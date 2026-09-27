import { api, el, renderAppHeader, flashHash } from './common.js';
import { initPipelinePanels } from './redash_panels.js';
import { initQualityPanels } from './quality_panels.js';
import { mountAcey } from './acey.js';

const VERDICT_LABEL = {
  NO_ISSUES: 'No fixes', FIXES_MADE: 'Fixes made', SBQ: 'SBQ',
  SECOND_OPINION: '2nd opinion', none: 'Undecided',
};
const SEV_LABEL = { PASS: 'No issues', SOFT_FAIL: 'Non-fail', HARD_FAIL: 'Fail', UNSORTED: 'Unsorted' };
const GATE = { golden: 97, ad1: 70, ad2: 50 };

let data = null;
let lbSort = { key: 'avgScore', dir: 1 };

// Display name: drop the vendor path ("anthropic/…", "xai/…") and the "claude-" family
// prefix so the distinguishing part (opus-4-6, sonnet-4-6, grok-4.5) is what shows.
// Full raw name is kept in the title tooltip. Codenames pass through unchanged.
function displayModel(name) {
  let s = String(name);
  if (s.includes('/')) s = s.slice(s.lastIndexOf('/') + 1);
  return s.replace(/^claude-/, '');
}
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const num1 = (x) => (x == null ? '—' : `${Math.round(x * 10) / 10}`);

function statCard(value, label) {
  return el('div', { class: 'stat-card glass' },
    el('div', { class: 'stat-value' }, String(value)),
    el('div', { class: 'stat-label' }, label));
}

function renderCards() {
  const g = data.gates;
  const rate = (n) => (g.scored ? `${n}/${g.scored}` : '—');
  document.getElementById('l12-cards').replaceChildren(
    statCard(data.total, 'Tasks'),
    statCard(`${num1(data.avg.golden)}%`, `Avg RD · ${rate(g.golden)} ≥ ${GATE.golden}`),
    statCard(`${num1(data.avg.ad1)}%`, `Avg AD1 · ${rate(g.ad1)} ≤ ${GATE.ad1}`),
    statCard(`${num1(data.avg.ad2)}%`, `Avg AD2 · ${rate(g.ad2)} ≤ ${GATE.ad2}`),
    statCard(rate(g.all), 'Clear every score gate'),
  );
}

// A labeled row of proportional segments (verdict / severity breakdown).
function breakdownCard(title, counts, order, labels, cls) {
  const total = order.reduce((s, k) => s + (counts[k] || 0), 0) || 1;
  const bar = el('div', { class: 'l12-bar' },
    ...order.filter((k) => counts[k]).map((k) =>
      el('div', { class: `l12-seg seg-${cls}-${k}`, style: `flex:${counts[k]}`, title: `${labels[k]}: ${counts[k]}` })));
  const legend = el('div', { class: 'l12-legend' },
    ...order.map((k) => el('span', { class: 'l12-legend-item' },
      el('span', { class: `l12-dot seg-${cls}-${k}` }),
      `${labels[k]} `, el('b', {}, String(counts[k] || 0)),
      el('span', { class: 'l12-legend-pct' }, ` ${Math.round((counts[k] || 0) / total * 100)}%`))));
  return el('div', { class: 'l12-move-card glass' }, el('h3', {}, title), bar, legend);
}

function renderMovement() {
  document.getElementById('l12-movement').replaceChildren(
    breakdownCard('Reviewer decisions', data.verdicts,
      ['NO_ISSUES', 'FIXES_MADE', 'SBQ', 'SECOND_OPINION', 'none'], VERDICT_LABEL, 'v'),
    breakdownCard('Severity (eval buckets)', data.severity,
      ['PASS', 'SOFT_FAIL', 'HARD_FAIL', 'UNSORTED'], SEV_LABEL, 's'),
  );
}

