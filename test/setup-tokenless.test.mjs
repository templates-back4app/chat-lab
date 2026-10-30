// File: test/setup-tokenless.test.mjs · G3: SETUP_ENABLED turned on but NO token hash configured — the
// misconfiguration half of amendment B5. The gate must fail CLOSED (SETUP_TOKEN_UNSET), never degrade to
// flag-only protection. Own process; the explicit empty hash beats the dev server's convenience default.
process.env.SETUP_ENABLED = '1';
process.env.SETUP_TOKEN_SHA256 = '';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
const { harness } = await import('./helpers.mjs');
const { LOCAL } = await import('../scripts/lib/env.mjs');

let h;
before(async () => {
  if (process.env.TEST_SERVER_URL) return;
  h = await harness({ suite: 'setup-tokenless' });
});
after(async () => { if (h) await h.cleanup(); });

test('G3 flag on, no token hash configured: every administrative call refuses with SETUP_TOKEN_UNSET (fail closed)', async (t) => {
  if (process.env.TEST_SERVER_URL) { t.skip('live run: local-only misconfiguration probe'); return; }
  for (const [name, params] of [
    ['setupSchema', { allowRerun: true }],
    ['testInspect', { className: 'Room' }],
    ['testCleanup', { runPrefix: 'zzdeadbeef00' }],
    ['testSeedMessages', { roomId: 'xxxxxxxxxx', authorId: 'xxxxxxxxxx', count: 1, runPrefix: 'zzdeadbeef00' }],
  ]) {
    const withToken = await h.call(name, { ...params, setupToken: LOCAL.SETUP_TOKEN });
    assert.equal(withToken.error.code, 'SETUP_TOKEN_UNSET', `${name}: SETUP_TOKEN_UNSET even with a token supplied`);
    assert.equal(withToken.error.parseCode, 119);
  }
  h.record({
    id: 'G3', test: 'administrative gate: unset-token half (B5)', persona: 'anonymous with REST key + any token',
    attempt: 'all four administrative functions on a server with SETUP_ENABLED=1 but no SETUP_TOKEN_SHA256',
    status: 400, code: 'SETUP_TOKEN_UNSET 119 ×4',
    body: 'turning the flag on without configuring the credential opens NOTHING — the gate fails closed',
    state: 'no schema change, no reads, no deletes',
  });
});
