#!/usr/bin/env node
// RLI eval, batch — the same engine as the studio's "Run eval" button and the
// Rubric tab's "Check with AI", driven from the command line (and the
// /rli-eval skill). Results land in the workspace, so the studio shows them
// immediately; a report + claim-sheet CSV land in --out.
//
//   node tools/rli/eval.mjs [--preview <delivery.json>] [--tasks <id,id…>] [--bucket <B>] [--all]
//                           [--rerun] [--force] [--no-checks] [--concurrency 3] [--out <dir>]
//
//   --preview      ingest this delivery_sender_preview JSON first, then eval its tasks
//   --tasks        task ids (comma/space separated). Default with no selector: every task
//                  on the board that has no full eval yet
//   --bucket/--all select by board bucket / everything
//   --rerun        re-run the full eval even where a full eval.json exists
//   --force        also touch tasks a reviewer has already worked (verdict, checklist,
//                  decided fixes) — their finding ids would change, so off by default
//   --no-checks    skip "Check with AI" on the criteria the full eval didn't cover
//
// Human-assisted by construction: it writes findings and PROPOSED fixes only.
// Nothing here approves a fix, edits task.json or records a decision.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, BUCKETS } from '../../src/config.js';
import { readRliIn, readRecord, isRliTask } from '../../src/rli.js';
import { deriveTask } from '../../src/rli_derive.js';
import { generateRliDoc, ensureCoverage, uncoveredCriteria, readEval, proposedBucket, CLAIM_COLUMNS, columnForDim } from '../../src/rli_docgen.js';
import { moveTask } from '../../src/workspace.js';
import { ingestRecords } from '../../src/rli_ingest.js';
import { buildPackage } from './package.mjs';
import { recordUsage } from '../../src/usage.js';

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const RERUN = flag('--rerun'), FORCE = flag('--force'), CHECKS = !flag('--no-checks');
const CONC = Math.max(1, Number(opt('--concurrency', 3)));
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, (c) => (c === 'T' ? '_' : ''));
const OUT = path.resolve(opt('--out', path.join(process.env.HOME, 'rli', 'evals', stamp)));
const USER = process.env.RLI_EVAL_USER || 'rli-eval';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- select
function findDir(id) {
  for (const b of BUCKETS) { const d = path.join(config.workspaceRoot, b, id); if (fs.existsSync(d)) return { bucket: b, id, dir: d }; }
  return null;
}
function allTasks(bucket = null) {
  const out = [];
  for (const b of BUCKETS) {
    if (bucket && b !== bucket) continue;
    const bd = path.join(config.workspaceRoot, b);
    if (!fs.existsSync(bd)) continue;
    for (const id of fs.readdirSync(bd)) {
      const dir = path.join(bd, id);
      if (!/^[0-9a-f]{24}$/.test(id) || !isRliTask(dir)) continue;
      try { if (JSON.parse(fs.readFileSync(path.join(dir, '_studio.json'), 'utf8')).tour) continue; } catch { /* no state */ }
      out.push({ bucket: b, id, dir });
    }
  }
  return out;
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// A reviewer has worked this task: re-running would renumber the findings their
// checklist and decisions point at.
function reviewerWork(dir) {
  const st = readJson(path.join(dir, '_studio.json')) || {};
  const ledger = readJson(path.join(dir, 'fix_ledger.json')) || [];
  const why = [];
  if (st.verdict) why.push(`decision ${st.verdict}`);
  if (st.checklist && Object.keys(st.checklist).length) why.push(`${Object.keys(st.checklist).length} checklist marks`);
  // Superseded entries (a reopened task's old decisions) no longer bind anything.
  const decided = (Array.isArray(ledger) ? ledger : []).filter((e) => e.decided_by && e.decided_by !== 'acc-eval' && !e.superseded_at).length;
  if (decided) why.push(`${decided} decided fixes`);
  return why;
}

let targets = [];
const preview = opt('--preview');
let ingestLog = [];
if (preview) {
  log(`ingesting ${preview}`);
  ingestLog = ingestRecords(JSON.parse(fs.readFileSync(preview, 'utf8')), { log: (m) => log(m) });
  // Every task in the delivery is in scope; unchanged ones with a full eval are kept as they are.
  targets = ingestLog.filter((r) => r.action !== 'error').map((r) => findDir(r.id)).filter(Boolean);
}
const idArg = opt('--tasks');
if (idArg) targets.push(...idArg.split(/[\s,]+/).filter(Boolean).map((id) => findDir(id) || (log(`✕ ${id}: not on the board`), null)).filter(Boolean));
if (flag('--all') || opt('--bucket')) targets.push(...allTasks(opt('--bucket')));
const explicit = targets.length > 0;
if (!explicit) targets = allTasks().filter((t) => { const ev = readEval(t.dir); return !ev || ev.partial; });
targets = [...new Map(targets.map((t) => [t.id, t])).values()];
if (!targets.length) { log('nothing to evaluate'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
log(`${targets.length} task(s) · checks ${CHECKS ? 'on' : 'off'} · concurrency ${CONC} · report → ${OUT}`);

// ---------------------------------------------------------------- run one
const usageAcc = () => { const acc = { prompt_tokens: 0, completion_tokens: 0 }; return { acc, onUsage: (u) => { acc.prompt_tokens += u.prompt_tokens || 0; acc.completion_tokens += u.completion_tokens || 0; } }; };

async function runOne(t) {
  const res = { id: t.id, bucketBefore: t.bucket, bucket: t.bucket, dir: t.dir, status: 'done', notes: [], checked: 0, checkErrors: [] };
  const work = reviewerWork(t.dir);
  const existing = readEval(t.dir);
  const needFull = !existing || existing.partial || RERUN;
  if (work.length && needFull && !FORCE) {
    res.status = 'skipped';
    res.notes.push(`reviewer work on it (${work.join(', ')}) — rerun with --force to replace its eval`);
    return res;
  }
  try { deriveTask(t.dir); } catch (e) { res.notes.push(`derivatives: ${e.message}`); }

  if (needFull) {
    log(`▶ ${t.id} full eval`);
    const u = usageAcc();
    await generateRliDoc(t.dir, 'review', { id: t.id, onUsage: u.onUsage });
    recordUsage({ user: USER, taskId: t.id, kind: 'docgen:review', model: config.litellm.model, usage: u.acc, text: 'Generated review.md (batch)' });
    // File the task under the eval's call, as the studio job does — unless a reviewer decided it.
    const target = proposedBucket(fs.readFileSync(path.join(t.dir, 'review.md'), 'utf8'));
    const decided = !!(readJson(path.join(t.dir, '_studio.json')) || {}).verdict;
    if (target && target !== t.bucket && !decided) {
      moveTask(t.bucket, t.id, target);
      res.bucket = target; res.dir = path.join(config.workspaceRoot, target, t.id);
    }
  } else {
    res.notes.push('full eval already present — kept');
  }

  if (CHECKS) {
    const todo = uncoveredCriteria(res.dir);
    if (todo.length) log(`  ${t.id} checking ${todo.length} uncovered criteria`);
    const u = usageAcc();
    const cov = await ensureCoverage(res.dir, { onUsage: u.onUsage });
    recordUsage({ user: USER, taskId: t.id, kind: 'eval:criterion', model: config.litellm.model, usage: u.acc, text: `Coverage checks (batch)` });
    res.checked = todo.length - cov.missing.length;
    // No missed rubric: a task with unmarked criteria is INCOMPLETE, not done.
    if (cov.missing.length) {
      res.status = 'incomplete';
      res.missing = cov.missing;
      res.checkErrors = Object.entries(cov.errors).map(([n, e]) => `C${n}: ${e}`);
    }
  }
  // Gaps surface even when checks were skipped — a partly marked rubric is never "done".
  if (!CHECKS) {
    const gaps = uncoveredCriteria(res.dir);
    if (gaps.length) { res.status = 'incomplete'; res.missing = gaps; res.notes.push('checks were skipped (--no-checks)'); }
  }
  log(`${res.status === 'incomplete' ? '⚠' : '✓'} ${t.id} → ${res.bucket}${res.status === 'incomplete' ? ` · INCOMPLETE (${res.missing.length} unmarked)` : ''}`);
  return res;
}

// ---------------------------------------------------------------- pool
const results = [];
let next = 0;
await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, async () => {
  while (next < targets.length) {
    const t = targets[next++];
    try { results.push(await runOne(t)); }
    catch (e) { log(`✕ ${t.id}: ${e.message}`); results.push({ id: t.id, bucket: t.bucket, dir: t.dir, status: 'error', notes: [String(e.message).slice(0, 300)] }); }
  }
}));

// ---------------------------------------------------------------- report
const GATE = { golden: 97, ad1: 70, ad2: 50 };
const r1 = (x) => (x == null ? '—' : `${Math.round(x * 10) / 10}`);
function scoresAfter(rec, ev) {
  const crits = JSON.parse(JSON.stringify(rec.rubric_eval?.criteria || []));
  for (const f of ev?.findings || []) for (const e of f.fix?.edits || []) {
    const m = e.path.match(/^\/rubric_eval\/criteria\/(\d+)\/(?:(golden|ad1|ad2)\/passed|weight)$/);
    if (!m || !crits[m[1]]) continue;
    if (m[2]) crits[m[1]][m[2]] = { ...(crits[m[1]][m[2]] || {}), passed: String(e.new) === 'true' };
    else crits[m[1]].weight = Number(e.new);
  }
  const total = crits.reduce((a, c) => a + (c.weight > 0 ? c.weight : 0), 0);
  const sc = (s) => (total ? (crits.reduce((a, c) => a + (c[s]?.passed === true ? c.weight : 0), 0) / total) * 100 : null);
  return { golden: sc('golden'), ad1: sc('ad1'), ad2: sc('ad2') };
}
const SEV_RANK = { HARD: 0, SOFT: 1, INFO: 2 };
// Evals written before findings carried a claim-sheet column: infer it from the spec dimension.
const colOf = (f) => f.column || columnForDim(f.dim);
const worst = (fs_) => fs_.reduce((w, f) => (w == null || SEV_RANK[f.sev] < SEV_RANK[w] ? f.sev : w), null);
const scoreWord = (sev) => (sev === 'HARD' ? 'Fail' : sev === 'SOFT' ? 'Non-fail' : 'Pass');

function claimRow(t, ev, after) {
  const chk = Object.fromEntries(t.checks.map((c) => [c.id, c]));
  const byCol = (col) => (ev?.findings || []).filter((f) => colOf(f) === col && f.sev !== 'INFO');
  const cell = (score, note) => ({ score, note: String(note || '').replace(/\s+/g, ' ').trim() });
  const fromFindings = (col, base = null) => {
    const fs_ = byCol(col);
    const w = worst(fs_);
    const score = base === 'Fail' || w === 'HARD' ? 'Fail' : base === 'Non-fail' || w === 'SOFT' ? 'Non-fail' : 'Pass';
    return { score, notes: fs_.map((f) => `${f.crit ? `C${f.crit}: ` : ''}${f.headline}`) };
  };
  const mixQ = chk.weights?.mix?.quality;
  const flips = { golden: 0, ad1: 0, ad2: 0 };
  for (const f of ev?.findings || []) for (const e of f.fix?.edits || []) { const m = e.path.match(/\/(golden|ad1|ad2)\/passed$/); if (m) flips[m[1]]++; }
  const totalFlips = flips.golden + flips.ad1 + flips.ad2;
  const g = (k, s) => cell(s.score, s.notes.join('; '));
  const pr = (s) => t.scores?.[s]?.percentage ?? null;
  const row = {
    brief: g('brief', fromFindings('brief', chk.complete?.status === 'fail' ? 'Fail' : null)),
    files: g('files', (() => { const s = fromFindings('files', chk.paths?.status === 'fail' ? 'Fail' : chk.paths?.status === 'warn' ? 'Non-fail' : null); if (chk.paths && chk.paths.status !== 'pass') s.notes.unshift(chk.paths.summary); return s; })()),
    weights: cell(mixQ == null ? '—' : mixQ < 55 ? 'Fail' : mixQ < 65 ? 'Non-fail' : 'Pass', mixQ == null ? '' : `quality ${mixQ}% of positive weight (spec ≥65, sheet tolerates ≥55)`),
    quality: g('quality', fromFindings('quality')),
    stump_ad1: cell(after.ad1 == null ? '—' : after.ad1 > GATE.ad1 ? 'Fail' : 'Pass', `printed ${r1(pr('ad1'))}%${Math.abs((after.ad1 ?? 0) - (pr('ad1') ?? 0)) >= 0.05 ? ` → ${r1(after.ad1)}% after proposed fixes` : ''}`),
    stump_ad2: cell(after.ad2 == null ? '—' : after.ad2 > GATE.ad2 ? 'Fail' : 'Pass', `printed ${r1(pr('ad2'))}%${Math.abs((after.ad2 ?? 0) - (pr('ad2') ?? 0)) >= 0.05 ? ` → ${r1(after.ad2)}% after proposed fixes` : ''}`),
    golden: cell(pr('golden') == null ? '—' : pr('golden') >= GATE.golden ? 'Pass' : 'Fail', `printed ${r1(pr('golden'))}% (printed RD is the source of truth)`),
    count: cell(chk.count?.status === 'fail' ? 'Fail' : chk.count?.status === 'warn' ? 'Non-fail' : 'Pass', chk.count?.summary),
    rankings: g('rankings', (() => { const s = fromFindings('rankings', chk.alignment?.status === 'fail' ? 'Fail' : chk.alignment?.status === 'warn' ? 'Non-fail' : null); if (chk.alignment?.detail) s.notes.unshift(chk.alignment.detail); return s; })()),
    overfitting: g('overfitting', fromFindings('overfitting')),
    atomicity: g('atomicity', fromFindings('atomicity')),
    provenance: g('provenance', (() => { const s = fromFindings('provenance', chk.provenance?.status === 'fail' ? 'Fail' : null); if (chk.provenance && chk.provenance.status !== 'na') s.notes.unshift(chk.provenance.summary); return s; })()),
    // Spec D17: Fail = 2+ wrong verdicts on one response or 5+ on the task; Non-fail = 1–4.
    grading: (() => { const s = fromFindings('grading'); const perResp = Math.max(flips.golden, flips.ad1, flips.ad2); const sc = perResp >= 2 || totalFlips >= 5 ? 'Fail' : totalFlips >= 1 ? (s.score === 'Fail' ? 'Fail' : 'Non-fail') : s.score; return cell(sc, [`${totalFlips} verdict(s) the eval would flip (RD ${flips.golden} · AD1 ${flips.ad1} · AD2 ${flips.ad2})`, ...s.notes].join('; ')); })(),
  };
  return row;
}

const rows = [];
for (const r of results) {
  if (r.status === 'skipped' || r.status === 'error') { rows.push({ r }); continue; }
  // incomplete tasks still get their report block — with the gap called out
  const t = readRliIn(r.dir);
  const ev = readEval(r.dir);
  const rec = readRecord(r.dir);
  const after = scoresAfter(rec, ev);
  const claim = claimRow(t, ev, after);
  rows.push({ r, t, ev, after, claim });
}
const rank = (x) => (x.r.status === 'incomplete' ? -1 : x.r.status !== 'done' ? 9 : { HARD_FAIL: 0, SOFT_FAIL: 1, PASS: 2 }[x.ev?.bucket] ?? 3);
rows.sort((a, b) => rank(a) - rank(b));

const BUCKET_WORD = { HARD_FAIL: 'Fail', SOFT_FAIL: 'Non-fail', PASS: 'No issues' };
const md = [`# RLI eval — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, '',
  ...(results.some((x) => x.status === 'incomplete') ? [`**${results.filter((x) => x.status === 'incomplete').length} task(s) INCOMPLETE — some criteria still unmarked; see below.**`, ''] : []),
  `${results.length} task(s): ${rows.filter((x) => x.ev?.bucket === 'HARD_FAIL').length} Fail · ${rows.filter((x) => x.ev?.bucket === 'SOFT_FAIL').length} Non-fail · ${rows.filter((x) => x.ev?.bucket === 'PASS').length} No issues · ${results.filter((x) => x.status === 'skipped').length} skipped · ${results.filter((x) => x.status === 'error').length} errored`,
  '', 'Findings and fixes are PROPOSED — nothing was applied. Open each task in the studio to adjudicate.', ''];
for (const x of rows) {
  const { r } = x;
  if (r.status !== 'done' && r.status !== 'incomplete') { md.push(`## ${r.status.toUpperCase()} — ${r.id}`, '', ...r.notes.map((n) => `- ${n}`), ''); continue; }
  if (r.status === 'incomplete') md.push(`> **INCOMPLETE — ${r.missing.length} criteria still unmarked (${r.missing.map((n) => `C${n}`).join(', ')}).** Re-run: \`node tools/rli/eval.mjs --tasks ${r.id}\``, '');
  const { t, ev, after, claim } = x;
  const crits = Object.keys(ev?.criteria || {}).length;
  const flagged = Object.values(ev?.criteria || {}).filter((c) => !c.ok).length;
  const pr = (s) => t.scores?.[s]?.percentage;
  const sc = (s, lab) => `${lab} ${r1(pr(s))}${Math.abs((after[s] ?? 0) - (pr(s) ?? 0)) >= 0.05 ? ` → ${r1(after[s])}` : ''}`;
  md.push(`## ${BUCKET_WORD[ev?.bucket] || 'No verdict'} — ${r.id}`, '',
    `${t.domain || '—'} · ${t.timeline || 'no timeline'} · ${t.criteria.length} criteria · eval covered ${crits}/${t.criteria.length} (${flagged} flagged)${r.bucket !== r.bucketBefore ? ` · filed ${r.bucketBefore} → ${r.bucket}` : ''}`,
    `Scores (printed → after proposed fixes): ${sc('golden', 'RD')} (≥97) · ${sc('ad1', 'AD1')} (≤70) · ${sc('ad2', 'AD2')} (≤50) · quality ${t.checks.find((c) => c.id === 'weights')?.mix?.quality ?? '—'}% (≥65)`,
    `Studio: http://localhost:4200/task/${r.bucket}/${r.id}?tab=rubric`, '');
  if (ev?.verdict) md.push(`**${ev.verdict}**`, '');
  const failingCols = Object.entries(claim).filter(([, c]) => c.score === 'Fail' || c.score === 'Non-fail');
  if (failingCols.length) {
    md.push('| Claim-sheet column | Score | Note |', '|---|---|---|');
    for (const [k, c] of failingCols) md.push(`| ${CLAIM_COLUMNS[k]} | ${c.score} | ${c.note.replace(/\|/g, '/').slice(0, 220)} |`);
    md.push('');
  }
  for (const f of (ev?.findings || []).slice().sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev])) {
    md.push(`- **${f.sev}** ${f.dim || ''} · ${CLAIM_COLUMNS[colOf(f)] || ''} · ${f.crit ? `C${f.crit}${f.side ? `·${({ golden: 'RD', ad1: 'AD1', ad2: 'AD2' })[f.side]}` : ''}` : 'task'} — ${f.headline}${f.fix?.summary ? `\n  - Proposed fix: ${f.fix.summary}${f.fix.edits?.length ? ` (${f.fix.edits.length} edit${f.fix.edits.length > 1 ? 's' : ''})` : ''}${f.fix.manual ? ' (by hand)' : ''}` : ''}`);
  }
  if (ev?.manual_checks?.length) md.push('', '_Check by hand:_ ' + ev.manual_checks.join(' · '));
  if (ev?.escalate) md.push('', `**Escalate:** ${ev.escalate}`);
  if (r.checkErrors?.length) md.push('', `_Checks that failed to run:_ ${r.checkErrors.join('; ')}`);
  if (r.notes.length) md.push('', `_Notes:_ ${r.notes.join('; ')}`);
  md.push('');
}
fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));