// ---- models (sortable) ----
function sortVal(m, key) {
  if (key === 'name') return m.name;
  if (key === 'h2h') { const d = m.h2h.wins + m.h2h.losses; return d ? m.h2h.wins / d : -1; }
  return m[key] ?? (lbSort.dir > 0 ? 999 : -1);
}
function setSort(key) {
  if (lbSort.key === key) lbSort.dir *= -1;
  else lbSort = { key, dir: key === 'name' || key === 'avgScore' || key === 'vsRd' ? 1 : -1 };
  renderLeaderboard();
}
function th(label, key, extra, title) {
  const active = lbSort.key === key;
  return el('th', { class: `sortable${active ? ' sorted' : ''}${extra ? ' ' + extra : ''}`, title: title || '', onclick: () => setSort(key) },
    label, active ? el('span', { class: 'sort-caret' }, lbSort.dir < 0 ? ' ▾' : ' ▴') : '');
}
// 1–7 preference mean → words, from the right-hand side's point of view.
const vsRdWord = (x) => (x == null ? '' : x < 2 ? 'RD far better' : x < 3.5 ? 'RD better' : x <= 4.5 ? 'comparable' : 'beats RD');
function renderLeaderboard() {
  const rows = [...data.leaderboard].sort((a, b) => {
    const va = sortVal(a, lbSort.key), vb = sortVal(b, lbSort.key);
    return va < vb ? -lbSort.dir : va > vb ? lbSort.dir : 0;
  });
  const head = el('tr', {},
    th('Model', 'name', 'l12-model-h'),
    th('Tasks', 'tasks', '', 'Tasks where this model produced AD1 or AD2'),
    el('th', {}, 'Slot'),
    th('Avg score', 'avgScore', '', 'Mean rubric score in its slot — lower = the task stumps it more'),
    th('Gate pass', 'gatePassRate', '', 'Share of its tasks under the stumping gate for its slot (AD1 ≤ 70, AD2 ≤ 50)'),
    th('vs RD', 'vsRd', '', 'Mean RD-vs-model preference, 1 = RD much better … 4 = comparable … 7 = model better'),
    th('Head to head', 'h2h', '', 'AD1 vs AD2 preference: wins–losses–ties against the other model'));
  const body = rows.map((m) => {
    const slot = [m.slots.ad1 && `AD1 ×${m.slots.ad1}`, m.slots.ad2 && `AD2 ×${m.slots.ad2}`].filter(Boolean).join(' · ');
    const h = m.h2h;
    return el('tr', {},
      el('td', { class: 'l12-model' }, el('span', { class: 'mono', title: m.name }, displayModel(m.name))),
      el('td', {}, String(m.tasks)),
      el('td', { class: 'l12-n' }, slot),
      el('td', {}, el('b', {}, m.avgScore == null ? '—' : `${num1(m.avgScore)}%`)),
      el('td', {}, el('span', { class: `l12-win ${m.gatePassRate == null ? '' : m.gatePassRate >= 0.9 ? 'good' : 'bad'}` }, pct(m.gatePassRate))),
      el('td', {}, el('b', {}, num1(m.vsRd)), el('span', { class: 'l12-n' }, ` ${vsRdWord(m.vsRd)}`)),
      el('td', {}, `${h.wins}–${h.losses}–${h.ties}`));
  });
  const t = document.getElementById('l12-leaderboard');
  t.replaceChildren(head, ...body);
  if (!body.length) t.append(el('tr', {}, el('td', { class: 'empty', colspan: '7' }, 'No model data in this scope.')));
}

