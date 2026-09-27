import crypto from 'node:crypto';
import {
  planTaskLaneMove, moveTaskToLane, selectTasks, laneOf,
  LANES, DESTINATIONS, LANE_LABELS, SEV_LABELS, VERDICT_LABELS, RESOLVED_VERDICTS,
} from './lanes.js';
import { recordAction } from './actions.js';
import { taskMeta, listWorkspace, findTaskBucket, httpError } from './workspace.js';
import { VERDICTS, claimTask, laneSnapshot } from './state.js';

// Write actions the audit copilot can take on the operator's behalf.
//
// Kept OUT of src/tools.js on purpose: those tools are also handed to the offline
// doc generator, which must never be able to mutate board state. A tool can only
// write if the caller explicitly composes ACTION_TOOL_DEFS in, which only the
// chat route does.
//
// Friction model (operator's choice):
//   * ONE task  -> applied immediately, reported with an Undo affordance.
//   * MANY tasks-> staged as a plan the operator confirms in the UI first.
//   * claim_tasks is the exception: N tasks, applied — self-scoped, see its section.
// All paths go through recordAction, so every copilot action lands in the same
// journal as a drag or a bulk move and is undoable the same way.
//
// Acey acts AS the operator: it is handed their username and gets exactly their
// permissions — never more. There is no copilot service account.

const TASK_ID_RE = /^[0-9a-f]{24}$/;

// A task the copilot names has to be found on the board; it only ever receives
// the bucket of the task the chat is open on. The global (program-level) chat
// has no open task to default to, so there it must always name one.
function resolveTask(taskId, current) {
  const id = String(taskId || '').trim().toLowerCase();
  if (!id || id === current.id) {
    if (!current.id) throw httpError(400, 'no task is open in this chat — pass the 24-hex task_id');
    return { bucket: current.bucket, id: current.id };
  }
  if (!TASK_ID_RE.test(id)) throw httpError(400, `not a 24-hex task id: ${id.slice(0, 40)}`);
  const bucket = findTaskBucket(id);
  if (!bucket) throw httpError(404, `task ${id} is not on the board`);
  return { bucket, id };
}

function laneLabelFor(bucket, id) {
  return LANE_LABELS[laneOf(taskMeta(bucket, id))] || '';
}

function describeTarget(lane, verdict) {
  const base = LANE_LABELS[lane] || lane;
  return lane === 'RESOLVED' && verdict ? `${base} · ${VERDICT_LABELS[verdict] || verdict}` : base;
}