const cols = Object.keys(CLAIM_COLUMNS);
const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = [['Task', 'Domain', 'Timeline', 'Eval', ...cols.flatMap((k) => [`${CLAIM_COLUMNS[k]} · Score`, `${CLAIM_COLUMNS[k]} · Note`])].map(csvEsc).join(',')];
for (const x of rows) {
  if (x.r.status !== 'done' && x.r.status !== 'incomplete') { csv.push([x.r.id, '', '', x.r.status].map(csvEsc).join(',')); continue; }
  csv.push([x.r.id, x.t.domain, x.t.timeline, BUCKET_WORD[x.ev?.bucket] || '—', ...cols.flatMap((k) => [x.claim[k].score, x.claim[k].note])].map(csvEsc).join(','));
}
fs.writeFileSync(path.join(OUT, 'claim_sheet.csv'), csv.join('\n'));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(rows.map((x) => ({
  task_id: x.r.id, status: x.r.status, bucket: x.ev?.bucket ?? null, notes: x.r.notes, checked: x.r.checked,
  scores_printed: x.t ? { rd: x.t.scores?.golden?.percentage, ad1: x.t.scores?.ad1?.percentage, ad2: x.t.scores?.ad2?.percentage } : null,
  scores_after_fixes: x.after || null, claim_sheet: x.claim || null, findings: x.ev?.findings?.length ?? null,
})), null, 1));
log(`report: ${path.join(OUT, 'report.md')}`);
log(`claim sheet: ${path.join(OUT, 'claim_sheet.csv')}`);

// The upload package (ACC-style): every fully evaluated task of this run, zipped
// with final_verdicts + the report. --no-package to skip.
if (!flag('--no-package')) {
  const done = results.filter((x) => x.status === 'done').map((x) => x.id);
  if (done.length) {
    const label = opt('--name') || `RLI_UPLOAD_${preview ? path.basename(preview).replace(/^delivery_sender_preview_[0-9a-f]+_/, '').replace(/\.json$/, '').slice(0, 60) : stamp}`;
    const pk = buildPackage({ ids: done, reportDir: OUT, name: label, outDir: OUT, log });
    fs.copyFileSync(pk.zip, path.join(process.env.HOME, 'Downloads', path.basename(pk.zip)));
    log(`upload package: ~/Downloads/${path.basename(pk.zip)}`);
  }
}

// Exit non-zero when any task has unmarked criteria, so a caller can't miss it.
if (results.some((x) => x.status === 'incomplete' || x.status === 'error')) process.exitCode = 2;
