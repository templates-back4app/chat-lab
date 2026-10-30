// File: scripts/measure-history.mjs · Node 22 ESM · M6 — history pagination: getMessages p50/p95 for a
// 50-message page at 1,000 and at 10,000 messages in the room. Data volume is the ONLY factor varied; the
// index is (room, createdAt) and the page is cursor-keyed (createdAt, objectId), stated in the evidence file.
// Two page shapes per size: the FIRST page (what a chat opens with) and a DEEP page (cursor at the oldest
// end — where offset pagination would degrade; cursor pagination should not).
//
// Seeding goes through the gated testSeedMessages (server-side batches of ≤500 per Cloud call) instead of one
// HTTP request per message: at 10,000 messages that is ~23 HTTP calls, while the per-object writes remain
// ~11,000 BILLABLE operations in the request-budget inventory (amendment CC4 counts them separately).
//
//   npm run measure:history -- --local                     # dev server must be running
//   npm run measure:history -- --live --sizes 1000,10000
import { target, args, LOCAL } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import {
  WARMUPS_DEFAULT, RUNS_DEFAULT, POLITE_RPS, runPrefix, stats, fmtStats, csvFile,
  call, mkWorld, cleanupRun, environmentLine, tokenBucket,
} from './lib/measure.mjs';

const a = args();
if (!a.local && !a.live) { console.error('say which target: --local (dev server must be running) or --live'); process.exit(2); }
const env = target(a);
const api = makeClient(env, { retry: env.name !== 'local' }); // seeding may ride through throttles; the TIMED reads never retry (checked below)
const timedApi = makeClient(env, { retry: false });
const warmups = Number(a.warmups ?? WARMUPS_DEFAULT);
const runs = Number(a.runs ?? RUNS_DEFAULT);
const sizes = String(a.sizes ?? '1000,10000').split(',').map(Number);
const RUN = runPrefix();
const setupToken = env.SETUP_TOKEN || LOCAL.SETUP_TOKEN;
const bucket = tokenBucket(POLITE_RPS);

console.log(`M6 history pagination · ${environmentLine(env, `sizes=${sizes.join('/')} warmups=${warmups} runs=${runs} prefix=${RUN}`)}`);
const { mod, roomId } = await mkWorld(api, RUN, { label: 'history', members: 0 });
const csv = csvFile('history-m6', env, 'size,page,run,target,ms,httpStatus,rows');

let seeded = 0;
for (const size of sizes.sort((x, y) => x - y)) {
  while (seeded < size) {
    const batch = Math.min(500, size - seeded);
    await bucket.take();
    const r = await call(api, 'testSeedMessages', { roomId, authorId: mod.objectId, count: batch, bodyPrefix: `m6 seed`, runPrefix: RUN, setupToken });
    seeded += r.created;
    process.stdout.write(`\rseeded ${seeded}/${size}   `);
  }
  console.log(`\nsize ${seeded}: seeded through testSeedMessages (server-side batches; per-object writes counted as billable ops in the budget)`);

  // The deep cursor: walk to the oldest end once (not timed) and keep the cursor whose page came back as the
  // LAST one — timing a 50-row page at that cursor is the "scrolled all the way back" read.
  let cursor = null;
  let deepCursor = null;
  for (;;) {
    await bucket.take();
    const page = await call(api, 'getMessages', { roomId, limit: 200, ...(cursor ? { before: cursor } : {}) }, mod.token);
    if (!page.messages.length || !page.more) { deepCursor = cursor; break; }
    const last = page.messages[page.messages.length - 1];
    cursor = { at: last.createdAt, id: last.id };
  }
  // Time: first page, and the page at the oldest end (deep).
  for (const [label, params] of [
    ['first', { roomId, limit: 50 }],
    ['deep', deepCursor ? { roomId, limit: 50, before: deepCursor } : { roomId, limit: 50 }],
  ]) {
    const times = [];
    let errors = 0;
    for (let i = 0; i < warmups + runs; i++) {
      await bucket.take();
      const t0 = performance.now();
      const r = await timedApi.request('POST', '/functions/getMessages', { body: params, session: mod.token });
      const ms = performance.now() - t0;
      if (i < warmups) continue;
      if (r.status !== 200) { errors++; csv.row(`${size},${label},${i - warmups + 1},${env.name},,${r.status},`); continue; }
      times.push(ms);
      csv.row(`${size},${label},${i - warmups + 1},${env.name},${ms.toFixed(1)},${r.status},${r.json.result.messages.length}`);
    }
    console.log(`size ${size} · ${label} page (50 rows): ${fmtStats(stats(times))} errors=${errors}`);
  }
}
console.log(`→ ${csv.rel}`);
console.log('index stated for the article: message_room_createdAt (room, createdAt) backs the history pages; cursor = (createdAt, objectId) tuple.');
await cleanupRun(api, env, RUN);
