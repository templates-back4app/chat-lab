// File: scripts/request-budget.mjs · Node 22 ESM · amendment CC4: the request-budget inventory, computed at
// Phase A from the REAL test inventory before any live run — never estimated from vibes.
//
// Two kinds of numbers, counted SEPARATELY and never conflated:
//   - HTTP requests: what the client sends. For the test suites they are MEASURED (run
//     `COUNT_REQUESTS=1 npm test`: the in-process server counts every request per suite into
//     docs/notes/.request-counts.jsonl). For the measurement scripts they are COMPUTED from the same
//     parameters the scripts default to (warm-ups, runs, ladder, K, sizes — imported, not retyped).
//   - Billable platform operations: what the backend's plan meter may count. A Cloud function call fans out
//     into server-side reads/writes (guard reads, hook re-checks, role writes), and a batch of 50 writes is
//     NEVER assumed to be one billable request. The per-function fan-out below is an ESTIMATE from reading
//     cloud/main.js; the actual billing granularity is established empirically EARLY in the live phase (Plan
//     Usage delta after a known workload — the first live step) and recorded as a finding.
//
// Output: docs/notes/request-budget.md (summarized in the build diary) + stdout.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/env.mjs';
import { WARMUPS_DEFAULT, RUNS_DEFAULT } from './lib/measure.mjs';

const COUNTS_FILE = path.join(ROOT, 'docs', 'notes', '.request-counts.jsonl');

// ---- measured: HTTP requests per suite (latest COUNT_REQUESTS=1 npm test run wins per suite) --------------
let suiteCounts = null;
if (existsSync(COUNTS_FILE)) {
  suiteCounts = new Map();
  for (const line of readFileSync(COUNTS_FILE, 'utf8').split('\n').filter(Boolean)) {
    const { suite, requests } = JSON.parse(line);
    suiteCounts.set(suite, requests); // later lines overwrite: the last complete run wins
  }
}

// ---- server-side fan-out per Cloud function (ESTIMATED from cloud/main.js; to verify live) ----------------
// objects read + written per call, counting guard reads, hook re-checks and role writes.
const FANOUT = {
  signUp: 2, createRoom: 11, addMember: 9, removeMember: 9, sendMessage: 6, getMessages: 3,
  deleteMessage: 8, testInspect: 2, testCleanup: 15, setupSchema: 8, seedPerMessage: 3,
};

// ---- computed: the measurement scripts, from their own default parameters --------------------------------
const W = WARMUPS_DEFAULT; const R = RUNS_DEFAULT;
const M4W = 5; const M4R = R;              // measure-delivery defaults
const FAN_LADDER = [1, 10, 50];            // measure-fanout default ladder
const M3_RUNS = 10; const M3_K = 10;       // measure-reconnect defaults
const T8_RUNS = 10;                        // measure-revocation default
const M5_CAP = 3000;                       // measure-throttle --max-requests default on live — THE cap (CC4)
const M6_SIZES = [1000, 10000];            // measure-history defaults
const world = (members) => 2 + 2 * members; // signUp mod + createRoom + per member (signUp + addMember)

const measurements = [
  {
    name: 'M0+M1+M4 measure-delivery',
    http: world(1) + (W + R) + (W + R) + (M4W + M4R) + 1,
    detail: `world ${world(1)} + M0 ${W}+${R} + M1 ${W}+${R} + M4 ${M4W}+${M4R} + cleanup 1; plus ${1 + M4W + M4R} WebSocket connections (not HTTP)`,
    ops: world(1) * 10 + (2 * (W + R) + M4W + M4R) * FANOUT.sendMessage + FANOUT.testCleanup,
  },
  {
    name: 'M2 measure-fanout (1/10/50)',
    http: world(Math.max(...FAN_LADDER)) + FAN_LADDER.length * (W + R) + 1,
    detail: `world ${world(50)} (50 distinct member accounts) + ${FAN_LADDER.length}×(${W}+${R}) sends + cleanup 1; plus ${FAN_LADDER.reduce((a, b) => a + b, 0)} WebSocket connections`,
    ops: world(50) * 10 + FAN_LADDER.length * (W + R) * FANOUT.sendMessage + FANOUT.testCleanup,
  },
  {
    name: 'M3 measure-reconnect (2 modes × 10 runs)',
    http: world(1) + 2 * M3_RUNS * (1 + M3_K + 3) + 1,
    detail: `world ${world(1)} + 2×${M3_RUNS} runs × (1 warm + K=${M3_K} + ~3 catch-up pages) + cleanup 1`,
    ops: world(1) * 10 + 2 * M3_RUNS * ((1 + M3_K) * FANOUT.sendMessage + 3 * FANOUT.getMessages) + FANOUT.testCleanup,
  },
  {
    name: 'T8 measure-revocation (10 runs)',
    http: T8_RUNS * 30 + 1,
    detail: `${T8_RUNS} runs × ~30 (2 sign-ups, room, membership, warm sends, removeMember, refused-read polls ~3, drain probes ~12–20) + cleanup 1 — probe counts depend on the measured drain; 30/run is the budget ceiling`,
    ops: T8_RUNS * (2 * FANOUT.signUp + FANOUT.createRoom + FANOUT.addMember + FANOUT.removeMember + 16 * FANOUT.sendMessage + 4 * FANOUT.getMessages) + FANOUT.testCleanup,
  },
  {
    name: 'M5 measure-throttle (CAP — deliberately exceeds the polite rate; THROWAWAY backend)',
    http: M5_CAP,
    detail: `hard cap --max-requests ${M5_CAP}: the ramp stops at the first Parse 155 or at the cap, whichever first (CC4's explicit M5 cap)`,
    ops: M5_CAP * FANOUT.sendMessage,
  },
  {
    name: 'M6 measure-history (1,000 and 10,000 messages)',
    http: world(0) + Math.ceil(Math.max(...M6_SIZES) / 500) + (Math.ceil(Math.max(...M6_SIZES) / 200) + 2) + M6_SIZES.length * 2 * (W + R) + 1,
    detail: `world ${world(0)} + seeding ${Math.ceil(10000 / 500)} testSeedMessages calls (500/batch) + deep-cursor walk ~${Math.ceil(10000 / 200) + 2} pages + ${M6_SIZES.length} sizes × 2 page kinds × (${W}+${R}) timed reads + cleanup 1`,
    ops: Math.max(...M6_SIZES) * FANOUT.seedPerMessage + (M6_SIZES.length * 2 * (W + R) + 52) * (FANOUT.getMessages + 50) + FANOUT.testCleanup,
    opsNote: `seeding is ${Math.ceil(10000 / 500)} HTTP calls but ~${Math.max(...M6_SIZES) * FANOUT.seedPerMessage.toLocaleString()} server-side operations — the clearest case of HTTP ≠ billable (CC4)`,
  },
];

