// RLI eval: one structured findings list per task (eval.json), from which the
// studio renders both review.md and remediation.md.
//
// Why one list instead of two essays: the old review + remediation ran ~4,000
// words, said every point four times, and the two docs could contradict each
// other (a remediation that quietly overturned the review's HARD finding). Now
// the model returns short, capped fields; the CODE validates them, derives the
// bucket from the worst severity, builds the fix blocks, and writes both docs —
// so they can't disagree, and every existing reader of review.md /
// remediation.md (autoqc tags, findings checklist, fix ledger, auto-bucketing,
// Acey) keeps working unchanged.
//
// Still human-assisted: every finding is a claim the auditor adjudicates, and
// every fix is a proposal they approve, edit or deny.
import fs from 'node:fs';
import path from 'node:path';
import { runAgentLoop } from './llm.js';
import { RLI_TOOL_DEFS, makeRliExecutor, rliCanon, rliTaskContext, RLI_CITATION_RULES } from './rli_acey.js';
import { readRecord } from './rli.js';
import { RLI_SPEC } from './spec.js';

export const CAPS = { headline: 15, evidence: 45, fixSummary: 14, manualNote: 15, escalate: 30, verdict: 25, maxFindings: 12, checkNote: 14 };
const SEVS = ['HARD', 'SOFT', 'INFO'];
const SIDE_KEY = { rd: 'golden', golden: 'golden', ad1: 'ad1', ad2: 'ad2' };
const SIDE_LABEL = { golden: 'RD', ad1: 'AD1', ad2: 'AD2' };
const FIELDS = ['passed', 'justification', 'weight', 'title'];

// The claim-sheet audit columns (P00 924 Audit sheet) — every finding is filed
// under one, so the report pre-fills the auditor's sheet.
export const CLAIM_COLUMNS = {
  brief: 'Brief issues',
  files: 'File names',
  weights: 'Criteria weight distribution',
  quality: 'Quality rubric checks',
  stump_ad1: 'AD1 stump < 70%',
  stump_ad2: 'AD2 stump < 50%',
  golden: 'Golden ≥ 97%',
  count: '40–100 criteria',
  rankings: 'Rankings make sense',
  overfitting: 'Rubric overfitting',
  atomicity: 'Atomicity / self-containment',
  provenance: 'Generate original files',
  grading: 'Verdict accuracy',
};

const SUBSTANCE = `
SUBSTANCE ONLY — what this eval is for:
- Report problems that change a verdict, a score, a gate, or whether a deliverable meets the brief.
- Never report spelling, grammar, punctuation, capitalisation or wording polish — in criteria, in
  justifications, in the brief or in the preference text — unless the wording changes the MEANING
  (the criterion then grades the wrong thing) or makes it ungradeable. File names and paths are
  not "wording": a brief path that doesn't match the delivered file is substantive.
- Justifications: flag one only when it is WRONG for that side (describes content that deliverable
  doesn't have, or the opposite of what's there), sits on the wrong criterion, or contradicts its
  own verdict. An accurate justification that is generic or reused across sides is not a finding;
  if reuse is widespread, one INFO roll-up at most — never a flag per criterion.

The customer's error classes (PKJA customer feedback) — check each:
1. Brief ambiguity: a request that reads two ways (e.g. "9 variations in a 3x3 grid" + "replicate the
   sample in the grid" = 10?), or specs that contradict (2560x1440 "16:9" but a 9:16 vertical ask).
   Any criterion that penalises a model for the other reading is unfair.
2. Ground-truth quality: the brief or golden asserts something false (rupee amounts illustrated with
   US bills, chroma-key spill, a golden that fails its own criterion). Criteria around it must still
   reward/penalise correctly.
3. Brief/input coherence: every input the brief names must match the delivered file exactly — name,
   extension and root (input/...). Typos in roots (inpu/), wrong extensions (.wav vs .m4a), spaces
   vs underscores, hard-coded golden_output/ prefixes.
4. Evaluation fairness: validate every FAIL against the passes on the same criterion (Yes/No/No —
   is the pass really better?), and every pass against what the artifact shows.
5. Overfitting: a criterion written around one model's specific slip (a named mispronunciation, a
   TTS artefact) rather than a professional standard.
6. Misplaced justifications: text that belongs to a different criterion or a different side.
7. Render provenance: 3D/CAD tasks whose deliverables are renders/exports must carry a Critically
   Detrimental (-8 to -10) criterion penalising generation-from-scratch — even if every model passes.
8. Coverage beyond the literal brief: what a commissioner would check (furnished interiors in an
   exterior render, uncanny details), and whether the output achieves the brief's GOAL (an ad sells
   to its audience, a podcast gets its point across, a poster gets people to attend).
9. Weight distribution: 5% formatting / 30% brief compliance / 65% aesthetics + functionality +
   usability/professionalism, measured on positive weight (spec gate >= 65%; the claim sheet
   tolerates >= 55% on the quality bucket — report the number, cite the gate).
`.trim();

