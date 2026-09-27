import { config } from './config.js';
import { buildBrief, blockedBacklog } from './overview.js';
import { qualitySnapshot } from './quality.js';
import { boardPipeline } from './pipeline.js';
import { routeSignal } from './team.js';

// Project health, expressed as SIGNALS rather than a score.
//
// A single health number is worse than useless on a project like this: it moves
// for reasons nobody can act on, and it hides the one thing that actually needs
// doing this week behind four things that are fine. So each check answers one
// question, and either fires with evidence or stays quiet.
//
// Every signal carries the number that triggered it and the threshold it crossed,
// so the todo it produces can be argued with. A todo that says "quality is down"
// gets ignored; one that says "L-1 wasted 3,533h of 9,141h billable (38.7%),
// threshold 25%" gets acted on or gets the threshold changed. Both are progress.
//
// Checks are deliberately dumb functions over data already fetched for the pages.
// Nothing here queries Redash directly.

const pct = (n) => `${Math.round(n)}%`;
const int = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

// Severity drives ordering and escalation, not colour alone.
//   p0 — asap: the delivery or the customer is at risk this cycle
//   p1 — by end of day: costs real money or quality if it runs longer
//   p2 — within 2-3 days
// Signals never emit p00 — the single-most-pressing crown is a human call.
const SEV_RANK = { p0: 0, p1: 1, p2: 2 };

// Thresholds in one place so they can be argued with as a set. These are first
// cuts from the numbers the project is currently running at, not received wisdom
// — expect to move them once a few weeks of signals have been seen.
export const THRESHOLDS = {
  wastedHoursPct: 25,        // share of billable hours flagged useless at a level
  blockedDays: 7,            // a task sitting in L1/L8 this long is stuck, not queued
  blockedCount: 10,          // how many stuck tasks before it is a workstream
  sbqPct: 35,                // send-back rate at the authoring level
  disableCount: 10,          // contributors sitting at "should disable"
  slippingCount: 5,          // contributors whose quality dropped this window
  calibrationDelta: 0.5,     // a reviewer this far off the project mean
  calibrationMinScores: 20,  // ...over at least this many grades
  staleCount: 15,            // tasks past the stale threshold at their level
  deliveryGapPct: 20,        // how far short of target the deliverable pool can be
  evalGap: 20,               // L10 tasks with no eval on the board before it is a work item
  evalCrunchDays: 2,         // within this of delivery, every un-evalled L10 task matters
};

