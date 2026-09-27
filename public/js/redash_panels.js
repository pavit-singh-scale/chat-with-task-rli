import { api, el, mount } from './common.js';

// Live-pipeline panels for the L12 Stats page.
//
// Everything else on that page is computed from what's on disk — i.e. only the
// tasks that were uploaded to the board. These panels come from Redash, so they
// describe the upstream ACC pipeline as a whole, and cross-join it against the
// board's local verdicts.
//
// They load AFTER the disk-computed sections and never block them: a Snowflake
// round trip is seconds, and Redash being down must not take the page with it.

const SEV_LABEL = { PASS: 'Pass', SOFT_FAIL: 'Soft fail', HARD_FAIL: 'Hard fail', UNSORTED: 'Unsorted' };
const BUCKET_ORDER = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];

const num = (n) => (n == null ? '—' : Number(n).toLocaleString());

function stamp(res) {
  if (!res?.retrievedAt) return '';
  const t = new Date(res.retrievedAt);
  return `${res.cached ? 'cached · ' : ''}${t.toLocaleTimeString()}`;
}

function note(text, cls = '') {
  return el('div', { class: `rd-note ${cls}` }, text);
}

// ---------------------------------------------------------------------------
// Level ladder — how much work is sitting at each layer right now
// ---------------------------------------------------------------------------

function renderLadder(host, ov) {
  // Numbers only: a bar per level added length without adding meaning — the
  // pending count IS the signal, and the columns compare cleanly on their own.
  const cell = (v, fmt = num) => (v ? fmt(v) : el('span', { class: 'dim' }, '—'));
  const rows = ov.levels.map((l) => el('div', { class: 'rd-lvl rd-ladder' },
    el('div', { class: 'rd-lvl-name' }, l.label),
    el('div', { class: 'rd-num' }, l.pending ? el('b', {}, num(l.pending)) : el('span', { class: 'dim' }, '0')),
    el('div', { class: 'rd-num' }, cell(l.other)),
    el('div', { class: 'rd-num' }, cell(l.hours, (h) => `${num(h)} h`)),
    el('div', { class: 'rd-num' }, cell(l.avgHours, (h) => `${h} h`))));

  host.replaceChildren(
    el('div', { class: 'rd-lvl-head rd-ladder' },
      el('div', {}, 'Review level'),
      el('div', { class: 'rd-num' }, 'Pending'),
      el('div', { class: 'rd-num', title: 'Nodes at this level that are no longer live (completed or canceled)' }, 'Not pending'),
      el('div', { class: 'rd-num' }, `Worked (${ov.days}d)`),
      el('div', { class: 'rd-num' }, 'Per attempt')),
    ...rows,
    note(`${num(ov.pending)} tasks pending across all layers · ${num(ov.totalHours)} hours worked in the last ${ov.days} days.`),
  );
}

// ---------------------------------------------------------------------------
// Board × pipeline — where the tasks YOU audited actually sit upstream
// ---------------------------------------------------------------------------

function renderBoardMatrix(table, board) {
  const levels = board.levels;
  const head = el('tr', {},
    el('th', {}, 'Board bucket'),
    el('th', {}, 'On board'),
    ...levels.map((l) => el('th', { class: 'rd-num' }, `L${l}`)),
    el('th', { class: 'rd-num' }, 'Not found'),
  );

  const body = BUCKET_ORDER.filter((b) => board.buckets[b]).map((b) => {
    const v = board.buckets[b];
    return el('tr', {},
      el('td', {}, el('span', { class: `rd-sev sev-${b}` }, SEV_LABEL[b] || b)),
      el('td', {}, num(v.total)),
      ...levels.map((l) => el('td', { class: 'rd-num' },
        v.levels[l] ? String(v.levels[l]) : el('span', { class: 'dim' }, '·'))),
      el('td', { class: 'rd-num' },
        v.total - v.matched ? String(v.total - v.matched) : el('span', { class: 'dim' }, '·')),
    );
  });

  table.replaceChildren(head, ...body);
  if (!body.length) table.append(el('tr', {}, el('td', { class: 'empty', colspan: String(levels.length + 3) }, 'No tasks on the board.')));
}

// Status split, so "at L12" isn't silently read as "finished" — a node can be
// pending, completed or canceled at the same level and they mean different things.
function renderStatusSplit(host, board) {
  const totals = {};
  for (const r of board.rows) {
    if (!r.status) continue;
    totals[r.status] = (totals[r.status] || 0) + 1;
  }
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  mount(host,
    entries.map(([status, n]) => el('span', { class: 'rd-chip' }, el('b', {}, num(n)), ` ${status}`)),
    board.unmatched
      ? el('span', { class: 'rd-chip warn' }, el('b', {}, num(board.unmatched)), ' not in pipeline')
      : null);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function initPipelinePanels({ days = 30 } = {}) {
  const section = document.getElementById('rd-section');
  if (!section) return;

  const status = await api('/redash/status').catch(() => ({ enabled: false }));
  if (!status.enabled || status.connected === false) {
    section.hidden = false;
    document.getElementById('rd-ladder').replaceChildren(
      note(status.enabled
        ? `Redash is configured but not reachable: ${status.error || 'unknown error'}`
        : 'Redash is not configured on this server (REDASH_API_KEY unset).', 'warn'));
    return;
  }

  section.hidden = false;
  const ladder = document.getElementById('rd-ladder');
  const table = document.getElementById('rd-board');
  const split = document.getElementById('rd-split');
  const stampEl = document.getElementById('rd-stamp');

  async function load(fresh = false) {
    ladder.replaceChildren(note('Loading pipeline from Redash…'));
    split.replaceChildren();
    const q = fresh ? '&fresh=1' : '';
    const [ov, board] = await Promise.all([
      api(`/redash/overview?days=${days}${q}`).catch((e) => ({ error: e.message })),
      api(`/redash/board?scope=all${q}`).catch((e) => ({ error: e.message })),
    ]);

    if (ov.error) ladder.replaceChildren(note(`Pipeline query failed: ${ov.error}`, 'warn'));
    else renderLadder(ladder, ov);

    if (board.error) {
      table.replaceChildren(el('tr', {}, el('td', { class: 'empty' }, `Board join failed: ${board.error}`)));
    } else {
      renderBoardMatrix(table, board);
      renderStatusSplit(split, board);
    }
    stampEl.textContent = stamp(ov.error ? board : ov);
  }

  document.getElementById('rd-refresh')?.addEventListener('click', () => load(true));
  await load(false);
}
