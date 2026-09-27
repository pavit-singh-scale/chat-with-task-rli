import { api, el, mount, renderAppHeader, avatar, flashHash } from './common.js';
import { mountChart, clearChart, deliveryColumns, intakeColumns, readinessFunnel, stackedArea, hBars, legend } from './charts.js';
import { mountAcey } from './acey.js';

// The Overview page.
//
// Load order matters here: the brief is cached Redash and comes back in about a
// second, the summary is a model call that can take much longer. They are
// fetched independently so the charts paint immediately and the prose lands
// when it lands, rather than the page sitting blank behind the LLM.

// Mirrors STAGES in src/overview.js: the bands ARE the levels. L1/L4/L8 are
// blocked work, not a step on the forward path, so they map to null and are
// reported separately rather than being folded into a neighbouring band.
const STAGE_LABELS = {
  l_minus1: 'L-1',
  l0: 'L0',
  l10: 'L10',
  l12: 'L12',
};
const STAGE_ORDER = ['l_minus1', 'l0', 'l10', 'l12'];
const LEVEL_STAGE = { '-1': 'l_minus1', 0: 'l0', 10: 'l10', 12: 'l12' };
const stageOf = (lvl) => LEVEL_STAGE[String(lvl)] || null;

const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const $ = (id) => document.getElementById(id);

let brief = null;
let me = null;

init();

async function init() {
  const user = await api('/me').catch(() => null);
  me = user?.username || null;
  renderAppHeader({ active: 'overview', user });

  $('ov-regen').addEventListener('click', () => loadSummary({ refresh: true }));

  try {
    brief = await api('/overview/brief');
  } catch (e) {
    $('ov-headline').textContent = 'Could not load the brief';
    mount($('ov-prose'), el('p', { class: 'ov-error' }, e.message));
    $('ov-hero').setAttribute('aria-busy', 'false');
    return;
  }

  renderClock(brief);
  renderActionItems();
  renderCharts(brief);
  renderFoot(brief);
  // Both are slower than the brief and independent of each other, so neither
  // blocks the page or the other.
  loadSummary({});
  loadInflight();
  loadBlocked();
  // Evidence deep links from the Team board land on a chart or section id.
  flashHash();
  // Acey adds items from its panel on this very page; keep the block current.
  document.addEventListener('acey:todos-changed', renderActionItems);
}

// ---------------------------------------------------------------------------
// hero
// ---------------------------------------------------------------------------

function renderClock(b) {
  const c = b.calendar;
  $('ov-headline').textContent = c.headline;
  $('ov-clock').textContent = b.now.label;

  const chip = (cls, label, value) =>
    el('div', { class: `ov-stat ${cls}` }, el('span', { class: 'ov-stat__v' }, value), el('span', { class: 'ov-stat__k' }, label));

  const p = b.pipeline;
  // The headline number is DELIVERABLE (L12), not a roll-up of upstream stages.
  // Reporting the sum as "within reach" made a 289-task shortfall read as 43.
  mount($('ov-countdown'),
    chip('', c.isDeliveryDay ? 'delivery is today' : `days to ${c.deliveryWeekday}`, c.isDeliveryDay ? '—' : String(c.daysUntil)),
    // The target can belong to a LATER delivery than the next one (RLI: none
    // for 09-28, 50 for 10-05) — say which, so nobody reads it as due Monday.
    p ? chip('', `deliverable of ${int(b.target)}${b.targetDate && b.targetDate !== c.nextDeliveryDate ? ` for ${shortDate(b.targetDate)}` : ''}${b.targetAssumed ? ' (assumed)' : ''}`, int(p.deliverable)) : null,
    p ? chip(p.gapToTarget > 0 ? 'ov-stat--warn' : 'ov-stat--ok',
      p.gapToTarget > 0 ? 'still to reach L12' : `target ${b.target}`,
      p.gapToTarget > 0 ? int(p.gapToTarget) : 'met') : null);
}

