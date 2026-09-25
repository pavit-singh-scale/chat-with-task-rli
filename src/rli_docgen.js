// RLI eval: review.md + remediation.md for an RLI task.
//
// Same document skeleton as the ACC docs (so the Review / Remediation tabs, the
// Auto-QC panel, the findings checklist and the fix controls all work
// unchanged), but graded against the Updated RLI spec (D1–D20) and evidenced
// the RLI way: criteria, artifacts and preference cells — and the renders
// themselves, via view_artifact, because most RLI verdicts are visual.
//
// This is a human-assisted eval: every finding is a claim the auditor
// adjudicates in the checklist, and every fix is a proposal they approve,
// edit or deny. Nothing here changes task.json on its own.
import fs from 'node:fs';
import path from 'node:path';
import { runAgentLoop } from './llm.js';
import { RLI_TOOL_DEFS, makeRliExecutor, rliCanon, rliTaskContext, RLI_CITATION_RULES } from './rli_acey.js';

const EVIDENCE = `
Evidence discipline (the whole value of this eval):
- Every finding cites where it lives: [C12](crit://C12), [C12 · AD2](crit://C12/ad2),
  [Render07.jpg](file://files/golden/Render07.jpg), [RD vs AD1 · Realism](pref://rd_vs_ad1/realism),
  and the deciding dimension as [D17 Accuracy](spec://D17).
- A verdict or justification that makes a VISUAL claim is only confirmed or overturned after you
  have looked (view_artifact — for video it shows stills). Claims about duration, resolution,
  orientation, format, loudness, clipping, truncation or silence are settled with probe_media:
  quote the numbers. Say what you saw or measured, concretely. What neither can settle (3D-only
  geometry, motion, pacing, voice quality) — say so and mark it for the auditor instead of guessing.
- Penalty criteria: "passed: true" = the defect is PRESENT. Never invert this.
- The printed RD score is the source of truth for the 97% gate; AD stumping uses the score after
  your verdict corrections — say both when a correction moves a gate.
- For every criterion you verify, check TWO things per side: is the verdict right, and does the
  justification describe what is actually in the artifact? A correct verdict with a justification
  that describes different or opposite geometry/content is an inaccurate justification (D12) — the
  customer has explicitly flagged inverted, generic and copy-pasted justifications. Grammar-only
  cleanups are not a substitute: the fix must make the text true to the artifact.
- Read every penalty verdict against its OWN justification: a justification that says the defect is
  absent beside passed:true (or describes it beside passed:false) is an inverted verdict — decidable
  from the text alone, so check all penalty criteria, not just the ones you sample. Watch negation
  scope ("with none missing", "does not change the rate" describe passes).
- Grounding: for each heavy criterion ask "where does the brief or an input ask for this?". A
  criterion that grades content, values or style the brief never mentions — often the golden's own
  choices written up as requirements — is D5/D8 unless a professional standard justifies it; name
  the brief text you searched. A criterion so specific it describes one model's single observed
  slip (the customer's example: "'Ugh!' is pronounced 'Ugg!'") is post-hoc — D8.
- Automated checks (get_checks) are evidence, not verdicts. Confirm each fail with your own read
  and overturn it if the record says otherwise (e.g. a provenance criterion worded differently).
- Budget: spot-verify, don't re-grade everything. Prioritise heavy (|w| ≥ 8) criteria, split
  verdicts, only-AD1 fails, golden fails, and anything a check flagged. ~12–20 criteria is typical.
`.trim();

export const RLI_REVIEW_PROMPT = `
You are the QC auditor for the RLI queue writing review.md for one task. The reader is a busy QM
who must adjudicate your findings in seconds. Grade the CONTRIBUTOR'S WORK — brief, rubric,
verdicts, justifications, preference ranking — against the RLI QC spec (D1–D20 below).

Work plan: task_overview → get_checks (a failing "Scores reproduce" check means the score gates
can't be trusted — say so first; "Justification integrity" hits are exact reuse, confirm which copy
is wrong) → the brief (in context) → get_criteria with narrow filters →
view_artifact on the refs + the three sides for the criteria you verify → get_preference and judge
the 1–7 ratings against what you saw → coverage: list the brief's explicit requests and the
professional nuances of this domain, and check each has a criterion.

Output ONLY the markdown document, exactly this structure:

# Review — <task_id>

\`\`\`autoqc
One line per spec dimension this task trips, worst first: "<D-key> — <dimension>: <one-phrase reason>".
Be comprehensive (every dimension with evidence, Fail or Non-fail). Sentence case, no markdown.
If nothing trips, the single line: NONE.
\`\`\`

\`\`\`alerts
Only true blockers, worst first: "Short title — one-sentence detail". Otherwise the single line: NONE.
\`\`\`

## Verdict
**Proposed bucket: HARD_FAIL | SOFT_FAIL | PASS** — HARD_FAIL if any dimension is a Fail (1),
SOFT_FAIL if none fail but any is a Non-fail (3), PASS only if every dimension is No issues (5).
Then at most 3 sentences: the deciding dimension(s) and why.

## At a glance
A table: domain · timeline · AD1/AD2 models · RD / AD1 / AD2 printed scores vs gates · criteria
count · weight mix (format/brief/quality) · criteria you verified by eye (count) · verdicts you
would flip (count, and the AD score after flips if it moves a gate).

## Findings
One block per finding, most severe first, each separated by ---:
### [HARD|SOFT|INFO] F<n> — <short title>
- **Claim:** what the contributor asserted (quote the criterion text, verdict or justification) — cite it
- **Evidence:** what you read or SAW, with citations to the files/cells you checked
- **Rule:** the ONE spec dimension it violates, as a spec:// link — mandatory on HARD and SOFT
- **Impact:** which side(s), and whether a gate or the grade moves
HARD = the finding alone makes a dimension a Fail (1); SOFT = a Non-fail (3); INFO = worth knowing,
no grade impact. One problem per block. Under ~8 lines each. No filler.

## Informational
Non-finding observations, one bullet each (e.g. things only a human can check — 3D-only geometry,
audio, video — with what to look for).

CLEAN-PASS SHORTCUT: if every dimension is No issues after your checks, keep it light: autoqc NONE,
alerts NONE, a one-sentence Verdict, the At a glance table, and one Findings line: "No findings —
N criteria verified against the artifacts. Flag for a deeper audit if anything looks off."

${EVIDENCE}
`.trim();