const EVIDENCE = `
Evidence discipline (the whole value of this eval):
- A verdict or justification that makes a VISUAL claim is only confirmed or overturned after you
  have looked (view_artifact — for video it shows stills). Claims about duration, resolution,
  orientation, format, loudness, clipping, truncation or silence are settled with probe_media:
  quote the numbers. What neither can settle (3D-only geometry, motion, pacing, voice quality)
  goes in manual_checks instead of being guessed.
- Penalty criteria: "passed: true" = the defect is PRESENT. Never invert this.
- For every criterion you verify, check TWO things per side: is the verdict right, and does the
  justification describe what is actually in the artifact? A correct verdict with a justification
  describing different or opposite content is an inaccurate justification (D12) — the customer has
  explicitly flagged inverted and misplaced justifications. (Generic-but-accurate is not a finding.)
- Read every penalty verdict against its OWN justification: a justification that says the defect is
  absent beside passed:true (or describes it beside passed:false) is an inverted verdict — decidable
  from the text alone, so check all penalty criteria. Watch negation scope ("with none missing",
  "does not change the rate" describe passes).
- Grounding: for each heavy criterion ask "where does the brief or an input ask for this?". A
  criterion grading content, values or style the brief never mentions — often the golden's own
  choices written up as requirements — is D5/D8 unless a professional standard justifies it. A
  criterion so specific it describes one model's single observed slip (the customer's example:
  "'Ugh!' is pronounced 'Ugg!'") is post-hoc — D8.
- Check the flips you propose TOGETHER before calling a gate: never report a stumping breach that
  another flip you also propose would cancel. The studio computes the scores after your fixes.
- Automated checks (get_checks) are evidence, not verdicts. A failing "Scores reproduce" check means
  the score gates can't be trusted — that is finding #1. "Justification integrity" hits are exact
  reuse: confirm which copy is wrong.
- Budget: spot-verify, don't re-grade everything. Prioritise heavy (|w| ≥ 8) criteria, split
  verdicts, only-AD1 fails, golden fails, and anything a check flagged.
`.trim();

