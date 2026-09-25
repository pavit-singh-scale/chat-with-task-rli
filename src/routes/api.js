import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  listWorkspace, taskMeta, listFiles, readTaskFile, readTrajectory,
  readTaskDef, readRank, moveTask, findTaskBucket, taskDir, resolveSafe, deleteTask, clearWorkspace,
  httpError,
} from '../workspace.js';
import { moveTaskToLane, selectTasks, laneOf, LANE_LABELS, SEV_LABELS, VERDICT_LABELS } from '../lanes.js';
import { recordAction, listActions, undoAction } from '../actions.js';
import { BUCKETS } from '../config.js';
import { ingestTask, findTaskSources } from '../ingest.js';
import { handleUpload } from '../upload.js';
import { verifyLogin, createSession, destroySession, requireAuth, requireAdmin } from '../auth.js';
import { claimTask, releaseTask, setVerdict, setVerdictNote, setChecklistItem, setGrammarLane, laneSnapshot, getState, VERDICTS } from '../state.js';
import { runAgentLoop } from '../llm.js';
import { TOOL_DEFS, makeExecutor } from '../tools.js';
import { generateDoc, taskContext, CITATION_RULES } from '../docgen.js';
import { QUALITY_CANON, getRubric, saveRubricCsv } from '../spec.js';
import { readRliIn, isRliTask } from '../rli.js';
import { readEval } from '../rli_docgen.js';
import { RLI_CHAT_PROMPT, RLI_CITATION_RULES, RLI_TOOL_DEFS, rliCanon, rliTaskContext, makeRliExecutor } from '../rli_acey.js';
import { recordUsage, readUsage, usageCsv } from '../usage.js';
import { enqueueDocs, jobSummary, statusFor } from '../jobs.js';
import { startPull, pullStatus, currentDownload } from '../l10.js';
import { markDelivered, markUndelivered, deliverStatus, currentBackup } from '../deliver.js';
import { computeL12 } from '../l12.js';
import { createDummyTask, removeTourTasks, logTour } from '../tour.js';
import { redashApi } from './redash.js';
import { overviewApi } from './overview.js';
import { teamApi } from './team.js';
import { aceyApi } from './acey.js';
import { stagingApi } from './staging.js';
import { fixesApi } from './fixes.js';
import { writeJsonAtomic } from '../fixes.js';
import { ACTION_TOOL_DEFS, makeActionExecutor, confirmPlan, cancelPlan } from '../copilot_actions.js';

