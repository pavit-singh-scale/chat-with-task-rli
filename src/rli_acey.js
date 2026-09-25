// Acey for RLI tasks — the task-scoped copilot, re-pointed at the RLI record.
//
// ACC Acey reads rank.json and two agent trajectories. An RLI task is a brief,
// a rubric graded three ways (RD / AD1 / AD2), a preference ranking and a pile
// of artifacts, so it gets its own prompt, canon, citation forms and tools.
// The one genuinely new capability is view_artifact: most RLI verdicts are
// visual ("the crown is flat, not rounded"), and they can only be checked by
// looking at the render.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RLI_SPEC } from './spec.js';
import { readRliIn, readRecord, kindOf } from './rli.js';
import { resolveSafe } from './workspace.js';

export const RLI_CHAT_PROMPT = `
You are Acey, the QC expert embedded in an auditor's session on the RLI queue (Anthropic custom
data, project 6a989ef00d42ba8e15aaac6c). Each task is a professional creative brief with input
files, a human expert's reference deliverable (RD, the golden), two model attempts (AD1, AD2), a
rubric of weighted pass/fail criteria graded for all three, and a pairwise preference ranking.
The auditor is checking the CONTRIBUTOR's work — the brief, the rubric, the verdicts, the
justifications and the ranking — against the QC spec below. You are the source of truth they
consult; answer the question asked.

How to work:
- Start from task_overview. Pull criteria with get_criteria (filter narrowly), preference with
  get_preference, the automated checks with get_checks.
- Visual claims are only verifiable by looking. When a verdict or justification says something
  about how an artifact looks, open it with view_artifact (renders, drawings, PDF pages, UV
  sheets) and compare RD/AD1/AD2 side by side. For video, view_artifact shows stills; for any
  claim about duration, resolution, format, loudness, clipping or silence, use probe_media and
  quote the numbers. Say plainly what still can't be checked (3D-only geometry, motion, pacing,
  voice quality) and what the auditor should check by hand.
- Penalty criteria (negative weight): "passed: true" means the defect IS present and its weight
  is deducted. Never read a penalty verdict the other way round.
- Scores: % = (positive weights passed − |negative weights| present) ÷ sum of positive weights.
  The printed RD score is the source of truth for the ≥97% gate — never re-derive it downward.

Answer discipline:
- Lead with the verdict in one sentence. Then **Where** (criterion / file / comparison, as a
  citation link), **Evidence** (what you read or saw, quoted or described precisely), **Rule**
  (the spec dimension that decides it, as a spec:// link) when severity or policy is involved.
- Under ~150 words unless asked for depth. No preamble, no recap of what the page already shows.
- Grade to the spec: Fail (1) / Non-fail (3) / No issues (5), with the one dimension that decides it.
  Automated checks are evidence, not verdicts — confirm or overturn them with what you see.
- Never assert something about an artifact you have not opened, or a criterion you have not read,
  in this conversation. If you cannot verify, say "unverified" and what would settle it.

Taking action on the board (move_task, propose_bulk_move, list_board) follows the same rules as
everywhere in the studio: only when explicitly asked, one move per turn, bulk moves are proposals.
`.trim();

export const RLI_CITATION_RULES = `
Citation forms (mandatory — the UI turns each into a button that jumps there):
- A rubric criterion: [C12](crit://C12), or one response's verdict on it: [C12 · AD1](crit://C12/ad1)
  (sides: rd, ad1, ad2). Use the C-number from get_criteria.
- An artifact: [Render07.jpg](file://files/golden/Render07.jpg) — the exact path from list_artifacts.
- A preference cell: [RD vs AD1 · Realism](pref://rd_vs_ad1/realism) (pairs rd_vs_ad1, rd_vs_ad2,
  ad1_vs_ad2; dimension ids from get_preference).
- A spec dimension: [D4 Weights](spec://D4) — D-keys from the canon. Cite the deciding dimension
  on every severity call.
- Use complete 24-char task ids.
`.trim();

export function rliCanon() {
  if (!RLI_SPEC) return '';
  const dims = RLI_SPEC.dimensions.map((d, i) =>
    `D${i + 1} ${d.category} · ${d.name}${d.auto ? ' [auto-checked]' : ''}\n` +
    d.options.map((o) => `  ${o.score}: ${o.label === 'No Issues' ? 'No issues' : o.label} — ${o.text}`).join('\n'));
  return [
    '# RLI QC spec (Updated RLI spec doc — source of truth)',
    RLI_SPEC.context,
    'Grading: ' + RLI_SPEC.grading.join(' '),
    'Weight mix (project decision): 5% formatting / 30% brief compliance (incl. Correctness) / 65% aesthetics + functionality + usability/professionalism, measured on positive weight; ≥65% quality is the hard gate.',
    dims.join('\n\n'),
  ].join('\n\n');
}

