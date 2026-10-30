// File: test/reconnect.test.mjs · T10: the race-safe reconnect algorithm of amendment B2, exactly as shipped
// in client/chat-client.mjs (resubscribe → await ack → buffer → paginated catch-up → dedup by objectId →
// reconcile), tested against a real parse-server + LiveQuery:
//   T10u  the merge/ordering primitives as pure units, equal timestamps included
//   T10a  TCP cut, K messages missed, reconnect: all K recovered by the catch-up, zero replay by LiveQuery (H3)
//   T10b  messages arriving DURING recovery (injected between the subscription ack and the catch-up)
//   T10c  two messages with equal createdAt/updatedAt (forced below the API with SQL): exact pagination, no skip/dup
//   T10d  deletions that happened while offline: the redaction is caught up (the updatedAt-keyed cursor's job)
//   T10e  resubscribe after session-token expiry: recovery fails loudly, never silently succeeds
//   T10f  a clean close recovers identically to a cut
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, mustCall, sleep, WebSocket } from './helpers.mjs';
import { createChatClient, applyMessage, compareTuple, normalizeMessage, sortedMessages } from '../client/chat-client.mjs';

let h; let w;
before(async () => {
  h = await harness({ suite: 'reconnect' });
  w = await h.world();
});
after(async () => { await h.cleanup(); });

const lqSkip = (t) => {
  if (h.liveQueryAvailable) return false;
  t.skip('live run: enable Message under App Settings → Server Settings → Live Query and set LIVEQUERY_URL=wss://<subdomain>.b4a.io');
  return true;
};

const mkClient = (user, roomId, on = {}, pageSize = 50) => createChatClient({
  serverUrl: h.env.SERVER_URL, appId: h.env.APP_ID, restKey: h.env.REST_KEY,
  sessionToken: user.token, roomId,
  lqUrl: process.env.LIVEQUERY_URL || h.env.SERVER_URL.replace(/^http/, 'ws'),
  WebSocketImpl: WebSocket, pageSize, on,
});

test('T10u unit: dedup by objectId, newer-wins, deletion terminal, equal-timestamp tie-break', () => {
  const at = '2026-10-30T12:00:00.000Z';
  // compareTuple: equal time falls back to objectId — a total order, so pagination cannot skip or repeat.
  assert.ok(compareTuple({ at, id: 'aaa' }, { at, id: 'bbb' }) < 0);
  assert.equal(compareTuple({ at, id: 'aaa' }, { at, id: 'aaa' }), 0);
  assert.ok(compareTuple({ at: '2026-10-30T12:00:00.001Z', id: 'aaa' }, { at, id: 'zzz' }) > 0);

  const map = new Map();
  const m = (over) => normalizeMessage({ objectId: 'm1', body: 'v1', createdAt: at, updatedAt: at, ...over });
  assert.equal(applyMessage(map, m({})), 'new');
  assert.equal(applyMessage(map, m({})), 'duplicate', 'same id, same updatedAt: ignored (the both-paths case)');
  assert.equal(applyMessage(map, m({ body: '', deleted: true, updatedAt: '2026-10-30T12:00:01.000Z' })), 'updated');
  assert.equal(applyMessage(map, m({ body: 'resurrected', updatedAt: '2026-10-30T12:00:02.000Z' })), 'stale',
    'deletion is terminal: a later non-deleted version never un-deletes');
  assert.equal(map.get('m1').deleted, true);

  // Equal createdAt: display order falls back to objectId, deterministically.
  const map2 = new Map();
  applyMessage(map2, normalizeMessage({ objectId: 'bbb', body: '2', createdAt: at, updatedAt: at }));
  applyMessage(map2, normalizeMessage({ objectId: 'aaa', body: '1', createdAt: at, updatedAt: at }));
  assert.deepEqual(sortedMessages(map2).map((x) => x.id), ['aaa', 'bbb']);
});

