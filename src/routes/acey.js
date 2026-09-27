import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { runAgentLoop, chatCompletion } from '../llm.js';
import { recordUsage } from '../usage.js';
import { ANALYST_TOOL_DEFS, makeAnalystExecutor, SCHEMA_BRIEF, queryCatalogue } from '../analyst_tools.js';
import { ACTION_TOOL_DEFS, makeActionExecutor } from '../copilot_actions.js';
import { TEAM, teamBrief, personByUsername } from '../team.js';
import { projectHealth } from '../health.js';
import { todoSummary, addTodo } from '../todos.js';
import { listWorkspace } from '../workspace.js';

// /api/acey/* — Acey outside a task.
//
// The task-scoped copilot answers "what is wrong with THIS task". This one
// answers the questions that have no task: how is the project doing, what is
// L-1's send-back rate this week, who should own this, is quality dropping.
// Those are the questions a QM actually asks, and until now the only way to get
// them answered was to write SQL by hand.
//
// The difference that makes it work is `run_sql`. Acey reads the curated queries
// in sql/redash/ to learn the house conventions — table choices, the project
// filter, the documented traps — and then writes its own. Every query it runs is
// streamed to the client and shown next to the answer, so a number is always
// traceable to the SQL that produced it.
//
// History is per-user and in memory. This is a question-and-answer surface, not
// a record: a reviewer asking about L10 throughput on Tuesday has no need to
// resume it on Thursday, and persisting it would mean writing conversations
// about people to disk.
export const aceyApi = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const HISTORY = new Map();          // username -> messages[]
const MAX_TURNS = 40;               // keep the tail; the system prompt carries the state

const ACTION_NAMES = new Set(ACTION_TOOL_DEFS.map((t) => t.function.name));

const SYSTEM = `
You are Acey, the RLI program's analyst (Anthropic custom creative-work data, Redash project
6a989ef00d42ba8e15aaac6c). You are talking to a QM or program owner from anywhere
in the RLI Operations Hub — not inside a single task — so the questions are about the PROGRAM: pipeline
health, throughput, quality, cost, people, and who should be doing something about it.

HOW TO ANSWER A DATA QUESTION
1. Check whether a curated query already answers it (list_queries). If one does, run it with
   redash_query. Do not rewrite something that exists.
2. If none does, read the one or two closest queries with read_query FIRST. They carry the table
   choices, the project filter, the timezone handling and the traps, in their comments. Then
   compose your own and run it with run_sql.
3. Report the number you actually got back. If a query errors or returns nothing, say so and fix
   the query — never fill the gap with an estimate, and never carry a number over from an earlier
   turn as though you had just measured it.

ANSWER DISCIPLINE
- Lead with the answer in one sentence. No preamble, no restating the question.
- Then the support: the figure, the window it covers, and the caveat if there is one.
- Under 120 words unless asked for depth. The dashboards are the verbose layer; you are the
  source of truth people consult for a specific question.
- Refer to review levels as they run on RLI: L-1 (contributor attempt), L0, L1 (review), L10
  (QM review), L12 (delivery pool). Check a level's meaning against the data before building a
  story on it — some curated queries were written for another project's lane layout.
- Distinguish tracked time (TASKATTEMPTS.V2_TIME_SPENT_SECS) from billable hours
  (GEN_AI_ISR.WORK_HOURS_SPENT). They are not the same number and the difference matters.
- Small samples are not findings. If an average rests on a handful of ratings, say the count.
- When someone asks who should handle something, route it by the domain map below, and say why.
  Anything cross-domain or above a single owner's line goes to Pavit.

THE AUDIT BOARD (this app's local board — you can act on it)
list_board, move_task, claim_tasks and propose_bulk_move work the board the operator is looking at.
- list_board FIRST, every time. Never answer or act from what the chat history says about the
  board — it lies the moment anyone drags a card.
- Move or claim only when the operator explicitly asked THIS turn. Your own analysis is never a
  reason to write anything.
- claim_tasks claims for the operator you are talking to and nobody else. Read their existing
  claims from list_board first — those are the context for the smartest match.
- Resolving needs a verdict: NO_ISSUES, FIXES_MADE or SBQ. If the operator did not
  say which, ask them which one they mean before moving anything. Never assume one.
- One write per turn: a single move_task or claim_tasks applies immediately (undoable); anything
  wider goes through propose_bulk_move, which the operator confirms with a click.
- There is no open task on this surface, so move_task always needs the 24-hex task_id.

WHAT YOU MUST NOT DO
- Do not invent a metric name, a table, or a threshold. If you are unsure a column exists, query
  the information schema or read a query that uses it.
- Do not describe project health from memory. The live figures are below and the tools are there;
  a confident stale number is worse than a slow accurate one.
`.trim();

