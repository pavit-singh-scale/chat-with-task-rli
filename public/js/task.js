import { api, apiSSE, renderMarkdown, el, mount, fmtTime, cap, startTour, avatar, personName } from './common.js';
import { createRli } from './rli.js';
import { createRliEval } from './rli_eval.js';

const pathRelative = location.pathname.slice((window.__base__ || '').length);
const [, , bucket, taskId] = pathRelative.split('/');
const SEV_LABEL = { HARD_FAIL: 'Fail', SOFT_FAIL: 'Non-fail', PASS: 'No issues', UNSORTED: 'Unsorted' };
document.getElementById('task-id').textContent = taskId;
const sevChip = document.getElementById('sev-chip');
const SEV_TAG = { HARD_FAIL: 'tag--hard', SOFT_FAIL: 'tag--soft', PASS: 'tag--pass', UNSORTED: '' };
sevChip.textContent = (SEV_LABEL[bucket] || bucket) + ' ▾';
sevChip.className = `tag sev-pill ${SEV_TAG[bucket] || ''}`;

const viewerEl = document.getElementById('viewer');
const viewerBody = document.getElementById('viewer-body');
// The tab bar names the active view now, so the old in-pane title has nowhere
// to go — keep a detached node so every `viewerTitle.textContent = …` is a
// harmless no-op rather than a crash.
const viewerTitle = document.createElement('span');
const trajToolbar = document.getElementById('traj-toolbar');
const trajCache = {};
let activeNav = null;

// ---------- view cache: every view keeps its DOM + scroll position ----------
// Switching between review.md, the trajectory, and files swaps live nodes in
// and out, so scroll position AND expanded/collapsed turn state persist.
const viewCache = new Map(); // key -> { node, scrollTop }
let currentViewKey = null;

// Back navigation (pinned ‹ in the viewer header, labelled with where it
// goes): each view registers how to reopen itself + a display label;
// switching views pushes the previous one onto the stack.
const viewReopeners = new Map(); // key -> { reopen: () => void, label: string }
const navStack = [];
let suppressHistory = false;
const backBtn = document.getElementById('back-btn');

function updateBackBtn() {
  const top = navStack[navStack.length - 1];
  backBtn.hidden = !top;
  if (top) backBtn.textContent = `‹ Back to ${top.label}`;
}

backBtn.addEventListener('click', () => {
  const prev = navStack.pop();
  if (!prev) return;
  suppressHistory = true;
  Promise.resolve(prev.reopen()).finally(() => { suppressHistory = false; });
  updateBackBtn();
});

function saveCurrentScroll() {
  if (currentViewKey && viewCache.has(currentViewKey)) {
    viewCache.get(currentViewKey).scrollTop = viewerEl.scrollTop;
  }
}

// 800px is a reading measure, right for prose (definition, findings, docs) and
// badly wrong for the tabular / side-by-side views — the QC spec's two-column
// card grid, CB responses, trajectories and the pipeline tables were all being
// squeezed into it while half the pane sat empty.
const WIDE_VIEWS = /^(qcspec|cb|pipeline|sbs|file|rankproof|rli)/;
function setDocWidth(key) {
  document.getElementById('viewer-body').classList.toggle('doc__inner--wide', WIDE_VIEWS.test(key || ''));
}

function mountView(key, build, { refresh = false } = {}) {
  setDocWidth(key);
  saveCurrentScroll();
  if (currentViewKey && currentViewKey !== key && !suppressHistory && viewReopeners.has(currentViewKey)) {
    navStack.push(viewReopeners.get(currentViewKey));
    if (navStack.length > 20) navStack.shift();
  }
  updateBackBtn();
  if (refresh) viewCache.delete(key);
  let entry = viewCache.get(key);
  if (!entry) {
    entry = { node: build(), scrollTop: 0 };
    viewCache.set(key, entry);
  }
  viewerBody.replaceChildren(entry.node);
  currentViewKey = key;
  viewerEl.scrollTop = entry.scrollTop;
  return entry;
}

// ---------- global traj:// + spec:// deep-link delegation ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-traj-model]');
  if (t) {
    e.preventDefault();
    showTrajectory(t.dataset.trajModel, Number(t.dataset.trajIndex), t.dataset.trajPhrase || null);
    return;
  }
  const c = e.target.closest('[data-cb-model]');
  if (c) {
    e.preventDefault();
    showModelResponsePhrase(c.dataset.cbModel, c.dataset.cbPhrase || null);
    return;
  }
  const cf = e.target.closest('[data-cb-field-path]');
  if (cf) {
    e.preventDefault();
    locateRankField(cf.dataset.cbFieldPath);
    return;
  }
  const rc = e.target.closest('[data-crit]');
  if (rc) { e.preventDefault(); rli.resetFilter(); viewCache.delete('rli-rubric'); showRliView('rubric').then(() => rli.flashCrit(Number(rc.dataset.crit), rc.dataset.critSide || null)); return; }
  const rf = e.target.closest('[data-rli-file]');
  if (rf) { e.preventDefault(); rli.openArtifact(rf.dataset.rliFile); return; }
  const rp = e.target.closest('[data-pref-pair]');
  if (rp) { e.preventDefault(); showRliView('preference').then(() => rli.flashPref(rp.dataset.prefPair, rp.dataset.prefDim || null)); return; }
  const s = e.target.closest('[data-spec-key]');
  if (s) {
    e.preventDefault();
    showQcSpec(s.dataset.specKey);
  }
});

// right-click a traj:// citation → context menu (open in single view or A↔B)
document.addEventListener('contextmenu', (e) => {
  const t = e.target.closest('[data-traj-model]');
  if (!t) return;
  e.preventDefault();
  const model = t.dataset.trajModel;
  const index = Number(t.dataset.trajIndex);
  openContextMenu(e.clientX, e.clientY, [
    { label: `Show in ${model === 'model_a' ? 'Model A' : 'Model B'}`, onClick: () => showTrajectory(model, index) },
    { label: 'View in A ↔ B', onClick: () => showSideBySide({ model, index }) },
  ]);
});

function openContextMenu(x, y, items) {
  document.querySelector('.ctx-menu')?.remove();
  const menu = el('div', { class: 'ctx-menu glass' },
    ...items.map((it) => el('button', { onclick: () => { menu.remove(); it.onClick(); } }, it.label)),
  );
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 90)}px`;
  document.body.append(menu);
  const away = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', away); } };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
}

// ---------- tabs ----------
// The left sidebar is gone: Documents became the tab bar, the trajectory list
// became Traj A / Traj B / A ↔ B, and Files (plus the QC spec, CB responses and
// the ranking proof) collapsed into one overflow menu. That roughly doubles the
// reading width of the document pane, which was the whole complaint.

const DOCS = [
  { key: 'review', label: 'Review', file: 'review.md' },
  { key: 'remediation', label: 'Remediation', file: 'remediation.md' },
];

let taskDef = null;
let hasReview = false;
let meta = null;
let activeTab = null;

// Traj A / Traj B / A ↔ B were three tabs for one view: the trajectory toolbar
// underneath already carries those exact three switches, so the tab bar was
// duplicating its own content. One "Trajectories" tab, and the toolbar picks
// the side — returning you to whichever you last had open.
let lastTraj = 'model_a';

const TABS = [
  { key: 'definition',   label: 'Definition',   open: () => showTaskDef() },
  { key: 'review',       label: 'Review',       open: () => openDoc(DOCS.find((d) => d.key === 'review')) },
  { key: 'remediation',  label: 'Remediation',  open: () => openDoc(DOCS.find((d) => d.key === 'remediation')) },
  { key: 'trajectories', label: 'Trajectories', open: () => (lastTraj === 'sbs' ? showSideBySide() : showTrajectory(lastTraj)) },
  { key: 'cb',           label: 'CB responses', open: () => showCbResponses() },
  { key: 'qcspec',       label: 'QC spec',      open: () => showQcSpec() },
  { key: 'pipeline',     label: 'Pipeline',     open: () => showPipeline() },
];

// ---------- RLI queue: tasks carrying a task.json get their own tab set ----------
const rli = createRli({
  bucket, taskId,
  onCrit: (n, side) => { rli.resetFilter(); viewCache.delete('rli-rubric'); return showRliView('rubric').then(() => rli.flashCrit(n, side)); },
  onSpec: (key) => showQcSpec(key),
});
// Review + Remediation for RLI render from the structured eval (eval.json).
let rliFixFocus = null;
const rliEval = createRliEval({
  bucket, taskId, rli,
  onCrit: (n, side) => { rli.resetFilter(); viewCache.delete('rli-rubric'); return showRliView('rubric').then(() => rli.flashCrit(n, side)); },
  onSpec: (key) => showQcSpec(key),
  onOpenTab: (key, focus) => { rliFixFocus = focus || null; openDoc(DOCS.find((d) => d.key === key)); },
  decorateFixDocs: (root) => decorateFixDocs(root),
  decisionPanel: (findings, checks, verdict, note) => buildChecklistView(findings, checks, verdict, note, { compact: true }),
});
const RLI_TABS = [
  { key: 'brief',        label: 'Brief',        open: () => showRliView('brief') },
  { key: 'deliverables', label: 'Deliverables', open: () => showRliView('deliverables') },
  { key: 'rubric',       label: 'Rubric',       open: () => showRliView('rubric') },
  { key: 'preference',   label: 'Preference',   open: () => showRliView('preference') },
  { key: 'review',       label: 'Review',       open: () => openDoc(DOCS.find((d) => d.key === 'review')) },
  { key: 'remediation',  label: 'Remediation',  open: () => openDoc(DOCS.find((d) => d.key === 'remediation')) },
  { key: 'qcspec',       label: 'QC spec',      open: () => showQcSpec() },
];
const RLI_LABEL = { brief: 'Brief', deliverables: 'Deliverables', rubric: 'Rubric', preference: 'Preference' };
let rliData = null;
async function showRliView(which) {
  setActiveTab(which);
  hideTrajToolbar();
  document.querySelector('.doc__regen')?.remove();
  viewReopeners.set(`rli-${which}`, { label: RLI_LABEL[which], reopen: () => showRliView(which) });
  const build = {
    brief: rli.buildBrief,
    deliverables: rli.buildDeliverables,
    rubric: rli.buildRubric,
    preference: rli.buildPreference,
  }[which];
  const key = `rli-${which}`;
  if (!viewCache.has(key)) {
    const node = await build();
    mountView(key, () => node);
  } else {
    mountView(key, () => null);
  }
}


function setActiveTab(key) {
  activeTab = key;
  for (const b of document.querySelectorAll('#tabs button[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === key));
  }
}

function openTab(key) {
  const t = TABS.find((x) => x.key === key);
  if (!t) return;
  setActiveTab(key);
  t.open();
}

function tabBadge(key) {
  if (meta?.kind === 'rli') {
    if (key === 'rubric' && rliData) return String(rliData.criteria.length);
    if (key === 'review' && rliData) { const f = rliData.checks.filter((c) => c.status === 'fail').length; return f ? String(f) : null; }
    if (key === 'deliverables' && rliData) return String(rliData.files.golden.length + rliData.files.ad1.length + rliData.files.ad2.length);
  }
  if (key === 'review' && meta?.findingCount) return String(meta.findingCount);
  // Both message counts on one tab, so collapsing the three didn't cost the
  // at-a-glance "how long is each side".
  if (key === 'trajectories' && trajMeta.model_a && trajMeta.model_b) {
    return `${trajMeta.model_a} / ${trajMeta.model_b}`;
  }
  if (key === 'cb') return meta?.models?.length ? String(meta.models.length) : null;
  return null;
}
const trajMeta = { model_a: null, model_b: null };

function renderTabs() {
  const bar = document.getElementById('tabs');
  const menu = document.getElementById('files-menu');
  // replaceChildren() below wipes the bar, so the persistent Files menu has to
  // be re-appended, not just left in the markup.
  const nodes = TABS.map((t) => {
    const badge = tabBadge(t.key);
    return el('button', {
      type: 'button', role: 'tab', 'data-tab': t.key,
      'aria-selected': String(activeTab === t.key),
      onclick: () => openTab(t.key),
    }, t.label, badge ? el('span', { class: 'badge' }, badge) : null);
  });
  bar.replaceChildren(...nodes, el('div', { class: 'spacer' }), menu);
}

async function buildSidebar() {
  meta = await api(`/task/${bucket}/${taskId}`);
  hasReview = meta.hasReview;
  taskDef ||= await api(`/task/${bucket}/${taskId}/taskdef`);
  meta.findingCount = 0;
  if (meta.hasReview) {
    try {
      const f = await api(`/task/${bucket}/${taskId}/doc/review`);
      meta.findingCount = parseFindings(f.text || '').length;
    } catch { /* not generated yet */ }
  }
  if (meta.kind === 'rli') {
    TABS.splice(0, TABS.length, ...RLI_TABS);
    document.getElementById('copilot-mode')?.setAttribute('hidden', '');
    if (copilotMode === 'dynamic') { copilotMode = 'static'; }
    refreshChatIntro?.();
    rliData = await rli.load();
    document.getElementById('dl-rank').firstChild.textContent = 'Download task.json ';
    document.querySelector('#verdict-select option[value="GRAMMAR_ONLY"]')?.remove();
  }
  renderTabs();
  buildFilesMenu();
  renderTaskStrip();

  if (meta.kind === 'rli') return;
  for (const m of ['model_a', 'model_b']) {
    loadTrajectory(m)
      .then((t) => { trajMeta[m] = `${t.count}`; renderTabs(); })
      .catch(() => { trajMeta[m] = '—'; renderTabs(); });
  }
}

// Everything that used to be a sidebar section but isn't a primary reading view.
async function buildFilesMenu() {
  const list = document.getElementById('files-list');
  // QC spec and CB responses are tabs now; what is left here is genuinely
  // "other stuff" — the ranking proof and the raw files.
  const entries = [];
  if (meta.hasRankingProof) {
    entries.push(el('button', { type: 'button', onclick: () => { closeMenus(); setActiveTab(null); showRankingProof(); } }, 'Ranking proof'));
    entries.push(el('div', { class: 'menu__sep' }));
  }
  list.replaceChildren(...entries);

  const tree = await api(`/task/${bucket}/${taskId}/files`);
  const files = [];
  (function walk(es) { for (const e of es) e.dir ? walk(e.children) : files.push(e.path); })(tree);
  const shown = files.filter((p) =>
    !SKIP_FILES.has(p) && !p.startsWith('trajectories/') &&
    !p.startsWith('snapshots/') && !p.startsWith('initial_snapshots/') && !p.startsWith('ranking_proof/'));
  for (const f of shown) {
    list.append(el('button', {
      type: 'button', class: 'menu__file', title: f,
      onclick: () => { closeMenus(); setActiveTab(null); showFile(f); },
    }, f));
  }
  if (!shown.length) list.append(el('div', { class: 'menu__hint menu__empty' }, 'No other files.'));
}

// Where this task sits in the reviewer's own queue, and what is still open on it.
async function renderTaskStrip() {
  const strip = document.getElementById('task-strip');
  const state = await api(`/task/${bucket}/${taskId}/state`).catch(() => ({}));
  const checks = state.checklist || {};
  const open = Math.max(0, (meta.findingCount || 0) - Object.keys(checks).length);
  const pct = meta.findingCount ? Math.round(((meta.findingCount - open) / meta.findingCount) * 100) : 0;

  let queue = null;
  try {
    const ws = await api('/workspace');
    const mine = Object.values(ws).flat().filter((t) => t.claimedBy === me?.username && !t.delivered && !t.tour);
    const idx = mine.findIndex((t) => t.id === taskId);
    const next = mine.find((t) => t.id !== taskId && !t.verdict);
    queue = { n: idx >= 0 ? idx + 1 : null, total: mine.length, next };
  } catch { /* strip degrades to findings only */ }

  if (meta.kind === 'rli' && rliData) {
    strip.classList.add('strip--rli');
    mount(strip, rli.summaryBar(rliData, { queue }),
      queue?.next ? el('a', { class: 'rli-sum__next', href: `${window.__base__ || ''}/task/${queue.next.bucket}/${queue.next.id}` }, 'Next task →') : null);
    return;
  }
  mount(strip,
    // Queue position only when there IS a queue — "Not claimed by you" was
    // the header's job said a second time.
    queue?.n ? el('span', {}, `Task ${queue.n} of ${queue.total} you claimed`) : null,
    meta.findingCount
      ? el('span', { class: 'progress', style: 'width:150px' }, el('i', { style: `width:${pct}%` }))
      : null,
    el('span', { class: 'sep' }, '·'),
    meta.findingCount
      ? el('span', {}, `${meta.findingCount} finding${meta.findingCount === 1 ? '' : 's'}, `,
        el('b', { class: open ? 'is-warn' : 'is-ok', style: 'font-family:var(--font);font-size:12px' },
          open ? `${open} still open` : 'all adjudicated'))
      : el('span', {}, 'No review generated yet'),
    el('span', { class: 'spacer' }),
    queue?.next
      ? el('a', { href: `${window.__base__ || ''}/task/${queue.next.bucket}/${queue.next.id}`, style: 'font-weight:600' }, 'Next task →')
      : null,
  );
}

// ---------- overflow menus ----------
function closeMenus() {
  for (const m of document.querySelectorAll('.menu__list')) m.hidden = true;
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#files-btn, #more-btn');
  if (btn) {
    const list = btn.parentElement.querySelector('.menu__list');
    const wasOpen = !list.hidden;
    closeMenus();
    list.hidden = wasOpen;
    return;
  }
  if (!e.target.closest('.menu__list')) closeMenus();
});

const SKIP_FILES = new Set(['review.md', 'remediation.md', '_audit_seed.md', '_chat.json', '_studio.json']);
const FILE_GROUP_ORDER = ['Task', 'Other'];

function setActive() {}
function findDocNav() { return null; }

function loadTrajectory(model) {
  // A rejected promise must not stay cached — it would make the trajectory
  // unloadable for the rest of the page's life after one transient failure.
  trajCache[model] ||= api(`/task/${bucket}/${taskId}/trajectory/${model}`)
    .catch((e) => { delete trajCache[model]; throw e; });
  return trajCache[model];
}

function hideTrajToolbar() {
  trajToolbar.hidden = true;
  setTrajLauncherActive(null);
}

// ---------- documents ----------
async function openDoc(doc, navNode, { refresh = false } = {}) {
  setActive(navNode);
  // Every entry path — tab click, gotoFinding, the Second Opinion jump, a
  // watchDoc completion — must sync the tab highlight, not just render.
  setActiveTab(doc.key);
  hideTrajToolbar();
  viewerTitle.textContent = doc.file;
  viewReopeners.set(`doc:${doc.key}`, { label: doc.label, reopen: () => openDoc(doc, findDocNav(doc.label)) });
  // RLI: both tabs are views of one structured eval. Always rebuilt — they are
  // working surfaces (fix decisions, finding adjudication, live scores).
  if (meta?.kind === 'rli') {
    const ev = await api(`/task/${bucket}/${taskId}/eval`).catch(() => null);
    if (ev) {
      const focus = rliFixFocus; rliFixFocus = null;
      const content = doc.key === 'review' ? await rliEval.buildReview(ev) : await rliEval.buildRemediation(ev, focus);
      mountView(`doc:${doc.key}`, () => content, { refresh: true });
      addRegenButton(doc);
      return;
    }
  }
  let missing = false;
  // Remediation is a WORKING surface (fix decisions + findings checklist +
  // verdict live below the prose), so it always rebuilds; caching it would
  // show stale decisions — the exact staleness class this app keeps meeting.
  if (doc.key === 'remediation') refresh = true;
  if (refresh || !viewCache.has(`doc:${doc.key}`)) {
    let content;
    try {
      const f = await api(`/task/${bucket}/${taskId}/file?path=${encodeURIComponent(doc.file)}`);
      content = el('div', { class: 'md' });
      // The remediation doc is a working surface: its fix blocks carry live
      // Approve / Edit / Deny controls wired below.
      content.innerHTML = renderMarkdown(f.text, { fixControls: doc.key === 'remediation' });
      if (doc.key === 'remediation') {
        decorateFixDocs(content);
        await appendChecklistSections(content);
      }
    } catch {
      missing = true;
      content = el('div', { class: 'md' },
        el('p', { class: 'hint-line' },
          me.role === 'admin' ? `No ${doc.file} yet — generate it from the button above.` : `${doc.label} hasn't been generated for this task yet.`));
      if (doc.key === 'remediation') await appendChecklistSections(content);
    }
    if (doc.key === 'review' && meta?.kind === 'rli') content = el('div', {}, await rli.checksPanel(), content);
    mountView(`doc:${doc.key}`, () => content, { refresh: true });
  } else {
    mountView(`doc:${doc.key}`, () => null);
  }
  addRegenButton(doc);
  // if a background job is mid-flight for this task, resume watching + auto-load
  if (missing) {
    try { const s = await api(`/task/${bucket}/${taskId}/docstatus`); if (s.state === 'running' || s.state === 'pending') watchDoc(doc); } catch { /* ignore */ }
  }
}

