// File: test/revocation.test.mjs · T8 (amendment B4: revocation RE-MEASURED in this room model — the timing
// distribution is scripts/measure-revocation.mjs, 10 runs, live phase; this suite proves the local MECHANISM
// and the accepted behaviour defined before measuring: fresh requests refused once removeMember returns, the
// open-subscription drain bounded, previously received content out of scope by definition) and T12
// (concurrency races: removeMember vs sendMessage, deleteMessage racing a send — recorded outcomes; hooks are
// validation, not database constraints, and any unauthorized delivery observed is a REPORTED finding).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, mustCall, sleep, ptr } from './helpers.mjs';

let h; let w;
before(async () => {
  h = await harness({ suite: 'revocation' });
  w = await h.world();
});
after(async () => { await h.cleanup(); });

test('T8 removed member: fresh requests are refused when removeMember returns; the open subscription drains within a bounded window', async (t) => {
  if (!h.liveQueryAvailable) { t.skip('live run: enable Message under App Settings → Server Settings → Live Query and set LIVEQUERY_URL=wss://<subdomain>.b4a.io'); return; }
  const victim = await h.addMember(w.acmeMod.token, w.acme, 'member', 't8_victim');
  const sub = await h.subscribe({ roomId: w.acme, session: victim.token });
  const warm = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T8 before removal' }, w.acmeMod.token);
  assert.ok(await sub.waitFor((e) => e.object.objectId === warm.id, 5000), 'subscription delivers before removal');

  const t0 = Date.now();
  await mustCall(h, 'removeMember', { roomId: w.acme, userId: victim.objectId }, w.acmeMod.token);

  // Fresh requests, immediately after return: the function path and the row-ACL path both refused.
  const fnAfter = await h.call('sendMessage', { roomId: w.acme, body: 'T8 after removal' }, victim.token);
  assert.equal(fnAfter.error.code, 'NOT_A_MEMBER', 'fresh write refused (membership row flipped first)');
  const histAfter = await h.call('getMessages', { roomId: w.acme }, victim.token);
  assert.equal(histAfter.error.code, 'NOT_A_MEMBER', 'fresh function read refused');
  const restAfter = await h.rest('GET', '/classes/Message', undefined, { session: victim.token });
  assert.deepEqual(restAfter.json.results, [], 'fresh REST read sees zero rows (role entries gone)');

  // The open-subscription drain: probe until confirmed silence (the LiveQuery server caches resolved session
  // auth, default cacheTimeout 5 s — "ends within a bounded window" is the claim, never "instant").
  let lastDelivered = null;
  let quietSince = null;
  while (Date.now() - t0 < 12000) {
    const probe = await mustCall(h, 'sendMessage', { roomId: w.acme, body: `T8 probe ${Date.now() - t0}ms` }, w.acmeMod.token);
    const e = await sub.waitFor((x) => x.object && x.object.objectId === probe.id, 1200);
    if (e) { lastDelivered = Date.now() - t0; quietSince = null; }
    else if (quietSince === null) quietSince = Date.now() - t0;
    if (quietSince !== null && Date.now() - t0 - quietSince >= 3000) break; // 3 s of silence across probes
    await sleep(400);
  }
  assert.notEqual(quietSince, null, `delivery to the removed member never stopped (last event ${lastDelivered} ms after removal)`);

  // A brand-new subscription after removal delivers nothing at all.
  const fresh = await h.subscribe({ roomId: w.acme, session: victim.token, allowError: true });
  if (!fresh.error) {
    const probe2 = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T8 after removal probe' }, w.acmeMod.token);
    assert.equal(await fresh.waitFor((x) => x.object && x.object.objectId === probe2.id, 2500), null,
      'a fresh subscription opened after removal receives nothing');
  }
  await sub.close();
  await fresh.close();
  h.observe('T8 revocation (LOCAL mechanics)',
    `fresh fn write/read + REST read refused immediately after removeMember returned; open subscription: last event ${lastDelivered === null ? 'none' : `${lastDelivered} ms`} after removal, silent from ${quietSince} ms. The 10-run DISTRIBUTION in this room model is scripts/measure-revocation.mjs — live phase (B4)`);
  h.record({
    id: 'T8', test: 'revocation in the room model (B4)', persona: 'removed member (open + fresh subscription)',
    attempt: 'removeMember; immediate fresh write/read/REST probes; drain probes on the open subscription; fresh subscription',
    status: 'ws/REST', code: `fresh: NOT_A_MEMBER + 0 rows · open sub last event ${lastDelivered === null ? 'none' : lastDelivered + ' ms'}, silent from ${quietSince} ms · fresh sub: 0 events`,
    body: 'the accepted revocation behaviour holds: fresh requests refused at return; the drain is a measured delay, never claimed instant; already-received content is unrecoverable by definition and out of the window',
    state: 'membership row removed; both role entries gone. Timing distribution: measure-revocation.mjs, 10 runs, LIVE',
  });
});

