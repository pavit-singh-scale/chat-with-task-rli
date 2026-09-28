// RLI ingest — one code path for the ingest CLI, the eval batch and the
// studio's upload. A record lands as workspace/<bucket>/<task_id>/ with its
// four artifact zips extracted under files/ and browser derivatives built.
//
// Re-delivery follows the ACC rule (a changed record REOPENS the task):
//   new        → download, derive, file under the auto-check bucket
//   unchanged  → left exactly as it is (eval, decisions and all)
//   changed    → new task.json/task.source.json; the stale eval + docs are
//                dropped; reviewer state carries over REOPENED (claim and chat
//                kept, verdict / checklist cleared — they point at old
//                findings); decided fixes are superseded, never replayed onto
//                the new text. Artifacts are re-downloaded only when the
//                deliverable fields changed; otherwise the files move across.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, BUCKETS } from './config.js';
import { readRliIn, checkRollup } from './rli.js';
import { deriveTask } from './rli_derive.js';
import { supersedeLedger } from './fixes.js';

const SIDE_SRC = { input: 'inputs', golden: 'golden_deliverables', ad1: 'ad1_artifacts', ad2: 'ad2_artifacts' };
const ARTIFACT_KEYS = Object.values(SIDE_SRC);
const EVAL_FILES = ['eval.json', 'eval.raw.txt', 'review.md', 'remediation.md', 'fixes.json'];
const stable = (v) => JSON.stringify(v, Object.keys(v || {}).sort());
const canon = (v) => JSON.stringify(sortDeep(v));
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

export function existingDir(id) {
  for (const b of BUCKETS) {
    const d = path.join(config.workspaceRoot, b, id);
    if (fs.existsSync(d)) return d;
  }
  return null;
}

// curl, not fetch: undici drops the larger artifact zips mid-stream.
function download(url, dest) {
  execFileSync('curl', ['-sfL', '--retry', '3', '--retry-delay', '2', '-o', dest, url], { stdio: 'pipe' });
  return fs.statSync(dest).size;
}
function unzip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-qo', zip, '-d', destDir], { stdio: 'pipe' });
  // Collapse a single wrapper folder (golden/golden/…, input/…) so paths match the brief.
  const entries = fs.readdirSync(destDir).filter((n) => n !== '__MACOSX' && n !== '.DS_Store');
  if (entries.length === 1 && fs.statSync(path.join(destDir, entries[0])).isDirectory()) {
    const inner = path.join(destDir, entries[0]);
    for (const n of fs.readdirSync(inner)) fs.renameSync(path.join(inner, n), path.join(destDir, n));
    fs.rmdirSync(inner);
  }
  fs.rmSync(path.join(destDir, '__MACOSX'), { recursive: true, force: true });
}

export function fetchArtifacts(stage, rec, log = () => {}) {
  const sources = {};
  for (const [side, key] of Object.entries(SIDE_SRC)) {
    for (const f of rec[key]?.files || []) {
      if (!f?.url) continue;
      sources[side] = [...(sources[side] || []), f];
      const tmp = path.join(stage, 'files', `_${side}_${path.basename(f.path || 'file')}`);
      try {
        fs.mkdirSync(path.join(stage, 'files'), { recursive: true });
        const bytes = download(f.url, tmp);
        if (/\.zip$/i.test(f.path || '') || fs.readFileSync(tmp).subarray(0, 2).toString() === 'PK') {
          unzip(tmp, path.join(stage, 'files', side));
          fs.rmSync(tmp);
        } else {
          fs.mkdirSync(path.join(stage, 'files', side), { recursive: true });
          fs.renameSync(tmp, path.join(stage, 'files', side, path.basename(f.path)));
        }
        log(`  ${side}: ${(bytes / 1e6).toFixed(1)} MB`);
      } catch (e) {
        log(`  ! ${side}: ${e.message.split('\n')[0]}`);
      }
    }
  }
  fs.writeFileSync(path.join(stage, 'files', '_sources.json'), JSON.stringify(sources, null, 2));
}

