// File: scripts/measure-reconnect.mjs · Node 22 ESM · M3 — the reconnect gap (H3), measured on the SHIPPED
// client (client/chat-client.mjs, the amendment-B2 algorithm): cut the socket for a controlled window while
// K messages are sent, then reconnect and record (a) how many of the K arrived as live events after the
// resubscribe (H3 expects 0 — events, not state), (b) how many the paginated catch-up recovered, (c) the
// duration of the recovery (subscription ack, catch-up query, pages), per run. Repeated for a CLEAN
// unsubscribe vs a TCP cut (the only factor varied between the two blocks).
//
//   npm run measure:reconnect -- --local                       # dev server must be running
//   npm run measure:reconnect -- --live --runs 10 --gap 5000   # LIVEQUERY_URL required
import WebSocket from 'ws';
import { target, args } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import {
  POLITE_RPS, runPrefix, stats, fmtStats, evidenceMd, liveQueryUrl,
  call, mkWorld, cleanupRun, environmentLine, sleep, tokenBucket,
} from './lib/measure.mjs';
import { createChatClient } from '../client/chat-client.mjs';

const a = args();
if (!a.local && !a.live) { console.error('say which target: --local (dev server must be running) or --live'); process.exit(2); }
const env = target(a);
const api = makeClient(env, { retry: false });
const runs = Number(a.runs ?? 10);
const gapMs = Number(a.gap ?? 5000);
const K = Number(a.k ?? 10);
const RUN = runPrefix();
const lqUrl = liveQueryUrl(env);
if (!lqUrl) { console.error('no LiveQuery URL: set LIVEQUERY_URL=wss://<subdomain>.b4a.io for live targets'); process.exit(2); }
const bucket = tokenBucket(POLITE_RPS);

console.log(`M3 reconnect gap · ${environmentLine(env, `runs=${runs} gap=${gapMs}ms K=${K} prefix=${RUN}`)}`);
const { mod, roomId, users } = await mkWorld(api, RUN, { label: 'reconnect', members: 1 });

const rows = [];
for (const mode of ['tcp-cut', 'clean-close']) {
  for (let run = 1; run <= runs; run++) {
    const client = createChatClient({
      serverUrl: env.SERVER_URL, appId: env.APP_ID, restKey: env.REST_KEY, jsKey: env.JS_KEY,
      sessionToken: users[0].token, roomId, lqUrl, WebSocketImpl: WebSocket,
    });
    await client.connect();
    await bucket.take();
    const warm = await call(api, 'sendMessage', { roomId, body: `m3 ${mode} ${run} warm` }, mod.token);
    await sleep(600);
    const warmDelivered = client.messages.has(warm.id);

    const eventsBefore = client.counters.eventsReceived;
    if (mode === 'tcp-cut') client.dropConnection(); else client.close();
    const tCut = performance.now();

    const sent = [];
    for (let i = 0; i < K; i++) {
      await bucket.take();
      sent.push(await call(api, 'sendMessage', { roomId, body: `m3 ${mode} ${run} missed ${i}` }, mod.token));
    }
    const remaining = gapMs - (performance.now() - tCut);
    if (remaining > 0) await sleep(remaining);
    const deliveredToDeadSocket = client.counters.eventsReceived - eventsBefore;

    const tReconnect = performance.now();
    const r = await client.connect();
    const totalRecoveryMs = performance.now() - tReconnect;
    const recovered = sent.filter((m) => client.messages.has(m.id)).length;
    rows.push({
      mode, run, warmDelivered,
      deliveredToDeadSocket, bufferedOnResubscribe: r.buffered, recovered, K,
      ackMs: r.ackMs, catchUpMs: r.catchUpMs, pages: r.catchUpPages, totalRecoveryMs,
      dup: client.counters.duplicatesIgnored,
    });
    console.log(`${mode} run ${run}/${runs}: dead-socket deliveries ${deliveredToDeadSocket} · buffered on resubscribe ${r.buffered} · recovered ${recovered}/${K} via catch-up (${r.catchUpPages} page(s), ${r.catchUpMs.toFixed(0)} ms; ack ${r.ackMs.toFixed(0)} ms; total ${totalRecoveryMs.toFixed(0)} ms) · dedup ignored ${client.counters.duplicatesIgnored}`);
    client.close();
  }
}

const md = evidenceMd('reconnect-m3', env);
const block = (mode) => {
  const rs = rows.filter((r) => r.mode === mode);
  const full = rs.filter((r) => r.recovered === r.K).length;
  return `### ${mode} (${rs.length} runs, ${gapMs} ms controlled gap, K=${K} messages sent while down)

| run | events on the dead socket | buffered on resubscribe | recovered via catch-up | subscription ack ms | catch-up ms (pages) | total recovery ms | dedup ignored |
|---|---|---|---|---|---|---|---|
${rs.map((r) => `| ${r.run} | ${r.deliveredToDeadSocket} | ${r.bufferedOnResubscribe} | ${r.recovered}/${r.K} | ${r.ackMs.toFixed(0)} | ${r.catchUpMs.toFixed(0)} (${r.pages}) | ${r.totalRecoveryMs.toFixed(0)} | ${r.dup} |`).join('\n')}

- full recovery (K/K): **${full}/${rs.length} runs** · catch-up duration: ${fmtStats(stats(rs.map((r) => r.catchUpMs)))} · total recovery: ${fmtStats(stats(rs.map((r) => r.totalRecoveryMs)))}
- live events replayed by the server for the gap: ${rs.every((r) => r.bufferedOnResubscribe === 0) ? '**zero in every run** — LiveQuery delivers events, not state (H3 supported in these runs); the catch-up query is mandatory and the shipped client runs it' : `NONZERO in ${rs.filter((r) => r.bufferedOnResubscribe > 0).length} run(s) — buffered events on resubscribe can also be messages sent during recovery; see the per-run numbers`}
`;
};
md.write(`# M3 — reconnect gap and recovery (H3) — ${env.name === 'back4app' ? 'BACK4APP' : 'LOCAL'} run

How we measured: the shipped client (client/chat-client.mjs: resubscribe → await ack → buffer → paginated
catch-up keyed on (updatedAt, objectId) → dedup by id → reconcile) against ${env.name}; one process, one
monotonic clock; the socket was ${gapMs} ms down while K=${K} messages were sent through sendMessage at the
polite ${POLITE_RPS} req/s. One factor varied: how the connection ended (TCP cut without a close frame vs
clean unsubscribe+close).

Environment: ${environmentLine(env)}

${block('tcp-cut')}
${block('clean-close')}
`);
console.log(`→ ${md.rel}`);
await cleanupRun(api, env, RUN);