// Assembled per request. The health block especially must be current — an
// analyst that describes last week's pipeline with today's confidence is the
// exact failure this surface exists to prevent.
async function buildSystem(username) {
  const parts = [SYSTEM, SCHEMA_BRIEF, `TEAM AND OWNERSHIP\n${teamBrief()}`];

  try {
    const h = await projectHealth({});
    const c = h.context;
    const lines = [
      'LIVE PROJECT STATE (already fetched — do not re-query for these):',
      `  ${c.deliverable} of ${c.target} deliverable at L12 for ${c.nextDelivery} (${c.daysUntilDelivery} days away).`,
      `  ${c.totalPending} tasks in flight, ${c.blocked} of them blocked at L1/L8. ${c.contributors} contributors active.`,
      `  Health signals firing: ${h.counts.p0} P0 (asap), ${h.counts.p1} P1 (by EOD), ${h.counts.p2} P2.`,
      ...h.signals.map((s) => `    [${s.severity}] ${s.title} → ${s.owner}${s.escalated ? ' (escalated)' : ''}`),
    ];
    parts.push(lines.join('\n'));
  } catch (e) {
    parts.push(`LIVE PROJECT STATE: unavailable (${e.message}). Say so if asked rather than guessing.`);
  }

  try {
    const ws = listWorkspace();
    const counts = Object.entries(ws).map(([b, list]) => `${b}: ${list.length}`).join(', ');
    parts.push(`AUDIT BOARD (local, this app only — not the upstream pipeline): ${counts}.`);
  } catch { /* board is optional context */ }

  const mine = todoSummary(username);
  if (mine.count) {
    parts.push(`${username.toUpperCase()}'S OPEN TODOS (${mine.count}): `
      + mine.top.map((t) => `${t.title} [${t.severity}]`).join('; '));
  }

  parts.push(`CURATED QUERIES AVAILABLE\n${queryCatalogue()}`);
  return parts.join('\n\n');
}

// Owner mentions in an answer — usernames, first names, full names, on word
// boundaries (markdown emphasis around a name does not defeat \b). This only
// ever OFFERS a button, so a contributor who happens to share a first name
// with an owner costs one ignorable affordance, never a wrong todo.
function detectOwners(text) {
  const out = [];
  for (const p of TEAM) {
    const names = [p.username, p.name, p.name.split(' ')[0]]
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (new RegExp(`\\b(?:${names.join('|')})\\b`, 'i').test(text || '')) {
      out.push({ username: p.username, name: p.name.split(' ')[0] });
    }
  }
  return out;
}

