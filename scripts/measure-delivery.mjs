// File: scripts/measure-delivery.mjs · Node 22 ESM · M0 (contemporaneous baseline) + M1 (headline delivery
// latency) + M4 (subscribe-to-first-event readiness).
//
// Clock protocol (amendments B1 + CC1): one process, one monotonic clock.
//   M0  the SAME-SESSION baseline: plain `sendMessage` REST round-trip, no subscriber open — every delivery
//       number is read against a same-day baseline from the same machine and plan, never a prior date's.
//   M1  headline = send request STARTED → event received on the other, already-open connection.
//       Secondary = REST-ack → event, SIGNED per message (negative = the event beat the ack: a finding).
//   M4  subscribe acknowledged → first event deliverable (send immediately after the ack; does it arrive?).
// 20 warm-ups discarded + 100 timed runs each (flags override); errors counted, never dropped silently.
//
//   npm run measure:delivery -- --local                 # mechanics + loopback numbers (dev server must run)
//   npm run measure:delivery -- --live --runs 100       # the live measurement (LIVEQUERY_URL=wss://… required)
//
// Everything it creates carries a fresh zz… run prefix and is deleted afterwards through the gated testCleanup.
import { target, args } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import {
  WARMUPS_DEFAULT, RUNS_DEFAULT, POLITE_RPS, runPrefix, stats, fmtStats, csvFile, liveQueryUrl,
  mkWorld, subscribeRaw, cleanupRun, environmentLine, tokenBucket,
} from './lib/measure.mjs';

const a = args();
if (!a.local && !a.live) { console.error('say which target: --local (dev server must be running) or --live'); process.exit(2); }
const env = target(a);
const api = makeClient(env, { retry: false }); // a throttled run must surface as an error count, not hide in retries
const warmups = Number(a.warmups ?? WARMUPS_DEFAULT);
const runs = Number(a.runs ?? RUNS_DEFAULT);
const m4runs = Number(a['m4-runs'] ?? runs);
const m4warmups = Number(a['m4-warmups'] ?? 5);
const RUN = runPrefix();
const lqUrl = liveQueryUrl(env);
if (!lqUrl) { console.error('no LiveQuery URL: set LIVEQUERY_URL=wss://<subdomain>.b4a.io for live targets'); process.exit(2); }
const bucket = tokenBucket(POLITE_RPS);

console.log(`M0+M1+M4 · ${environmentLine(env, `warmups=${warmups} runs=${runs} m4runs=${m4runs} politeRps=${POLITE_RPS} prefix=${RUN}`)}`);
const { mod, roomId, users } = await mkWorld(api, RUN, { label: 'delivery', members: 1 });
const sender = mod;      // sends over REST
const receiver = users[0]; // holds the open subscription

// ---------------------------------------------------------------------------------------------------------
// M0 — contemporaneous baseline (CC1): plain sendMessage round-trip, SAME session, NO subscriber open.
// ---------------------------------------------------------------------------------------------------------
const m0 = csvFile('baseline-m0', env, 'run,target,restRoundTripMs,httpStatus');
let m0errors = 0;
const m0times = [];
for (let i = 0; i < warmups + runs; i++) {
  await bucket.take();
  const t0 = performance.now();
  const r = await api.request('POST', '/functions/sendMessage', { body: { roomId, body: `m0 baseline ${i}` }, session: sender.token });
  const ms = performance.now() - t0;
  if (i < warmups) continue;
  if (r.status !== 200) { m0errors++; continue; }
  m0times.push(ms);
  m0.row(`${i - warmups + 1},${env.name},${ms.toFixed(1)},${r.status}`);
}
console.log(`M0 baseline (plain sendMessage REST round-trip, no subscriber): ${fmtStats(stats(m0times))} errors=${m0errors} → ${m0.rel}`);

