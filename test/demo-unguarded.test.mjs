// File: test/demo-unguarded.test.mjs · T11, the enabled half: a Cloud function WITHOUT the membership check
// leaks INTO a room — the outsider's message is delivered to a member's open subscription — shown
// deliberately, then compared with the guarded sendMessage.
//
// DEMO_UNGUARDED=1 is set below, BEFORE cloud/main.js is loaded. node --test runs every test file in its own
// process, so the flag never leaks into the other suites; matrix.test.mjs proves the same function answers
// 141 "Invalid function" in a default deploy. Never set this flag on a backend with real data.
process.env.DEMO_UNGUARDED = '1';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
// Dynamic import: static imports are hoisted and would load cloud/config.js BEFORE the flag above is set.
const { harness, mustCall } = await import('./helpers.mjs');

let h; let w;
before(async () => {
  if (process.env.TEST_SERVER_URL) return; // skipped on live targets (see the test body)
  h = await harness({ suite: 'demo-unguarded' });
  w = await h.world();
});
after(async () => { if (h) await h.cleanup(); });

test('T11 (demo half) the unguarded function posts an outsider\'s message into the room and members RECEIVE it; the guarded version refuses', async (t) => {
  if (process.env.TEST_SERVER_URL) { t.skip('live run: the demo flag must never be set on a shared backend — the default-deploy half (141) runs live in the matrix suite'); return; }

  const sub = await h.subscribe({ roomId: w.acme, session: w.acmeMember.token });

  // The vulnerable version: authentication alone, no membership check, master-key write with the hook stood
  // down (DEMO_UNGUARDED models the naive app that has neither guard layer).
  const leak = await h.call('demoSendMessage', { roomId: w.acme, body: 'outsider was here' }, w.outsider.token);
  assert.equal(leak.ok, true, 'the unguarded function accepts the outsider\'s message');
  const event = await sub.waitFor((e) => e.object && e.object.objectId === leak.result.id, 5000);
  assert.ok(event, 'the leak is REAL TIME: the member\'s open subscription delivered the outsider\'s message');
  assert.equal(event.object.body, 'outsider was here');
  const row = (await h.master('Message', { objectId: leak.result.id }))[0];
  assert.equal(row.author.objectId, w.outsider.objectId, 'the row landed in the room with the outsider as author');

  // Anonymous callers are still refused — which is exactly why "it requires a user" feels safe and is not.
  const anon = await h.call('demoSendMessage', { roomId: w.acme, body: 'anon' });
  assert.equal(anon.error.parseCode, 209);

  // The fixed version: same caller, same room — the GUARDS-table membership guard refuses.
  const fixed = await h.call('sendMessage', { roomId: w.acme, body: 'outsider again' }, w.outsider.token);
  assert.equal(fixed.error.code, 'NOT_A_MEMBER');
  assert.equal(fixed.error.parseCode, 119);
  const own = await mustCall(h, 'sendMessage', { roomId: w.acme, body: 'member still fine' }, w.acmeMember.token);
  assert.ok(own.id, 'the guarded version still serves actual members');

  // Defense in depth, the other way around: with the flag ON but WITHOUT the demo save-context, the hook
  // still refuses a non-member author even under the master key — the demo had to stand BOTH layers down.
  const hookHolds = await h.rest('POST', '/classes/Message',
    { room: { __type: 'Pointer', className: 'Room', objectId: w.acme }, author: { __type: 'Pointer', className: '_User', objectId: w.outsider.objectId }, body: 'no context', deleted: false },
    { master: true });
  assert.match(hookHolds.json.error, /AUTHOR_NOT_MEMBER/, 'the hook alone still blocks a plain master-key write');

  await sub.close();
  h.observe('T11 demo', `demoSendMessage delivered "${event.object.body}" from a non-member to a member's live subscription; sendMessage answers NOT_A_MEMBER for the same caller; the hook alone still blocks a contextless master write`);
  h.record({
    id: 'T11demo', test: 'unguarded function (DEMO_UNGUARDED=1, throwaway server)', persona: 'outsider',
    attempt: 'demoSendMessage into ACME with a member subscribed; then the guarded sendMessage; then a master write without the demo context',
    status: '200 / 400', code: 'leak delivered live / NOT_A_MEMBER 119 / AUTHOR_NOT_MEMBER (hook)',
    body: 'a missing authorization check can leak room data: the outsider\'s message reached members in real time. The demo stands down BOTH layers; either one alone stops it',
    state: 'flag off by default (T11 in the matrix suite: 141); registration without a GUARDS entry refuses to start (R-series)',
  });
});