function addRegenButton(doc) {
  // The old viewer header is gone with the sidebar; the control now sits at the
  // top of the document pane itself.
  document.querySelector('.doc__regen')?.remove();
  if (me.role !== 'admin') return; // reviewers view docs; only admin generates
  // RLI runs ONE eval that feeds both tabs, so both buttons run it.
  const isRli = meta?.kind === 'rli';
  document.getElementById('viewer-body').prepend(
    el('button', {
      class: 'btn doc__regen',
      onclick: async () => {
        await api(`/task/${bucket}/${taskId}/docgen/${isRli ? 'review' : doc.key}`, { method: 'POST' });
        watchDoc(doc); // background job; poll + auto-reload, survives navigation
      },
    }, isRli ? 'Run eval' : `Generate ${doc.key}.md`)
  );
}

// Poll the server-side job for this task; reload the doc when it lands. Safe to
// stop (navigating away) — the job keeps running on the server regardless.
let docWatch = null;
async function watchDoc(doc) {
  clearInterval(docWatch);
  docWatch = null;
  document.querySelectorAll('.gen-banner').forEach((b) => b.remove()); // one banner at a time
  let banner = el('div', { class: 'gen-banner' }, 'Generating… this runs in the background — you can switch tasks or close this and come back.');
  viewerBody.prepend(banner);
  // A view switch detaches the banner; terminal messages re-attach to the live
  // pane rather than being written into a node nobody can see.
  const say = (text, cls = '') => {
    if (!banner.isConnected) {
      banner = el('div', { class: 'gen-banner' });
      viewerBody.prepend(banner);
    }
    banner.className = `gen-banner${cls ? ` ${cls}` : ''}`;
    banner.textContent = text;
  };
  let finished = false;
  const tick = async () => {
    let s;
    try { s = await api(`/task/${bucket}/${taskId}/docstatus`); } catch { return; }
    if (s.state === 'running' || s.state === 'pending') {
      // progress only updates in place — it must not chase the user across tabs
      if (banner.isConnected) banner.textContent = s.current ? `Generating ${s.current}.md… (background — feel free to navigate away)` : 'Queued… (background)';
      return;
    }
    clearInterval(docWatch); docWatch = null;
    finished = true;
    if (s.state === 'error') { say(`Generation failed: ${s.error}`, 'error-line'); return; }
    // The RLI eval files the task under its verdict — follow it to the new URL.
    if (s.movedTo && s.movedTo !== bucket) {
      say(`Eval filed this task as ${SEV_LABEL[s.movedTo] || s.movedTo} — reloading…`);
      setTimeout(() => { location.href = `${window.__base__ || ''}/task/${s.movedTo}/${taskId}?tab=${doc.key}`; }, 900);
      return;
    }
    if (activeTab === doc.key) {
      // still on this doc's tab (or its placeholder) — load the fresh doc
      banner.remove();
      openDoc(doc, findDocNav(doc.label === 'Review' ? 'Review' : 'Remediation'), { refresh: true });
    } else {
      // don't yank them off whatever they're reading — announce instead
      viewCache.delete(`doc:${doc.key}`); // next tab open fetches the fresh doc
      say(`${doc.key}.md is ready — open the ${doc.label} tab to read it.`);
    }
    buildSidebar();
  };
  await tick();
  if (!finished) docWatch = setInterval(tick, 3000);
}

// ---------- task definition / milestones ----------
async function showTaskDef() {
  setActiveTab('definition');
  hideTrajToolbar();
  viewerTitle.textContent = `task definition${taskDef.missing ? '' : ` (${taskDef.source})`}`;
  document.querySelector('.doc__regen')?.remove();
  viewReopeners.set('taskdef', { label: 'Task definition', reopen: () => { setActive(findDocNav('Task definition')); showTaskDef(); } });
  const presence = taskDef.missing || !taskDef.milestones.length ? null : await milestonePresence();
  mountView('taskdef', () => buildTaskDefView(presence), { refresh: true });
}

