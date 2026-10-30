// File: scripts/lib/measure.mjs · Node 22 ESM · shared by the measurement scripts (M0–M6, T8).
//
// House measurement rules, encoded once: latency = 20 warm-ups discarded + 100 timed runs, p50/p95 and error
// count; behaviour = one recorded outcome per cell; the CSV carries the label of the target it actually ran
// against ('back4app' only for the real live host). Clock protocol per amendment B1: sender and receiver run
// in THIS process on ONE monotonic clock (performance.now()); the headline interval STARTS when the send
// request is initiated, and the REST-ack→event interval is a secondary, SIGNED value (negative = the event
// beat the ack — a finding, not an error).
import crypto from 'node:crypto';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { ROOT, LOCAL } from './env.mjs';
import { parseCloudError, sleep, tokenBucket } from './rest.mjs';

export { sleep, tokenBucket };
export const WARMUPS_DEFAULT = 20;
export const RUNS_DEFAULT = 100;
export const POLITE_RPS = 16; // the polite client ceiling every script except M5 respects

export const runPrefix = () => 'zz' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

export function percentile(sortedXs, p) {
  if (!sortedXs.length) return NaN;
  const idx = Math.min(sortedXs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedXs.length) - 1));
  return sortedXs[idx];
}

export function stats(xs) {
  if (!xs.length) return { n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

export const fmtStats = (st, unit = 'ms') => st.n
  ? `n=${st.n} p50=${st.p50.toFixed(1)} p95=${st.p95.toFixed(1)} min=${st.min.toFixed(1)} max=${st.max.toFixed(1)} ${unit}`
  : 'n=0';

export function csvFile(name, env, header) {
  const date = new Date().toISOString().slice(0, 10);
  const label = env.name === 'back4app' ? 'back4app' : 'local';
  const file = path.join(ROOT, 'docs', 'evidence', `${name}-${label}-${date}.csv`);
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, header + '\n');
  }
  return { file, row: (line) => appendFileSync(file, line + '\n'), rel: path.relative(ROOT, file) };
}

export function evidenceMd(name, env) {
  const date = new Date().toISOString().slice(0, 10);
  const label = env.name === 'back4app' ? 'back4app' : 'local';
  const file = path.join(ROOT, 'docs', 'evidence', `${name}-${label}-${date}.md`);
  mkdirSync(path.dirname(file), { recursive: true });
  return { file, write: (text) => writeFileSync(file, text), rel: path.relative(ROOT, file) };
}

/** Throws unless the target is usable; returns the LiveQuery URL (ws) or null. */
export function liveQueryUrl(env) {
  if (process.env.LIVEQUERY_URL) return process.env.LIVEQUERY_URL;
  if (env.name === 'local' || env.name === 'local-test') return env.SERVER_URL.replace(/^http/, 'ws');
  return null;
}

export async function call(api, name, params, session) {
  const r = await api.request('POST', `/functions/${name}`, { body: params, session });
  if (r.status !== 200) throw new Error(`${name}: ${r.status} ${JSON.stringify(parseCloudError(r.json))}`);
  return r.json.result;
}

export async function signUp(api, prefix, RUN) {
  const username = `${RUN}_${prefix}_${crypto.randomBytes(3).toString('hex')}`;
  const r = await api.request('POST', '/users', { body: { username, password: 'Pw-' + crypto.randomBytes(9).toString('base64url'), email: `${username}@example.test` } });
  if (r.status !== 201) throw new Error(`signUp: ${r.status} ${JSON.stringify(r.json)}`);
  return { objectId: r.json.objectId, token: r.json.sessionToken, username };
}

