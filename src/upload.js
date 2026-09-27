import Busboy from 'busboy';
import { seedLedgerFromGrammar, supersedeLedger, readLedger, loadFixBlocks, validateTask, writeJsonAtomic } from './fixes.js';
import { writeTextAtomic } from './state.js';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { assertBucket, ensureWorkspace, findTaskBucket, httpError } from './workspace.js';
import { writeAuditSeed, ensureRankingProof } from './ingest.js';

const execFileP = promisify(execFile);
const TASK_ID_RE = /^[a-f0-9]{24}$/;

// Browser folder upload (webkitdirectory) or a single .zip. Each file arrives
// with its relative path as the filename; we stage into a temp dir, locate
// rank.json, derive the task id, and move into the chosen bucket.
export function handleUpload(req, res, next) {
  ensureWorkspace();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cwt-upload-'));
  const fields = {};
  const writes = [];
  let fileCount = 0;

  // preservePath keeps the webkitRelativePath the browser puts in filename.
  const bb = Busboy({ headers: req.headers, preservePath: true, limits: { fileSize: 500 * 1024 * 1024, files: 4000 } });

  bb.on('field', (name, val) => (fields[name] = val));
  bb.on('file', (name, stream, info) => {
    const rel = sanitizeRel(info.filename);
    if (!rel) return stream.resume(); // skip junk/unsafe paths
    fileCount++;
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const out = fs.createWriteStream(dest);
    stream.pipe(out);
    writes.push(new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      stream.on('limit', () => reject(httpError(413, `${rel} exceeds the 500MB per-file limit`)));
    }));
  });

  bb.on('close', async () => {
    try {
      await Promise.all(writes);
      if (!fileCount) throw httpError(400, 'no files received');
      const result = await finalizeUpload(tmp, fields);
      res.json(result);
    } catch (e) {
      next(e);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  bb.on('error', (e) => {
    fs.rmSync(tmp, { recursive: true, force: true });
    next(e);
  });
  req.pipe(bb);
}

// Strip the browser's path decorations and refuse traversal. Returns '' to skip.
function sanitizeRel(filename) {
  const rel = String(filename || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..') || rel.endsWith('/')) return '';
  if (path.basename(rel) === '.DS_Store') return '';
  return rel;
}

async function finalizeUpload(tmp, fields) {
  // Single zip → extract in place, then treat like a folder upload.
  const rootEntries = fs.readdirSync(tmp);
  if (rootEntries.length === 1 && rootEntries[0].toLowerCase().endsWith('.zip')) {
    const zipPath = path.join(tmp, rootEntries[0]);
    try {
      await execFileP('unzip', ['-q', '-o', zipPath, '-d', tmp, '-x', '__MACOSX/*']);
    } catch (e) {
      throw httpError(400, `could not extract zip: ${e.message.slice(0, 200)}`);
    }
    fs.unlinkSync(zipPath);
  }

  // Delivery upload (multiple <task_id>/rank.json folders) → bulk-sort.
  // Single-task upload → land in the requested bucket.
  const taskRoots = findTaskRoots(tmp);
  if (!taskRoots.length) {
    throw httpError(400, 'no rank.json found in the upload — upload a <task_id> folder or a delivery zip of them');
  }
  if (taskRoots.length > 1 || TASK_ID_RE.test(path.basename(taskRoots[0]))) {
    return bulkIngest(taskRoots, fields);
  }

  // Single folder not named by task id — fall back to explicit/derived id.
  const taskRoot = taskRoots[0];
  const taskId = deriveTaskId(taskRoot, fields.taskId);
  if (!taskId) {
    throw httpError(400, 'could not derive a 24-char task id from the folder name — name the folder after the task id or fill the task id field');
  }
  return bulkIngest([taskRoot], fields, taskId);
}

// Sort every uploaded task into HARD_FAIL/SOFT_FAIL/PASS via the delivery's
// _audit/final_verdicts.json (fallback: the requested bucket). Uploads are
// additive (other tasks are untouched); a re-uploaded task_id OVERRIDES the
// previous copy (latest wins), preserving the reviewer's claim/verdict state.
function bulkIngest(taskRoots, fields, forcedId = null) {
  const fallbackBucket = assertBucket(fields.bucket || 'UNSORTED');
  const ingested = [];
  const replaced = [];
  const skippedBadId = [];

  for (const taskRoot of taskRoots) {
    const taskId = forcedId || (TASK_ID_RE.test(path.basename(taskRoot)) ? path.basename(taskRoot) : null);
    if (!taskId) {
      skippedBadId.push(path.basename(taskRoot));
      continue;
    }
    const deliveryDir = path.dirname(taskRoot);
    const verdicts = loadVerdicts(deliveryDir);
    const bucket = verdicts ? bucketFor(verdicts.get(taskId)) : fallbackBucket;

    // override any prior copy (in whatever bucket), carrying over reviewer state
    const priorBucket = findTaskBucket(taskId);
    let studio = null;
    let chat = null;
    let reopened = false;
    let priorLedger = null;
    if (priorBucket) {
      const priorDir = path.join(config.workspaceRoot, priorBucket, taskId);
      try { studio = fs.readFileSync(path.join(priorDir, '_studio.json'), 'utf8'); } catch { /* none */ }
      try { chat = fs.readFileSync(path.join(priorDir, '_chat.json'), 'utf8'); } catch { /* none */ }
      // The ledger survives re-upload the way _studio.json does — it is the
      // board's change history and the whole point of append-only.
      priorLedger = readLedger(priorDir);
    }
    // A re-audited task left at SBQ or "Fixes made" must not silently stay
    // resolved — reopen it (clear verdict + release claim) so it returns to the
    // OPEN lane for re-review. NO_ISSUES (genuine pass) and SECOND_OPINION
    // (already its own lane) are left untouched.
    if (studio) {
      const reset = reopenIfStale(studio);
      studio = reset.json;
      reopened = reset.reopened;
    }
    const dest = path.join(config.workspaceRoot, bucket, taskId);
    // Copy to a temp sibling first, swap only once the copy succeeded — a
    // failed copy (disk full, truncated zip) must not lose the prior copy.
    // Symlinks are pruned: unzip materializes them, and the file readers would
    // follow one to any host file.
    const tmpDest = path.join(config.workspaceRoot, bucket, `.tmp-${taskId}-${process.pid}`);
    fs.rmSync(tmpDest, { recursive: true, force: true });
    try {
      fs.cpSync(taskRoot, tmpDest, {
        recursive: true,
        filter: (src) => !fs.lstatSync(src).isSymbolicLink(),
      });
    } catch (e) {
      fs.rmSync(tmpDest, { recursive: true, force: true });
      throw e;
    }
    if (priorBucket) fs.rmSync(path.join(config.workspaceRoot, priorBucket, taskId), { recursive: true, force: true });
    fs.renameSync(tmpDest, dest);
    ensureRankingProof(dest); // re-fetch any proof image that didn't materialize (expired CDS URL) while it's still uploadable
    if (studio) writeTextAtomic(path.join(dest, '_studio.json'), studio); // keeps checklist/delivered; verdict+claim reset if reopened
    if (chat) writeTextAtomic(path.join(dest, '_chat.json'), chat); // copilot history survives re-upload the same way
    let seeded = false;
    if (fs.existsSync(path.join(deliveryDir, '_audit'))) {
      seeded = writeAuditSeed(deliveryDir, taskId, dest);
    }

    // ── staging handoff (spec §3-§4) ──
    // Prior board decisions carry over — but on a REOPEN (content changed
    // upstream) they are superseded, never replayed onto new text.
    if (priorLedger?.length) {
      const entries = reopened ? supersedeLedger(priorLedger) : priorLedger;
      writeJsonAtomic(path.join(dest, 'fix_ledger.json'), entries);
    }
    seedLedgerFromGrammar(dest);
    loadFixBlocks(dest); // parse remediation fences once, cache to fixes.json
    const auditRow = verdicts?.get(taskId) || null;
    const warnings = validateTask(dest, auditRow);
    writeAuditState(dest, auditRow, warnings);

    (priorBucket ? replaced : ingested).push({
      taskId, bucket, seeded, reopened,
      tags: auditRow?.tags || [],
      warnings: warnings.length,
    });
  }

  const all = [...ingested, ...replaced];
  const first = all[0];
  return {
    taskId: first?.taskId || null,
    bucket: first?.bucket || null,
    ingested,
    replaced,
    reopened: all.filter((t) => t.reopened).map((t) => t.taskId),
    counts: countBy(all, (t) => t.bucket),
    // The two silent killers from §4.6, made loud: dirs that landed UNSORTED
    // and tasks whose fix blocks or verdict rows failed validation.
    warnings: all.filter((t) => t.warnings).map((t) => ({ taskId: t.taskId, count: t.warnings })),
    grammarFixed: all.filter((t) => t.tags?.includes('grammar-fixed')).length,
    skipped_bad_id: skippedBadId,
    seeded: all.some((t) => t.seeded),
    files: all.length === 1 ? countFiles(path.join(config.workspaceRoot, first.bucket, first.taskId)) : undefined,
  };
}

// The audit's own metadata lives in _studio.json under a namespaced key, so a
// re-upload can overwrite the audit block without touching claims, checklists
// or verdicts (§4.2).
function writeAuditState(dest, auditRow, warnings) {
  const p = path.join(dest, '_studio.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fresh */ }
  state.audit = {
    ...(auditRow || {}),
    warnings,
    ingested_at: new Date().toISOString(),
  };
  writeTextAtomic(p, JSON.stringify(state, null, 2));
}

// Verdicts that mean "still needs work" — re-uploading such a task is a re-audit,
// so we drop the reviewer's verdict and claim to send it back to the OPEN lane.
const REOPEN_VERDICTS = new Set(['SBQ', 'FIXES_MADE']);

function reopenIfStale(studioJson) {
  let state;
  try { state = JSON.parse(studioJson); } catch { return { json: studioJson, reopened: false }; }
  if (!REOPEN_VERDICTS.has(state.verdict)) return { json: studioJson, reopened: false };
  delete state.verdict;
  delete state.verdict_by;
  delete state.verdict_at;
  delete state.claimed_by;
  delete state.claimed_at;
  state.reopened_at = new Date().toISOString();
  state.reopened_reason = 're-audit upload';
  return { json: JSON.stringify(state, null, 2), reopened: true };
}

// Full rows, not just the verdict string: since the staging handoff the row
// carries tags, grammar_only_fail, writing_band_as_delivered and the fix
// counts, and all of §2.1 depends on keeping them (older batches ship
// {task_id, verdict} rows and flow through the same shape).
function loadVerdicts(deliveryDir) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(deliveryDir, '_audit', 'final_verdicts.json'), 'utf8'));
    if (Array.isArray(rows)) return new Map(rows.map((r) => [r.task_id, r]));
  } catch { /* no verdicts shipped with this upload */ }
  return null;
}

