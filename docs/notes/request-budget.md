# Request-budget inventory (amendment CC4) — computed 2026-10-30

Computed from the real test inventory at Phase A, before any live run. HTTP requests and billable
platform operations are counted separately; a batch is never assumed to be one billable request. The
fan-out factors are estimates from reading cloud/main.js — **the first live step measures the actual
billing granularity** (Plan Usage delta after a known workload, e.g. one M0 block of 120 sends) and this
file is then corrected from that finding.

## Test suites (HTTP requests, MEASURED locally via COUNT_REQUESTS=1 npm test)

| suite | HTTP requests (measured) |
|---|---|
| demo-unguarded.test.mjs | 40 |
| livequery.test.mjs | 93 |
| matrix.test.mjs | 79 |
| positive.test.mjs | 54 |
| reconnect.test.mjs | 67 |
| revocation.test.mjs | 84 |
| setup-disabled.test.mjs | 22 |
| setup-tokenless.test.mjs | 18 |
| **total, one `npm test` run** | **457** |

Live-run adjustments: the three local-only suites/rows (SQL surgery, master probes, demo flag) SKIP on
live targets (fewer requests), while live mode adds setupSchema + testInspect state read-backs +
testCleanup per suite (~10–25 extra per suite). Budget the live suite at the measured local total.

## Measurement scripts (HTTP computed from their own default parameters; ops = estimated server-side fan-out)

| measurement | HTTP requests | server-side object ops (est., to verify live) | how computed |
|---|---|---|---|
| M0+M1+M4 measure-delivery | 350 | ~2,125 | world 4 + M0 20+100 + M1 20+100 + M4 5+100 + cleanup 1; plus 106 WebSocket connections (not HTTP) |
| M2 measure-fanout (1/10/50) | 463 | ~3,195 | world 102 (50 distinct member accounts) + 3×(20+100) sends + cleanup 1; plus 61 WebSocket connections |
| M3 measure-reconnect (2 modes × 10 runs) | 285 | ~1,555 | world 4 + 2×10 runs × (1 warm + K=10 + ~3 catch-up pages) + cleanup 1 |
| T8 measure-revocation (10 runs) | 301 | ~1,425 | 10 runs × ~30 (2 sign-ups, room, membership, warm sends, removeMember, refused-read polls ~3, drain probes ~12–20) + cleanup 1 — probe counts depend on the measured drain; 30/run is the budget ceiling |
| M5 measure-throttle (CAP — deliberately exceeds the polite rate; THROWAWAY backend) | 3000 | ~18,000 | hard cap --max-requests 3000: the ramp stops at the first Parse 155 or at the cap, whichever first (CC4's explicit M5 cap) |
| M6 measure-history (1,000 and 10,000 messages) | 555 | ~58,211 | world 2 + seeding 20 testSeedMessages calls (500/batch) + deep-cursor walk ~52 pages + 2 sizes × 2 page kinds × (20+100) timed reads + cleanup 1 · seeding is 20 HTTP calls but ~30000 server-side operations — the clearest case of HTTP ≠ billable (CC4) |
| **total** | **4954** | **~84,511** | |

## Phase A live-run total (what the plan meter must absorb)

| item | HTTP requests |
|---|---|
| live `npm test` run | ~457 |
| one independent README run (the agent test, §9) | ~457 |
| measurement scripts M0–M6 + T8 | 4954 |
| retry contingency under throttle (×1.15) | included |
| **grand total** | **~6,748** |

Against the free plan's 25K requests/month (sourced October 2026 — RE-VERIFY the pricing page at live-run
time): ~6,748 HTTP requests fit, but if billable operations meter closer to the
~84,511 estimated server-side ops, the budget does NOT fit one free backend —
that is exactly why the granularity probe is the FIRST live step, and why M5 runs on a throwaway backend.

Session count: each suite file signs up its own personas (fresh sessions per run, run-prefixed); no
session is reused across suites, and testCleanup deletes the run's users and sessions afterwards.