/** One run-prefixed room with a moderator + N member users (through the real client path, no master key). */
export async function mkWorld(api, RUN, { label = 'measure', members = 1 } = {}) {
  const mod = await signUp(api, `${label}_mod`, RUN);
  const roomId = (await call(api, 'createRoom', { name: `${label} ${RUN}` }, mod.token)).roomId;
  const users = [];
  for (let i = 0; i < members; i++) {
    const u = await signUp(api, `${label}_m${i}`, RUN);
    await call(api, 'addMember', { roomId, userId: u.objectId }, mod.token);
    users.push(u);
  }
  return { mod, roomId, users };
}

/**
 * Minimal raw LiveQuery subscription for measurements: per-objectId arrival timestamps on THIS process's
 * monotonic clock, plus waiters, duplicate and disconnect counters. No SDK, no buffering logic — the shipped
 * client is measured separately (M3); this is the bare receiver of the clock protocol.
 */
export async function subscribeRaw({ lqUrl, env, session, roomId }) {
  const ws = new WebSocket(lqUrl);
  const arrivals = new Map(); // objectId → performance.now() of FIRST arrival
  const waiters = new Map();  // objectId → resolve
  let duplicates = 0;
  let events = 0;
  let closed = false;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (!['create', 'update', 'delete', 'enter', 'leave'].includes(msg.op)) return;
    events++;
    const id = msg.object && msg.object.objectId;
    const now = performance.now();
    if (!id) return;
    if (arrivals.has(id)) { duplicates++; return; }
    arrivals.set(id, now);
    const w = waiters.get(id);
    if (w) { waiters.delete(id); w(now); }
  });
  ws.on('close', () => { closed = true; });
  ws.on('error', () => { closed = true; });
  const once = (op) => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting op:${op}`)), 10000);
    ws.on('message', function fn(d) {
      const m = JSON.parse(d.toString());
      if (m.op === op) { clearTimeout(timer); ws.off('message', fn); res(m); }
      if (m.op === 'error') { clearTimeout(timer); ws.off('message', fn); rej(new Error(`LiveQuery error: ${JSON.stringify(m)}`)); }
    });
  });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const connected = once('connected');
  ws.send(JSON.stringify({ op: 'connect', applicationId: env.APP_ID, javascriptKey: env.JS_KEY, sessionToken: session }));
  await connected;
  const tSubscribeSent = performance.now();
  const subscribed = once('subscribed');
  ws.send(JSON.stringify({
    op: 'subscribe', requestId: 1,
    query: { className: 'Message', where: { room: { __type: 'Pointer', className: 'Room', objectId: roomId } } },
    sessionToken: session,
  }));
  await subscribed;
  const subscribeAckMs = performance.now() - tSubscribeSent;
  return {
    subscribeAckMs,
    arrivals,
    /** Resolves with the arrival timestamp of `objectId` (first delivery), or null after `ms`. */
    arrival(objectId, ms = 10000) {
      if (arrivals.has(objectId)) return Promise.resolve(arrivals.get(objectId));
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiters.delete(objectId); resolve(null); }, ms);
        waiters.set(objectId, (now) => { clearTimeout(timer); resolve(now); });
      });
    },
    get duplicates() { return duplicates; },
    get events() { return events; },
    get closed() { return closed; },
    close: () => new Promise((resolve) => { if (closed) return resolve(); ws.on('close', resolve); ws.close(); }),
  };
}

/** Deletes everything a measurement run created, through the gated helper (never the master key). */
export async function cleanupRun(api, env, RUN) {
  const setupToken = env.SETUP_TOKEN || LOCAL.SETUP_TOKEN;
  const r = await api.request('POST', '/functions/testCleanup', { body: { runPrefix: RUN, setupToken } });
  if (r.status === 200) console.log(`cleanup: removed ${JSON.stringify(r.json.result)}`);
  else console.log(`cleanup FAILED (${JSON.stringify(parseCloudError(r.json))}) — rows with prefix ${RUN} remain`);
}

/** The environment line every evidence file carries. */
export function environmentLine(env, extra = '') {
  return `target=${env.name} serverURL=${env.SERVER_URL} node=${process.version} date=${new Date().toISOString()} ${extra}`.trim();
}
