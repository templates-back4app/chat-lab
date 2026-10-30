// File: scripts/measure-throttle.mjs · Node 22 ESM · M5 — the throttle ceiling (H6): ramp the send rate past
// the polite 16 req/s until HTTP 400 / Parse code 155 appears; report messages/s at first throttle and what a
// client sees afterwards. THROWAWAY BACKEND ONLY on live targets (the throttle punishes the whole app), and
// hard-capped by --max-requests from the request-budget inventory (amendment CC4: M5's ramp gets an explicit
// request cap; the free plan's monthly quota bounds total runs). The local parse-server configures no
// throttle — a local run proves the mechanics and must end at the cap with zero 155s, which the output states
// instead of hiding.
//
//   npm run measure:throttle -- --local                              # mechanics only (dev server must run)
//   npm run measure:throttle -- --live --max-requests 3000           # throwaway backend only
import { target, args } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import {
  runPrefix, evidenceMd, mkWorld, cleanupRun, environmentLine, sleep, stats, fmtStats,
} from './lib/measure.mjs';

const a = args();
if (!a.local && !a.live) { console.error('say which target: --local (dev server must be running) or --live (THROWAWAY backend only)'); process.exit(2); }
const env = target(a);
const api = makeClient(env, { retry: false }); // the throttle IS the measurement; never retried away
const maxRequests = Number(a['max-requests'] ?? (env.name === 'back4app' ? 3000 : 1500));
const stepSeconds = Number(a['step-seconds'] ?? 10);
const ladder = String(a.rates ?? '16,24,32,48,64,96').split(',').map(Number);
const RUN = runPrefix();

console.log(`M5 throttle ceiling · ${environmentLine(env, `rates=${ladder.join('/')} stepSeconds=${stepSeconds} cap=${maxRequests} prefix=${RUN}`)}`);
if (env.name === 'back4app') console.log('REMINDER: run this against a THROWAWAY backend only — a 155 throttle punishes every caller of the app.');
const { mod, roomId } = await mkWorld(api, RUN, { label: 'throttle', members: 0 });

let total = 0;
let firstThrottle = null; // { rate, atRequest, status, code }
const steps = [];
outer:
for (const rate of ladder) {
  const interval = 1000 / rate;
  const t0 = performance.now();
  let sent = 0; let ok = 0; let throttled = 0; let otherErrors = 0;
  const latencies = [];
  let next = performance.now();
  while (performance.now() - t0 < stepSeconds * 1000) {
    if (total >= maxRequests) break;
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
    next += interval;
    const tReq = performance.now();
    const r = await api.request('POST', '/functions/sendMessage', { body: { roomId, body: `m5 r${rate} ${sent}` }, session: mod.token });
    latencies.push(performance.now() - tReq);
    sent++; total++;
    if (r.status === 200) ok++;
    else if (r.status === 400 && r.json && r.json.code === 155) {
      throttled++;
      if (!firstThrottle) firstThrottle = { rate, atRequest: total, status: r.status, code: 155, body: JSON.stringify(r.json).slice(0, 200) };
    } else otherErrors++;
  }
  const achieved = sent / ((performance.now() - t0) / 1000);
  steps.push({ rate, sent, ok, throttled, otherErrors, achieved, lat: stats(latencies) });
  console.log(`rate ${rate} req/s target → achieved ${achieved.toFixed(1)} req/s · sent ${sent} ok ${ok} throttled(155) ${throttled} other ${otherErrors} · latency ${fmtStats(stats(latencies))}`);
  if (firstThrottle) break outer;
  if (total >= maxRequests) break;
}

const md = evidenceMd('throttle-m5', env);
md.write(`# M5 — throttle ceiling (H6) — ${env.name === 'back4app' ? 'BACK4APP (throwaway backend)' : 'LOCAL'} run

How we measured: sendMessage through the single write path at a ramped target rate (${ladder.join(', ')} req/s,
${stepSeconds} s per step, one sender, hard cap ${maxRequests} requests from the request-budget inventory),
no retries — the first HTTP 400 with Parse code 155 ends the ramp. Latency per request on one monotonic clock.

Environment: ${environmentLine(env)}

| target req/s | achieved req/s | sent | ok | throttled (155) | other errors | latency p50 ms | latency p95 ms |
|---|---|---|---|---|---|---|---|
${steps.map((s) => `| ${s.rate} | ${s.achieved.toFixed(1)} | ${s.sent} | ${s.ok} | ${s.throttled} | ${s.otherErrors} | ${s.lat.n ? s.lat.p50.toFixed(1) : ''} | ${s.lat.n ? s.lat.p95.toFixed(1) : ''} |`).join('\n')}

Result: ${firstThrottle
    ? `first throttle at target rate **${firstThrottle.rate} req/s**, request #${firstThrottle.atRequest} of the ramp — HTTP ${firstThrottle.status}, Parse code ${firstThrottle.code} (not 429). Raw body: \`${firstThrottle.body}\``
    : `**no throttle observed** within the ${total}-request cap${env.name === 'back4app' ? '' : ' — expected: the local parse-server configures no platform throttle (this run proves the ramp mechanics only; the live number is the measurement)'}. The achieved-rate column shows where the single sequential sender became latency-bound instead.`}

Total requests spent: ${total} of the ${maxRequests} cap.
`);
console.log(`→ ${md.rel} · total requests ${total}/${maxRequests}${firstThrottle ? ` · FIRST THROTTLE at ${firstThrottle.rate} req/s` : ' · no throttle observed'}`);
await cleanupRun(api, env, RUN);
