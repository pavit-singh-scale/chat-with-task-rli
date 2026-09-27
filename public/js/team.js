import { api, el, mount, renderAppHeader, avatar } from './common.js';
import { mountAcey } from './acey.js';

// The Team page answers ONE question: what needs doing on RLI, and who owns it.
//
// It used to answer three, badly. The same eight items appeared as a health
// signal (evidence, no actions), again under "Escalated", and again inside a
// per-person column — so you read a problem, then scrolled past two more copies
// to find the actionable one. The severity tiles filtered nothing. Five ragged
// columns of unequal height made scanning impossible.
//
// Now: one card per item, grouped under its owner, carrying its own evidence and
// its own actions. Severity, escalation and ownership are FILTERS across the top
// rather than separate renderings of the same data — which is also what finally
// gives those counts a job.
//
// The evidence a health check produced (the value and the threshold it crossed)
// lives on the card, because a todo you cannot argue with is one people quietly
// stop doing. Nothing was lost by deleting the signals section; it moved.

const $ = (id) => document.getElementById(id);
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const SEV_RANK = { p00: 0, p0: 1, p1: 2, p2: 3 };
// Priorities are deadlines. P00 is the crown: at most one open item wears it,
// and the server demotes the previous holder to P0 when it moves.
const SEV_META = {
  p00: 'P00 — THE most pressing item (only one, ever)',
  p0: 'P0 — asap',
  p1: 'P1 — by end of day',
  p2: 'P2 — within 2–3 days',
};

let data = null;
let me = null;
let view = 'all';       // all | mine | escalated | critical | high | medium | closed

init();

async function init() {
  const user = await api('/me').catch(() => null);
  me = user?.username || null;
  renderAppHeader({ active: 'team', user });

  $('tm-refresh').addEventListener('click', () => load({ fresh: true }));
  $('tm-export').addEventListener('click', exportItems);

  // Acey creates and undoes items from its panel while this page sits behind
  // it — reload so the list is never staler than the confirmation beside it.
  document.addEventListener('acey:todos-changed', () => load({}));
  // Clicking Acey's "Added" deep link while already on this page changes only
  // the hash; land it the same way a cross-page arrival lands.
  window.addEventListener('hashchange', flashFromHash);

  await load({});
}

// Loads overlap (quick-add, Acey events, refresh); a slow early response must
// not paint over a newer one, so each load is stamped and stale ones drop.
let loadSeq = 0;

async function load({ fresh }) {
  const seq = ++loadSeq;
  if (!data) showSkeleton();
  try {
    const next = await api(`/team/board?${view === 'closed' ? 'closed=1&' : ''}${fresh ? 'fresh=1' : ''}`);
    if (seq !== loadSeq) return;
    data = next;
  } catch (e) {
    if (seq !== loadSeq) return;
    $('tm-sub').textContent = `Could not load the board — ${e.message}`;
    mount($('tm-filters'));
    mount($('tm-owners'), el('div', { class: 'tm-blank' },
      'The health checks could not run, so nothing below is current. This is not a clear board.'));
    return;
  }
  render();
}

// Every item, exactly once. people[].todos already contains the full set;
// `escalated` is the same objects flagged, not a second list.
const allItems = () => data.people.flatMap((p) => p.todos);

function matches(t) {
  if (view === 'all') return true;
  if (view === 'mine') return t.owner === me;
  if (view === 'escalated') return !!t.escalated;
  if (view === 'closed') return t.status === 'done' || t.status === 'resolved';
  if (view === 'p0') return t.severity === 'p0' || t.severity === 'p00';
  return t.severity === view;
}

function render() {
  const items = allItems();
  const c = data.health.context;

  $('tm-sub').textContent = [
    `${int(c.deliverable ?? 0)} of ${int(c.target ?? 0)} deliverable for ${c.nextDelivery}`,
    `${c.daysUntilDelivery}d out`,
    `${int(c.totalPending ?? 0)} in flight`,
    c.blocked ? `${int(c.blocked)} blocked` : null,
  ].filter(Boolean).join(' · ');

  renderFilters(items);
  renderOwners(items.filter(matches));

  const ch = data.changes;
  $('tm-foot').textContent = ch
    ? `Auto items are created by a health check and close themselves when the signal clears `
      + `(${ch.created} new, ${ch.resolved} cleared, ${ch.reopened} recurred this sync). `
      + `Items you add by hand are never closed automatically. Checked ${new Date(data.health.generatedAt).toLocaleTimeString()}. `
      + 'Priorities: P00 = the one most pressing (only one) · P0 = asap · P1 = by EOD · P2 = 2–3 days.'
    : '';
}