// Per-milestone presence in each model's user turns. Distinctive-token match
// (stopwords stripped) with in-order, one-turn-per-milestone assignment: each
// milestone claims the earliest not-yet-consumed user turn that clears the bar,
// so a single content-rich turn can't light up several milestones and matches
// must respect prompt order. Still advisory (paraphrases can slip past), but far
// fewer false "found"s than the old any-turn 50%-overlap check.
async function milestonePresence() {
  const turnToks = {};
  for (const m of ['model_a', 'model_b']) {
    try {
      const t = await loadTrajectory(m);
      turnToks[m] = t.messages.filter((x) => x.role === 'user')
        .map((x) => contentTokens(x.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ')));
    } catch { turnToks[m] = null; } // missing/stub trajectory
  }
  const msToks = taskDef.milestones.map((ms) => contentTokens(ms.prompt));
  const out = {};
  for (const ms of taskDef.milestones) out[ms.id] = {};
  for (const m of ['model_a', 'model_b']) {
    const turns = turnToks[m];
    if (turns == null) { for (const ms of taskDef.milestones) out[ms.id][m] = null; continue; }
    let ptr = 0; // next unconsumed user turn — enforces in-order assignment
    taskDef.milestones.forEach((ms, i) => {
      let found = false;
      for (let j = ptr; j < turns.length; j++) {
        if (milestoneMatch(msToks[i], turns[j])) { found = true; ptr = j + 1; break; }
      }
      out[ms.id][m] = found;
    });
  }
  return out;
}

// One worded status chip summarizing presence across both trajectories.
// Clickable → opens the A↔B side-by-side viewer at this milestone's prompt.
function presenceChip(milestone, a, b) {
  if (a == null && b == null) return el('span', { class: 'pres-chip unknown', title: 'no trajectory to check' }, 'No trajectory');
  const onclick = () => openMilestoneInSbs(milestone, a, b);
  const mk = (cls, title, text) => el('span', { class: `pres-chip clickable ${cls}`, title: `${title} · click to view in A ↔ B`, onclick }, text);
  if (a && b) return mk('yes', 'string-matched in both A and B', 'Found in A & B');
  if (!a && !b) return mk('no', 'no string match in A or B', 'Not found');
  return mk('partial', 'string-matched in only one side', a ? 'In A only' : 'In B only');
}

// Find a milestone's prompt in whichever side has it and open A↔B there.
async function openMilestoneInSbs(milestone, a, b) {
  const model = (b && !a) ? 'model_b' : 'model_a'; // prefer A, fall back to B
  let best = null;
  try {
    const traj = await loadTrajectory(model);
    const toks = tokenize(milestone.prompt);
    for (const m of traj.messages) {
      if (m.role !== 'user') continue;
      const ov = score(toks, tokenize(m.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ')));
      if (!best || ov > best.ov) best = { index: m.index, ov };
    }
  } catch { /* no trajectory; open SBS unfocused */ }
  setActive(null);
  showSideBySide(best ? { model, index: best.index } : null);
}

function buildTaskDefView(presence) {
  if (taskDef.missing) {
    return el('div', { class: 'callout info' },
      'No task definition shipped with this task (no embedded rank.json "task" object, no source_task/task.json). ',
      'Informational only per customer policy 2026-06-09 — never a finding.');
  }
  return el('div', { class: 'taskdef' },
    el('h1', {}, taskDef.title || 'Task definition'),
    el('div', { class: 'def-chips' },
      taskDef.category ? el('span', { class: 'chip' }, taskDef.category) : null,
      taskDef.difficulty ? el('span', { class: `chip diff-${taskDef.difficulty}` }, taskDef.difficulty) : null,
      taskDef.language ? el('span', { class: 'chip' }, taskDef.language) : null,
    ),
    el('h2', {}, `Milestones (${taskDef.milestones.length})`),
    el('p', { class: 'hint-line' },
      'The annotator must enter each milestone prompt (paraphrase counts) in order, in both trajectories. ',
      'Present / not-present matches distinctive words in order, one user turn per milestone — it errs toward "not found" over false positives, and can miss heavy paraphrases, so if a milestone reads "not found" but you believe it is there, ask Acey to confirm. ',
      '"Locate" jumps to the closest user turn — navigation, not a coverage verdict.'),
    taskDef.milestones.map((m, i) =>
      el('div', { class: 'milestone' },
        el('div', { class: 'milestone-head' },
          el('span', { class: 'chip milestone-id' }, m.id),
          el('span', { class: 'milestone-title' }, m.title || `Milestone ${i + 1}`),
          el('span', { class: 'spacer' }),
          presence ? presenceChip(m, presence[m.id]?.model_a, presence[m.id]?.model_b) : null,
          el('button', { onclick: () => locateMilestone('model_a', m) }, 'Locate in A'),
          el('button', { onclick: () => locateMilestone('model_b', m) }, 'Locate in B'),
          el('button', { onclick: () => askCopilotAboutMilestone(m) }, 'Ask Acey'),
        ),
        el('div', { class: 'milestone-prompt' }, m.prompt),
      )
    ),
    taskDef.user_persona
      ? [el('h2', {}, 'User persona'), renderPersona(taskDef.user_persona)]
      : null,
    taskDef.guardrails.length
      ? [el('h2', {}, 'Guardrails'), el('ul', {}, taskDef.guardrails.map((g) => el('li', {}, g)))]
      : null,
  );
}

// The persona usually ships as a JSON blob ({high_level_goals, hint_policy, …}).
// Render it as labeled cards instead of dumping the raw string. hint_policy is
// audit-critical (what the persona will / won't reveal), so it gets a highlight.
const PERSONA_FIELDS = [
  ['high_level_goals', 'Goals', '◎', ''],
  ['familiarity_with_tools', 'Tooling familiarity', '⚒', ''],
  ['opinions_on_patterns', 'Opinions & preferences', '✦', ''],
  ['communication_style', 'Communication style', '❝', ''],
  ['patience_style', 'Patience', '⏳', ''],
  ['hint_policy', 'Hint policy', '⚑', 'key'],
];
function humanizeKey(k) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function personaCard(label, icon, value, cls) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return el('div', { class: `persona-field${cls ? ' ' + cls : ''}` },
    el('div', { class: 'persona-label' }, el('span', { class: 'persona-ico' }, icon), el('span', {}, label)),
    el('div', { class: 'persona-value' }, text),
  );
}
function renderPersona(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    data = s[0] === '{' || s[0] === '[' ? (() => { try { return JSON.parse(s); } catch { return null; } })() : null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return el('div', { class: 'callout persona-plain' }, String(raw)); // not structured — plain text
  }
  const known = new Set(PERSONA_FIELDS.map((f) => f[0]));
  const rows = [];
  for (const [key, label, icon, cls] of PERSONA_FIELDS) {
    if (data[key] != null && data[key] !== '') rows.push(personaCard(label, icon, data[key], cls));
  }
  for (const [key, v] of Object.entries(data)) {
    if (!known.has(key) && v != null && v !== '') rows.push(personaCard(humanizeKey(key), '•', v, ''));
  }
  return rows.length ? el('div', { class: 'persona' }, ...rows) : el('div', { class: 'callout persona-plain' }, String(raw));
}

async function locateMilestone(model, milestone) {
  const traj = await loadTrajectory(model);
  const tokens = tokenize(milestone.prompt);
  let best = null;
  for (const m of traj.messages) {
    if (m.role !== 'user') continue;
    const text = m.parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
    const overlap = score(tokens, tokenize(text));
    if (!best || overlap > best.overlap) best = { index: m.index, overlap };
  }
  if (!best) {
    alert(`${model} has no user turns — likely a stub trajectory.`);
    return;
  }
  setActive(null);
  showTrajectory(model, best.index);
}

function tokenize(s) {
  return new Set(String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
}
function score(a, b) {
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return a.size ? hit / a.size : 0;
}

// Common English + task-boilerplate words that carry no distinguishing signal.
// Stripping them stops generic overlap ("add the code to a file") from faking a
// milestone match. Kept deliberately conservative — only truly ubiquitous words.
const STOPWORDS = new Set('the and for are but not you your with this that from have has had was were will would should can could may might must into onto over per via out off use used using make made need needs want add adding added create creating created update updated please note like just get got set new file files code function functions method methods output input value values test tests case cases run runs step steps also each them they this these those there their then than when what which who how why all any some more most such very much many few able ensure sure allow allows return returns also within about above below same other only what some'.split(/\s+/).filter(Boolean));

// Distinctive-token set for milestone matching: length>=3 alphanumerics minus
// stopwords. Separate from tokenize() so the looser A↔B alignment / Locate
// navigation behavior is untouched.
function contentTokens(s) {
  const toks = String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
  return new Set(toks.filter((t) => !STOPWORDS.has(t)));
}

// A milestone is "present" in a user turn only when a strong majority of its
// distinctive tokens appear AND at least two do (tiny prompts must appear in
// full) — much stricter than the old 50%-of-all-tokens-any-turn test.
function milestoneMatch(msToks, turnToks) {
  if (!msToks.size) return false;
  let hit = 0;
  for (const t of msToks) if (turnToks.has(t)) hit++;
  const need = msToks.size <= 2 ? msToks.size : 2;
  return hit >= need && hit / msToks.size >= 0.6;
}

function askCopilotAboutMilestone(m) {
  setChatCollapsed(false);
  chatText.value = `Check milestone ${m.id} ("${m.title || m.prompt.slice(0, 80)}") in both trajectories: was its intent entered by the annotator (paraphrase counts) or done proactively by the model? Cite the matching user turns with traj:// links, or quote evidence it is genuinely absent.`;
  chatText.focus();
}

// ---------- QC spec (V11 rubric) ----------
let rubricPromise = null;

async function showQcSpec(focusKey = null) {
  setActiveTab('qcspec');
  hideTrajToolbar();
  viewerTitle.textContent = 'QC spec';
  document.querySelector('.doc__regen')?.remove();
  viewReopeners.set('qcspec', { label: 'QC spec', reopen: () => { setActive(findDocNav('QC spec')); showQcSpec(); } });
  rubricPromise ||= api('/spec/rubric');
  const { dimensions } = await rubricPromise;
  mountView('qcspec', () => buildQcSpecView(dimensions));
  if (focusKey) {
    setActive(findDocNav('QC spec'));
    const node = document.getElementById(`spec-${focusKey}`);
    if (node) {
      revealInPane(node);
    }
  }
}

// scrollIntoView({block:'start'}) pins the target flush against the top of the
// scrolling pane, which reads as "cut off" — the card's own heading ends up
// hard against the tab bar. Scroll the pane manually with headroom instead.
function revealInPane(node, { offset = 28 } = {}) {
  const pane = document.getElementById('viewer');
  const delta = node.getBoundingClientRect().top - pane.getBoundingClientRect().top - offset;
  pane.scrollBy({ top: delta, behavior: 'smooth' });
  node.classList.remove('flash');
  void node.offsetWidth;          // restart the animation if it is already running
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 2400);
}

function buildQcSpecView(dimensions) {
  if (!dimensions.length) {
    return el('div', { class: 'callout info' },
      'The QC rubric hasn\'t been uploaded yet. An admin can add it from the home page (QC rubric · Upload CSV).');
  }
  // category -> group -> [variants]; sibling failure modes share one header
  const byCategory = new Map();
  for (const d of dimensions) {
    if (!byCategory.has(d.category)) byCategory.set(d.category, new Map());
    const groups = byCategory.get(d.category);
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(d);
  }
  // V11 added a milder score-4 band ("single minor slip") alongside 3 — both are
  // non-fails, so 4 shares the non-fail treatment in a softer shade.
  const SCORE = {
    1: { label: 'Fail', cls: 'fail' },
    2: { label: 'Fail', cls: 'fail' },
    3: { label: 'Non-fail', cls: 'nonfail' },
    4: { label: 'Non-fail', cls: 'nonfail minor' },
    5: { label: 'Pass', cls: 'pass' },
  };

  const card = (d, showVariant) =>
    el('div', { class: 'spec-card', id: `spec-${d.key}` },
      el('div', { class: 'spec-card-head' },
        el('span', { class: 'spec-key' }, d.key),
        showVariant ? el('span', { class: 'spec-variant' }, d.variant || d.group) : null,
      ),
      el('div', { class: 'spec-bands' },
        d.options.map((o) => {
          const s = SCORE[o.score] || { label: String(o.score), cls: '' };
          return el('div', { class: `spec-band-row ${s.cls}` },
            el('span', { class: 'spec-band-tag' }, `${o.score} · ${s.label}`),
            el('span', { class: 'spec-band-body' },
              o.category ? el('span', { class: 'spec-band-cat' }, o.category) : null,
              el('span', { class: 'spec-band-text' }, o.text),
            ),
          );
        }),
      ),
    );

  return el('div', { class: 'qcspec' },
    el('h1', {}, 'QC spec'),
    el('p', { class: 'hint-line' },
      meta?.kind === 'rli'
        ? `Updated RLI spec doc · ${dimensions.length} dimensions across ${byCategory.size} categories. Grade to the lowest dimension: any 1 is a Fail, any 3 makes the task a Non-fail, all 5s is No issues. Cited as D-keys — click any citation to land on its card.`
        : `V11 rubric · ${dimensions.length} failure modes across ${byCategory.size} categories. Cited as R-keys throughout reviews, remediations, and Acey — click any citation to land on its card.`),
    ...[...byCategory.entries()].flatMap(([category, groups]) => [
      el('h2', { class: 'spec-cat' }, category),
      [...groups.entries()].map(([group, dims]) => {
        const desc = dims.find((d) => d.description)?.description || '';
        const multi = dims.length > 1;
        return el('section', { class: 'spec-group' },
          el('div', { class: 'spec-group-head' },
            el('h3', {}, group),
            !multi && dims[0].variant ? el('span', { class: 'spec-group-variant' }, dims[0].variant) : null,
          ),
          desc ? groupDesc(desc) : null,
          el('div', { class: 'spec-grid' }, dims.map((d) => card(d, multi))),
        );
      }),
    ]),
  );
}

// Some V11 dimension descriptions run to a full screen of prose. Collapsed by
// default with a peek of the first lines — the cards below are what you came
// for; the rubric essay is reference you open when you need the exact wording.
function groupDesc(desc) {
  const wrap = el('p', { class: 'spec-group-desc collapsed' }, desc);
  const toggle = el('button', { class: 'spec-desc-toggle', type: 'button' }, 'Show more');
  toggle.addEventListener('click', () => {
    const open = wrap.classList.toggle('collapsed');
    toggle.textContent = open ? 'Show more' : 'Show less';
  });
  // Short descriptions don't need a control at all; measured after paint.
  requestAnimationFrame(() => {
    if (wrap.scrollHeight <= wrap.clientHeight + 4) {
      wrap.classList.remove('collapsed');
      toggle.remove();
    }
  });
  return el('div', { class: 'spec-desc' }, wrap, toggle);
}

// ---------- CB responses (rank.json behind a UI) ----------
let rankPromise = null;

// Every successful fixes action can rewrite rank.json — drop the cached rank
// promise AND the mounted CB view so the next open refetches instead of
// showing pre-fix text for the rest of the page's life.
function invalidateRankViews() {
  rankPromise = null;
  viewCache.delete('cb');
}

async function showCbResponses() {
  setActiveTab('cb');
  hideTrajToolbar();
  viewerTitle.textContent = 'CB responses — rank.json';
  document.querySelector('.doc__regen')?.remove();
  viewReopeners.set('cb', { label: 'CB responses', reopen: () => { setActive(findDocNav('CB responses')); showCbResponses(); } });
  rankPromise ||= api(`/task/${bucket}/${taskId}/rank`);
  const rank = await rankPromise;
  mountView('cb', () => buildCbResponsesView(rank));
}

function mdNode(text, cls = 'cb-prose') {
  const d = el('div', { class: cls });
  d.innerHTML = renderMarkdown(text || '_(none)_');
  return d;
}

// A labelled CB section tagged with its rank.json field name so /field citations
// can locate it.
function cbSection(field, label, content) {
  return el('div', { class: 'cb-section', 'data-cb-field': field },
    el('div', { class: 'cb-label' }, label), content);
}

// Open CB responses and scroll+flash the element for a rank.json field path
// (e.g. /ranking_rationale, /results/blue_tower/grading/correctness).
async function locateRankField(path) {
  setActive(findDocNav('CB responses'));
  await showCbResponses();
  const target = findRankFieldEl(path);
  if (!target) return;
  const isRow = target.tagName === 'TR';
  target.scrollIntoView({ behavior: 'smooth', block: isRow ? 'center' : 'start' });
  target.classList.add('flash');
  setTimeout(() => target.classList.remove('flash'), 2500);
}

function findRankFieldEl(path) {
  const parts = String(path).replace(/^\//, '').split('/');
  if (parts[0] === 'results' && parts[1]) {
    const key = parts[1];
    const card = [...viewerBody.querySelectorAll('.cb-model')]
      .find((c) => [c.dataset.cbKey, c.dataset.cbCodename, c.dataset.cbSide].includes(key));
    if (!card) return null;
    const field = parts[2];
    if (!field) return card;
    if (field === 'grading') {
      const dim = parts[3];
      if (dim) return card.querySelector(`.cb-grade-tbl tr[data-cb-dim="${cssEscape(dim)}"]`) || card.querySelector('[data-cb-field="grading"]');
      return card.querySelector('[data-cb-field="grading"]');
    }
    return card.querySelector(`[data-cb-field="${cssEscape(field)}"]`) || card;
  }
  return viewerBody.querySelector(`[data-cb-field="${cssEscape(parts[0])}"]`);
}

function cssEscape(s) {
  return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function scoreClass(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '';
  if (n >= 3) return 'good';   // ACC-format dimensions are scored 1–3 (3 = best)
  if (n === 2) return 'mid';
  return 'bad';
}

// Preference rating panel: negative favors Model A, positive favors Model B.
// Shows the winner up front, then a centered scale with a knob at the value.
function buildPrefPanel(rating) {
  const won = rating < 0 ? 'a' : rating > 0 ? 'b' : null;
  const mag = Math.abs(rating);
  const strength = ['no preference', 'slight', 'moderate', 'strong', 'very strong'][mag] || `magnitude ${mag}`;
  const extent = Math.max(3, mag);
  const pct = Math.max(2, Math.min(98, 50 + (rating / extent) * 50));
  const fillStyle = won === 'b' ? `left:50%;width:${pct - 50}%`
    : won === 'a' ? `left:${pct}%;width:${50 - pct}%`
      : 'left:50%;width:0';

  const verdict = el('div', { class: `cb-pref-verdict ${won ? 'won-' + won : 'tie'}` },
    el('span', {}, won === 'a' ? 'Model A preferred' : won === 'b' ? 'Model B preferred' : 'No preference'),
    el('span', { class: 'cb-pref-num' }, `${rating > 0 ? '+' : ''}${rating} · ${strength}`),
  );
  const track = el('div', { class: 'cb-pref-track' },
    el('div', { class: 'cb-pref-axis' }),
    el('div', { class: 'cb-pref-zero' }),
    el('div', { class: `cb-pref-fill ${won ? 'won-' + won : ''}`, style: fillStyle }),
    el('div', { class: `cb-pref-knob ${won ? 'won-' + won : ''}`, style: `left:${pct}%` }),
  );
  return el('div', { class: 'cb-pref-panel', 'data-cb-field': 'preference_rating' },
    verdict,
    el('div', { class: 'cb-pref-scale' },
      el('span', { class: 'cb-pref-end left' }, 'Model A'),
      track,
      el('span', { class: 'cb-pref-end right' }, 'Model B'),
    ),
  );
}

function buildCbResponsesView(rank) {
  if (!rank || !rank.present) {
    return el('div', { class: 'callout info' }, 'No rank.json shipped with this task, or it could not be parsed.');
  }
  const container = el('div', { class: 'cb' }, el('h1', {}, 'CB responses'));
  container.append(el('p', { class: 'hint-line' },
    'The annotator\'s rank.json — each model\'s summary, per-dimension grading, and failure modes, plus the A-vs-B decision. ',
    'Use “Open responses” or the find box to jump into a model\'s actual turns; citations in the text (traj:// / cb://) are clickable.'));

  // task-level decision
  const task = el('div', { class: 'cb-task' });
  if (rank.preference_rating != null) task.append(buildPrefPanel(rank.preference_rating));
  else task.append(el('div', { class: 'cb-pref-none', 'data-cb-field': 'preference_rating' }, 'No preference rating recorded in rank.json.'));
  task.append(cbSection('ranking_rationale', 'Ranking rationale', mdNode(rank.ranking_rationale)));
  if (rank.clarification) task.append(cbSection('optional_clarification_comments', 'Clarification comments', mdNode(rank.clarification)));
  if (rank.other) task.append(cbSection('optional_other_comments', 'Other comments', mdNode(rank.other)));
  container.append(task);

  for (const m of rank.models) {
    const sideCls = m.side === 'model_b' ? 'model_b' : 'model_a';
    const sideLabel = m.side === 'model_b' ? 'Model B' : m.side === 'model_a' ? 'Model A' : (m.side || '?');
    const head = el('div', { class: 'cb-model-head' },
      el('span', { class: 'cb-side' }, sideLabel),
      el('span', { class: 'cb-codename' }, m.codename || m.key),
      m.winner ? el('span', { class: 'cb-winner' }, 'Winner') : null,
      m.rank != null ? el('span', { class: 'cb-rank' }, `rank ${m.rank}`) : null,
      el('span', { class: 'spacer' }),
      m.side ? el('button', { class: 'cb-open', onclick: () => { setActive(null); showTrajectory(m.side); } }, 'Open responses →') : null,
    );

    const body = el('div', { class: 'cb-body' });

    // find-a-quote box: jump to the first response turn containing the phrase
    if (m.side) {
      const input = el('input', { type: 'text', placeholder: `Find a quote in ${sideLabel}'s responses…` });
      const go = () => { const q = input.value.trim(); if (q) showModelResponsePhrase(m.side, q); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      body.append(el('div', { class: 'cb-find' }, input, el('button', { onclick: go }, 'Find →')));
    }

    if (m.summary) body.append(cbSection('summary', 'Summary', mdNode(m.summary)));

    if (m.grading?.length) {
      const tbody = el('tbody');
      for (const g of m.grading) {
        const rat = el('td', { class: 'rat' });
        rat.innerHTML = renderMarkdown(g.rationale || '_(none)_');
        tbody.append(el('tr', { 'data-cb-dim': g.dim },
          el('td', { class: 'dim' }, g.dim.replace(/_/g, ' ')),
          el('td', { class: 'score' }, g.score != null ? el('span', { class: `cb-score ${scoreClass(g.score)}` }, `${g.score} / 3`) : '—'),
          rat,
        ));
      }
      const wrap = el('div', { class: 'cb-grade-wrap', 'data-cb-field': 'grading' },
        el('table', { class: 'cb-grade-tbl' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Dimension'), el('th', {}, 'Score'), el('th', {}, 'Assessment'))),
          tbody,
        ),
      );
      body.append(el('div', { class: 'cb-label' }, 'Grading'), wrap);
    }

    const flagged = (m.failure_modes || []).filter((f) => f.level && f.level !== 'none');
    body.append(cbSection('failure_modes', `Failure modes${flagged.length ? ` (${flagged.length})` : ''}`,
      flagged.length
        ? el('div', { class: 'cb-fmodes' }, ...flagged.map((f) => el('span', { class: `cb-fmode ${f.level}` }, `${f.key.replace(/_/g, ' ')} · ${f.level}`)))
        : el('div', { class: 'cb-fmodes-none' }, 'None flagged')));

    container.append(el('div', { class: `cb-model ${sideCls}`, 'data-cb-key': m.key, 'data-cb-codename': m.codename || m.key, 'data-cb-side': m.side || '' }, head, body));
  }
  return container;
}

// ---------- ranking proof (image + justification per side) ----------
async function showRankingProof() {
  hideTrajToolbar();
  viewerTitle.textContent = 'Ranking proof';
  document.querySelector('.doc__regen')?.remove();
  viewReopeners.set('rankproof', { label: 'Ranking proof', reopen: () => { setActive(findDocNav('Ranking proof')); showRankingProof(); } });
  const tree = await api(`/task/${bucket}/${taskId}/files`);
  const proof = [];
  (function walk(es) { for (const e of es) { if (e.dir) walk(e.children); else if (e.path.startsWith('ranking_proof/')) proof.push(e.path); } })(tree);
  mountView('rankproof', () => buildRankingProof(proof), { refresh: true });
}

function buildRankingProof(files) {
  if (!files.length) return el('div', { class: 'callout info' }, 'No ranking proof shipped with this task.');
  const container = el('div', { class: 'rankproof' }, el('h1', {}, 'Ranking proof'));
  for (const [k, label, cls] of [['a', 'Model A', 'traj-model_a'], ['b', 'Model B', 'traj-model_b']]) {
    const base = (f) => f.split('/').pop();
    const img = files.find((f) => /\.(png|jpe?g|webp)$/i.test(f) && base(f).startsWith(`${k}_`));
    const just = files.find((f) => f.endsWith('_justification.txt') && base(f).startsWith(`${k}_`));
    if (!img && !just) continue;
    const section = el('section', { class: 'rp-side' }, el('h2', { class: cls }, label));
    if (img) {
      const src = `${window.__base__ || ''}/api/task/${bucket}/${taskId}/file?path=${encodeURIComponent(img)}`;
      section.append(el('a', { href: src, target: '_blank', title: 'open full size' }, el('img', { class: 'rp-img', src })));
    }
    if (just) {
      const text = el('div', { class: 'rp-just-text' }, 'loading…');
      section.append(el('div', { class: 'rp-just' }, el('div', { class: 'rp-just-label' }, 'Justification'), text));
      api(`/task/${bucket}/${taskId}/file?path=${encodeURIComponent(just)}`).then((f) => { text.textContent = f.text || '(empty)'; }).catch(() => { text.textContent = '(could not load)'; });
    }
    container.append(section);
  }
  return container;
}

// ---------- pipeline (live upstream context from Redash) ----------
// The task folder is a snapshot of one attempt; this is where the task actually
// sits in the ACC pipeline, who worked it at each layer, and what it has cost.

const LVL_LABEL = {
  '-1': 'L-1 · Tasking', 0: 'L0 · Review', 1: 'L1 · Review', 4: 'L4 · Review',
  8: 'L8 · Review', 10: 'L10 · QM', 12: 'L12 · Final',
};
const lvlLabel = (l) => LVL_LABEL[String(l)] ?? `L${l}`;
const fmtDate = (s) => (s ? new Date(s).toISOString().slice(0, 16).replace('T', ' ') : '—');

async function showPipeline() {
  setActiveTab('pipeline');
  hideTrajToolbar();
  viewerTitle.textContent = 'Pipeline';
  document.querySelector('.doc__regen')?.remove();
  viewReopeners.set('pipeline', { label: 'Pipeline', reopen: () => { setActive(findDocNav('Pipeline')); showPipeline(); } });

  const host = el('div', { class: 'pipeline' }, el('div', { class: 'pl-loading' }, 'Querying Redash…'));
  mountView('pipeline', () => host, { refresh: true });
  try {
    const data = await api(`/redash/task/${taskId}`);
    host.replaceChildren(...buildPipeline(data));
  } catch (e) {
    host.replaceChildren(el('div', { class: 'callout info' }, `Could not load pipeline data: ${e.message}`));
  }
}

function buildPipeline(d) {
  const out = [el('h1', {}, 'Pipeline')];

  if (!d.history.length) {
    out.push(el('div', { class: 'callout info' },
      'This task has no pipeline nodes in Redash. That is normal for an older delivery whose nodes have been archived.'));
    return out;
  }

  // Where it is now + what it cost.
  const cur = d.current;
  out.push(el('div', { class: 'pl-cards' },
    plCard(cur ? lvlLabel(cur.reviewLevel) : '—', 'Current level', cur ? `status: ${cur.status}` : ''),
    plCard(`${d.totals.billableHours ?? d.totals.hours} h`, 'Billable time',
      // Tracked/active come from a different clock (TASKATTEMPTS) that whole
      // task generations don't have — say so instead of rendering a bare 0.
      d.totals.hours || d.totals.activeHours
        ? `${d.totals.activeHours} h active · ${d.totals.attempts} attempts`
        : `${d.totals.attempts} attempts · no tracked-time rows for this task id`),
    plCard(String(d.workers.length), 'People involved', d.workers.some((w) => w.suspectTeam) ? 'flagged team present' : ''),
    plCard(String(d.history.length), 'Pipeline nodes', cur ? `updated ${fmtDate(cur.endedAt)}` : ''),
  ));

  // A flagged worker team is audit-relevant, so it is called out rather than
  // left for the reviewer to notice in the table.
  const flagged = d.workers.filter((w) => w.suspectTeam);
  if (flagged.length) {
    out.push(el('div', { class: 'pl-flag' },
      el('b', {}, flagged.length === 1 ? 'Worker on a flagged team: ' : 'Workers on flagged teams: '),
      flagged.map((w) => `${w.name} (${w.team}, at ${lvlLabel(w.reviewLevel)})`).join('; '),
      el('div', { class: 'pl-flag-sub' },
        'Team path only — it is context for the audit, not a finding on its own.'),
    ));
  }

  // Time per level.
  if (d.time.length) {
    out.push(el('h2', {}, 'Time per level'));
    const barH = (t) => t.billableHours ?? t.hours;
    const maxH = Math.max(...d.time.map((t) => Math.max(barH(t), t.hours)), 0.01);
    out.push(el('div', { class: 'pl-time' },
      ...d.time.map((t) => el('div', { class: 'pl-time-row' },
        el('div', { class: 'pl-time-name' }, lvlLabel(t.reviewLevel)),
        el('div', { class: 'pl-time-bar' },
          el('div', { class: 'pl-time-fill', style: `width:${(barH(t) / maxH) * 100}%` }),
          el('div', { class: 'pl-time-fill active', style: `width:${(t.activeHours / maxH) * 100}%` })),
        el('div', { class: 'pl-time-val' }, `${barH(t)} h billed`,
          el('span', { class: 'pl-dim' }, t.hours || t.activeHours ? ` · ${t.hours} tracked / ${t.activeHours} active` : '')),
        el('div', { class: 'pl-dim' }, `${t.attempts} attempt${t.attempts === 1 ? '' : 's'}${t.uselessAttempts ? ` (${t.uselessAttempts} useless)` : ''}`),
      ))));
  }

  // Full node history, newest last (reading order matches the task's life).
  out.push(el('h2', {}, 'History'));
  const rows = d.history.map((n) => el('tr', { class: n.isCurrent ? 'pl-current' : '' },
    el('td', {}, el('span', { class: 'pl-lvl' }, lvlLabel(n.reviewLevel))),
    el('td', {}, el('span', { class: `pl-status s-${n.status}` }, n.status || '—')),
    el('td', {}, n.workerName
      ? el('span', { class: n.suspectTeam ? 'pl-worker flagged' : 'pl-worker', title: n.workerTeam || '' }, n.workerName)
      : el('span', { class: 'pl-dim' }, 'unassigned')),
    el('td', { class: 'pl-dim' }, n.workerTeam || ''),
    el('td', { class: 'mono pl-dim' }, fmtDate(n.startedAt)),
    el('td', { class: 'mono pl-dim' }, fmtDate(n.endedAt)),
  ));
  out.push(el('div', { class: 'admin-table-wrap' },
    el('table', { class: 'admin-table pl-table' },
      el('tr', {}, ...['Level', 'Status', 'Worker', 'Team', 'Entered', 'Left'].map((h) => el('th', {}, h))),
      ...rows)));

  out.push(el('div', { class: 'pl-foot' },
    `Live from Redash${d.cached ? ' (cached)' : ''} · ${fmtDate(d.retrievedAt)}`));
  return out;
}

function plCard(value, label, sub) {
  return el('div', { class: 'pl-card' },
    el('div', { class: 'pl-card-val' }, value),
    el('div', { class: 'pl-card-label' }, label),
    sub ? el('div', { class: 'pl-card-sub' }, sub) : null);
}

// ---------- checklist (adjudicate review findings → decision) ----------
const CHECK_VERDS = [
  ['NO_ISSUES', 'No Issues'],
  ['FIXES_MADE', 'Fixes made'],
  ['GRAMMAR_ONLY', 'Grammar-only'],
  ['SBQ', 'SBQ'],
  ['SECOND_OPINION', 'Second Opinion Needed'],
];

function parseFindings(md) {
  const out = [];
  const re = /^###\s*\[(HARD|SOFT|INFO)\]\s*(F\d+)\s*[—–-]+\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(md))) out.push({ sev: m[1], id: m[2], title: m[3] });
  return out;
}

// Jump from a checklist row to its finding in the Review doc.
async function gotoFinding(fid) {
  const reviewDoc = DOCS.find((d) => d.key === 'review');
  await openDoc(reviewDoc, findDocNav('Review'));
  setTimeout(() => {
    const node = document.getElementById(`finding-${fid}`);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 2500);
    }
  }, 60);
}

// ---------- Fixes (staging handoff §5) ----------
// The directive fixes render INSIDE the Checklist tab — one decision surface
// per task. There is deliberately no separate Fixes tab: it duplicated the
// checklist item-for-item within a day of existing. The remediation DOC shows
// the same blocks read-only, with the narrative around them; decisions happen
// here. showFixes() survives as an alias for anything holding an old deep link.
async function showFixes() { return showChecklist(); }

// ---------- interactive fix blocks in the remediation doc ----------
// The doc shows each directive with the prose around it; these controls make
// the doc itself the decision surface. Approve applies through the fix engine,
// Deny takes an inline reason, Edit unfolds the proposed text for rewording —
// an edited approval ships the reviewer's text and the ledger records what the
// model proposed next to what actually landed (edited_from).
async function decorateFixDocs(root) {
  let states;
  try { states = await api(`/task/${bucket}/${taskId}/fixes`); }
  catch {
    // the markdown pass already rendered live-looking buttons — kill them
    for (const box of root.querySelectorAll('.fixdoc[data-fix-path]')) disarmFixDoc(box, 'fix state unavailable');
    return;
  }
  const byId = new Map(states.items.map((i) => [i.id, i]));
  // APPLIED blocks in the doc carry their own ids; the seeded grammar entries
  // use G-ids. Path + old-text + occurrence is the stable join — the same
  // doubled word can appear twice in one field, and without occurrence both
  // blocks would bind to whichever entry the Map kept last.
  const fixJoinKey = (p, old, occ) => `${p}\u0000${old}\u0000${Number(occ) || 1}`;
  const byPathOld = new Map(states.items.filter((i) => i.path)
    .map((i) => [fixJoinKey(i.path, String(i.old), i.occurrence), i]));

  for (const box of root.querySelectorAll('.fixdoc[data-fix-path]')) {
    const path = box.dataset.fixPath;
    if (!path) continue;
    const oldText = box.querySelector('.fixdoc__old')?.textContent ?? '';
    const item = byId.get(box.dataset.fixId) || byPathOld.get(fixJoinKey(path, oldText, box.dataset.fixOccurrence));
    if (!item) {
      disarmFixDoc(box, 'couldn\'t match this block to the fix ledger — decide it under ‘Fixes without a block above’');
      continue;
    }
    wireFixDoc(box, item);
  }
}

// A fix block whose buttons can't act must not look live.
function disarmFixDoc(box, note) {
  const act = box.querySelector('.fixdoc__act');
  if (!act) return; // no controls rendered (instruction-only block)
  for (const b of act.querySelectorAll('.fixdoc-btn')) b.disabled = true;
  const decision = box.querySelector('.fixdoc__decision');
  if (decision) decision.textContent = note;
}

function wireFixDoc(box, item) {
  const decision = box.querySelector('.fixdoc__decision');
  const act = box.querySelector('.fixdoc__act');
  const editor = box.querySelector('.fixdoc__editor');
  if (!decision || !act) return;

  const paint = (i) => {
    const done = i.kind === 'grammar'
      ? (i.reverted ? { txt: `denied · reverted${i.reason ? ` — ${i.reason}` : ''}`, cls: 'is-denied' }
        : i.decided_by && i.decided_by !== 'acc-eval' ? { txt: `approved · ${i.decided_by}`, cls: 'is-approved' }
          : i.signed_off_by ? { txt: `signed off · ${i.signed_off_by}`, cls: 'is-approved' }
            : { txt: 'applied by the eval — sign off, edit or deny', cls: '' })
      : i.decision === 'approved' && !i.reverted ? { txt: `approved · ${i.decided_by}${latestEdit(i)}`, cls: 'is-approved' }
        : i.decision === 'denied' ? { txt: `denied · ${i.decided_by}${i.reason ? ` — ${i.reason}` : ''}`, cls: 'is-denied' }
          : i.needsReanchor ? { txt: 'NEEDS RE-ANCHOR — text drifted', cls: 'is-denied' }
            : { txt: 'awaiting your decision', cls: '' };
    decision.textContent = done.txt;
    decision.className = `fixdoc__decision ${done.cls}`;
    const decided = done.cls !== '';
    act.hidden = decided && i.kind !== 'grammar' && i.decision === 'denied' ? false : decided;
    // Denied stays actionable (approve-anyway is a legitimate reversal); a
    // decided approval hides the buttons — Undo lives in the checklist.
    if (i.decision === 'denied' || i.reverted) act.hidden = false;
    if ((i.decision === 'approved' && !i.reverted) || i.signed_off_by) act.hidden = true;
    // The green text shows what actually LANDED — an edited approval ships the
    // reviewer's version (applied_new), not the model's proposal.
    const landed = i.applied_new ?? i.new;
    if (landed !== undefined) {
      box.querySelector('.fixdoc__new').textContent = box.dataset.verdict
        ? (String(landed) === 'true' ? 'pass' : 'fail') // RLI verdict flips read pass/fail
        : landed === '' ? '(delete)' : String(landed);
    }
  };
  const latestEdit = (i) => (i.edited_from !== undefined && i.edited_from !== null ? ' · edited' : '');

  const refresh = async () => {
    const states = await api(`/task/${bucket}/${taskId}/fixes`);
    const next = states.items.find((x) => x.id === item.id)
      || states.items.find((x) => x.path === item.path && String(x.old) === String(item.old));
    if (next) {
      item = next;
      paint(item); // paint() also rewrites the green text with the landed version
    }
  };

  const call = async (action, body) => {
    try {
      const r = await api(`/task/${bucket}/${taskId}/fixes/${item.id}/${action}`, { method: 'POST', body: body || {} });
      if (r.result === 'DRIFTED') alert(`${item.id}: the text is not what this fix was authored against — nothing written.`);
      if (r.result === 'AMBIGUOUS') alert(`${item.id}: old matches more than once — route back to the eval.`);
      invalidateRankViews();
      await refresh();
      document.dispatchEvent(new CustomEvent('fix-decided', { detail: { id: item.id } }));
      return true;
    } catch (e) { alert(e.message); return false; }
  };

  act.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fix-action]');
    if (!btn) return;
    e.preventDefault();
    const action = btn.dataset.fixAction;
    if (action === 'approve') return call('approve');
    if (action === 'edit') return openEditor();
    if (action === 'deny') return openDeny();
  });

  function openEditor() {
    const current = box.querySelector('.fixdoc__new').textContent;
    const ta = el('textarea', { class: 'fixdoc__ta', spellcheck: 'false' },
      current === '(delete)' ? '' : current);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(220, ta.scrollHeight)}px`; };
    ta.addEventListener('input', grow);
    editor.replaceChildren(
      el('div', { class: 'fixdoc__editor-label' }, 'Your replacement — this exact text ships:'),
      ta,
      el('div', { class: 'fixdoc__editor-row' },
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { editor.hidden = true; } }, 'Cancel'),
        el('button', {
          class: 'btn btn--primary', type: 'button',
          onclick: async (ev) => {
            if (!ta.value.trim()) return ta.focus();
            ev.target.disabled = true;
            const ok = await call('approve', { new: ta.value });
            ev.target.disabled = false; // a failed call must leave the button usable
            if (ok) editor.hidden = true;
          },
        }, 'Apply my version')));
    editor.hidden = false;
    requestAnimationFrame(() => { grow(); ta.focus(); });
  }

  function openDeny() {
    const input = el('input', { class: 'fixdoc__ta fixdoc__reason', placeholder: 'Why this fix is wrong — recorded for the vendor dispute trail' });
    const denyBtn = el('button', {
      class: 'btn btn--primary', type: 'button',
      onclick: async () => {
        if (!input.value.trim()) return input.focus();
        denyBtn.disabled = true;
        const ok = await call('deny', { reason: input.value.trim() });
        denyBtn.disabled = false; // a failed call must leave the button usable
        if (ok) editor.hidden = true;
      },
    }, item.kind === 'grammar' ? 'Deny & revert' : 'Deny');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); denyBtn.click(); } });
    editor.replaceChildren(
      input,
      el('div', { class: 'fixdoc__editor-row' },
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => { editor.hidden = true; } }, 'Cancel'),
        denyBtn));
    editor.hidden = false;
    input.focus();
  }

  paint(item);
}

function buildFixesView(data) {
  const container = el('div', { class: 'fixes' });
  container.append(el('h1', {}, 'Fixes'));
  if (!data.items.length && !data.parseErrors.length) {
    container.append(el('p', { class: 'hint-line' }, 'This batch brought no directive fixes for this task.'));
    return container;
  }
  const grammar = data.items.filter((i) => i.kind === 'grammar');
  const proposed = data.items.filter((i) => i.kind === 'proposed');
  const instructions = data.items.filter((i) => i.kind === 'instruction');
  container.append(el('p', { class: 'hint-line' },
    `${grammar.length} grammar edit${grammar.length === 1 ? '' : 's'} already applied by the eval · `
    + `${proposed.length} proposed · ${data.pending} awaiting a decision.`
    + (data.hasSource ? '' : ' No rank.source.json — grammar reverts are unavailable.')));

  for (const e of data.parseErrors) {
    container.append(el('div', { class: 'fix-item fix-item--warn' },
      el('b', {}, `Unparseable fix block ${e.block}: `), e.error));
  }

  const act = async (id, action, body) => {
    try {
      const r = await api(`/task/${bucket}/${taskId}/fixes/${id}/${action}`, { method: 'POST', body: body || {} });
      if (r.result === 'DRIFTED') return alert(`${id}: the text is not what this fix was authored against (drifted) — nothing written.`);
      if (r.result === 'AMBIGUOUS') return alert(`${id}: old matches more than once — route back to the eval to widen it.`);
      invalidateRankViews();
      showFixes();
    } catch (err) { alert(err.message); }
  };

  const item = (f) => {
    const decided = f.decision !== 'pending' || f.kind === 'grammar';
    // green text = what actually shipped; an edited approval lands applied_new
    const landed = f.applied_new ?? f.new;
    const state = f.kind === 'grammar'
      ? (f.reverted ? 'denied · reverted' : (f.signed_off_by ? `signed off by ${f.signed_off_by}` : 'applied by the eval'))
      : f.decision === 'pending'
        ? (f.needsReanchor ? 'NEEDS RE-ANCHOR' : f.applicability === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'pending')
        : `${f.decision} by ${f.decided_by}`;
    const row = el('div', { class: `fix-item${f.meaning_changing ? ' fix-item--meaning' : ''}${f.reverted ? ' fix-item--reverted' : ''}` },
      el('div', { class: 'fix-item__head' },
        el('span', { class: 'fix-id mono' }, f.id),
        f.rule ? el('a', { class: 'spec-link', href: '#', 'data-spec-key': f.rule }, f.rule) : null,
        el('span', { class: 'fix-kind' }, f.kind),
        f.meaning_changing ? el('span', { class: 'fix-meaning', title: 'Alters what the sentence asserts — excluded from bulk approval' }, 'meaning-changing') : null,
        el('span', { class: 'fix-state' }, state)),
      f.path
        ? el('div', { class: 'fix-swap' },
          el('div', { class: 'fix-path mono' }, f.path),
          el('div', { class: 'fix-old' }, typeof f.old === 'string' ? f.old : String(f.old)),
          el('div', { class: 'fix-new' }, landed === '' ? '(delete)' : (typeof landed === 'string' ? landed : String(landed))))
        : el('div', { class: 'fix-instruction' }, f.instruction || '(instruction)'),
    );
    const buttons = el('div', { class: 'fix-actions' });
    if (f.kind === 'grammar' && !f.reverted) {
      if (!f.signed_off_by) buttons.append(el('button', { class: 'btn btn--ghost', onclick: () => act(f.id, 'approve') }, 'Sign off'));
      buttons.append(el('button', {
        class: 'btn btn--ghost fix-deny',
        onclick: () => { const r = prompt('Deny reverts this edit from rank.source.json. Reason:'); if (r) act(f.id, 'deny', { reason: r }); },
      }, 'Deny & revert'));
    } else if (f.kind === 'proposed' && f.decision === 'pending' && !f.needsReanchor) {
      buttons.append(el('button', { class: 'btn btn--ghost', onclick: () => act(f.id, 'approve') }, 'Approve & apply'));
      buttons.append(el('button', {
        class: 'btn btn--ghost fix-deny',
        onclick: () => { const r = prompt('Reason for denying this fix:'); if (r) act(f.id, 'deny', { reason: r }); },
      }, 'Deny'));
    } else if (f.decision === 'approved' && !f.reverted && f.kind === 'proposed') {
      buttons.append(el('button', { class: 'btn btn--ghost', onclick: () => act(f.id, 'revert') }, 'Undo'));
    }
    if (buttons.childElementCount) row.append(buttons);
    return row;
  };

  if (proposed.length || instructions.length) {
    container.append(el('h2', { class: 'fix-h2' }, 'Proposed'));
    proposed.forEach((f) => container.append(item(f)));
    instructions.forEach((f) => container.append(item(f)));
  }
  if (grammar.length) {
    // POST /fixes/approve-mechanical acts TASK-WIDE, so the count comes from
    // the full merged state (allItems), not just the rows in this list.
    const scope = data.allItems || data.items;
    const mech = scope.filter((i) => !i.meaning_changing
      && ((i.kind === 'grammar' && !i.signed_off_by && !i.reverted)
        || (i.kind === 'proposed' && i.decision === 'pending' && i.applicability === 'OK'))).length;
    container.append(el('h2', { class: 'fix-h2' }, 'Grammar (applied by the eval)',
      mech ? el('button', {
        class: 'btn btn--ghost fix-bulk',
        title: 'Meaning-changing edits are excluded — they get an individual look',
        onclick: async () => {
          try { await api(`/task/${bucket}/${taskId}/fixes/approve-mechanical`, { method: 'POST' }); invalidateRankViews(); showFixes(); }
          catch (e) { alert(e.message); }
        },
      }, `Approve all mechanical · ${mech}`) : null));
    grammar.forEach((f) => container.append(item(f)));
  }
  return container;
}

// The Checklist tab is merged INTO the Remediation tab (operator request —
// "include checklist functionality on the remediation page"): one working
// surface with the doc's reasoning on top and every decision below it.
// showChecklist survives as the alias for verdict flows and old deep links.
async function showChecklist() {
  const doc = DOCS.find((d) => d.key === 'remediation');
  // A fix decision rebuilds this whole view — mid-page it must not dump the
  // reviewer back at the top.
  const keepScroll = currentViewKey === 'doc:remediation' ? viewerEl.scrollTop : null;
  await openDoc(doc, findDocNav(doc.label), { refresh: true });
  if (keepScroll != null) viewerEl.scrollTop = keepScroll;
}

// The merged lower half of the Remediation tab:
//   1. fixes that have no ```fix fence in the doc (the seeded grammar edits on
//      v1-doc tasks) — same approve/deny controls, so no task loses its
//      decision UI just because its doc predates the fence format;
//   2. the findings checklist + verdict recording, verbatim from the old tab.
async function appendChecklistSections(content) {
  let fixData = null;
  let reviewText = '';
  let state = {};
  try {
    [fixData, state] = await Promise.all([
      api(`/task/${bucket}/${taskId}/fixes`).catch(() => null),
      api(`/task/${bucket}/${taskId}/state`),
    ]);
    reviewText = (await api(`/task/${bucket}/${taskId}/file?path=review.md`).catch(() => ({ text: '' }))).text || '';
  } catch { /* sections degrade individually below */ }

  if (fixData?.items?.length) {
    // Which fixes are already interactive fence blocks above? Join on id, then
    // on path+old (APPLIED fences carry their own ids, the seeded ledger uses
    // G-ids — same edit, two names).
    const covered = new Set();
    for (const box of content.querySelectorAll('.fixdoc[data-fix-id]')) {
      covered.add(box.dataset.fixId);
      const oldText = box.querySelector('.fixdoc__old')?.textContent ?? '';
      covered.add(`${box.dataset.fixPath}\u0000${oldText}\u0000${Number(box.dataset.fixOccurrence) || 1}`);
    }
    const residual = fixData.items.filter((i) =>
      !covered.has(i.id) && !(i.path && covered.has(`${i.path}\u0000${String(i.old)}\u0000${Number(i.occurrence) || 1}`)));
    if (residual.length) {
      const sub = buildFixesView({ ...fixData, items: residual, allItems: fixData.items,
        pending: residual.filter((i) => i.kind === 'proposed' && i.decision === 'pending').length });
      sub.querySelector('h1')?.remove();
      content.append(
        el('hr', { class: 'merged-rule' }),
        el('h2', { class: 'fix-h2' }, 'Fixes without a block above'),
        sub);
    }
  }

  content.append(
    el('hr', { class: 'merged-rule' }),
    buildChecklistView(parseFindings(reviewText), state.checklist || {}, state.verdict, state.verdict_note));
  if (focusNoteNext) {
    focusNoteNext = false;
    setTimeout(() => content.querySelector('.check-note-input')?.focus(), 120);
  }
}
let focusNoteNext = false;

function buildChecklistView(findings, checks, verdict, note, { compact = false } = {}) {
  const container = el('div', { class: `checklist${compact ? ' checklist--compact' : ''}` });
  if (!compact) container.append(el('h1', {}, 'Checklist'));
  if (!compact) container.append(el('p', { class: 'hint-line' },
    findings.length
      ? 'Adjudicate each review finding — mark it Done (fixed / verified) or Over-flag (not a real issue) — then record the decision below.'
      : 'No review findings yet (generate the Review to populate them) — you can still record a decision below.'));

  const local = { ...checks };
  const statusOf = (id) => local[id]?.status || 'open';
  const summary = el('div', { class: 'check-summary' });
  const suggestion = el('div', { class: 'check-suggestion' });

  function recompute() {
    const c = { open: 0, done: 0, overflag: 0, hardOpen: 0 };
    for (const f of findings) {
      const s = statusOf(f.id);
      c[s]++;
      if (s === 'open' && f.sev === 'HARD') c.hardOpen++;
    }
    summary.replaceChildren(
      el('span', {}, `${findings.length} findings`), sep(),
      el('span', { class: 'c-done' }, `${c.done} done`), sep(),
      el('span', { class: 'c-overflag' }, `${c.overflag} over-flagged`), sep(),
      el('span', { class: c.open ? 'c-open' : '' }, `${c.open} open`),
    );
    suggestion.textContent =
      c.open === 0
        ? (c.overflag === findings.length ? 'Everything over-flagged → likely No Issues.' : 'All findings addressed → likely Fixes made or No Issues.')
        : c.hardOpen
          ? `${c.hardOpen} HARD finding(s) still open → likely SBQ, or send for a second opinion.`
          : `${c.open} finding(s) still open.`;
  }
  const sep = () => el('span', { class: 'dot-sep' }, '·');

  async function onSet(id, status) {
    await api(`/task/${bucket}/${taskId}/checklist`, { method: 'POST', body: { key: id, status } });
    if (status) local[id] = { status }; else delete local[id];
    recompute();
  }

  // Compact mode: the caller renders the rows and drives adjudication here.
  container.setCheck = onSet;
  if (findings.length && !compact) {
    const list = el('div', { class: 'check-list' });
    for (const f of findings) list.append(checkRow(f, statusOf, onSet));
    container.append(list);
  }

  // Second-opinion "why": key-issue note, shown only when that verdict is active.
  const noteInput = el('textarea', { class: 'check-note-input', rows: '3',
    placeholder: 'What\'s the crux another reviewer needs to resolve? Cite the turn / claim / rank.json field.' });
  noteInput.value = note || '';
  const noteSaved = el('span', { class: 'check-note-saved' });
  let noteTimer;
  const saveNote = async () => {
    try {
      await api(`/task/${bucket}/${taskId}/verdict-note`, { method: 'POST', body: { note: noteInput.value } });
      noteSaved.textContent = 'saved';
      clearTimeout(noteTimer); noteTimer = setTimeout(() => { noteSaved.textContent = ''; }, 1500);
    } catch (e) { noteSaved.textContent = e.message; }
  };
  // 'change' alone — it already fires on blur when the value changed, and
  // binding blur too posted every save twice.
  noteInput.addEventListener('change', saveNote);
  const noteWrap = el('div', { class: 'check-note' },
    el('div', { class: 'check-note-label' }, el('span', {}, '⚠ Second opinion — key issue'), noteSaved),
    noteInput,
    el('div', { class: 'check-note-hint' }, 'Shown on the board and to whoever picks this up — the one thing that needs another set of eyes.'),
  );
  const updateNoteVisibility = (v) => {
    const show = v === 'SECOND_OPINION';
    noteWrap.hidden = !show;
    if (!show) noteInput.value = ''; // server clears the note when the verdict moves away
  };

  const verdictBtns = CHECK_VERDS.map(([k, label]) =>
    el('button', {
      class: `vbtn v-${k}${verdict === k ? ' active' : ''}`, 'data-v': k,
      onclick: async () => {
        // a failed POST must not paint the button active or move the select
        try { await api(`/task/${bucket}/${taskId}/verdict`, { method: 'POST', body: { verdict: k } }); }
        catch (e) { alert(e.message); return; }
        verdictSelect.value = k;
        verdictSelect.className = `verdict-select set v-${k}`;
        refreshState();
        container.querySelectorAll('.check-verdicts .vbtn').forEach((b) => b.classList.toggle('active', b.dataset.v === k));
        updateNoteVisibility(k);
        if (k === 'SECOND_OPINION') noteInput.focus();
      },
    }, label)
  );
  container.append(
    el('div', { class: 'check-panel' },
      el('h2', {}, 'Decision'),
      findings.length ? summary : null,
      findings.length ? el('p', { class: 'check-suggestion-wrap' }, suggestion) : null,
      el('div', { class: 'check-verdicts' }, ...verdictBtns),
      noteWrap,
    )
  );
  updateNoteVisibility(verdict);
  if (findings.length) recompute();
  return container;
}

function checkRow(f, statusOf, onSet) {
  const row = el('div', {},
    el('span', { class: `sev sev-${f.sev}` }, f.sev),
    el('button', { class: 'check-title', title: 'view this finding in the Review', onclick: () => gotoFinding(f.id) }, `${f.id} — ${f.title}`),
    el('span', { class: 'check-actions' }),
  );
  const actions = row.querySelector('.check-actions');
  const apply = () => {
    const s = statusOf(f.id);
    row.className = `check-row s-${s}`;
    actions.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.s === s));
  };
  for (const [s, label] of [['done', '✓ Done'], ['overflag', '⚑ Over-flag']]) {
    actions.append(el('button', {
      'data-s': s,
      onclick: async () => { await onSet(f.id, statusOf(f.id) === s ? '' : s); apply(); },
    }, label));
  }
  apply();
  return row;
}

// ---------- trajectory viewer (prompt-grouped, matching trajectory-viewer-v2) ----------
const TOOL_COLORS = {
  bash: 'blue', read: 'green', edit: 'amber', apply_patch: 'orange',
  write: 'cyan', grep: 'purple', glob: 'purple', task: 'stone', agent: 'pink', question: 'pink',
};

function groupTurns(messages) {
  const groups = [];
  let cur = null;
  for (const m of messages) {
    if (m.role === 'user') {
      cur = { user: m, assistants: [] };
      groups.push(cur);
    } else if (cur) {
      cur.assistants.push(m);
    } else {
      cur = { user: null, assistants: [m] };
      groups.push(cur);
    }
  }
  return groups;
}

function userText(m) {
  return m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

async function showTrajectory(model, focusIndex = null, phrase = null) {
  setActive(null); // single highlight: the launcher below is the only active marker
  lastTraj = model;
  setActiveTab('trajectories');
  viewerTitle.textContent = `Trajectory viewer — trajectory_${model}.json`;
  document.querySelector('.doc__regen')?.remove();
  viewReopeners.set(`traj:${model}`, {
    label: model === 'model_a' ? 'Model A' : 'Model B',
    reopen: () => showTrajectory(model),
  });
  let traj;
  try { traj = await loadTrajectory(model); }
  catch {
    // missing/stub trajectory: the tab is already selected, so the old view
    // must not silently stay — say what's wrong, in the pane
    setTrajLauncherActive(model);
    renderTrajTabs(model);
    mountView(`traj:${model}`, () =>
      el('div', { class: 'callout info' },
        `${model === 'model_a' ? 'Model A' : 'Model B'}'s trajectory is missing or unreadable for this task.`),
      { refresh: true });
    viewCache.delete(`traj:${model}`); // don't cache the error — a retry rebuilds
    return;
  }
  setTrajLauncherActive(model);
  renderTrajTabs(model);

  mountView(`traj:${model}`, () =>
    el('div', { class: 'convo' }, ...groupTurns(traj.messages).map((g, gi) => renderTurnGroup(model, g, gi)))
  );

  // An explicit citation jump overrides the remembered scroll position.
  if (focusIndex != null) jumpToMessage(model, focusIndex, phrase);
}

// Jump to the first message in a model's responses containing `phrase` (searched
// case-insensitively across text + reasoning), then highlight it. Backs cb://
// citations that point at model responses without a known message index.
async function showModelResponsePhrase(model, phrase) {
  let traj;
  try { traj = await loadTrajectory(model); }
  catch { alert(`${model === 'model_a' ? 'Model A' : 'Model B'} trajectory is unavailable.`); return; }
  let index = null;
  if (phrase) {
    const needle = phrase.trim().toLowerCase();
    for (const m of traj.messages) {
      const text = m.parts.filter((p) => p.type === 'text' || p.type === 'reasoning').map((p) => p.text).join(' ').toLowerCase();
      if (text.includes(needle)) { index = m.index; break; }
    }
  }
  setActive(null);
  showTrajectory(model, index, phrase);
}

// Wrap the first case-insensitive occurrence of `phrase` inside `container` in a
// <mark>, scroll to it, and flash. Returns true if it highlighted something.
function highlightPhraseIn(container, phrase) {
  if (!container || !phrase) return false;
  container.querySelectorAll('mark.cb-hl').forEach((mk) => mk.replaceWith(document.createTextNode(mk.textContent)));
  const needle = phrase.trim().toLowerCase();
  if (!needle) return false;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const idx = node.nodeValue.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + needle.length);
    const mark = el('mark', { class: 'cb-hl' });
    try { range.surroundContents(mark); } catch { return false; } // phrase spans elements — bail to block flash
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.classList.add('flash');
    setTimeout(() => mark.classList.remove('flash'), 2500);
    return true;
  }
  return false;
}

