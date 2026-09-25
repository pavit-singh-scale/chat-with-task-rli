import fs from 'node:fs';
import path from 'node:path';
import { runAgentLoop } from './llm.js';
import { TOOL_DEFS, makeExecutor, makeExecutorForDir } from './tools.js';
import { readTaskDef, readTaskDefIn, taskDir, writeTaskFile, writeFileIn, grammarInfo } from './workspace.js';
import { QUALITY_CANON } from './spec.js';
import { isRliTask } from './rli.js';
import { generateRliDoc } from './rli_docgen.js';

// Shared context block: rank.json digest + audit seed, prepended to every
// system prompt (chat copilot and doc generation).
export function taskContext(bucket, id) {
  return taskContextForDir(taskDir(bucket, id), { id, bucket });
}

export function taskContextForDir(dir, { id = path.basename(dir), bucket = '?' } = {}) {
  const parts = [`Task ID: ${id} (bucket: ${bucket})`];
  try {
    const rank = JSON.parse(fs.readFileSync(path.join(dir, 'rank.json'), 'utf8'));
    const digest = {
      instance_id: rank.instance_id,
      annotator_id: rank.annotator_id,
      vendor: rank.vendor,
      problem_statement: String(rank.problem_statement || '').slice(0, 2000),
      models: {},
      ranking_rationale: String(rank.ranking_rationale || '').slice(0, 4000),
      preference_rating: rank.preference_rating,
    };
    for (const [codename, r] of Object.entries(rank.results || {})) {
      digest.models[codename] = {
        model_assignment: r.model_assignment,
        rank: r.rank,
        failure_modes_non_none: Object.fromEntries(
          Object.entries(r.failure_modes || {}).filter(([, v]) => v && v !== 'none')
        ),
      };
    }
    parts.push('rank.json digest:\n' + JSON.stringify(digest, null, 2));
  } catch {
    parts.push('(rank.json missing or unparseable — flag this immediately, it is a packaging defect)');
  }
  // The Spelling/Grammar tag the board shows on the card, derived from review.md's
  // autoqc fence. grammarOnly is what auto-routes a task into the Grammar Fixes
  // lane, so the distinction between "flagged" and "the only fail" is the whole
  // point — a task with other fails alongside R23/R24 does NOT belong there.
  const g = grammarInfo(dir);
  if (g.dims === null) {
    parts.push('Writing/QC tag: un-audited — review.md has no autoqc fence, so no dimensions are known. '
      + (g.grammar ? 'A loose text match suggests spelling/grammar is mentioned, but that is not authoritative.' : ''));
  } else if (g.grammarOnly) {
    parts.push(`Writing/QC tag: GRAMMAR-ONLY — spelling/grammar (${g.dims.join(', ')}) is the ONLY tripped dimension, `
      + 'so this task auto-routes to the Grammar Fixes lane and resolves as GRAMMAR_ONLY.');
  } else if (g.grammar) {
    parts.push(`Writing/QC tag: spelling/grammar flagged, but NOT the only fail — also ${g.otherDims.join(', ')}. `
      + 'It does not belong in Grammar Fixes on its own, and resolves as FIXES_MADE rather than GRAMMAR_ONLY.');
  } else if (g.dims.length) {
    parts.push(`Writing/QC tag: no spelling/grammar fail. Tripped dimensions: ${g.dims.join(', ')}.`);
  } else {
    parts.push('Writing/QC tag: audited clean — the autoqc fence lists NONE.');
  }

  const def = readTaskDefIn(dir);
  if (def.missing) {
    parts.push('Task definition: MISSING (informational only per customer policy 2026-06-09 — never a finding).');
  } else {
    parts.push(
      'Task definition (' + def.source + '):\n' +
      JSON.stringify(
        {
          title: def.title,
          category: def.category,
          difficulty: def.difficulty,
          language: def.language,
          milestones: def.milestones.map((m) => ({ id: m.id, title: m.title, prompt: m.prompt.slice(0, 1200) })),
          guardrails: def.guardrails.map((g) => g.slice(0, 500)),
        },
        null,
        2
      ).slice(0, 16_000)
    );
  }
  const seed = path.join(dir, '_audit_seed.md');
  if (fs.existsSync(seed)) {
    parts.push('Prior /acc audit findings for this task (_audit_seed.md):\n' + fs.readFileSync(seed, 'utf8').slice(0, 20_000));
  }
  return parts.join('\n\n');
}

