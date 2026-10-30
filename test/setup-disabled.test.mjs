// File: test/setup-disabled.test.mjs · G2: the DEFAULT DEPLOYMENT (amendment B5) — SETUP_ENABLED off — must
// refuse every administrative function with SETUP_DISABLED, token or no token. Own process (node --test runs
// each file separately), so the explicit '0' below beats the dev server's local convenience default.
process.env.SETUP_ENABLED = '0';
process.env.SETUP_TOKEN_SHA256 = '';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
const { harness } = await import('./helpers.mjs');
const { LOCAL } = await import('../scripts/lib/env.mjs');

let h;
before(async () => {
  if (process.env.TEST_SERVER_URL) return;
  h = await harness({ suite: 'setup-disabled' });
});
after(async () => { if (h) await h.cleanup(); });

test('G2 default deployment: every administrative function answers SETUP_DISABLED, with or without a token', async (t) => {
  if (process.env.TEST_SERVER_URL) { t.skip('live run: the live backend is deliberately gate-OPEN during the measurement campaign; the disable-and-verify step closes it afterwards (README)'); return; }
  for (const [name, params] of [
    ['setupSchema', { allowRerun: true }],
    ['testInspect', { className: 'Room' }],
    ['testCleanup', { runPrefix: 'zzdeadbeef00' }],
    ['testSeedMessages', { roomId: 'xxxxxxxxxx', authorId: 'xxxxxxxxxx', count: 1, runPrefix: 'zzdeadbeef00' }],
  ]) {
    const bare = await h.call(name, params);
    assert.equal(bare.error.code, 'SETUP_DISABLED', `${name} without token: SETUP_DISABLED`);
    assert.equal(bare.error.parseCode, 119);
    const withToken = await h.call(name, { ...params, setupToken: LOCAL.SETUP_TOKEN });
    assert.equal(withToken.error.code, 'SETUP_DISABLED', `${name} with a (correct-looking) token: still SETUP_DISABLED — the flag is checked first`);
  }
  h.record({
    id: 'G2', test: 'administrative gate: flag half (B5 default deployment)', persona: 'anonymous with REST key (+ the local token)',
    attempt: 'all four administrative functions, with and without the token, on a server with SETUP_ENABLED off',
    status: 400, code: 'SETUP_DISABLED 119 ×8',
    body: 'the default deployment refuses everything administrative regardless of credentials',
    state: 'no schema change, no reads, no deletes — the server also starts fine with the gate closed (registry covers setup functions)',
  });
});