// ---------------------------------------------------------------------------
// Filters — the counts ARE the control
// ---------------------------------------------------------------------------

function renderFilters(items) {
  const open = items.filter((t) => t.status !== 'done' && t.status !== 'resolved');
  const count = (pred) => open.filter(pred).length;

  // Seven chips was a control per concept; the shape that matters day-to-day is
  // three questions (everything / mine / escalated) plus an occasional slice,
  // so the slices live in one dropdown instead of four more buttons.
  const chips = [
    { key: 'all', label: 'All', n: open.length },
    { key: 'mine', label: 'Mine', n: count((t) => t.owner === me) },
    { key: 'escalated', label: 'Escalated', n: count((t) => t.escalated) },
  ].map((d) => {
    const on = view === d.key;
    const b = el('button', {
      class: `tm-filter${on ? ' is-on' : ''}${d.key !== 'all' && !d.n ? ' is-empty' : ''}`,
      type: 'button', 'aria-pressed': on ? 'true' : 'false',
    }, d.label, el('span', { class: 'tm-filter__n' }, String(d.n)));
    b.addEventListener('click', () => setView(d.key));
    return b;
  });

  const MORE = [
    ['p0', `P0 · ${count((t) => t.severity === 'p0' || t.severity === 'p00')}`],
    ['p1', `P1 · ${count((t) => t.severity === 'p1')}`],
    ['p2', `P2 · ${count((t) => t.severity === 'p2')}`],
    ['closed', 'Closed'],
  ];
  const inMore = MORE.some(([k]) => k === view);
  const more = el('select', {
    class: `tm-filter tm-filter--sel${inMore ? ' is-on' : ''}`, 'aria-label': 'More filters',
  },
    el('option', { value: '' }, 'More…'),
    ...MORE.map(([k, label]) => el('option', { value: k, ...(view === k ? { selected: true } : {}) }, label)));
  more.addEventListener('change', () => setView(more.value || 'all'));

  mount($('tm-filters'), ...chips, more);
}

function setView(key) {
  const wasClosed = view === 'closed';
  view = key;
  // Closed items are not fetched by default, so crossing that boundary needs a
  // round trip; every other switch is in memory and instant.
  if (wasClosed || key === 'closed') load({});
  else render();
}

// ---------------------------------------------------------------------------
// The work, grouped by owner
// ---------------------------------------------------------------------------

function renderOwners(items) {
  if (!items.length) {
    return mount($('tm-owners'), el('div', { class: 'tm-blank' },
      view === 'all'
        ? 'No open work. Every health check is under its threshold.'
        : 'Nothing matches this filter.'));
  }

  const byOwner = new Map();
  for (const t of items) {
    if (!byOwner.has(t.owner)) byOwner.set(t.owner, []);
    byOwner.get(t.owner).push(t);
  }

  // Team order, so the page does not reshuffle as items move between people.
  // In the All view every owner renders — an empty owner is one thin row whose
  // quick-add is the way work gets typed in for them. In a filtered view,
  // owners with no matches are dropped; empty rows there would just be noise.
  mount($('tm-owners'), ...data.people
    .filter((p) => view === 'all' || byOwner.has(p.username))
    .map((p) => ownerSection(p, sortWork(byOwner.get(p.username) || []))));

  flashFromHash();
}

// Deep links from the Overview and from Acey confirmations: #t<id> scrolls to
// that card and flashes it; #owner-<username> lands on a person's section. The
// hash is consumed after one flash so a later manual reload does not replay it.
function flashFromHash() {
  const m = /^#(t\d+|owner-[a-z]+)$/.exec(location.hash || '');
  if (!m) return;
  const target = document.getElementById(m[1]);
  if (!target) return;
  target.scrollIntoView({ block: 'center' });
  target.classList.add('hash-flash');
  setTimeout(() => target.classList.remove('hash-flash'), 2200);
  history.replaceState(null, '', location.pathname + location.search);
}

const sortWork = (list) => list.sort((a, b) =>
  (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3)
  || String(a.createdAt).localeCompare(String(b.createdAt)));