function setTrajLauncherActive(which) {
  for (const k of ['model_a', 'model_b', 'sbs']) {
    document.getElementById(`traj-launch-${k}`)?.classList.toggle('active', k === which);
  }
}

function renderTrajTabs(active) {
  trajToolbar.hidden = false;
  document.getElementById('collapse-all').style.display = active === 'sbs' ? 'none' : '';
  document.getElementById('traj-tabs').replaceChildren(
    el('button', { class: `traj-tab traj-model_a ${active === 'model_a' ? 'active' : ''}`, onclick: () => showTrajectory('model_a') }, 'Model A'),
    el('button', { class: `traj-tab traj-model_b ${active === 'model_b' ? 'active' : ''}`, onclick: () => showTrajectory('model_b') }, 'Model B'),
    el('button', { class: `traj-tab traj-sbs ${active === 'sbs' ? 'active' : ''}`, onclick: () => showSideBySide() }, 'A ↔ B'),
  );
}

// ---------- side-by-side compare ----------
// Align A and B by matched user prompts (anchors); each model's response to a
// shared prompt sits in its own column beneath it. Reactive/extra turns on one
// side render as a one-sided row.
async function showSideBySide(focus = null) {
  viewerTitle.textContent = 'Trajectory viewer — A ↔ B';
  document.querySelector('.doc__regen')?.remove();
  setActive(null);
  viewReopeners.set('sbs', { label: 'A ↔ B', reopen: () => showSideBySide() });
  let A, B;
  try { A = await loadTrajectory('model_a'); } catch { A = null; }
  try { B = await loadTrajectory('model_b'); } catch { B = null; }
  lastTraj = 'sbs';
  setActiveTab('trajectories');
  setTrajLauncherActive('sbs');
  renderTrajTabs('sbs');
  mountView('sbs', () => buildSideBySide(A, B), { refresh: true });
  if (focus) jumpToMessage(focus.model, focus.index);
}

