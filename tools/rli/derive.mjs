#!/usr/bin/env node
// Build browser-viewable derivatives (GLB / SVG / PNG) for every RLI task on
// the board. Idempotent; --force rebuilds.  node tools/rli/derive.mjs [--force] [task_id…]
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../src/config.js';
import { deriveTask, toolStatus } from '../../src/rli_derive.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = new Set(args.filter((a) => /^[a-f0-9]{24}$/.test(a)));
console.log('tools:', toolStatus());
for (const b of ['HARD_FAIL', 'SOFT_FAIL', 'PASS', 'UNSORTED']) {
  const bdir = path.join(config.workspaceRoot, b);
  if (!fs.existsSync(bdir)) continue;
  for (const id of fs.readdirSync(bdir)) {
    if (only.size && !only.has(id)) continue;
    const dir = path.join(bdir, id);
    if (!fs.existsSync(path.join(dir, 'task.json'))) continue;
    const r = deriveTask(dir, { force, log: (m) => console.log(`  ${id.slice(-6)} ${m}`) });
    if (r.length) console.log(`${id}: ${r.filter((x) => x.status === 'ok').length} built, ${r.filter((x) => x.status === 'cached').length} cached, ${r.filter((x) => ['error', 'none'].includes(x.status)).length} without a derivative`);
  }
}