export const RLI_EVAL_PROMPT = `
You are the QC auditor for the RLI queue. Grade the CONTRIBUTOR'S WORK — brief, rubric, verdicts,
justifications, preference ranking — against the RLI QC spec (D1–D20 below). The reader is a busy
QM who must understand each finding in five seconds and act on it in one click.

Work plan: task_overview → get_checks → the brief (in context) → get_criteria with narrow filters →
view_artifact / probe_media on the refs and the three sides for the criteria you verify →
get_preference, judged against what you saw → coverage: the brief's explicit requests and the
professional nuances of the domain each have a criterion.

OUTPUT: ONLY one JSON object, no prose, no code fence. Shape:
{
  "verdict": "<≤${CAPS.verdict} words: the deciding problem(s), plain English — no bucket word, no D-codes (the UI shows both)>",
  "findings": [
    {
      "sev": "HARD" | "SOFT" | "INFO",
      "dim": "D17",
      "crit": 31,             // C-number this is about, or null for rubric/brief/task-level
      "side": "ad2",          // "rd" | "ad1" | "ad2" | null
      "headline": "<≤${CAPS.headline} words — the finding itself, e.g. 'Passed on paving that isn't in the render'>",
      "evidence": "<≤${CAPS.evidence} words, ≤2 sentences — what you SAW or measured, with citation links>",
      "owner": "contributor" | "QM" | "ops",
      "column": "brief" | "files" | "weights" | "quality" | "stump_ad1" | "stump_ad2" | "golden" | "count" | "rankings" | "overfitting" | "atomicity" | "provenance" | "grading",
      "fix": null | {
        "summary": "<≤${CAPS.fixSummary} words, imperative — e.g. 'Flip to fail; describe the blank ground plane'>",
        "edits": [ { "crit": 31, "side": "ad2", "field": "passed", "old": "true", "new": "false" },
                   { "crit": 31, "side": "ad2", "field": "justification", "old": "<exact current text or substring>", "new": "<replacement>" } ],
        "manual": null | "<paste-ready text when it can't be a field edit, e.g. a whole new criterion: text + weight + category + RD/AD1/AD2 verdicts>"
      }
    }
  ],
  "manual_checks": [ "<≤${CAPS.manualNote} words each — what only a human can check, and where>" ],
  "escalate": null | "<≤${CAPS.escalate} words — only if edits can't salvage the task (brief/inputs insufficient, golden below professional grade, suspected AI-generated golden)>",
  "verified": { "criteria": <n criteria you checked against artifacts>, "artifacts": <n files you opened> },
  "checked": [ { "crit": 12, "ok": true, "note": "<≤${CAPS.checkNote} words — what you confirmed, e.g. 'All three verdicts match the renders'>" } ]
}

"checked" lists EVERY criterion you actually verified (verdicts + justifications against the artifacts
or the record), ok=false for ones with a problem — each of those must also have a finding with that crit.
It drives the per-criterion eval marks on the Rubric tab, so don't list criteria you only skimmed.

Rules for findings:
- At most ${CAPS.maxFindings}. One problem each, most severe first. A wrong verdict is ONE finding per
  criterion (crit set, its flip + justification rewrite as the edits) — never bundle flips on several
  criteria. Merge only pattern findings with no verdict flips: "24 justifications copied across
  responses" is ONE finding, not 24.
- HARD = alone makes a dimension a Fail (1). SOFT = a Non-fail (3). INFO = no grade impact.
- dim is mandatory on HARD and SOFT: the ONE deciding dimension.
- Word caps are enforced by code and over-long output is sent back. Headlines state the problem,
  not the evidence: no number soup, no "Note that", no hedging.
- Edits: field is "passed" (old/new "true"/"false"), "justification" or "title" (old = EXACT current
  text or an exact substring — read it with get_criteria first), or "weight" (old/new numbers as
  strings). For the brief use {"field":"brief","old":…,"new":…} with crit/side null. crit is the
  C-number (1-based). side is required for passed/justification. A verdict flip usually needs a
  justification rewrite beside it. Anything else (a new criterion, re-scoring) goes in "manual".
- column: the claim-sheet column the finding belongs to (grading = a verdict or justification
  that's wrong; quality = redundancy/coverage/relevance/depth; see the list above for the rest).
- Clean task: findings [], a one-line verdict, manual_checks for what you could not see.

${SUBSTANCE}

${EVIDENCE}
`.trim();

// ------------------------------------------------------------ validation

const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

function extractJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON object in the reply');
  return JSON.parse(s.slice(a, b + 1));
}

