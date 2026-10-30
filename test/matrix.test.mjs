// File: test/matrix.test.mjs · the "who can listen / who can write" negative matrix, T1–T6 + the
// administrative-gate rows (G-series, amendment B5) + the default-deploy half of T11. Raw REST and raw
// LiveQuery frames; every row records HTTP status, Parse code, body AND state (and frames for subscription
// rows). T3 is the load-bearing H1 row: whether LiveQuery filters events per subscriber by ACL is TESTED,
// never assumed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, mustCall, ptr, where } from './helpers.mjs';
import { HOSTILE_BODY } from './fixtures.mjs';

let h; let w;
before(async () => {
  h = await harness({ suite: 'matrix' });
  w = await h.world();
});
after(async () => { await h.cleanup(); });

test('T1 anonymous: REST reads refused by the CLP; LiveQuery without a session delivers nothing (rejection point recorded)', async (t) => {
  // REST: no session at all — only App ID + REST key, what any visitor of a bundled web app holds.
  const findMsg = await h.rest('GET', '/classes/Message');
  const findRoom = await h.rest('GET', '/classes/Room');
  const getMsg = await h.rest('GET', `/classes/Message/${w.acmeMsg1}`);
  for (const r of [findMsg, findRoom, getMsg]) {
    assert.ok(r.status === 400 || r.status === 404 || (r.status === 200 && (r.json.results || []).length === 0 && r.json.results),
      `anonymous read refused or empty (got ${r.status} ${JSON.stringify(r.json).slice(0, 80)})`);
    assert.ok(!JSON.stringify(r.json).includes('Anvil shipment'), 'no message body leaks');
  }
  // Functions: 209 by the guard, which doubles as the deploy probe (209 ≠ 141).
  const fn = await h.call('sendMessage', { roomId: w.acme, body: 'anon' });
  assert.equal(fn.error.parseCode, 209);
  assert.equal(fn.error.code, 'UNAUTHENTICATED');

  let lqNote = 'LiveQuery unavailable on this target';
  if (h.liveQueryAvailable) {
    const sub = await h.subscribe({ roomId: w.acme, session: undefined, allowError: true });
    if (sub.error) {
      lqNote = `rejected at ${sub.phase} time: ${JSON.stringify(sub.error)}`;
      await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T1 sentinel' }, w.acmeMember.token);
    } else {
      // Subscribed without a session: the rejection, if any, must be at event time — zero deliveries.
      const control = await h.subscribe({ roomId: w.acme, session: w.acmeMember.token });
      const sentinel = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T1 sentinel' }, w.acmeMember.token);
      const got = await control.waitFor((e) => e.object.objectId === sentinel.id, 5000);
      assert.ok(got, 'control: the member subscription received the sentinel');
      assert.equal(sub.events.length, 0, 'the anonymous subscription received zero events');
      lqNote = `subscribe acknowledged but zero events delivered (event-time rejection); frames: ${sub.frames.map((f) => f.op).join(',')}`;
      await control.close();
    }
    await sub.close();
  }
  h.observe('T1 anonymous LiveQuery', lqNote);
  h.record({
    id: 'T1', test: 'anonymous access', persona: 'anonymous (no session)',
    attempt: 'REST find/get on Room+Message; sendMessage; LiveQuery connect+subscribe without a session while a member chats',
    status: `${findMsg.status}/${getMsg.status}`, code: `REST ${findMsg.json && findMsg.json.code} · fn 209 · LQ: ${lqNote.slice(0, 80)}`,
    body: 'no row data, no message body in any response',
    state: 'n/a (reads only)',
  });
});

