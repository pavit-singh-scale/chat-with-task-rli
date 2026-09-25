#!/usr/bin/env node
// Ingest an RLI delivery_sender_preview JSON into the board.
//
//   node tools/rli/ingest.mjs <preview.json> [--force] [--no-files]
//
// Each record becomes workspace/<bucket>/<task_id>/ with:
//   task.json          the record, verbatim
//   files/<side>/      input / golden / ad1 / ad2, downloaded + unzipped
//   files/_sources.json  the source URLs (the S3 links are the only copy)
// Bucket = HARD_FAIL (shown as "Fail") when a deterministic spec gate already
// fails, otherwise UNSORTED — only a human audit can clear a task to No issues.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../../src/config.js';
import { readRliIn, checkRollup } from '../../src/rli.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
const noFiles = args.includes('--no-files');
if (!file) { console.error('usage: node tools/rli/ingest.mjs <preview.json> [--force] [--no-files]'); process.exit(1); }

const records = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(records)) throw new Error('expected a JSON array of task records');
const BUCKETS = ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED'];
for (const b of BUCKETS) fs.mkdirSync(path.join(config.workspaceRoot, b), { recursive: true });

const SIDE_SRC = { input: 'inputs', golden: 'golden_deliverables', ad1: 'ad1_artifacts', ad2: 'ad2_artifacts' };

function existingDir(id) {
  for (const b of BUCKETS) {
    const d = path.join(config.workspaceRoot, b, id);
    if (fs.existsSync(d)) return d;
  }
  return null;
}

// curl, not fetch: undici drops the larger artifact zips mid-stream; curl with
// retries is what the ACC studio's ranking-proof downloader already relies on.
async function download(url, dest) {
  execFileSync('curl', ['-sfL', '--retry', '3', '--retry-delay', '2', '-o', dest, url], { stdio: 'pipe' });
  return fs.statSync(dest).size;
}

function unzip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-qo', zip, '-d', destDir], { stdio: 'pipe' });
  // Collapse a single wrapper folder (e.g. golden/golden/...) so paths match the brief.
  const entries = fs.readdirSync(destDir).filter((n) => n !== '__MACOSX' && n !== '.DS_Store');
  if (entries.length === 1 && fs.statSync(path.join(destDir, entries[0])).isDirectory()
      && !/^inputs?$/i.test(entries[0])) {
    const inner = path.join(destDir, entries[0]);
    for (const n of fs.readdirSync(inner)) fs.renameSync(path.join(inner, n), path.join(destDir, n));
    fs.rmdirSync(inner);
  }
  // An inputs zip whose root is input/ — keep files at files/input/<name>.
  if (entries.length === 1 && /^inputs?$/i.test(entries[0])) {
    const inner = path.join(destDir, entries[0]);
    for (const n of fs.readdirSync(inner)) fs.renameSync(path.join(inner, n), path.join(destDir, n));
    fs.rmdirSync(inner);
  }
  fs.rmSync(path.join(destDir, '__MACOSX'), { recursive: true, force: true });
}

let added = 0, skipped = 0;
for (const rec of records) {
  const id = rec.task_id;
  if (!/^[a-f0-9]{24}$/.test(id || '')) { console.warn(`skip: bad task_id ${id}`); continue; }
  const prev = existingDir(id);
  if (prev && !force) { console.log(`= ${id} already on the board (${path.basename(path.dirname(prev))}) — --force to re-ingest`); skipped++; continue; }
  const stage = path.join(config.workspaceRoot, `.ingest-${id}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'files'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'task.json'), JSON.stringify(rec, null, 2));

  const sources = {};
  if (!noFiles) {
    for (const [side, key] of Object.entries(SIDE_SRC)) {
      const list = rec[key]?.files || [];
      for (const f of list) {
        if (!f?.url) continue;
        sources[side] = [...(sources[side] || []), f];
        const tmp = path.join(stage, 'files', `_${side}_${path.basename(f.path || 'file')}`);
        try {
          const bytes = await download(f.url, tmp);
          if (/\.zip$/i.test(f.path || '') || fs.readFileSync(tmp).subarray(0, 2).toString() === 'PK') {
            unzip(tmp, path.join(stage, 'files', side));
            fs.rmSync(tmp);
          } else {
            fs.mkdirSync(path.join(stage, 'files', side), { recursive: true });
            fs.renameSync(tmp, path.join(stage, 'files', side, path.basename(f.path)));
          }
          process.stdout.write(`  ${side}: ${(bytes / 1e6).toFixed(1)} MB\n`);
        } catch (e) {
          console.warn(`  ! ${side}: ${e.message}`);
        }
      }
    }
  }
  fs.writeFileSync(path.join(stage, 'files', '_sources.json'), JSON.stringify(sources, null, 2));

  const t = readRliIn(stage);
  const roll = checkRollup(t.checks);
  const bucket = roll.fail ? 'HARD_FAIL' : 'UNSORTED';
  if (prev) fs.rmSync(prev, { recursive: true, force: true });
  const dest = path.join(config.workspaceRoot, bucket, id);
  fs.renameSync(stage, dest);
  added++;
  console.log(`+ ${id} ${t.domain.padEnd(32)} → ${bucket === 'HARD_FAIL' ? 'Fail    ' : 'Unsorted'} ${roll.fail ? `(${roll.failing.join('; ')})` : ''}`);
}
console.log(`\ndone: ${added} ingested, ${skipped} already present.`);