// Resolve an edit against the live record → a fix-ledger block, or an error.
function resolveEdit(rec, e, n) {
  if (e.field === 'brief') {
    if (typeof e.old !== 'string' || !e.old || !String(rec.brief || '').includes(e.old)) return { error: `edit ${n}: brief "old" is not an exact substring of the brief` };
    return { path: '/brief', old: e.old, new: String(e.new ?? '') };
  }
  if (!FIELDS.includes(e.field)) return { error: `edit ${n}: field must be one of ${FIELDS.join(', ')}, brief` };
  const crits = rec.rubric_eval?.criteria || [];
  const i = Number(e.crit) - 1;
  if (!Number.isInteger(i) || !crits[i]) return { error: `edit ${n}: crit C${e.crit} does not exist (1–${crits.length})` };
  const c = crits[i];
  if (e.field === 'weight' || e.field === 'title') {
    const cur = String(e.field === 'weight' ? c.weight : c.title ?? '');
    if (e.field === 'weight' ? String(e.old) !== cur : !cur.includes(String(e.old || ''))) return { error: `edit ${n}: C${e.crit} ${e.field} is "${cur.slice(0, 80)}", not "${String(e.old).slice(0, 80)}"` };
    return { path: `/rubric_eval/criteria/${i}/${e.field}`, old: String(e.old), new: String(e.new ?? '') };
  }
  const side = SIDE_KEY[String(e.side || '').toLowerCase()];
  if (!side) return { error: `edit ${n}: side must be rd, ad1 or ad2` };
  const v = c[side] || {};
  if (e.field === 'passed') {
    // Models write verdicts in words as often as booleans; the record stores booleans.
    const asBool = (x) => ({ pass: 'true', passed: 'true', yes: 'true', true: 'true', fail: 'false', failed: 'false', no: 'false', false: 'false' })[String(x).trim().toLowerCase()] ?? String(x);
    e = { ...e, old: asBool(e.old), new: asBool(e.new) };
    const cur = String(v.passed);
    if (String(e.old) !== cur) return { error: `edit ${n}: C${e.crit}·${SIDE_LABEL[side]} passed is ${cur}, not ${e.old}` };
    if (!['true', 'false'].includes(String(e.new)) || String(e.new) === cur) return { error: `edit ${n}: passed must flip to the other boolean` };
    return { path: `/rubric_eval/criteria/${i}/${side}/passed`, old: cur, new: String(e.new) };
  }
  const cur = String(v.justification || '');
  if (!e.old || !cur.includes(String(e.old))) return { error: `edit ${n}: C${e.crit}·${SIDE_LABEL[side]} justification does not contain "${String(e.old || '').slice(0, 80)}" — copy it exactly` };
  return { path: `/rubric_eval/criteria/${i}/${side}/justification`, old: String(e.old), new: String(e.new ?? '') };
}

export const columnForDim = (d) => ({ D17: 'grading', D12: 'grading', D13: 'grading', D20: 'provenance', D4: 'weights', D19: 'files', D15: 'brief',
  D1: 'rankings', D2: 'rankings', D9: 'atomicity', D10: 'atomicity', D14: 'golden', D18: 'stump_ad1', D3: 'count' })[d] || 'quality';

