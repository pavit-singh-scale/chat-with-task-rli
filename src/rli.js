// RLI queue (Anthropic / PKJA, project 6a989ef00d42ba8e15aaac6c).
//
// A task is one record from the delivery_sender_preview JSON, stored verbatim
// as <task>/task.json, with its four artifact zips extracted beside it:
//   files/input/   brief inputs          files/golden/  RD (reference deliverable)
//   files/ad1/     model attempt 1       files/ad2/     model attempt 2
//
// readRliIn() normalizes the record for the UI; computeChecks() runs every QC
// dimension of the spec that can be decided from data alone. Everything else
// is left to the human auditor — these checks never claim a verdict they
// cannot prove from the record.
import fs from 'node:fs';
import path from 'node:path';
import { derivedFor, mediaFor } from './rli_derive.js';

export const SIDES = [
  { key: 'golden', label: 'RD', long: 'Reference deliverable (golden)' },
  { key: 'ad1', label: 'AD1', long: 'Model attempt 1' },
  { key: 'ad2', label: 'AD2', long: 'Model attempt 2' },
];

// Gates from the Updated RLI spec doc.
export const GATES = {
  minCriteria: 40,
  maxCriteria: 100,
  goldenMin: 97,
  ad1Max: 70,
  ad2Max: 50,
  ad2CalibMin: 25,       // reference model calibrated to 25–50%
  qualityMinPos: 65,     // aesthetics + functionality + usability ≥ 65% of positive weight
  target: { format: 5, brief: 30, quality: 65 },
  provenanceMaxWeight: -8,
  atRiskPts: 3,          // within this many points of a stumping gate = at risk
};

// Rubric category → the client's three buckets (5 / 30 / 65).
const BUCKET_OF = {
  'format/file': 'format', format: 'format', formatting: 'format',
  'brief compliance': 'brief', correctness: 'brief', 'requirements compliance': 'brief', 'content correctness': 'brief',
  aesthetics: 'quality', 'presentation & aesthetics': 'quality', functionality: 'quality',
  'usability/professionalism': 'quality', 'usability & professionalism': 'quality', 'usability & realism': 'quality', editability: 'quality',
};
export function bucketOf(category) { return BUCKET_OF[String(category || '').trim().toLowerCase()] || 'other'; }

const MEDIA = [
  ['image', /\.(png|jpe?g|gif|webp|bmp|avif|svg|tiff?|ico)$/i],
  ['video', /\.(mp4|m4v|mov|webm|mkv|avi|wmv)$/i],
  ['audio', /\.(mp3|wav|ogg|aac|m4a|flac|aiff?)$/i],
  ['pdf', /\.pdf$/i],
  ['model3d', /\.(obj|glb|gltf|stl|fbx|ply|3ds|dae)$/i],
  ['cad', /\.(dwg|dxf|skp|stp|step|ipt|3dm|rvt|ifc|max|blend|sldprt|sldasm|c4d|ma|mb)$/i],
  ['design', /\.(psd|ai|eps|indd|fig|sketch|xd|afdesign|afphoto)$/i],
  ['sheet', /\.(csv|xlsx?|ods)$/i],
  ['doc', /\.(docx?|pptx?|odt|rtf)$/i],
  ['archive', /\.(zip|rar|7z|tar|gz)$/i],
  ['text', /\.(md|txt|json|ya?ml|html?|css|js|ts|py|xml|srt|vtt|mtl|csv|tex|sh|cs|gd|lua)$/i],
];
export function kindOf(name) {
  for (const [k, re] of MEDIA) if (re.test(name)) return k;
  return 'other';
}

export function isRliTask(dir) { return fs.existsSync(path.join(dir, 'task.json')); }

export function readRecord(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
}