export const api = express.Router();
api.use(express.json({ limit: '2mb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- auth (the only routes that don't require a session) ----
api.post('/login', wrap(async (req, res) => {
  const user = verifyLogin(String(req.body.username || ''), String(req.body.password || ''));
  if (!user) return res.status(401).json({ error: 'invalid username or password' });
  const sid = createSession(user);
  res.setHeader('set-cookie', `cwt_sid=${sid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`);
  res.json(user);
}));

api.post('/logout', requireAuth, wrap(async (req, res) => {
  destroySession(req.sid);
  res.setHeader('set-cookie', 'cwt_sid=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

api.use(requireAuth);

// NOTHING under /api may be served from a browser or proxy cache. The old
// board's "Export CSV stopped updating" was exactly this failure — a cached
// response reused without revalidation — and a stale JSON here mis-states task
// state, which is worse than a stale download. The avatar route overrides this
// with its own max-age below; it serves immutable-ish PNGs, not state.
api.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

api.get('/me', (req, res) => res.json(req.user));

// Profile photo for a user, or 404 so the client falls back to the initial disc.
//
// These are real people's photographs, so they live in DATA_DIR (gitignored, and
// excluded from the sandbox deploy tarball) rather than in public/. That keeps
// faces out of git history and off any shared host, and means they are only
// reachable with a session — this route sits below requireAuth. The cost is that
// a fresh clone or deploy shows initials until the files are copied in, which is
// the right default for personal data.
const AVATAR_NAME_RE = /^[a-z0-9_-]{1,32}$/i;
api.get('/avatar/:username', (req, res) => {
  const name = String(req.params.username || '').toLowerCase();
  if (!AVATAR_NAME_RE.test(name)) return res.status(400).end();
  const file = path.join(config.dataDir, 'avatars', `${name}.png`);
  // Belt and braces on top of the character allowlist: the resolved path must
  // still sit inside the avatars directory.
  const dir = path.join(config.dataDir, 'avatars');
  const resolved = path.resolve(file);
  if (!resolved.startsWith(dir + path.sep)) return res.status(400).end();
  if (!fs.existsSync(resolved)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=3600');
  res.type('png').send(fs.readFileSync(resolved));
});

// --- guided tour sandbox: a disposable dummy task the user can act on ---
api.post('/tour/start', wrap(async (req, res) => res.json(createDummyTask(req.user.username))));
api.post('/tour/end', wrap(async (req, res) => res.json({ removed: removeTourTasks(req.user.username) })));
api.post('/tour/log', wrap(async (req, res) => {
  logTour({ user: req.user.username, at: new Date().toISOString(), step: req.body?.step, action: req.body?.action, success: !!req.body?.success });
  res.json({ ok: true });
}));

// Live Redash: pipeline panels, per-task upstream context, query browser.
api.use('/redash', redashApi);
api.use('/overview', overviewApi);
api.use('/team', teamApi);
api.use('/acey', aceyApi);
api.use('/staging', stagingApi);
api.use('/task/:bucket/:id/fixes', fixesApi);

api.get('/spec/rubric', (req, res) => res.json({ dimensions: getRubric() }));

// admin: copilot/docgen activity, token usage, and cost
api.get('/admin/usage', requireAdmin, wrap(async (req, res) =>
  res.json(readUsage(Math.min(2000, Number(req.query.limit) || 500)))
));

api.get('/admin/usage.csv', requireAdmin, wrap(async (req, res) => {
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', 'attachment; filename="copilot_usage.csv"');
  res.send(usageCsv());
}));

// admin uploads the QC rubric CSV once (raw text body); everyone reads it
api.post('/spec/rubric', requireAdmin, express.text({ type: '*/*', limit: '8mb' }), wrap(async (req, res) => {
  const dims = saveRubricCsv(String(req.body || ''));
  res.json({ ok: true, dimensions: dims.length });
}));

api.get('/workspace', wrap(async (req, res) => res.json(listWorkspace())));

// Archive = the delivered (soft-archived) tasks, flattened and viewable by ALL users.
// Powers the browse/search Archive page. Sorted newest-archived first.
api.get('/archive', wrap(async (req, res) => {
  const ws = listWorkspace();
  const tasks = Object.values(ws).flat().filter((t) => t.delivered && !t.tour);
  tasks.sort((a, b) => String(b.deliveredAt || '').localeCompare(String(a.deliveredAt || '')));
  res.json({ tasks, count: tasks.length });
}));

api.get('/config', (req, res) =>
  res.json({ model: config.litellm.model, deliveryRoots: config.deliveryRoots, workspaceRoot: config.workspaceRoot })
);

// L12 analytics dashboard data. scope: completed (default) | active | all.
api.get('/l12', wrap(async (req, res) => {
  const scope = ['completed', 'active', 'all'].includes(req.query.scope) ? req.query.scope : 'completed';
  res.json(computeL12(scope));
}));

api.post('/ingest', requireAdmin, wrap(async (req, res) => {
  const { taskId, bucket } = req.body;
  res.json(ingestTask(String(taskId || '').trim(), bucket || 'UNSORTED'));
}));

api.get('/find/:taskId', wrap(async (req, res) => res.json({ sources: findTaskSources(req.params.taskId) })));

// multipart folder/zip upload — admin only, must NOT go through express.json
api.post('/upload', requireAdmin, handleUpload);

api.get('/task/:bucket/:id/taskdef', wrap(async (req, res) => res.json(readTaskDef(req.params.bucket, req.params.id))));

api.get('/task/:bucket/:id/rank', wrap(async (req, res) => res.json(readRank(req.params.bucket, req.params.id))));

// ---- claim / verdict / export ----
api.post('/task/:bucket/:id/claim', wrap(async (req, res) =>
  res.json(claimTask(req.params.bucket, req.params.id, req.user.username))
));

api.post('/task/:bucket/:id/release', wrap(async (req, res) =>
  res.json(releaseTask(req.params.bucket, req.params.id, req.user.username, req.user.role === 'admin'))
));

api.post('/task/:bucket/:id/verdict', wrap(async (req, res) => {
  const { bucket, id } = req.params;
  const before = laneSnapshot(bucket, id);
  const state = setVerdict(bucket, id, req.body.verdict ?? null, req.user.username);
  const after = laneSnapshot(bucket, id);
  // journal it so a decision made on the task page is undoable from the board too
  if (before.verdict !== after.verdict) {
    const v = after.verdict;
    recordAction({
      by: req.user.username, kind: 'verdict', items: [{ bucket, id, before, after }],
      label: `${id.slice(0, 8)}… · ${v ? (VERDICT_LABELS[v] || v) : 'verdict cleared'}`,
    });
  }
  res.json(state);
}));

// ---- lane moves (single + bulk), all journaled so they can be undone ----

// Move one task to a lane in a single call. The board's drag-and-drop uses this so
// a drag is one undoable action rather than three unrelated writes.
api.post('/task/:bucket/:id/lane', wrap(async (req, res) => {
  const { bucket, id } = req.params;
  const lane = String(req.body.lane || '');
  const item = moveTaskToLane(bucket, id, lane, { verdict: req.body.verdict ?? null, username: req.user.username });
  if (!item) return res.json({ moved: 0, action: null }); // already in that lane
  const act = recordAction({
    by: req.user.username, kind: 'move',
    label: `${id.slice(0, 8)}… · ${LANE_LABELS[laneOf(taskMeta(bucket, id))] || lane}`,
    items: [item],
  });
  res.json({ moved: 1, action: act && { id: act.id, label: act.label } });
}));

// Bulk lane move: every task matching {severity, fromLane} (and/or an explicit id
// list) → one destination lane. The selection is resolved server-side so it can't
// drift from a stale client copy of the board.
api.post('/bulk/lane', wrap(async (req, res) => {
  const { severity = 'ALL', fromLane = 'ANY', toLane, verdict = null, ids = null } = req.body || {};
  if (!toLane) throw httpError(400, 'toLane required');
  const candidates = selectTasks({ severity, fromLane, ids });
  const items = [];
  for (const meta of candidates) {
    const item = moveTaskToLane(meta.bucket, meta.id, toLane, { verdict, username: req.user.username });
    if (item) items.push(item);
  }
  const sevLabel = severity === 'ALL' ? '' : `${SEV_LABELS[severity] || severity} · `;
  const fromLabel = fromLane === 'ANY' ? 'any lane' : (LANE_LABELS[fromLane] || fromLane);
  const toLabel = (LANE_LABELS[toLane] || toLane) + (toLane === 'RESOLVED' && verdict ? ` (${VERDICT_LABELS[verdict] || verdict})` : '');
  const act = recordAction({
    by: req.user.username, kind: 'bulk_move',
    label: `${items.length} ${sevLabel}${fromLabel} → ${toLabel}`,
    items,
  });
  res.json({ moved: items.length, action: act && { id: act.id, label: act.label } });
}));

// Complete the Grammar Fixes lane, SPLIT by what the audit actually found.
//
// The lane holds two different kinds of task and they must not be tracked as one
// thing: those whose audit tripped only R23/R24 (grammar was the entire problem),
// and those that had other fails too and were moved in by hand once those were
// fixed. The first group resolves as GRAMMAR_ONLY, the second as FIXES_MADE.
//
// The discriminator is grammarOnly — the audit's own dimension list — not how the
// task entered the lane. A task whose review.md still lists R13 alongside R23 had
// more than a grammar problem, however it got here.
// (The /bulk/grammar-complete route is gone with the Grammar Fixes lane: the
// Staging lane's backfill check — /api/staging/verify + /resolve — replaced it.)

api.get('/actions', wrap(async (req, res) =>
  res.json({ actions: listActions(Math.min(Number(req.query.limit) || 12, 50)) })
));

api.post('/actions/:id/undo', wrap(async (req, res) =>
  res.json(undoAction(req.params.id, req.user.username))
));

// Confirm / cancel a bulk move Acey proposed. The plan is re-resolved against the
// CURRENT board at confirm time, so a proposal can't apply a stale selection.
api.post('/copilot/action/confirm', wrap(async (req, res) =>
  res.json(confirmPlan(String(req.body?.token || ''), req.user.username))
));

api.post('/copilot/action/cancel', wrap(async (req, res) =>
  res.json(cancelPlan(String(req.body?.token || ''), req.user.username))
));

// Superseded by /bulk/lane (which is journaled + undoable). Kept for any scripted
// callers; it can only express verdict-shaped destinations.
// Bulk workflow move: set a verdict (→ lane) across a whole severity bucket (or explicit ids).
// Any reviewer can do this — it's a personal workflow action, not an admin edit.
api.post('/verdict/bulk', wrap(async (req, res) => {
  const verdict = req.body.verdict ?? null;
  const only = req.body.bucket && req.body.bucket !== 'ALL' ? req.body.bucket : null;
  const idSet = Array.isArray(req.body.ids) && req.body.ids.length ? new Set(req.body.ids) : null;
  const ws = listWorkspace();
  let moved = 0;
  for (const [bucket, tasks] of Object.entries(ws)) {
    if (only && bucket !== only) continue;
    for (const t of tasks) {
      if (t.tour) continue;
      if (idSet && !idSet.has(t.id)) continue;
      setVerdict(bucket, t.id, verdict, req.user.username);
      moved++;
    }
  }
  res.json({ moved, verdict });
}));

// Move a task into / out of the Grammar Fixes lane by hand ({ mode: 'in'|'out'|null }).
api.post('/task/:bucket/:id/grammar-lane', wrap(async (req, res) =>
  res.json(setGrammarLane(req.params.bucket, req.params.id, req.body.mode ?? null, req.user.username))
));

// the "key issue" note behind a Second Opinion verdict
api.post('/task/:bucket/:id/verdict-note', wrap(async (req, res) =>
  res.json(setVerdictNote(req.params.bucket, req.params.id, req.body.note ?? '', req.user.username))
));

api.get('/task/:bucket/:id/state', wrap(async (req, res) => res.json(getState(req.params.bucket, req.params.id))));

api.post('/task/:bucket/:id/checklist', wrap(async (req, res) =>
  res.json(setChecklistItem(req.params.bucket, req.params.id, String(req.body.key || ''), req.body.status || '', req.user.username))
));

// Exports are generated fresh on every request, but without an explicit directive
// a browser is allowed to reuse a stored response WITHOUT revalidating (heuristic
// caching — there is no Cache-Control or Last-Modified here). For an `attachment`
// fetched by navigation that means the old bytes get written to disk and the export
// looks like it never updated. no-store forbids that.
function freshDownload(res, filename) {
  res.setHeader('cache-control', 'no-store, must-revalidate');
  res.setHeader('content-disposition', `attachment; filename="${filename}"`);
}

// Local-time stamp in the filename, so a re-export is a NEW file rather than
// "export (1).csv" sitting next to a stale "export.csv" you might reopen instead.
function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// One task_id per line for a bucket column, or ?verdict=SBQ for a verdict group.
api.get('/export/ids/:bucket', wrap(async (req, res) => {
  const ws = listWorkspace();
  let tasks = ws[req.params.bucket];
  if (!tasks) return res.status(400).json({ error: `unknown bucket ${req.params.bucket}` });
  tasks = tasks.filter((t) => !t.tour);
  if (req.query.verdict) tasks = tasks.filter((t) => t.verdict === req.query.verdict);
  res.setHeader('content-type', 'text/plain');
  freshDownload(res, `${req.params.bucket}${req.query.verdict ? '_' + req.query.verdict : ''}_task_ids_${stamp()}.txt`);
  res.send(tasks.map((t) => t.id).join('\n') + (tasks.length ? '\n' : ''));
}));

api.get('/export/all.csv', wrap(async (req, res) => {
  // Lane comes from the shared laneOf() rather than a copy of the rules. The copy
  // that used to live here is exactly how this column drifted from the board — it
  // had no Grammar Fixes case, so 27 tasks exported as the wrong lane.
  const csv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const ws = listWorkspace();
  const lines = ['task_id,bucket,lane,verdict,claimed_by,tags,has_review,has_remediation,grammar_only,delivered,audit_tags,pending_fixes,writing_band_as_delivered'];
  for (const [bucket, tasks] of Object.entries(ws)) {
    for (const t of tasks) {
      if (t.tour) continue;   // dummy tour tasks aren't real audit tasks
      const tags = t.grammar ? 'Spelling/Grammar Issues' : '';
      // `delivered` is included so the row count can be reconciled with the board,
      // which hides delivered tasks behind a toggle.
      lines.push([
        t.id, bucket, LANE_LABELS[laneOf(t)], t.verdict || '', t.claimedBy || '',
        tags, t.hasReview, t.hasRemediation, !!t.grammarOnly, !!t.delivered,
        (t.audit?.tags || []).join('|'), t.pendingFixes ?? 0, t.audit?.writing_band_as_delivered || '',
      ].map(csv).join(','));
    }
  }
  res.setHeader('content-type', 'text/csv');
  freshDownload(res, `audit_studio_export_${stamp()}.csv`);
  res.send(lines.join('\n') + '\n');
}));

api.get('/task/:bucket/:id', wrap(async (req, res) => res.json(taskMeta(req.params.bucket, req.params.id))));

api.get('/task/:bucket/:id/files', wrap(async (req, res) => res.json(listFiles(req.params.bucket, req.params.id))));

// RLI: the normalized record + deterministic spec checks for the task page.
api.get('/task/:bucket/:id/rli', wrap(async (req, res) => res.json(readRliIn(taskDir(req.params.bucket, req.params.id)))));

// RLI: the structured eval both the Review and Remediation tabs render from.
// 404 = no structured eval yet (the tabs fall back to the markdown docs).
api.get('/task/:bucket/:id/eval', wrap(async (req, res) => {
  const ev = readEval(taskDir(req.params.bucket, req.params.id));
  if (!ev) throw httpError(404, 'no eval.json for this task');
  res.json(ev);
}));

// RLI: stream any artifact byte-for-byte with its real content type (range
// requests work, so video/audio seek). Traversal-guarded like every task read.
api.get('/task/:bucket/:id/raw', wrap(async (req, res) => {
  const abs = resolveSafe(taskDir(req.params.bucket, req.params.id), String(req.query.path || ''));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpError(404, `file not found: ${req.query.path}`);
  if (req.query.download) return res.download(abs, path.basename(abs));
  res.sendFile(abs, { dotfiles: 'allow', headers: { 'Cache-Control': 'private, max-age=3600' } });
}));

api.get('/task/:bucket/:id/file', wrap(async (req, res) => {
  const rel = String(req.query.path || '');
  // ?download=1 streams the FULL file as an attachment — readTaskFile clips
  // text at 200k chars, which would hand over a truncated (invalid) rank.json.
  if (req.query.download) {
    const abs = resolveSafe(taskDir(req.params.bucket, req.params.id), rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw httpError(404, `file not found: ${rel}`);
    return res.download(abs, String(req.query.name || '') || path.basename(abs));
  }
  const f = readTaskFile(req.params.bucket, req.params.id, rel);
  if (f.kind === 'image') return res.sendFile(f.abs);
  res.json(f);
}));

api.get('/task/:bucket/:id/trajectory/:model', wrap(async (req, res) =>
  res.json(readTrajectory(req.params.bucket, req.params.id, req.params.model))
));

api.post('/task/:bucket/:id/move', wrap(async (req, res) => {
  moveTask(req.params.bucket, req.params.id, req.body.to);
  res.json({ ok: true, bucket: req.body.to });
}));

// admin: delete one task, or clear the whole board (fresh delivery cycle)
api.delete('/task/:bucket/:id', requireAdmin, wrap(async (req, res) => {
  deleteTask(req.params.bucket, req.params.id);
  res.json({ ok: true });
}));

api.post('/admin/clear', requireAdmin, wrap(async (req, res) => {
  res.json({ cleared: clearWorkspace() });
}));

// --- L10 pull: fetch tasks from Redash into a downloadable zip (admin only) ---
// Fire-and-forget (the pull downloads trajectories and can run for minutes); the
// admin UI polls /admin/pull-l10/status, then GETs /download when a zip is ready.
// body: { mode: 'l10' | 'ids', taskIds?: string[] }
api.post('/admin/pull-l10', requireAdmin, wrap(async (req, res) => {
  const mode = req.body?.mode === 'ids' ? 'ids' : 'l10';
  const taskIds = Array.isArray(req.body?.taskIds) ? req.body.taskIds.map(String) : [];
  if (mode === 'ids' && !taskIds.length) return res.status(400).json({ error: 'taskIds required for mode=ids' });
  res.json(startPull({ mode, taskIds, user: req.user.username }));
}));

api.get('/admin/pull-l10/status', requireAdmin, wrap(async (req, res) => res.json(pullStatus())));

api.get('/admin/pull-l10/download', requireAdmin, wrap(async (req, res) => {
  const dl = currentDownload();
  if (!dl) return res.status(404).json({ error: 'no pull available to download yet' });
  res.download(dl.abs, dl.name);
}));

// --- deliver: soft-archive tasks (hide from board) + build a restorable backup ---
const taskIdList = (body) => (Array.isArray(body?.taskIds) ? body.taskIds : [])
  .map((s) => String(s).trim()).filter(Boolean);

api.post('/admin/deliver', requireAdmin, wrap(async (req, res) => {
  const ids = taskIdList(req.body);
  if (!ids.length) return res.status(400).json({ error: 'taskIds required' });
  res.json(await markDelivered(ids, req.user.username));
}));

api.post('/admin/undeliver', requireAdmin, wrap(async (req, res) => {
  const ids = taskIdList(req.body);
  if (!ids.length) return res.status(400).json({ error: 'taskIds required' });
  res.json(markUndelivered(ids, req.user.username));
}));

// bulk-move: relocate many tasks at once. Source = an explicit taskIds list
// AND/OR every task in fromBucket. Destination = a target bucket, or mark them
// delivered. (admin only)
api.post('/admin/bulk-move', requireAdmin, wrap(async (req, res) => {
  const ids = new Set(taskIdList(req.body));
  if (req.body?.fromBucket) {
    const ws = listWorkspace();
    const list = ws[req.body.fromBucket];
    if (!list) return res.status(400).json({ error: `unknown bucket ${req.body.fromBucket}` });
    for (const t of list) if (!t.tour) ids.add(t.id);
  }
  const targetIds = [...ids];
  if (!targetIds.length) return res.status(400).json({ error: 'provide taskIds and/or fromBucket' });

  if (req.body?.delivered) return res.json({ mode: 'delivered', ...(await markDelivered(targetIds, req.user.username)) });

  const to = req.body?.to;
  if (!BUCKETS.includes(to)) return res.status(400).json({ error: `to must be one of ${BUCKETS.join(', ')}` });
  const moved = [], sameBucket = [], notFound = [];
  for (const id of targetIds) {
    const from = findTaskBucket(id);
    if (!from) { notFound.push(id); continue; }
    if (from === to) { sameBucket.push(id); continue; }
    try { moveTask(from, id, to); moved.push(id); } catch { notFound.push(id); }
  }
  res.json({ mode: 'move', to, moved: moved.length, sameBucket: sameBucket.length, notFound, movedIds: moved });
}));

api.get('/admin/deliver/status', requireAdmin, wrap(async (req, res) => res.json(deliverStatus())));

api.get('/admin/deliver/download', requireAdmin, wrap(async (req, res) => {
  const bk = currentBackup();
  if (!bk) return res.status(404).json({ error: 'no delivery backup available yet' });
  res.download(bk.abs, bk.name);
}));

// --- doc generation (SSE so the UI can show tool activity live) ---
// Doc generation runs as a background job (survives the client navigating away).
api.post('/task/:bucket/:id/docgen/:which', requireAdmin, wrap(async (req, res) => {
  const { bucket, id, which } = req.params;
  if (!['review', 'remediation'].includes(which)) return res.status(400).json({ error: 'which must be review|remediation' });
  res.json(enqueueDocs(bucket, id, [which], req.user.username));
}));

// generate docs for EVERY task at once (admin). onlyMissing (default true) skips
// tasks that already have the doc; pass {onlyMissing:false} to regenerate all.
api.post('/admin/gendocs', requireAdmin, wrap(async (req, res) => {
  const onlyMissing = req.body?.onlyMissing !== false;
  const ws = listWorkspace();
  let queued = 0, tasks = 0;
  for (const [bucket, list] of Object.entries(ws)) {
    for (const t of list) {
      if (t.tour) continue;
      const whichList = [];
      if (!onlyMissing || !t.hasReview) whichList.push('review');
      if (!onlyMissing || !t.hasRemediation) whichList.push('remediation');
      if (!whichList.length) continue;
      tasks++;
      if (enqueueDocs(bucket, t.id, whichList, req.user.username).queued) queued++;
    }
  }
  res.json({ queued, tasks });
}));

api.get('/admin/gendocs/status', requireAdmin, wrap(async (req, res) => res.json(jobSummary())));

api.get('/task/:bucket/:id/docstatus', wrap(async (req, res) => res.json(statusFor(req.params.bucket, req.params.id))));

// A generated doc plus its finding count — the Review tab badge and the task
// strip read this. Findings are the `### [HARD|SOFT|INFO] Fn` heading blocks.
api.get('/task/:bucket/:id/doc/:which', wrap(async (req, res) => {
  const { bucket, id, which } = req.params;
  if (!['review', 'remediation'].includes(which)) return res.status(400).json({ error: 'which must be review|remediation' });
  const f = readTaskFile(bucket, id, `${which}.md`); // 404s when not generated yet
  const findingCount = (String(f.text || '').match(/^###\s*\[(?:HARD|SOFT|INFO)\]\s*F\d+/gm) || []).length;
  res.json({ ...f, findingCount });
}));

// --- chat with task (SSE agent loop, history persisted in _chat.json) ---
const CHAT_PROMPT = `
You are Acey, the ACC quality SME embedded in a QM reviewer's audit session. You know the customer
program spec cold (the quality canon below; full texts via read_spec) and you have tools over
this task's files. The reviewer already has a verbose review.md and remediation.md — you are NOT
another source of prose. You are the source of truth they consult for specific questions.

Answer discipline (strict):
- Lead with the answer/verdict in one sentence. No preamble, no restating the question, no
  recapping what the review already says.
- Then exactly what supports it, in this shape:
  **Where:** the precise location — rank.json field path, traj:// citation, or file.
  **Evidence:** the quoted text / search hit count. Verbatim quotes, trimmed hard.
  **Rule:** the spec basis when severity or policy is involved — cite the sub-dimension or
  check code (e.g. "QC 4.2 [Fail - Fabricated or False Claim]", "ONL-GC-07").
- Default to under 120 words. Go longer ONLY when the reviewer asks for depth or the question
  is genuinely multi-part. One question, one answer — no unsolicited adjacent observations
  unless they change the verdict (then one line, marked "Also:").
- Never assert anything about a trajectory you haven't read or searched in this conversation.
  If you can't verify, say "unverified" and what you'd need.
- When judging severity, give the bucket (HARD / SOFT / INFO) and the one rule that decides it.
  When the reviewer asks "what should I look for", give a checklist of concrete searches/places
  ordered by expected yield, not an essay.

Taking action on the board (move_task, propose_bulk_move, list_board):
- You act AS this reviewer, with their permissions. Every action is journaled and undoable.
- ONLY act when they actually ask you to. Analysis never authorises a move: if your read is
  that a task is a hard fail, SAY SO — do not set the verdict. "Should this be SBQ?" is a
  question, not an instruction; answer it and offer to make the move.
- If the instruction is ambiguous about destination or verdict, ask ONE short question rather
  than guessing. Moving to Resolved always needs an explicit verdict — never invent one.
- move_task applies immediately to a single task, and is capped at ONE per turn. The moment the
  operator names two or more tasks — however they phrase it — use propose_bulk_move with
  task_ids instead. Do not issue repeated move_task calls to work around the cap.
  After a move, confirm what changed in one short sentence; don't re-describe or re-justify.
- propose_bulk_move applies NOTHING — it shows the reviewer a card they must click. Never say
  or imply a bulk move has happened. Say what the plan covers in one sentence and stop.
- Call list_board before any bulk proposal so the selection reflects the real board, and
  before answering questions about lanes, counts or what is left to review.
- Earlier turns are NOT evidence of current state. The board is shared and mutable — moves get
  undone, and other reviewers act on it between your turns. Never answer "that's already done"
  from your own history: check list_board first, then answer.
- The Spelling/Grammar tag is not a yes/no. "only" (R23/R24 and nothing else) is what routes a
  task to Grammar Fixes and resolves it GRAMMAR_ONLY; "flagged" means writing errors PLUS other
  fails, which resolves FIXES_MADE and does not belong in that lane. Never collapse the two, and
  never resolve a task GRAMMAR_ONLY whose otherDims are non-empty. "unaudited" means review.md
  has no autoqc fence — say so rather than reporting the task as clean.
- Never chain a bulk proposal into further action in the same turn, and never propose a move
  the reviewer did not ask for.
`.trim();

// --- dynamic copilot: a conversational, clickable guided walkthrough ---
// Shared voice: talk like a sharp colleague walking a teammate through a finding —
// plain English, no rubric-code soup — while every step still points at the exact spot.
const GUIDE_VOICE = `
Voice: casual + precise. Talk like a sharp colleague leaning over the reviewer's shoulder —
plain, direct, a little warm. Say what the problem is and why it matters in everyday words
("See here — Alpha swore all the tests passed, but it never actually ran them. That's the miss.").
Do NOT lead with rubric codes or field paths in the prose; the anchor already gives them a
one-click chip to verify. Short sentences. No preamble.

Anchor forms (EXACT — nothing else resolves; use real indices/paths you observed via tools):
  traj://model_a/<int>  or  traj://model_b/<int>   — a specific trajectory message
  field://<rank.json path>   — e.g. field:///results/model_1/grading/correctness/rationale
  spec://R<n>                — a QC rubric row, e.g. spec://R15
Invalid anchors are dropped server-side.
`.trim();

const GUIDE_RULES = `
DYNAMIC GUIDE MODE. Instead of a prose answer, build a step-by-step walkthrough the reviewer
clicks through, each step pointing at an exact place in this task's data.

${GUIDE_VOICE}

Investigate with your tools as usual, THEN finish by calling present_guide EXACTLY ONCE — the guide
IS the answer; do not also write prose.
- answerable: true only if at least one concrete anchored step supports the answer. For a
  general/opinion question with no place to point at, set answerable:false + a one-line reason.
- verdict_line: one conversational sentence opening the walk ("Yeah, this one's a real failure —
  let me walk you through it.").
- steps: ORDERED {anchor, commentary}; commentary = one or two plain-English sentences on what to
  notice here and why it matters.
`.trim();

const GUIDE_FOLLOWUP_RULES = `
DYNAMIC GUIDE — FOLLOW-UP. The reviewer is partway through a walkthrough you built and just asked
you something. Investigate with your tools if needed, then call guide_reply EXACTLY ONCE.

${GUIDE_VOICE}

- reply: answer their question directly and conversationally (2–4 sentences).
- revised_steps: include ONLY if their question means the walkthrough should now go somewhere
  different — the new ORDERED steps to REPLACE everything AFTER the step they're on (same
  {anchor, commentary} shape, same anchor rules). Omit it entirely if the existing plan still holds.
`.trim();

const guideStepsSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      anchor: { type: 'string', description: 'traj://model_a/<int> | traj://model_b/<int> | field://<rank.json path> | spec://R<n>' },
      commentary: { type: 'string' },
    },
    required: ['anchor', 'commentary'],
  },
};

const PRESENT_GUIDE_TOOL = {
  type: 'function',
  function: {
    name: 'present_guide',
    description: 'Deliver the answer as an ordered, clickable guided walkthrough anchored to exact spots. Call exactly once, at the end, instead of writing prose.',
    parameters: {
      type: 'object',
      properties: {
        answerable: { type: 'boolean' },
        reason: { type: 'string', description: 'why not answerable (only when answerable is false)' },
        verdict_line: { type: 'string' },
        steps: guideStepsSchema,
      },
      required: ['answerable', 'verdict_line'],
    },
  },
};

const GUIDE_FOLLOWUP_TOOL = {
  type: 'function',
  function: {
    name: 'guide_reply',
    description: "Answer the reviewer's mid-walkthrough question, and optionally revise the steps that come after where they are now.",
    parameters: {
      type: 'object',
      properties: {
        reply: { type: 'string' },
        revised_steps: { ...guideStepsSchema, description: 'omit unless the walkthrough should change course from here' },
      },
      required: ['reply'],
    },
  },
};

const resolvePath = (obj, p) => p.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

function validateAnchor(anchor, lens, rankRaw, rubricKeys) {
  let m;
  if ((m = anchor.match(/^traj:\/\/(model_[ab])\/(\d+)$/))) {
    const idx = Number(m[2]);
    if (idx >= 0 && idx < lens[m[1]]) return { ok: true, anchor };
    return { ok: false, why: `traj index ${idx} out of range (0..${Math.max(lens[m[1]] - 1, 0)})` };
  }
  if ((m = anchor.match(/^field:\/\/(\/.+)$/))) {
    if (rankRaw && resolvePath(rankRaw, m[1]) !== undefined) return { ok: true, anchor };
    return { ok: false, why: `rank.json path not found: ${m[1]}` };
  }
  if ((m = anchor.match(/^spec:\/\/(R\d+)$/))) {
    if (!rubricKeys || rubricKeys.has(m[1])) return { ok: true, anchor };
    return { ok: false, why: `rubric ${m[1]} not found` };
  }
  return { ok: false, why: 'unrecognized anchor form' };
}

// Resolve a list of {anchor, commentary} against real task data; drop anything unresolvable.
function validateSteps(bucket, id, steps) {
  const trajLen = (model) => {
    try { const t = readTrajectory(bucket, id, model); return (t.messages || t || []).length; } catch { return 0; }
  };
  const lens = { model_a: trajLen('model_a'), model_b: trajLen('model_b') };
  let rankRaw = null;
  try { rankRaw = JSON.parse(fs.readFileSync(path.join(taskDir(bucket, id), 'rank.json'), 'utf8')); } catch { /* no rank */ }
  let rubricKeys = null;
  try { const r = getRubric(); rubricKeys = new Set(Object.keys(r?.dimensions || r || {}).filter((k) => /^R\d+$/.test(k))); } catch { /* no rubric */ }
  if (rubricKeys && !rubricKeys.size) rubricKeys = null; // no rubric loaded → don't hard-fail spec anchors

  const kept = [];
  const dropped = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    const anchor = String(s?.anchor || '').trim();
    const commentary = String(s?.commentary || '').slice(0, 600);
    const v = validateAnchor(anchor, lens, rankRaw, rubricKeys);
    if (v.ok) kept.push({ anchor: v.anchor, commentary });
    else dropped.push({ anchor, why: v.why });
  }
  return { kept, dropped };
}

// Build the guide the client will play — every anchor resolved against real task data.
function validateGuide(bucket, id, args) {
  const verdict_line = String(args.verdict_line || '').slice(0, 400);
  if (args.answerable === false) {
    return { dynamic: false, reason: String(args.reason || 'no anchored evidence'), verdict_line };
  }
  const { kept, dropped } = validateSteps(bucket, id, args.steps);
  if (!kept.length) return { dynamic: false, reason: 'no resolvable anchors', verdict_line, dropped };
  return { dynamic: true, verdict_line, steps: kept, dropped };
}

api.post('/task/:bucket/:id/chat', wrap(async (req, res) => {
  const { bucket, id } = req.params;
  const dir = taskDir(bucket, id);
  const history = loadChat(dir);
  const userMsg = { role: 'user', content: String(req.body.message || '').slice(0, 50_000) };
  if (!userMsg.content) return res.status(400).json({ error: 'message required' });

  // RLI tasks get their own prompt, canon, citations and tools; ACC is unchanged.
  // Dynamic guides are ACC-only for now (their anchors are trajectory-based).
  const rli = isRliTask(dir);
  const dynamic = !rli && req.body.mode === 'dynamic';
  const system = rli
    ? [RLI_CHAT_PROMPT, rliCanon(), RLI_CITATION_RULES, rliTaskContext(dir)].join('\n\n')
    : [CHAT_PROMPT, QUALITY_CANON, CITATION_RULES, dynamic ? GUIDE_RULES : '', taskContext(bucket, id)]
      .filter(Boolean).join('\n\n');
  const acc = { prompt_tokens: 0, completion_tokens: 0 };
  const onUsage = (u) => { acc.prompt_tokens += u.prompt_tokens || 0; acc.completion_tokens += u.completion_tokens || 0; };
  // In dynamic mode the model's final answer is a present_guide tool call: validate its anchors
  // against real task data and push the built guide straight to the client.
  const readExec = rli ? makeRliExecutor(dir) : makeExecutor(bucket, id);
  // Board-writing tools are composed in HERE and nowhere else, so the offline doc
  // generator (which shares TOOL_DEFS) can never mutate task state. Acey acts as
  // the signed-in operator and inherits exactly their permissions.
  const actionExec = makeActionExecutor({
    bucket, id, username: req.user.username, onAction: (e) => sendSSE(res, e),
  });
  const ACTION_NAMES = new Set(ACTION_TOOL_DEFS.map((t) => t.function.name));
  const baseExec = async (name, args) =>
    (ACTION_NAMES.has(name) ? actionExec : readExec)(name, args);

  const executor = !dynamic ? baseExec : async (name, args) => {
    if (name !== 'present_guide') return baseExec(name, args);
    const guide = validateGuide(bucket, id, args);
    sendSSE(res, { type: 'guide', guide });
    return guide.dynamic
      ? `Guide delivered to the reviewer (${guide.steps.length} validated step(s)${guide.dropped?.length ? `, ${guide.dropped.length} dropped as unresolvable` : ''}). Stop now — do not add any prose.`
      : `Guide not available for dynamic (${guide.reason}); the reviewer was told. Stop now — do not add any prose.`;
  };
  startSSE(res);
  try {
    const { messages } = await runAgentLoop({
      messages: [{ role: 'system', content: system }, ...history, userMsg],
      tools: rli
        ? [...RLI_TOOL_DEFS, ...ACTION_TOOL_DEFS]
        : dynamic
          ? [...TOOL_DEFS, ...ACTION_TOOL_DEFS, PRESENT_GUIDE_TOOL]
          : [...TOOL_DEFS, ...ACTION_TOOL_DEFS],
      executor,
      onEvent: (e) => sendSSE(res, e),
      maxSteps: 50,
      onUsage,
    });
    saveChat(dir, [...history, userMsg, ...messages]);
    sendSSE(res, { type: 'done' });
  } catch (e) {
    sendSSE(res, { type: 'error', message: e.message });
  } finally {
    recordUsage({ user: req.user.username, taskId: id, kind: 'chat', model: config.litellm.model, usage: acc, text: userMsg.content });
  }
  res.end();
}));

// Mid-walkthrough follow-up: answer conversationally, and optionally revise the steps that come
// after where the reviewer is. Stateless (the client holds the guide); not persisted to chat.
api.post('/task/:bucket/:id/guide/followup', wrap(async (req, res) => {
  const { bucket, id } = req.params;
  const question = String(req.body.question || '').slice(0, 10_000);
  if (!question) return res.status(400).json({ error: 'question required' });
  const steps = Array.isArray(req.body.steps) ? req.body.steps : [];
  const stepIndex = Number.isInteger(req.body.stepIndex) ? req.body.stepIndex : 0;
  const original = String(req.body.originalQuestion || '').slice(0, 5_000);

  const here = steps[stepIndex] || null;
  const ahead = steps.slice(stepIndex + 1);
  const state = [
    original ? `The walkthrough answers the reviewer's original question: "${original}".` : '',
    here ? `They are on this step — commentary: "${here.commentary}" (anchor ${here.anchor}).` : 'They are on the opening card.',
    ahead.length
      ? `Steps still ahead of them:\n${ahead.map((s, i) => `${i + 1}. (${s.anchor}) ${s.commentary}`).join('\n')}`
      : 'There are no steps after this one yet.',
    `They just asked: "${question}"`,
  ].filter(Boolean).join('\n\n');

  const system = [CHAT_PROMPT, QUALITY_CANON, CITATION_RULES, GUIDE_FOLLOWUP_RULES, taskContext(bucket, id)].join('\n\n');
  const acc = { prompt_tokens: 0, completion_tokens: 0 };
  const onUsage = (u) => { acc.prompt_tokens += u.prompt_tokens || 0; acc.completion_tokens += u.completion_tokens || 0; };
  const baseExec = makeExecutor(bucket, id);
  const executor = async (name, args) => {
    if (name !== 'guide_reply') return baseExec(name, args);
    const reply = String(args.reply || '').slice(0, 2000);
    let revised = null;
    if (Array.isArray(args.revised_steps) && args.revised_steps.length) {
      const { kept } = validateSteps(bucket, id, args.revised_steps);
      if (kept.length) revised = kept;
    }
    sendSSE(res, { type: 'guide_reply', reply, revisedSteps: revised });
    return `Reply delivered${revised ? ` and ${revised.length} step(s) revised` : ''}. Stop now — do not add prose.`;
  };
  startSSE(res);
  try {
    await runAgentLoop({
      messages: [{ role: 'system', content: system }, { role: 'user', content: state }],
      tools: [...TOOL_DEFS, GUIDE_FOLLOWUP_TOOL],
      executor,
      onEvent: (e) => sendSSE(res, e),
      maxSteps: 30,
      onUsage,
    });
    sendSSE(res, { type: 'done' });
  } catch (e) {
    sendSSE(res, { type: 'error', message: e.message });
  } finally {
    recordUsage({ user: req.user.username, taskId: id, kind: 'chat', model: config.litellm.model, usage: acc, text: question });
  }
  res.end();
}));

api.get('/task/:bucket/:id/chat', wrap(async (req, res) => {
  const { bucket, id } = req.params;
  const history = loadChat(taskDir(bucket, id));
  // What the UI renders: user text + assistant text + tool markers — plus any
  // dynamic walkthroughs, rebuilt so they stay replayable after a reload.
  //
  // A walkthrough's final answer is a present_guide tool call, and its arguments
  // are in the saved history, so the guide is recovered by re-running the same
  // validation the live path uses. That is deterministic and costs no tokens — and
  // because it re-resolves every anchor against the task as it is NOW, a step whose
  // evidence has since moved is dropped rather than replayed as a dead link.
  const out = [];
  let lastUser = '';
  for (const m of history) {
    // The loop's note that artifact images were shown to the model is context for
    // the model, not something the reviewer typed — keep it out of the chat.
    if (m.role === 'user' && typeof m.content === 'string' && /^\[\d+ artifact image\(s\) were shown to the model/.test(m.content)) continue;
    if (m.role === 'user') { lastUser = m.content; out.push({ role: 'user', content: m.content }); continue; }
    if (m.role === 'assistant' && m.content) { out.push({ role: 'assistant', content: m.content }); continue; }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const plain = [];
      const guides = [];
      for (const c of m.tool_calls) {
        if (c.function?.name !== 'present_guide') { plain.push(c.function?.name); continue; }
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); } catch { /* unparseable → not answerable */ }
        guides.push(validateGuide(bucket, id, args));
      }
      if (plain.length) out.push({ role: 'tools', tools: plain });
      // the guide bubble replaces the bare "⚙ present_guide" marker
      for (const guide of guides) out.push({ role: 'guide', guide, question: lastUser });
    }
  }
  res.json(out);
}));

api.delete('/task/:bucket/:id/chat', wrap(async (req, res) => {
  const p = path.join(taskDir(req.params.bucket, req.params.id), '_chat.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
}));

function loadChat(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '_chat.json'), 'utf8'));
  } catch {
    return [];
  }
}
function saveChat(dir, messages) {
  writeJsonAtomic(path.join(dir, '_chat.json'), messages);
}

function startSSE(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders?.();
}
function sendSSE(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

api.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message });
});
