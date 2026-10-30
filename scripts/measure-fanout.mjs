// File: scripts/measure-fanout.mjs · Node 22 ESM · M2 — fan-out: M1 repeated with 1, 10 and 50 open
// subscribers on one room; subscriber count is the ONLY factor varied. Amendment B6: 50 subscribers from one
// machine is a TESTED CONFIGURATION, not a ceiling — alongside latency the script records LOSS (events that
// never arrived per subscriber), DUPLICATES (same id twice on one socket), DISCONNECTS, and the per-message
// fan-out spread (first → last receiver). All subscribers share this process's uplink and clock; the article
// says so next to the table.
//
//   npm run measure:fanout -- --local                       # dev server must be running
//   npm run measure:fanout -- --live --subscribers 1,10,50  # LIVEQUERY_URL required; stop at the plan's limit
//                                                           # and report the tested maximum if connections fail
import { target, args } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import {
  WARMUPS_DEFAULT, RUNS_DEFAULT, POLITE_RPS, runPrefix, stats, fmtStats, percentile, csvFile, liveQueryUrl,
  mkWorld, subscribeRaw, cleanupRun, environmentLine, tokenBucket,
} from './lib/measure.mjs';

const a = args();
if (!a.local && !a.live) { console.error('say which target: --local (dev server must be running) or --live'); process.exit(2); }
const env = target(a);
const api = makeClient(env, { retry: false });
const warmups = Number(a.warmups ?? WARMUPS_DEFAULT);
const runs = Number(a.runs ?? RUNS_DEFAULT);
const ladder = String(a.subscribers ?? '1,10,50').split(',').map(Number);
const RUN = runPrefix();
const lqUrl = liveQueryUrl(env);
if (!lqUrl) { console.error('no LiveQuery URL: set LIVEQUERY_URL=wss://<subdomain>.b4a.io for live targets'); process.exit(2); }
const bucket = tokenBucket(POLITE_RPS);

console.log(`M2 fan-out · ${environmentLine(env, `ladder=${ladder.join('/')} warmups=${warmups} runs=${runs} prefix=${RUN}`)}`);
const maxSubs = Math.max(...ladder);
const { mod, roomId, users } = await mkWorld(api, RUN, { label: 'fanout', members: maxSubs });
const csv = csvFile('fanout-m2', env,
  'config_subscribers,msg,target,sendStartToFirstMs,sendStartToP50Ms,sendStartToLastMs,received,lost,duplicatesSoFar,disconnectsSoFar');

for (const n of ladder) {
  // Open n subscriptions, each as a DISTINCT member (distinct sessions — the real fan-out shape).
  const subs = [];
  let connectFailure = null;
  for (let i = 0; i < n; i++) {
    try {
      subs.push(await subscribeRaw({ lqUrl, env, session: users[i].token, roomId }));
    } catch (e) {
      connectFailure = `subscriber ${i + 1}/${n}: ${e.message}`;
      break;
    }
  }
  if (connectFailure) {
    console.log(`M2 config ${n}: STOPPED opening connections — ${connectFailure}. Tested maximum is the previous config (plan limit, reported, never extrapolated).`);
    for (const s of subs) await s.close();
    break;
  }

  const spreads = []; const toFirst = []; const toLast = []; const perSubscriberAll = [];
  let lostTotal = 0;
  for (let i = 0; i < warmups + runs; i++) {
    await bucket.take();
    const tStart = performance.now();
    const r = await api.request('POST', '/functions/sendMessage', { body: { roomId, body: `m2 n${n} ${i}` }, session: mod.token });
    if (r.status !== 200) continue;
    const id = r.json.result.id;
    const arrivals = (await Promise.all(subs.map((s) => s.arrival(id, 10000)))).filter((x) => x !== null);
    if (i < warmups) continue;
    const lost = n - arrivals.length;
    lostTotal += lost;
    const latencies = arrivals.map((t) => t - tStart).sort((x, y) => x - y);
    perSubscriberAll.push(...latencies);
    if (latencies.length) {
      toFirst.push(latencies[0]);
      toLast.push(latencies[latencies.length - 1]);
      spreads.push(latencies[latencies.length - 1] - latencies[0]);
    }
    const dup = subs.reduce((x, s) => x + s.duplicates, 0);
    const disc = subs.reduce((x, s) => x + (s.closed ? 1 : 0), 0);
    csv.row(`${n},${i - warmups + 1},${env.name},${latencies.length ? latencies[0].toFixed(1) : ''},${latencies.length ? percentile(latencies, 50).toFixed(1) : ''},${latencies.length ? latencies[latencies.length - 1].toFixed(1) : ''},${arrivals.length},${lost},${dup},${disc}`);
  }
  const duplicates = subs.reduce((x, s) => x + s.duplicates, 0);
  const disconnects = subs.reduce((x, s) => x + (s.closed ? 1 : 0), 0);
  console.log(`M2 config ${n} subscriber(s) over ${runs} message(s):`);
  console.log(`  per-subscriber delivery (send-start → event, all arrivals): ${fmtStats(stats(perSubscriberAll))}`);
  console.log(`  to FIRST receiver: ${fmtStats(stats(toFirst))}`);
  console.log(`  to LAST receiver:  ${fmtStats(stats(toLast))} · fan-out spread (last−first): ${fmtStats(stats(spreads))}`);
  console.log(`  loss: ${lostTotal} of ${runs * n} expected deliveries · duplicates: ${duplicates} · disconnects: ${disconnects}`);
  for (const s of subs) await s.close();
}
console.log(`→ ${csv.rel}`);
await cleanupRun(api, env, RUN);
