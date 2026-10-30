// File: test/guards.test.mjs · the guard registry (cloud/guards.js) as a unit, with no Parse and no server:
// a function missing from the GUARDS table, naming an unknown guard, registered twice, or listed but never
// registered must THROW AT LOAD — a forgotten guard fails the deploy, not the room. Amendment B5: the
// administrative functions are covered by the same registry, which the last test asserts against the real
// GUARDS table in cloud/main.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createRegistry, GUARD_NAMES } = createRequire(import.meta.url)('../cloud/guards.js');

test('R1 a Cloud function not listed in GUARDS refuses to register (fails the deploy at load)', () => {
  const registry = createRegistry({ listed: 'authenticated' }, {});
  assert.throws(() => registry.define('unlisted', () => {}), /not listed in the GUARDS table/);
});

test('R2 an entry naming an unknown guard throws while the table is validated', () => {
  assert.throws(() => createRegistry({ broken: 'sometimes-checked' }, {}), /unknown guard "sometimes-checked"/);
});

test('R3 double registration throws; a listed-but-never-registered entry fails assertAllRegistered', () => {
  const registry = createRegistry({ a: 'authenticated', b: 'member' }, {});
  registry.define('a', () => {});
  assert.throws(() => registry.define('a', () => {}), /registered twice/);
  assert.throws(() => registry.assertAllRegistered(), /never registered: b/);
});

test('R4 demo-unguarded entries are skipped (not registered at all) while the demo flag is off', () => {
  const calls = [];
  const registry = createRegistry({ demo: 'demo-unguarded', real: 'member' }, { demoEnabled: false });
  registry.define('demo', (g) => calls.push(g));
  registry.define('real', (g) => calls.push(g));
  assert.deepEqual(calls, ['member'], 'the demo function was never handed to Parse.Cloud.define');
  registry.assertAllRegistered(); // a skipped demo entry does not count as missing
});

test('R5 the real GUARDS table covers the administrative functions with the setup guard (amendment B5)', () => {
  // cloud/main.js needs the Parse global to load, so the table is read from the source text. The server-side
  // enforcement (registry throws at load) is proven by R1–R3 plus the fact that every other suite's server
  // starts; this row pins the table contents the registry enforces.
  const source = readFileSync(path.join(ROOT, 'cloud', 'main.js'), 'utf8');
  const tableMatch = source.match(/const GUARDS = \{([\s\S]*?)\};/);
  assert.ok(tableMatch, 'GUARDS table found in cloud/main.js');
  const entries = Object.fromEntries([...tableMatch[1].matchAll(/^\s*(\w+):\s*'([a-z-]+)'/gm)].map((m) => [m[1], m[2]]));
  for (const fn of ['setupSchema', 'testInspect', 'testCleanup', 'testSeedMessages']) {
    assert.equal(entries[fn], 'setup', `${fn} declares the setup guard (SETUP_ENABLED + server-checked token)`);
  }
  assert.equal(entries.demoSendMessage, 'demo-unguarded');
  for (const guard of Object.values(entries)) assert.ok(GUARD_NAMES.includes(guard), `guard ${guard} is a known name`);
  assert.deepEqual(
    Object.keys(entries).sort(),
    ['addMember', 'createRoom', 'deleteMessage', 'demoSendMessage', 'getMessages', 'myRooms',
      'removeMember', 'sendMessage', 'setupSchema', 'testCleanup', 'testInspect', 'testSeedMessages'].sort(),
    'the 12 functions of the lab, each with a declared guard',
  );
});
