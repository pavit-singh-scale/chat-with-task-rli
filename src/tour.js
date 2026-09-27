import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, BUCKETS } from './config.js';
import { ensureWorkspace } from './workspace.js';

// A disposable, per-user sandbox task so reviewers can actually *do* things
// during the tour (claim, decide, drag between lanes, chat with the copilot)
// without touching real data. Tagged in _studio.json so the board hides it from
// everyone else and exports skip it; removed when the tour ends.

const TOUR_BUCKET = 'SOFT_FAIL'; // a middle severity; starts Open (no verdict/claim)

function writeJSON(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

// The RLI sandbox is a COPY of a real task — record, eval and docs — so the
// tour shows the real viewers (3D, renders, rubric, preference) and a real
// eval to adjudicate. Artifacts are HARD-linked, not copied (they run to GBs,
// and a symlink would be refused by resolveSafe as escaping the task dir);
// every write the tour can make (fix approvals, verdicts, chat) lands in the
// copy's own JSON files, and removing the sandbox only drops the links.
// Source: the first task with an eval.json (TOUR_SOURCE_TASK pins one).
function pickRliSource() {
  const pinned = process.env.TOUR_SOURCE_TASK;
  let fallback = null;
  for (const b of BUCKETS) {
    const bdir = path.join(config.workspaceRoot, b);
    let names = [];
    try { names = fs.readdirSync(bdir); } catch { continue; }
    for (const name of names.sort()) {
      const dir = path.join(bdir, name);
      if (!fs.existsSync(path.join(dir, 'task.json'))) continue;
      try { if (JSON.parse(fs.readFileSync(path.join(dir, '_studio.json'), 'utf8')).tour) continue; } catch { /* no state */ }
      if (pinned && name === pinned) return dir;
      if (!pinned && fs.existsSync(path.join(dir, 'eval.json'))) return dir;
      fallback ||= dir;
    }
  }
  return fallback;
}

function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name), b = path.join(to, name);
    const st = fs.lstatSync(a);
    if (st.isDirectory()) linkTree(a, b);
    else if (st.isFile()) fs.linkSync(a, b);
  }
}

export function createDummyTask(user) {
  ensureWorkspace();
  removeTourTasks(user); // clear any stale sandbox for this user first
  const src = pickRliSource();
  if (!src) throw new Error('no RLI task on the board to build a tour sandbox from');
  const id = crypto.randomBytes(12).toString('hex'); // 24 hex
  const dir = path.join(config.workspaceRoot, TOUR_BUCKET, id);
  fs.mkdirSync(dir, { recursive: true });
  // The pristine source.json, not task.json: a sandbox starts from the record
  // as delivered, not with someone's approved fixes already applied.
  const pristine = fs.existsSync(path.join(src, 'task.source.json')) ? 'task.source.json' : 'task.json';
  fs.copyFileSync(path.join(src, pristine), path.join(dir, 'task.json'));
  fs.copyFileSync(path.join(src, pristine), path.join(dir, 'task.source.json'));
  for (const f of ['eval.json', 'review.md', 'remediation.md']) {
    if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  }
  if (fs.existsSync(path.join(src, 'files'))) linkTree(path.join(src, 'files'), path.join(dir, 'files'));
  writeJSON(path.join(dir, '_studio.json'), { tour: true, tour_owner: user, tour_source: path.basename(src) });
  return { bucket: TOUR_BUCKET, id };
}

// Remove sandbox tasks. With a user, only theirs; without, every tour task
// (used to sweep leftovers).
export function removeTourTasks(user) {
  ensureWorkspace();
  let removed = 0;
  for (const b of BUCKETS) {
    const bdir = path.join(config.workspaceRoot, b);
    for (const name of fs.readdirSync(bdir)) {
      const studio = path.join(bdir, name, '_studio.json');
      try {
        const s = JSON.parse(fs.readFileSync(studio, 'utf8'));
        if (s.tour && (!user || s.tour_owner === user)) { fs.rmSync(path.join(bdir, name), { recursive: true, force: true }); removed++; }
      } catch { /* not a tour task */ }
    }
  }
  return removed;
}

export function logTour(entry) {
  try {
    fs.appendFileSync(path.join(config.dataDir, 'tour_log.jsonl'), JSON.stringify(entry) + '\n');
  } catch { /* logging is best-effort */ }
}
