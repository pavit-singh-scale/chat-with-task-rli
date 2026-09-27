import { api, el, cap, renderAppHeader } from './common.js';
import { initIngest } from './ingest.js';

const KIND_LABEL = {
  chat: 'Copilot chat',
  'docgen:review': 'Generated review',
  'docgen:remediation': 'Generated remediation',
};

const fmtInt = (n) => (n || 0).toLocaleString();
const fmtCost = (n) => '$' + (n || 0).toFixed(2);
const fmtTime = (ts) => (ts ? ts.replace('T', ' ').slice(0, 16) + 'Z' : '');

let allEvents = [];
const searchInput = document.getElementById('activity-search');

async function boot() {
  const me = await api('/me'); // 401 → login
  if (me.role !== 'admin') { location.href = (window.__base__ || '') + '/'; return; }
  renderAppHeader({
    active: 'admin', user: me,
    extras: [
      el('span', { class: 'mono admin-rate', id: 'rate-note' }),
      el('a', { class: 'btn', href: (window.__base__ || '') + '/api/admin/usage.csv' }, 'Export CSV'),
    ],
  });
  initL10();
  initDeliver();
  await load();
}

// A task is "completed" when it carries a recorded decision (the board's Resolved lane).
const RESOLVED_VERDICTS = new Set(['NO_ISSUES', 'FIXES_MADE', 'SBQ']);

// --- Archive tasks (soft-archive / deliver + backup zip) ---
function initDeliver() {
  document.getElementById('deliver-btn').addEventListener('click', () => runDeliver('/admin/deliver'));
  document.getElementById('undeliver-btn').addEventListener('click', () => runDeliver('/admin/undeliver'));
  document.getElementById('archive-completed-btn').addEventListener('click', archiveCompleted);
  refreshDeliver();
}