function buildSideBySide(A, B) {
  if (!A || !B) {
    return el('div', { class: 'callout info' }, 'Side-by-side needs both trajectories; one is missing or a stub.');
  }
  const ga = groupTurns(A.messages), gb = groupTurns(B.messages);
  const rows = alignPrompts(ga, gb);
  const rowsWrap = el('div', { class: 'sbs-rows' });
  let n = 0;
  for (const r of rows) {
    if (r.type === 'anchor') {
      n++;
      rowsWrap.append(
        el('div', { class: 'sbs-row' },
          // shared prompt header spans both columns; carries the deep-link anchor
          el('div', { class: 'sbs-anchor', 'data-a-user': String(r.a.user.index), 'data-b-user': String(r.b.user.index) },
            el('div', { class: 'sbs-anchor-head' },
              el('span', { class: 'turn-num' }, `Prompt ${n}`),
              el('span', { class: 'sbs-idx' }, `A[${r.a.user.index}] · B[${r.b.user.index}]`),
              el('span', { class: 'spacer' }),
              el('span', { class: 'sbs-count' }, `${r.a.assistants.length} vs ${r.b.assistants.length} turns`),
            ),
            el('div', { class: 'msg-user-text' }, userText(r.a.user)),
          ),
          el('div', { class: 'sbs-cols' },
            el('div', { class: 'sbs-col col-a' },
              el('div', { class: 'sbs-col-tag traj-model_a' }, 'Model A'),
              ...r.a.assistants.map((a) => assistantBlock('model_a', a)),
            ),
            el('div', { class: 'sbs-col col-b' },
              el('div', { class: 'sbs-col-tag traj-model_b' }, 'Model B'),
              ...r.b.assistants.map((a) => assistantBlock('model_b', a)),
            ),
          ),
        ),
      );
    } else {
      // one-sided (extra/reactive turn on A or B): a dashed card with a clear
      // "Model X only" badge, and the content kept IN its own column so the side
      // is obvious at a glance — the other column shows a muted placeholder.
      const g = r.a || r.b;
      const model = r.a ? 'model_a' : 'model_b';
      const isA = model === 'model_a';
      const content = el('div', { class: `sbs-col ${isA ? 'col-a' : ''}` },
        el('div', { class: `sbs-col-tag ${isA ? 'traj-model_a' : 'traj-model_b'}` }, isA ? 'Model A' : 'Model B'),
        g.user ? userBlock(model, g.user) : null,
        ...g.assistants.map((a) => assistantBlock(model, a)),
      );
      const blank = el('div', { class: `sbs-col sbs-blank ${isA ? 'col-a' : ''}` },
        el('div', { class: 'sbs-blank-note' }, `no matching turn on ${isA ? 'Model B' : 'Model A'}`),
      );
      rowsWrap.append(
        el('div', { class: `sbs-row oneside ${model}` },
          el('div', { class: 'sbs-oneside-head' },
            el('span', { class: `sbs-oneside-badge ${model}` }, `${isA ? 'Model A' : 'Model B'} only`),
            el('span', { class: 'sbs-oneside-note' }, 'extra / reactive turn — no matching prompt on the other side'),
          ),
          el('div', { class: 'sbs-cols' }, isA ? content : blank, isA ? blank : content),
        ),
      );
    }
  }
  return el('div', { class: 'sbs' },
    el('div', { class: 'sbs-colhead' },
      el('span', { class: 'traj-model_a' }, `Model A · ${A.count} msgs`),
      el('span', { class: 'traj-model_b' }, `Model B · ${B.count} msgs`),
    ),
    rowsWrap,
  );
}