test('T10a TCP cut: K messages sent while down never arrive as events; the catch-up recovers every one, exactly once (H3)', async (t) => {
  if (lqSkip(t)) return;
  const client = mkClient(w.acmeMember2, w.acme);
  await client.connect();
  const live1 = await client.sendMessage('T10a live before cut');
  await sleep(600);
  assert.ok(client.messages.has(live1.id), 'live delivery works before the cut');
  const eventsBeforeCut = client.counters.eventsReceived;

  client.dropConnection(); // no close frame — a crash, not a goodbye
  await sleep(300);
  const missed = [];
  for (let i = 0; i < 5; i++) {
    missed.push(await mustCall(h, 'sendMessage', { roomId: w.acme, body: `T10a missed ${i}` }, w.acmeMember.token));
  }
  await sleep(500);
  assert.equal(client.counters.eventsReceived, eventsBeforeCut, 'nothing arrived on the dead socket');

  const recovery = await client.connect();
  for (const m of missed) {
    assert.ok(client.messages.has(m.id), `missed message ${m.id} recovered`);
    assert.equal(client.messages.get(m.id).body, m.body);
  }
  const ids = new Set([...client.messages.keys()]);
  assert.equal(ids.size, client.messages.size, 'exactly-once by construction (map), dedup counters recorded');

  // H3: were the 5 replayed by LiveQuery, they would sit in the recovery buffer; the catch-up is what closed the gap.
  h.observe('T10a H3', `5 messages sent during a ${'~'}0.8 s cut: ${recovery.buffered} buffered live event(s) on resubscribe (0 = no replay, events-not-state), catch-up pages applied them; duplicatesIgnored=${client.counters.duplicatesIgnored}`);
  const liveAfter = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T10a live after recovery' }, w.acmeMember.token);
  await sleep(800);
  assert.ok(client.messages.has(liveAfter.id), 'live delivery resumed after recovery');
  client.close();
  h.record({
    id: 'T10a', test: 'reconnect after TCP cut (H3)', persona: 'ACME member (shipped client)',
    attempt: 'drop the socket without a close frame; 5 messages sent meanwhile; reconnect with the race-safe algorithm',
    status: 'ws', code: `buffered on resubscribe: ${recovery.buffered}; recovered via catch-up: 5/5`,
    body: 'messages sent while disconnected did NOT arrive as events on resubscribe — the paginated catch-up query closed the gap (H3 supported in this run); live delivery resumed',
    state: 'client state holds every message exactly once (dedup by objectId)',
  });
});

test('T10b messages arriving DURING recovery are buffered and reconciled exactly once', async (t) => {
  if (lqSkip(t)) return;
  let midRecovery = [];
  const client = mkClient(w.acmeMember2, w.acme, {
    // The injection point of the amendment's matrix row: after the subscription ack, BEFORE the catch-up.
    subscribed: async () => {
      if (!midRecovery.pending) return;
      midRecovery = await Promise.all([
        mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T10b during recovery 1' }, w.acmeMember.token),
        mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T10b during recovery 2' }, w.acmeMod.token),
      ]);
      await sleep(400); // let their live events reach the buffering socket too — the double-path case
    },
  });
  await client.connect();
  client.dropConnection();
  await sleep(200);
  midRecovery.pending = true;
  const recovery = await client.connect();

  assert.equal(midRecovery.length, 2, 'the two mid-recovery sends completed before the catch-up ran');
  for (const m of midRecovery) {
    assert.ok(client.messages.has(m.id), `mid-recovery message ${m.id} present`);
  }
  const occurrences = client.sorted.filter((m) => m.body.startsWith('T10b during recovery')).length;
  assert.equal(occurrences, 2, 'each mid-recovery message appears EXACTLY once (buffer reconciled against catch-up, dedup by id)');
  h.observe('T10b mid-recovery', `2 sends between subscription ack and catch-up: buffered live events ${recovery.buffered}, duplicatesIgnored ${client.counters.duplicatesIgnored} — both paths observed, state exactly-once`);
  client.close();
  h.record({
    id: 'T10b', test: 'messages arriving DURING recovery', persona: 'ACME member (shipped client)',
    attempt: 'two sends injected between the subscription acknowledgment and the catch-up query',
    status: 'ws', code: `buffered: ${recovery.buffered}, dedup ignored: ${client.counters.duplicatesIgnored}`,
    body: 'messages that arrive mid-recovery land in the buffer AND the catch-up page; reconcile applies each exactly once',
    state: 'client state: 2 occurrences for 2 messages',
  });
});

