# M3 — reconnect gap and recovery (H3) — LOCAL run

How we measured: the shipped client (client/chat-client.mjs: resubscribe → await ack → buffer → paginated
catch-up keyed on (updatedAt, objectId) → dedup by id → reconcile) against local; one process, one
monotonic clock; the socket was 5000 ms down while K=10 messages were sent through sendMessage at the
polite 16 req/s. One factor varied: how the connection ended (TCP cut without a close frame vs
clean unsubscribe+close).

Environment: target=local serverURL=http://localhost:1342/parse node=v25.8.1 date=2026-10-30T14:26:00.532Z

### tcp-cut (10 runs, 5000 ms controlled gap, K=10 messages sent while down)

| run | events on the dead socket | buffered on resubscribe | recovered via catch-up | subscription ack ms | catch-up ms (pages) | total recovery ms | dedup ignored |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 10/10 | 4 | 8 (1) | 12 | 1 |
| 2 | 0 | 0 | 10/10 | 5 | 7 (1) | 12 | 1 |
| 3 | 0 | 0 | 10/10 | 5 | 8 (1) | 12 | 1 |
| 4 | 0 | 0 | 10/10 | 2 | 6 (1) | 8 | 1 |
| 5 | 0 | 0 | 10/10 | 5 | 6 (1) | 11 | 1 |
| 6 | 0 | 0 | 10/10 | 3 | 7 (1) | 10 | 1 |
| 7 | 0 | 0 | 10/10 | 3 | 7 (1) | 10 | 1 |
| 8 | 0 | 0 | 10/10 | 4 | 7 (1) | 10 | 1 |
| 9 | 0 | 0 | 10/10 | 7 | 6 (1) | 13 | 1 |
| 10 | 0 | 0 | 10/10 | 5 | 8 (1) | 13 | 1 |

- full recovery (K/K): **10/10 runs** · catch-up duration: n=10 p50=6.8 p95=8.5 min=6.0 max=8.5 ms · total recovery: n=10 p50=10.5 p95=13.2 min=8.2 max=13.2 ms
- live events replayed by the server for the gap: **zero in every run** — LiveQuery delivers events, not state (H3 supported in these runs); the catch-up query is mandatory and the shipped client runs it

### clean-close (10 runs, 5000 ms controlled gap, K=10 messages sent while down)

| run | events on the dead socket | buffered on resubscribe | recovered via catch-up | subscription ack ms | catch-up ms (pages) | total recovery ms | dedup ignored |
|---|---|---|---|---|---|---|---|
| 1 | 0 | 0 | 10/10 | 4 | 7 (1) | 11 | 1 |
| 2 | 0 | 0 | 10/10 | 4 | 7 (1) | 11 | 1 |
| 3 | 0 | 0 | 10/10 | 6 | 8 (1) | 13 | 1 |
| 4 | 0 | 0 | 10/10 | 4 | 8 (1) | 12 | 1 |
| 5 | 0 | 0 | 10/10 | 3 | 6 (1) | 9 | 1 |
| 6 | 0 | 0 | 10/10 | 6 | 6 (1) | 12 | 1 |
| 7 | 0 | 0 | 10/10 | 2 | 6 (1) | 8 | 1 |
| 8 | 0 | 0 | 10/10 | 2 | 6 (1) | 8 | 1 |
| 9 | 0 | 0 | 10/10 | 4 | 6 (1) | 10 | 1 |
| 10 | 0 | 0 | 10/10 | 3 | 7 (1) | 10 | 1 |

- full recovery (K/K): **10/10 runs** · catch-up duration: n=10 p50=6.3 p95=7.9 min=5.7 max=7.9 ms · total recovery: n=10 p50=10.3 p95=13.5 min=8.0 max=13.5 ms
- live events replayed by the server for the gap: **zero in every run** — LiveQuery delivers events, not state (H3 supported in these runs); the catch-up query is mandatory and the shipped client runs it

