# M5 — throttle ceiling (H6) — LOCAL run

How we measured: sendMessage through the single write path at a ramped target rate (16, 24, 32, 48, 64, 96 req/s,
10 s per step, one sender, hard cap 1500 requests from the request-budget inventory),
no retries — the first HTTP 400 with Parse code 155 ends the ramp. Latency per request on one monotonic clock.

Environment: target=local serverURL=http://localhost:1342/parse node=v25.8.1 date=2026-10-30T14:28:03.388Z

| target req/s | achieved req/s | sent | ok | throttled (155) | other errors | latency p50 ms | latency p95 ms |
|---|---|---|---|---|---|---|---|
| 16 | 16.1 | 161 | 161 | 0 | 0 | 8.1 | 10.1 |
| 24 | 24.1 | 241 | 241 | 0 | 0 | 8.2 | 10.3 |
| 32 | 32.1 | 321 | 321 | 0 | 0 | 7.5 | 9.4 |
| 48 | 48.1 | 481 | 481 | 0 | 0 | 6.5 | 8.6 |
| 64 | 64.1 | 296 | 296 | 0 | 0 | 4.5 | 7.3 |

Result: **no throttle observed** within the 1500-request cap — expected: the local parse-server configures no platform throttle (this run proves the ramp mechanics only; the live number is the measurement). The achieved-rate column shows where the single sequential sender became latency-bound instead.

Total requests spent: 1500 of the 1500 cap.
