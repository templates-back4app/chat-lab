// File: test/helpers.mjs · shared by the node:test suites. Raw REST + raw LiveQuery frames — no SDK, no
// browser: every matrix row records exactly what crossed the network.
//
// Target: by default an in-process parse-server (scripts/dev-server.mjs) on a free port with the database
// postgres://localhost:5433/chat_test, purged at the start of every suite file. For the LIVE run (the
// coordinator does this, later — nothing in Phase A calls any remote backend):
//
//   TEST_SERVER_URL=https://parseapi.back4app.com LIVEQUERY_URL=wss://<subdomain>.b4a.io npm test
//
// which loads the keys from .env.live (APP_ID, JS_KEY, REST_KEY, SETUP_TOKEN — never the master key), uses
// the token-gated Cloud helpers instead of master-key REST (setupSchema for the schema, testInspect for every
// state read-back, testCleanup to delete what the run created), and SKIPS, with a printed reason, the parts
// that need direct master/database access (hook-vs-master-key probes, SQL timestamp surgery, session
// deletion). Every object a run creates carries the per-execution RUN prefix in its username/room name, so
// parallel or crashed runs never collide and cleanup can only ever sweep its own run.
//
// Every suite records matrix rows (persona, attempt, HTTP/Parse code or ws frames, body assertion, state
// assertion) into docs/evidence/.rows-<target>.jsonl; `npm test` regenerates
// docs/evidence/subscription-matrix-<target>-<date>.md from them afterwards (scripts/evidence.mjs).
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { LOCAL, ROOT, loadDotEnv } from '../scripts/lib/env.mjs';
import { makeClient, parseCloudError, where, sleep } from '../scripts/lib/rest.mjs';
import { applySchema } from '../scripts/setup.mjs';

export { where, sleep, parseCloudError, WebSocket };
/** Per-execution run prefix: every username and room name carries it (shape enforced by testCleanup). */
export const RUN = 'zz' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
export const unique = (prefix) => `${RUN}_${prefix}_${crypto.randomBytes(3).toString('hex')}`;
export const password = () => 'Pw-' + crypto.randomBytes(9).toString('base64url');
export const ptr = (className, objectId) => ({ __type: 'Pointer', className, objectId });

/** Evidence label: 'back4app' only for the real live host — a localhost TEST_SERVER_URL is a rehearsal. */
export const TARGET = !process.env.TEST_SERVER_URL ? 'local'
  : /back4app\.com/.test(process.env.TEST_SERVER_URL) ? 'back4app' : 'remote-rehearsal';