// Carry reviewer state across a reopen: claim + chat stay, decisions go.
function reopenState(prevDir, stage) {
  const st = readJson(path.join(prevDir, '_studio.json'));
  if (st) {
    const had = { verdict: st.verdict || null, checklist: st.checklist ? Object.keys(st.checklist).length : 0 };
    delete st.verdict; delete st.verdict_note; delete st.checklist;
    st.reopened_at = new Date().toISOString();
    st.reopened_reason = 'record changed in a re-delivery';
    if (had.verdict || had.checklist) st.reopened_had = had;
    fs.writeFileSync(path.join(stage, '_studio.json'), JSON.stringify(st, null, 2));
  }
  for (const f of ['_chat.json']) {
    if (fs.existsSync(path.join(prevDir, f))) fs.copyFileSync(path.join(prevDir, f), path.join(stage, f));
  }
  const ledger = readJson(path.join(prevDir, 'fix_ledger.json'));
  if (Array.isArray(ledger) && ledger.length) fs.writeFileSync(path.join(stage, 'fix_ledger.json'), JSON.stringify(supersedeLedger(ledger), null, 2));
}

// One record. `extras` = files to place beside task.json (an upload package's
// eval.json / review.md / remediation.md) — they are the eval OF this record.
export function ingestRecord(rec, { noFiles = false, extras = null, log = () => {} } = {}) {
  const id = rec?.task_id;
  if (!/^[a-f0-9]{24}$/.test(id || '')) return { id, action: 'error', error: 'bad task_id' };
  const prev = existingDir(id);
  const prevRec = prev ? (readJson(path.join(prev, 'task.source.json')) || readJson(path.join(prev, 'task.json'))) : null;
  const unchanged = prevRec && canon(prevRec) === canon(rec);

  if (unchanged) {
    // Same record: nothing to redo. An upload's eval files still land (latest wins).
    if (extras) for (const [name, src] of Object.entries(extras)) fs.copyFileSync(src, path.join(prev, name));
    return { id, action: 'unchanged', bucket: path.basename(path.dirname(prev)), dir: prev };
  }

  const stage = path.join(config.workspaceRoot, `.ingest-${id}-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'files'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'task.json'), JSON.stringify(rec, null, 2));
  fs.writeFileSync(path.join(stage, 'task.source.json'), JSON.stringify(rec, null, 2)); // pristine copy for fix undo

  let reused = false;
  const sameArtifacts = prevRec && ARTIFACT_KEYS.every((k) => canon(prevRec[k] ?? null) === canon(rec[k] ?? null));
  if (prev && sameArtifacts && fs.existsSync(path.join(prev, 'files'))) {
    fs.rmSync(path.join(stage, 'files'), { recursive: true, force: true });
    fs.renameSync(path.join(prev, 'files'), path.join(stage, 'files'));
    reused = true;
  } else if (!noFiles) {
    fetchArtifacts(stage, rec, log);
  }
  if (prev) reopenState(prev, stage);
  if (extras) for (const [name, src] of Object.entries(extras)) fs.copyFileSync(src, path.join(stage, name));
  if (!noFiles && !reused) deriveTask(stage, { log: (m) => log(`  ${m}`) });

  const t = readRliIn(stage);
  const roll = checkRollup(t.checks);
  const bucket = roll.fail ? 'HARD_FAIL' : 'UNSORTED';
  if (prev) fs.rmSync(prev, { recursive: true, force: true });
  const dest = path.join(config.workspaceRoot, bucket, id);
  fs.renameSync(stage, dest);
  return { id, action: prev ? 'reopened' : 'added', bucket, dir: dest, reusedFiles: reused, domain: t.domain, failing: roll.failing };
}

export function ingestRecords(records, opts = {}) {
  for (const b of BUCKETS) fs.mkdirSync(path.join(config.workspaceRoot, b), { recursive: true });
  const out = [];
  for (const rec of records) {
    try { out.push(ingestRecord(rec, opts)); }
    catch (e) { out.push({ id: rec?.task_id, action: 'error', error: e.message }); }
    const r = out[out.length - 1];
    opts.log?.(`${({ added: '+', reopened: '↻', unchanged: '=', error: '✕' })[r.action] || '?'} ${r.id} ${r.action}${r.bucket ? ` → ${r.bucket}` : ''}${r.reusedFiles ? ' (files reused)' : ''}${r.error ? ` — ${r.error}` : ''}`);
  }
  return out;
}

export { EVAL_FILES, stable };