async function loadSummary({ refresh }) {
  const prose = $('ov-prose');
  const btn = $('ov-regen');
  btn.disabled = true;
  btn.textContent = refresh ? 'Regenerating…' : 'regenerate';
  // On a refetch the previous synthesis is held at reduced opacity rather than
  // swapped for skeletons: the text is still true while the new one generates,
  // and replacing it would jump the layout by several lines for ~15 seconds.
  // The first load is the only case with nothing to hold, and it keeps its
  // skeletons from the markup.
  if (refresh) prose.classList.add('is-stale');
  try {
    const s = await api(`/overview/summary${refresh ? '?refresh=1' : ''}`);
    if (s.text) {
      // The headline is already the page's h1; the model repeats it verbatim as
      // its opening sentence, so strip that one duplicate rather than showing it
      // twice. Anything else it wrote is left exactly as written.
      const body = s.text.startsWith(s.headline) ? s.text.slice(s.headline.length).trim() : s.text;
      // Paragraphs as text nodes, not markdown. The synthesis is prose by
      // construction — the system prompt forbids headings, lists and emoji — so
      // there is nothing to parse, and this keeps model output off innerHTML
      // instead of trusting it with an HTML parser.
      mount(prose, ...body.split(/\n\s*\n/).map((para) => el('p', {}, para.trim())).filter((p) => p.textContent));
      $('ov-stamp').textContent = s.cached
        ? `synthesis cached${s.generatedAt ? ` · ${new Date(s.generatedAt).toLocaleString()}` : ''}`
        : `synthesis generated ${new Date(s.generatedAt || Date.now()).toLocaleTimeString()}`;
    } else {
      // The deterministic half of the page is unaffected, so say what's missing
      // and leave everything else standing.
      mount(prose, el('p', { class: 'ov-error' },
        `Synthesis unavailable — ${s.error || 'the model returned nothing'}. The numbers below are unaffected.`));
      $('ov-stamp').textContent = '';
    }
  } catch (e) {
    mount(prose, el('p', { class: 'ov-error' }, `Synthesis unavailable — ${e.message}. The numbers below are unaffected.`));
  } finally {
    prose.classList.remove('is-stale');
    btn.disabled = false;
    btn.textContent = 'Regenerate';
    $('ov-hero').setAttribute('aria-busy', 'false');
  }
}

// Action items, read straight off the Team board and linked back into it.
//
// This replaces two earlier surfaces: a personal "N for you" strip and a
// weekly round-robin of board chores that treated four people with different
// jobs as interchangeable. One block now, showing the same cards the Team page
// renders — same ids, same severities — so clicking any item lands on that
// exact card over there, flashed. Never a derived copy that can drift.
async function renderActionItems() {
  const host = $('ov-actions');
  if (!host) return;
  let board;
  try {
    board = await api('/team/items');
  } catch {
    return; // the Team page is the source of truth; a broken block beats a wrong one
  }
  const base = window.__base__ || '';
  // Me first, then team order — the question this block answers starts with
  // "what do I owe", then widens.
  const people = board.people
    .filter((p) => p.todos.length)
    .sort((a, b) => (b.username === me) - (a.username === me));

  const head = el('div', { class: 'ov-actions__head' },
    el('h2', {}, 'Action items'),
    el('span', { class: 'ov-actions__hint' }, 'Live from the Team board — click through to claim or close.'),
    el('a', { class: 'ov-actions__link', href: `${base}/team.html` }, 'Team board →'));

  if (!people.length) {
    return mount(host, head,
      el('p', { class: 'ov-actions__empty' }, 'Nothing open on the team board.'));
  }

  const TOP = 3;
  mount(host, head, el('div', { class: 'ov-actions__grid' }, ...people.map((p) => el('article', { class: 'ova-person' },
    el('header', { class: 'ova-person__head' },
      avatar(p.username),
      el('span', { class: 'ova-person__name' }, p.name.split(' ')[0]),
      el('span', { class: 'ova-person__n' },
        `${p.live} open${p.doneWeek ? ` · ${p.doneWeek} done` : ''}`)),
    ...p.todos.slice(0, TOP).map((t) => el('div', { class: 'ova-item' },
      el('span', { class: `tm-sev tm-sev--${t.severity}` }, t.severity),
      el('a', { href: `${base}/team.html#${t.id}`, title: t.title }, t.title))),
    p.todos.length > TOP
      ? el('a', { class: 'ova-more', href: `${base}/team.html#owner-${p.username}` },
        `+${p.todos.length - TOP} more`)
      : null))));
}