function ownerSection(p, todos) {
  // "N open · M closed this week" is the completion tracking: the difference
  // between a queue that is stuck and one that is churning, per person.
  const stats = el('div', { class: 'tm-owner__stats' },
    el('span', {}, `${p.live} open`),
    p.doneWeek ? el('span', { class: 'tm-owner__done' }, `${p.doneWeek} closed this week`) : null);
  const total = p.live + p.doneWeek;

  return el('section', { class: `tm-owner${p.username === me ? ' is-me' : ''}`, id: `owner-${p.username}` },
    el('header', { class: 'tm-owner__head' },
      avatar(p.username),
      el('div', { class: 'tm-owner__id' },
        el('h2', { class: 'tm-owner__name' }, p.name,
          p.username === me ? el('span', { class: 'tm-you' }, 'You') : null),
        el('p', { class: 'tm-owner__remit' }, p.blurb)),
      el('div', { class: 'tm-owner__meta' },
        stats,
        total ? el('div', { class: 'tm-progress', title: `${p.doneWeek} of ${total} closed this week` },
          el('span', { style: `width:${Math.round((p.doneWeek / total) * 100)}%` })) : null)),
    el('div', { class: 'tm-work' },
      ...todos.map(card),
      view === 'closed' ? null : quickAdd(p)));
}

// Quick add, the Todoist pattern: one input at the bottom of the list, type and
// press Enter, everything else optional. The dot cycles severity so the common
// case never needs a form; focus returns to the same input after the reload so
// entering three items in a row is three lines of typing.
let refocusOwner = null;

function quickAdd(p) {
  const SEVS = ['p2', 'p1', 'p0', 'p00'];
  let idx = 0;
  const dot = el('button', {
    class: 'tm-qa__sev tm-qa__sev--p2', type: 'button',
    title: `${SEV_META.p2} — click to change`, 'aria-label': 'Priority',
  });
  dot.addEventListener('click', () => {
    idx = (idx + 1) % SEVS.length;
    dot.className = `tm-qa__sev tm-qa__sev--${SEVS[idx]}`;
    dot.title = `${SEV_META[SEVS[idx]]} — click to change`;
  });

  const input = el('input', {
    class: 'tm-qa__input', maxlength: '200',
    placeholder: `Add an item for ${p.name.split(' ')[0]}…`,
    'aria-label': `Add an item for ${p.name}`,
  });
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') return input.blur();
    if (e.key !== 'Enter' || !input.value.trim()) return;
    input.disabled = true;
    try {
      const res = await api('/team/todos', {
        method: 'POST',
        body: { owner: p.username, title: input.value.trim(), severity: SEVS[idx] },
      });
      refocusOwner = p.username;
      await load({});
      if (res.demoted?.length) toast(demotionMsg(res.demoted));
    } catch (err) {
      input.disabled = false;
      alert(err.message);
    }
  });

  const row = el('div', { class: 'tm-qa' }, dot, input);
  if (refocusOwner === p.username) {
    refocusOwner = null;
    requestAnimationFrame(() => input.focus());
  }
  return row;
}