// Returns { ev, errors }. ev is normalized; errors are what the model must fix.
export function validateEval(raw, dir) {
  const rec = readRecord(dir);
  const nCrit = rec.rubric_eval?.criteria?.length || 0;
  const errors = [];
  const cap = (label, s, max) => { if (words(s) > max) errors.push(`${label} is ${words(s)} words (max ${max}): "${String(s).slice(0, 90)}…"`); };
  if (!raw || typeof raw !== 'object') return { ev: null, errors: ['reply is not a JSON object'] };
  cap('verdict', raw.verdict, CAPS.verdict);
  const findings = Array.isArray(raw.findings) ? raw.findings : [];
  if (!Array.isArray(raw.findings)) errors.push('findings must be an array');
  if (findings.length > CAPS.maxFindings) errors.push(`${findings.length} findings (max ${CAPS.maxFindings}) — merge repeats`);
  const out = findings.slice(0, CAPS.maxFindings).map((f, k) => {
    const id = `F${k + 1}`;
    const sev = String(f.sev || '').toUpperCase();
    if (!SEVS.includes(sev)) errors.push(`${id}: sev must be HARD, SOFT or INFO`);
    const dim = f.dim ? String(f.dim).toUpperCase() : null;
    if (dim && !/^D([1-9]|1\d|20)$/.test(dim)) errors.push(`${id}: dim "${f.dim}" is not D1–D20`);
    if (!dim && sev !== 'INFO') errors.push(`${id}: dim is required on ${sev}`);
    const crit = f.crit == null ? null : Number(f.crit);
    if (crit != null && !(crit >= 1 && crit <= nCrit)) errors.push(`${id}: crit C${f.crit} does not exist (1–${nCrit})`);
    const side = f.side ? SIDE_KEY[String(f.side).toLowerCase()] || null : null;
    cap(`${id} headline`, f.headline, CAPS.headline);
    cap(`${id} evidence`, f.evidence, CAPS.evidence);
    let fix = null;
    if (f.fix) {
      cap(`${id} fix.summary`, f.fix.summary, CAPS.fixSummary);
      const edits = [];
      (f.fix.edits || []).forEach((e, j) => {
        const r = resolveEdit(rec, e, `${id}.${j + 1}`);
        if (r.error) errors.push(r.error);
        else edits.push({ ...r, crit: e.crit ?? null, side: SIDE_KEY[String(e.side || '').toLowerCase()] || null, field: e.field });
      });
      // One row = one criterion: verdict flips on several criteria are several
      // findings, each with its own score impact and decision.
      const flipCrits = [...new Set((f.fix.edits || []).filter((e) => e.field === 'passed').map((e) => Number(e.crit)))];
      if (flipCrits.length > 1 || (flipCrits.length === 1 && crit != null && flipCrits[0] !== crit)) {
        errors.push(`${id}: verdict flips on ${flipCrits.map((n) => `C${n}`).join(', ')} — split into one finding per criterion, each with crit set to that criterion`);
      }
      fix = { summary: String(f.fix.summary || ''), edits, manual: f.fix.manual ? String(f.fix.manual) : null };
      if (!edits.length && !fix.manual && !fix.summary) fix = null;
    }
    return { id, sev, dim, crit: crit >= 1 && crit <= nCrit ? crit : null, side, headline: String(f.headline || '').trim(), evidence: String(f.evidence || '').trim(),
      owner: ['contributor', 'QM', 'ops'].includes(f.owner) ? f.owner : 'contributor', fix,
      column: CLAIM_COLUMNS[f.column] ? f.column : columnForDim(dim) };
  });
  const manual = (Array.isArray(raw.manual_checks) ? raw.manual_checks : []).map(String).slice(0, 6);
  manual.forEach((m, k) => cap(`manual_checks[${k}]`, m, CAPS.manualNote));
  if (raw.escalate) cap('escalate', raw.escalate, CAPS.escalate);
  // The bucket is the worst severity — derived, never taken from the model.
  const bucket = out.some((f) => f.sev === 'HARD') ? 'HARD_FAIL' : out.some((f) => f.sev === 'SOFT') ? 'SOFT_FAIL' : 'PASS';
  const ev = {
    version: 1,
    task_id: rec.task_id,
    generated_at: new Date().toISOString(),
    bucket,
    verdict: String(raw.verdict || '').trim(),
    findings: out,
    manual_checks: manual,
    escalate: raw.escalate ? String(raw.escalate).trim() : null,
    verified: { criteria: Number(raw.verified?.criteria) || 0, artifacts: Number(raw.verified?.artifacts) || 0 },
    criteria: {},
  };
  // Per-criterion coverage: crit → { ok, note, source }. A finding on a
  // criterion always wins over an "ok" the model also listed for it.
  for (const c of Array.isArray(raw.checked) ? raw.checked : []) {
    const n = Number(c?.crit);
    if (!(n >= 1 && n <= nCrit)) continue;
    const note = String(c.note || '').trim();
    if (words(note) > CAPS.checkNote + 6) errors.push(`checked C${n} note is ${words(note)} words (max ${CAPS.checkNote})`);
    ev.criteria[n] = { ok: c.ok !== false, note, source: 'eval' };
  }
  for (const f of out) {
    const crits = new Set([f.crit, ...(f.fix?.edits || []).map((e) => e.crit)].filter((x) => x >= 1 && x <= nCrit).map(Number));
    for (const n of crits) ev.criteria[n] = { ok: false, note: f.headline, finding: f.id, source: 'eval' };
  }
  return { ev, errors };
}

// ------------------------------------------------------------ run