// ---------------------------------------------------------------------------------------------------------
// M1 — headline delivery latency: send STARTED → event received on the open subscription.
// ---------------------------------------------------------------------------------------------------------
const sub = await subscribeRaw({ lqUrl, env, session: receiver.token, roomId });
const m1 = csvFile('delivery-m1', env, 'run,target,sendStartToEventMs,sendStartToAckMs,ackToEventSignedMs,httpStatus,arrived');
let m1errors = 0; let m1lost = 0;
const startToEvent = []; const startToAck = []; const ackToEvent = [];
for (let i = 0; i < warmups + runs; i++) {
  await bucket.take();
  const timed = i >= warmups;
  const tStart = performance.now(); // B1: the interval starts when the send request STARTS
  const r = await api.request('POST', '/functions/sendMessage', { body: { roomId, body: `m1 ${i}` }, session: sender.token });
  const tAck = performance.now();   // REST response received (body parsed)
  if (r.status !== 200 || !r.json.result) { if (timed) { m1errors++; m1.row(`${i - warmups + 1},${env.name},,,,${r.status},0`); } continue; }
  const tEvent = await sub.arrival(r.json.result.id, 10000);
  if (!timed) continue;
  if (tEvent === null) { m1lost++; m1.row(`${i - warmups + 1},${env.name},,${(tAck - tStart).toFixed(1)},,${r.status},0`); continue; }
  startToEvent.push(tEvent - tStart);
  startToAck.push(tAck - tStart);
  ackToEvent.push(tEvent - tAck); // SIGNED: negative = the event beat the ack (reported, not an error)
  m1.row(`${i - warmups + 1},${env.name},${(tEvent - tStart).toFixed(1)},${(tAck - tStart).toFixed(1)},${(tEvent - tAck).toFixed(1)},${r.status},1`);
}
const negatives = ackToEvent.filter((x) => x < 0).length;
console.log(`M1 headline (send-start → event): ${fmtStats(stats(startToEvent))} errors=${m1errors} lost=${m1lost} dup=${sub.duplicates}`);
console.log(`M1 secondary (send-start → REST ack): ${fmtStats(stats(startToAck))}`);
console.log(`M1 secondary SIGNED (ack → event): ${fmtStats(stats(ackToEvent))} — negative intervals (event beat the ack): ${negatives}${negatives ? ' ← FINDING' : ''}`);
console.log(`→ ${m1.rel}`);
await sub.close();

// ---------------------------------------------------------------------------------------------------------
// M4 — readiness: subscribe acknowledged → first event deliverable (send fired immediately after the ack).
// ---------------------------------------------------------------------------------------------------------
const m4 = csvFile('readiness-m4', env, 'run,target,subscribeAckMs,sendStartToEventMs,ackToEventMs,arrived');
let m4lost = 0;
const m4subAck = []; const m4toEvent = [];
for (let i = 0; i < m4warmups + m4runs; i++) {
  await bucket.take();
  const cycle = await subscribeRaw({ lqUrl, env, session: receiver.token, roomId });
  const tAck = performance.now(); // the subscription is acknowledged NOW; send immediately
  const tStart = performance.now();
  const r = await api.request('POST', '/functions/sendMessage', { body: { roomId, body: `m4 ${i}` }, session: sender.token });
  const timed = i >= m4warmups;
  if (r.status !== 200) { if (timed) m4.row(`${i - m4warmups + 1},${env.name},${cycle.subscribeAckMs.toFixed(1)},,,0`); await cycle.close(); continue; }
  const tEvent = await cycle.arrival(r.json.result.id, 10000);
  if (timed) {
    if (tEvent === null) { m4lost++; m4.row(`${i - m4warmups + 1},${env.name},${cycle.subscribeAckMs.toFixed(1)},,,0`); }
    else {
      m4subAck.push(cycle.subscribeAckMs);
      m4toEvent.push(tEvent - tStart);
      m4.row(`${i - m4warmups + 1},${env.name},${cycle.subscribeAckMs.toFixed(1)},${(tEvent - tStart).toFixed(1)},${(tEvent - tAck).toFixed(1)},1`);
    }
  }
  await cycle.close();
}
console.log(`M4 subscribe ack (subscribe sent → ack): ${fmtStats(stats(m4subAck))}`);
console.log(`M4 readiness (send right after ack → event): ${fmtStats(stats(m4toEvent))} — sends that never arrived: ${m4lost} of ${m4runs} (a lost first message = the "joining a room" race)`);
console.log(`→ ${m4.rel}`);

await cleanupRun(api, env, RUN);
