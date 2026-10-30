// File: test/positive.test.mjs · P-series: positive controls. A backend that denies everything would pass
// most negative tests; these rows prove every persona CAN do what the design permits, asserting response
// bodies AND database state (master-rights read-back) AND — the chat-specific part — the LiveQuery event on
// an open subscription, never just status codes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, mustCall, ptr } from './helpers.mjs';

let h; let w;
before(async () => {
  h = await harness({ suite: 'positive' });
  w = await h.world();
});
after(async () => { await h.cleanup(); });

test('P1 member: reads the room history (bodies asserted), sends via sendMessage (row + ACL asserted), and receives the event on an open subscription', async (t) => {
  const token = w.acmeMember.token;

  // History through the function: both seed messages, newest first, bodies present.
  const page = await mustCall(h, 'getMessages', { roomId: w.acme }, token);
  assert.equal(page.mode, 'history');
  assert.deepEqual(page.messages.map((m) => m.id), [w.acmeMsg2, w.acmeMsg1], 'newest first');
  assert.equal(page.messages[1].body, 'Anvil shipment confirmed');
  assert.equal(page.more, false);

  // Direct REST read: the row ACL (member role) serves exactly the ACME messages.
  const rest = await h.rest('GET', '/classes/Message', undefined, { session: token });
  assert.equal(rest.status, 200);
  assert.deepEqual(new Set(rest.json.results.map((m) => m.objectId)), new Set([w.acmeMsg1, w.acmeMsg2]),
    'an unfiltered Message find returns exactly the two ACME messages — the ACL does the scoping, not the query');

  if (!h.liveQueryAvailable) { t.diagnostic('LiveQuery unavailable on this target: event half skipped'); }
  const sub = h.liveQueryAvailable ? await h.subscribe({ roomId: w.acme, session: token }) : null;

  const sent = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'P1 live message' }, token);
  assert.equal(sent.authorId, w.acmeMember.objectId, 'the author is always the caller');
  assert.equal(sent.deleted, false);
  const rows = await h.master('Message', { objectId: sent.id });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, 'P1 live message');
  assert.deepEqual(rows[0].ACL, { [`role:room_${w.acme}_member`]: { read: true } },
    'stored ACL is exactly member-role read, nothing else');

  let eventNote = 'LiveQuery unavailable (live target without LIVEQUERY_URL)';
  if (sub) {
    const event = await sub.waitFor((e) => e.op === 'create' && e.object.objectId === sent.id, 5000);
    assert.ok(event, 'the create event arrived on the already-open subscription');
    assert.equal(event.object.body, 'P1 live message');
    eventNote = `op:create delivered with the body`;
    await sub.close();
  }

  h.record({
    id: 'P1', test: 'positive control', persona: 'ACME member',
    attempt: 'getMessages; unfiltered REST find; sendMessage; event on an open room subscription',
    status: 200, code: null,
    body: `history returns both seed bodies newest-first; send echoes the message; ${eventNote}`,
    state: `Message stored with ACL {role:room_<acme>_member: read}; author = caller`,
  });
});