export const CITATION_RULES = `
Citation rules (mandatory):
- Whenever you reference a point in a trajectory, cite it as a markdown link with a traj:// URL:
  [model_a msg 23](traj://model_a/23). The UI turns these into "Show in trajectory" buttons that
  jump the reviewer to that exact message. model is model_a or model_b; the number is the message
  index shown by read_trajectory. Cite generously — every factual claim about a trajectory needs one.
- To point at an exact word/phrase inside a message (not just the whole message), append ?q= with the
  URL-encoded phrase: [model_a msg 23](traj://model_a/23?q=silently%20dropped). The reviewer lands on
  that message with the phrase highlighted. Use this whenever you quote specific words a model wrote.
- To point at a phrase in a model's responses without a specific index, use a cb:// link:
  [Model B said "…"](cb://model_b?q=the%20exact%20phrase) — the UI searches that model's responses and
  highlights the first match. Prefer traj://<model>/<N>?q= when you know the index; use cb:// otherwise.
- Whenever a V11 rubric dimension decides a severity or verdict, cite it as a spec:// link:
  [R12 Summaries · Accuracy](spec://R12). The UI turns these into buttons that open the QC spec
  at that exact rubric row. Use the R-keys from the canon (R1-R25).
- Whenever you cite a rank.json field (the annotator's grading/summary/decision), write the field
  path as inline code with a leading slash — e.g. \`/ranking_rationale\`, \`/preference_rating\`,
  \`/results/<codename>/summary\`, \`/results/<codename>/grading/correctness\`. The UI turns these
  into clickable chips that jump to that field in the CB responses view.
- "model_a"/"model_b" map to model codenames via rank.json model_assignment; always state the mapping once.
- Verify before you assert: every specific number or quoted prompt in rank.json is a falsifiable
  claim — use the search tool against the trajectories before calling it accurate or fabricated.
  For quoted prompts, search distinctive n-grams, not the full literal; for absence claims
  ("never X"), remember a search HIT refutes the claim.
- Use complete 24-char task and annotator IDs, never truncated forms.
- Annotator idle time and a missing task definition are INFORMATIONAL only, never findings (customer policy 2026-06-09).
`.trim();

const REVIEW_PROMPT = `
You are an expert ACC delivery auditor writing review.md for a QM reviewer. The reviewer is
busy: the document must surface what matters in seconds, not minutes. Substance over prose.

Investigate the task thoroughly using your tools (list_files first, then rank.json, both
trajectories, ranking_proof justifications, snapshots as needed). Then output ONLY the final
markdown document (no preamble) with EXACTLY this structure:

# Review — <task_id>

\`\`\`autoqc
One line per V11 QC dimension this task trips, worst first: "<R-key> — <dimension>: <one-phrase reason>".
\`\`\`
This renders as the "Auto-QC read" panel at the very top — a scannable index of EVERY QC failure
detected (each R-key is a clickable chip that opens that rubric card). Be comprehensive: list
every dimension you found evidence for (R1-R25 — completeness, summary accuracy, A/B fairness,
score deltas, prompt match, milestone leakage, spelling, cheating, etc.), not only the blockers.
Sentence case, no other markdown. Example lines:
R6 — Trajectory completeness: model_a is a 2-message greeting stub
R12 — Summary accuracy: model_1 claims (strsep fix, unit tests) absent from the trajectory
R3 — Prompt matching: model_a and model_b initial prompts are not an exact match
If the task is clean, output the single line: NONE.

\`\`\`alerts
Short title, eight words max — one-sentence detail in plain language.
\`\`\`
The alerts block renders as a "Critical issues" card below the Auto-QC read. One line per
glaring issue, worst first, ONLY true blockers — things the reviewer must know before reading
anything else. Each line is "title — detail", sentence case (never all caps; acronyms fine),
no markdown inside. Example:
Model A is a 2-message greeting stub — the winner-side trajectory contains no work, so every model_1 claim is unverifiable.
If there are no glaring issues, output the block with the single line: NONE.

## Verdict
**Proposed bucket: HARD_FAIL | SOFT_FAIL | PASS** — then at most 3 sentences why.

## At a glance
A markdown table, one row per fact: models (codename → real model mapping), ranks, preference
rating, trajectory lengths (msgs, user turns), milestones entered, claim spot-check result.

## Findings
One block per finding, most severe first, EACH separated by a horizontal rule (---).
Block format:
### [HARD|SOFT|INFO] F<n> — <short title>
- **Claim:** "<verbatim quote>" — \`<rank.json field path>\`
- **Evidence:** search hits / quoted trajectory text, with traj:// citations
- **Rule:** the ONE V11 QC dimension this violates, as a spec:// link with its name —
  e.g. [R12 Summaries · Accuracy](spec://R12). MANDATORY on every HARD and SOFT finding.
- **Impact:** which side, whether rank/scores are affected
Keep each block under ~8 lines. Do NOT merge multiple problems into one block — one error,
one block. No filler sentences; every line must carry a fact.

Check at minimum: initial-prompt consistency between models, claim accuracy of every specific
number/quote in the rationales, coaching/guidance asymmetry, duplicate prompts, stub/forfeit
trajectories (≤3 msgs or greeting-stub "Hello! How can I help you today?"), milestone coverage,
ranking_proof justification vs rank.json consistency.

## Informational
Idle time, missing task definition, and other non-finding observations. One bullet each.

CLEAN-PASS SHORTCUT (saves reviewer time): if the task is a clean PASS — no HARD/SOFT on any
layer and the rank-driving claim is confirmed against the trajectory — keep the review LIGHT.
Output: autoqc NONE, a one-sentence Verdict, the At a glance table, and a single Findings line
"No findings — rank-driving claim read-confirmed. Flag to admin for a more detailed review if
anything looks off." Do not pad with INFO blocks or invent findings.
`.trim();

