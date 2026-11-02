# M3 — reconnect gap and recovery (H3) — BACK4APP run

How we measured: the shipped client (client/chat-client.mjs: resubscribe → await ack → buffer → paginated
catch-up keyed on (updatedAt, objectId) → dedup by id → reconcile) against back4app; one process, one
monotonic clock; the socket was 5000 ms down while K=10 messages were sent through sendMessage at the
polite 16 req/s. One factor varied: how the connection ended (TCP cut without a close frame vs
clean unsubscribe+close).

Environment: target=back4app serverURL=https://parseapi.back4app.com node=v25.8.1 date=2026-11-02T12:45:44.167Z

### tcp-cut (10 runs, 5000 ms controlled gap, K=10 messages sent while down)

| run | events on the dead socket | buffered on resubscribe | recovered via catch-up | subscription ack ms | catch-up ms (pages) | total recovery ms | dedup ignored |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 10/10 | 2463 | 452 (1) | 2915 | 1 |
| 2 | 0 | 0 | 10/10 | 2388 | 414 (1) | 2802 | 1 |
| 3 | 0 | 0 | 10/10 | 2986 | 411 (1) | 3397 | 1 |
| 4 | 0 | 0 | 10/10 | 2402 | 401 (1) | 2804 | 1 |
| 5 | 0 | 0 | 10/10 | 2321 | 403 (1) | 2724 | 1 |
| 6 | 0 | 0 | 10/10 | 2610 | 482 (1) | 3092 | 1 |
| 7 | 0 | 0 | 10/10 | 2539 | 408 (1) | 2947 | 1 |
| 8 | 0 | 0 | 10/10 | 2280 | 402 (1) | 2681 | 1 |
| 9 | 0 | 0 | 10/10 | 2581 | 430 (1) | 3011 | 1 |
| 10 | 0 | 0 | 10/10 | 2538 | 411 (1) | 2950 | 1 |

- full recovery (K/K): **10/10 runs** · catch-up duration: n=10 p50=411.1 p95=482.1 min=401.3 max=482.1 ms · total recovery: n=10 p50=2915.2 p95=3396.9 min=2681.3 max=3396.9 ms
- live events replayed by the server for the gap: **zero in every run** — LiveQuery delivers events, not state (H3 supported in these runs); the catch-up query is mandatory and the shipped client runs it

### clean-close (10 runs, 5000 ms controlled gap, K=10 messages sent while down)

| run | events on the dead socket | buffered on resubscribe | recovered via catch-up | subscription ack ms | catch-up ms (pages) | total recovery ms | dedup ignored |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 10/10 | 2492 | 401 (1) | 2893 | 1 |
| 2 | 0 | 0 | 10/10 | 2330 | 407 (1) | 2737 | 1 |
| 3 | 0 | 0 | 10/10 | 2389 | 402 (1) | 2790 | 1 |
| 4 | 0 | 0 | 10/10 | 2331 | 410 (1) | 2741 | 1 |
| 5 | 0 | 0 | 10/10 | 2596 | 445 (1) | 3041 | 1 |
| 6 | 1 | 0 | 10/10 | 2403 | 514 (1) | 2917 | 2 |
| 7 | 0 | 0 | 10/10 | 2424 | 474 (1) | 2898 | 1 |
| 8 | 0 | 0 | 10/10 | 2624 | 441 (1) | 3066 | 1 |
| 9 | 0 | 0 | 10/10 | 2360 | 417 (1) | 2777 | 1 |
| 10 | 0 | 0 | 10/10 | 2637 | 416 (1) | 3053 | 1 |

- full recovery (K/K): **10/10 runs** · catch-up duration: n=10 p50=415.5 p95=513.7 min=401.2 max=513.7 ms · total recovery: n=10 p50=2893.1 p95=3065.7 min=2736.8 max=3065.7 ms
- live events replayed by the server for the gap: **zero in every run** — LiveQuery delivers events, not state (H3 supported in these runs); the catch-up query is mandatory and the shipped client runs it

