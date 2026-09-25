import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Customer program spec lives in spec/, committed to this private repo so the
// app is self-contained on deploy (see spec/README.md). The canon is embedded
// in every copilot/docgen system prompt; full docs are served on demand via the
// read_spec tool; the V11 rubric is parsed for the UI's QC-spec view and
// spec://R# citations.
const specDir = config.specDir;

export const SPEC_FILES = {
  v11_rubric: 'V11_RUBRIC.csv',
  nwr_checklist: 'NWR_CHECKLIST.md',
  qc_rubric_v2_legacy: 'QC_RUBRIC.md',
  gap_analysis: 'QC_GAP_ANALYSIS.md',
};

export const QUALITY_CANON = read('QUALITY_CANON.md');

export function readSpec(name) {
  const file = SPEC_FILES[name];
  if (!file) throw new Error(`unknown spec "${name}" — one of: ${Object.keys(SPEC_FILES).join(', ')}`);
  if (name === 'v11_rubric') {
    const dims = getRubric();
    if (!dims.length) return '(V11 rubric missing from spec/)';
    return dims
      .map((d) =>
        [`=== ${d.key} (${d.id}) · ${d.category} — ${d.name}`,
          d.description ? `Auditor notes: ${d.description}` : null,
          ...d.options.map((o) =>
            `  [${SCORE_BANDS[o.score] || o.score}]${o.category ? ` ${o.category}:` : ''} ${o.text}`),
        ].filter(Boolean).join('\n')
      )
      .join('\n\n');
  }
  return read(file);
}

function read(file) {
  try {
    return fs.readFileSync(path.join(specDir, file), 'utf8');
  } catch {
    return `(spec file ${file} missing from ${specDir})`;
  }
}

// ---- V11 rubric (platform CSV export) ----
// Row with a title starts a dimension; following rows carry its remaining
// answer options. Keys R1..Rn are assigned in file order and are the citation
// handles used by the copilot (spec://R12) and the UI anchors. V11 keeps V5's 25
// dimensions in the same order, so R1-R25 stay a stable 1:1 alias for the V11
// UUIDs (dim.id) that the platform uses.
// Source of truth: the admin-uploaded copy in DATA_DIR (writable, persists in
// the data volume); falls back to a file dropped into SPEC_DIR.
export const SCORE_BANDS = { 1: '1 Fail', 2: '2 Fail', 3: '3 Non-Fail', 4: '4 Non-Fail (minor)', 5: '5 Pass' };
let rubricCache = null;
const uploadedRubricPath = path.join(config.dataDir, 'rubric.csv');

// Admin uploads the QC rubric once; stored in the writable data volume so it
// survives restarts and is served to every reviewer.
export function saveRubricCsv(csvText) {
  const dims = parseCsv(csvText);
  if (!dims.length || !dims.some((r) => r[1])) throw new Error('that does not look like a rubric CSV (no titled rows)');
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(uploadedRubricPath, csvText);
  rubricCache = null;
  return getRubric();
}

// RLI queue: the QC spec ships as structured JSON (spec/RLI_QC_SPEC.json,
// transcribed from the "Updated RLI spec doc"). When present it wins over the
// V11 CSV; dimensions are keyed D1..Dn and cited as spec://D<n>.
export const RLI_SPEC = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(specDir, 'RLI_QC_SPEC.json'), 'utf8')); } catch { return null; }
})();
export const SPEC_PREFIX = RLI_SPEC ? 'D' : 'R';

function rliDims() {
  return RLI_SPEC.dimensions.map((d, i) => ({
    key: `D${i + 1}`,
    id: `D${i + 1}`,
    category: d.category,
    group: d.name,
    variant: null,
    name: d.name,
    description: d.notes || '',
    auto: d.auto || null,
    options: d.options.map((o) => ({ score: o.score, category: o.label === 'No Issues' ? null : o.label, text: o.text, requiresJustification: o.score < 5 })),
  }));
}

export function getRubric() {
  if (rubricCache) return rubricCache;
  if (RLI_SPEC) return (rubricCache = rliDims());
  let raw;
  for (const p of [uploadedRubricPath, path.join(specDir, 'V11_RUBRIC.csv')]) {
    try { raw = fs.readFileSync(p, 'utf8'); break; } catch { /* try next */ }
  }
  if (!raw) return (rubricCache = []);
  const rows = parseCsv(raw);
  const dims = [];
  let cur = null;
  for (const r of rows.slice(1)) {
    const [id, title, , questionDescription, , , , , , , optText, optScore, optJustify] = r;
    if (title) {
      // Titles encode "Category - Group - Variant" (variant optional), e.g.
      // "Ranking & Rationale - Trajectory Summaries - Accuracy". Sibling
      // variants of one group are bundled together in the UI.
      const parts = title.split(' - ').map((s) => s.trim());
      cur = {
        key: `R${dims.length + 1}`,
        id,
        category: parts[0] || 'Other',
        group: parts.length > 2 ? parts.slice(1, -1).join(' — ') : parts[1] || title,
        variant: parts.length > 2 ? parts[parts.length - 1] : null,
        name: parts.slice(1).join(' — ').trim() || title,
        description: depara(questionDescription).replace(/^\.\s*/, '').replace(/\s*See the spec doc for examples\.?/g, '').replace(/\s*For all options except the last, apply (an|the) error categor(y|ies)\.?/g, '').replace(/\n{3,}/g, '\n\n').trim(),
        options: [],
      };
      dims.push(cur);
    }
    if (cur && optText) {
      // V11 prefixes each non-pass option with its error-category label in
      // brackets ("[Fail - Missing Core Evidence]"); lift it out of the prose so
      // the UI can tag it and the band text reads as one sentence.
      const text = depara(optText).trim();
      const label = text.match(/^\[([^\]\n]+)\]\s*/);
      cur.options.push({
        score: Number(optScore) || null,
        category: label ? label[1].trim() : null,
        text: (label ? text.slice(label[0].length) : text).trim(),
        requiresJustification: optJustify === 'true',
      });
    }
  }
  for (const d of dims) d.options.sort((a, b) => (a.score || 9) - (b.score || 9));
  return (rubricCache = dims);
}

// The V11 export carries Word-style paragraph marks (¶, sometimes doubled) at
// the head of continuation lines, where the newline is already present. Drop
// them so the text renders as prose instead of "¶NOTE: …".
function depara(s) {
  return (s || '').replace(/(^|\n)[ \t]*¶+[ \t]*/g, '$1');
}

// Minimal RFC-4180 CSV parser (quoted fields, embedded newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