// Align A and B by their user prompts via an LCS over prompt similarity. A row is
// an "anchor" (shared step) ONLY when the two prompts genuinely match; every
// unmatched prompt stays one-sided. We never pair non-matching prompts — doing so
// (the previous greedy fallback) fabricated shared steps that exist on only one
// side, which is what made the side-by-side view misleading.
function alignPrompts(A, B) {
  const T = 0.5;
  const tok = (groups) => groups.map((g) => (g?.user ? tokenize(userText(g.user)) : null));
  const ta = tok(A), tb = tok(B);
  // Symmetric overlap so a long prompt vs its shorter paraphrase still matches.
  const match = (i, j) => !!ta[i] && !!tb[j] && Math.max(score(ta[i], tb[j]), score(tb[j], ta[i])) >= T;

  const n = A.length, m = B.length;
  // Suffix-form LCS length table, so reconstruction walks left→right in order.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = match(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (match(i, j)) { rows.push({ type: 'anchor', a: A[i], b: B[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: 'one', a: A[i] }); i++; }
    else { rows.push({ type: 'one', b: B[j] }); j++; }
  }
  while (i < n) rows.push({ type: 'one', a: A[i++] });
  while (j < m) rows.push({ type: 'one', b: B[j++] });
  return rows;
}

function jumpToMessage(model, index, phrase = null) {
  // exact message node, or (in A↔B) the shared anchor that folds this user prompt
  let node = document.getElementById(`msg-${model}-${index}`);
  if (!node) node = document.querySelector(`.sbs-anchor[data-${model === 'model_a' ? 'a' : 'b'}-user="${index}"]`);
  if (!node) return;
  node.closest('.turn-body')?.classList.add('open');
  node.closest('.turn-group')?.querySelector('.turn-header .arrow')?.classList.add('open');
  node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // A phrase highlight (from a ?q= citation) supersedes the whole-block flash.
  if (phrase && highlightPhraseIn(node, phrase)) return;
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 2500);
}

function userBlock(model, m) {
  return el('div', { class: 'msg-user', id: `msg-${model}-${m.index}` },
    el('div', { class: 'msg-user-label' },
      'User',
      el('span', { class: 'msg-idx' }, ` · ${model}[${m.index}] · ${fmtTime(m.created)}`),
      copyLinkBtn(model, m.index),
    ),
    el('div', { class: 'msg-user-text' }, userText(m)),
  );
}

function assistantBlock(model, a) {
  const blocks = [];
  for (const p of a.parts) {
    if (p.type === 'text' && p.text.trim()) {
      const d = el('div', { class: 'md asst-md' });
      d.innerHTML = renderMarkdown(p.text);
      blocks.push(d);
    } else if (p.type === 'reasoning' && p.text.trim()) blocks.push(el('div', { class: 'asst-text reasoning' }, p.text));
    else if (p.type === 'tool') blocks.push(renderToolBlock(p));
  }
  if (!blocks.length) blocks.push(el('div', { class: 'empty-resp' }, '(no response content)'));
  return el('div', { class: 'msg-asst', id: `msg-${model}-${a.index}` },
    el('div', { class: 'step-header' },
      'Assistant',
      el('span', { class: 'msg-idx' }, ` · ${model}[${a.index}]`),
      copyLinkBtn(model, a.index),
    ),
    blocks,
  );
}

function renderTurnGroup(model, g, gi) {
  const preview = g.user ? userText(g.user).slice(0, 130) : '(assistant continues)';
  const body = el('div', { class: 'turn-body open' });
  if (g.user) body.append(userBlock(model, g.user));
  for (const a of g.assistants) body.append(assistantBlock(model, a));

  const arrow = el('span', { class: 'arrow open' }, '▶');
  const header = el('div', {
    class: 'turn-header',
    onclick: () => {
      body.classList.toggle('open');
      arrow.classList.toggle('open');
    },
  },
    arrow,
    el('span', { class: 'turn-num' }, g.user ? `Prompt ${gi + 1}` : 'Preamble'),
    el('span', { class: 'turn-preview' }, preview),
  );
  return el('div', { class: 'turn-group' }, header, body);
}

function copyLinkBtn(model, index) {
  return el('button', {
    class: 'copy-link', title: 'copy traj:// link for use in chat/docs',
    onclick: (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(`traj://${model}/${index}`);
      const btn = e.currentTarget;
      btn.textContent = 'copied';
      setTimeout(() => { btn.textContent = 'link'; }, 1200);
    },
  }, 'link');
}

function renderToolBlock(p) {
  const color = TOOL_COLORS[p.tool] || 'default';
  const body = el('div', { class: 'tool-body' },
    el('div', { class: 'codeblock' }, `${p.input}`),
    el('div', { class: 'codeblock out' }, p.output || '(no output)'),
  );
  const arrow = el('span', { class: 'arrow' }, '▶');
  return el('div', { class: `tool-block tbl-${color}` },
    el('div', {
      class: 'tool-header',
      onclick: () => { body.classList.toggle('open'); arrow.classList.toggle('open'); },
    },
      arrow,
      el('span', { class: `tool-badge tb-${color}` }, p.tool),
      el('span', { class: 'tool-title' }, p.title || ''),
      el('span', { class: 'tool-dur' }, p.status),
    ),
    body,
  );
}

let allCollapsed = false;
document.getElementById('collapse-all').addEventListener('click', (e) => {
  allCollapsed = !allCollapsed;
  viewerBody.querySelectorAll('.turn-body').forEach((b) => b.classList.toggle('open', !allCollapsed));
  viewerBody.querySelectorAll('.turn-header .arrow').forEach((a) => a.classList.toggle('open', !allCollapsed));
  e.currentTarget.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
});

// ---------- files ----------
async function showFile(relPath) {
  hideTrajToolbar();
  viewerTitle.textContent = relPath;
  document.querySelector('.doc__regen')?.remove();
  viewReopeners.set(`file:${relPath}`, {
    label: relPath.split('/').pop(),
    reopen: () => {
      setActive([...document.querySelectorAll('#nav-files .nav-item')].find((b) => b.title === relPath) || null);
      showFile(relPath);
    },
  });
  if (viewCache.has(`file:${relPath}`)) {
    mountView(`file:${relPath}`, () => null);
    return;
  }
  let content;
  if (/\.(png|jpg|jpeg|gif|webp)$/i.test(relPath)) {
    content = el('img', { class: 'proof', src: `${window.__base__ || ''}/api/task/${bucket}/${taskId}/file?path=${encodeURIComponent(relPath)}` });
  } else {
    const f = await api(`/task/${bucket}/${taskId}/file?path=${encodeURIComponent(relPath)}`);
    if (relPath.endsWith('.md')) {
      content = el('div', { class: 'md' });
      content.innerHTML = renderMarkdown(f.text);
    } else if (relPath.endsWith('.json')) {
      let pretty = f.text;
      try { pretty = JSON.stringify(JSON.parse(f.text), null, 2); } catch { /* show raw */ }
      content = el('pre', { class: 'raw' }, pretty);
    } else {
      content = el('pre', { class: 'raw' }, f.text);
    }
    if (f.truncated) content = el('div', {}, el('p', { class: 'hint-line' }, '[file clipped at 200k chars]'), content);
  }
  mountView(`file:${relPath}`, () => content);
}

// ---------- chat ----------
// The platform-side takeover link for THIS task.
const OUTLIER_CLAIM_URL = `https://app.outlier.ai/en/expert/tasks?forceClaim=1&taskId=${encodeURIComponent(taskId)}`;
document.getElementById('force-claim').href = OUTLIER_CLAIM_URL;

// ⋯ menu utilities. Copy actions confirm inline on the button itself — the
// menu stays open long enough to read "Copied ✓", then closes.
function wireCopy(id, getText) {
  const btn = document.getElementById(id);
  const label = btn.textContent;
  btn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(getText()); }
    catch { prompt('Copy:', getText()); return; }
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = label; closeMenus(); }, 650);
  });
}
wireCopy('copy-task-id', () => taskId);
wireCopy('copy-board-link', () => location.href);
wireCopy('copy-outlier-link', () => OUTLIER_CLAIM_URL);

// Downloads stream the CURRENT file through the API (no-store, always live)
// under a stamped filename, so a saved copy is identifiable later. Navigation,
// not api(): the JSON file route clips text at 200k chars, which would save a
// truncated (invalid) rank.json labelled as the current state.
function wireDownload(id, file, suffix, pick = null) {
  document.getElementById(id).addEventListener('click', () => {
    if (pick) { file = pick(); suffix = file; }
    const name = `${taskId}_${suffix}`;
    const a = document.createElement('a');
    a.href = `${window.__base__ || ''}/api/task/${bucket}/${taskId}/file?path=${encodeURIComponent(file)}&download=1&name=${encodeURIComponent(name)}`;
    a.download = name;
    a.click();
    closeMenus();
  });
}
wireDownload('dl-rank', 'rank.json', 'rank.json', () => (meta?.kind === 'rli' ? 'task.json' : 'rank.json'));
wireDownload('dl-ledger', 'fix_ledger.json', 'fix_ledger.json');

const chatLog = document.getElementById('chat-log');
const chatText = document.getElementById('chat-text');
const chatStatus = document.getElementById('chat-status');

// ---------- dynamic copilot: static answer vs. guided walkthrough ----------
let copilotMode = localStorage.getItem('cwt_copilot_mode') === 'dynamic' ? 'dynamic' : 'static';
const modeToggle = document.getElementById('copilot-mode');
const chatPanel = document.getElementById('chat-panel');
// A living ambient layer behind the chat — aurora glow in dynamic, calm in static.
const chatAmbient = el('div', { class: 'chat-ambient', 'aria-hidden': 'true' });
chatPanel?.prepend(chatAmbient);
function syncModeToggle() {
  // The redesign's segmented control styles [aria-pressed]; toggling the old
  // .active class left Dynamic looking unselected, so it read as broken.
  modeToggle?.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === copilotMode)));
}
function applyMode() {
  chatPanel?.classList.toggle('mode-dynamic', copilotMode === 'dynamic');
  chatPanel?.classList.toggle('mode-static', copilotMode === 'static');
}
modeToggle?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === copilotMode) return;
  copilotMode = b.dataset.mode;
  localStorage.setItem('cwt_copilot_mode', copilotMode);
  syncModeToggle();
  applyMode();
  chatLog.querySelector('.chat-intro')?.remove();
  refreshChatIntro();
  // one-shot light sweep across the panel to punctuate the switch
  chatPanel?.classList.add('mode-switching');
  setTimeout(() => chatPanel?.classList.remove('mode-switching'), 650);
});
syncModeToggle();
applyMode();