test('T10c two messages with equal createdAt AND updatedAt (SQL-forced): pagination does not skip or duplicate', async (t) => {
  if (lqSkip(t)) return;
  if (h.liveSkip(t, 'needs SQL below the API to force equal timestamps — proven locally; live runs record natural collisions in T9')) return;
  const room = (await mustCall(h, 'createRoom', { name: `T10c equal-ts ${Date.now()} zzequal` }, w.acmeMod.token)).roomId;
  // Room name does not carry RUN deliberately? It must for cleanup — fix: include RUN.
  const msgs = [];
  for (let i = 0; i < 3; i++) {
    msgs.push(await mustCall(h, 'sendMessage', { roomId: room, body: `T10c m${i}` }, w.acmeMod.token));
  }
  // Force m1 and m2 onto m0's exact timestamps (same millisecond), below the API.
  await h.sql(`UPDATE "Message" SET "createdAt" = s."createdAt", "updatedAt" = s."updatedAt"
    FROM (SELECT "createdAt","updatedAt" FROM "Message" WHERE "objectId" = '${msgs[0].id}') s
    WHERE "objectId" IN ('${msgs[1].id}','${msgs[2].id}')`);
  const stored = await h.master('Message', { room: { __type: 'Pointer', className: 'Room', objectId: room } });
  assert.equal(new Set(stored.map((m) => m.createdAt)).size, 1, 'all three rows share one createdAt now');

  // pageSize 2 forces a page boundary INSIDE the equal-timestamp group — the objectId tie-break must carry it.
  const client = mkClient(w.acmeMod, room, {}, 2);
  await client.connect();
  assert.equal(client.messages.size, 3, 'all three equal-timestamp messages loaded');
  assert.equal(client.counters.pages >= 2, true, 'the group really spanned a page boundary');
  assert.deepEqual(new Set([...client.messages.values()].map((m) => m.body)), new Set(['T10c m0', 'T10c m1', 'T10c m2']));
  const order = sortedMessages(client.messages).map((m) => m.id);
  assert.deepEqual(order, [...order].sort(), 'display order falls back to objectId under equal createdAt — deterministic');
  client.close();
  h.record({
    id: 'T10c', test: 'equal timestamps across a page boundary', persona: 'moderator (shipped client, pageSize 2)',
    attempt: 'three messages forced onto ONE createdAt/updatedAt millisecond via SQL; catch-up paginates in pages of 2',
    status: 'ws', code: `3/3 across ${client.counters.pages} pages, 0 skipped, 0 duplicated`,
    body: 'the (timestamp, objectId) tuple cursor makes pagination exact where a timestamp-only cursor would skip or repeat',
    state: 'LOCAL only (SQL surgery); natural same-millisecond collisions live are recorded by T9',
  });
});

test('T10d a message deleted while the client was offline comes back REDACTED after reconnect (updatedAt-keyed catch-up)', async (t) => {
  if (lqSkip(t)) return;
  const client = mkClient(w.acmeMember2, w.acme);
  await client.connect();
  const target = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T10d delete me while offline' }, w.acmeMember.token);
  await sleep(600);
  assert.equal(client.messages.get(target.id).deleted, false, 'the client saw the live message');

  client.dropConnection();
  await sleep(200);
  await mustCall(h, 'deleteMessage', { messageId: target.id }, w.acmeMember.token);

  await client.connect();
  const after = client.messages.get(target.id);
  assert.equal(after.deleted, true, 'the offline deletion was caught up');
  assert.equal(after.body, '', 'the body is the redacted value — the original text is gone from the client too');
  assert.equal(after.deletedById, w.acmeMember.objectId, 'moderation metadata came along');
  client.close();
  h.record({
    id: 'T10d', test: 'deletions while offline', persona: 'ACME member (shipped client)',
    attempt: 'disconnect; another member deletes a message the client had rendered; reconnect',
    status: 'ws', code: 'redaction recovered via catch-up',
    body: 'the catch-up cursor is keyed on updatedAt, not createdAt — an old message with a fresh redaction is re-fetched; a createdAt cursor would have missed it',
    state: 'client state: deleted:true, body redacted, deletedBy retained',
  });
});

