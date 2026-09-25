import { api, el, mount, cap, startTour, renderAppHeader, avatar, personName } from './common.js';
import { mountAcey } from './acey.js';

const ORDER = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];
const VERDICT_LABELS = {
  NO_ISSUES: 'No Issues',
  FIXES_MADE: 'Fixes made',
  GRAMMAR_ONLY: 'Grammar-only',
  SBQ: 'SBQ',
  SECOND_OPINION: 'Second Opinion Needed',
};
const SEV_LABEL = { HARD_FAIL: 'Fail', SOFT_FAIL: 'Non-fail', PASS: 'No issues', UNSORTED: 'Unsorted' };
// Severity is the only thing colour means on a board card. Unsorted has no colour:
// it is an absence of a verdict, not a fourth status.
const SEV_TAG = { HARD_FAIL: 'tag--hard', SOFT_FAIL: 'tag--soft', PASS: 'tag--pass', UNSORTED: '' };
// Verdicts are states, not categories — a three-step ramp, nothing else.
const VERDICT_STATE = {
  NO_ISSUES: 'is-ok', FIXES_MADE: 'is-ok', GRAMMAR_ONLY: 'is-ok',
  SECOND_OPINION: 'is-warn', SBQ: 'is-fail',
};
// Workflow lanes — derived from claim + decision state. A decision marks a
// ticket "seen" (Resolved), except Second Opinion which stays in its own lane.
const RESOLVED_VERDICTS = new Set(['NO_ISSUES', 'FIXES_MADE', 'GRAMMAR_ONLY', 'SBQ']);
const LANES = [
  { key: 'OPEN', name: 'Open', hint: 'Unclaimed, no decision yet.' },
  { key: 'REVIEW', name: 'In review', hint: 'Claimed and being audited.' },
  { key: 'SECOND_OPINION', name: 'Needs 2nd opinion', hint: 'Flagged for another reviewer.' },
  {
    key: 'STAGING',
    name: 'Staging',
    hint: 'Fix sign-off and backfill. Tasks arrive here when the batch brought fixes to decide; they leave for Resolved through the backfill check.',
  },
  { key: 'RESOLVED', name: 'Resolved', hint: 'A decision has been recorded.' },
];

// Staging sits ahead of the claim check on purpose: fix sign-off happens in
// bulk there, so claiming a task doesn't pull it out. Recording a verdict does.
function laneOf(t) {
  if (t.verdict === 'SECOND_OPINION') return 'SECOND_OPINION';
  if (t.verdict && RESOLVED_VERDICTS.has(t.verdict)) return 'RESOLVED';
  if (t.inStagingLane) return 'STAGING';
  if (t.claimedBy) return 'REVIEW';
  return 'OPEN';
}

// Assignee avatar: a colored initial (deterministic per name) + the name.
// Unclaimed shows a dashed placeholder.
// Claim straight from the board without opening the task (opening = view only).
// stopPropagation/preventDefault so the click doesn't follow the card link.
function claimAction(t) {
  return el('button', {
    class: 'link', type: 'button', title: 'assign this task to you',
    onclick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { await api(`/task/${t.bucket}/${t.id}/claim`, { method: 'POST' }); }
      catch (err) { toast(err.message); }
      load();
    },
  }, 'Claim');
}

function assignee(name) {
  if (!name) return el('span', { class: 'card__owner' }, 'Unassigned');
  return el('span', { class: 'card__owner' },
    avatar(name, { cls: 'avatar--sm' }),
    personName(name),
  );
}

// ---------- drag-and-drop between lanes = workflow transition ----------
let dragging = null;

async function applyLaneChange(t, target, x, y) {
  const { bucket, id } = t;
  const from = laneOf(t);
  if (from === target) return;
  // Decide the resulting state first (RESOLVED asks which decision).
  let verdict = null, claim = null;
  if (target === 'SECOND_OPINION') verdict = 'SECOND_OPINION';
  else if (target === 'RESOLVED') { verdict = await pickResolution(x, y); if (!verdict) return; }
  else if (target === 'REVIEW') { verdict = null; claim = 'Claim'; }
  else if (target === 'OPEN') { verdict = null; claim = t.claimedBy ? 'Release' : null; }

  // Optimistically update the card in place + render once — no full refetch, no flash/jump.
  // The server derives the same state from the target lane; this is just the preview.
  const orig = (currentWs[bucket] || []).find((x2) => x2.id === id);
  if (orig) {
    orig.verdict = verdict;
    if (claim === 'Claim') orig.claimedBy = me?.username || orig.claimedBy;
    if (claim === 'Release') orig.claimedBy = null;
    if (target === 'STAGING') { orig.grammarLane = 'in'; orig.inStagingLane = true; }
    else if (from === 'STAGING') { orig.grammarLane = 'out'; orig.inStagingLane = false; }
  }
  render();

  // One journaled call: the server works out verdict + claim + grammar override
  // from the destination lane, so the drag is a single undoable action.
  try {
    const r = await api(`/task/${bucket}/${id}/lane`, { method: 'POST', body: { lane: target, verdict } });
    refreshBulkCount();
    refreshActions();
    if (r.action) toast(`Moved to ${LANES.find((l) => l.key === target)?.name || target}.`, { label: 'Undo', run: () => undo(r.action.id) });
  } catch (e) {
    toast(e.message);
    await load();
  }
}