// A guide anchor -> the existing deep-link resolver (mounts the view, scrolls, highlights).
function resolveAnchor(anchor) {
  let m;
  if ((m = anchor.match(/^traj:\/\/(model_[ab])\/(\d+)$/))) return showTrajectory(m[1], Number(m[2]));
  if ((m = anchor.match(/^field:\/\/(\/.+)$/))) return locateRankField(m[1]);
  if ((m = anchor.match(/^spec:\/\/(R\d+)$/))) return showQcSpec(m[1]);
}

// An anchor -> a human "where you're looking" label + a color-coded kind badge.
// Model A=green / Model B=blue match the trajectory viewer; rank.json=purple; rubric=orange.
function anchorMeta(anchor) {
  let m;
  if ((m = anchor.match(/^traj:\/\/(model_[ab])\/(\d+)$/))) {
    const a = m[1] === 'model_a';
    return { kind: a ? 'Model A' : 'Model B', accent: a ? 'var(--green)' : 'var(--blue)', title: `${a ? 'Model A' : 'Model B'} · turn ${m[2]}` };
  }
  if ((m = anchor.match(/^field:\/\/(\/.+)$/))) {
    const segs = m[1].split('/').filter(Boolean);
    return { kind: 'rank.json', accent: 'var(--purple)', title: segs.slice(-2).join(' · ') || 'rank.json field' };
  }
  if ((m = anchor.match(/^spec:\/\/(R\d+)$/))) {
    return { kind: 'QC rubric', accent: 'var(--orange)', title: `Rubric ${m[1]}` };
  }
  return { kind: '', accent: '', title: '' };
}

// Play a validated guide through the existing tour engine: an opening verdict card,
// then one step per anchor — the hole exposes the viewer while onShow scrolls it there.
// The header shows WHAT you're looking at (color-coded), not a redundant step counter.
// The floating copilot: a hovering mailbox that spotlights the evidence and talks you through it
// in a speech bubble. Pre-mapped steps, but you can ask a follow-up at any step and it answers +
// re-plans the steps ahead. Static copilot is untouched — this only runs in dynamic mode.
let activeGuide = null;
function playGuide(guide, originalQuestion = '') {
  if (!guide?.dynamic || !guide.steps?.length) return;
  activeGuide?.close();

  let evidence = guide.steps.map((s) => ({ ...s, ...anchorMeta(s.anchor) }));
  const threads = {};        // idx -> [{who, text}] follow-up Q&A kept per step
  let idx = 0;               // 0 = verdict card; 1..N = evidence[idx-1]
  let busy = false;

  // The walkthrough plays where Acey already lives. Nothing floats over the
  // document: the panel does the talking and the document reacts, which is what
  // makes it read as guided rather than as a popup that happened to appear.
  setChatCollapsed(false);
  const bubble = el('div', { class: 'dg-bubble' });
  const stage = el('div', { class: 'dg-stage' }, bubble);
  chatLog.append(stage);
  stage.scrollIntoView({ block: 'end', behavior: 'smooth' });

  const total = () => evidence.length + 1;
  const curStep = () => (idx === 0
    ? { kind: 'Verdict', accent: 'var(--red)', title: '', text: guide.verdict_line || 'Here’s what I found.', anchor: null }
    : { ...evidence[idx - 1], text: evidence[idx - 1].commentary });

  // resolveAnchor() navigates the document pane to the step's target and the
  // shared .flash ring marks it — so the highlight lands on the thing being
  // discussed, not on a 2px outline around the entire pane like it used to.
  function place() {
    stage.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function close() {
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey);
    stage.remove(); activeGuide = null;
  }
  function onKey(e) {
    if (e.target.closest('.dg-ask')) return;   // typing a follow-up
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') go(idx + 1);
    else if (e.key === 'ArrowLeft') go(idx - 1);
  }

  function go(n) {
    if (n < 0) return;
    if (n >= total()) return close();
    idx = n;
    render();
    const s = curStep();
    if (idx > 0 && s.anchor) { resolveAnchor(s.anchor); setTimeout(place, 60); setTimeout(place, 300); }
    else place();
  }

  async function ask(q) {
    if (!q || busy) return;
    const t = (threads[idx] ||= []);
    t.push({ who: 'you', text: q });
    busy = true; render();
    try {
      await apiSSE(`/task/${bucket}/${taskId}/guide/followup`,
        { question: q, originalQuestion, steps: evidence, stepIndex: Math.max(idx - 1, 0) },
        (m) => {
          if (m.type === 'guide_reply') {
            t.push({ who: 'copilot', text: m.reply });
            if (m.revisedSteps?.length) {
              const keep = evidence.slice(0, idx);   // 0..current evidence step
              evidence = [...keep, ...m.revisedSteps.map((s) => ({ ...s, ...anchorMeta(s.anchor) }))];
            }
          }
          if (m.type === 'error') t.push({ who: 'copilot', text: `(couldn’t answer: ${m.message})` });
        });
    } catch (e) {
      t.push({ who: 'copilot', text: `(couldn’t answer: ${e.message})` });
    }
    busy = false; render();
  }

  function render() {
    const s = curStep();
    stage.style.setProperty('--dg-accent', s.accent || 'var(--blue)');
    const dots = el('div', { class: 'dg-dots' },
      ...Array.from({ length: total() }, (_, i) =>
        el('span', { class: `dg-dot${i === idx ? ' on' : ''}${i < idx ? ' past' : ''}` })));
    const thread = (threads[idx] || []).map((m) =>
      el('div', { class: `dg-turn ${m.who}` }, m.text));

    bubble.replaceChildren(...[
      el('div', { class: 'dg-head' },
        s.kind ? el('span', { class: 'dg-kind' }, s.kind) : el('span', {}),
        dots,
        el('button', { class: 'dg-x', title: 'Exit walkthrough (Esc)', onclick: close }, '✕'),
      ),
      el('div', { class: 'dg-say' }, s.text),
      (idx > 0 && s.title) ? el('button', { class: 'dg-cite', onclick: () => resolveAnchor(s.anchor) },
        `↳ ${s.title}`) : null,
      ...thread,
      busy ? el('div', { class: 'dg-turn copilot thinking' }, 'thinking…') : null,
      el('div', { class: 'dg-foot' },
        el('input', {
          class: 'dg-ask', placeholder: idx === 0 ? 'ask me anything, or hit ▸' : 'ask a follow-up…',
          onkeydown: (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); e.target.value = ''; ask(v); } },
        }),
        el('div', { class: 'dg-nav' },
          idx > 0 ? el('button', { class: 'dg-back', onclick: () => go(idx - 1) }, 'Back') : null,
          el('button', { class: 'primary dg-next', onclick: () => go(idx + 1) },
            idx === 0 ? 'Show me ▸' : (idx >= total() - 1 ? 'Done' : 'Next ▸')),
        ),
      ),
    ].filter(Boolean));
  }

  activeGuide = { close };
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey);
  go(0);
}

function renderGuideBubble(guide, question = '') {
  chatLog.querySelector('.chat-intro')?.remove();
  // This card carried its own layout — a mascot floating inside the bubble and
  // bold body text — so it read as a different component from every other Acey
  // reply. It now uses the same stamp + bubble as the rest of the transcript.
  const body = el('div', { class: 'bubble md' });
  if (guide.dynamic) {
    body.append(
      el('div', { class: 'guide-verdict' }, guide.verdict_line || 'Guided walkthrough'),
      el('button', {
        class: 'guide-replay', type: 'button',
        onclick: () => playGuide(guide, question),
      }, `▶ Replay walkthrough · ${guide.steps.length} step${guide.steps.length === 1 ? '' : 's'}`),
    );
  } else {
    if (guide.verdict_line) body.append(el('div', {}, guide.verdict_line));
    body.append(el('div', { class: 'tool-line' },
      `Not available for dynamic — ${guide.reason || 'no anchored evidence'}. Switch to Static for a written answer.`));
  }
  chatLog.append(el('div', { class: 'chat-msg assistant' }, aceyStamp(), body));
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Empty-state greeting + clickable starter prompts (shown only when the log has
// no messages; removed as soon as one arrives).
const CHAT_SUGGESTIONS = [
  'Give me a rundown of every finding in this task and where each one stands.',
  'Summarize the A ↔ B decision and whether the ranking is defensible.',
  'Verify the annotator\'s rank.json grading against the trajectories.',
  'Were all milestones entered, in order, in both trajectories?',
  'Find the strongest evidence for and against the winning model.',
];

// The 76px bobbing mascot, the hero name card and the aurora behind it are gone:
// Acey's identity is already in the panel header. What is left is the one thing
// that helps — what it can do, and four ways in.
const RLI_SUGGESTIONS = [
  'Walk me through every auto-check fail and tell me which ones are real.',
  'Is AD1’s score defensible? Check the verdicts closest to the 70% gate against the renders.',
  'Which criteria look post-hoc or overfit to one model’s specific flaw?',
  'Does the golden really pass the heaviest criteria? Look at its files.',
  'What would a professional in this domain check that the rubric misses?',
];
function renderChatIntro() {
  const chips = (meta?.kind === 'rli' ? RLI_SUGGESTIONS : CHAT_SUGGESTIONS).map((s) =>
    el('button', {
      type: 'button',
      onclick: () => { chatText.value = s; chatText.focus(); chatText.dispatchEvent(new Event('input')); },
    }, s));
  // The copy used to say "Flip to Dynamic" even while Dynamic was selected.
  const intro = meta?.kind === 'rli'
    ? ['I know the RLI QC spec cold and I can open this task’s renders, drawings and PDFs to check a verdict against what’s actually there. ',
       'Every claim I make links to the ', el('b', {}, 'criterion, file or comparison'), ' it rests on.']
    : copilotMode === 'dynamic'
    ? ['I read both trajectories and cross-check the annotator’s rank.json against what actually ',
       'happened. Ask me anything and I’ll ', el('b', {}, 'walk you through it step by step'),
       ', stopping on each turn, rubric row and rank.json field that matters.']
    : ['I read both trajectories and cross-check the annotator’s rank.json against what actually ',
       'happened, citing exact turns, rubric rows and rank.json fields as clickable links. Flip to ',
       el('b', {}, 'Dynamic'), ' and I’ll walk you through a failure step by step.'];
  return el('div', { class: 'chat-intro' },
    el('img', { class: 'chat-intro-avatar', src: `${window.__base__ || ''}/copilot.png`, alt: '' }),
    el('p', { class: 'acey__intro' }, ...intro),
    el('h3', { class: 'eyebrow', style: 'margin: 20px 0 10px' }, 'Start with'),
    el('div', { class: 'acey__suggest' }, ...chips),
  );
}

// Show the intro when the log has no real messages; hide it otherwise.
function refreshChatIntro() {
  const hasMsg = chatLog.querySelector('.chat-msg, .tool-line');
  const intro = chatLog.querySelector('.chat-intro');
  if (hasMsg) intro?.remove();
  else if (!intro) chatLog.append(renderChatIntro());
  // With only the intro in it, the column centres its content; once there are
  // messages it goes back to a normal top-anchored scroll.
  chatLog.classList.toggle('is-empty', !hasMsg);
}

// Targeted warmth: Acey's replies carry its avatar and a name label, so the
// column reads as someone answering rather than as log output. No glow, no
// bobbing mascot — the personality is in the voice and the presence.
function aceyStamp() {
  return el('div', { class: 'msg-who' },
    el('img', { class: 'msg-avatar', src: `${window.__base__ || ''}/copilot.png`, alt: '' }),
    el('span', {}, 'Acey'));
}

function appendChat(role, content) {
  chatLog.querySelector('.chat-intro')?.remove();
  const bubble = el('div', { class: `bubble${role === 'assistant' ? ' md' : ''}` });
  if (role === 'assistant') bubble.innerHTML = renderMarkdown(content);
  else bubble.textContent = content;
  chatLog.append(
    el('div', { class: `chat-msg ${role}` },
      role === 'user'
        ? el('div', { class: 'who' }, 'reviewer')
        : aceyStamp(),
      bubble,
    )
  );
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendToolLine(text) {
  chatLog.querySelector('.chat-intro')?.remove();
  chatLog.append(el('div', { class: 'tool-line' }, text));
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function loadChat() {
  const history = await api(`/task/${bucket}/${taskId}/chat`);
  chatLog.replaceChildren();
  for (const m of history) {
    if (m.role === 'tools') appendToolLine(`⚙ ${m.tools.join(', ')}`);
    // A past walkthrough comes back as a guide bubble with its Replay button. It is
    // NOT auto-played the way a fresh one is — opening a task shouldn't take over
    // the screen; the reviewer starts the replay.
    else if (m.role === 'guide') renderGuideBubble(m.guide, m.question || '');
    else appendChat(m.role, m.content);
  }
  refreshChatIntro();
}

// ---------- copilot board actions ----------
// A single-task move is already applied when we hear about it, so it renders as a
// result chip with Undo. A bulk move is only a PROPOSAL until the reviewer clicks
// Apply — so it must never be phrased as though it happened.

function undoButton(action) {
  if (!action?.id) return null;
  return el('button', {
    class: 'act-undo',
    onclick: async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = 'undoing…';
      try {
        const r = await api(`/actions/${action.id}/undo`, { method: 'POST' });
        btn.replaceWith(el('span', { class: 'act-undone' },
          `undone${r.skipped?.length ? ` · ${r.skipped.length} skipped (changed since)` : ''}`));
        await refreshState();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Undo';
        btn.title = e.message;
        alert(e.message);
      }
    },
  }, 'Undo');
}

function appendActionChip(summary, action) {
  const chip = el('div', { class: 'act-chip' },
    el('span', { class: 'act-ico' }, '✓'),
    el('span', { class: 'act-text' }, summary),
    undoButton(action));
  chatLog.append(chip);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendActionProposal({ token, plan }) {
  const card = el('div', { class: 'act-card' });
  const actions = el('div', { class: 'act-card-actions' });

  const apply = el('button', {
    class: 'primary',
    onclick: async () => {
      apply.disabled = true;
      cancel.disabled = true;
      apply.textContent = 'applying…';
      try {
        const r = await api('/copilot/action/confirm', { method: 'POST', body: { token } });
        card.classList.add('done');
        mount(card,
          el('div', { class: 'act-chip inline' },
            el('span', { class: 'act-ico' }, '✓'),
            el('span', { class: 'act-text' }, `Moved ${r.moved} task${r.moved === 1 ? '' : 's'} → ${plan.target}`),
            undoButton(r.action)),
          // The plan is re-resolved at confirm time, so the board may have moved
          // between the proposal and the click. Say so rather than hiding it.
          r.drifted
            ? el('div', { class: 'act-card-note warn' }, 'The board changed after the proposal — the count applied differs from what was shown.')
            : null,
        );
        await refreshState();
      } catch (e) {
        apply.disabled = false;
        cancel.disabled = false;
        apply.textContent = `Apply ${plan.counts.change} change${plan.counts.change === 1 ? '' : 's'}`;
        card.append(el('div', { class: 'act-card-note warn' }, e.message));
      }
    },
  }, `Apply ${plan.counts.change} change${plan.counts.change === 1 ? '' : 's'}`);

  const cancel = el('button', {
    class: 'quiet',
    onclick: async () => {
      await api('/copilot/action/cancel', { method: 'POST', body: { token } }).catch(() => {});
      card.classList.add('cancelled');
      card.replaceChildren(el('div', { class: 'act-card-note' }, 'Cancelled — nothing was changed.'));
    },
  }, 'Cancel');

  actions.append(apply, cancel);
  const notes = [];
  if (plan.counts.unchanged) notes.push(`${plan.counts.unchanged} already there`);
  if (plan.counts.missing) notes.push(`${plan.counts.missing} not on the board`);

  mount(card,
    el('div', { class: 'act-card-head' }, 'Confirm bulk move'),
    el('div', { class: 'act-card-sum' }, plan.summary),
    // FULL task ids, not 8-char prefixes: prefixes collide in this data (three
    // different tasks rendered as "6a0b7b88…" in one proposal), and this is the
    // card the reviewer approves a write from — it has to be unambiguous.
    el('div', { class: 'act-sample' },
      ...plan.sample.map((t) => el('span', { class: 'act-sample-id mono', title: `${t.id} · ${t.severity}` },
        `${t.id} · ${t.from}`)),
      plan.counts.change > plan.sample.length
        ? el('span', { class: 'act-sample-more' }, `+${plan.counts.change - plan.sample.length} more`)
        : null),
    notes.length ? el('div', { class: 'act-card-note' }, notes.join(' · ')) : null,
    actions,
  );
  chatLog.append(card);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function handleActionEvent(m) {
  if (m.kind === 'applied') {
    appendActionChip(m.summary, m.action);
    if (m.isCurrentTask) refreshState();
  } else if (m.kind === 'proposal') {
    appendActionProposal(m);
  }
}

async function send() {
  const message = chatText.value.trim();
  if (!message) return;
  chatText.value = '';
  chatText.style.height = '38px';
  await sendMessage(message);
}

function removeContinueBtn() { chatLog.querySelector('.chat-continue')?.remove(); }

// The copilot paused at the per-turn step ceiling — offer to resume with context.
function showContinueBtn() {
  removeContinueBtn();
  chatLog.append(el('button', {
    class: 'chat-continue',
    onclick: () => { removeContinueBtn(); sendMessage('Continue from where you paused — pick up the same task and finish.'); },
  }, 'Copilot paused at the step limit · Continue ▸'));
  chatLog.scrollTop = chatLog.scrollHeight;
}

// One activity row per turn instead of a chat message per tool call. It counts
// repeats and lists the distinct tools, so the work is still visible without
// burying the answer under a dozen ⚙ lines.
let activityRow = null;
const activityTools = new Map();
function resetActivity() { activityRow = null; activityTools.clear(); }
function noteActivity(name) {
  activityTools.set(name, (activityTools.get(name) || 0) + 1);
  const total = [...activityTools.values()].reduce((a, b) => a + b, 0);
  const list = [...activityTools.entries()]
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(' · ');
  if (!activityRow) {
    activityRow = el('div', { class: 'tool-line' });
    chatLog.append(activityRow);
  }
  activityRow.textContent = `⚙ ${total} step${total === 1 ? '' : 's'} · ${list}`;
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendMessage(message) {
  appendChat('user', message);
  resetActivity();
  removeContinueBtn();
  document.getElementById('chat-send').disabled = true;
  chatStatus.textContent = 'thinking…';
  chatStatus.classList.remove('error-line');
  try {
    await apiSSE(`/task/${bucket}/${taskId}/chat`, { message, mode: copilotMode }, (m) => {
      if (m.type === 'tool' && m.name !== 'present_guide') {
        noteActivity(m.name);
        chatStatus.textContent = `running ${m.name}…`;
      }
      if (m.type === 'tool' && m.name === 'present_guide') chatStatus.textContent = 'building walkthrough…';
      // Only the final message is the answer; everything before it is the model
      // narrating its own next step. That reasoning goes to the status line, not
      // the transcript.
      if (m.type === 'assistant') {
        if (m.final) { appendChat('assistant', m.content); chatStatus.textContent = ''; }
        else chatStatus.textContent = m.content.replace(/\s+/g, ' ').slice(0, 90);
      }
      if (m.type === 'guide') { chatStatus.textContent = ''; renderGuideBubble(m.guide, message); if (m.guide.dynamic) playGuide(m.guide, message); }
      if (m.type === 'action') { chatStatus.textContent = ''; handleActionEvent(m); }
      if (m.type === 'truncated') { chatStatus.textContent = ''; showContinueBtn(); }
      if (m.type === 'error') { chatStatus.textContent = m.message; chatStatus.classList.add('error-line'); }
      if (m.type === 'done') chatStatus.textContent = '';
    });
  } catch (e) {
    chatStatus.textContent = e.message;
    chatStatus.classList.add('error-line');
  }
  document.getElementById('chat-send').disabled = false;
}

document.getElementById('chat-send').addEventListener('click', send);
chatText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
// single-line input that grows only when the draft does
chatText.addEventListener('input', () => {
  chatText.style.height = '38px';
  chatText.style.height = Math.min(132, chatText.scrollHeight) + 'px';
});
document.getElementById('clear-chat').addEventListener('click', async () => {
  await api(`/task/${bucket}/${taskId}/chat`, { method: 'DELETE' });
  chatLog.replaceChildren();
  refreshChatIntro();
});

// ---------- claim / decision / severity ----------
// Severity reclassify lives on the badge itself (click → small menu), so the
// header stays uncluttered.
sevChip.addEventListener('click', () => {
  const r = sevChip.getBoundingClientRect();
  const SEVS = [['HARD_FAIL', 'Hard'], ['SOFT_FAIL', 'Soft'], ['PASS', 'Pass'], ['UNSORTED', 'Unsorted']];
  const menu = el('div', { class: 'pop-menu glass' },
    el('div', { class: 'pop-menu-title' }, 'Severity'),
    ...SEVS.map(([k, label]) =>
      el('button', {
        class: k === bucket ? 'current' : '',
        onclick: async () => {
          menu.remove();
          if (k === bucket) return;
          await api(`/task/${bucket}/${taskId}/move`, { method: 'POST', body: { to: k } });
          location.href = `${window.__base__ || ''}/task/${k}/${taskId}`;
        },
      }, label + (k === bucket ? '  ✓' : '')),
    ),
  );
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 6}px`;
  document.body.append(menu);
  const away = (e) => { if (!menu.contains(e.target) && e.target !== sevChip) { menu.remove(); document.removeEventListener('mousedown', away); } };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
});

const claimBtn = document.getElementById('claim-btn');
const claimWho = document.getElementById('claim-who');
const verdictSelect = document.getElementById('verdict-select');
let claimedBy = null;

async function refreshState() {
  const s = await api(`/task/${bucket}/${taskId}/state`);
  claimedBy = s.claimed_by || null;
  const mine = s.claimed_by === me.username;
  // ONE claim control: unclaimed = just the Claim button; claimed = one chip
  // (avatar · name · ×-to-release). The old ghost "Unclaimed" label next to a
  // Claim button next to "Claim on Outlier" was three claim-words in a row.
  if (!s.claimed_by) {
    claimWho.hidden = true;
    claimBtn.hidden = false;
    claimBtn.disabled = false;
    claimBtn.textContent = 'Claim';
    claimBtn.className = 'primary';
  } else {
    const canRelease = mine || me.role === 'admin';
    claimWho.hidden = false;
    claimWho.className = 'claim-who claimed';
    claimWho.replaceChildren(
      avatar(s.claimed_by),
      mine ? 'Yours' : personName(s.claimed_by),
      ...(canRelease ? [el('button', {
        class: 'claim-x',
        title: mine ? 'Release this task' : `Release ${personName(s.claimed_by)}'s claim (admin)`,
        onclick: async () => {
          await api(`/task/${bucket}/${taskId}/release`, { method: 'POST' }).catch((e) => alert(e.message));
          refreshState();
          renderTaskStrip();
        },
      }, '×')] : []),
    );
    claimBtn.hidden = true;
  }
  verdictSelect.value = s.verdict || '';
  verdictSelect.className = 'verdict-select' + (s.verdict ? ` set v-${s.verdict}` : '');
}