test('P2 moderator: everything a member can, plus addMember, removeMember, and deleteMessage on another author\'s message', async () => {
  const token = w.acmeMod.token;

  // Member powers: read + send.
  const page = await mustCall(h, 'getMessages', { roomId: w.acme }, token);
  assert.ok(page.messages.length >= 2);
  await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'P2 moderator speaking' }, token);

  // Moderator reads every membership row of the room (ACL: owner + moderator role).
  const memberships = await h.rest('GET', '/classes/RoomMembership', undefined, { session: token });
  const acmeRows = memberships.json.results.filter((m) => m.room.objectId === w.acme);
  assert.ok(acmeRows.length >= 5, `moderator lists the room's membership rows (got ${acmeRows.length})`);

  // addMember + state: membership row active, role entry present.
  const u = await h.addMember(token, w.acme, 'member', 'p2_member');
  const m1 = await h.master('RoomMembership', { user: ptr('_User', u.objectId), room: ptr('Room', w.acme) });
  assert.equal(m1[0].status, 'active');
  const roles = await h.master('_Role', { name: `room_${w.acme}_member`, users: ptr('_User', u.objectId) });
  assert.equal(roles.length, 1, 'addMember added the user to the member role');

  // removeMember + state: row flipped, role entry gone.
  const removed = await mustCall(h, 'removeMember', { roomId: w.acme, userId: u.objectId }, token);
  assert.equal(removed.removed, true);
  assert.equal((await h.master('RoomMembership', { user: ptr('_User', u.objectId), room: ptr('Room', w.acme) }))[0].status, 'removed');
  assert.equal((await h.master('_Role', { name: `room_${w.acme}_member`, users: ptr('_User', u.objectId) })).length, 0,
    'role entry gone after removal');

  // deleteMessage on ANOTHER author's message: redacted, metadata retained (B3 sub-rows live in matrix T6).
  const victim = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'P2 will be moderated away' }, w.acmeMember.token);
  const redacted = await mustCall(h, 'deleteMessage', { messageId: victim.id }, token);
  assert.equal(redacted.deleted, true);
  assert.equal(redacted.body, '', 'body redacted in the response');
  const rows = await h.master('Message', { objectId: victim.id });
  assert.equal(rows[0].body, '', 'body redacted in storage');
  assert.equal(rows[0].deletedBy.objectId, w.acmeMod.objectId, 'deletedBy retained for moderation');

  h.record({
    id: 'P2', test: 'positive control', persona: 'ACME moderator',
    attempt: 'member powers + list memberships + addMember/removeMember + deleteMessage on another author\'s message',
    status: 200, code: null,
    body: 'all succeed; deleteMessage returns the redacted message',
    state: 'membership active→removed with role entries following; message body overwritten server-side, deletedBy/deletedAt retained',
  });
});

test('P3 dual-room user: subscribed to both rooms, receives each room\'s events exactly on the matching subscription', async (t) => {
  if (!h.liveQueryAvailable) { t.skip('live run: enable Message under App Settings → Server Settings → Live Query and set LIVEQUERY_URL=wss://<subdomain>.b4a.io'); return; }
  const token = w.dual.token;
  const rooms = await mustCall(h, 'myRooms', {}, token);
  assert.deepEqual(new Set(rooms.rooms.map((r) => r.roomId)), new Set([w.acme, w.borealis]));

  const subAcme = await h.subscribe({ roomId: w.acme, session: token });
  const subBorealis = await h.subscribe({ roomId: w.borealis, session: token });

  const inAcme = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'P3 to ACME' }, w.acmeMember.token);
  const inBorealis = await mustCall(h, 'sendMessage', { roomId: w.borealis, body: 'P3 to Borealis' }, w.borealisMember.token);

  const gotAcme = await subAcme.waitFor((e) => e.object.objectId === inAcme.id, 5000);
  const gotBorealis = await subBorealis.waitFor((e) => e.object.objectId === inBorealis.id, 5000);
  assert.ok(gotAcme && gotBorealis, 'each subscription delivered its own room\'s message');

  // Routing: the ACME subscription must never see the Borealis message and vice versa.
  assert.equal(await subAcme.waitFor((e) => e.object.objectId === inBorealis.id, 800), null, 'no Borealis event on the ACME subscription');
  assert.equal(await subBorealis.waitFor((e) => e.object.objectId === inAcme.id, 800), null, 'no ACME event on the Borealis subscription');

  await subAcme.close();
  await subBorealis.close();
  h.record({
    id: 'P3', test: 'positive control', persona: 'dual-room user (ACME + Borealis)',
    attempt: 'two open subscriptions, one send into each room',
    status: 'ws', code: 'create ×2, correctly routed',
    body: 'each event arrived exactly on the subscription whose room filter matches; zero cross-deliveries',
    state: 'myRooms lists both rooms',
  });
});