// ---------------------------------------------------------------------------
// charts
// ---------------------------------------------------------------------------

function renderCharts(b) {
  if (!b.redash?.enabled) {
    for (const id of ['chart-deliveries', 'chart-funnel', 'chart-intake', 'chart-throughput', 'chart-cost', 'chart-rework']) {
      mount($(id), el('p', { class: 'ov-error' }, 'Redash is not configured (REDASH_API_KEY unset).'));
    }
    return;
  }

  // 1 — delivery volume vs target
  if (b.deliveries?.history?.length) {
    const d = b.deliveries;
    $('ov-delivery-sub').textContent =
      `${d.history.length} batches. Last was ${int(d.last.tasks)} on ${d.last.date}; trailing four average ${int(d.trailingAvg)}.`;
    mountChart($('chart-deliveries'), deliveryColumns({ history: d.history, target: b.target }));
  }

  // 2 — supply funnel. Only the Final band is deliverable; the rest is supply
  // that still has to reach L12, and the caption says so rather than letting the
  // cumulative total imply the target is covered.
  if (b.pipeline?.stages?.length) {
    const p = b.pipeline;
    // The bands are L-1, L0, L10, L12. Blocked levels are not on that path, so
    // they are stated here rather than quietly missing from the running total.
    const blocked = p.blocked?.pending
      ? ` ${int(p.blocked.pending)} more are blocked at `
        + `${p.blocked.byLevel.map((x) => `L${x.level}`).join(' / ')} and are not counted below.`
      : '';
    $('ov-funnel-sub').textContent =
      `${int(p.deliverable)} of the ${int(b.target)}${b.targetDate ? ` targeted for ${shortDate(b.targetDate)}` : ''} are deliverable now (L12) — ${p.progressPct}%. `
      + `${int(p.feeder)} sit at L10 and ${int(p.upstream)} further back; running totals below assume every one of them reaches L12 in time`
      + `${p.supplyShortfall > 0 ? `, which would still leave ${int(p.supplyShortfall)} short` : ''}.${blocked}`;
    mountChart($('chart-funnel'), readinessFunnel({ stages: p.stages, target: b.target }));
  }

  // 2c — deliverable intake. The summary cites the cycle-to-date comparison, so
  // it needs to be visible somewhere rather than only asserted in prose.
  if (b.intake?.days?.length) {
    const ik = b.intake;
    const pace = ik.lastCycleToDate != null && ik.lastCycleToDate > 0
      ? ` That is ${Math.round((ik.thisCycle / ik.lastCycleToDate) * 100)}% of the ${int(ik.lastCycleToDate)} reached by the same point last cycle.`
      : '';
    $('ov-intake-sub').textContent =
      `Level 12 is the deliverable state. ${int(ik.thisCycle ?? 0)} have entered it since the last delivery `
      + `(${ik.lastDelivery}, ${ik.offsetDays} day${ik.offsetDays === 1 ? '' : 's'} ago).${pace}`;
    mountChart($('chart-intake'), intakeColumns({
      days: ik.days,
      deliveries: (b.deliveries?.history || []).map((d) => d.date),
      cycleStart: ik.lastDelivery,
    }));
  }

  // 3 — throughput per level
  if (b.throughput?.length) {
    const days = [...new Set(b.throughput.map((r) => r.day))].sort();
    const idx = new Map(days.map((d, i) => [d, i]));
    const series = Object.fromEntries(STAGE_ORDER.map((k) => [k, days.map(() => 0)]));
    // stageOf is null for the blocked levels, which have no band on an ordinal
    // ramp. Skipping them keeps the chart honest; the count goes in the caption.
    let offPath = 0;
    for (const r of b.throughput) {
      const k = stageOf(r.level);
      if (!k) { offPath += r.tasks; continue; }
      series[k][idx.get(r.day)] += r.tasks;
    }
    mountChart($('chart-throughput'), stackedArea({ days, stageKeys: STAGE_ORDER, stageLabels: STAGE_LABELS, series }));
    mount($('chart-throughput-legend'), legend(STAGE_ORDER.map((k) => ({ key: k, label: STAGE_LABELS[k] }))));
    if (offPath) {
      $('ov-tp-sub').textContent += ` A further ${int(offPath)} touches at L1/L4/L8 are not shown — see Blocked upstream.`;
    }
  }

  // 4 & 5 — two measures, two charts, never one dual axis
  const ec = (b.economics || []).filter((e) => e.attempts > 0);
  if (ec.length) {
    const totalHours = ec.reduce((a, e) => a + e.totalHours, 0);
    const top = [...ec].sort((a, b2) => b2.totalHours - a.totalHours)[0];
    $('ov-cost-sub').textContent =
      `Last ${b.windowDays} days. L${top.level} is ${Math.round((top.totalHours / totalHours) * 100)}% of ${int(totalHours)} billed hours.`;
    mountChart($('chart-cost'), hBars({
      rows: [...ec].sort((a, b2) => b2.totalHours - a.totalHours).map((e) => ({
        label: `L${e.level}`,
        // Blocked levels have no band on the ramp; they get the neutral fill
        // rather than borrowing a forward level's colour.
        stageKey: stageOf(e.level) || 'blocked',
        totalHours: e.totalHours,
        tip: `<b>L${e.level}</b><br>`
          + `${int(e.totalHours)}h tracked vs ${int(e.activeHours)}h active<br>`
          + (e.uselessHours
            ? `${int(e.billableHours)}h billable, <b>${int(e.uselessHours)}h wasted</b> (${e.uselessPct}%)<br>`
            : '')
          + `${int(e.attempts)} attempts · ${e.avgHours}h avg, ${e.medianHours}h median`,
      })),
      valueKey: 'totalHours',
      format: (v) => `${int(v)}h`,
      note: 'Hover a bar for billed-vs-active hours and the per-attempt average.',
    }));

    const rw = [...ec].sort((a, b2) => b2.pctRejected - a.pctRejected);
    const worst = rw[0];
    $('ov-rework-sub').textContent = worst.pctRejected > 0
      ? `Last ${b.windowDays} days. L${worst.level} is the highest at ${worst.pctRejected}%.`
      : `Last ${b.windowDays} days. Nothing is being sent back.`;
    mountChart($('chart-rework'), hBars({
      rows: rw.map((e) => ({
        label: `L${e.level}`,
        pctRejected: e.pctRejected,
        tip: `<b>L${e.level}</b><br>${e.pctRejected}% of ${int(e.attempts)} attempts rejected`,
      })),
      valueKey: 'pctRejected',
      format: (v) => `${v}%`,
      accent: 'status',
      threshold: 25,
      note: 'Amber at 25% and above — each rejection re-runs an earlier level.',
    }));
  }
}