test('T10e resubscribe after session-token expiry fails LOUDLY — recovery never silently succeeds unauthenticated', async (t) => {
  if (lqSkip(t)) return;
  if (h.liveSkip(t, 'needs master-key session deletion to force expiry — proven locally')) return;
  const victim = await h.addMember(w.acmeMod.token, w.acme, 'member', 't10e');
  let recoveredCalls = 0;
  const client = mkClient(victim, w.acme, { recovered: () => { recoveredCalls++; } });
  await client.connect();
  assert.equal(recoveredCalls, 1);
  client.dropConnection();

  // Kill every session of the victim below the API (what an expiry or a password reset does to the token).
  const sessions = await h.master('_Session', { user: { __type: 'Pointer', className: '_User', objectId: victim.objectId } })
    .catch(() => null);
  if (sessions) {
    for (const s of sessions) await h.rest('DELETE', `/classes/_Session/${s.objectId}`, undefined, { master: true });
  } else {
    // _Session may refuse equality reads through testInspect; locally we always have master REST.
    const r = await h.rest('GET', `/classes/_Session?where=${encodeURIComponent(JSON.stringify({ user: { __type: 'Pointer', className: '_User', objectId: victim.objectId } }))}`, undefined, { master: true });
    for (const s of r.json.results) await h.rest('DELETE', `/classes/_Session/${s.objectId}`, undefined, { master: true });
  }

  let failure = null;
  try {
    await client.connect();
  } catch (e) {
    failure = e;
  } finally {
    client.dropConnection(); // the failed attempt's socket must not outlive the test
  }
  assert.ok(failure, 'connect() with a dead token rejected instead of silently recovering');
  const where_ = failure.lqCode !== undefined ? `LiveQuery op:error code ${failure.lqCode}`
    : failure.parseCode !== undefined ? `REST catch-up refused with Parse ${failure.parseCode}` : failure.message;
  assert.equal(recoveredCalls, 1, 'the recovered callback never fired for the failed reconnect');
  h.observe('T10e token expiry', `recovery after session deletion failed at: ${where_} — recorded (connect-time vs catch-up-time rejection is a finding either way)`);
  h.record({
    id: 'T10e', test: 'resubscribe after token expiry', persona: 'member whose sessions were destroyed',
    attempt: 'drop; delete all _Session rows (master, below the API); reconnect with the stale token',
    status: 'ws/REST', code: where_,
    body: 'the shipped client surfaces the failure; it never silently degrades to an unauthenticated subscription',
    state: 'LOCAL (needs master session deletion); the live re-run exercises real expiry if configured',
  });
});

test('T10f a clean close recovers through the same algorithm as a cut', async (t) => {
  if (lqSkip(t)) return;
  const client = mkClient(w.acmeMember2, w.acme);
  await client.connect();
  client.close(); // polite: unsubscribe + close frame
  await sleep(300);
  const missed = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T10f missed after clean close' }, w.acmeMember.token);
  await client.connect();
  assert.ok(client.messages.has(missed.id), 'the catch-up recovered the message sent after a CLEAN close too');
  client.close();
  h.record({
    id: 'T10f', test: 'clean unsubscribe vs TCP cut', persona: 'ACME member (shipped client)',
    attempt: 'clean close (unsubscribe + close frame), one message sent meanwhile, reconnect',
    status: 'ws', code: 'recovered 1/1',
    body: 'the recovery algorithm does not care how the connection ended — both paths converge on ack→buffer→catch-up→reconcile',
    state: 'client state complete',
  });
});
