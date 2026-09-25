// Who owns what on RLI (PKJA), and therefore who a given problem belongs to.
//
// This replaces the round-robin in buildAssignments(), which rotated chores
// evenly across four people every week on the assumption that they were
// interchangeable. They are not: Gilberto runs quality policy, Christian runs
// throughput and pay, Ernesto runs tooling and QC, Nishchay runs the attempter
// cohort. Handing Ernesto a promotions decision because it was his turn produces
// a list nobody acts on, which is worse than no list.
//
// So routing is by DOMAIN. Every health signal declares the domain it belongs to
// and lands with the person who owns that domain. Anything with no owner, or
// flagged as cross-cutting, escalates rather than being assigned to whoever is
// next in a rotation.

export const ESCALATION = 'pavit';

export const TEAM = [
  // RLI / PKJA leads, from the QM Follow-Up Tracker's People tab and who runs
  // what in #rli-pkja-pt (2026-09-25). Domains are the routing key for health
  // signals; ownership here is inferred from the channel — confirm with Pavit
  // before treating it as policy.
  {
    username: 'luis',
    name: 'Luis Monsalve',
    remit: 'Pipeline & throughput (STO)',
    domains: ['throughput', 'missions', 'team_management', 'pay_efficiency', 'onsites', 'cohort_growth', 'superattempters'],
    blurb: 'Runs the PKJA pipeline: CB allocations and onboarding, daily action items, pay rates, what ships each day.',
  },
  {
    username: 'ernesto',
    name: 'Ernesto Hernandez',
    remit: 'Delivery & customer quality',
    domains: ['quality', 'audits', 'qc', 'promotions', 'guidelines'],
    blurb: 'Owns deliveries and customer feedback: auditing sprints, QC fails, the feedback-driven fixes to rubrics and justifications.',
  },
  {
    username: 'erfan',
    name: 'Erfan Mansoori',
    remit: 'Rubrics DRI · data',
    domains: ['redash', 'dashboards', 'quality_dashboard', 'tooling', 'linters'],
    blurb: 'RLI Rubrics DRI: the PKJA Redash dashboard, domain/QM distributions, linters and the numbers behind coverage calls.',
  },
  {
    username: 'gilberto',
    name: 'Gilberto Leon',
    remit: 'Rubrics DRI · war room',
    domains: ['courses', 'community'],
    blurb: 'RLI Rubrics DRI: runs the daily war room and QM alignment on the spec.',
  },
  {
    username: ESCALATION,
    name: 'Pavit Singh',
    remit: 'Evals & escalation',
    // `evals` routes here directly: tasks at L10 with no eval on the board can
    // only move with an eval pass. Everything else arrives only by escalation.
    domains: ['evals'],
    blurb: 'Runs the eval passes that move L10 work onto the board, plus high-leverage and cross-domain calls.',
  },
];

const OWNER_OF = new Map();
for (const person of TEAM) for (const d of person.domains) OWNER_OF.set(d, person.username);

export const ALL_DOMAINS = [...OWNER_OF.keys()];

export function personByUsername(username) {
  return TEAM.find((p) => p.username === username) || null;
}

// Route a signal to a person.
//
// `escalate` on a signal means the owner still sees it — it is their domain —
// but it ALSO surfaces on the escalation list, because the call is bigger than
// the domain. A signal with an unknown domain escalates outright rather than
// being dropped or guessed at: an unroutable problem is itself a finding.
export function routeSignal(signal) {
  const owner = OWNER_OF.get(signal.domain) || null;
  return {
    owner: owner || ESCALATION,
    escalated: !owner || !!signal.escalate,
    unrouted: !owner,
  };
}

// A compact description of the team for the model's system prompt, so Acey can
// answer "who should look at this" without a tool call and without inventing an
// org chart.
export function teamBrief() {
  return TEAM.map((p) => `${p.name} (${p.username}) — ${p.remit}: ${p.blurb}`
    + (p.domains.length ? ` [domains: ${p.domains.join(', ')}]` : ' [escalation target]'))
    .join('\n');
}