function validateDestination(lane, verdict) {
  if (!DESTINATIONS.includes(lane)) {
    throw httpError(400, `unknown lane ${lane} — one of ${DESTINATIONS.join(', ')}`);
  }
  if (lane === 'RESOLVED' && !RESOLVED_VERDICTS.includes(verdict)) {
    throw httpError(400, `moving to Resolved needs a verdict — one of ${RESOLVED_VERDICTS.join(', ')}`);
  }
  if (verdict && !VERDICTS.includes(verdict)) {
    throw httpError(400, `unknown verdict ${verdict} — one of ${VERDICTS.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Single-task move — applied immediately
// ---------------------------------------------------------------------------

export function applySingleMove({ bucket, id, lane, verdict = null, username }) {
  validateDestination(lane, verdict);
  const from = laneLabelFor(bucket, id);
  const item = moveTaskToLane(bucket, id, lane, { verdict, username });
  if (!item) {
    return { moved: 0, id, from, to: describeTarget(lane, verdict), noop: true, action: null };
  }
  const act = recordAction({
    by: username,
    kind: 'copilot_move',
    label: `${id.slice(0, 8)}… · ${laneLabelFor(bucket, id)} (Acey)`,
    items: [item],
  });
  return {
    moved: 1,
    id,
    bucket,
    from,
    to: describeTarget(lane, verdict),
    noop: false,
    action: act && { id: act.id, label: act.label },
  };
}

// ---------------------------------------------------------------------------
// Bulk move — planned, staged, confirmed, then applied
// ---------------------------------------------------------------------------

// Resolve the selection server-side and work out what would actually change,
// WITHOUT writing anything.
export function planBulkMove({ severity = 'ALL', fromLane = 'ANY', ids = null, toLane, verdict = null, username }) {
  if (!toLane) throw httpError(400, 'toLane required');
  validateDestination(toLane, verdict);

  let idList = null;
  if (ids != null) {
    idList = (Array.isArray(ids) ? ids : String(ids).split(/[\s,]+/))
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
    const bad = idList.filter((x) => !TASK_ID_RE.test(x));
    if (bad.length) throw httpError(400, `not 24-hex task ids: ${bad.slice(0, 3).join(', ')}`);
  }

  const candidates = selectTasks({ severity, fromLane, ids: idList });
  const willChange = [];
  const unchanged = [];
  for (const meta of candidates) {
    const p = planTaskLaneMove(meta.bucket, meta.id, toLane, { verdict, username });
    (p.changes ? willChange : unchanged).push({
      id: meta.id, bucket: meta.bucket, from: LANE_LABELS[laneOf(meta)] || '', severity: meta.bucket,
    });
  }

  // Ids the operator named that aren't on the board at all — reported rather than
  // silently dropped, the same way the Move-by-ID box does it.
  const found = new Set(candidates.map((m) => m.id));
  const missing = idList ? idList.filter((x) => !found.has(x)) : [];

  const sevLabel = severity === 'ALL' ? '' : `${SEV_LABELS[severity] || severity} · `;
  const fromLabel = fromLane === 'ANY' ? 'any lane' : (LANE_LABELS[fromLane] || fromLane);

  return {
    severity, fromLane, toLane, verdict, ids: idList,
    willChange, unchanged, missing,
    counts: { change: willChange.length, unchanged: unchanged.length, missing: missing.length },
    target: describeTarget(toLane, verdict),
    summary: `${willChange.length} ${sevLabel}${fromLabel} → ${describeTarget(toLane, verdict)}`,
  };
}

export function applyBulkMove(plan, username) {
  const items = [];
  for (const t of plan.willChange) {
    const item = moveTaskToLane(t.bucket, t.id, plan.toLane, { verdict: plan.verdict, username });
    if (item) items.push(item);
  }
  const act = recordAction({
    by: username, kind: 'copilot_bulk_move',
    label: `${items.length} → ${plan.target} (Acey)`,
    items,
  });
  return { moved: items.length, action: act && { id: act.id, label: act.label } };
}

// ---- staged plans awaiting confirmation ----
// In memory and short-lived by design: a stale plan is dangerous (the board moves
// under it), so an unconfirmed one simply expires. Re-planning is one cheap call.

const STAGE_TTL_MS = 10 * 60 * 1000;
const staged = new Map(); // token -> { plan, username, at }

export function stagePlan(plan, username) {
  for (const [t, v] of staged) if (Date.now() - v.at > STAGE_TTL_MS) staged.delete(t);
  const token = crypto.randomBytes(12).toString('hex');
  staged.set(token, { plan, username, at: Date.now() });
  return token;
}

// Confirming re-plans from CURRENT board state rather than replaying the stored
// list: between proposal and click, someone else may have moved these tasks. The
// stored plan is the operator's INTENT (selection + destination); what actually
// gets written is derived fresh from that intent.
export function confirmPlan(token, username) {
  const entry = staged.get(token);
  if (!entry) throw httpError(404, 'that proposal expired or was already applied — ask Acey again');
  if (entry.username !== username) throw httpError(403, 'that proposal belongs to another user');
  staged.delete(token);
  const fresh = planBulkMove({ ...entry.plan, username });
  const res = applyBulkMove(fresh, username);
  return { ...res, summary: fresh.summary, drifted: fresh.counts.change !== entry.plan.counts.change };
}

export function cancelPlan(token, username) {
  const entry = staged.get(token);
  if (entry && entry.username === username) staged.delete(token);
  return { cancelled: true };
}

// ---------------------------------------------------------------------------
// Batch claim — self-scoped, so it applies without a confirmation card
// ---------------------------------------------------------------------------

// "Claim N for me" writes N tasks, but every one of them lands on the REQUESTING
// operator's own plate and one undo releases them all — the blast radius of a
// mistake is their own workload, not the board. That is why this is allowed to
// apply immediately where a bulk MOVE of the same size must be confirmed.

const CLAIM_CAP = 10;

// Instance family, from what taskMeta already exposes: the problem statement.
// Re-cuts of the same underlying task ship the same problem text, so a
// normalized prefix groups them the way the board's search box finds them —
// no new metadata field needed.
function familyOf(meta) {
  return String(meta.problem || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function claimTasksFor({ count, severity = null, like = null, username }) {
  const n = Math.max(1, Math.min(CLAIM_CAP, Number(count) || 1));
  if (severity && !SEV_LABELS[severity]) {
    throw httpError(400, `unknown severity ${severity} — one of ${Object.keys(SEV_LABELS).join(', ')}`);
  }

  // The operator's existing claims are the context for the "smartest match":
  // which instance families they are already deep in, and which severities
  // their current plate leans toward.
  const mine = [];
  for (const metas of Object.values(listWorkspace())) {
    for (const meta of metas) {
      if (!meta.tour && !meta.delivered && meta.claimedBy === username) mine.push(meta);
    }
  }
  const myFamilies = new Set(mine.map(familyOf).filter(Boolean));
  const mySevCount = {};
  for (const m of mine) mySevCount[m.bucket] = (mySevCount[m.bucket] || 0) + 1;

  // Candidates: unclaimed, live, OPEN-lane tasks — claiming one IS the move to
  // In review (laneOf: claimed + no verdict = REVIEW). selectTasks already skips
  // tour sandboxes and archived tasks and returns board order (bucket, then id).
  let candidates = selectTasks({ severity: severity || 'ALL', fromLane: 'OPEN', ids: null });
  if (like) {
    const q = String(like).toLowerCase();
    candidates = candidates.filter((m) => (m.problem || '').toLowerCase().includes(q));
  }

  // Stable sort: family match to their existing claims first, then the severity
  // they already hold most of, then the board order the selection came in.
  candidates = candidates
    .map((meta, i) => ({ meta, i }))
    .sort((a, b) => (myFamilies.has(familyOf(b.meta)) - myFamilies.has(familyOf(a.meta)))
      || ((mySevCount[b.meta.bucket] || 0) - (mySevCount[a.meta.bucket] || 0))
      || (a.i - b.i))
    .map((x) => x.meta);

  const items = [];
  const claimed = [];
  for (const meta of candidates) {
    if (claimed.length >= n) break;
    const before = laneSnapshot(meta.bucket, meta.id);
    try {
      claimTask(meta.bucket, meta.id, username); // the same path as the board's Claim button
    } catch (e) {
      if (e.status === 409) continue; // raced — someone claimed it since the listing; next candidate
      throw e;
    }
    items.push({ bucket: meta.bucket, id: meta.id, before, after: laneSnapshot(meta.bucket, meta.id) });
    claimed.push({ id: meta.id, severity: meta.bucket, problem: (meta.problem || '').slice(0, 100) });
  }

  // ONE journal record for the whole batch: Recent actions shows a single
  // "claimed N" line, and one undo releases them all.
  const act = recordAction({
    by: username, kind: 'copilot_claim',
    label: `claimed ${claimed.length} → In review (Acey)`,
    items,
  });
  return {
    claimed, requested: n, matched: candidates.length,
    action: act && { id: act.id, label: act.label },
  };
}

// ---------------------------------------------------------------------------
// Board awareness (read-only) — the copilot otherwise only sees one task folder
// ---------------------------------------------------------------------------

// The Spelling/Grammar tag exactly as the board chip means it:
//   'only'      R23/R24 tripped and nothing else -> auto-routes to Grammar Fixes
//   'flagged'   R23/R24 tripped alongside other fails -> does NOT belong there
//   'clean'     audited, no writing fail
//   'unaudited' no autoqc fence in review.md, so nothing is known
function writingTag(meta) {
  if (meta.qcDims === null) return 'unaudited';
  if (meta.grammarOnly) return 'only';
  if (meta.grammar) return 'flagged';
  return 'clean';
}

export function boardView({ lane = null, severity = null, writing = null, limit = 60 } = {}) {
  const ws = listWorkspace();
  const rows = [];
  const byLane = {};
  const bySeverity = {};
  const byWriting = {};
  for (const [bucket, metas] of Object.entries(ws)) {
    for (const meta of metas) {
      if (meta.tour || meta.delivered) continue;
      const l = laneOf(meta);
      const tag = writingTag(meta);
      byLane[l] = (byLane[l] || 0) + 1;
      bySeverity[bucket] = (bySeverity[bucket] || 0) + 1;
      byWriting[tag] = (byWriting[tag] || 0) + 1;
      if (lane && lane !== 'ANY' && l !== lane) continue;
      if (severity && severity !== 'ALL' && bucket !== severity) continue;
      if (writing && writing !== 'ANY' && tag !== writing) continue;
      rows.push({
        id: meta.id, bucket, lane: l,
        verdict: meta.verdict || null,
        claimedBy: meta.claimedBy || null,
        writing: tag,
        qcDims: meta.qcDims,        // every tripped dimension (null = un-audited)
        otherDims: meta.otherDims,  // the non-writing fails that block grammar-only
        // 'in'/'out' = a human overrode the automatic routing, which is worth
        // knowing before proposing to move the task back out again.
        grammarOverride: meta.grammarLane || null,
      });
    }
  }
  return {
    total: rows.length, byLane, bySeverity, byWriting,
    rows: rows.slice(0, Math.min(200, limit)),
    truncated: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions + executor
// ---------------------------------------------------------------------------

export const ACTION_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_board',
      description:
        'Read the audit board: how many tasks sit in each lane, severity bucket and Spelling/Grammar tag, plus the matching task ids '
        + 'with their lane, verdict, claim, writing tag and tripped QC dimensions. '
        + 'Use this BEFORE proposing any bulk move so the selection is grounded in what is actually on the board. '
        + `Lanes: ${LANES.join(', ')}. Severity buckets: HARD_FAIL, SOFT_FAIL, PASS, UNSORTED. `
        + 'Ignore the writing tag: it is an ACC carry-over keyed to rubric items R23/R24 and never fires on RLI (evals grade on D1–D20). '
        + '"clean" = audited with no writing fail; "unaudited" = review.md has no autoqc fence, so nothing is known — never treat that as clean. '
        + 'A row marked "[moved in/out by hand]" had its routing overridden by a human.',
      parameters: {
        type: 'object',
        properties: {
          lane: { type: 'string', enum: [...LANES, 'ANY'], description: 'restrict to one lane' },
          severity: { type: 'string', enum: ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED', 'ALL'] },
          writing: {
            type: 'string',
            enum: ['only', 'flagged', 'clean', 'unaudited', 'ANY'],
            description: 'restrict by the Spelling/Grammar tag',
          },
          limit: { type: 'integer', description: 'max rows, default 60' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_task',
      description:
        'Move ONE task to a lane and/or set its verdict. Applies immediately — the operator sees what changed and can undo it. '
        + 'Defaults to the task currently open in this chat; pass task_id only to act on a different task on the board. '
        + 'LIMIT: ONE write per turn, shared with claim_tasks — a second call is refused. If the operator names two or more tasks, '
        + 'use propose_bulk_move with task_ids instead so they approve the set with one click. '
        + 'Only do this when the operator has actually asked for it; never move a task just because your analysis suggests a verdict. '
        + `RESOLVED requires a verdict (${RESOLVED_VERDICTS.join(', ')}) — if the operator did not say which, ASK them; never pick one for them. `
        + 'REOPEN clears the verdict and leaves everything else alone. No other lane takes a verdict.',
      parameters: {
        type: 'object',
        properties: {
          lane: { type: 'string', enum: DESTINATIONS, description: 'destination lane, or REOPEN to clear the decision' },
          verdict: { type: 'string', enum: VERDICTS, description: 'required for RESOLVED' },
          task_id: { type: 'string', description: '24-hex id; omit for the current task' },
        },
        required: ['lane'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'claim_tasks',
      description:
        'Claim up to `count` (max 10) unclaimed Open-lane tasks FOR THE OPERATOR IN THIS CHAT and put them In review — '
        + 'claiming IS that move. The pick is smart: tasks from the same instance family as their existing claims first, '
        + 'then the severity mix they already hold (or the explicit severity), then board order. '
        + 'Applies immediately and is journaled as ONE undoable action. Strictly self-scoped: never claim on someone '
        + 'else\'s behalf — if asked to, refuse and say that person has to ask Acey themselves. '
        + 'LIMIT: ONE write per turn, shared with move_task — a second call is refused. '
        + 'Check list_board first so the pick is grounded in their current claims, and only claim when the operator '
        + 'explicitly asked this turn.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: 'how many to claim, 1–10' },
          severity: {
            type: 'string',
            enum: ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'],
            description: 'restrict to one severity bucket; omit to match their current claim mix',
          },
          like: { type: 'string', description: 'free-text filter on the problem statement (e.g. "swim meet optimizer")' },
        },
        required: ['count'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_bulk_move',
      description:
        'Propose moving MANY tasks at once. This does NOT apply anything: it resolves the selection against the live board and returns a plan the operator must confirm with a click. '
        + 'Select by severity and/or source lane (e.g. all PASS in OPEN), or by an explicit task_ids list. '
        + 'After calling this, tell the operator what the plan covers in one short sentence and stop — do not claim the move has happened.',
      parameters: {
        type: 'object',
        properties: {
          to_lane: { type: 'string', enum: DESTINATIONS },
          verdict: { type: 'string', enum: VERDICTS, description: 'required when to_lane is RESOLVED' },
          severity: { type: 'string', enum: ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED', 'ALL'] },
          from_lane: { type: 'string', enum: [...LANES, 'ANY'] },
          task_ids: { type: 'array', items: { type: 'string' }, description: 'explicit 24-hex ids instead of a filter' },
        },
        required: ['to_lane'],
      },
    },
  },
];

// onAction(event) is how the chat route pushes an SSE event to the browser so it
// can render an Undo chip or a confirmation card.
export function makeActionExecutor({ bucket, id, username, onAction }) {
  const current = { bucket, id };
  // "Apply one, confirm many" has to be enforced on the NUMBER OF TASKS a turn
  // actually writes, not on which tool was called — otherwise the model can move
  // N tasks by calling move_task N times and never trip the confirmation gate.
  // (Observed in testing: asked to move two named tasks, it issued two
  // move_task calls rather than one proposal.) One executor is built per chat
  // request, so this counter is exactly one turn's budget.
  let applied = 0;
  return async (name, args = {}) => {
    switch (name) {
      case 'list_board': {
        const v = boardView({
          lane: args.lane, severity: args.severity, writing: args.writing, limit: args.limit || 60,
        });
        const lines = [
          `Board: ${Object.entries(v.byLane).map(([k, n]) => `${LANE_LABELS[k] || k}=${n}`).join(', ')}`,
          `Severity: ${Object.entries(v.bySeverity).map(([k, n]) => `${SEV_LABELS[k] || k}=${n}`).join(', ')}`,
          `Spelling/Grammar tag: ${Object.entries(v.byWriting).map(([k, n]) => `${k}=${n}`).join(', ')}`,
          `${v.total} task(s) match${v.truncated ? ` (showing ${v.rows.length})` : ''}`,
          'task_id                   severity   lane             verdict         writing    dims                 claimed_by',
        ];
        for (const r of v.rows) {
          const dims = r.qcDims === null ? 'un-audited' : (r.qcDims.length ? r.qcDims.join('/') : 'NONE');
          lines.push(
            `${r.id}  ${(r.bucket || '').padEnd(9)}  ${(r.lane || '').padEnd(15)}  ${(r.verdict || '—').padEnd(14)}  `
            + `${r.writing.padEnd(9)}  ${dims.padEnd(19)}  ${r.claimedBy || '—'}`
            + (r.grammarOverride ? `  [moved ${r.grammarOverride} by hand]` : ''),
          );
        }
        return lines.join('\n');
      }

      case 'move_task': {
        if (applied >= 1) {
          return 'REFUSED — nothing was changed. Write actions apply immediately, so they are limited to '
            + 'ONE per turn (move_task and claim_tasks share that budget) and this turn already used its '
            + 'one. To change several tasks in a turn, call propose_bulk_move with task_ids: the operator '
            + 'approves the whole set with one click. Tell them what landed and that the rest needs a confirmation.';
        }
        const target = resolveTask(args.task_id, current);
        // resolveTask only checks the directory exists, which archived tasks
        // still do — bulk selection skips them in selectTasks, so guard here too.
        if (taskMeta(target.bucket, target.id).delivered) {
          return `REFUSED — nothing was changed. ${target.id} is archived — restore it from the archive first.`;
        }
        // The "nudge back": resolving without a verdict is not an error to paper
        // over with a default — it is a question only the operator can answer.
        if (args.lane === 'RESOLVED' && !RESOLVED_VERDICTS.includes(args.verdict)) {
          return 'REFUSED — nothing was changed. Resolving a task needs a verdict and the operator has not '
            + `given one. ASK THE OPERATOR which they mean — ${RESOLVED_VERDICTS.join(', ')} — and call `
            + 'move_task again once they answer. Never pick a verdict for them.';
        }
        let verdict = args.verdict ?? null;
        let note = '';
        if (verdict && args.lane !== 'RESOLVED') {
          // Never accept a verdict silently on a lane that doesn't take one.
          note = ` NOTE: the ${verdict} verdict was IGNORED — only a move to RESOLVED takes one. Say so if the operator asked for it.`;
          verdict = null;
        }
        const res = applySingleMove({
          ...target, lane: args.lane, verdict, username,
        });
        if (res.noop) return `No change: ${res.id.slice(0, 8)}… is already ${res.to}.${note}`;
        applied += 1;
        onAction?.({
          type: 'action', kind: 'applied',
          // Full id: 8-char prefixes collide in this dataset, and this line is the
          // reviewer's only record of what was just written.
          summary: `${res.id} · ${res.from} → ${res.to}`,
          taskId: res.id, isCurrentTask: res.id === current.id,
          action: res.action,
        });
        return `Applied: ${res.id} moved ${res.from} → ${res.to}.${note} `
          + 'The operator sees this with an Undo button. Confirm it in one short sentence.';
      }

      case 'claim_tasks': {
        if (applied >= 1) {
          return 'REFUSED — nothing was changed. Write actions apply immediately, so they are limited to '
            + 'ONE per turn (claim_tasks and move_task share that budget) and this turn already used its '
            + 'one. Tell the operator what landed and ask them to send the next request as its own message.';
        }
        const res = claimTasksFor({
          count: args.count, severity: args.severity ?? null, like: args.like ?? null, username,
        });
        if (!res.claimed.length) {
          return `No tasks were claimed — ${res.matched} unclaimed Open task(s) matched`
            + `${args.severity ? ` severity ${args.severity}` : ''}${args.like ? ` "${args.like}"` : ''}`
            + (res.matched ? ', but every one was claimed by someone else while this ran.' : '.')
            + ' Nothing was written. Tell the operator and ask whether to widen the filter.';
        }
        applied += 1;
        onAction?.({
          type: 'action', kind: 'applied',
          // Full ids, same rule as move_task: this chip is the operator's only
          // record of the write, and 8-char prefixes collide in this dataset.
          summary: `claimed ${res.claimed.length} → In review · ${res.claimed.map((c) => c.id).join(', ')}`,
          isCurrentTask: res.claimed.some((c) => c.id === current.id),
          action: res.action,
        });
        return `Applied: claimed ${res.claimed.length} task(s) for ${username} — claiming puts them In review.\n`
          + `${res.claimed.map((c) => `${c.id}  ${c.severity}  ${c.problem}`).join('\n')}\n`
          + (res.claimed.length < res.requested
            ? `Only ${res.claimed.length} of the ${res.requested} asked for were claimable — say so. `
            : '')
          + 'The operator sees this with an Undo button. Report each id with what it is in one short list.';
      }

      case 'propose_bulk_move': {
        const plan = planBulkMove({
          severity: args.severity || 'ALL',
          fromLane: args.from_lane || 'ANY',
          ids: args.task_ids ?? null,
          toLane: args.to_lane,
          verdict: args.verdict ?? null,
          username,
        });
        if (!plan.counts.change) {
          return `Nothing to do: 0 tasks would change (${plan.counts.unchanged} already ${plan.target}`
            + `${plan.counts.missing ? `, ${plan.counts.missing} not on the board` : ''}). No proposal was shown.`;
        }
        const token = stagePlan(plan, username);
        onAction?.({ type: 'action', kind: 'proposal', token, plan: {
          summary: plan.summary, target: plan.target, counts: plan.counts,
          sample: plan.willChange.slice(0, 8).map((t) => ({ id: t.id, from: t.from, severity: t.severity })),
          missing: plan.missing.slice(0, 5),
        } });
        return `Proposal shown to the operator: ${plan.counts.change} task(s) → ${plan.target}`
          + `${plan.counts.unchanged ? `, ${plan.counts.unchanged} already there` : ''}`
          + `${plan.counts.missing ? `, ${plan.counts.missing} not on the board` : ''}. `
          + 'NOTHING has been applied — they must click Apply. Say what it covers in one sentence and stop.';
      }

      default:
        return `ERROR: unknown action tool ${name}`;
    }
  };
}