function listSide(dir, side) {
  const root = path.join(dir, 'files', side);
  const out = [];
  if (!fs.existsSync(root)) return out;
  (function walk(d, rel) {
    for (const name of fs.readdirSync(d).sort()) {
      if (name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._')) continue;
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else {
        const f = { name, rel: r, path: `files/${side}/${r}`, size: st.size, kind: kindOf(name) };
        const d = derivedFor(dir, f.path);
        if (d) f.derived = d;
        if (f.kind === 'video' || f.kind === 'audio') { const m = mediaFor(dir, f.path); if (m) f.media = m; }
        out.push(f);
      }
    }
  })(root, '');
  return out;
}

// First meaningful line of the Work Description — the card/strip title.
export function briefTitle(brief) {
  const text = String(brief || '');
  const m = text.match(/#+\s*Work Description\s*\n+([\s\S]*?)(\n\s*\n|\n#|$)/i);
  const para = (m ? m[1] : text.replace(/^#.*$/gm, '')).trim().replace(/\s+/g, ' ');
  const first = para.split(/(?<=[.!?])\s/)[0] || para;
  return first.length > 200 ? `${first.slice(0, 197)}…` : first;
}

// Split the brief into its four canonical sections (tolerant of "##Heading"
// with no space and of heading-name variants).
export function briefSections(brief) {
  const text = String(brief || '');
  const parts = [];
  const re = /^#{1,4}\s*([^\n#][^\n]*)$/gm;
  let m, last = null;
  while ((m = re.exec(text))) {
    if (last) parts.push({ ...last, body: text.slice(last.end, m.index).trim() });
    last = { heading: m[1].trim(), end: re.lastIndex };
  }
  if (last) parts.push({ ...last, body: text.slice(last.end).trim() });
  if (!parts.length && text.trim()) parts.push({ heading: 'Brief', body: text.trim() });
  return parts.map(({ heading, body }) => ({ heading, body }));
}

export function readRliIn(dir) {
  const rec = readRecord(dir);
  const re = rec.rubric_eval || {};
  const criteria = (re.criteria || []).map((c, i) => ({
    n: i + 1,
    id: String(c.id ?? i + 1),
    title: String(c.title || ''),
    weight: Number(c.weight) || 0,
    category: String(c.criteria_category || ''),
    bucket: bucketOf(c.criteria_category),
    verdicts: Object.fromEntries(SIDES.map((s) => {
      const v = c[s.key] || {};
      const passed = typeof v.passed === 'boolean' ? v.passed : null;
      // On a negative (penalty) criterion "passed" means the defect statement
      // is TRUE — the defect is present and its weight is deducted. Verified
      // against the reported scores on every task in the 0924 export.
      const good = passed === null ? null : (Number(c.weight) < 0 ? !passed : passed);
      return [s.key, { passed, good, justification: String(v.justification || '') }];
    })),
  }));
  const files = {
    input: listSide(dir, 'input'),
    golden: listSide(dir, 'golden'),
    ad1: listSide(dir, 'ad1'),
    ad2: listSide(dir, 'ad2'),
  };
  const out = {
    present: true,
    task_id: rec.task_id,
    unique_id: rec.unique_id || null,
    domain: rec.domain || '',
    timeline: rec.timeline || '',
    title: briefTitle(rec.brief),
    brief: rec.brief || '',
    briefSections: briefSections(rec.brief),
    models: { golden: 'Human expert', ad1: rec.ad1_model || rec.ad1_artifacts?.model || null, ad2: rec.ad2_model || rec.ad2_artifacts?.model || null },
    inputsDeclared: rec.inputs?.file_count ?? null,
    scores: re.scores || {},
    criteria,
    pref: rec.pref_ranking || null,
    files,
    missing: [
      !rec.brief && 'brief',
      !rec.golden_deliverables && 'golden deliverables',
      !rec.ad1_artifacts && 'AD1 artifacts',
      !rec.ad2_artifacts && 'AD2 artifacts',
      !rec.inputs && 'inputs block',
      !rec.timeline && 'timeline',
    ].filter(Boolean),
  };
  // The pristine record (snapshotted before the first studio fix) — lets the
  // score check tell "the export's arithmetic is wrong" from "an auditor has
  // since flipped verdicts here".
  const srcPath = path.join(dir, 'task.source.json');
  if (fs.existsSync(srcPath)) {
    try {
      const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
      out.sourceCriteria = (src.rubric_eval?.criteria || []).map((c) => ({
        weight: Number(c.weight) || 0,
        verdicts: Object.fromEntries(SIDES.map((s) => [s.key, { passed: typeof c[s.key]?.passed === 'boolean' ? c[s.key].passed : null }])),
      }));
    } catch { /* unreadable snapshot — score check falls back to the live record */ }
  }
  out.checks = computeChecks(out);
  return out;
}

// ---------------------------------------------------------------- checks

const pct = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);

export function weightMix(criteria) {
  const pos = criteria.filter((c) => c.weight > 0);
  const total = pos.reduce((s, c) => s + c.weight, 0) || 1;
  const sum = (b) => pos.filter((c) => c.bucket === b).reduce((s, c) => s + c.weight, 0);
  const byCat = {};
  for (const c of pos) byCat[c.category || '(none)'] = (byCat[c.category || '(none)'] || 0) + c.weight;
  return {
    positiveTotal: total,
    format: pct((100 * sum('format')) / total),
    brief: pct((100 * sum('brief')) / total),
    quality: pct((100 * sum('quality')) / total),
    other: pct((100 * sum('other')) / total),
    byCategory: Object.entries(byCat).map(([k, v]) => ({ category: k, bucket: bucketOf(k), weight: v, pct: pct((100 * v) / total) })).sort((a, b) => b.weight - a.weight),
    negatives: criteria.filter((c) => c.weight < 0).length,
  };
}

// Paths the brief names explicitly: input/…, inputs/…, typo'd roots, and quoted
// filenames with an extension.
function briefPaths(brief) {
  const text = String(brief || '');
  const found = new Map();
  for (const m of text.matchAll(/(?:^|[\s'"`(\[*])((?:inputs?|inpu|imput|input_files)\/[^\s'"`)\],;]+)/gim)) {
    found.set(m[1].replace(/[.:]+$/, ''), 'path');
  }
  // Ranges like 'input/Reff01.jpg' to 'input/Reff17.jpg' — expand the numbering.
  const ranges = [];
  for (const m of text.matchAll(/(inputs?\/)([A-Za-z_\- ]*?)(\d+)(\.\w+)['"`]?\s*(?:to|-|–|through)\s*['"`]?\1\2(\d+)\4/gi)) {
    const [, root, stem, a, ext, b] = m;
    ranges.push({ root, stem, from: Number(a), to: Number(b), width: a.length, ext });
  }
  return { explicit: [...found.keys()], ranges };
}

function normName(s) { return s.toLowerCase().replace(/[\s_\-]+/g, ''); }

function checkPaths(t) {
  const inputs = t.files.input;
  const byRel = new Set(inputs.map((f) => f.rel));
  const byName = new Set(inputs.map((f) => f.name));
  const { explicit, ranges } = briefPaths(t.brief);
  const problems = [];
  const resolved = new Set();
  const expanded = [];
  for (const r of ranges) {
    for (let i = r.from; i <= r.to; i++) expanded.push(`${r.stem}${String(i).padStart(r.width, '0')}${r.ext}`);
  }
  for (const p of explicit) {
    const rootOk = /^inputs?\//i.test(p);
    const rel = p.replace(/^[^/]+\//, '');
    const base = rel.split('/').pop();
    if (byRel.has(rel) || byName.has(base)) {
      resolved.add(base);
      if (!rootOk) problems.push({ sev: 'fail', text: `Brief uses a misspelled root "${p.split('/')[0]}/" for ${base}.`, ref: p });
      continue;
    }
    const near = inputs.find((f) => normName(f.name) === normName(base))
      || inputs.find((f) => f.name.replace(/\.\w+$/, '') === base.replace(/\.\w+$/, ''));
    if (near) {
      resolved.add(near.name);
      problems.push({ sev: 'fail', text: `Brief names "${p}" but the input is "${near.rel}".`, ref: p });
    } else if (!inputs.length) {
      problems.push({ sev: 'warn', text: `Brief names "${p}" but no input files were delivered to check it against.`, ref: p });
    } else {
      problems.push({ sev: 'fail', text: `Brief names "${p}" — no matching file in the inputs.`, ref: p });
    }
  }
  for (const n of expanded) if (byName.has(n)) resolved.add(n);
  const unlisted = inputs.filter((f) => !resolved.has(f.name) && !explicit.some((p) => p.endsWith(f.rel)));
  return { explicit, ranges, problems, unlisted };
}

// Brief asks for something that must be derived from a source file (renders
// of a 3D model, exports from CAD, stems from a session, frames from a video).
const DERIVED_RE = /\b(render(s|ed|ings?)?|turntables?|wire-?frames?|beauty shots?|exports? (from|of)|stems?|bounced|frames? (cut|extracted|from))\b/i;
const SOURCE_RE = /\.(fbx|obj|glb|gltf|stl|skp|3ds|max|blend|c4d|ma|mb|step|stp|dwg|rvt|ifc|3dm|sldprt|sldasm|ipt|aep|prproj|als|flp|logicx|ptx)\b|\b(3d model|cad|sketchup|revit|blender|maya|rhino|solidworks|session file|project file)\b/i;
const PROVENANCE_RE = /\b(generat\w*|ai[- ]?generated|image[- ]?gen\w*|from scratch|text-to-image|not (actually )?rendered|rather than (being )?rendered|derived|rendered (directly )?from|fabricat\w*|synthesi[sz]\w*)\b/i;

function checkProvenance(t) {
  const deliverables = (t.briefSections.find((s) => /deliverable/i.test(s.heading))?.body) || t.brief;
  const derivedAsked = DERIVED_RE.test(deliverables) && (SOURCE_RE.test(t.brief) || /3d|cad|architecture|industrial|game|animation/i.test(t.domain));
  if (!derivedAsked) return { applies: false };
  const cands = t.criteria.filter((c) => PROVENANCE_RE.test(c.title));
  const strong = cands.filter((c) => c.weight <= GATES.provenanceMaxWeight);
  return { applies: true, candidates: cands, strong };
}

// Preference comparisons: mean position on the 1–7 scale (1 = left better).
function prefSummary(pref) {
  return (pref?.comparisons || []).map((c) => {
    const dims = c.dimensions || [];
    const mean = dims.length ? dims.reduce((s, d) => s + Number(d.score || 4), 0) / dims.length : 4;
    return { pair: c.pair, left: c.left, right: c.right, mean: Math.round(mean * 100) / 100, dims };
  });
}
const SIDE_OF = { RD: 'golden', AD1: 'ad1', AD2: 'ad2' };

export function computeChecks(t) {
  const checks = [];
  const add = (c) => checks.push(c);
  const sc = (k) => (typeof t.scores?.[k]?.percentage === 'number' ? t.scores[k].percentage : null);
  const g = sc('golden'), a1 = sc('ad1'), a2 = sc('ad2');
  const n = t.criteria.length;

  // Cannot audit — record incomplete.
  const blocking = t.missing.filter((m) => m !== 'timeline' && m !== 'inputs block');
  if (blocking.length) {
    add({ id: 'complete', dim: null, label: 'Record completeness', status: 'fail',
      summary: `Missing ${blocking.join(', ')} — the rubric verdicts can't be checked against anything.`,
      detail: 'The export carries rubric grades and preference scores but not the artifacts they grade. Re-export or pull the task before auditing.' });
  } else if (t.missing.length) {
    add({ id: 'complete', dim: null, label: 'Record completeness', status: 'warn', summary: `Missing ${t.missing.join(', ')}.` });
  }

  add({ id: 'count', dim: 'D3', label: 'Criteria count (40–100)',
    status: n < GATES.minCriteria ? 'fail' : n > GATES.maxCriteria ? 'warn' : 'pass',
    summary: `${n} criteria${n === GATES.minCriteria ? ' — exactly at the floor' : ''}.` });

  add({ id: 'golden', dim: 'D14', label: 'Golden ≥ 97%',
    status: g == null ? 'na' : g >= GATES.goldenMin ? 'pass' : 'fail',
    summary: g == null ? 'No RD score in the record.' : `RD scores ${g}% (${t.scores.golden.score}/${t.scores.golden.total}).`,
    detail: 'Per spec the printed RD score is the source of truth — never re-derive it to push it under the gate.' });

  // Every gate trusts the printed scores, so first prove they follow from the
  // verdicts: Σ weight where passed (penalties subtract) ÷ Σ positive weight.
  const rescore = (crits, side) => {
    const total = crits.reduce((s, c) => s + (c.weight > 0 ? c.weight : 0), 0);
    const score = crits.reduce((s, c) => s + (c.verdicts[side].passed === true ? c.weight : 0), 0);
    const blank = crits.filter((c) => c.verdicts[side].passed === null).length;
    return { score, total, pct: total ? pct((score / total) * 100) : null, blank };
  };
  const scoreRows = SIDES.map((s) => {
    const printed = t.scores?.[s.key];
    const now = rescore(t.criteria, s.key);
    const orig = t.sourceCriteria ? rescore(t.sourceCriteria, s.key) : now;
    const matches = (r) => printed && r.score === printed.score && r.total === printed.total;
    return { side: s.label, printed, now, orig, reproduces: matches(orig), edited: !!printed && matches(orig) && !matches(now) };
  });
  const broken = scoreRows.filter((r) => r.printed && !r.reproduces);
  const blanks = scoreRows.filter((r) => r.now.blank);
  const edited = scoreRows.filter((r) => r.edited);
  add({ id: 'score', dim: null, label: 'Scores reproduce from the verdicts',
    status: !scoreRows.some((r) => r.printed) ? 'na' : broken.length ? 'fail' : blanks.length || edited.length ? 'warn' : 'pass',
    summary: broken.length
      ? broken.map((r) => `${r.side} printed ${r.printed.score}/${r.printed.total}, verdicts give ${r.orig.score}/${r.orig.total}`).join(' · ')
      : edited.length
        ? `Verdicts edited in the studio — now ${edited.map((r) => `${r.side} ${r.now.pct}%`).join(' · ')} (printed ${edited.map((r) => `${r.printed.percentage}%`).join(' · ')})`
        : 'Printed RD / AD1 / AD2 scores match the verdicts exactly.',
    detail: [
      broken.length && 'The printed score does not follow from the verdicts in the record, so every score gate on this task is unreliable. Usually a verdict was edited after scoring, or the export is stale — re-pull before auditing.',
      blanks.length && `Criteria with no verdict: ${blanks.map((r) => `${r.side} ${r.now.blank}`).join(', ')}.`,
      edited.length && 'The export reproduced exactly; the difference is fixes applied here. The printed score stays the source of truth for the RD gate, but check the stumping gates against the corrected AD scores.',
    ].filter(Boolean).join(' ') || null,
    rows: scoreRows.map(({ side, printed, now, orig }) => ({ side, printed, now, orig })) });

  // Stumping + the distance to each gate in verdict flips.
  const flips = (side, max) => {
    const s = t.scores?.[side];
    if (!s?.total) return null;
    const need = (max / 100) * s.total - s.score; // points to reach the gate
    const failed = t.criteria.filter((c) => c.weight > 0 && c.verdicts[side].passed === false).sort((x, y) => y.weight - x.weight);
    let acc = 0, k = 0;
    for (const c of failed) { if (acc > need) break; acc += c.weight; k++; }
    return acc > need ? { flips: k, pointsToGate: Math.round(need * 10) / 10, biggest: failed.slice(0, k).map((c) => c.n) } : { flips: null, pointsToGate: Math.round(need * 10) / 10 };
  };
  const f1 = flips('ad1', GATES.ad1Max), f2 = flips('ad2', GATES.ad2Max);
  const over = [a1 != null && a1 > GATES.ad1Max && `AD1 ${a1}% > 70%`, a2 != null && a2 > GATES.ad2Max && `AD2 ${a2}% > 50%`].filter(Boolean);
  const atRisk = [
    a1 != null && a1 <= GATES.ad1Max && GATES.ad1Max - a1 <= GATES.atRiskPts && `AD1 is ${pct(GATES.ad1Max - a1)} pts under the gate${f1?.flips ? ` — ${f1.flips} verdict flip${f1.flips > 1 ? 's' : ''} (C${f1.biggest.join(', C')}) would cross it` : ''}`,
    a2 != null && a2 <= GATES.ad2Max && GATES.ad2Max - a2 <= GATES.atRiskPts && `AD2 is ${pct(GATES.ad2Max - a2)} pts under the gate${f2?.flips ? ` — ${f2.flips} verdict flip${f2.flips > 1 ? 's' : ''} (C${f2.biggest.join(', C')}) would cross it` : ''}`,
  ].filter(Boolean);
  add({ id: 'stumping', dim: 'D18', label: 'Stumping: AD1 ≤ 70%, AD2 ≤ 50%',
    status: a1 == null || a2 == null ? 'na' : over.length ? 'fail' : atRisk.length ? 'warn' : 'pass',
    summary: `AD1 ${a1 ?? '—'}% (${t.models.ad1 || '?'}) · AD2 ${a2 ?? '—'}% (${t.models.ad2 || '?'})`,
    detail: [...over, ...atRisk].join('. ') || null,
    note: atRisk.length ? 'Borderline score: validate every AD verdict and the weights behind it before accepting it — the audit workflow flags scores just under a gate as the place engineered stumping hides.' : null,
    evidence: [...new Set([
      ...(a1 != null && GATES.ad1Max - a1 <= GATES.atRiskPts && a1 <= GATES.ad1Max ? f1?.biggest || [] : []),
      ...(a2 != null && GATES.ad2Max - a2 <= GATES.atRiskPts && a2 <= GATES.ad2Max ? f2?.biggest || [] : []),
    ])].map((i) => `crit://C${i}`) });

  if (a2 != null && a2 < GATES.ad2CalibMin) {
    add({ id: 'calib', dim: null, label: 'Reference-model calibration (25–50%)', status: 'info',
      summary: `AD2 at ${a2}% is below the 25% floor the spec calibrates the reference model to.`,
      detail: 'Not a gate in the grading rubric — the project context says tasks are calibrated so the reference model scores uniformly between 25% and 50%. Very low scores can mean over-punishing criteria.' });
  }

  const mix = weightMix(t.criteria);
  const mixProblems = [
    mix.quality < GATES.qualityMinPos && `Aesthetics + functionality + usability is ${mix.quality}% of positive weight (needs ≥ 65%)`,
    mix.other > 0 && `${mix.other}% sits in categories outside the three buckets`,
  ].filter(Boolean);
  const mixNotes = [
    Math.abs(mix.brief - GATES.target.brief) > 10 && `brief compliance ${mix.brief}% vs the 30% target`,
    Math.abs(mix.format - GATES.target.format) > 5 && `formatting ${mix.format}% vs the 5% target`,
  ].filter(Boolean);
  add({ id: 'weights', dim: 'D4', label: 'Weight mix (5 / 30 / 65)',
    status: mix.quality < GATES.qualityMinPos ? 'fail' : (mix.other > 0 || mixNotes.length) ? 'warn' : 'pass',
    summary: `Format ${mix.format}% · Brief ${mix.brief}% · Quality ${mix.quality}%${mix.other ? ` · Other ${mix.other}%` : ''}`,
    detail: [...mixProblems, ...mixNotes].join('; ') || null,
    note: 'Only the ≥65% quality floor is a hard gate. The second half of the Weights dimension — mis-weighted criteria that AD1/AD2 fail — needs an auditor.',
    mix });

  const paths = checkPaths(t);
  const pFail = paths.problems.filter((p) => p.sev === 'fail');
  add({ id: 'paths', dim: 'D19', label: 'File names and paths',
    status: pFail.length ? 'fail' : paths.problems.length || paths.unlisted.length ? 'warn' : 'pass',
    summary: pFail.length ? `${pFail.length} brief path${pFail.length > 1 ? 's' : ''} don't resolve.` : paths.explicit.length || paths.ranges.length ? 'Every explicit brief path resolves.' : 'The brief names no explicit paths.',
    detail: [
      ...paths.problems.map((p) => p.text),
      paths.unlisted.length ? `${paths.unlisted.length} input file${paths.unlisted.length > 1 ? 's are' : ' is'} never mentioned in the brief: ${paths.unlisted.slice(0, 12).map((f) => f.rel).join(', ')}${paths.unlisted.length > 12 ? '…' : ''}` : null,
    ].filter(Boolean).join(' '),
    note: 'Unlisted inputs are not a fail on their own — but a brief rewritten at the sufficiency step can drop files the models were given.',
    paths });

  // Preference ↔ score alignment, per pair.
  const pairs = prefSummary(t.pref);
  const align = pairs.map((p) => {
    const L = sc(SIDE_OF[p.left]), R = sc(SIDE_OF[p.right]);
    if (L == null || R == null) return null;
    const gap = L - R; // + = left scores higher
    const prefers = p.mean < 3.5 ? 'left' : p.mean > 4.5 ? 'right' : 'neutral';
    const scoreFavors = Math.abs(gap) <= 2 ? 'tie' : gap > 0 ? 'left' : 'right';
    let status = 'pass', why = null;
    if (prefers !== 'neutral' && scoreFavors !== 'tie' && prefers !== scoreFavors) {
      status = Math.abs(gap) > 10 ? 'fail' : 'warn';
      why = `${p.left} vs ${p.right}: preference leans ${prefers === 'left' ? p.left : p.right} (mean ${p.mean}) but the rubric has ${scoreFavors === 'left' ? p.left : p.right} ahead by ${pct(Math.abs(gap))} pts.`;
    } else if (prefers === 'neutral' && Math.abs(gap) > 20) {
      status = 'warn';
      why = `${p.left} vs ${p.right}: preference is neutral (mean ${p.mean}) but the rubric gap is ${pct(Math.abs(gap))} pts.`;
    } else if (p.left === 'RD' && prefers === 'left' && R >= 85) {
      status = 'warn';
      why = `RD is preferred over ${p.right}, yet ${p.right} earns ${R}% of the rubric.`;
    }
    return { pair: p.pair, left: p.left, right: p.right, mean: p.mean, gap: pct(gap), status, why };
  }).filter(Boolean);
  const worst = align.some((x) => x.status === 'fail') ? 'fail' : align.some((x) => x.status === 'warn') ? 'warn' : align.length ? 'pass' : 'na';
  add({ id: 'alignment', dim: 'D13', label: 'Preference ↔ rubric alignment', status: worst,
    summary: align.length ? align.map((x) => `${x.left}–${x.right} ${x.mean}`).join(' · ') : 'No preference ranking in the record.',
    detail: align.filter((x) => x.why).map((x) => x.why).join(' ') || null,
    align });

  const prov = checkProvenance(t);
  if (!prov.applies) {
    add({ id: 'provenance', dim: 'D20', label: 'Derived-deliverable provenance', status: 'na',
      summary: 'The brief does not ask for a deliverable derived from a source file.' });
  } else {
    const ok = prov.strong.length > 0;
    add({ id: 'provenance', dim: 'D20', label: 'Derived-deliverable provenance', status: ok ? 'pass' : 'fail',
      summary: ok
        ? `C${prov.strong.map((c) => c.n).join(', C')} penalise generation instead of derivation at ≤ −8.`
        : prov.candidates.length
          ? `A provenance criterion exists (C${prov.candidates.map((c) => c.n).join(', C')}) but is weighted above −8.`
          : 'The brief asks for derived deliverables (renders/exports) but no criterion penalises generating them instead.',
      detail: 'Spec: the rubric must carry a Critically Detrimental (−8 to −10) criterion that penalises generating the deliverable instead of deriving it, and names the evidence to check. Whether the RD/AD verdicts on it are right still needs an auditor.',
      evidence: prov.candidates.map((c) => `crit://C${c.n}`) });
  }

  // Justification integrity — exact-match tests, so no fuzzy false positives.
  //   column swap: one side's text reused on another side of the SAME criterion
  //                with the opposite verdict (text and verdict cannot both be right)
  //   row swap:    the same text on a DIFFERENT criterion (pasted on the wrong row)
  //   copies:      same text, same verdict across sides — legitimate for
  //                objective checks ("exactly 60 fps"), a smell on subjective ones
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const MIN_JUST = 40;
  const columnSwaps = [], copies = [];
  for (const c of t.criteria) {
    for (let i = 0; i < SIDES.length; i++) for (let j = i + 1; j < SIDES.length; j++) {
      const a = c.verdicts[SIDES[i].key], b = c.verdicts[SIDES[j].key];
      const na = norm(a.justification);
      if (na.length < MIN_JUST || na !== norm(b.justification)) continue;
      const hit = { n: c.n, sides: [SIDES[i], SIDES[j]], weight: c.weight };
      (a.passed !== null && b.passed !== null && a.passed !== b.passed ? columnSwaps : copies).push(hit);
    }
  }
  // Same text on different criteria, grouped: either one generic line stamped
  // across several atomic criteria, or a justification pasted on the wrong row.
  const byText = new Map();
  for (const c of t.criteria) {
    for (const s of SIDES) {
      const k = norm(c.verdicts[s.key].justification);
      if (k.length < MIN_JUST) continue;
      if (!byText.has(k)) byText.set(k, new Set());
      byText.get(k).add(c.n);
    }
  }
  const rowGroups = [...byText.values()].filter((g) => g.size > 1).map((g) => [...g].sort((a, b) => a - b));
  const rowCrit = [...new Set(rowGroups.flat())];
  const sideLink = (n, s) => `C${n}·${s.label}`;
  const bucketByN = Object.fromEntries(t.criteria.map((c) => [c.n, c.bucket]));
  const copiedCrit = [...new Set(copies.map((x) => x.n))];
  // Only subjective (quality-bucket), heavy criteria make a copy suspicious —
  // two files can both honestly be "a stereo WAV at 48 kHz".
  const suspectCopies = [...new Set(copies.filter((x) => Math.abs(x.weight) >= 7 && bucketByN[x.n] === 'quality').map((x) => x.n))];
  add({ id: 'integrity', dim: 'D12', label: 'Justification integrity',
    status: columnSwaps.length ? 'fail' : rowGroups.length || suspectCopies.length ? 'warn' : 'pass',
    summary: columnSwaps.length || rowGroups.length || copiedCrit.length
      ? [
        columnSwaps.length && `${columnSwaps.length} identical justification${columnSwaps.length > 1 ? 's' : ''} with opposite verdicts`,
        rowGroups.length && `${rowCrit.length} criteria share one justification`,
        suspectCopies.length && `${suspectCopies.length} subjective ${suspectCopies.length > 1 ? 'criteria' : 'criterion'} copied across responses`,
        !suspectCopies.length && copiedCrit.length && `${copiedCrit.length} objective ${copiedCrit.length > 1 ? 'criteria' : 'criterion'} copied across responses`,
      ].filter(Boolean).join(' · ')
      : 'No justification is reused across responses or criteria.',
    detail: [
      columnSwaps.length && `Same text, opposite verdicts — one of each pair is wrong: ${columnSwaps.map((x) => `${sideLink(x.n, x.sides[0])} = ${sideLink(x.n, x.sides[1])}`).join(', ')}.`,
      rowGroups.length && `One justification on several criteria — generic, or pasted on the wrong row: ${rowGroups.slice(0, 8).map((g) => `C${g.join('/C')}`).join('; ')}${rowGroups.length > 8 ? '…' : ''}.`,
      suspectCopies.length && `Heavy aesthetic/functional criteria with the same text on two responses: C${suspectCopies.join(', C')} — the customer flagged copy-pasted justifications.`,
      copiedCrit.length && `${copiedCrit.length} criteria in all carry identical text across responses with the same verdict; fine for objective checks.`,
    ].filter(Boolean).join(' ') || null,
    note: 'Exact matches only (case and punctuation ignored), so every hit is real reuse. Paraphrased or inverted text is left to the eval, which reads each justification against the artifact.',
    evidence: [...new Set([...columnSwaps.map((x) => x.n), ...rowCrit, ...suspectCopies])].map((n) => `crit://C${n}`) });

  // Heuristic signals for the auditor — never a verdict.
  const ad1Only = t.criteria.filter((c) => c.verdicts.golden.good === true && c.verdicts.ad1.good === false && c.verdicts.ad2.good === true);
  const goldenMisses = t.criteria.filter((c) => c.verdicts.golden.good === false);
  const expectAd1 = process.env.RLI_EXPECTED_AD1_MODEL;
  const wrongModel = expectAd1 && t.models.ad1 && !t.models.ad1.toLowerCase().includes(expectAd1.toLowerCase());
  if (ad1Only.length || goldenMisses.length || wrongModel) {
    add({ id: 'signals', dim: null, label: 'Signals worth a look', status: 'info',
      summary: [
        ad1Only.length && `${ad1Only.length} criteria only AD1 fails`,
        goldenMisses.length && `${goldenMisses.length} the golden fails`,
        wrongModel && `AD1 is ${t.models.ad1}, expected ${expectAd1}`,
      ].filter(Boolean).join(' · '),
      detail: [
        ad1Only.length && `Only-AD1 fails can be legitimate — or post-hoc criteria written around one model's flaw (the customer's "Ugh" example). Check: C${ad1Only.map((c) => c.n).join(', C')}.`,
        goldenMisses.length && `Golden misses: C${goldenMisses.map((c) => c.n).join(', C')} — confirm the golden really fails them rather than the criterion being mis-scoped.`,
        wrongModel && `RLI_EXPECTED_AD1_MODEL is "${expectAd1}" but this task's AD1 was produced by ${t.models.ad1}.`,
      ].filter(Boolean).join(' '),
      evidence: [...ad1Only, ...goldenMisses].map((c) => `crit://C${c.n}`) });
  }

  return checks;
}

export function checkRollup(checks) {
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  return { fail: fails.length, warn: warns.length, failing: fails.map((c) => c.label), warning: warns.map((c) => c.label) };
}