export function rliTaskContext(dir) {
  const t = readRliIn(dir);
  const fails = t.checks.filter((c) => c.status === 'fail').map((c) => `${c.label} (${c.dim || '—'}): ${c.summary}`);
  const warns = t.checks.filter((c) => c.status === 'warn').map((c) => `${c.label} (${c.dim || '—'}): ${c.summary}`);
  return [
    `Task ID: ${t.task_id} · ${t.domain} · ${t.timeline || 'no timeline'}`,
    `AD1 = ${t.models.ad1 || '?'} · AD2 = ${t.models.ad2 || '?'}`,
    `Scores: RD ${t.scores?.golden?.percentage ?? '—'}% · AD1 ${t.scores?.ad1?.percentage ?? '—'}% · AD2 ${t.scores?.ad2?.percentage ?? '—'}% · ${t.criteria.length} criteria`,
    t.missing.length ? `Record is missing: ${t.missing.join(', ')}` : null,
    fails.length ? `Automated check FAILS:\n- ${fails.join('\n- ')}` : 'Automated checks: no fails.',
    warns.length ? `Automated checks to verify:\n- ${warns.join('\n- ')}` : null,
    `Brief:\n${String(t.brief || '(none)').slice(0, 6000)}`,
    `Artifacts: inputs ${t.files.input.length} · RD ${t.files.golden.length} · AD1 ${t.files.ad1.length} · AD2 ${t.files.ad2.length}`,
  ].filter(Boolean).join('\n\n');
}

const SIDE_OF = { rd: 'golden', golden: 'golden', ad1: 'ad1', ad2: 'ad2' };

export const RLI_TOOL_DEFS = [
  { type: 'function', function: { name: 'task_overview', description: 'Scores vs gates, weight mix, automated check results, and the artifact inventory for this RLI task.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
    name: 'get_criteria',
    description: 'Rubric criteria with weight, category and the RD/AD1/AD2 verdicts (and justifications on request). Filter narrowly.',
    parameters: { type: 'object', properties: {
      filter: { type: 'string', enum: ['all', 'split', 'ad1_only', 'golden_fails', 'penalties', 'heavy'], description: 'split = verdicts differ; ad1_only = only AD1 fails; heavy = |weight| ≥ 8' },
      category: { type: 'string', description: 'exact category name, e.g. Aesthetics' },
      ids: { type: 'array', items: { type: 'integer' }, description: 'C-numbers to fetch' },
      search: { type: 'string', description: 'substring match on the criterion text' },
      justifications: { type: 'boolean', description: 'include the three justifications (default true when ids given)' },
    } },
  } },
  { type: 'function', function: { name: 'get_preference', description: 'The pairwise preference ranking: every dimension score (1 = left better … 7 = right better) and each justification, plus the rubric scores for each pair.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_checks', description: 'The automated spec checks with full detail and the criteria they point at.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: {
    name: 'list_artifacts',
    description: 'Files for a side (input, rd, ad1, ad2) with kind, size and whether a browser derivative exists.',
    parameters: { type: 'object', properties: { side: { type: 'string', enum: ['input', 'rd', 'ad1', 'ad2', 'all'] } } },
  } },
  { type: 'function', function: {
    name: 'view_artifact',
    description: 'LOOK at up to 4 artifacts at once (images, rendered drawings from DWG, SketchUp previews, the first page of a PDF). A video path shows evenly spaced stills from it instead (all 6 when it is the only path, else 2). Use to verify visual verdicts and to compare RD/AD1/AD2. Paths come from list_artifacts.',
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, maxItems: 4 } }, required: ['paths'] },
  } },
  { type: 'function', function: {
    name: 'probe_media',
    description: 'Measurements for video/audio artifacts you cannot watch or hear: duration, resolution, fps, orientation, sample rate, bit depth, channels, peak/RMS dB, silence spans, and flags (silent track, possible clipping, trailing/leading silence). Use to check any verdict about length, format, loudness, clipping or truncation. A flag is a lead, not a verdict — say what the numbers show.',
    parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, maxItems: 8 } }, required: ['paths'] },
  } },
  { type: 'function', function: {
    name: 'read_text_artifact',
    description: 'Read a text artifact (md, txt, json, csv, code, generation notes).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['path'] },
  } },
  { type: 'function', function: {
    name: 'read_spec',
    description: 'Full text of the RLI QC spec, or one dimension (e.g. "D4").',
    parameters: { type: 'object', properties: { dimension: { type: 'string' } } },
  } },
];