function card(t) {
  const closed = t.status === 'done' || t.status === 'resolved';

  // The universal completion affordance: a circle that becomes a check. Marks
  // done optimistically so the strike is felt at the moment of the click, then
  // reloads for the real state.
  const check = el('button', {
    class: `tm-check${closed ? ' is-done' : ''}`, type: 'button',
    title: closed ? stateLabel(t) : 'Mark done',
    'aria-label': closed ? 'Completed' : 'Mark done',
    ...(closed ? { disabled: true } : {}),
  });
  if (!closed) {
    check.addEventListener('click', async () => {
      check.disabled = true;
      check.classList.add('is-done');
      check.closest('.tm-card')?.classList.add('is-closing');
      try { await api(`/team/todos/${t.id}`, { method: 'PATCH', body: { status: 'done' } }); await load({}); }
      catch (e) {
        check.disabled = false;
        check.classList.remove('is-done');
        check.closest('.tm-card')?.classList.remove('is-closing');
        alert(e.message);
      }
    });
  }

  // Todo ids are already t-prefixed (t12), so they are used as the element id
  // verbatim — a second prefix made #t12 links miss the card entirely.
  return el('article', { class: `tm-card tm-card--${t.severity}${closed ? ' is-closed' : ''}`, id: String(t.id) },
    el('div', { class: 'tm-card__top' },
      check,
      closed
        ? el('span', { class: `tm-sev tm-sev--${t.severity}`, title: SEV_META[t.severity] }, t.severity)
        : sevControl(t),
      el('h3', { class: 'tm-card__title' }, t.title),
      t.escalated ? el('span', { class: 'tm-tag tm-tag--esc' }, 'Escalated') : null,
      t.source === 'manual' ? el('span', { class: 'tm-tag' }, 'Added by hand') : null),

    t.detail ? el('p', { class: 'tm-card__detail' }, t.detail) : null,

    // The number and the threshold it crossed, so the item can be argued with
    // rather than only obeyed.
    t.metric
      ? el('p', { class: 'tm-card__metric' },
        el('b', {}, `${int(t.metric.value)}${t.metric.unit === '%' ? '%' : ` ${t.metric.unit}`}`),
        ` · flags above ${int(t.metric.threshold)}${t.metric.unit === '%' ? '%' : ''}`,
        t.domain ? ` · ${t.domain.replace(/_/g, ' ')}` : '')
      : null,

    el('div', { class: 'tm-card__foot' },
      t.status !== 'open' && !closed ? el('span', { class: 'tm-state' }, stateLabel(t)) : null,
      closed ? el('span', { class: 'tm-state' }, stateLabel(t)) : null,
      t.recurrences ? el('span', { class: 'tm-state tm-state--warn' }, `Came back ${t.recurrences}×`) : null,
      // Evidence goes to the exact chart or table that proves the number; when
      // no anchor exists (hand-added items), Acey walks it instead.
      t.link ? el('a', { class: 'tm-evidence', href: (window.__base__ || '') + t.link }, 'Evidence') : null,
      !t.link && !closed ? (() => {
        const b = el('button', { class: 'btn btn--ghost tm-btn', type: 'button' }, 'Ask Acey');
        b.addEventListener('click', () => window.__acey?.ask(
          `Walk me through the evidence behind this action item: "${t.title}"`
          + (t.detail ? ` — context: ${t.detail.slice(0, 300)}` : '')));
        return b;
      })() : null,
      closed ? null : actions(t),
      // Deleting is destruction, so it lives at the card's corner as ✕ — with an
      // Undo toast after, not a confirm before. Auto items are not deletable
      // (the next health sync would just recreate them), so no ✕ there.
      t.source === 'manual' && !closed ? (() => {
        const x = el('button', { class: 'tm-card__x', type: 'button', title: 'Delete', 'aria-label': 'Delete' }, '✕');
        x.addEventListener('click', async () => {
          x.disabled = true;
          try {
            await api(`/team/todos/${t.id}`, { method: 'DELETE' });
            await load({});
            toast(`Deleted "${t.title.slice(0, 44)}${t.title.length > 44 ? '…' : ''}"`, {
              label: 'Undo',
              fn: async () => {
                // Send the whole item back: re-POSTing the visible fields would
                // mint a new id and drop notes/claim/history.
                await api('/team/todos/restore', { method: 'POST', body: t });
                await load({});
              },
            });
          } catch (e) { x.disabled = false; alert(e.message); }
        });
        return x;
      })() : null));
}

function stateLabel(t) {
  if (t.status === 'claimed') return `Claimed by ${t.claimedBy || 'someone'}`;
  if (t.status === 'snoozed') return `Snoozed until ${String(t.snoozeUntil || '').slice(0, 10)}`;
  if (t.status === 'done') return `Done by ${t.doneBy || 'someone'}`;
  if (t.status === 'resolved') return 'Closed — the signal cleared';
  return '';
}

function actions(t) {
  // One control where four buttons used to be: assigning IS the verb — picking
  // yourself is what Claim was, picking someone else is what Reassign was, and
  // Snooze earned its keep for nobody. The checkbox owns completion; ✕ owns
  // deletion.
  const row = el('div', { class: 'tm-card__actions' });
  const sel = el('select', { class: 'select tm-reassign', 'aria-label': 'Assign to' },
    el('option', { value: '' }, `Assign · ${firstName(t.owner)}`),
    ...data.people.map((p) => el('option', {
      value: p.username, ...(p.username === t.owner ? { disabled: true } : {}),
    }, p.username === me ? `Me (${p.name.split(' ')[0]})` : p.name)));
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try {
      await api(`/team/todos/${t.id}`, { method: 'PATCH', body: { owner: sel.value } });
      await load({});
    } catch (e) { alert(e.message); }
  });
  row.append(sel);
  return row;
}