const suiteTotal = suiteCounts ? [...suiteCounts.values()].reduce((a, b) => a + b, 0) : null;
const measureTotal = measurements.reduce((a, m) => a + m.http, 0);
const opsTotal = measurements.reduce((a, m) => a + m.ops, 0);
const RETRY_FACTOR = 1.15;

const lines = [];
const out = (s) => { lines.push(s); console.log(s); };

out(`# Request-budget inventory (amendment CC4) — computed ${new Date().toISOString().slice(0, 10)}`);
out('');
out('Computed from the real test inventory at Phase A, before any live run. HTTP requests and billable');
out('platform operations are counted separately; a batch is never assumed to be one billable request. The');
out('fan-out factors are estimates from reading cloud/main.js — **the first live step measures the actual');
out('billing granularity** (Plan Usage delta after a known workload, e.g. one M0 block of 120 sends) and this');
out('file is then corrected from that finding.');
out('');
out('## Test suites (HTTP requests, MEASURED locally via COUNT_REQUESTS=1 npm test)');
out('');
if (suiteCounts) {
  out('| suite | HTTP requests (measured) |');
  out('|---|---|');
  for (const [suite, n] of [...suiteCounts.entries()].sort()) out(`| ${suite} | ${n} |`);
  out(`| **total, one \`npm test\` run** | **${suiteTotal}** |`);
  out('');
  out(`Live-run adjustments: the three local-only suites/rows (SQL surgery, master probes, demo flag) SKIP on`);
  out(`live targets (fewer requests), while live mode adds setupSchema + testInspect state read-backs +`);
  out(`testCleanup per suite (~10–25 extra per suite). Budget the live suite at the measured local total.`);
} else {
  out('**No measured counts yet** — run `COUNT_REQUESTS=1 npm test`, then `npm run budget` again.');
}
out('');
out('## Measurement scripts (HTTP computed from their own default parameters; ops = estimated server-side fan-out)');
out('');
out('| measurement | HTTP requests | server-side object ops (est., to verify live) | how computed |');
out('|---|---|---|---|');
for (const m of measurements) out(`| ${m.name} | ${m.http} | ~${Math.round(m.ops).toLocaleString('en-US')} | ${m.detail}${m.opsNote ? ' · ' + m.opsNote : ''} |`);
out(`| **total** | **${measureTotal}** | **~${Math.round(opsTotal).toLocaleString('en-US')}** | |`);
out('');
out('## Phase A live-run total (what the plan meter must absorb)');
out('');
const suiteN = suiteTotal ?? 1500;
const grand = Math.round((suiteN * 2 + measureTotal) * RETRY_FACTOR);
out(`| item | HTTP requests |`);
out(`|---|---|`);
out(`| live \`npm test\` run | ~${suiteN}${suiteTotal === null ? ' (placeholder — measure first)' : ''} |`);
out(`| one independent README run (the agent test, §9) | ~${suiteN} |`);
out(`| measurement scripts M0–M6 + T8 | ${measureTotal} |`);
out(`| retry contingency under throttle (×${RETRY_FACTOR}) | included |`);
out(`| **grand total** | **~${grand.toLocaleString('en-US')}** |`);
out('');
out(`Against the free plan's 25K requests/month (sourced October 2026 — RE-VERIFY the pricing page at live-run`);
out(`time): ~${grand.toLocaleString('en-US')} HTTP requests fit, but if billable operations meter closer to the`);
out(`~${Math.round(opsTotal).toLocaleString('en-US')} estimated server-side ops, the budget does NOT fit one free backend —`);
out('that is exactly why the granularity probe is the FIRST live step, and why M5 runs on a throwaway backend.');
out('');
out('Session count: each suite file signs up its own personas (fresh sessions per run, run-prefixed); no');
out('session is reused across suites, and testCleanup deletes the run\'s users and sessions afterwards.');

writeFileSync(path.join(ROOT, 'docs', 'notes', 'request-budget.md'), lines.join('\n') + '\n');
console.log(`\n→ docs/notes/request-budget.md`);