// Gather every not-yet-archived task with a resolved decision and archive them all.
async function archiveCompleted() {
  const btn = document.getElementById('archive-completed-btn');
  const status = document.getElementById('deliver-status');
  btn.disabled = true;
  try {
    const ws = await api('/workspace');
    const ids = Object.values(ws).flat()
      .filter((t) => !t.tour && !t.delivered && t.verdict && RESOLVED_VERDICTS.has(t.verdict))
      .map((t) => t.id);
    if (!ids.length) { status.textContent = 'No completed (Resolved) tasks to archive right now.'; return; }
    if (!confirm(`Move ${ids.length} completed task${ids.length === 1 ? '' : 's'} to the archive? They'll leave the board but stay viewable in the Archive.`)) return;
    status.textContent = `Archiving ${ids.length} completed task(s) + building backup…`;
    const r = await api('/admin/deliver', { method: 'POST', body: { taskIds: ids } });
    renderDeliver(r, 'deliver');
  } catch (e) {
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function deliverIds() {
  return document.getElementById('deliver-input').value.trim().split(/[,\s]+/).filter(Boolean);
}

async function runDeliver(endpoint) {
  const taskIds = deliverIds();
  const status = document.getElementById('deliver-status');
  if (!taskIds.length) { status.textContent = 'Paste at least one task id.'; return; }
  status.textContent = endpoint.endsWith('undeliver') ? 'Restoring…' : 'Delivering + building backup…';
  for (const id of ['deliver-btn', 'undeliver-btn']) document.getElementById(id).disabled = true;
  try {
    const r = await api(endpoint, { method: 'POST', body: { taskIds } });
    renderDeliver(r, endpoint.endsWith('undeliver') ? 'restore' : 'deliver');
  } catch (e) {
    status.textContent = e.message;
  } finally {
    for (const id of ['deliver-btn', 'undeliver-btn']) document.getElementById(id).disabled = false;
  }
}

// On page load, surface the most recent backup (if the server still has one).
async function refreshDeliver() {
  try {
    const s = await api('/admin/deliver/status');
    if (s.lastDelivery) renderDeliver(s.lastDelivery, 'deliver', true);
  } catch { /* none yet */ }
}

function renderDeliver(r, kind, quiet) {
  const status = document.getElementById('deliver-status');
  const dl = document.getElementById('deliver-download');
  const detail = document.getElementById('deliver-detail');

  if (kind === 'restore') {
    status.textContent = `restored ${r.restored} task(s) to the board`;
    detail.textContent = [
      r.restoredIds?.length ? `restored: ${r.restoredIds.map((x) => x.slice(0, 8)).join(', ')}` : '',
      r.notFound?.length ? `not found: ${r.notFound.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    return;
  }
  dl.hidden = !r.zipName;
  if (r.zipName) dl.href = (window.__base__ || '') + '/api/admin/deliver/download';
  status.textContent = quiet
    ? `last backup ready${r.finishedAt ? ' · ' + fmtTime(r.finishedAt) + 'Z' : ''}`
    : `delivered ${r.delivered} task(s)${r.zipBytes ? ' · backup ' + fmtBytes(r.zipBytes) : ''}`;
  detail.textContent = [
    r.deliveredIds?.length ? `delivered: ${r.deliveredIds.map((x) => x.slice(0, 8)).join(', ')}` : '',
    r.notFound?.length ? `not found (skipped): ${r.notFound.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

// --- Pull tasks from Redash (L10 or an explicit id list) ---
let l10Polling = null;

function initL10() {
  document.getElementById('pull-ids-btn').addEventListener('click', () => {
    const raw = document.getElementById('pull-ids-input').value.trim();
    const taskIds = raw.split(/[,\s]+/).filter(Boolean);
    if (!taskIds.length) { setL10Text('Paste at least one task id.'); return; }
    triggerPull({ mode: 'ids', taskIds });
  });
  pollL10();
}

async function triggerPull(body) {
  const r = await api('/admin/pull-l10', { method: 'POST', body });
  if (!r.started && r.running) setL10Text('A pull is already running…');
  pollL10();
}

async function pollL10() {
  const s = await api('/admin/pull-l10/status');
  renderL10(s);
  clearTimeout(l10Polling);
  if (s.running) l10Polling = setTimeout(pollL10, 3000); // only poll while a pull is in flight
}

function renderL10(s) {
  const btn = document.getElementById('pull-ids-btn');
  btn.disabled = s.running;
  btn.textContent = s.running ? 'Pulling…' : 'Pull Task by ID';

  const r = s.lastRun;
  const dl = document.getElementById('pull-l10-download');
  dl.hidden = !(r && r.zipName);
  if (r && r.zipName) dl.href = (window.__base__ || '') + '/api/admin/pull-l10/download';

  if (s.running) setL10Text('Pulling tasks from Redash…');
  else if (!r) setL10Text('Paste task ids to pull.');
  else setL10Text(`done ${fmtTime(r.finishedAt)}Z`);

  const detail = document.getElementById('pull-l10-detail');
  if (!r) { detail.textContent = ''; return; }
  if (r.error || r.ok === false) {
    const head = r.error ? `last pull FAILED: ${r.error}` : 'last pull finished with issues';
    detail.textContent = [head, r.errors?.length ? `• ${r.errors.join('\n• ')}` : '', `(${r.mode || ''} pull)`]
      .filter(Boolean).join('\n');
    return;
  }
  const parts = [
    `last pull (${r.mode}): ${r.requested} requested · ${r.staged} packaged${r.zipBytes ? ` · ${fmtBytes(r.zipBytes)}` : ''}`,
  ];
  if (r.partial?.length) parts.push(`partial trajectories: ${r.partial.length} (${r.partial.map((x) => x.slice(0, 8)).join(', ')})`);
  if (r.errors?.length) parts.push(`issues:\n• ${r.errors.join('\n• ')}`);
  detail.textContent = parts.join('\n');
}

function setL10Text(t) { document.getElementById('pull-l10-status').textContent = t; }
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function load() {
  const data = await api('/admin/usage?limit=2000');
  document.getElementById('rate-note').textContent =
    `cost @ $${data.rate.inPer1M}/$${data.rate.outPer1M} per 1M in/out tokens`;

  // summary cards
  const t = data.totals;
  document.getElementById('stat-cards').replaceChildren(
    statCard('Interactions', fmtInt(t.interactions)),
    statCard('Input tokens', fmtInt(t.prompt_tokens)),
    statCard('Output tokens', fmtInt(t.completion_tokens)),
    statCard('Est. cost', fmtCost(t.cost)),
  );

  // by-user table
  const ut = document.getElementById('user-table');
  ut.replaceChildren(
    row('th', ['User', 'Interactions', 'Input', 'Output', 'Est. cost']),
    ...data.byUser.map((u) => row('td', [
      cap(u.user), fmtInt(u.interactions), fmtInt(u.prompt_tokens), fmtInt(u.completion_tokens), fmtCost(u.cost),
    ])),
  );
  if (!data.byUser.length) ut.append(emptyRow('No copilot activity yet.'));

  allEvents = data.events;
  renderEvents();
}

function statCard(label, value) {
  return el('div', { class: 'stat-card glass' },
    el('div', { class: 'stat-value' }, value),
    el('div', { class: 'stat-label' }, label),
  );
}

function renderEvents() {
  const q = searchInput.value.trim().toLowerCase();
  const rows = allEvents.filter((e) =>
    !q || [e.user, e.taskId, e.text, e.kind].some((v) => (v || '').toLowerCase().includes(q))
  );
  const et = document.getElementById('event-table');
  et.replaceChildren(
    row('th', ['Time', 'User', 'Action', 'Task', 'Detail', 'Tokens (in/out)', 'Cost']),
    ...rows.map((e) =>
      el('tr', {},
        td(fmtTime(e.ts)),
        td(cap(e.user)),
        td(KIND_LABEL[e.kind] || e.kind),
        e.taskId
          ? el('td', {}, el('a', { class: 'mono task-link', href: taskHref(e.taskId), title: e.taskId }, e.taskId.slice(0, 10) + '…'))
          : td('—'),
        el('td', { class: 'detail', title: e.text || '' }, e.text || ''),
        td(`${fmtInt(e.prompt_tokens)} / ${fmtInt(e.completion_tokens)}`),
        td(fmtCost(e.cost)),
      )
    ),
  );
  if (!rows.length) et.append(emptyRow(q ? 'No match.' : 'No copilot activity yet.'));
}

// We only log the task id, not its bucket — link via a resolver page hop is
// overkill, so just deep-link by scanning buckets client-side isn't available
// here; link to the board filtered by the id instead.
function taskHref(taskId) {
  return `${window.__base__ || ''}/?q=${encodeURIComponent(taskId)}`;
}

function row(cell, cells) {
  return el('tr', {}, ...cells.map((c) => el(cell, {}, c)));
}
function td(v) { return el('td', {}, v); }
function emptyRow(msg) {
  return el('tr', {}, el('td', { class: 'empty', colspan: '7' }, msg));
}

searchInput.addEventListener('input', renderEvents);

boot();

// Delivery ingest moved off the board with the redesign; the code is unchanged.
initIngest({ onChange: () => location.reload() });