claimBtn.addEventListener('click', async () => {
  const action = claimedBy ? 'release' : 'claim';
  try {
    await api(`/task/${bucket}/${taskId}/${action}`, { method: 'POST' });
  } catch (e) {
    alert(e.message);
  }
  refreshState();
  renderTaskStrip(); // queue position updates the moment the claim lands
});

// '' clears the decision; any value sets it
verdictSelect.addEventListener('change', async () => {
  const v = verdictSelect.value || null;
  try {
    await api(`/task/${bucket}/${taskId}/verdict`, { method: 'POST', body: { verdict: v } });
  } catch (e) {
    alert(e.message);
    refreshState(); // put the select back to what the server actually holds
    return;
  }
  refreshState();
  // Second Opinion needs a "why" — jump to the checklist and focus the note box.
  if (v === 'SECOND_OPINION') { focusNoteNext = true; showChecklist(); }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = (window.__base__ || '') + '/login.html';
});

// ---------- guided tour (interactive, on the sandbox task) ----------
function postTourLog(entry) { api('/tour/log', { method: 'POST', body: entry }).catch(() => {}); }
function endTaskTourCleanup() {
  const active = sessionStorage.getItem('cwt_tour_task');
  sessionStorage.removeItem('cwt_tour_task');
  api('/tour/end', { method: 'POST' }).catch(() => {});
  if (active) location.href = (window.__base__ || '') + '/'; // the sandbox we're viewing is gone — go back to the board
}

let copilotBaseline = 0;
function primeCopilot() {
  setChatCollapsed(false);
  copilotBaseline = chatLog.querySelectorAll('.chat-msg.assistant').length;
  if (!chatText.value.trim()) chatText.value = 'Did the winning model really pass all the tests it claims? Verify against the trajectory.';
  chatText.focus();
}
const verifyCopilot = () => chatLog.querySelectorAll('.chat-msg.assistant').length > copilotBaseline;
const verifyDecision = () => !!document.getElementById('verdict-select').value;

const TASK_TOUR = [
  { title: 'Inside a task — your sandbox 🧪', body: 'This is a private sandbox task: claim it, chat, decide, whatever you like — it\'s deleted when the tour ends, so nothing here is real. Everything you audit lives on this one screen.' },
  // The sidebar these steps used to point at (#nav-docs / #nav-trajs) is gone;
  // the tab bar and its Trajectories tab are the current homes.
  { selector: '#tabs', title: 'Documents', body: 'Task definition & milestones, the V11 QC spec, and CB responses — the annotator\'s rank.json in a clean UI (summary, per-dimension grading, failure modes, and the A↔B decision). The generated Review, Remediation, and your Checklist live here too.' },
  { selector: '#tabs button[data-tab="trajectories"]', title: 'Trajectory viewer', body: 'Read Model A or Model B on their own, or Compare A ↔ B side by side to see exactly where the two runs diverge — matching prompts line up, and one-sided turns are clearly called out.' },
  { selector: '#viewer', title: 'Clickable citation "chips"', body: 'Everywhere you read — docs, CB responses, copilot answers — you\'ll see little chips. A traj:// chip jumps to an exact trajectory turn; a spec:// chip opens the QC rubric row that applies; a /rank.json field chip lands you in CB responses. Each one scrolls to the precise spot and highlights it — even a specific quoted phrase inside a response. See one? Click it.' },
  { selector: '#chat-panel', title: 'Meet Acey — try it 🚀', body: 'Ask Acey anything about this task. It reads and searches both trajectories and cross-checks the rank.json, then answers with those same clickable chips so you can verify in one click. I\'ve dropped a starter question in the box — click a suggestion or hit Send, and I\'ll wait for the reply.',
    onShow: primeCopilot, try: { action: 'copilot', hint: 'Waiting for Acey to answer…', verify: verifyCopilot } },
  { selector: '#verdict-select', title: 'Try it: record a decision ✅', body: 'Set a decision for this sandbox task — No Issues / Fixes made / SBQ / Second Opinion. Pick Second Opinion and it\'ll ask for the key issue, which then shows on the board card for the next reviewer.',
    try: { action: 'decision', hint: 'Waiting for you to pick a decision…', verify: verifyDecision } },
  { selector: '#claim-btn', title: 'Claim the task', body: 'Claim it so the team knows you\'re auditing it — your name then shows on the board for everyone. (Feel free to try it.)' },
  { selector: '#sev-chip', title: 'Reclassify severity', body: 'Landed in the wrong bucket? Click here to move the task between Hard / Soft / Pass.' },
  { title: 'You\'re all set 🎉', body: 'That\'s the full flow — board to decision. I\'ll clean up your sandbox now and take you back to the board. Replay anytime from the ✦ Tour button. Happy auditing!' },
];

function runTaskTour() { setChatCollapsed(false); startTour(TASK_TOUR, { onExit: endTaskTourCleanup, onLog: postTourLog }); }

// ✦ Tour on a task page: spin up a fresh sandbox and go audit it there.
async function launchTaskTour() {
  let dummy = null;
  try { dummy = await api('/tour/start', { method: 'POST' }); } catch { /* ignore */ }
  if (dummy) {
    sessionStorage.setItem('cwt_tour_task', JSON.stringify(dummy));
    sessionStorage.setItem('cwt_tour_resume', '1');
    location.href = `${window.__base__ || ''}/task/${dummy.bucket}/${dummy.id}`;
  }
}
document.getElementById('tour-btn')?.addEventListener('click', launchTaskTour);
// best-effort cleanup if they close the tab mid-tour (not while navigating to resume)
window.addEventListener('beforeunload', () => {
  if (sessionStorage.getItem('cwt_tour_task') && !sessionStorage.getItem('cwt_tour_resume')) navigator.sendBeacon?.(`${window.__base__ || ''}/api/tour/end`);
});

// Acey is a fixed 348px column, but it still collapses — reviewers wanted the
// full width back for reading trajectories. Collapsed, it becomes the same
// round mascot every page keeps fixed bottom-right (one access point, one
// corner, everywhere — user decision 2026-08-08), and ⌘K/Ctrl+K toggles it,
// same as everywhere else. The launcher hides while the panel is open, since
// the panel's own ✕ lives in its header. Choice persists per browser.
const workspaceEl = document.querySelector('.workspace');
const showAceyBtn = document.getElementById('show-acey');

function setChatCollapsed(collapsed) {
  workspaceEl.classList.toggle('acey-collapsed', collapsed);
  showAceyBtn.hidden = !collapsed;
  try { localStorage.setItem('cwt_chat_collapsed', collapsed ? '1' : ''); } catch { /* private mode */ }
}
// Kept as a name the tour and suggestion chips already call.
function openCopilotWithFlair() { setChatCollapsed(false); }

document.getElementById('collapse-chat').addEventListener('click', () => setChatCollapsed(true));
showAceyBtn.addEventListener('click', () => setChatCollapsed(false));
setChatCollapsed(!!localStorage.getItem('cwt_chat_collapsed'));

// The shortcut the rest of the app already answers to. Esc is not claimed —
// the task page's dialogs and the guide player already own it.
if (!/Mac|iP(hone|ad|od)/.test(navigator.platform || '')) {
  showAceyBtn.title = 'Ask Acey (Ctrl+K)';
}
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    setChatCollapsed(!workspaceEl.classList.contains('acey-collapsed'));
  }
});

// Drag the panel's left edge to resize. Width persists; below MIN it collapses
// to the mascot rather than becoming a useless sliver.
const MIN_ACEY = 300, MAX_ACEY = 760, COLLAPSE_AT = 220;
const aceyPanel = document.getElementById('chat-panel');
function setAceyWidth(px) {
  const w = Math.min(MAX_ACEY, Math.max(MIN_ACEY, px));
  aceyPanel.style.width = `${w}px`;
  try { localStorage.setItem('cwt_chat_w', String(w)); } catch { /* private mode */ }
}
const savedAceyW = Number(localStorage.getItem('cwt_chat_w'));
if (savedAceyW) setAceyWidth(savedAceyW);

const aceyGrip = el('div', { class: 'acey__grip', title: 'Drag to resize' });
aceyPanel.prepend(aceyGrip);
aceyGrip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  aceyGrip.setPointerCapture(e.pointerId);
  aceyGrip.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  const onMove = (ev) => {
    const w = window.innerWidth - ev.clientX;
    if (w < COLLAPSE_AT) { setChatCollapsed(true); onUp(); return; }
    setAceyWidth(w);
  };
  const onUp = () => {
    aceyGrip.classList.remove('dragging');
    document.body.style.cursor = '';
    aceyGrip.removeEventListener('pointermove', onMove);
    aceyGrip.removeEventListener('pointerup', onUp);
  };
  aceyGrip.addEventListener('pointermove', onMove);
  aceyGrip.addEventListener('pointerup', onUp);
});


// ---------- boot ----------
const me = await api('/me'); // 401 redirects to login
document.getElementById('user-chip').hidden = false;
document.getElementById('user-name').textContent = personName(me.username);
const uAvatar = document.getElementById('user-avatar');
if (uAvatar) uAvatar.replaceWith(avatar(me.username, { cls: 'avatar--photo-slot' }));
if (me.role === 'admin') {
  const del = document.getElementById('delete-task');
  del.hidden = false;
  del.addEventListener('click', async () => {
    if (!confirm(`Delete task ${taskId} from the board? This removes its files, claim, decision, and generated docs.`)) return;
    await api(`/task/${bucket}/${taskId}`, { method: 'DELETE' });
    location.href = (window.__base__ || '') + '/';
  });
}
await refreshState();
setInterval(refreshState, 10_000);
await buildSidebar();
const params = new URLSearchParams(location.search);
if (params.get('traj')) {
  showTrajectory(params.get('traj'), params.has('msg') ? Number(params.get('msg')) : null);
} else if (meta?.kind === 'rli') {
  openTab(params.get('tab') || 'brief');
} else if (hasReview) {
  openTab('review');
} else {
  openTab('definition');
}
await loadChat();

// Continue the single tour that started on the board (it opened this sandbox task).
if (sessionStorage.getItem('cwt_tour_resume')) {
  sessionStorage.removeItem('cwt_tour_resume');
  runTaskTour();
}