// ---------------------------------------------------------------------------
// in-flight tasks + matchups, with layer toggles
// ---------------------------------------------------------------------------

// Fetched separately from the brief and filtered in memory, so toggling a layer
// is instant rather than a round trip. `selected` is the source of truth; every
// render reads it, nothing derives state from the DOM.
let inflight = null;
const selected = new Set();

async function loadInflight() {
  const host = $('chart-matchups');
  try {
    inflight = await api('/overview/inflight');
  } catch (e) {
    clearChart(host, el('p', { class: 'ov-error' }, `Could not load in-flight tasks — ${e.message}`));
    return;
  }
  if (!inflight.enabled) {
    clearChart(host, el('p', { class: 'ov-error' }, 'Redash is not configured (REDASH_API_KEY unset).'));
    return;
  }
  if (inflight.error) {
    clearChart(host, el('p', { class: 'ov-error' }, `Query failed — ${inflight.error}`));
    return;
  }
  // Every layer on by default: the question is "what is in flight", and starting
  // with a partial view would misrepresent the total.
  for (const l of inflight.levels) selected.add(l.level);
  renderLayerToggles();
  renderMatchups();
}

const LEVEL_LABEL = (lvl) => `L${lvl}`;

// Two different kinds of blank, deliberately not merged. See renderMatchups.
const NOT_RECORDED = '(not yet recorded)';
const ONE_SIDE = '(one arm recorded)';