const REMEDIATION_PROMPT = `
You are an expert ACC delivery auditor writing remediation.md — a pinpoint repair manual.
The reviewer should never have to hunt: every fix names the exact place to go and the exact
change to make. Verify anything you rely on from review.md with your tools first.

FIRST decide whether this is a TRAJECTORY-DEFECT task, because those are NOT normally remediable
and must NOT get a list of content fixes. A trajectory defect = an incomplete trajectory, missing
milestones, or a greeting/placeholder stub (e.g. only "hello" / "Hello! How can I help you today?")
on one or both sides. When you see one, there is nothing to "fix" in rank.json — the work is to
recover or redo the trajectory. Differentiate by reading BOTH models' actual responses in the
trajectories (and the rank.json summaries):

- **Genuinely incomplete trajectory** — if the defective side's responses are themselves stunted /
  nonsensical / abandoned (the model never really did the task), then the session itself was
  incomplete and the real trajectory most likely does NOT exist anywhere. → This task is UNUSABLE
  as shipped: it must be redone from scratch. Do not propose content edits.
- **Trajectory not pulled correctly** — if BOTH sides actually contain well-formed, substantive
  responses in the underlying data but a shipped trajectory file is a stub/empty/truncated, then
  the real trajectory exists and was just exported wrong. → Direct the QM to locate the missing
  trajectory in a different VERSION CARD on agent-env and perform a MANUAL BACKFILL, and to TRACK
  the backfill in the team Google Sheet. Do not propose content edits.

If it IS a trajectory defect, output this instead of the normal fix list:

# Remediation — <task_id>

\`\`\`alerts
One sentence: which defect and the single required action (e.g. "Greeting-stub on model_a — recover the real trajectory from another agent-env version card and backfill, or mark unusable.")
\`\`\`

## Trajectory defect
- **What's wrong:** the defect + the side(s), with a traj:// citation, and the deciding V11 link ([R6 Trajectory Completeness](spec://R6)).
- **Which case:** state "genuinely incomplete" vs "not pulled correctly" and the evidence — quote/summarize both models' responses you inspected (well-formed vs stunted) that led to the call.
- **Action (the only path):**
  - If *not pulled correctly*: "Find the trajectory in another version card for this task on agent-env, manually backfill it into this delivery, and log the backfill in the team Google Sheet (task id, version card used, who/when)." Nothing in rank.json should be edited until the real trajectory is in place.
  - If *genuinely incomplete*: "This task is unusable as shipped — the trajectory was never completed and the real one does not live elsewhere. It must be redone end-to-end; do not attempt content fixes. Escalate for re-collection."
- **Do NOT** propose rank.json/claim/score edits — they are meaningless against a missing or fake trajectory.

Stop there for trajectory defects (no Fix list / Re-audit checklist). Otherwise, for a normal task
with a real trajectory, use the structure below.

# Remediation — <task_id>

\`\`\`alerts
One "title — detail" line in sentence case if the task is unsalvageable without vendor action, otherwise: NONE
\`\`\`

## Fix list
One block per fix, in the order they must be done, separated by --- . Block format
(number fixes "Fix 1", "Fix 2" — never "R1", to avoid colliding with the QC rubric's R-keys):
### Fix <n> — <imperative title> (owner: annotator | vendor | internal-QM)
- **Go to:** the exact location — file + field path for rank.json edits
  (e.g. \`rank.json /results/<codename>/grading/correctness/rationale\`), or the trajectory
  point as a traj:// citation, or the exact artifact file (e.g. \`ranking_proof/a_proof_justification.txt\`)
- **Problem:** one line, ending with the violated V11 dimension as a spec:// link —
  e.g. [R6 Trajectory Completeness](spec://R6).
- **Fix:** the concrete change. For text edits give before → after: quote the current wrong
  text, then give replacement text the owner can paste or adapt. For re-exports/re-runs give
  the exact artifact to produce.
- **Verify:** the exact check that proves the fix landed (a search string + expected hit count,
  a field value, a message index to re-read).

(Do NOT emit a re-audit checklist section — reviewers track per-finding sign-off in the
dedicated Checklist tab, so a duplicate checklist here is redundant.)

## Escalate instead if
Bullet conditions under which remediation is wrong (byte-identical unremediated resubmission,
vendor stub, fabrication pattern across tasks) and who to escalate to.

CLEAN-PASS SHORTCUT: if the task is a clean PASS, the whole remediation is just — alerts NONE,
one line "No fixes required — clean PASS. Flag to admin for a more detailed review if deeper
verification is wanted.", then the "## Escalate instead if" section. No Fix list.
`.trim();