test('T2 non-member: REST find/get/where/count probes come back empty or 101 — counts scoped, ids no oracle', async () => {
  const token = w.outsider.token;
  const find = await h.rest('GET', '/classes/Message', undefined, { session: token });
  assert.equal(find.status, 200);
  assert.deepEqual(find.json.results, [], 'unfiltered find: zero foreign rows');

  const get = await h.rest('GET', `/classes/Message/${w.acmeMsg1}`, undefined, { session: token });
  assert.equal(get.json.code, 101, 'get by id answers 101, indistinguishable from nonexistent');

  const probe = await h.rest('GET', `/classes/Message?where=${where({ body: 'Anvil shipment confirmed' })}`, undefined, { session: token });
  assert.deepEqual(probe.json.results, [], 'where probe on a known body: zero rows');

  const count = await h.rest('GET', `/classes/Message?count=1&limit=0&where=${where({ room: ptr('Room', w.acme) })}`, undefined, { session: token });
  assert.equal(count.json.count, 0, 'count probe scoped to zero');

  const rooms = await h.rest('GET', '/classes/Room', undefined, { session: token });
  assert.deepEqual(rooms.json.results, [], 'room list: empty for a non-member');

  const fn = await h.call('getMessages', { roomId: w.acme }, token);
  assert.equal(fn.error.code, 'NOT_A_MEMBER');
  assert.equal(fn.error.parseCode, 119);

  h.record({
    id: 'T2', test: 'non-member read probes', persona: 'outsider (valid session, no rooms)',
    attempt: 'unfiltered find; get by known id; where probe on a known body; scoped count; getMessages',
    status: '200/404', code: '0 rows · 101 · count 0 · NOT_A_MEMBER 119',
    body: 'no ACME or Borealis data in any response',
    state: 'n/a (reads only)',
  });
});

test('T3 (H1, load-bearing) non-member subscription — with the room filter AND with no filter at all — receives zero events while members chat', async (t) => {
  if (!h.liveQueryAvailable) { t.skip('live run: enable Message under App Settings → Server Settings → Live Query and set LIVEQUERY_URL=wss://<subdomain>.b4a.io'); return; }
  const subFiltered = await h.subscribe({ roomId: w.acme, session: w.outsider.token });
  const subUnfiltered = await h.subscribe({ whereObj: {}, session: w.outsider.token });
  const control = await h.subscribe({ whereObj: {}, session: w.acmeMember.token });

  // Members chat in both rooms first, then the control sentinel: when the sentinel has arrived on the member
  // subscription and the outsider got nothing, the events were FILTERED, not merely slow.
  await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T3 acme chatter' }, w.acmeMod.token);
  await mustCall(h, 'sendMessage', { roomId: w.borealis, body: 'T3 borealis chatter' }, w.borealisMember.token);
  const sentinel = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T3 sentinel' }, w.acmeMember.token);

  const got = await control.waitFor((e) => e.op === 'create' && e.object.objectId === sentinel.id, 5000);
  assert.ok(got, 'control: the ACME member\'s unfiltered subscription received the sentinel');
  assert.ok(control.events.some((e) => (e.object.body || '').startsWith('T3 acme')), 'control also saw the chatter');
  assert.ok(!control.events.some((e) => (e.object.body || '').startsWith('T3 borealis')),
    'the member\'s unfiltered subscription is itself scoped to their own rooms');

  assert.deepEqual(subFiltered.events, [], 'H1: the outsider\'s room-filtered subscription received ZERO events');
  assert.deepEqual(subUnfiltered.events, [], 'H1: the outsider\'s UNFILTERED subscription received ZERO events');

  h.observe('T3 outcome', `H1 SUPPORTED on this target: outsider got 0 events (filtered + unfiltered) while 3 messages flowed; control frames: ${control.events.map((e) => e.op + ':' + (e.object.body || '').slice(0, 20)).join(' | ')}`);
  await subFiltered.close(); await subUnfiltered.close(); await control.close();
  h.record({
    id: 'T3', test: 'LiveQuery honours ACLs (H1)', persona: 'outsider (open subscriptions, filtered and unfiltered)',
    attempt: 'subscribe to Message with where:{room} and where:{}; members send 3 messages across 2 rooms',
    status: 'ws', code: 'subscribed acks, 0 events',
    body: 'zero events on both outsider subscriptions; member control received all ACME events incl. the sentinel',
    state: 'H1 supported in this run — the server filters events per subscriber by ACL',
  });
});