export async function runRliEval(dir, { onEvent, onUsage, id = path.basename(dir) } = {}) {
  const system = [RLI_EVAL_PROMPT, rliCanon(), RLI_CITATION_RULES, rliTaskContext(dir)].join('\n\n');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: `Evaluate task ${id}. Reply with the JSON object only.` }];
  const { messages: added, final } = await runAgentLoop({ messages, tools: RLI_TOOL_DEFS, executor: makeRliExecutor(dir), onEvent, maxSteps: 40, onUsage });

  // Keep the raw answer first — an hour of looking at renders must never be
  // lost to a failure in what comes after.
  fs.writeFileSync(path.join(dir, 'eval.raw.txt'), final || '');
  let text = final, ev = null, errors = [];
  let best = null; // the best parse so far, errors and all
  // One repair round: the model fixes its own JSON against the exact errors,
  // with its whole investigation in context. It runs through the tool loop
  // because the proxy rejects a tool-bearing history sent without tools (and
  // re-reading a criterion to copy an exact "old" string is legitimate).
  for (let attempt = 0; attempt < 2; attempt++) {
    try { ({ ev, errors } = validateEval(extractJson(text), dir)); } catch (e) { ev = null; errors = [`invalid JSON: ${e.message}`]; }
    if (ev && (!best || errors.length < best.errors.length)) best = { ev, errors };
    if (!errors.length || attempt === 1) break;
    onEvent?.({ type: 'status', text: `repairing ${errors.length} validation issue(s)` });
    try {
      const r = await runAgentLoop({
        messages: [...messages, ...added,
          { role: 'user', content: `Your JSON has these problems — fix them and return the corrected JSON object only:\n- ${errors.join('\n- ')}` }],
        tools: RLI_TOOL_DEFS, executor: makeRliExecutor(dir), onEvent, maxSteps: 8, onUsage,
      });
      text = r.final || '';
    } catch (e) {
      onEvent?.({ type: 'status', text: `repair failed: ${e.message}` });
      break;
    }
  }
  if (best) ({ ev, errors } = best);
  if (!ev) throw new Error(`eval returned unusable JSON: ${errors.join('; ').slice(0, 300)}`);
  // Whatever is still wrong after the repair stays visible rather than dropped.
  ev.validation = errors;
  fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify(ev, null, 1));
  return ev;
}

// ------------------------------------------------------------ one criterion, on demand

const CHECK_PROMPT = `
You are the QC auditor for the RLI queue, checking ONE rubric criterion of one task: are the RD, AD1
and AD2 verdicts right, and does each justification describe what is actually in that deliverable?
Read the criterion with get_criteria, open the relevant artifacts with view_artifact / probe_media,
and read the brief (in context) when the criterion's grounding is in question.

OUTPUT: ONLY one JSON object, no prose:
{
  "ok": true | false,
  "sev": "HARD" | "SOFT" | "INFO",          // only when ok=false
  "dim": "D17",                             // the deciding spec dimension, when ok=false
  "side": "rd" | "ad1" | "ad2" | null,      // the side that is wrong, if one
  "reason": "<≤${CAPS.headline} words — the problem, or what you confirmed when ok>",
  "column": "grading" | "overfitting" | "files" | "provenance" | "quality" | "atomicity" | null,
  "explanation": "<≤${CAPS.evidence} words — what you saw or measured, with citation links>",
  "fix": null | { "summary": "<≤${CAPS.fixSummary} words>", "edits": [ { "crit": <n>, "side": "ad2", "field": "passed"|"justification"|"weight"|"title", "old": "...", "new": "..." } ], "manual": null | "<text>" }
}
Edits follow the same rules as the full eval: "old" is copied exactly from the record; a verdict
flip usually needs a justification rewrite beside it. ok=true when the verdicts are right and each
justification is accurate for its side — generic or reused wording alone is NOT a problem.
Be conservative: ok=true unless you can show
the problem. If you cannot see what the criterion needs (3D-only, motion, voice), say so in the
reason and set ok=true with the explanation starting "Not verifiable here:".

${SUBSTANCE}

${EVIDENCE}
`.trim();