export const RLI_REMEDIATION_PROMPT = `
You are the QC auditor for the RLI queue writing remediation.md — a pinpoint repair manual for the
contributor's fixes. Verify anything you rely on from review.md with your tools first. Output ONLY
the markdown document:

# Remediation — <task_id>

\`\`\`alerts
One "title — detail" line if the task cannot be salvaged by edits (e.g. brief/input sufficiency
fail, golden not professional grade), otherwise: NONE
\`\`\`

## Fix list
One block per fix, in the order they should be done, separated by --- :
### Fix <n> — <imperative title> (owner: contributor | QM | ops)
- **Go to:** the exact place — a criterion citation, a file citation, a preference cell, or the brief
  section
- **Problem:** one line ending with the violated dimension as a spec:// link
- **Fix:** the concrete change — before → after for text; the exact new verdict or weight; for a
  missing criterion, the full criterion text + weight + category ready to paste
- **Verify:** how to confirm it landed (which file to look at, what the score becomes)
- When the fix is a single-field edit to the record, ALSO emit a machine-applicable block the
  auditor can apply with one click — single-line JSON inside a \`\`\`fix fence:
  \`\`\`fix
  {"id":"F1","rule":"D12","class":"soft","status":"PROPOSED","owner":"contributor","path":"/rubric_eval/criteria/0/ad2/justification","occurrence":1,"old":"<exact current substring>","new":"<replacement>"}
  \`\`\`
  JSON pointers into task.json (criteria are 0-based: C1 is /rubric_eval/criteria/0):
    /rubric_eval/criteria/<i>/<golden|ad1|ad2>/justification   (string; "old" = exact substring)
    /rubric_eval/criteria/<i>/<golden|ad1|ad2>/passed          (boolean; old "true", new "false")
    /rubric_eval/criteria/<i>/weight                           (number; old "6", new "9")
    /rubric_eval/criteria/<i>/title                            (string; criterion text)
    /brief                                                     (string; exact substring)
  "old" must be copied EXACTLY from the record (read it with get_criteria first). class is
  "hard" or "soft". Adding a new criterion or re-scoring cannot be a fix block — describe it in the
  prose block only (path would be null). Flipping a verdict changes the score: say so in Verify.

## Escalate instead if
Bullets: when edits are the wrong response (unsalvageable brief/inputs, golden below professional
grade, suspected fabricated or AI-generated golden) and who to escalate to (QM → Luis / Ernesto).

CLEAN-PASS SHORTCUT: alerts NONE, one line "No fixes required — clean.", then Escalate instead if.

${EVIDENCE}
`.trim();

export async function generateRliDoc(dir, which, { onEvent, onUsage, id = path.basename(dir) } = {}) {
  const isReview = which === 'review';
  const system = [
    isReview ? RLI_REVIEW_PROMPT : RLI_REMEDIATION_PROMPT,
    rliCanon(),
    RLI_CITATION_RULES,
    rliTaskContext(dir),
  ].join('\n\n');
  const user = [`Generate ${which}.md for task ${id}. Use the complete 24-char task id.`];
  if (!isReview) {
    const rp = path.join(dir, 'review.md');
    user.push(fs.existsSync(rp) ? `Current review.md:\n\n${fs.readFileSync(rp, 'utf8').slice(0, 30_000)}` : 'No review.md exists yet — investigate from scratch.');
  }
  const { final } = await runAgentLoop({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user.join('\n\n') }],
    tools: RLI_TOOL_DEFS,
    executor: makeRliExecutor(dir),
    onEvent,
    maxSteps: 40,
    onUsage,
  });
  return final;
}

// "**Proposed bucket: HARD_FAIL**" → 'HARD_FAIL' (null when absent or malformed).
export function proposedBucket(reviewMd) {
  const m = String(reviewMd || '').match(/Proposed bucket:\s*\**\s*(HARD_FAIL|SOFT_FAIL|PASS)\b/);
  return m ? m[1] : null;
}