test('T4 member: direct REST writes on Message are refused by the CLP (proves that layer only)', async () => {
  const token = w.acmeMember.token;
  const post = await h.rest('POST', '/classes/Message', { room: ptr('Room', w.acme), author: ptr('_User', w.acmeMember.objectId), body: 'bypass', deleted: false }, { session: token });
  assert.ok(post.status === 400 || post.status === 403, `create refused (${post.status})`);
  const put = await h.rest('PUT', `/classes/Message/${w.acmeMsg1}`, { body: 'edited!' }, { session: token });
  assert.ok(put.status >= 400, `update refused (${put.status})`);
  const del = await h.rest('DELETE', `/classes/Message/${w.acmeMsg1}`, undefined, { session: token });
  assert.ok(del.status >= 400, `delete refused (${del.status})`);
  assert.equal((await h.master('Message', { objectId: w.acmeMsg1 }))[0].body, 'Anvil shipment confirmed', 'row untouched');
  h.record({
    id: 'T4', test: 'direct writes closed', persona: 'ACME member (valid session)',
    attempt: 'raw REST POST/PUT/DELETE on Message, bypassing sendMessage',
    status: `${post.status}/${put.status}/${del.status}`, code: `${post.json && post.json.code}/${put.json && put.json.code}/${del.json && del.json.code}`,
    body: 'all three refused by the class-level permissions (this row proves the CLP layer only)',
    state: 'message body unchanged in the database',
  });
});

test('T5 through sendMessage: foreign room, spoofed author, forged ACL, body over the cap — all rejected or ignored, DB asserted', async () => {
  const token = w.outsider.token;

  const foreign = await h.call('sendMessage', { roomId: w.acme, body: 'outsider post' }, token);
  assert.equal(foreign.error.code, 'NOT_A_MEMBER');
  assert.equal(foreign.error.parseCode, 119);

  // Spoofed author + forged ACL: extra params are simply not part of the contract — the author is always the
  // caller and the ACL is recomputed by the hook. Asserted on the stored row.
  const spoof = await mustCall(h, 'sendMessage', {
    roomId: w.acme, body: 'T5 spoof attempt',
    author: ptr('_User', w.borealisMember.objectId), authorId: w.borealisMember.objectId,
    ACL: { '*': { read: true, write: true } },
  }, w.acmeMember.token);
  const row = (await h.master('Message', { objectId: spoof.id }))[0];
  assert.equal(row.author.objectId, w.acmeMember.objectId, 'author is the caller, not the spoofed pointer');
  assert.deepEqual(row.ACL, { [`role:room_${w.acme}_member`]: { read: true } }, 'forged public ACL overwritten server-side');

  const oversize = await h.call('sendMessage', { roomId: w.acme, body: 'x'.repeat(2001) }, w.acmeMember.token);
  assert.equal(oversize.error.code, 'BODY_LENGTH');
  const empty = await h.call('sendMessage', { roomId: w.acme, body: '' }, w.acmeMember.token);
  assert.equal(empty.error.code, 'BODY_LENGTH');
  const notString = await h.call('sendMessage', { roomId: w.acme, body: { $gt: '' } }, w.acmeMember.token);
  assert.equal(notString.error.code, 'INVALID_ARGS');

  // The hostile body is DATA: stored verbatim, returned verbatim (rendering is the client's job — B3; the
  // shipped renderer is asserted in render.test.mjs).
  const hostile = await mustCall(h, 'sendMessage', { roomId: w.acme, body: HOSTILE_BODY }, w.acmeMember.token);
  assert.equal((await h.master('Message', { objectId: hostile.id }))[0].body, HOSTILE_BODY, 'stored verbatim, never interpreted');

  h.record({
    id: 'T5', test: 'forged inputs through the write path', persona: 'outsider + ACME member',
    attempt: 'sendMessage with: foreign room / spoofed author pointer / forged public ACL / 2001-char body / empty body / object body / hostile markup body',
    status: '400/200', code: 'NOT_A_MEMBER 119 · spoof+ACL ignored · BODY_LENGTH ×2 · INVALID_ARGS',
    body: 'refusals carry the envelope; accepted rows echo the caller as author',
    state: 'stored author = caller; stored ACL = member-role read only; hostile body stored verbatim as data',
  });
});