export async function checkCriterion(dir, n, { onEvent, onUsage } = {}) {
  const rec = readRecord(dir);
  const nCrit = rec.rubric_eval?.criteria?.length || 0;
  if (!(n >= 1 && n <= nCrit)) throw new Error(`no criterion C${n}`);
  const system = [CHECK_PROMPT, rliCanon(), RLI_CITATION_RULES, rliTaskContext(dir)].join('\n\n');
  const messages = [{ role: 'system', content: system }, { role: 'user', content: `Check criterion C${n}. Reply with the JSON object only.` }];
  const { final } = await runAgentLoop({ messages, tools: RLI_TOOL_DEFS, executor: makeRliExecutor(dir), onEvent, maxSteps: 14, onUsage });
  const raw = extractJson(final);
  // No full eval yet: record the check, but mark the eval partial so nothing
  // downstream reads "0 findings" as a clean PASS.
  const ev = readEval(dir) || { version: 1, partial: true, task_id: rec.task_id, generated_at: new Date().toISOString(), bucket: null, verdict: '', findings: [], manual_checks: [], escalate: null, verified: { criteria: 0, artifacts: 0 }, criteria: {} };
  ev.criteria ||= {};
  // Re-checking replaces this criterion's previous on-demand finding.
  const prev = ev.criteria[n]?.finding && ev.criteria[n]?.source === 'check' ? ev.criteria[n].finding : null;
  if (prev) ev.findings = ev.findings.filter((f) => f.id !== prev);
  if (raw.ok !== false) {
    ev.criteria[n] = { ok: true, note: String(raw.reason || '').trim(), explanation: String(raw.explanation || '').trim(), source: 'check', at: new Date().toISOString() };
  } else {
    // Validate as a one-finding eval so edits resolve against the live record.
    const { ev: one, errors } = validateEval({ verdict: '', findings: [{ sev: raw.sev || 'SOFT', dim: raw.dim || 'D17', crit: n, side: raw.side || null, headline: raw.reason, evidence: raw.explanation, fix: raw.fix, column: raw.column }] }, dir);
    const f = one.findings[0];
    const nextId = `F${Math.max(0, ...ev.findings.map((x) => Number(String(x.id).slice(1)) || 0)) + 1}`;
    f.id = nextId;
    if (errors.length) f.validation = errors;
    ev.findings.push(f);
    ev.criteria[n] = { ok: false, note: f.headline, explanation: f.evidence, finding: f.id, source: 'check', at: new Date().toISOString() };
  }
  ev.bucket = ev.findings.some((f) => f.sev === 'HARD') ? 'HARD_FAIL' : ev.findings.some((f) => f.sev === 'SOFT') ? 'SOFT_FAIL' : ev.partial ? null : 'PASS';
  fs.writeFileSync(path.join(dir, 'eval.json'), JSON.stringify(ev, null, 1));
  fs.writeFileSync(path.join(dir, 'review.md'), renderReviewMd(ev));
  fs.writeFileSync(path.join(dir, 'remediation.md'), renderRemediationMd(ev));
  return ev;
}

// No missed rubric: check every criterion the full eval didn't cover, one at a
// time (they share eval.json), retrying failures. Returns what is still
// unmarked — callers treat a non-empty list as an incomplete eval.
export function uncoveredCriteria(dir) {
  const n = readRecord(dir).rubric_eval?.criteria?.length || 0;
  const ev = readEval(dir) || {};
  const out = [];
  for (let i = 1; i <= n; i++) if (!ev.criteria?.[i]) out.push(i);
  return out;
}
export async function ensureCoverage(dir, { onUsage, onProgress, retries = 2 } = {}) {
  const errors = {};
  for (let attempt = 0; attempt <= retries; attempt++) {
    const todo = uncoveredCriteria(dir);
    if (!todo.length) break;
    for (const [k, n] of todo.entries()) {
      onProgress?.({ n, done: k, total: todo.length, attempt });
      try { await checkCriterion(dir, n, { onUsage }); delete errors[n]; }
      catch (e) { errors[n] = String(e.message || e).slice(0, 160); }
    }
  }
  const missing = uncoveredCriteria(dir);
  return { missing, errors: Object.fromEntries(missing.map((n) => [n, errors[n] || 'not checked'])) };
}

export function readEval(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'eval.json'), 'utf8')); } catch { return null; }
}

// ------------------------------------------------------------ markdown (compat)

const dimName = (d) => {
  const i = Number(String(d || '').replace(/\D/g, '')) - 1;
  return RLI_SPEC?.dimensions?.[i]?.name || d;
};
const whereOf = (f) => (f.crit ? `C${f.crit}${f.side ? ` · ${SIDE_LABEL[f.side]}` : ''}` : 'Task');
const whereLink = (f) => (f.crit ? `[${whereOf(f)}](crit://C${f.crit}${f.side ? `/${f.side === 'golden' ? 'rd' : f.side}` : ''})` : 'Task-level');
export const fixBlockId = (f, j) => `${f.id}${String.fromCharCode(97 + j)}`;