export async function generateDoc(bucket, id, which, onEvent, onUsage) {
  return generateDocForDir(taskDir(bucket, id), which, { onEvent, onUsage, id });
}

// Generate review.md / remediation.md against an absolute task directory.
// Used by the app (via generateDoc) and by tools/gen_docs.mjs to pre-bake docs
// into a delivery folder before it's zipped for upload.
export async function generateDocForDir(dir, which, { onEvent, onUsage, id = path.basename(dir) } = {}) {
  if (isRliTask(dir)) {
    const doc = cleanDoc(await generateRliDoc(dir, which, { onEvent, onUsage, id }));
    writeFileIn(dir, `${which}.md`, doc);
    return doc;
  }
  const isReview = which === 'review';
  const system = [
    isReview ? REVIEW_PROMPT : REMEDIATION_PROMPT,
    QUALITY_CANON,
    CITATION_RULES,
    taskContextForDir(dir, { id }),
  ].join('\n\n');

  const userParts = [`Generate ${which}.md for task ${id}. Use complete IDs.`];
  if (!isReview) {
    const reviewPath = path.join(dir, 'review.md');
    if (fs.existsSync(reviewPath)) {
      userParts.push('Current review.md:\n\n' + fs.readFileSync(reviewPath, 'utf8').slice(0, 30_000));
    } else {
      userParts.push('No review.md exists yet — investigate from scratch.');
    }
  }

  const { final } = await runAgentLoop({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userParts.join('\n\n') },
    ],
    tools: TOOL_DEFS,
    executor: makeExecutorForDir(dir),
    onEvent,
    maxSteps: 25,
    onUsage,
  });

  const doc = cleanDoc(final);
  writeFileIn(dir, `${which}.md`, doc);
  return doc;
}

// Models sometimes wrap whole-document output in a ```markdown fence and/or
// prefix it with a "Let me compile the review" lead-in — keep only the doc,
// which always starts at the first H1.
function cleanDoc(s) {
  const m = s.trim().match(/^```(?:markdown|md)?\n([\s\S]*)\n```$/);
  let doc = (m ? m[1] : s).trim();
  const h1 = doc.search(/^# /m);
  if (h1 > 0) doc = doc.slice(h1);
  return doc.trim() + '\n';
}