// Shrink an image for the model (≤1568px long edge, JPEG) with macOS sips.
function toModelImage(abs) {
  const tmp = path.join(os.tmpdir(), `rli-view-${process.pid}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    const isPdf = /\.pdf$/i.test(abs);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1568', abs, '--out', tmp], { stdio: 'pipe', timeout: 60_000 });
    const b64 = fs.readFileSync(tmp).toString('base64');
    return { mime: 'image/jpeg', b64, note: isPdf ? 'first page of the PDF' : null };
  } catch {
    // SVG / unsupported: send the original if it is a raster the API accepts.
    if (/\.(png|jpe?g|gif|webp)$/i.test(abs) && fs.statSync(abs).size < 4_500_000) {
      const ext = abs.split('.').pop().toLowerCase().replace('jpg', 'jpeg');
      return { mime: `image/${ext}`, b64: fs.readFileSync(abs).toString('base64') };
    }
    return null;
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function makeRliExecutor(dirIn) {
  const dir = path.resolve(dirIn);
  const t = () => readRliIn(dir);
  const all = (tt) => [...tt.files.input, ...tt.files.golden, ...tt.files.ad1, ...tt.files.ad2];
  const crit = (c, withJ) => ({
    C: c.n, weight: c.weight, category: c.category, bucket: c.bucket, text: c.title,
    verdicts: Object.fromEntries(['golden', 'ad1', 'ad2'].map((s) => [s === 'golden' ? 'RD' : s.toUpperCase(),
      c.weight < 0 ? (c.verdicts[s].passed ? 'defect present' : 'defect absent') : (c.verdicts[s].passed ? 'pass' : 'fail')])),
    ...(withJ ? { justifications: { RD: c.verdicts.golden.justification, AD1: c.verdicts.ad1.justification, AD2: c.verdicts.ad2.justification } } : {}),
  });
  return async (name, args = {}) => {
    const tt = t();
    switch (name) {
      case 'task_overview':
        return JSON.stringify({
          task_id: tt.task_id, domain: tt.domain, timeline: tt.timeline, models: tt.models, scores: tt.scores,
          criteria: tt.criteria.length, missing: tt.missing,
          weight_mix: tt.checks.find((c) => c.id === 'weights')?.mix,
          checks: tt.checks.map((c) => ({ id: c.id, dim: c.dim, status: c.status, label: c.label, summary: c.summary })),
          artifacts: Object.fromEntries(Object.entries(tt.files).map(([k, v]) => [k === 'golden' ? 'rd' : k, v.map((f) => `${f.path} (${f.kind}${f.derived ? `, viewable as ${f.derived.kind}` : ''})`)])),
        }, null, 1);
      case 'get_criteria': {
        let list = tt.criteria;
        const g = (c, s) => c.verdicts[s].good;
        if (args.filter === 'split') list = list.filter((c) => new Set([g(c, 'golden'), g(c, 'ad1'), g(c, 'ad2')]).size > 1);
        if (args.filter === 'ad1_only') list = list.filter((c) => g(c, 'golden') && !g(c, 'ad1') && g(c, 'ad2'));
        if (args.filter === 'golden_fails') list = list.filter((c) => g(c, 'golden') === false);
        if (args.filter === 'penalties') list = list.filter((c) => c.weight < 0);
        if (args.filter === 'heavy') list = list.filter((c) => Math.abs(c.weight) >= 8);
        if (args.category) list = list.filter((c) => c.category.toLowerCase() === String(args.category).toLowerCase());
        if (args.ids?.length) list = list.filter((c) => args.ids.includes(c.n));
        if (args.search) list = list.filter((c) => c.title.toLowerCase().includes(String(args.search).toLowerCase()));
        const withJ = args.justifications ?? (!!args.ids?.length || list.length <= 12);
        return JSON.stringify({ count: list.length, of: tt.criteria.length, criteria: list.slice(0, 100).map((c) => crit(c, withJ)) }, null, 1);
      }
      case 'get_preference':
        return JSON.stringify({ type: tt.pref?.type, rd_better_than_ads: tt.pref?.rd_better_than_ads, scores: tt.scores, comparisons: tt.pref?.comparisons || [], alignment: tt.checks.find((c) => c.id === 'alignment')?.align }, null, 1);
      case 'get_checks':
        return JSON.stringify(tt.checks, null, 1).slice(0, 60_000);
      case 'list_artifacts': {
        const side = args.side && args.side !== 'all' ? SIDE_OF[args.side] || args.side : null;
        const files = side ? tt.files[side] || [] : all(tt);
        return JSON.stringify(files.map((f) => ({ path: f.path, kind: f.kind, size: f.size, derived: f.derived?.kind || null,
          ...(f.media ? { duration_s: f.media.duration_s, stills: f.media.frames.length || undefined, media_flags: f.media.flags.length ? f.media.flags : undefined } : {}) })), null, 1);
      }
      case 'view_artifact': {
        const paths = (args.paths || []).slice(0, 4);
        const byPath = new Map(all(tt).map((f) => [f.path, f]));
        const images = [];
        const notes = [];
        for (const p of paths) {
          const f = byPath.get(p);
          if (!f) { notes.push(`${p}: not an artifact of this task (use list_artifacts)`); continue; }
          if (f.kind === 'video') {
            const frames = f.media?.frames || [];
            if (!frames.length) { notes.push(`${p}: video with no extracted stills (run tools/rli/derive.mjs) — ask the auditor to watch it`); continue; }
            const pick = paths.length === 1 ? frames : [frames[Math.floor(frames.length / 3)], frames[Math.floor((2 * frames.length) / 3)]];
            for (const fr of pick) {
              const img = toModelImage(resolveSafe(dir, fr.path));
              if (img) images.push({ ...img, label: `${p} — still at ${fr.t}s of ${f.media.duration_s}s` });
            }
            notes.push(`${p}: ${pick.length} still(s) shown (${pick.map((fr) => `${fr.t}s`).join(', ')}) — stills cannot show motion, pacing or audio`);
            continue;
          }
          let src = f.path, via = null;
          if (f.derived && ['image', 'drawing'].includes(f.derived.kind)) { src = f.derived.path; via = f.derived.label; }
          else if (f.derived?.thumb) { src = f.derived.thumb; via = 'sheet preview'; }
          if (!['image', 'pdf'].includes(kindOf(src))) {
            notes.push(`${p}: ${f.kind} can't be shown as an image${f.kind === 'model3d' ? ' — inspect the renders/wireframes instead, and tell the auditor to orbit the model in the viewer' : ''}.`);
            continue;
          }
          const img = toModelImage(resolveSafe(dir, src));
          if (!img) { notes.push(`${p}: could not convert for viewing`); continue; }
          images.push({ ...img, label: `${p}${via ? ` (${via})` : ''}${img.note ? ` — ${img.note}` : ''}` });
          notes.push(`${p}: shown${via ? ` via ${via}` : ''}`);
        }
        return { content: notes.join('\n') + (images.length ? `\n${images.length} image(s) attached below in order.` : ''), images };
      }
      case 'probe_media': {
        const byPath = new Map(all(tt).map((f) => [f.path, f]));
        return JSON.stringify((args.paths || []).slice(0, 8).map((p) => {
          const f = byPath.get(p);
          if (!f) return { path: p, error: 'not an artifact of this task' };
          if (!['video', 'audio'].includes(f.kind)) return { path: p, error: `${f.kind} is not video/audio` };
          if (!f.media) return { path: p, error: 'no probe cached — run tools/rli/derive.mjs' };
          const { frames, ...m } = f.media;
          return { path: p, ...m, stills: frames.map((fr) => fr.t) };
        }), null, 1);
      }
      case 'read_text_artifact': {
        const abs = resolveSafe(dir, String(args.path || ''));
        const text = fs.readFileSync(abs, 'utf8').split('\n');
        const off = Math.max(0, args.offset || 0), lim = Math.min(args.limit || 400, 2000);
        return text.slice(off, off + lim).join('\n').slice(0, 80_000);
      }
      case 'read_spec': {
        const canon = rliCanon();
        if (args.dimension) {
          const block = canon.split('\n\n').find((b) => b.startsWith(`${String(args.dimension).toUpperCase()} `));
          const i = Number(String(args.dimension).replace(/\D/g, '')) - 1;
          const notes = RLI_SPEC?.dimensions?.[i]?.notes;
          return [block || `no dimension ${args.dimension}`, notes ? `Notes for auditors: ${notes}` : ''].join('\n\n');
        }
        return canon;
      }
      default:
        return `ERROR: unknown tool ${name}`;
    }
  };
}

export { readRecord };
