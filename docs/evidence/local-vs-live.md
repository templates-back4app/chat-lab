# Local vs live — where the runs differed (2026-11-02)

| What | Local (parse-server 7.5.4, Postgres, loopback) | Live (Back4app, Parse 7.5.2, MongoDB, USA East, Free) |
|---|---|---|
| Suite | 34/34 pass | 28 pass, 0 fail, 6 skipped (master-key/SQL-only rows; reasons printed, local file holds them) |
| M0 baseline (REST round-trip) | p50 8.2 ms | p50 403.6 / p95 475.3 ms (n=100) |
| M1 headline (send-start → event) | p50 7.8 / p95 9.8 ms | p50 404.6 / p95 507.6 ms (n=100, 0 lost, 0 dup) |
| Ack→event signed interval | negative in 99/100 | negative in 94/100 (median −1.3 ms) — the event usually beats the sender's own REST ack on both targets |
| Fan-out at 50 subscribers | spread p50 2.2 ms, 0 loss | spread p50 5.8 / p95 48.4 ms, 0 loss / 0 dup / 0 disconnect in 5,000 deliveries |
| Reconnect (10 runs) | recovered 10/10, zero server replay | recovered 10/10 via 1-page catch-up every run; catch-up 416–514 ms; resubscribe ack ~2.4–2.6 s dominates total (~2.8–3.1 s); dedup absorbed 1 overlap per run; 0 dead-socket deliveries |
| Revocation (10 runs, this room model) | fresh read refused ~2 ms; LQ last event median 4,581 ms | fresh read refused min 400 / median 412 / max 514 ms; LQ last event min 3,615 / median 4,445 / max 4,589 ms; silence confirmed ~7.7 s |
| History M6 | ANOMALY: first page (p50 16.5 ms) slower than deep page (10.4 ms) at 10k | did NOT reproduce: 10k first page p50 442.8, deep 418.9 ms — flat, backed by message_room_createdAt |
| Billing granularity (CC4 probe) | n/a | Plan Usage counter lags ≥ hours (still "58 requests" after thousands of calls the same day); HTTP-vs-billable delta unreadable same-day — re-read the dashboard a day later before correcting the budget |