function renderLayerToggles() {
  const host = $('ov-layers');
  const chips = inflight.levels.map((l) => {
    const on = selected.has(l.level);
    const btn = el('button', {
      class: `ov-layer${on ? ' is-on' : ''}`, type: 'button',
      'aria-pressed': on ? 'true' : 'false',
      title: `${l.total} in flight at level ${l.level}, ${l.withMatchup} with a recorded matchup`,
    }, LEVEL_LABEL(l.level), el('span', { class: 'ov-layer__n' }, String(l.total)));
    btn.addEventListener('click', () => {
      if (selected.has(l.level)) selected.delete(l.level); else selected.add(l.level);
      renderLayerToggles();
      renderMatchups();
    });
    return btn;
  });

  // All/none is the only pair of shortcuts worth having with six layers.
  const all = el('button', { class: 'ov-layer ov-layer--act', type: 'button' }, 'All');
  all.addEventListener('click', () => {
    for (const l of inflight.levels) selected.add(l.level);
    renderLayerToggles(); renderMatchups();
  });
  const none = el('button', { class: 'ov-layer ov-layer--act', type: 'button' }, 'None');
  none.addEventListener('click', () => {
    selected.clear(); renderLayerToggles(); renderMatchups();
  });

  mount(host, ...chips, el('span', { class: 'ov-layers__sep' }), all, none);
}