aceyApi.post('/chat', wrap(async (req, res) => {
  const user = req.user.username;
  const message = String(req.body?.message || '').slice(0, 50_000);
  if (!message) return res.status(400).json({ error: 'message required' });

  const history = HISTORY.get(user) || [];
  const userMsg = { role: 'user', content: message };
  const system = await buildSystem(user);

  const acc = { prompt_tokens: 0, completion_tokens: 0 };
  const onUsage = (u) => {
    acc.prompt_tokens += u.prompt_tokens || 0;
    acc.completion_tokens += u.completion_tokens || 0;
  };

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.flushHeaders?.();
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

  // Every query Acey runs is pushed to the client as it happens. The point is
  // not progress indication — it is that the operator can read the SQL behind
  // the answer instead of taking the number on trust.
  const analystExec = makeAnalystExecutor({ onQuery: (q) => send({ type: 'sql', ...q }) });
  // Board-writing tools compose in HERE, same as the task chat: Acey acts as the
  // signed-in operator with exactly their permissions. No task is open on this
  // surface, so the executor gets no current task and move_task needs an id.
  const actionExec = makeActionExecutor({
    bucket: null, id: null, username: user, onAction: (e) => send(e),
  });
  const executor = (name, args) => (ACTION_NAMES.has(name) ? actionExec : analystExec)(name, args);

  try {
    const { messages } = await runAgentLoop({
      messages: [{ role: 'system', content: system }, ...history, userMsg],
      tools: [...ANALYST_TOOL_DEFS, ...ACTION_TOOL_DEFS],
      executor,
      onEvent: (e) => send(e),
      maxSteps: 30,
      onUsage,
    });
    // Trim to a user-message boundary: a turn is assistant(tool_calls) + its
    // tool results, and a slice that beheads the pair leaves an orphan
    // role:'tool' head that the proxy rejects — every later turn then 400s
    // until the user clears the chat.
    const trimmed = [...history, userMsg, ...messages].slice(-MAX_TURNS);
    const firstUser = trimmed.findIndex((m) => m.role === 'user');
    HISTORY.set(user, firstUser === -1 ? [] : trimmed.slice(firstUser));
    // If the answer names an owner, offer to turn it into an action item on
    // the Team board — the model routes, the human authorizes with a click.
    const final = [...messages].reverse()
      .find((m) => m.role === 'assistant' && m.content && !m.tool_calls?.length);
    const owners = detectOwners(final?.content);
    if (owners.length) send({ type: 'actions', owners });
    send({ type: 'done' });
  } catch (e) {
    send({ type: 'error', message: e.message });
  } finally {
    recordUsage({ user, taskId: null, kind: 'acey', model: config.litellm.model, usage: acc, text: message });
  }
  res.end();
}));

// Replays the conversation INCLUDING the queries that were run.
//
// The first version filtered out every message carrying tool_calls, which meant
// reopening the panel silently dropped all the SQL — the answers came back but
// the evidence behind them did not, which defeats the point of showing it in the
// first place. The calls are already in the transcript; they just have to be
// unpacked in order.
aceyApi.get('/history', (req, res) => {
  const out = [];
  for (const m of HISTORY.get(req.user.username) || []) {
    if (m.role === 'user' && m.content) { out.push({ role: 'user', content: m.content }); continue; }
    if (m.role !== 'assistant') continue;

    for (const call of m.tool_calls || []) {
      if (call.function?.name !== 'run_sql') continue;
      try {
        const args = JSON.parse(call.function.arguments || '{}');
        if (args.sql) out.push({ role: 'sql', sql: args.sql, purpose: args.purpose || '' });
      } catch { /* malformed args — nothing to replay */ }
    }
    // Content alongside tool_calls is the model narrating its next step, not the
    // answer. Only the message that ends the loop is the reply.
    if (m.content && !m.tool_calls?.length) {
      out.push({ role: 'assistant', content: m.content, owners: detectOwners(m.content) });
    }
  }
  res.json({ messages: out });
});

aceyApi.delete('/history', (req, res) => {
  HISTORY.delete(req.user.username);
  res.json({ cleared: true });
});

