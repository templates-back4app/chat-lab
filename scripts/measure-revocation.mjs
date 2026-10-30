// File: scripts/measure-revocation.mjs · Node 22 ESM · T8, amendment B4: revocation RE-MEASURED in THIS room
// model (never inherited from tenant-lab's 2026-10-29 numbers, which become context only). The accepted
// behaviour is defined BEFORE measuring: fresh requests are refused once `removeMember` returns; the
// open-subscription drain is a measured DELAY, never implied instant; previously received content is
// unrecoverable by definition — the window below measures NEW delivery only. Per run: (a) the time from
// `removeMember` RETURNING to the first REFUSED fresh REST read by the removed member (polled back-to-back),
// and (b) on an open LiveQuery subscription, when the last event was delivered and when delivery had
// verifiably stopped. 10 runs by default, min/median/max printed, one CSV row per run — SAME CSV format as
// tenant-lab's revocation-h2 file, so the article can place the two measurements side by side.
//
//   npm run measure:revocation -- --local              # mechanics proof against the local dev server
//   npm run measure:revocation -- --live --runs 10     # the live measurement (LIVEQUERY_URL=wss://… for the drain columns)
//
// Everything it creates carries a fresh zz… run prefix and is deleted afterwards through the gated testCleanup.
import { target, args } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import {
  runPrefix, csvFile, liveQueryUrl, call, signUp, subscribeRaw, cleanupRun, environmentLine, sleep,
} from './lib/measure.mjs';

const a = args();
if (!a.local && !a.live) { console.error('say which target: --local (dev server must be running) or --live'); process.exit(2); }
const env = target(a);
const api = makeClient(env, { retry: env.name !== 'local' });
const runs = Number(a.runs ?? 10);
const RUN = runPrefix();
const lqUrl = liveQueryUrl(env);

const csv = csvFile('revocation-t8', env, 'run,target,removeCallMs,firstRefusedReadMs,readsBeforeRefusal,lqLastEventMs,lqSilentConfirmedMs');
console.log(`T8 revocation delay (room model) · ${environmentLine(env, `runs=${runs} LiveQuery=${lqUrl ? 'on' : 'OFF (set LIVEQUERY_URL for the drain columns)'} prefix=${RUN}`)}`);

const firstRefused = []; const lqLast = [];
for (let run = 1; run <= runs; run++) {
  // Fresh room per run: every event the victim's subscription receives belongs to this run by construction.
  const mod = await signUp(api, 't8mod', RUN);
  const roomId = (await call(api, 'createRoom', { name: `t8 ${RUN} run ${run}` }, mod.token)).roomId;
  await call(api, 'sendMessage', { roomId, body: 'warm' }, mod.token);
  const victim = await signUp(api, 't8victim', RUN);
  await call(api, 'addMember', { roomId, userId: victim.objectId }, mod.token);
  const sanity = await api.request('GET', '/classes/Message', { session: victim.token });
  if ((sanity.json.results || []).length < 1) throw new Error('sanity: the member cannot read before removal');

  let sub = null;
  if (lqUrl) {
    sub = await subscribeRaw({ lqUrl, env, session: victim.token, roomId });
    const w = await call(api, 'sendMessage', { roomId, body: 'lq warm' }, mod.token);
    const arrived = await sub.arrival(w.id, 5000);
    if (!arrived) console.log(`run ${run}: warning — the warm LiveQuery event never arrived; drain columns for this run are unreliable`);
  }

  const tCall = performance.now();
  await call(api, 'removeMember', { roomId, userId: victim.objectId }, mod.token);
  const t0 = performance.now();
  const removeCallMs = t0 - tCall;

  // (a) fresh reads, back-to-back, until the first refused one (0 rows readable).
  let readsBeforeRefusal = 0;
  let firstRefusedReadMs = null;
  for (;;) {
    const r = await api.request('GET', '/classes/Message', { session: victim.token });
    const rows = (r.json && r.json.results) || [];
    if (r.status === 200 && rows.length === 0) { firstRefusedReadMs = performance.now() - t0; break; }
    readsBeforeRefusal++;
    if (performance.now() - t0 > 30000) { firstRefusedReadMs = -1; break; } // never refused within 30 s: record -1
  }

  // (b) LiveQuery drain: probe with sends until 3 s of confirmed silence (or 20 s cap). subscribeRaw stamps
  // the FIRST arrival per id, so the newest arrival time is the max over the probe ids.
  let lqLastEventMs = ''; let lqSilentConfirmedMs = '';
  if (sub) {
    const probeIds = [];
    let lastArrival = null;
    while (performance.now() - t0 < 20000) {
      const p = await call(api, 'sendMessage', { roomId, body: `probe ${Math.round(performance.now() - t0)}` }, mod.token);
      probeIds.push(p.id);
      await sleep(500);
      lastArrival = probeIds.reduce((acc, id) => {
        const t = sub.arrivals.get(id);
        return t !== undefined && (acc === null || t > acc) ? t : acc;
      }, null);
      if (lastArrival && performance.now() - lastArrival > 3000) break;
      if (!lastArrival && performance.now() - t0 > 8000) break; // nothing delivered after removal at all
    }
    lqLastEventMs = lastArrival ? Math.round(lastArrival - t0) : 'none';
    lqSilentConfirmedMs = Math.round(performance.now() - t0);
    await sub.close();
  }

  csv.row(`${run},${env.name},${removeCallMs.toFixed(0)},${firstRefusedReadMs === null ? '' : firstRefusedReadMs.toFixed(0)},${readsBeforeRefusal},${lqLastEventMs},${lqSilentConfirmedMs}`);
  console.log(`run ${run}/${runs}: removeMember ${removeCallMs.toFixed(0)} ms · first refused read +${firstRefusedReadMs?.toFixed(0)} ms (${readsBeforeRefusal} read(s) still served) · LQ last event ${lqLastEventMs || 'n/a'} ms, silence confirmed ${lqSilentConfirmedMs || 'n/a'} ms`);
  if (typeof firstRefusedReadMs === 'number' && firstRefusedReadMs >= 0) firstRefused.push(firstRefusedReadMs);
  if (typeof lqLastEventMs === 'number') lqLast.push(lqLastEventMs);
}

const summary = (xs) => {
  if (!xs.length) return 'n/a';
  const s = [...xs].sort((x, y) => x - y);
  return `min ${s[0].toFixed(0)} / median ${s[Math.floor(s.length / 2)].toFixed(0)} / max ${s[s.length - 1].toFixed(0)} ms`;
};
console.log(`\nfirst refused fresh read after removeMember returned: ${summary(firstRefused)} over ${firstRefused.length} run(s)`);
console.log(`LiveQuery last delivered event after removal: ${summary(lqLast)} over ${lqLast.length} run(s)`);
console.log(`→ ${csv.rel}`);
await cleanupRun(api, env, RUN);