// The Staging lane's exit: run the backfill check across every task in the
// lane, show what is confirmed and what is blocked (and why), then move the
// confirmed set to Resolved and hand over the id list for the platform-side
// L12 move. Flow per Pavit, 2026-08-10.
async function runBackfillCheck() {
  const overlay = el('div', { class: 'bf-overlay' });
  const box = el('div', { class: 'bf glass' },
    el('div', { class: 'bf__head' }, el('b', {}, 'Backfill check'),
      el('button', { class: 'btn btn--ghost', onclick: () => overlay.remove() }, 'Close')),
    el('div', { class: 'bf__body' }, el('p', { class: 'bf__note' }, 'Checking readiness and upstream SBQ…')));
  overlay.append(box);
  document.body.append(overlay);

  let r;
  try {
    r = await api('/staging/verify?fresh=1');
  } catch (e) {
    box.querySelector('.bf__body').replaceChildren(el('p', { class: 'bf__note bf__note--warn' }, `Check failed — ${e.message}`));
    return;
  }

  const ready = r.items.filter((i) => i.ready);
  const blocked = r.items.filter((i) => !i.ready);
  const matchChip = (m) => {
    if (!m || m.status === 'NOT_FOUND') return el('span', { class: 'bf__match dim', title: 'No label row on platform yet' }, '—');
    if (m.status === 'MATCH') return el('span', { class: 'bf__match is-ok', title: 'Preference + winner match platform' }, '✓ platform');
    if (m.status === 'MISMATCH') {
      const detail = (m.fields || []).filter((f) => !f.match)
        .map((f) => `${f.field}: board ${f.board} vs platform ${f.platform}`).join('; ');
      return el('span', { class: 'bf__match is-bad', title: detail }, '✗ platform');
    }
    // Not a failure: the backfill was retrieved <30 min ago and platform hasn't
    // caught up yet.
    if (m.status === 'PENDING') {
      const until = m.pending_until ? ` — check again after ${m.pending_until.slice(11, 16)}Z` : '';
      return el('span', { class: 'bf__match is-warn', title: `Backfill retrieved less than 30 min ago; platform propagation pending${until}` }, '⏳ pending propagation');
    }
    return el('span', { class: 'bf__match dim', title: m.status }, '—');
  };
  const row = (i) => {
    const warns = i.warningDetails || [];
    const main = el('div', { class: `bf__row${i.ready ? '' : ' bf__row--blocked'}${warns.length ? ' bf__row--x' : ''}` },
      el('span', { class: `bf__dot${i.ready ? ' is-ok' : ''}` }),
      el('a', { class: 'mono bf__id', href: `${window.__base__ || ''}/task/${i.bucket}/${i.id}` }, i.id),
      i.upstream ? el('span', { class: 'bf__lvl' }, `L${i.upstream.level} · ${i.upstream.status}`) : el('span', { class: 'bf__lvl dim' }, 'no pipeline row'),
      matchChip(i.labelMatch),
      el('span', { class: 'bf__why' }, i.ready ? (i.grammarOnly ? 'ready · grammar-only' : 'ready') : i.blockers.join(' · '),
        warns.length ? el('span', { class: 'bf__expand', 'aria-hidden': 'true' }, ' ▾') : null));
    if (!warns.length) return main;
    // The warning COUNT was a dead end — click the row to see what the
    // validator actually objects to, without leaving the popup.
    const details = el('div', { class: 'bf__warns', hidden: 'hidden' },
      ...warns.map((w) => el('div', { class: 'bf__warn' }, el('code', {}, w.check), ` — ${w.detail}`)));
    main.title = 'Click to show the validation warnings';
    main.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // the task link still navigates
      details.hidden = !details.hidden;
      main.querySelector('.bf__expand').textContent = details.hidden ? ' ▾' : ' ▴';
    });
    return el('div', { class: 'bf__rowwrap' }, main, details);
  };

  const body = box.querySelector('.bf__body');
  body.replaceChildren(
    el('p', { class: 'bf__note' },
      `${r.items.length} in Staging — ${ready.length} confirmed, ${blocked.length} blocked.`
      + (r.redash ? '' : ' Redash was unreachable, so SBQ is unverified — board checks only.')),
    ...ready.map(row), ...blocked.map(row),
    el('p', { class: 'bf__note' },
      'Platform match covers preference + winner; prose fields land via the backfill JSON and are verified by the eval reconciler.'),
    el('div', { class: 'bf__actions' },
      el('button', {
        class: 'btn',
        title: 'The wire-format JSON — original upload shape, board-edited values — for the platform backfill',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const out = await api('/staging/backfill');
            const blob = new Blob([JSON.stringify(out.rows, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `backfill_${new Date().toISOString().slice(0, 10)}_${out.manifest.tasks}tasks.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            e.target.textContent = `Retrieved ${out.manifest.tasks} rows (${out.manifest.excluded.length} excluded)`;
          } catch (err) { e.target.disabled = false; toast(err.message); }
        },
      }, 'Retrieve backfills'),
      el('button', {
        class: 'btn',
        onclick: async (e) => {
          const ids = ready.map((i) => i.id).join('\n');
          try { await navigator.clipboard.writeText(ids); e.target.textContent = `Copied ${ready.length} ids`; }
          catch { prompt('Task ids — copy for the platform L12 move:', ids); }
        },
      }, 'Copy task IDs'),
      el('button', {
        class: 'btn btn--primary',
        disabled: ready.length ? undefined : 'disabled',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const out = await api('/staging/resolve', { method: 'POST', body: { ids: ready.map((i) => i.id) } });
            overlay.remove();
            await load();
            toast(`Moved ${out.moved.length} confirmed task${out.moved.length === 1 ? '' : 's'} to Resolved.`
              + (out.skipped.length ? ` ${out.skipped.length} skipped.` : ''));
          } catch (err) { e.target.disabled = false; toast(err.message); }
        },
      }, `Move ${ready.length} confirmed to Resolved`)));
}

// The Resolved lane's check: the §7.2 quadrant reconciliation — board SBQ vs
// Redash SBQ vs L12 membership — as a 2×2 of counts plus the exception rows
// (must_pull red, backfill_missing amber, pending neutral). Same overlay
// pattern as the backfill check; the count for delivered (archived) tasks is
// included even while they're hidden from the board.
async function runReconciliation() {
  const overlay = el('div', { class: 'bf-overlay' });
  const body = el('div', { class: 'bf__body' });
  const box = el('div', { class: 'bf glass' },
    el('div', { class: 'bf__head' }, el('b', {}, 'Reconciliation — Resolved vs Redash'),
      el('button', { class: 'btn btn--ghost', onclick: () => overlay.remove() }, 'Close')),
    body);
  overlay.append(box);
  document.body.append(overlay);

  const fill = async (fresh) => {
    body.replaceChildren(el('p', { class: 'bf__note' }, 'Comparing Resolved against Redash SBQ + L12…'));
    let r;
    try { r = await api(`/staging/quadrants${fresh ? '?fresh=1' : ''}`); }
    catch (e) { body.replaceChildren(el('p', { class: 'bf__note bf__note--warn' }, `Check failed — ${e.message}`)); return; }
    if (!r.redash) {
      body.replaceChildren(el('p', { class: 'bf__note bf__note--warn' },
        `Redash unavailable — ${r.error || 'not configured'}. The quadrant check needs the warehouse.`));
      return;
    }

    const c = r.counts;
    const cell = (n, label, cls) => el('div', { class: `rq__cell${n ? ` ${cls}` : ''}` }, el('b', {}, String(n)), label);
    const grid = el('div', { class: 'rq' },
      el('span', { class: 'rq__hdr' }, ''),
      el('span', { class: 'rq__hdr' }, 'Redash: SBQ'),
      el('span', { class: 'rq__hdr' }, 'Redash: non-SBQ'),
      el('span', { class: 'rq__hdr', title: 'A live L12 node (pending or completed) — a canceled L12 node counts as pulled, not present' }, 'In L12 (live)'),
      cell(c.must_pull, 'must be pulled', 'is-bad'),
      cell(c.ok_in_l12, 'correct', 'is-ok'),
      el('span', { class: 'rq__hdr' }, 'Not in L12'),
      cell(c.ok_out, 'correct', 'is-ok'),
      cell(c.backfill_missing, 'backfill missing', 'is-warn'),
    );

    // Exceptions only — the two ✓ quadrants are counts, not homework.
    const ORDER_Q = { must_pull: 0, backfill_missing: 1, pending: 2 };
    const exceptions = r.items
      .filter((i) => i.quadrant in ORDER_Q)
      .sort((a, b) => ORDER_Q[a.quadrant] - ORDER_Q[b.quadrant] || a.id.localeCompare(b.id));
    const DOT = { must_pull: ' is-bad', backfill_missing: '', pending: ' dim' };
    const WHY = {
      must_pull: (i) => `open SBQ${i.sbqAwaitingConfirmation ? ' (board-marked, awaiting Redash)' : ''} — pull out of L12`,
      // A canceled L12 node is the usual reason a task is "not in L12" — say
      // so, instead of implying the backfill vanished.
      backfill_missing: (i) => (i.note ? `non-SBQ — ${i.note}; lands back in L12 with the next backfill` : 'non-SBQ, not in L12 — backfill missing')
        + (i.backfilledAt ? ` (stamped ${i.backfilledAt.slice(0, 16).replace('T', ' ')})` : ''),
      pending: (i) => `backfilled ${i.backfilledAt.slice(11, 16)}Z — propagation pending`,
    };
    const row = (i) => el('div', { class: 'bf__row' },
      el('span', { class: `bf__dot${DOT[i.quadrant]}` }),
      el('a', { class: 'mono bf__id', href: `${window.__base__ || ''}/task/${i.severity}/${i.id}` }, i.id),
      i.upstream ? el('span', { class: 'bf__lvl' }, `L${i.upstream.level} · ${i.upstream.status}`) : el('span', { class: 'bf__lvl dim' }, 'no pipeline row'),
      i.delivered ? el('span', { class: 'bf__lvl dim' }, 'archived') : null,
      el('span', { class: 'bf__why' }, WHY[i.quadrant](i)));

    body.replaceChildren(
      el('p', { class: 'bf__note' },
        `${r.items.length} in Resolved — ${c.ok_in_l12 + c.ok_out} reconciled, ${c.must_pull} to pull, ${c.backfill_missing} missing, ${c.pending} pending.`),
      grid,
      exceptions.length
        ? null
        : el('p', { class: 'bf__note' }, 'No exceptions — every Resolved task reconciles.'),
      ...exceptions.map(row),
      el('div', { class: 'bf__actions' },
        el('button', {
          class: 'btn',
          title: 'Bypass the 5-minute Redash cache and re-run the queries',
          onclick: (e) => { e.target.disabled = true; fill(true); },
        }, 'Refresh from Redash')));
  };
  fill(false);
}

// Resolved is a 3-way decision — ask which one at the drop point.
function pickResolution(x, y) {
  return new Promise((resolve) => {
    const choose = (v) => { cleanup(); resolve(v); };
    const menu = el('div', { class: 'drop-menu glass' },
      el('div', { class: 'drop-menu-title' }, 'Mark resolved as'),
      el('button', { onclick: () => choose('NO_ISSUES') }, 'No Issues'),
      el('button', { onclick: () => choose('FIXES_MADE') }, 'Fixes made'),
      el('button', { onclick: () => choose('GRAMMAR_ONLY') }, 'Grammar-only'),
      el('button', { onclick: () => choose('SBQ') }, 'SBQ'),
      el('button', { class: 'cancel', onclick: () => choose(null) }, 'Cancel'),
    );
    menu.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;
    document.body.append(menu);
    const onAway = (e) => { if (!menu.contains(e.target)) choose(null); };
    function cleanup() { menu.remove(); document.removeEventListener('mousedown', onAway); }
    setTimeout(() => document.addEventListener('mousedown', onAway), 0);
  });
}

let toastTimer;
// action: optional { label, run } — renders an inline button (used for Undo), and
// holds the toast open longer so there's time to reach it.
function toast(msg, action = null) {
  let t = document.getElementById('toast');
  if (!t) { t = el('div', { id: 'toast', class: 'toast' }); document.body.append(t); }
  mount(t,
    el('span', {}, msg),
    action
      ? el('button', {
        class: 'toast-action',
        onclick: () => { t.classList.remove('show'); action.run(); },
      }, action.label)
      : null,
  );
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 9000 : 3200);
}

let me = null;
let currentWs = {};
let sevFilter = 'ALL';
// "My queue" is orthogonal to severity — a toggle that composes with the
// severity pick and the search. Persisted: a reviewer working their queue
// should not have to re-arm the filter on every reload.
let mineOnly = localStorage.getItem('cwt_mine_only') === '1';
let showDelivered = false; // delivered tasks are soft-archived: hidden from the board for everyone
const searchInput = document.getElementById('task-search');

async function boot() {
  me = await api('/me'); // 401 redirects to login
  // One header implementation across every page — the board included, so the
  // two can't drift apart again.
  renderAppHeader({
    active: 'board', user: me,
    extras: [el('button', { class: 'btn btn--ghost', type: 'button', id: 'tour-btn' }, 'Take a tour')],
  });
  document.getElementById('tour-btn').addEventListener('click', startBoardTour);
  document.getElementById('clear-board').hidden = me.role !== 'admin';
  document.getElementById('gen-all').hidden = me.role !== 'admin';
  if (me.role === 'admin') pollGenStatus(); // reflect any in-flight batch on load
  const q = new URLSearchParams(location.search).get('q');
  if (q) searchInput.value = q;
  await load();
  setInterval(load, 8000); // live claim/verdict status from other reviewers
}

let loadInflight = null; // back-to-back callers (focus + visibilitychange, the poll) share one fetch
let loadSeq = 0;

function load() {
  if (loadInflight) return loadInflight;
  // Stamp at request start, not response, so a second focus event that fires
  // while the fetch is in flight already sees a fresh timestamp.
  lastLoadedAt = Date.now();
  const seq = ++loadSeq;
  loadInflight = (async () => {
    try {
      const ws = await api('/workspace');
      if (seq !== loadSeq) return; // a newer load finished first — don't overwrite its render
      currentWs = ws;
      render();
      loadLayers();
    } finally {
      loadInflight = null;
    }
  })();
  return loadInflight;
}

// A board tab left open holds the workspace from whenever it last acted. The
// downloads are server-generated and always fresh, but the LANES ON SCREEN are
// not — and a person reading a stale board makes stale calls. Refresh whenever
// the tab comes back into focus, debounced so tab-flipping doesn't hammer the
// server.
let lastLoadedAt = 0;
const FOCUS_REFRESH_MS = 15_000;
async function refreshIfStale() {
  if (document.hidden || Date.now() - lastLoadedAt < FOCUS_REFRESH_MS) return;
  try { await load(); } catch { /* next focus retries */ }
}
window.addEventListener('focus', refreshIfStale);
document.addEventListener('visibilitychange', refreshIfStale);

// The Redash-observed layer for every task, as a tag on the card (§7.1) — so
// SBQ and pipeline position are facts on the board, not guesses. Batched and
// served from a 5-minute cache; re-render happens when the answer arrives.
let upstreamLayers = {};
let upstreamBackfill = {};
let layersLoaded = false;
async function loadLayers() {
  if (layersLoaded) return;
  layersLoaded = true;
  try {
    const r = await api('/staging/layers');
    upstreamLayers = r.layers || {};
    upstreamBackfill = r.backfill || {};
    if (Object.keys(upstreamLayers).length || Object.keys(upstreamBackfill).length) render();
  } catch { /* the tag is an extra, never a blocker */ }
}

// The backfilled tag: which cards were backfilled, and whether the board's
// "fixed" label matches what Redash returns for them. Unknown match (Redash
// down, no label row yet) keeps the plain muted tag — never a false ✗.
function backfillTag(id) {
  const b = upstreamBackfill[id];
  if (!b) return null;
  const when = (b.retrievedAt || b.backfilledAt || '').slice(0, 16).replace('T', ' ');
  const m = b.match;
  if (m?.status === 'MATCH') {
    return el('span', { class: 'tag tag--backfill is-ok', title: `Backfilled ${when} — preference + winner match platform` }, 'backfilled ✓');
  }
  if (m?.status === 'MISMATCH') {
    const detail = (m.fields || []).filter((f) => !f.match)
      .map((f) => `${f.field}: board ${f.board} vs platform ${f.platform}`).join('; ');
    return el('span', { class: 'tag tag--backfill is-bad', title: `Backfilled ${when} — ${detail}` }, 'backfilled ✗');
  }
  if (m?.status === 'PENDING') {
    const until = m.pending_until ? ` until ${m.pending_until.slice(11, 16)}Z` : '';
    return el('span', { class: 'tag tag--backfill is-warn', title: `Backfilled ${when} — platform propagation pending${until}` }, 'backfilled ⏳');
  }
  return el('span', { class: 'tag tag--backfill', title: `Backfilled ${when} — platform match unknown (no label row yet)` }, 'backfilled');
}

// Flatten the workspace into tickets carrying their bucket (= severity).
function allTickets() {
  const out = [];
  for (const bucket of ORDER) for (const t of currentWs[bucket] || []) out.push({ ...t, bucket });
  return out;
}

// RLI cards: domain, the three rubric scores against their gates, and which
// automated spec checks already fail — the triage signal before anyone opens it.
function rliCardBits(r) {
  const sc = (lbl, v, bad) => el('span', { class: `rli-cs${bad ? ' is-bad' : ''}` }, el('i', {}, lbl), v == null ? '—' : `${Math.round(v)}%`);
  return el('div', { class: 'rli-card' },
    el('div', { class: 'rli-card__row' },
      el('span', { class: 'tag tag--quiet' }, r.domain || '—'),
      el('span', { class: 'spacer' }),
      sc('RD', r.scores.golden, r.scores.golden != null && r.scores.golden < 97),
      sc('AD1', r.scores.ad1, r.scores.ad1 != null && r.scores.ad1 > 70),
      sc('AD2', r.scores.ad2, r.scores.ad2 != null && r.scores.ad2 > 50)),
    r.checks.fail || r.incomplete
      ? el('div', { class: 'rli-card__fails' }, r.checks.failing.map((f) => el('span', { class: 'rli-card__fail' }, f.replace(/\s*\(.*\)$/, ''))))
      : el('div', { class: 'rli-card__ok' }, r.checks.warn ? `Auto-checks clear · ${r.checks.warn} to check` : 'Auto-checks clear'),
  );
}

function ticketCard(t) {
  const lane = laneOf(t);
  const card = el('a', {
    class: `card${lane === 'RESOLVED' ? ' card--resolved' : ''}${t.tour ? ' card--tour' : ''}`,
    href: `${window.__base__ || ''}/task/${t.bucket}/${t.id}`,
    draggable: 'true',
    ondragstart: (e) => {
      dragging = t;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.id); // Firefox needs data set
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => { dragging = null; e.currentTarget.classList.remove('dragging'); },
  },
    el('div', { class: 'card__top' },
      // Severity is a tag, never a coloured left edge on the card.
      el('span', { class: `tag ${SEV_TAG[t.bucket] || ''}` }, SEV_LABEL[t.bucket]),
      upstreamLayers[t.id]
        ? el('span', {
          class: `tag tag--layer${upstreamLayers[t.id].level === '12' ? ' tag--layer-l12' : ''}`,
          title: `Redash: L${upstreamLayers[t.id].level} · ${upstreamLayers[t.id].status}`,
        }, `L${upstreamLayers[t.id].level}`)
        : null,
      backfillTag(t.id),
      t.tour ? el('span', { class: 'tag', title: 'temporary tour sandbox — deleted when the tour ends' }, 'sandbox') : null,
      t.delivered ? el('span', { class: 'tag', title: `delivered${t.deliveredAt ? ' ' + t.deliveredAt.slice(0, 10) : ''}` }, 'archived') : null,
      el('span', { class: 'spacer' }),
      // Verdicts are states, not categories: settled → ok, unsettled → warn, rejected → fail.
      t.verdict
        ? el('span', { class: `card__verdict ${VERDICT_STATE[t.verdict] || ''}` },
          el('span', { class: 'dot', style: 'background: currentColor' }),
          VERDICT_LABELS[t.verdict] || t.verdict)
        : null,
    ),
    el('div', { class: 'card__id' }, t.id),
    t.problem ? el('div', { class: 'card__problem' }, t.problem) : null,
    t.kind === 'rli' && t.rli ? rliCardBits(t.rli) : null,
    lane === 'SECOND_OPINION' && t.verdictNote
      ? el('div', { class: 'card__why', title: t.verdictNote }, el('b', {}, 'Why · '), t.verdictNote)
      : null,
    el('div', { class: 'card__foot' },
      t.claimedBy ? assignee(t.claimedBy) : claimAction(t),
      el('span', { class: 'spacer' }),
      // Neutral by design so it never competes with the severity tag.
      t.grammar || t.audit?.tags?.includes('grammar-fixed')
        ? el('span', {
          class: 'tag tag--grammar',
          title: t.audit?.tags?.includes('grammar-fixed')
            ? `Grammar fixed by the eval — as-delivered band ${t.audit.writing_band_as_delivered || '?'}, ${t.audit.grammar_fixes_applied || 0} edit(s)`
            : t.grammarOnly
            ? `Spelling / grammar is the only fail (${(t.qcDims || []).join(', ')}) — auto-routed to Grammar fixes`
            : `Spelling / grammar flagged, but not the only fail — also ${(t.otherDims || []).join(', ')}`,
        }, el('span', { 'aria-hidden': 'true' }, '✎'), 'Grammar')
        : null,
    ),
  );
  if (t.tour) card.id = 'tour-dummy-card';
  return card;
}

function render() {
  const q = searchInput.value.trim().toLowerCase();
  const all = allTickets().filter((t) =>
    (!t.tour || t.tourOwner === me?.username) && // sandbox tasks show only to their owner
    (showDelivered || !t.delivered));
  const tickets = all.filter((t) =>
    (sevFilter === 'ALL' || t.bucket === sevFilter) &&
    (!mineOnly || t.claimedBy === me?.username) &&
    (!q || t.id.toLowerCase().includes(q) || (t.problem || '').toLowerCase().includes(q))
  );
  updateDeliveredToggle();
  updateArchiveBtn();

  // Queue controls live off the UNFILTERED view: the pill count must not
  // change when a severity chip is picked, and Claim next needs to know if
  // there is anything left to grab at all.
  const myCount = all.filter((t) => t.claimedBy === me?.username).length;
  mineFilterBtn.textContent = `My queue · ${myCount}`;
  const unclaimedOpen = all.some((t) => laneOf(t) === 'OPEN' && !t.claimedBy);
  const claimNextBtn = document.getElementById('claim-next');
  claimNextBtn.disabled = !unclaimedOpen;
  claimNextBtn.title = unclaimedOpen
    ? 'Claim the oldest unclaimed Open task and go straight to it'
    : 'Nothing unclaimed in Open right now';

  const byLane = new Map(LANES.map((l) => [l.key, []]));
  for (const t of tickets) byLane.get(laneOf(t)).push(t);

  const root = document.getElementById('lanes');
  // Preserve each lane's scroll position across the 8s auto-refresh, so scrolling
  // into a lane doesn't snap back to the top.
  const prevScroll = {};
  root.querySelectorAll('.lane').forEach((l) => {
    const k = l.dataset.lane;
    const b = l.querySelector('.lane__list');
    if (k && b) prevScroll[k] = b.scrollTop;
  });

  root.replaceChildren(
    ...LANES.map((lane) => {
      const items = byLane.get(lane.key);
      const pendingFixes = lane.key === 'STAGING' ? items.reduce((a, t) => a + (t.pendingFixes || 0), 0) : 0;
      return el('section', {
        class: 'lane',
        'data-lane': lane.key,
        ondragover: (e) => {
          if (!dragging || laneOf(dragging) === lane.key) return;
          e.preventDefault();
          e.currentTarget.classList.add('lane--drop');
        },
        ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('lane--drop'); },
        ondrop: (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('lane--drop');
          if (dragging) applyLaneChange(dragging, lane.key, e.clientX, e.clientY);
        },
      },
        el('div', { class: 'lane__head' },
          el('span', { class: 'lane__name' }, lane.name),
          el('span', { class: 'lane__count' }, String(items.length)),
        ),
        // What is left to decide, at a glance.
        lane.key === 'STAGING' && items.length
          ? el('div', { class: 'lane__note' },
            pendingFixes
              ? `${pendingFixes} fix${pendingFixes === 1 ? '' : 'es'} awaiting a decision`
              : 'All fixes decided — run the backfill check')
          : null,
        items.length
          ? el('div', { class: 'lane__list' }, items.map(ticketCard))
          : el('div', { class: 'lane__empty' },
            // An empty queue is a starting point, not a failed search.
            mineOnly && myCount === 0
              ? 'Nothing claimed yet — Claim on any card, or hit ⚡ Claim next.'
              : q || sevFilter !== 'ALL' || mineOnly ? 'No match.' : lane.hint),
        // Lane-level action sits BELOW the cards it acts on, not in the header
        // where it competed with the lane title as a second link.
        lane.key === 'STAGING' && items.length
          ? el('button', {
            class: 'lane__complete',
            title: 'Check readiness and upstream SBQ for every task in Staging, then move the confirmed ones',
            onclick: (e) => { e.preventDefault(); runBackfillCheck(); },
          }, `Backfill check · ${items.length} task${items.length === 1 ? '' : 's'}`)
          : null,
        lane.key === 'RESOLVED' && items.length
          ? el('button', {
            class: 'lane__complete',
            title: 'Compare every Resolved task against Redash — SBQ status vs L12 membership, propagation-aware',
            onclick: (e) => { e.preventDefault(); runReconciliation(); },
          }, 'Reconciliation · SBQ × L12')
          : null,
      );
    })
  );
  root.querySelectorAll('.lane').forEach((l) => {
    const k = l.dataset.lane;
    const b = l.querySelector('.lane__list');
    if (k && b && prevScroll[k]) b.scrollTop = prevScroll[k];
  });

  renderStrip(all, byLane);
  // Reserved width + tabular numerals, so the toolbar never shifts between states.
  document.getElementById('search-count').textContent =
    q || sevFilter !== 'ALL' || mineOnly ? `${tickets.length} of ${all.length}` : `${all.length} tasks`;
  refreshBulkCount();
  refreshIdmoveSummary();
}

// "How far through this delivery are we" — replaces counting cards by eye.
function renderStrip(all, byLane) {
  const real = all.filter((t) => !t.tour);
  const audited = real.filter((t) => t.verdict && RESOLVED_VERDICTS.has(t.verdict)).length;
  const mine = real.filter((t) => t.claimedBy === me?.username).length;
  const second = byLane.get('SECOND_OPINION').length;
  const pct = real.length ? Math.round((audited / real.length) * 100) : 0;
  const resume = real.find((t) => t.claimedBy === me?.username && !t.verdict)
    || real.find((t) => !t.claimedBy && !t.verdict);

  mount(document.getElementById('strip'),
    el('b', {}, `${real.length} tasks`),
    el('span', { class: 'progress' }, el('i', { style: `width:${pct}%` })),
    el('span', {}, `${audited} / ${real.length} audited`),
    el('span', { class: 'sep' }, '·'),
    el('span', {}, `${second} need 2nd opinion`),
    el('span', { class: 'sep' }, '·'),
    el('span', {}, `${mine} claimed by you`),
    el('span', { class: 'spacer' }),
    resume
      ? el('a', { href: `${window.__base__ || ''}/task/${resume.bucket}/${resume.id}`, style: 'font-weight:600' },
        'Resume audit →')
      : null,
  );
}

// Show/hide the delivered toggle based on how many tasks are soft-archived.
function updateDeliveredToggle() {
  const n = allTickets().filter((t) => t.delivered).length;
  const btn = document.getElementById('toggle-delivered');
  btn.hidden = n === 0;
  btn.textContent = showDelivered ? `Hide delivered (${n})` : `Show delivered (${n})`;
  btn.classList.toggle('on', showDelivered);
}

// "Completed" = the Resolved workflow lane (any recorded decision), independent of
// severity — archiving sorts by completion status, NOT by Pass/Fail.
function completedTasks() {
  return allTickets().filter((t) => !t.tour && !t.delivered && t.verdict && RESOLVED_VERDICTS.has(t.verdict));
}
function updateArchiveBtn() {
  const btn = document.getElementById('archive-completed');
  if (!btn) return;
  const n = completedTasks().length;
  btn.hidden = me?.role !== 'admin' || n === 0; // admin-only; nothing completed → nothing to archive
  btn.textContent = `📦 Archive completed (${n})`;
}
async function archiveCompleted() {
  const status = document.getElementById('bv-status');
  const done = completedTasks();
  if (!done.length) return;
  if (!confirm(`Archive ${done.length} completed task${done.length === 1 ? '' : 's'} — everything in the Resolved lane, any severity? They leave the board but stay searchable in the Archive, and a restorable backup zip is built.`)) return;
  status.textContent = 'archiving…';
  try {
    const r = await api('/admin/deliver', { method: 'POST', body: { taskIds: done.map((t) => t.id) } });
    await load();
    status.textContent = `archived ${r.delivered}`;
    setTimeout(() => { status.textContent = ''; }, 2600);
  } catch (e) { status.textContent = e.message; }
}
document.getElementById('archive-completed')?.addEventListener('click', archiveCompleted);
document.getElementById('toggle-delivered').addEventListener('click', () => {
  showDelivered = !showDelivered;
  render();
});

searchInput.addEventListener('input', render);

// ---------- actions drawer ----------
// One drawer instead of six scattered controls. It pushes the lane grid down;
// the page still never scrolls.
const drawer = document.getElementById('drawer');
let drawerTab = 'move';

function setDrawerTab(tab) {
  drawerTab = tab;
  for (const b of drawer.querySelectorAll('.drawer__tabs button[data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  for (const p of drawer.querySelectorAll('.drawer__body')) {
    p.hidden = p.dataset.panel !== tab;
  }
  if (tab === 'history') refreshActions();
  if (tab === 'Export') renderExportIds();
}

function setDrawerOpen(open) {
  drawer.hidden = !open;
  document.getElementById('actions-btn').setAttribute('aria-expanded', String(open));
  if (open) setDrawerTab(drawerTab);
}

document.getElementById('actions-btn').addEventListener('click', () => setDrawerOpen(drawer.hidden));
document.getElementById('drawer-close').addEventListener('click', () => setDrawerOpen(false));
drawer.addEventListener('click', (e) => {
  const t = e.target.closest('.drawer__tabs button[data-tab]');
  if (t) setDrawerTab(t.dataset.tab);
});

// Per-lane id export lives in the drawer now rather than as a button per column.
function renderExportIds() {
  const host = document.getElementById('export-ids');
  if (!host || host.childElementCount) return;
  const base = window.__base__ || '';
  mount(host,
    el('span', { class: 'drawer__hint' }, 'One task_id per line:'),
    ...['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'].map((b) =>
      el('a', { class: 'btn', href: `${base}/api/export/ids/${b}` }, `${SEV_LABEL[b]} ids`)),
  );
}

const mineFilterBtn = document.getElementById('mine-filter');
mineFilterBtn.setAttribute('aria-pressed', String(mineOnly));
mineFilterBtn.addEventListener('click', () => {
  mineOnly = !mineOnly;
  localStorage.setItem('cwt_mine_only', mineOnly ? '1' : '0');
  mineFilterBtn.setAttribute('aria-pressed', String(mineOnly));
  render();
});

// One click to build the queue: claim the first unclaimed Open task and land
// on it. A 409 means someone else got there first — reload and let them retry.
document.getElementById('claim-next').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const open = allTickets().filter((t) =>
    !t.tour && !t.delivered && laneOf(t) === 'OPEN' && !t.claimedBy);
  if (!open.length) { toast('No unclaimed open tasks.'); return; }
  btn.disabled = true;
  const t = open[0];
  try {
    await api(`/task/${t.bucket}/${t.id}/claim`, { method: 'POST' });
    location.href = `${window.__base__ || ''}/task/${t.bucket}/${t.id}`;
  } catch (err) {
    btn.disabled = false;
    toast(`Claim failed: ${err.message}`);
    load();
  }
});

document.getElementById('sev-filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sev]');
  if (!btn) return;
  sevFilter = btn.dataset.sev;
  for (const b of document.querySelectorAll('#sev-filter button')) {
    b.setAttribute('aria-pressed', String(b === btn));
  }
  render();
});

document.getElementById('export-csv').addEventListener('click', () => { location.href = (window.__base__ || '') + '/api/export/all.csv'; });

// ---------- bulk lane move: {severity, source lane} → any lane ----------
const bvSev = document.getElementById('bv-sev');
const bvFrom = document.getElementById('bv-from');
const bvTo = document.getElementById('bv-to');
const bvCount = document.getElementById('bv-count');

// "RESOLVED:FIXES_MADE" → the lane plus the verdict that lane needs.
function bulkTarget() {
  const [lane, verdict = null] = (bvTo?.value || '').split(':');
  return { lane, verdict };
}

// Which tasks the current selection would actually move. Mirrors the server's
// selectTasks + "skip anything already there", so the count matches what happens.
function bulkMatches() {
  const sev = bvSev?.value || 'ALL';
  const from = bvFrom?.value || 'ANY';
  const { lane: to } = bulkTarget();
  // Reopen isn't a lane — it clears the verdict, so the no-op test is "has no
  // verdict". Inside Resolved the verdict decides, matching the server.
  const { verdict: toVerdict } = bulkTarget();
  const noop = (t) => (to === 'REOPEN' ? !t.verdict
    : to === 'RESOLVED' ? t.verdict === toVerdict
    : laneOf(t) === to);
  return allTickets().filter((t) =>
    !t.tour && !t.delivered &&
    (sev === 'ALL' || t.bucket === sev) &&
    (from === 'ANY' || laneOf(t) === from) &&
    !noop(t)
  );
}

// Showing the match count, the severity split and the skip reason BEFORE the
// button is the point of this panel — the old inline pill committed first and
// reported after.
function refreshBulkCount() {
  if (!bvCount) return;
  const matches = bulkMatches();
  const { lane } = bulkTarget();
  const already = matches.filter((t) => laneOf(t) === lane).length;
  const willMove = matches.length - already;

  bvCount.textContent = `${matches.length} task${matches.length === 1 ? '' : 's'} match`;
  const split = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED']
    .map((b) => [SEV_LABEL[b], matches.filter((t) => t.bucket === b).length])
    .filter(([, n]) => n)
    .map(([l, n]) => `${n} ${l}`)
    .join(' · ');
  document.getElementById('bv-split').textContent = split;
  document.getElementById('bv-skip').textContent =
    already ? `${already} already in that lane, skipped` : '';

  const apply = document.getElementById('bv-apply');
  if (apply) {
    apply.disabled = willMove === 0;
    apply.textContent = willMove ? `Move ${willMove} task${willMove === 1 ? '' : 's'}` : 'Move';
  }
}
[bvSev, bvFrom, bvTo].forEach((s) => s?.addEventListener('change', refreshBulkCount));

document.getElementById('bv-apply')?.addEventListener('click', async () => {
  const status = document.getElementById('bv-status');
  const { lane, verdict } = bulkTarget();
  const matches = bulkMatches();
  const toLabel = bvTo.selectedOptions[0].textContent.trim();
  const fromLabel = bvFrom.selectedOptions[0].textContent.trim().toLowerCase();
  const sevLabel = bvSev.value === 'ALL' ? '' : `${bvSev.selectedOptions[0].textContent.trim()} `;
  if (!matches.length) { status.textContent = 'nothing to move'; setTimeout(() => { status.textContent = ''; }, 2600); return; }
  if (!confirm(`Move ${matches.length} ${sevLabel}task${matches.length === 1 ? '' : 's'} in ${fromLabel} → “${toLabel}”?\n\nThis changes the lane for everyone. Undo from Recent actions.`)) return;
  status.textContent = 'moving…';
  try {
    const r = await api('/bulk/lane', {
      method: 'POST',
      body: { severity: bvSev.value, fromLane: bvFrom.value, toLane: lane, verdict },
    });
    status.textContent = `moved ${r.moved}`;
    await load();
    if (r.action) toast(`Moved ${r.moved} task${r.moved === 1 ? '' : 's'}.`, { label: 'Undo', run: () => undo(r.action.id) });
    setTimeout(() => { status.textContent = ''; }, 2600);
  } catch (e) { status.textContent = e.message; }
});

// ---------- move a pasted list of task IDs into one lane ----------
const idmoveInput = document.getElementById('idmove-input');
const idmoveTo = document.getElementById('idmove-to');

// Comma / space / newline separated, order-preserving, de-duplicated.
function parsePastedIds(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text || '').split(/[\s,]+/)) {
    const id = raw.trim().toLowerCase();
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// Classify the paste against the board so the outcome is visible BEFORE moving —
// pasting 20 ids and silently acting on 17 of them is the thing to avoid.
function classifyPastedIds() {
  const ids = parsePastedIds(idmoveInput?.value);
  const [lane, verdict = null] = (idmoveTo?.value || '').split(':');
  const known = new Map(allTickets().filter((t) => !t.tour).map((t) => [t.id, t]));
  const malformed = ids.filter((id) => !/^[a-f0-9]{24}$/.test(id));
  const valid = ids.filter((id) => /^[a-f0-9]{24}$/.test(id));
  const missing = valid.filter((id) => !known.has(id));
  const found = valid.filter((id) => known.has(id)).map((id) => known.get(id));
  // Mirror the server: inside Resolved the verdict decides, so re-resolving an
  // SBQ task as No issues is a real change, not "already there".
  const noop = (t) => (lane === 'REOPEN' ? !t.verdict
    : lane === 'RESOLVED' ? t.verdict === verdict
    : laneOf(t) === lane);
  return { ids, malformed, missing, found, willMove: found.filter((t) => !noop(t)), lane, verdict };
}

function refreshIdmoveSummary() {
  // NB: not named `el` — that would shadow the imported el() DOM helper used below.
  const box = document.getElementById('idmove-summary');
  const apply = document.getElementById('idmove-apply');
  if (!box) return;
  const c = classifyPastedIds();
  if (!c.ids.length) {
    box.textContent = 'Paste some IDs to begin.';
    box.className = 'idmove-summary';
    if (apply) apply.disabled = true;
    return;
  }
  const bits = [`${c.willMove.length} will move`];
  const already = c.found.length - c.willMove.length;
  if (already) bits.push(`${already} already there`);
  if (c.missing.length) bits.push(`${c.missing.length} not on the board`);
  if (c.malformed.length) bits.push(`${c.malformed.length} not a task ID`);
  mount(box,
    el('span', {}, `${c.ids.length} pasted · ${bits.join(' · ')}`),
    c.missing.length || c.malformed.length
      ? el('div', { class: 'idmove-bad' },
        [...c.malformed, ...c.missing].slice(0, 6).join(', ')
        + (c.malformed.length + c.missing.length > 6 ? ` … +${c.malformed.length + c.missing.length - 6}` : ''))
      : null,
  );
  box.className = `idmove-summary${c.missing.length || c.malformed.length ? ' has-bad' : ''}`;
  if (apply) apply.disabled = c.willMove.length === 0;
}
idmoveInput?.addEventListener('input', refreshIdmoveSummary);
idmoveTo?.addEventListener('change', refreshIdmoveSummary);


document.getElementById('idmove-apply')?.addEventListener('click', async () => {
  const status = document.getElementById('idmove-status');
  const c = classifyPastedIds();
  if (!c.willMove.length) return;
  const toLabel = idmoveTo.selectedOptions[0].textContent.trim();
  const skipped = c.missing.length + c.malformed.length;
  if (!confirm(
    `Move ${c.willMove.length} task${c.willMove.length === 1 ? '' : 's'} → “${toLabel}”?`
    + (skipped ? `\n\n${skipped} pasted ID${skipped === 1 ? '' : 's'} will be ignored (not on the board).` : '')
    + '\n\nUndo from Recent actions.'
  )) return;
  status.textContent = 'moving…';
  try {
    // Send only the ids that resolve — the server re-checks, but this keeps the
    // journal entry's count honest rather than padded with ids that never moved.
    const r = await api('/bulk/lane', {
      method: 'POST',
      body: { toLane: c.lane, verdict: c.verdict, ids: c.found.map((t) => t.id) },
    });
    status.textContent = `moved ${r.moved}`;
    await load();
    refreshIdmoveSummary();
    if (r.action) toast(`Moved ${r.moved} task${r.moved === 1 ? '' : 's'} by ID.`, { label: 'Undo', run: () => undo(r.action.id) });
    setTimeout(() => { status.textContent = ''; }, 2600);
  } catch (e) { status.textContent = e.message; }
});

// ---------- action journal: recent actions + undo ----------
async function undo(id) {
  try {
    const r = await api(`/actions/${id}/undo`, { method: 'POST' });
    await load();
    const skipped = r.skipped?.length
      ? ` · ${r.skipped.length} skipped (changed since)`
      : '';
    toast(`Reverted ${r.undone} task${r.undone === 1 ? '' : 's'}${skipped}.`);
  } catch (e) { toast(e.message); }
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

async function refreshActions() {
  const body = document.getElementById('acts-body');
  if (!body || drawerTab !== 'history' || drawer.hidden) return;
  let actions;
  try { ({ actions } = await api('/actions?limit=12')); } catch { return; }
  body.replaceChildren(
    ...(actions.length
      ? actions.map((a) => el('div', { class: `act${a.undone ? ' is-undone' : ''}` },
        el('span', { class: 'act-when' }, ago(a.at)),
        el('span', { class: 'act-who' }, cap(a.by)),
        el('span', { class: 'act-label' }, a.label),
        a.undone
          ? el('span', { class: 'act-undone' }, 'undone')
          : el('button', { class: 'act-undo', onclick: () => undo(a.id) }, 'Undo'),
      ))
      : [el('div', { class: 'act-empty' }, 'No lane changes yet.')])
  );
}

// generate review+remediation for every task missing them, as background jobs
let genPoll = null;
document.getElementById('gen-all').addEventListener('click', async () => {
  if (!confirm('Generate review + remediation for every task that is missing them? This runs in the background and can take a while / use significant tokens on large batches.')) return;
  const r = await api('/admin/gendocs', { method: 'POST', body: { onlyMissing: true } });
  document.getElementById('search-count').textContent = `queued ${r.queued} task(s) for doc generation…`;
  pollGenStatus();
});
async function pollGenStatus() {
  clearInterval(genPoll); genPoll = null;
  const sc = document.getElementById('search-count');
  const tick = async () => {
    let s;
    try { s = await api('/admin/gendocs/status'); } catch { return; }
    if (!s.busy) {
      clearInterval(genPoll); genPoll = null;
      const done = s.counts.done || 0, err = s.counts.error || 0;
      if (done || err) { sc.textContent = `doc generation done · ${done} ok${err ? ` · ${err} failed` : ''}`; await load(); }
      return;
    }
    sc.textContent = `generating docs · running ${s.active} · queued ${s.queued}`;
  };
  await tick();
  if (!genPoll) genPoll = setInterval(tick, 4000);
}

document.getElementById('clear-board').addEventListener('click', async () => {
  const total = ORDER.reduce((n, b) => n + (currentWs[b]?.length || 0), 0);
  if (!confirm(`Clear all ${total} task uploads from the board? This cannot be undone (claims, decisions, and generated docs are removed). Use this to start a fresh delivery cycle.`)) return;
  const { cleared } = await api('/admin/clear', { method: 'POST' });
  await load();
  document.getElementById('search-count').textContent = `cleared ${cleared}`;
});

// ---------- guided tour (interactive, on a disposable sandbox task) ----------
function tourTask() { try { return JSON.parse(sessionStorage.getItem('cwt_tour_task') || 'null'); } catch { return null; } }
function postTourLog(entry) { api('/tour/log', { method: 'POST', body: entry }).catch(() => {}); }
function endTourCleanup() {
  sessionStorage.removeItem('cwt_tour_task');
  api('/tour/end', { method: 'POST' }).catch(() => {});
  load();
}
// Best-effort cleanup if they close the tab mid-tour.
window.addEventListener('beforeunload', () => {
  if (sessionStorage.getItem('cwt_tour_task') && !sessionStorage.getItem('cwt_tour_resume')) {
    navigator.sendBeacon?.((window.__base__ || '') + '/api/tour/end');
  }
});

function openTaskForTour() {
  const d = tourTask();
  if (!d) return false;
  sessionStorage.setItem('cwt_tour_resume', '1'); // task page resumes the same tour
  location.href = `${window.__base__ || ''}/task/${d.bucket}/${d.id}`;
  return true; // intercept: navigating (don't run onExit cleanup)
}

const BOARD_TOUR = [
  { title: 'Welcome to ACC Audit Studio 👋', body: 'A hands-on tour — you\'ll actually try things on a private sandbox task (marked "sandbox"). Nothing you do here is real; it\'s deleted when the tour ends. Use Next / Back or ← →, Esc to leave.' },
  { selector: '.toolbar', title: 'Find & filter tasks', body: 'Search by task ID or problem text, and filter by severity — Fail, Non-fail, or No issues. Invaluable when a delivery drops hundreds of tasks at once.' },
  { selector: '.lanes', title: 'Your workflow board', body: 'Every task sits in a lane that reflects its state: Open → In review → (Needs 2nd opinion) → Resolved. It\'s the shared source of truth for who\'s doing what.' },
  { selector: '#tour-dummy-card', pin: 'top', title: 'Try it: drag & drop 🖱️', body: 'The drag IS the action — no forms. Grab your highlighted "sandbox" card (in the Soft column) and drag it into another lane: drop in Resolved to pick a decision, "Needs 2nd opinion" to flag it, or "In review" to claim it. Go ahead — I\'ll wait.',
    try: { action: 'drag_drop', hint: 'Waiting for you to drag the sandbox card into another lane…', verify: verifyDragged } },
  { selector: '.lane[data-lane="SECOND_OPINION"]', title: 'Second opinions, with the "why"', body: 'Tasks flagged for another reviewer land here — and the key issue the first reviewer wrote shows right on the card, so whoever picks it up knows the crux instantly.' },
  { selector: '#actions-btn', title: 'Actions', body: 'Everything bulk lives behind one button: move a whole severity or lane, move a pasted list of IDs, export CSV or per-lane IDs, review and undo recent actions, and (admins) generate docs or archive completed work. Each move shows you what matches before you commit.', onShow: () => document.getElementById('drawer').hidden && document.getElementById('actions-btn').click() },
  { selector: '#drawer', title: 'Preview, then commit', body: 'The Move panel reads as a sentence and tells you how many tasks match — and how many are already there and will be skipped — before you press the button. Everything you do here is undoable from the History tab.' },
  { title: 'Now the fun part — the task itself', body: 'The board is the map; the task page is where you actually audit: trajectories, the annotator\'s grading, and an AI copilot. Let me open your sandbox task and keep going.', nextLabel: 'Open the task ▸', onNext: openTaskForTour },
];

async function verifyDragged() {
  const d = tourTask();
  if (!d) return false;
  try { const s = await api(`/task/${d.bucket}/${d.id}/state`); return !!(s.verdict || s.claimed_by); }
  catch { return false; }
}

async function startBoardTour() {
  let dummy = null;
  try { dummy = await api('/tour/start', { method: 'POST' }); } catch { /* run read-only if sandbox fails */ }
  if (dummy) sessionStorage.setItem('cwt_tour_task', JSON.stringify(dummy));
  await load(); // surface the sandbox card
  startTour(BOARD_TOUR, { onExit: endTourCleanup, onLog: postTourLog });
}

boot();


// Acey is available from every page, not just inside a task.
mountAcey({ page: 'board' });