test('T5m (local) the hooks hold even under the MASTER key: non-member author, edits, room moves all refused', async (t) => {
  if (h.liveSkip(t, 'needs master-key writes — the hook layer is proven in the local run')) return;
  // A future Cloud function that forgets its membership check writes with the master key — the hook refuses.
  const post = await h.rest('POST', '/classes/Message',
    { room: ptr('Room', w.acme), author: ptr('_User', w.outsider.objectId), body: 'master bypass', deleted: false }, { master: true });
  assert.equal(post.status, 400);
  assert.match(post.json.error, /AUTHOR_NOT_MEMBER/, 'hook: author must be an active member at write time');

  const edit = await h.rest('PUT', `/classes/Message/${w.acmeMsg1}`, { body: 'rewritten history' }, { master: true });
  assert.match(edit.json.error, /MESSAGE_IMMUTABLE/, 'hook: no edit feature, even for the master key');

  const move = await h.rest('PUT', `/classes/Message/${w.acmeMsg1}`, { room: ptr('Room', w.borealis) }, { master: true });
  assert.match(move.json.error, /(ROOM_IMMUTABLE|MESSAGE_IMMUTABLE)/, 'hook: room is immutable after create');

  assert.equal((await h.master('Message', { objectId: w.acmeMsg1 }))[0].body, 'Anvil shipment confirmed');
  h.record({
    id: 'T5m', test: 'hooks as second guard (master-key probes)', persona: 'master key (simulating a buggy Cloud function)',
    attempt: 'direct master-key create with non-member author; master-key body edit; master-key room move',
    status: 400, code: 'AUTHOR_NOT_MEMBER / MESSAGE_IMMUTABLE / room immutable',
    body: 'every write refused by beforeSave even with full credentials',
    state: 'message unchanged. LOCAL evidence; live runs skip (master key stays in the dashboard)',
  });
});

test('T6 deletion policy + soft-delete semantics: redaction visible on direct reads AND on the LiveQuery event (B3)', async (t) => {
  // Policy half.
  const target = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T6 target message' }, w.acmeMember.token);
  const peer = await h.call('deleteMessage', { messageId: target.id }, w.acmeMember2.token);
  assert.equal(peer.error.code, 'NOT_ALLOWED', 'a member cannot delete another member\'s message');
  const foreign = await h.call('deleteMessage', { messageId: target.id }, w.outsider.token);
  assert.equal(foreign.error.parseCode, 101, 'non-member: 101, no existence oracle');
  const anon = await h.call('deleteMessage', { messageId: target.id });
  assert.equal(anon.error.parseCode, 209);

  // Soft-delete half, with an open subscription watching (amendment B3: record what LiveQuery emits).
  const sub = h.liveQueryAvailable ? await h.subscribe({ roomId: w.acme, session: w.acmeMember2.token }) : null;
  const redacted = await mustCall(h, 'deleteMessage', { messageId: target.id }, w.acmeMember.token);
  assert.equal(redacted.deleted, true);
  assert.equal(redacted.body, '', 'author delete: response body redacted');

  // Direct REST read by another member: body asserted GONE from accessible storage.
  const read = await h.rest('GET', `/classes/Message/${target.id}`, undefined, { session: w.acmeMember2.token });
  assert.equal(read.status, 200);
  assert.equal(read.json.body, '', 'direct read: body is the redacted value');
  assert.equal(read.json.deleted, true);
  assert.equal(read.json.deletedBy.objectId, w.acmeMember.objectId, 'moderation metadata retained');
  const viaFn = await mustCall(h, 'getMessages', { roomId: w.acme }, w.acmeMember2.token);
  const inPage = viaFn.messages.find((m) => m.id === target.id);
  assert.equal(inPage.body, '', 'history page: redacted too');

  let lqNote = 'LiveQuery unavailable on this target';
  if (sub) {
    const event = await sub.waitFor((e) => e.object && e.object.objectId === target.id, 5000);
    assert.ok(event, 'open subscribers were told about the deletion');
    assert.equal(event.object.body, '', 'the event carries the REDACTED body, not the original');
    lqNote = `LiveQuery emitted op:${event.op} with the redacted body (recorded either way per B3: update = soft delete keeps matching the query)`;
    await sub.close();
  }
  h.observe('T6 deletion event', lqNote);

  // Terminal + idempotent.
  const again = await mustCall(h, 'deleteMessage', { messageId: target.id }, w.acmeMember.token);
  assert.equal(again.already, true, 'second delete is a no-op');
  if (h.canMaster) {
    const undelete = await h.rest('PUT', `/classes/Message/${target.id}`, { deleted: false, body: 'resurrected' }, { master: true });
    assert.match(undelete.json.error, /MESSAGE_DELETED/, 'deletion is terminal even for the master key');
  }

  h.record({
    id: 'T6', test: 'soft delete (redacted from accessible storage)', persona: 'author, peer member, moderator (P2), outsider, anonymous',
    attempt: 'peer/foreign/anonymous deleteMessage refused; author deletes own; direct REST read + history page + LiveQuery event inspected; re-delete; master-key un-delete',
    status: '200/400', code: `NOT_ALLOWED 119 · 101 · 209 · ok · ${lqNote.slice(0, 60)}`,
    body: 'body == REDACTED everywhere after deletion: response, direct read, history page, live event',
    state: 'stored body overwritten; deleted/deletedAt/deletedBy retained; un-delete refused (terminal)',
  });
});