// ---- pairwise preferences ----
function renderPrefs() {
  const wrap = document.getElementById('l12-prefs');
  const cards = data.prefs.filter((p) => p.n).map((p) => {
    const lean = (x) => (x == null ? '' : x < 3.5 ? p.left : x > 4.5 ? p.right : 'even');
    return el('div', { class: 'l12-pref glass' },
      el('div', { class: 'l12-pref__head' },
        el('b', {}, `${p.left} vs ${p.right}`),
        el('span', { class: 'l12-n' }, `${p.n} task${p.n === 1 ? '' : 's'}`),
        el('span', { class: 'spacer' }),
        el('span', { class: `l12-pref__agree ${p.decided && p.agree / p.decided < 0.8 ? 'bad' : ''}`, title: 'Of the tasks where the preference leans one way and the rubric scores differ by more than 2 points, how many point the same way' },
          p.decided ? `agrees with rubric ${p.agree}/${p.decided}` : 'no decided pairs')),
      el('table', { class: 'l12-pref__t' },
        el('tr', {}, el('th', {}, 'Dimension'), el('th', {}, 'Mean'), el('th', {}, 'Leans'), el('th', { title: `ratings favouring ${p.left} / comparable / favouring ${p.right}` }, `${p.left} · = · ${p.right}`)),
        ...p.dims.map((d) => el('tr', {},
          el('td', {}, d.title),
          el('td', {}, el('b', {}, num1(d.mean))),
          el('td', { class: 'l12-n' }, lean(d.mean)),
          el('td', { class: 'mono l12-n' }, `${d.left} · ${d.tie} · ${d.right}`)))));
  });
  wrap.replaceChildren(...(cards.length ? cards : [el('div', { class: 'l12-empty' }, 'No preference data in this scope.')]));
}

// ---- domains ----
function renderDomains() {
  const head = el('tr', {}, ...['Domain', 'Tasks', 'Avg RD', 'Avg AD1', 'Avg AD2', 'Fail', 'Non-fail'].map((h) => el('th', {}, h)));
  const cell = (side, v) => el('td', { class: v == null ? '' : (side === 'golden' ? v >= GATE.golden : v <= GATE[side]) ? '' : 'l12-gatebad' }, v == null ? '—' : `${num1(v)}%`);
  const body = data.domains.map((d) => el('tr', {},
    el('td', {}, d.domain), el('td', {}, String(d.tasks)),
    cell('golden', d.avg.golden), cell('ad1', d.avg.ad1), cell('ad2', d.avg.ad2),
    el('td', {}, String(d.hard)), el('td', {}, String(d.soft))));
  const t = document.getElementById('l12-domains');
  t.replaceChildren(head, ...body);
  if (!body.length) t.append(el('tr', {}, el('td', { class: 'empty', colspan: '7' }, 'No tasks in this scope.')));
}

async function loadScope(scope) {
  data = await api(`/l12?scope=${scope}`);
  renderCards();
  renderMovement();
  renderLeaderboard();
  renderPrefs();
  renderDomains();
}

// ---------- boot ----------
const me = await api('/me');
const scopeSel = el('select', { class: 'select', id: 'l12-scope-sel' },
  el('option', { value: 'active' }, 'Active board (non-archived)'),
  el('option', { value: 'completed' }, 'Completed (resolved, non-archived)'),
  el('option', { value: 'all' }, 'All tasks on disk'));
renderAppHeader({ active: 'l12', user: me, extras: [scopeSel] });

const sel = document.getElementById('l12-scope-sel');
const s0 = new URLSearchParams(location.search).get('scope');
if (s0 && ['completed', 'active', 'all'].includes(s0)) sel.value = s0;
sel.addEventListener('change', () => loadScope(sel.value));
await loadScope(sel.value);

// Redash panels load last and independently — a slow or unreachable Redash must
// never delay or break the disk-computed sections above.
// Evidence deep links target panels that only exist once these resolve, so the
// hash is consumed after both have had their chance to render.
Promise.allSettled([
  initPipelinePanels().catch((e) => console.error('pipeline panels:', e)),
  initQualityPanels().catch((e) => console.error('quality panels:', e)),
]).then(() => flashHash());


// Acey is available from every page, not just inside a task.
mountAcey({ page: 'L12 stats' });
