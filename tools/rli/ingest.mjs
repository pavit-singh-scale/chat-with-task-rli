#!/usr/bin/env node
// Ingest an RLI delivery_sender_preview JSON into the board.
//
//   node tools/rli/ingest.mjs <preview.json> [--no-files]
//
// New tasks are downloaded + derived; unchanged ones are left alone; a changed
// record REOPENS its task (see src/rli_ingest.js for the carry-over rules).
import fs from 'node:fs';
import { ingestRecords } from '../../src/rli_ingest.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node tools/rli/ingest.mjs <preview.json> [--no-files]'); process.exit(1); }
const records = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Array.isArray(records)) throw new Error('expected a JSON array of task records');
const out = ingestRecords(records, { noFiles: args.includes('--no-files'), log: (m) => console.log(m) });
const n = (a) => out.filter((r) => r.action === a).length;
console.log(`\ndone: ${n('added')} added · ${n('reopened')} reopened · ${n('unchanged')} unchanged · ${n('error')} errors`);