function signal(s) {
  return { ...s, ...routeSignal(s) };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkDelivery(brief) {
  const out = [];
  const p = brief.pipeline;
  if (!p) return out;

  const target = brief.target || config.overview.targetVolume;
  const shortPct = target ? ((target - p.deliverable) / target) * 100 : 0;

  // Only meaningful close to the delivery. Three days out, being short is the
  // normal state of the world and firing on it every week trains people to
  // ignore the list.
  const daysLeft = brief.targetDaysUntil ?? brief.calendar.daysUntil;
  if (daysLeft <= 2 && shortPct > THRESHOLDS.deliveryGapPct) {
    out.push(signal({
      id: 'delivery-gap',
      domain: 'throughput',
      severity: shortPct > 50 ? 'p0' : 'p1',
      // Escalates because closing a gap this late is a scope call, not a
      // throughput chore — someone has to decide what ships.
      escalate: shortPct > 50,
      title: `${int(p.gapToTarget)} short of the ${int(target)} target with ${daysLeft} day(s) to go`,
      detail: `${int(p.deliverable)} deliverable at L12 (${p.progressPct}% of target). `
        + `${int(p.feeder)} at L10 and ${int(p.upstream)} further back.`,
      metric: { value: p.gapToTarget, threshold: Math.round((target * THRESHOLDS.deliveryGapPct) / 100), unit: 'tasks' },
      link: '/overview.html#chart-deliveries',
    }));
  }

  if (p.stale?.count >= THRESHOLDS.staleCount) {
    out.push(signal({
      id: 'stale-tasks',
      domain: 'throughput',
      severity: 'p2',
      title: `${int(p.stale.count)} tasks have stopped moving`,
      detail: p.stale.byLevel.map((s) => `L${s.level}: ${s.stale} (oldest ${s.oldestDays}d)`).join(', '),
      metric: { value: p.stale.count, threshold: THRESHOLDS.staleCount, unit: 'tasks' },
      link: '/overview.html#chart-funnel',
    }));
  }
  return out;
}

// Wasted hours are the clearest money signal on the project and nothing surfaced
// them before the billing view was wired in.
function checkWaste(brief) {
  const out = [];
  for (const e of brief.economics || []) {
    if (!e.billableHours || e.uselessPct < THRESHOLDS.wastedHoursPct) continue;
    out.push(signal({
      id: `waste-l${e.level}`,
      domain: 'pay_efficiency',
      severity: e.uselessPct > 35 ? 'p1' : 'p2',
      escalate: e.uselessPct > 35 && e.uselessHours > 1000,
      title: `L${e.level} wasted ${int(e.uselessHours)}h of ${int(e.billableHours)}h billable (${pct(e.uselessPct)})`,
      detail: `Work that was paid for and thrown away, over the last ${brief.windowDays} days. `
        + `Send-back rate at this level is ${e.sbqPct == null ? 'unknown' : pct(e.sbqPct)}.`,
      metric: { value: Math.round(e.uselessPct), threshold: THRESHOLDS.wastedHoursPct, unit: '%' },
      link: '/overview.html#chart-cost',
    }));
  }
  return out;
}

function checkBlocked(blocked) {
  const out = [];
  for (const lane of blocked.lanes || []) {
    const rows = (blocked.rows || []).filter((r) => r.level === lane.level);
    const old = rows.filter((r) => r.daysBlocked >= THRESHOLDS.blockedDays);
    if (!old.length && lane.tasks < THRESHOLDS.blockedCount) continue;

    // L1 is content — a guidelines problem. L8 is engineering — a tooling
    // problem. Same shape of signal, different owner, which is exactly the
    // distinction a rotation cannot make.
    const domain = lane.level === '1' ? 'guidelines' : 'tooling';
    out.push(signal({
      id: `blocked-l${lane.level}`,
      domain,
      severity: old.length >= THRESHOLDS.blockedCount ? 'p1' : 'p2',
      title: `${int(lane.tasks)} tasks blocked at L${lane.level}`
        + (old.length ? `, ${int(old.length)} for a week or more` : ''),
      // The hint is a fragment ("blocked on something the platform has to fix");
      // it starts a sentence here, so it gets a capital.
      detail: `${lane.hint.charAt(0).toUpperCase()}${lane.hint.slice(1)}. Oldest is ${lane.oldestDays}d. `
        + `${int(lane.hoursSunk)}h of work already spent on tasks that cannot move.`,
      metric: { value: old.length || lane.tasks, threshold: THRESHOLDS.blockedDays, unit: 'tasks' },
      link: '/overview.html#ov-blocked',
    }));
  }
  return out;
}

// The first question of an assignment pass: how many tasks sit at L10 upstream
// with no eval on the Audit Studio board? Only an eval pass moves them — tasks
// do not reach L12 unevalled — so the gap routes straight to Pavit as his
// queue, not as an escalation.
//
// Two ways to fire, deliberately different:
//   * gap >= 20             a real batch is waiting, worth a sitting
//   * delivery is close AND the target is short AND any gap at all — at that
//     point each evalled task converts one-for-one into deliverable volume,
//     so even a handful is worth the pass. Severity rises to critical because
//     it is the same event as the delivery being at risk.
//
// Both sides count PENDING L10 nodes: atL10 (the brief's feeder) is a
// pending-only count, so a board task whose latest L10 node is completed or
// canceled has already left the pool being measured — subtracting it anyway
// understates the gap. Board tasks that have moved past L10 upstream stopped
// being part of either side of this comparison.
function checkEvalGap(brief, board) {
  const p = brief.pipeline;
  if (!p || !Array.isArray(board?.rows)) return [];

  const atL10 = Number(p.feeder) || 0;
  const onBoard = board.rows.filter((r) => String(r.reviewLevel) === '10' && r.status === 'pending').length;
  const gap = Math.max(0, atL10 - onBoard);

  const short = (p.gapToTarget || 0) > 0;
  const crunch = (brief.targetDaysUntil ?? brief.calendar.daysUntil) <= THRESHOLDS.evalCrunchDays && short && gap > 0;
  if (gap < THRESHOLDS.evalGap && !crunch) return [];

  return [signal({
    id: 'eval-gap',
    domain: 'evals',
    severity: crunch ? 'p0' : 'p1',
    title: `Run evals on ${int(gap)} L10 task${gap === 1 ? '' : 's'} not yet on the board`,
    detail: `${int(atL10)} tasks sit at L10 upstream and ${int(onBoard)} of them are on the Hub `
      + `board. The remaining ${int(gap)} cannot reach L12 without an eval pass.`
      + (crunch
        ? ` Delivery is ${brief.targetDaysUntil ?? brief.calendar.daysUntil} day(s) out and the target is ${int(p.gapToTarget)} short — each of these converts directly into deliverable volume now.`
        : ''),
    metric: { value: gap, threshold: THRESHOLDS.evalGap, unit: 'tasks' },
    link: '/l12.html#rd-split',
  })];
}

function checkContributors(q) {
  const out = [];
  if (!q?.enabled) return out;

  const disable = q.actions.filter((p) => p.tierKey === 'attempter_disable');
  const demote = q.actions.filter((p) => p.tierKey === 'reviewer_demote');
  if (disable.length + demote.length >= THRESHOLDS.disableCount) {
    out.push(signal({
      id: 'contributors-disable',
      domain: 'promotions',
      severity: 'p1',
      title: `${int(disable.length + demote.length)} contributors are below the bar`,
      detail: `${int(disable.length)} attempters at "should disable", ${int(demote.length)} reviewers at "should demote". `
        + `Thresholds match the ops QC list.`,
      metric: { value: disable.length + demote.length, threshold: THRESHOLDS.disableCount, unit: 'people' },
      link: '/l12.html#q-actions',
    }));
  }

  const promote = q.actions.filter((p) => p.tierKey === 'attempter_promote');
  if (promote.length) {
    out.push(signal({
      id: 'contributors-promote',
      domain: 'superattempters',
      severity: 'p2',
      title: `${int(promote.length)} promote candidates waiting`,
      detail: 'Attempters scoring 4.0+ with a poor-rate under 5%. These are the superattempter '
        + 'cohort intake — they go stale if they sit.',
      metric: { value: promote.length, threshold: 1, unit: 'people' },
      link: '/l12.html#q-actions',
    }));
  }

  if (q.slipping.length >= THRESHOLDS.slippingCount) {
    out.push(signal({
      id: 'quality-slipping',
      domain: 'quality',
      severity: 'p1',
      title: `${int(q.slipping.length)} contributors slipped this window`,
      detail: `Quality dropped ≥0.4, poor-rate climbed ≥10pp, or they fell below the trusted line, `
        + `over ${q.windowDays} days. Left alone, their work is what QMs send back at L10 next week.`,
      metric: { value: q.slipping.length, threshold: THRESHOLDS.slippingCount, unit: 'people' },
      link: '/l12.html#q-slipping',
    }));
  }

  const off = (q.reviewers || []).filter((r) =>
    r.calibrationDelta != null
    && r.scoresGiven >= THRESHOLDS.calibrationMinScores
    && Math.abs(r.calibrationDelta) >= THRESHOLDS.calibrationDelta);
  if (off.length) {
    out.push(signal({
      id: 'reviewer-calibration',
      domain: 'qc',
      severity: 'p1',
      // Every verdict downstream of a miscalibrated reviewer inherits the error,
      // so this is worth more attention than its size suggests.
      escalate: off.some((r) => Math.abs(r.calibrationDelta) >= 1),
      title: `${int(off.length)} reviewers are grading off the project standard`,
      detail: off.slice(0, 5).map((r) => `${r.name || r.email}: ${r.avgScoreGiven} `
        + `(${r.calibrationDelta > 0 ? '+' : ''}${r.calibrationDelta} vs ${r.projectMean}, `
        + `${r.sbqPct}% sent back over ${r.reviews} reviews)`).join('; ')
        + (off.length > 5 ? `; +${off.length - 5} more` : ''),
      metric: { value: off.length, threshold: 1, unit: 'reviewers' },
      link: '/l12.html#q-reviewers',
    }));
  }
  return out;
}

// A check that fires when the data behind the other checks is missing. Silence
// because a query failed looks exactly like silence because everything is fine,
// and that is the failure mode worth guarding hardest against.
function checkDataHealth(brief, blocked, q, board) {
  const errs = [
    ...(brief.errors || []),
    ...(blocked.errors || []),
    ...(q?.errors || []),
    ...(board?.error ? [{ query: 'board_pipeline', error: board.error }] : []),
  ];
  if (!errs.length) return [];
  return [signal({
    id: 'data-health',
    domain: 'redash',
    severity: 'p1',
    title: `${errs.length} upstream quer${errs.length === 1 ? 'y' : 'ies'} failed`,
    detail: errs.map((e) => `${e.query}: ${e.error}`).join('; ')
      + ' — checks that depend on these are silent, not clear.',
    metric: { value: errs.length, threshold: 0, unit: 'queries' },
    link: '/redash.html',
  })];
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

export async function projectHealth({ fresh = false, days = 30 } = {}) {
  const [brief, blocked, quality, board] = await Promise.all([
    buildBrief({ fresh, days }),
    blockedBacklog({ fresh }).catch((e) => ({ lanes: [], rows: [], errors: [{ query: 'blocked_backlog', error: e.message }] })),
    qualitySnapshot({ fresh, days }).catch((e) => ({ enabled: false, errors: [{ query: 'quality', error: e.message }] })),
    // The board x pipeline join, for the eval-gap check. rows: null (not [])
    // on failure so the check skips rather than reading an empty board as
    // "nothing evalled" and inflating the gap.
    boardPipeline({ scope: 'all', fresh }).catch((e) => ({ rows: null, error: e.message })),
  ]);

  const signals = [
    ...checkDelivery(brief),
    ...checkWaste(brief),
    ...checkBlocked(blocked),
    ...checkEvalGap(brief, board),
    ...checkContributors(quality),
    ...checkDataHealth(brief, blocked, quality, board),
  ].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);

  return {
    signals,
    counts: {
      p0: signals.filter((s) => s.severity === 'p0').length,
      p1: signals.filter((s) => s.severity === 'p1').length,
      p2: signals.filter((s) => s.severity === 'p2').length,
      escalated: signals.filter((s) => s.escalated).length,
    },
    // Enough of the underlying state for the page to show context without
    // re-fetching any of it.
    context: {
      deliverable: brief.pipeline?.deliverable ?? null,
      target: brief.target,
      daysUntilDelivery: brief.targetDaysUntil ?? brief.calendar.daysUntil,
      nextDelivery: brief.targetDate || brief.calendar.nextDeliveryDate,
      totalPending: brief.pipeline?.totalPending ?? null,
      blocked: brief.pipeline?.blocked?.pending ?? null,
      contributors: quality?.totals?.contributors ?? null,
    },
    generatedAt: new Date().toISOString(),
  };
}
