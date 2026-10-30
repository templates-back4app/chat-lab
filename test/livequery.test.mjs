// File: test/livequery.test.mjs · the subscription-behaviour rows that are not reconnect (T10, own suite) or
// revocation (T8, own suite): T7 — the GRANT direction of H4 (a subscription opened BEFORE membership, kept
// open across addMember: when do events start arriving?), and T9 — interleaved senders: no cross-room
// leakage, arrival order vs createdAt order RECORDED (H5 — whatever it is, it is reported; timestamp ordering
// does not establish a total order of writes and the lab never claims it does).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness, mustCall, sleep } from './helpers.mjs';

let h; let w;
before(async () => {
  h = await harness({ suite: 'livequery' });
  w = await h.world();
});
after(async () => { await h.cleanup(); });

const lqSkip = (t) => {
  if (h.liveQueryAvailable) return false;
  t.skip('live run: enable Message under App Settings → Server Settings → Live Query and set LIVEQUERY_URL=wss://<subdomain>.b4a.io');
  return true;
};

test('T7 (H4 grant direction) a subscription opened BEFORE membership starts delivering only after addMember — the delay is recorded', async (t) => {
  if (lqSkip(t)) return;
  const joiner = await h.signUp('t7_joiner');
  const sub = await h.subscribe({ roomId: w.acme, session: joiner.token, allowError: true });
  assert.equal(sub.error, null, 'the pre-membership subscribe was acknowledged (rejection, if any, is at event time)');

  // Not a member yet: nothing may arrive.
  await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T7 before grant' }, w.acmeMember.token);
  assert.equal(await sub.waitFor(() => true, 1500), null, 'no event before the grant');

  const t0 = performance.now();
  await mustCall(h, 'addMember', { roomId: w.acme, userId: joiner.objectId }, w.acmeMod.token);
  const grantReturnedMs = performance.now() - t0;

  // Probe until the OPEN subscription delivers (the LiveQuery server caches resolved session auth — the grant
  // may lag on an open connection exactly like revocation drains; 20 s cap, record the outcome either way).
  let firstDeliveredMs = null;
  let probes = 0;
  while (performance.now() - t0 < 20000) {
    probes++;
    const probe = await mustCall(h, 'sendMessage', { roomId: w.acme, body: `T7 probe ${probes}` }, w.acmeMember.token);
    const e = await sub.waitFor((x) => x.object && x.object.objectId === probe.id, 1200);
    if (e) { firstDeliveredMs = performance.now() - t0; break; }
    await sleep(400);
  }
  // A FRESH subscription opened after the grant must deliver immediately (the fresh-request half of H4).
  const fresh = await h.subscribe({ roomId: w.acme, session: joiner.token });
  const freshProbe = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'T7 fresh probe' }, w.acmeMember.token);
  const freshGot = await fresh.waitFor((x) => x.object && x.object.objectId === freshProbe.id, 5000);
  assert.ok(freshGot, 'a subscription opened AFTER the grant delivers');

  h.observe('T7 grant propagation (open subscription)', firstDeliveredMs === null
    ? `NOT delivered within 20 s on the pre-grant subscription (${probes} probes) — an open subscription does not pick up a new grant on this target; a resubscribe is required. Fresh subscription delivered immediately.`
    : `first event ${Math.round(firstDeliveredMs)} ms after addMember returned (call itself ${Math.round(grantReturnedMs)} ms, ${probes} probe(s)); fresh subscription also delivered`);
  await sub.close();
  await fresh.close();
  h.record({
    id: 'T7', test: 'membership grant vs open subscription (H4 mirror of revocation)', persona: 'new member (subscription opened pre-grant)',
    attempt: 'subscribe before membership; probe; addMember; probe until delivery or 20 s; fresh subscription control',
    status: 'ws', code: firstDeliveredMs === null ? 'open sub: no delivery ≤ 20 s; fresh sub: delivers' : `open sub: first event +${Math.round(firstDeliveredMs)} ms; fresh sub: delivers`,
    body: 'pre-grant sends never arrived; the recorded delay is the grant direction of H4 (local mechanics; live re-run is the quoted number)',
    state: 'RoomMembership active; role entry present (addMember state asserted in P2)',
  });
});

test('T9 (H5) two senders interleave 50 messages; a third member subscribes: no leakage, arrival order vs createdAt recorded', async (t) => {
  if (lqSkip(t)) return;
  const watcher = await h.subscribe({ roomId: w.acme, session: w.acmeMember2.token });
  const borealisWatcher = await h.subscribe({ roomId: w.borealis, session: w.borealisMember.token });

  // 25 sends per sender, fired concurrently in pairs — the racing writers of the brief.
  const results = [];
  for (let i = 0; i < 25; i++) {
    const [a, b] = await Promise.all([
      mustCall(h, 'sendMessage', { roomId: w.acme, body: `T9 A${i}` }, w.acmeMember.token),
      mustCall(h, 'sendMessage', { roomId: w.acme, body: `T9 B${i}` }, w.acmeMod.token),
    ]);
    results.push(a, b);
  }
  const ids = new Set(results.map((r) => r.id));

  // Wait until all 50 arrived (or 15 s).
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (watcher.events.filter((e) => ids.has(e.object.objectId)).length >= 50) break;
    await sleep(200);
  }
  const arrived = watcher.events.filter((e) => ids.has(e.object.objectId));
  assert.equal(arrived.length, 50, `all 50 interleaved messages delivered (got ${arrived.length})`);
  assert.equal(new Set(arrived.map((e) => e.object.objectId)).size, 50, 'no duplicates');
  assert.equal(borealisWatcher.events.filter((e) => ids.has(e.object.objectId)).length, 0, 'zero leakage into the Borealis subscription');

  // H5: compare arrival order with createdAt order — recorded, not asserted (one run shows one outcome).
  const arrivalIds = arrived.map((e) => e.object.objectId);
  const byCreated = [...arrived].sort((x, y) =>
    (Date.parse(x.object.createdAt) - Date.parse(y.object.createdAt)) || (x.object.objectId < y.object.objectId ? -1 : 1));
  const inversions = arrivalIds.reduce((n, id, i) => n + (byCreated[i].object.objectId !== id ? 1 : 0), 0);
  const createdAtValues = arrived.map((e) => e.object.createdAt);
  const equalTimestampGroups = createdAtValues.length - new Set(createdAtValues).size;
  h.observe('T9 ordering (H5)', `50/50 delivered, 0 duplicates, 0 leaks; positions where arrival order differs from (createdAt, objectId) order: ${inversions}; messages sharing a createdAt millisecond with another: ${equalTimestampGroups}. One run, one outcome — no ordering guarantee is claimed either way.`);

  await watcher.close();
  await borealisWatcher.close();
  h.record({
    id: 'T9', test: 'interleaved senders, scoping + ordering (H5)', persona: 'two ACME senders + ACME watcher + Borealis watcher',
    attempt: '25 concurrent send-pairs into ACME while both rooms have open subscriptions',
    status: 'ws', code: `50 events, 0 dup, 0 leaked; arrival-vs-createdAt mismatched positions: ${inversions}`,
    body: `equal-createdAt collisions in this run: ${equalTimestampGroups}; ordering reported as observed, never guaranteed (H5)`,
    state: '50 Message rows in the room (master read-back)',
  });
  assert.equal((await h.master('Message', { room: { __type: 'Pointer', className: 'Room', objectId: w.acme } })).filter((m) => ids.has(m.objectId)).length, 50);
});
