#!/usr/bin/env node
// Build an RLI Operations Hub upload package — the RLI counterpart of the ACC
// "Audit Studio Upload" zip. Upload it on the board (Actions → Upload) and every
// task lands with its eval, review, remediation (fix blocks → Approve/Edit/Deny)
// and bucket; artifacts come from the records' own links.
//
//   node tools/rli/package.mjs --tasks <id,id…> [--report <eval out dir>] [--name <label>] [--out <dir>]
//
// Zip layout:
//   <task_id>/task.json            the record as delivered (pristine source copy)
//   <task_id>/eval.json            structured eval (findings, per-criterion coverage)
//   <task_id>/review.md            rendered from eval.json
//   <task_id>/remediation.md       rendered from eval.json, ```fix blocks included
//   _audit/final_verdicts.json     [{ task_id, verdict: HARD_FAIL|SOFT_FAIL|PASS, … }]
//   _audit/report.md, claim_sheet.csv, summary.json   (when --report is given)
//
// No missed rubric: a task whose eval leaves any criterion unmarked is refused
// (listed, not packaged) unless --allow-incomplete.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { config, BUCKETS } from '../../src/config.js';
import { readEval, uncoveredCriteria } from '../../src/rli_docgen.js';
import { parseFixBlocks } from '../../src/fixes.js';

export function buildPackage({ ids, reportDir = null, name = null, outDir = path.join(os.homedir(), 'Downloads'), allowIncomplete = false, log = console.log }) {
  const findDir = (id) => BUCKETS.map((b) => path.join(config.workspaceRoot, b, id)).find((d) => fs.existsSync(d));
  const label = name || `RLI_UPLOAD_${new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_')}`;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'rli-pkg-'));
  const root = path.join(stage, label);
  fs.mkdirSync(path.join(root, '_audit'), { recursive: true });
  const verdicts = [], refused = [], missing = [];
  for (const id of ids) {
    const dir = findDir(id);
    if (!dir) { missing.push(id); continue; }
    const ev = readEval(dir);
    const gaps = ev ? uncoveredCriteria(dir) : null;
    if (!ev || ev.partial) { refused.push({ id, why: 'no full eval' }); continue; }
    if (gaps.length && !allowIncomplete) { refused.push({ id, why: `${gaps.length} criteria unmarked (${gaps.map((n) => `C${n}`).join(', ')})` }); continue; }
    const dst = path.join(root, id);
    fs.mkdirSync(dst);
    // The PRISTINE record: fixes are proposals, never baked into the package.
    const src = fs.existsSync(path.join(dir, 'task.source.json')) ? 'task.source.json' : 'task.json';
    fs.copyFileSync(path.join(dir, src), path.join(dst, 'task.json'));
    for (const f of ['eval.json', 'review.md', 'remediation.md']) fs.copyFileSync(path.join(dir, f), path.join(dst, f));
    const fx = parseFixBlocks(fs.readFileSync(path.join(dst, 'remediation.md'), 'utf8'));
    if (fx.errors.length) throw new Error(`${id}: ${fx.errors.length} unparseable fix block(s) in remediation.md`);
    verdicts.push({ task_id: id, verdict: ev.bucket || 'UNSORTED', findings: ev.findings.length, fixes: fx.blocks.length, criteria_checked: Object.keys(ev.criteria || {}).length });
  }
  fs.writeFileSync(path.join(root, '_audit', 'final_verdicts.json'), JSON.stringify(verdicts, null, 2));
  if (reportDir) for (const f of ['report.md', 'claim_sheet.csv', 'summary.json']) {
    if (fs.existsSync(path.join(reportDir, f))) fs.copyFileSync(path.join(reportDir, f), path.join(root, '_audit', f));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const zip = path.join(outDir, `${label}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync('zip', ['-qr', zip, label], { cwd: stage });
  // Verify from inside the zip, not the staging folder.
  const listing = execFileSync('unzip', ['-Z1', zip]).toString().split('\n').filter(Boolean);
  for (const v of verdicts) for (const f of ['task.json', 'eval.json', 'review.md', 'remediation.md']) {
    if (!listing.includes(`${label}/${v.task_id}/${f}`)) throw new Error(`zip is missing ${v.task_id}/${f}`);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  const counts = verdicts.reduce((a, v) => ((a[v.verdict] = (a[v.verdict] || 0) + 1), a), {});
  log(`package: ${zip} · ${verdicts.length} task(s) (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' · ')})`);
  if (refused.length) log(`refused ${refused.length}: ${refused.map((r) => `${r.id} (${r.why})`).join('; ')}`);
  if (missing.length) log(`not on the board: ${missing.join(', ')}`);
  return { zip, packaged: verdicts, refused, missing };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  let ids = (opt('--tasks') || '').split(/[\s,]+/).filter(Boolean);
  const reportDir = opt('--report');
  if (!ids.length && reportDir) ids = JSON.parse(fs.readFileSync(path.join(reportDir, 'summary.json'), 'utf8')).map((r) => r.task_id);
  if (!ids.length) { console.error('usage: node tools/rli/package.mjs --tasks <ids> | --report <eval out dir>'); process.exit(1); }
  const r = buildPackage({ ids, reportDir, name: opt('--name'), outDir: opt('--out') || undefined, allowIncomplete: argv.includes('--allow-incomplete') });
  if (r.refused.length) process.exitCode = 2;
}