export function renderReviewMd(ev) {
  const hard = ev.findings.filter((f) => f.sev === 'HARD');
  const tagged = ev.findings.filter((f) => f.dim && f.sev !== 'INFO');
  return [
    `# Review — ${ev.task_id}`, '',
    // A check-only (partial) eval has no autoqc fence: the board reads
    // "NONE" as audited-clean, and nothing has been audited yet.
    ...(ev.partial && !tagged.length ? [] : ['```autoqc',
      ...(tagged.length ? tagged.map((f) => `${f.dim} — ${dimName(f.dim)}: ${f.headline}`) : ['NONE']),
      '```', '']),
    '```alerts',
    ...(hard.length ? hard.map((f) => `${f.headline} — ${whereOf(f)}`) : ['NONE']),
    '```', '',
    '## Verdict',
    ev.partial
      ? `**No full eval yet** — ${Object.keys(ev.criteria || {}).length} criteria checked individually. Run the eval for a verdict.`
      : `**Proposed bucket: ${ev.bucket}** — ${ev.verdict}`, '',
    '## Findings',
    ...(ev.findings.length || ev.partial ? ev.findings.flatMap((f) => [
      `### [${f.sev}] ${f.id} — ${f.headline}`,
      `- **Where:** ${whereLink(f)}`,
      `- **Evidence:** ${f.evidence}`,
      f.dim ? `- **Rule:** [${f.dim} ${dimName(f.dim)}](spec://${f.dim})` : null,
      f.fix?.summary ? `- **Fix:** ${f.fix.summary}` : null,
      '',
    ].filter((x) => x !== null)) : [`No findings — ${ev.verified.criteria} criteria verified against the artifacts.`, '']),
    ev.manual_checks.length ? '## Check by hand' : null,
    ...ev.manual_checks.map((m) => `- ${m}`),
  ].filter((x) => x !== null).join('\n') + '\n';
}

export function renderRemediationMd(ev) {
  const withFix = ev.findings.filter((f) => f.fix);
  return [
    `# Remediation — ${ev.task_id}`, '',
    '```alerts', ev.escalate ? `Escalate — ${ev.escalate}` : 'NONE', '```', '',
    '## Fix list',
    ...(withFix.length ? withFix.flatMap((f) => [
      `### Fix ${f.id} — ${f.fix.summary || f.headline} (owner: ${f.owner})`,
      `- **Go to:** ${whereLink(f)}${f.dim ? ` · [${f.dim}](spec://${f.dim})` : ''}`,
      ...f.fix.edits.map((e, j) => ['```fix', JSON.stringify({ id: fixBlockId(f, j), rule: f.dim || 'D16', class: f.sev === 'HARD' ? 'hard' : 'soft', status: 'PROPOSED', owner: f.owner, path: e.path, occurrence: 1, old: e.old, new: e.new }), '```'].join('\n')),
      f.fix.manual ? `\n**Apply by hand:**\n\n> ${f.fix.manual.replace(/\n/g, '\n> ')}` : null,
      '',
    ].filter((x) => x !== null)) : ['No fixes required — clean.', '']),
  ].join('\n') + '\n';
}

// Entry point used by docgen: review runs the eval; remediation re-renders
// from eval.json (running the eval only if there is none yet).
export async function generateRliDoc(dir, which, opts = {}) {
  let ev = which === 'review' ? null : readEval(dir);
  if (!ev) ev = await runRliEval(dir, opts);
  const review = renderReviewMd(ev), remediation = renderRemediationMd(ev);
  // Both docs always come from the same eval.json, so write the sibling too.
  fs.writeFileSync(path.join(dir, which === 'review' ? 'remediation.md' : 'review.md'), which === 'review' ? remediation : review);
  return which === 'review' ? review : remediation;
}

// "**Proposed bucket: HARD_FAIL**" → 'HARD_FAIL' (null when absent or malformed).
export function proposedBucket(reviewMd) {
  const m = String(reviewMd || '').match(/Proposed bucket:\s*\**\s*(HARD_FAIL|SOFT_FAIL|PASS)\b/);
  return m ? m[1] : null;
}