// Starter questions, so the empty state teaches what this can do rather than
// showing a blank box. Read from disk when present so they can be tuned without
// a deploy, same pattern as the rubric override.
// "Add as action item" is two endpoints on purpose, one per party:
//
//   POST /action/draft   the MODEL drafts — one small completion turns the
//                        answer into a title/detail/severity the human can read
//   POST /action         the HUMAN creates — deterministic addTodo() of exactly
//                        the fields they saw and possibly edited
//
// The first version drafted AFTER the click, inside the create call, which
// meant authorizing text you had never seen onto a teammate's queue. Splitting
// them puts the review step where it belongs: between the model's wording and
// the board.
aceyApi.post('/action/draft', wrap(async (req, res) => {
  const person = personByUsername(String(req.body?.owner || ''));
  if (!person) return res.status(400).json({ error: `unknown owner: ${req.body?.owner}` });
  const question = String(req.body?.question || '').slice(0, 2000);
  const answer = String(req.body?.answer || '').slice(0, 6000);
  if (!answer) return res.status(400).json({ error: 'answer required' });

  const acc = { prompt_tokens: 0, completion_tokens: 0 };
  let draft = null;
  try {
    const msg = await chatCompletion({
      messages: [
        {
          role: 'system',
          content: 'You turn an analyst\'s answer into ONE action item for a named owner. Reply with JSON '
            + 'only, no code fences: {"title":"...","detail":"...","severity":"p0"|"p1"|"p2"}. The title is '
            + 'imperative, at most 90 characters, and carries the key figure when there is one ("Coach the 5 '
            + 'reviewers grading off the standard"). The detail is one or two plain sentences with the '
            + 'supporting numbers from the answer — no markdown. Priorities are deadlines: "p0" means it '
            + 'cannot wait (delivery or customer actively at risk), "p1" means it should land by end of '
            + 'day, "p2" (the default) means within 2-3 days.',
        },
        { role: 'user', content: `Owner: ${person.name} — ${person.remit}\nQuestion asked: ${question}\nAnswer:\n${answer}` },
      ],
      maxTokens: 300,
      onUsage: (u) => { acc.prompt_tokens += u.prompt_tokens || 0; acc.completion_tokens += u.completion_tokens || 0; },
    });
    draft = JSON.parse(String(msg.content || '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch { /* fall through to the plain fallback */ }

  recordUsage({ user: req.user.username, taskId: null, kind: 'acey', model: config.litellm.model, usage: acc, text: `draft for ${person.username}` });
  res.json({
    draft: {
      title: String(draft?.title || `Follow up: ${question || answer}`).slice(0, 140),
      detail: String(draft?.detail || answer.slice(0, 300)).slice(0, 600),
      severity: ['p0', 'p1', 'p2'].includes(draft?.severity) ? draft.severity : 'p2',
    },
  });
}));

aceyApi.post('/action', wrap(async (req, res) => {
  const person = personByUsername(String(req.body?.owner || ''));
  if (!person) return res.status(400).json({ error: `unknown owner: ${req.body?.owner}` });
  const title = String(req.body?.title || '').trim().slice(0, 140);
  if (!title) return res.status(400).json({ error: 'title required' });
  const detail = String(req.body?.detail || '').trim().slice(0, 600);
  const todo = addTodo({
    owner: person.username,
    title,
    detail: detail ? `${detail} — via Acey, added by ${req.user.username}.` : `Via Acey, added by ${req.user.username}.`,
    // p00 is allowed here — a human picked it — and addTodo enforces the singleton.
    severity: ['p00', 'p0', 'p1', 'p2'].includes(req.body?.severity) ? req.body.severity : 'p2',
    by: req.user.username,
  });
  res.json({ todo });
}));

aceyApi.get('/suggestions', (req, res) => {
  const custom = path.join(config.dataDir, 'acey_suggestions.json');
  try {
    return res.json({ suggestions: JSON.parse(fs.readFileSync(custom, 'utf8')) });
  } catch { /* fall through to defaults */ }
  res.json({
    suggestions: [
      'How much of L-1 is being wasted this week, and is it getting worse?',
      'Which reviewers are grading furthest from the project standard?',
      'Are we on pace for the next delivery?',
      'What is blocking the oldest tasks at L8?',
      'Which attempters are ready to promote?',
    ],
  });
});