function bucketFor(row) {
  const v = String(row?.verdict || '').toUpperCase();
  if (v.startsWith('HARD')) return 'HARD_FAIL';
  if (v.startsWith('SOFT')) return 'SOFT_FAIL';
  if (v.startsWith('PASS')) return 'PASS';
  return 'UNSORTED';
}

function countBy(items, fn) {
  const out = {};
  for (const it of items) out[fn(it)] = (out[fn(it)] || 0) + 1;
  return out;
}

// Every directory that contains a rank.json (depth-first, no descent past a hit).
function findTaskRoots(root) {
  const roots = [];
  const walk = (dir) => {
    if (fs.existsSync(path.join(dir, 'rank.json'))) {
      roots.push(dir);
      return;
    }
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory() && name !== '_audit') walk(p);
    }
  };
  walk(root);
  return roots;
}

function deriveTaskId(taskRoot, explicit) {
  if (explicit && TASK_ID_RE.test(explicit.trim())) return explicit.trim();
  if (TASK_ID_RE.test(path.basename(taskRoot))) return path.basename(taskRoot);
  // Walk up in case rank.json sat in a subdir of the <task_id> folder.
  let dir = taskRoot;
  for (let i = 0; i < 4; i++) {
    dir = path.dirname(dir);
    if (TASK_ID_RE.test(path.basename(dir))) return path.basename(dir);
  }
  return null;
}

function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}