test('T12 races: concurrent removeMember/sendMessage and deleteMessage racing a send — outcomes recorded, invariants checked', async () => {
  // Race 1: removal vs 6 rapid sends by the victim. Whatever interleaving wins, every ACCEPTED message must
  // exist with the proper ACL and every REFUSED one must be NOT_A_MEMBER — no half-written row, no row
  // without the room ACL.
  const victim = await h.addMember(w.acmeMod.token, w.acme, 'member', 't12_victim');
  const sends = Array.from({ length: 6 }, (_, i) => h.call('sendMessage', { roomId: w.acme, body: `T12 race ${i}` }, victim.token));
  const removal = h.call('removeMember', { roomId: w.acme, userId: victim.objectId }, w.acmeMod.token);
  const settled = await Promise.all([removal, ...sends]);
  const removeResult = settled[0];
  assert.equal(removeResult.ok, true, 'removeMember succeeded');
  const accepted = settled.slice(1).filter((r) => r.ok);
  const refused = settled.slice(1).filter((r) => !r.ok);
  for (const r of refused) assert.equal(r.error.code, 'NOT_A_MEMBER', 'refusals are the membership guard, nothing else');
  for (const r of accepted) {
    const row = (await h.master('Message', { objectId: r.result.id }))[0];
    assert.ok(row, 'accepted message exists');
    assert.deepEqual(row.ACL, { [`role:room_${w.acme}_member`]: { read: true } }, 'accepted message carries the room ACL');
  }
  h.observe('T12 removeMember vs sendMessage', `6 concurrent sends during removal: ${accepted.length} accepted (all with correct ACL), ${refused.length} refused NOT_A_MEMBER. The exact split is scheduling, not a guarantee — hooks are validation, not DB constraints.`);

  // Race 2: deleteMessage racing a send burst by the author — deletion must win terminally on its target.
  const target = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T12 delete target' }, w.acmeMember.token);
  const [del, ...more] = await Promise.all([
    h.call('deleteMessage', { messageId: target.id }, w.acmeMember.token),
    h.call('sendMessage', { roomId: w.acme, body: 'T12 concurrent A' }, w.acmeMember.token),
    h.call('sendMessage', { roomId: w.acme, body: 'T12 concurrent B' }, w.acmeMember.token),
  ]);
  assert.equal(del.ok, true);
  const row = (await h.master('Message', { objectId: target.id }))[0];
  assert.equal(row.deleted, true);
  assert.equal(row.body, '', 'the redaction landed despite the concurrent traffic');
  for (const r of more) assert.equal(r.ok, true, 'unrelated sends were untouched by the race');

  // Race 3: two concurrent removals of the same member — both must settle without corrupting state.
  const victim2 = await h.addMember(w.acmeMod.token, w.acme, 'member', 't12_victim2');
  const [r1, r2] = await Promise.all([
    h.call('removeMember', { roomId: w.acme, userId: victim2.objectId }, w.acmeMod.token),
    h.call('removeMember', { roomId: w.acme, userId: victim2.objectId }, w.acmeMod.token),
  ]);
  assert.ok(r1.ok && r2.ok, 'both removals settle (idempotent by design)');
  assert.equal((await h.master('RoomMembership', { user: ptr('_User', victim2.objectId), room: ptr('Room', w.acme) }))[0].status, 'removed');
  assert.equal((await h.master('_Role', { name: `room_${w.acme}_member`, users: ptr('_User', victim2.objectId) })).length, 0);

  h.record({
    id: 'T12', test: 'concurrency races', persona: 'victim + moderator + author, racing',
    attempt: 'removeMember ∥ 6×sendMessage; deleteMessage ∥ 2×sendMessage; removeMember ∥ removeMember',
    status: 200, code: `${accepted.length} accepted / ${refused.length} NOT_A_MEMBER in the removal race; redaction terminal; double removal idempotent`,
    body: 'recorded outcomes; cross-record invariants under concurrency are best-effort and stated as such',
    state: 'every accepted row carries the room ACL; membership removed exactly once; no partial rows observed',
  });
});