const ROWS_FILE = path.join(ROOT, 'docs', 'evidence', `.rows-${TARGET}.jsonl`);

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer(); s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Starts (or attaches to) the server, applies the schema, purges local data (local) / nothing (live). */
export async function harness({ suite } = {}) {
  let env; let handle = null; let isLocal = true;
  if (process.env.TEST_SERVER_URL) {
    isLocal = false;
    loadDotEnv(path.join(ROOT, '.env.live')); // live keys live here; never printed, never committed
    loadDotEnv();
    env = {
      name: TARGET,
      APP_ID: process.env.APP_ID, JS_KEY: process.env.JS_KEY || '', REST_KEY: process.env.REST_KEY || '',
      MASTER_KEY: process.env.MASTER_KEY || '', SETUP_TOKEN: process.env.SETUP_TOKEN || '',
      SERVER_URL: process.env.TEST_SERVER_URL.replace(/\/+$/, ''),
    };
    if (!env.APP_ID) throw new Error('TEST_SERVER_URL is set but APP_ID is missing — fill .env.live first.');
    if (!env.SETUP_TOKEN) throw new Error('live run needs SETUP_TOKEN in .env.live (the raw administrative token, amendment B5).');
  } else {
    loadDotEnv();
    const { startServer } = await import('../scripts/dev-server.mjs');
    const port = await freePort();
    handle = await startServer({ port, databaseURI: process.env.TEST_DATABASE_URL || 'postgres://localhost:5433/chat_test', quiet: true });
    env = { ...LOCAL, name: 'local-test', SERVER_URL: handle.url };
  }
  const api = makeClient(env, { retry: !isLocal }); // live: retry Back4app's 155 throttle with backoff
  const canMaster = !!env.MASTER_KEY;
  const setupToken = env.SETUP_TOKEN || LOCAL.SETUP_TOKEN;

  if (canMaster) {
    await applySchema(env);
  } else {
    // No master key: the schema goes through the gated Cloud function. allowRerun, because a live backend
    // that already ran the suite holds rooms and would trip setupSchema's rerun tripwire.
    const setup = await api.call('setupSchema', { allowRerun: true, setupToken });
    if (!setup.ok) {
      const why = setup.error.code === 'SETUP_DISABLED' ? 'SETUP_ENABLED is off on this backend'
        : setup.error.code === 'SETUP_TOKEN_UNSET' ? 'no SETUP_TOKEN_SHA256 configured on this backend'
        : setup.error.code === 'SETUP_TOKEN_INVALID' ? 'the SETUP_TOKEN in .env.live does not match the configured hash'
        : /Invalid function/.test(setup.error.message || '') ? 'Cloud Code is not deployed (upload main.js, config.js, guards.js and Deploy — verify with a request)'
        : `HTTP ${setup.status} ${JSON.stringify(setup.error)}`;
      throw new Error(`setupSchema failed: ${why}`);
    }
  }
  if (isLocal) {
    // Purge everything from previous runs so counts and state assertions are deterministic. Live runs never
    // purge: room scoping keeps foreign rows invisible, and testCleanup removes this run's rows.
    for (const cls of ['Message', 'RoomMembership', 'Room', '_Session', '_User', '_Role']) {
      await api.request('DELETE', `/purge/${cls}`, { master: true });
    }
  }

  const observations = [];
  const h = {
    env, api, isLocal, canMaster, setupToken, observations, suite: suite || 'suite',
    databaseURI: handle ? handle.databaseURI : null,

    /**
     * Skip helper for live runs: parts that need the master key or direct database access (hook-vs-master
     * probes, SQL timestamp surgery, session deletion) run locally and print a reason live. Usage:
     *   if (h.liveSkip(t, 'needs master-key writes — hook layer proven in the local run')) return;
     */
    liveSkip(t, reason) {
      if (canMaster) return false;
      t.skip(`live run: ${reason}`);
      return true;
    },

    observe(label, value) { observations.push({ label, value }); },

    /** One evidence-matrix row. `id` sorts the final table (T1, T1b, P2a, …). */
    record(row) {
      mkdirSync(path.dirname(ROWS_FILE), { recursive: true });
      appendFileSync(ROWS_FILE, JSON.stringify({ suite: h.suite, at: new Date().toISOString(), ...row }) + '\n');
    },

    // ---- raw REST --------------------------------------------------------------------------------------
    rest: (method, p, body, opts = {}) => api.request(method, p, { ...opts, body }),
    fn: (name, params, session) => api.request('POST', `/functions/${name}`, { body: params || {}, session }),
    /** Cloud call with the envelope unwrapped: {ok, status, result | error:{parseCode, code, message}} */
    call: (name, params, session) => api.call(name, params || {}, { session }),

    /**
     * Master-rights read-back for STATE assertions (equality-where only). Locally: REST with the master key.
     * Live: the token-gated Cloud function testInspect — the master key never leaves the dashboard.
     */
    async master(className, whereObj) {
      if (canMaster) {
        const r = await api.request('GET', `/classes/${className}?where=${where(whereObj)}`, { master: true });
        if (r.status !== 200) throw new Error(`master read ${className} failed: ${r.status} ${JSON.stringify(r.json)}`);
        return r.json.results;
      }
      const r = await api.call('testInspect', { className, where: whereObj, limit: 1000, setupToken });
      if (!r.ok) throw new Error(`testInspect ${className} failed: ${JSON.stringify(r.error)}`);
      return r.result.results;
    },

    /** Runs SQL against the local test database (below-the-API state surgery; local only). */
    async sql(statement) {
      if (!handle) throw new Error('sql() is local-only');
      const { runSql } = await import('../scripts/dev-server.mjs');
      return runSql(handle.databaseURI, statement);
    },

    // ---- personas --------------------------------------------------------------------------------------
    async signUp(prefix) {
      const username = unique(prefix);
      const email = `${username}@example.test`;
      const pw = password();
      const r = await api.request('POST', '/users', { body: { username, password: pw, email } });
      if (r.status !== 201) throw new Error(`signUp failed: ${r.status} ${JSON.stringify(r.json)}`);
      return { username, email, pw, objectId: r.json.objectId, token: r.json.sessionToken };
    },
    async login(username, pw) {
      const r = await api.request('POST', '/login', { body: { username, password: pw } });
      if (r.status !== 200) throw new Error(`login failed: ${r.status}`);
      return { objectId: r.json.objectId, token: r.json.sessionToken };
    },

    /** Sign up a fresh user and have `modToken` add them to `roomId`. Returns the user's handle. */
    async addMember(modToken, roomId, roleKind = 'member', prefix = 'member') {
      const u = await h.signUp(prefix);
      const r = await h.call('addMember', { roomId, userId: u.objectId, role: roleKind }, modToken);
      if (!r.ok) throw new Error(`addMember failed: ${JSON.stringify(r.error)}`);
      return u;
    },

    /**
     * Builds the two fictitious companies' rooms and the personas of the brief: ACME lounge (moderator, two
     * members, one removed member) and Borealis ops (moderator, member), a dual-room user in both, an
     * outsider in neither, plus three seed messages whose ids the matrix rows target.
     */
    async world() {
      const acmeMod = await h.signUp('acme_mod');
      const acme = (await mustCall(h, 'createRoom', { name: `ACME lounge ${RUN}` }, acmeMod.token)).roomId;
      const borealisMod = await h.signUp('borealis_mod');
      const borealis = (await mustCall(h, 'createRoom', { name: `Borealis ops ${RUN}` }, borealisMod.token)).roomId;

      const acmeMember = await h.addMember(acmeMod.token, acme, 'member', 'acme_member');
      const acmeMember2 = await h.addMember(acmeMod.token, acme, 'member', 'acme_member2');
      const borealisMember = await h.addMember(borealisMod.token, borealis, 'member', 'borealis_member');

      const dual = await h.signUp('dual');
      for (const [mod, rid] of [[acmeMod, acme], [borealisMod, borealis]]) {
        await mustCall(h, 'addMember', { roomId: rid, userId: dual.objectId }, mod.token);
      }

      const removed = await h.addMember(acmeMod.token, acme, 'member', 'removed');
      await mustCall(h, 'removeMember', { roomId: acme, userId: removed.objectId }, acmeMod.token);

      const outsider = await h.signUp('outsider');

      const acmeMsg1 = (await mustCall(h, 'sendMessage', { roomId: acme, body: 'Anvil shipment confirmed' }, acmeMember.token)).id;
      const acmeMsg2 = (await mustCall(h, 'sendMessage', { roomId: acme, body: 'Tunnel painting at 14:00' }, acmeMod.token)).id;
      const borealisMsg1 = (await mustCall(h, 'sendMessage', { roomId: borealis, body: 'Magnetometer calibrated' }, borealisMember.token)).id;

      return {
        acme, borealis, acmeMod, acmeMember, acmeMember2, borealisMod, borealisMember, dual, removed, outsider,
        acmeMsg1, acmeMsg2, borealisMsg1,
      };
    },

    // ---- LiveQuery -------------------------------------------------------------------------------------
    /**
     * Raw LiveQuery subscription over ws (no SDK). Returns { events, frames, waitFor(predicate, ms),
     * close() }. `events` collects every op:create/update/delete/enter/leave message; `frames` every parsed
     * frame (the matrix rows quote them). With {allowError:true} a refused handshake resolves to
     * { error: frame } instead of throwing — T1 records connect-time vs event-time rejection either way.
     * `roomId` builds the room-pointer filter; `whereObj` overrides it (e.g. {} = no filter at all, T3b).
     */
    async subscribe({ className = 'Message', roomId, whereObj, session, allowError = false } = {}) {
      // Back4app LiveQuery runs on its own host: enable Message under App Settings → Server Settings →
      // Live Query and pass LIVEQUERY_URL=wss://<subdomain>.b4a.io; locally the dev server speaks ws itself.
      const wsUrl = process.env.LIVEQUERY_URL || env.SERVER_URL.replace(/^http/, 'ws');
      const ws = new WebSocket(wsUrl);
      const events = [];
      const frames = [];
      const waiters = [];
      let onEvent = null;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        frames.push(msg);
        if (['create', 'update', 'delete', 'enter', 'leave'].includes(msg.op)) {
          events.push(msg);
          if (waiters.length) waiters.shift()(msg);
        } else if (onEvent) onEvent(msg);
      });
      const expect = (op) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for op:${op}`)), 8000);
        onEvent = (msg) => {
          if (msg.op === op) { clearTimeout(timer); resolve(msg); }
          else if (msg.op === 'error') {
            clearTimeout(timer);
            if (allowError) resolve(msg);
            else reject(new Error(`LiveQuery error: ${JSON.stringify(msg)}`));
          }
        };
      });
      await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
      ws.on('error', () => { /* a late socket error must fail a test, never crash the process */ });
      const connected = expect('connected');
      ws.send(JSON.stringify({ op: 'connect', applicationId: env.APP_ID, javascriptKey: env.JS_KEY, sessionToken: session }));
      const connectedMsg = await connected;
      if (connectedMsg.op === 'error') return { events, frames, error: connectedMsg, phase: 'connect', waitFor: async () => null, close: () => ws.close() };
      const resolvedWhere = whereObj !== undefined ? whereObj
        : roomId ? { room: { __type: 'Pointer', className: 'Room', objectId: roomId } } : {};
      const subscribed = expect('subscribed');
      ws.send(JSON.stringify({ op: 'subscribe', requestId: 1, query: { className, where: resolvedWhere }, sessionToken: session }));
      const subscribedMsg = await subscribed;
      let cursor = 0; // events already consumed by waitFor
      const sub = {
        events, frames,
        error: subscribedMsg.op === 'error' ? subscribedMsg : null,
        phase: subscribedMsg.op === 'error' ? 'subscribe' : 'subscribed',
        /**
         * Resolves with the next unconsumed event matching `predicate` (default: any), checking the backlog
         * first, or null after `ms` of silence. Deterministic against events that arrived before the call.
         */
        waitFor(predicate = () => true, ms = 1500) {
          return new Promise((resolve) => {
            const scan = () => {
              while (cursor < events.length) {
                const e = events[cursor++];
                if (predicate(e)) return e;
              }
              return null;
            };
            const hit = scan();
            if (hit) return resolve(hit);
            const timer = setTimeout(() => { const i = waiters.indexOf(fn); if (i !== -1) waiters.splice(i, 1); resolve(null); }, ms);
            const fn = () => { const found = scan(); if (found) { clearTimeout(timer); resolve(found); } else waiters.push(fn); };
            waiters.push(fn);
          });
        },
        close: () => new Promise((resolve) => { ws.on('close', resolve); ws.close(); }),
      };
      return sub;
    },

    /** True when a LiveQuery test can run against this target. */
    liveQueryAvailable: isLocal || !!process.env.LIVEQUERY_URL,

    async cleanup() {
      printObservations(`${h.suite} observations`, observations);
      if (!isLocal) {
        // Delete ONLY what this run created: rooms whose name carries RUN, users whose username starts with
        // RUN and are < 2 h old (plus their sessions). Gated by the setup flag + token like the other helpers.
        const r = await api.call('testCleanup', { runPrefix: RUN, setupToken });
        if (r.ok) console.log(`cleanup: testCleanup(${RUN}) removed ${JSON.stringify(r.result)}`);
        else console.log(`cleanup: testCleanup failed (${r.error.code}) — rows with prefix ${RUN} remain on the backend`);
      }
      if (handle) await handle.close();
    },
  };
  return h;
}

async function mustCall(h, name, params, session) {
  const r = await h.call(name, params, session);
  if (!r.ok) throw new Error(`${name} failed: HTTP ${r.status} ${JSON.stringify(r.error)}`);
  return r.result;
}
export { mustCall };

/** Prints the observations table so a test run doubles as evidence for the article. */
export function printObservations(title, observations) {
  if (!observations.length) return;
  console.log([`\n## ${title}`, ...observations.map((o) => `- ${o.label}: ${o.value}`)].join('\n'));
}