test('G1 (amendment B5) the administrative functions demand the server-checked token even while SETUP_ENABLED is on', async () => {
  // This suite's local server runs with the gate OPEN (flag on + token configured) — the refusals below are
  // therefore the TOKEN's doing, not the flag's. The flag-off and token-unset halves run in their own server
  // processes: test/setup-disabled.test.mjs and test/setup-tokenless.test.mjs.
  const missing = await h.call('setupSchema', { allowRerun: true });
  assert.equal(missing.error.code, 'SETUP_TOKEN_INVALID');
  assert.equal(missing.error.parseCode, 119);
  const wrong = await h.call('testInspect', { className: 'Message', setupToken: 'not-the-token-not-even-close' });
  assert.equal(wrong.error.code, 'SETUP_TOKEN_INVALID');
  const cleanupWrong = await h.call('testCleanup', { runPrefix: 'zzdeadbeef00', setupToken: 'not-the-token-not-even-close' });
  assert.equal(cleanupWrong.error.code, 'SETUP_TOKEN_INVALID');
  const seedWrong = await h.call('testSeedMessages', { roomId: w.acme, authorId: w.acmeMember.objectId, count: 1, runPrefix: 'zzdeadbeef00', setupToken: 'nope-nope-nope-nope' });
  assert.equal(seedWrong.error.code, 'SETUP_TOKEN_INVALID');

  const right = await h.call('testInspect', { className: 'Room', where: { objectId: w.acme }, setupToken: h.setupToken });
  assert.equal(right.ok, true, 'the correct token passes');
  assert.equal(right.result.results.length, 1);

  h.record({
    id: 'G1', test: 'administrative gate: token half (B5)', persona: 'anonymous with REST key',
    attempt: 'setupSchema without token; testInspect/testCleanup/testSeedMessages with a wrong token; testInspect with the right token',
    status: '400/200', code: 'SETUP_TOKEN_INVALID ×4 (119); correct token: 200',
    body: 'the flag alone opens nothing — the server-side SHA-256 comparison must also pass',
    state: 'flag-off (SETUP_DISABLED) and token-unset (SETUP_TOKEN_UNSET) halves recorded by their own suites',
  });
});

test('T11 (default half) demoSendMessage is not even registered in a default deploy: Parse 141', async () => {
  const r = await h.call('demoSendMessage', { roomId: w.acme, body: 'demo?' }, w.outsider.token);
  assert.equal(r.ok, false);
  assert.equal(r.error.parseCode, 141);
  assert.match(r.error.message, /Invalid function/);
  h.record({
    id: 'T11', test: 'deliberately unguarded function, default deploy', persona: 'outsider',
    attempt: 'call demoSendMessage while DEMO_UNGUARDED is off (every deploy default)',
    status: 404, code: '141 Invalid function',
    body: 'the function does not exist unless the flag is set in a throwaway process (see T11demo, own suite)',
    state: 'no Message row created',
  });
});