// The priority chip is also the way priority changes — including crowning a
// new P00. The server enforces the singleton; the toast explains the demotion
// so the board does not just silently look different.
function sevControl(t) {
  const sel = el('select', {
    class: `tm-sev tm-sev--${t.severity} tm-sev--sel`,
    'aria-label': 'Priority', title: `${SEV_META[t.severity]} — click to change`,
  }, ...Object.keys(SEV_META).map((k) =>
    el('option', { value: k, ...(k === t.severity ? { selected: true } : {}) }, k.toUpperCase())));
  sel.addEventListener('change', async () => {
    try {
      // The server owns the demotion list — reconstructing it from pre-PATCH
      // data is wrong the moment someone else crowned in between.
      const res = await api(`/team/todos/${t.id}`, { method: 'PATCH', body: { severity: sel.value } });
      await load({});
      if (res.demoted?.length) toast(demotionMsg(res.demoted));
    } catch (e) { alert(e.message); }
  });
  return sel;
}

function demotionMsg(demoted) {
  const name = demoted[0].title || String(demoted[0].id);
  const clipped = name.length > 40 ? `${name.slice(0, 40)}…` : name;
  const more = demoted.length > 1 ? ` (and ${demoted.length - 1} more)` : '';
  return `P00 is exclusive — "${clipped}"${more} moved down to P0.`;
}

const firstName = (username) => (data.people.find((p) => p.username === username)?.name || username).split(' ')[0];

// ---------------------------------------------------------------------------
// Export — one-liners for the running-history doc
// ---------------------------------------------------------------------------

// The SSOT gdoc keeps a running history of action items; this turns the
// visible view into paste-ready bullets. Clipboard first; if the browser
// refuses (permissions, plain http), a selectable box appears instead of a
// silent failure.
function exportItems() {
  const items = allItems().filter(matches);
  if (!items.length) return toast('Nothing to export in this view.');
  const day = new Date().toISOString().slice(0, 10);
  const text = [
    `RLI action items — ${day}${view === 'all' ? '' : ` (${view})`}`,
    ...items.map((t) => `• [${t.severity.toUpperCase()}] ${firstName(t.owner)} — ${t.title}`
      + (t.status === 'done' || t.status === 'resolved' ? ' (closed)' : '')),
  ].join('\n');

  const fallback = () => showExportBox(text);
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(text).then(
    () => toast(`Copied ${items.length} action item${items.length === 1 ? '' : 's'} — paste into the doc.`),
    fallback);
}

function showExportBox(text) {
  const ta = el('textarea', { class: 'tm-export__ta', readonly: 'readonly' }, text);
  const box = el('div', { class: 'tm-export' },
    el('div', { class: 'tm-export__head' }, 'Select and copy',
      el('button', { class: 'btn btn--ghost tm-btn', type: 'button', onclick: () => box.remove() }, 'Close')),
    ta);
  document.body.append(box);
  ta.focus();
  ta.select();
}

// One toast at a time, bottom-center, with an optional action — the Undo after
// a delete lives here.
let toastEl = null;
function toast(message, action) {
  toastEl?.remove();
  const t = el('div', { class: 'tm-toast', role: 'status' }, el('span', {}, message));
  if (action) {
    const b = el('button', { class: 'tm-toast__act', type: 'button' }, action.label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await action.fn(); t.remove(); } catch (e) { alert(e.message); }
    });
    t.append(b);
  }
  document.body.append(t);
  toastEl = t;
  setTimeout(() => { if (t.isConnected) t.remove(); }, 7000);
}

// Matched to the real layout so the page does not jump when data lands.
function showSkeleton() {
  $('tm-sub').textContent = 'Checking project health…';
  mount($('tm-filters'), ...Array.from({ length: 5 }, () => el('div', { class: 'tm-filter tm-skel' })));
  mount($('tm-owners'), ...Array.from({ length: 3 }, () => el('section', { class: 'tm-owner tm-skel tm-skel--card' })));
}

mountAcey({ page: 'team' });