function renderMatchups() {
  const rows = inflight.rows.filter((r) => selected.has(r.level));
  const known = rows.filter((r) => r.matchup).length;
  const half = rows.filter((r) => r.matchupState === 'one_side').length;

  $('ov-mu-sub').textContent = selected.size === 0
    ? 'No layers selected.'
    : `${int(rows.length)} task${rows.length === 1 ? '' : 's'} in flight across `
      + `${selected.size} of ${inflight.levels.length} layers — ${int(known)} with a recorded matchup`
      + (half ? `, ${int(half)} with one arm so far.` : '.');

  // Recount per matchup over the FILTERED rows, so the bars answer the question
  // the toggles just asked rather than showing project-wide totals.
  //
  // The two blank cases are kept apart. "Nothing recorded" is overwhelmingly
  // tasks nobody has worked yet, which is an absence of work; "one arm recorded"
  // is a task mid-generation with half its pairing already known. Merging them
  // buries a real state inside a much larger nothing-to-see-here bucket.
  const counts = new Map();
  for (const r of rows) {
    const k = r.matchup || (r.matchupState === 'one_side' ? ONE_SIDE : NOT_RECORDED);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const bars = [...counts.entries()]
    .sort((a, b) => {
      const rank = (k) => (k === NOT_RECORDED ? 2 : k === ONE_SIDE ? 1 : 0);
      return rank(a[0]) - rank(b[0]) || b[1] - a[1];
    })
    .map(([matchup, n]) => ({
      label: matchup.replace(/\s+vs\s+/, ' vs '),
      count: n,
      tip: `<b>${matchup.replace(/\s+vs\s+/, ' vs ')}</b><br>${int(n)} of ${int(rows.length)} selected`
        + `<br>${Math.round((n / Math.max(1, rows.length)) * 100)}% of the current selection`,
    }));

  if (!bars.length) {
    // clearChart, not mount: the host may hold a live chart whose ResizeObserver
    // would otherwise redraw it over this message.
    clearChart($('chart-matchups'), el('p', { class: 'ov-mu-empty' }, 'Nothing in flight in the selected layers.'));
  } else {
    // Model names are long and vary, so the label gutter is sized from the
    // longest one actually present rather than left at the default.
    const longest = Math.max(...bars.map((b2) => b2.label.length));
    mountChart($('chart-matchups'), hBars({
      rows: bars, valueKey: 'count', format: (v) => int(v),
      labelWidth: Math.min(330, Math.max(90, Math.round(longest * 6.4) + 18)),
      note: 'Model names as recorded upstream. A pairing is order-normalised, so X vs Y and Y vs X count together.',
    }));
  }

  // Oldest first — that is the actionable order for anything in flight.
  const sorted = [...rows].sort((a, b) => b.ageDays - a.ageDays || a.level.localeCompare(b.level));
  const table = $('ov-mu-table');
  const head = el('tr', {},
    el('th', {}, 'Task'), el('th', {}, 'Level'), el('th', { class: 'ov-num' }, 'Age'), el('th', {}, 'Matchup'));
  mount(table,
    el('thead', {}, head),
    el('tbody', {}, ...sorted.slice(0, 400).map((r) => el('tr', {},
      el('td', { class: 'mono' }, r.taskId),
      el('td', {}, LEVEL_LABEL(r.level)),
      el('td', { class: 'ov-num' }, `${r.ageDays}d`),
      // A half-recorded pairing still names one of the models, and saying so is
      // strictly more useful than reporting the whole row as unknown.
      el('td', { class: r.matchup ? '' : 'ov-mu-none' },
        r.matchup ? r.matchup.replace(/\s+vs\s+/, '  vs  ')
          : r.matchupState === 'one_side'
            ? `${r.modelA ? `A: ${r.modelA}` : `B: ${r.modelB}`} · other arm pending`
            : 'not yet recorded')))));

  // Say so when the table is capped, rather than letting 400 look like all of it.
  $('ov-mu-foot').textContent = sorted.length > 400
    ? `Showing the 400 oldest of ${int(sorted.length)} selected tasks.`
    : (sorted.length ? `All ${int(sorted.length)} selected tasks shown, oldest first.` : '');
}

// ---------------------------------------------------------------------------
// blocked backlog
// ---------------------------------------------------------------------------

// L1 and L8 are not queue levels — a task lands there because something is wrong
// with it and stays until a person fixes it. Everywhere else on this page they
// are two small bars inside a pending count, which is exactly where the oldest
// work in the project has been hiding.
let blocked = null;
const lanesOn = new Set();

async function loadBlocked() {
  const sub = $('ov-blk-sub');
  try {
    blocked = await api('/overview/blocked');
  } catch (e) {
    sub.textContent = `Could not load blocked tasks — ${e.message}`;
    return;
  }
  if (!blocked.enabled) {
    sub.textContent = 'Redash is not configured (REDASH_API_KEY unset).';
    return;
  }
  for (const l of blocked.lanes) lanesOn.add(l.level);
  renderLaneChips();
  renderBlocked();
}

function renderLaneChips() {
  const chips = blocked.lanes.map((l) => {
    const on = lanesOn.has(l.level);
    const btn = el('button', {
      class: `ov-layer${on ? ' is-on' : ''}`, type: 'button',
      'aria-pressed': on ? 'true' : 'false',
      // The chip says the level. What the level MEANS goes in the tooltip —
      // everyone here says "L8", not "the engineering issues lane".
      title: `${l.label} — ${l.hint}. ${l.tasks} blocked, oldest ${l.oldestDays}d, ${int(l.hoursSunk)}h already spent`,
    }, `L${l.level}`, el('span', { class: 'ov-layer__n' }, String(l.tasks)));
    btn.addEventListener('click', () => {
      if (lanesOn.has(l.level)) lanesOn.delete(l.level); else lanesOn.add(l.level);
      renderLaneChips();
      renderBlocked();
    });
    return btn;
  });
  mount($('ov-blk-lanes'), ...chips);
}

function renderBlocked() {
  const rows = blocked.rows.filter((r) => lanesOn.has(r.level))
    .sort((a, b) => b.daysBlocked - a.daysBlocked);

  // Hours already spent is what makes this a priority rather than a curiosity:
  // the work is done, it just cannot move.
  const sunk = rows.reduce((a, r) => a + r.hoursSunk, 0);
  const week = rows.filter((r) => r.daysBlocked >= 7).length;
  $('ov-blk-sub').textContent = rows.length
    ? `${int(rows.length)} task${rows.length === 1 ? '' : 's'} blocked — `
      + `${int(week)} for a week or more, ${int(Math.round(sunk))} hours of work already sunk into them.`
    : (lanesOn.size ? 'Nothing blocked in the selected lanes.' : 'No lanes selected.');

  const head = el('tr', {},
    el('th', {}, 'Task'), el('th', {}, 'Lane'),
    el('th', { class: 'ov-num' }, 'Blocked'), el('th', {}, 'Came from'),
    el('th', {}, 'Author'), el('th', { class: 'ov-num' }, 'Attempts'),
    el('th', { class: 'ov-num' }, 'Hours in'));

  mount($('ov-blk-table'),
    el('thead', {}, head),
    el('tbody', {}, ...rows.slice(0, 200).map((r) => el('tr', { class: r.daysBlocked >= 7 ? 'ov-blk-old' : '' },
      el('td', { class: 'mono' }, r.taskId),
      el('td', {}, `L${r.level}`),
      el('td', { class: 'ov-num' }, `${r.daysBlocked}d`),
      el('td', {}, r.cameFromLevel == null
        ? el('span', { class: 'ov-mu-none' }, 'unknown')
        : `L${r.cameFromLevel}`),
      // A task can reach a problem lane without ever having been authored, in
      // which case there is nobody to route it back to — say so rather than
      // rendering an empty cell that reads like a loading failure.
      el('td', { title: r.authorEmail || '' }, r.author || el('span', { class: 'ov-mu-none' }, 'never attempted')),
      el('td', { class: 'ov-num' }, String(r.attempts)),
      el('td', { class: 'ov-num' }, r.hoursSunk ? `${r.hoursSunk}h` : el('span', { class: 'ov-mu-none' }, '—'))))));

  $('ov-blk-foot').textContent = rows.length > 200
    ? `Showing the 200 longest-blocked of ${int(rows.length)}.`
    : (rows.length ? `All ${int(rows.length)} shown, longest-blocked first.` : '');
}

function renderFoot(b) {
  const base = window.__base__ || '';
  mount($('ov-foot'),
    document.createTextNode('Pipeline data via Redash · delivery clock anchored to America/Los_Angeles · '),
    // Every chart on this page is one of four registry queries, so the raw rows
    // behind it are readable as a table (and downloadable as CSV) on the Redash
    // page. That is the non-visual path to these numbers.
    el('a', { href: `${base}/redash.html` }, 'view the underlying rows as tables'),
    b.errors?.length
      ? el('span', { class: 'ov-error' },
        ` · ${b.errors.length} query error(s): ` + b.errors.map((e) => `${e.query} — ${e.error}`).join('; '))
      : null);
}


// Acey is available from every page, not just inside a task.
mountAcey({ page: 'overview' });

// "2026-10-05" → "Mon Oct 5" (dates are PT calendar days; noon UTC avoids TZ drift).
function shortDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).replace(',', '');
}
