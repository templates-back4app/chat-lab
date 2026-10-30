# Local vs. live — differences observed between the local parse-server and Back4app

**Status: live phase not run yet (Phase A is local-only).** This file is the designated place for every
difference between the local run (parse-server ^7, Postgres adapter, loopback) and the Back4app run (Parse
Server, MongoDB, managed LiveQuery at `wss://<subdomain>.b4a.io`). Only the live run is quoted in the article;
a local-vs-live difference is a finding, not a bug, and lands here with both values and dates.

## Expected differences to check (from the local run and sibling repos — verify, do not assume)

| Surface | Local observation (2026-10-30) | Live: to verify |
|---|---|---|
| CLP refusal codes | anonymous find/get on member-readable classes → HTTP 404, Parse 101 "Permission denied, user needs to be authenticated" | code pairs may differ on MongoDB/Back4app |
| Anonymous LiveQuery subscribe | `subscribed` acknowledged, zero events (event-time rejection), frames `connected,subscribed` | connect-time vs event-time rejection is a finding either way (T1) |
| LiveQuery event on soft delete | `op:update` carrying the redacted body (the row keeps matching the room filter) | update vs leave on the managed server (T6/B3) |
| Open-subscription auth propagation | grant (T7): first event ~4.9 s after addMember; revocation (T8): last event ~5.0 s, silent by ~6.6 s — the LiveQuery server's session/role cache (default cacheTimeout 5 s) | Back4app's cache configuration may differ; T8 is re-measured with 10 runs (B4), T7 recorded |
| Signed ack→event interval (B1) | consistently NEGATIVE on loopback (the event beats the REST ack by ~0.5–1 ms) | sign and magnitude on a real network path |
| Ordering (T9/H5) | 50/50 delivered; arrival order differed from (createdAt, objectId) order at 22 of 50 positions; 14 messages shared a createdAt millisecond | record the live distribution; no guarantee claimed either way |
| Equal timestamps | forced via SQL below the API (T10c, local-only); pagination exact with the (timestamp, objectId) cursor | not forceable live; natural collisions recorded by T9 |
| Throttle | none locally (M5 reports cap reached, zero 155s — mechanics only) | HTTP 400 / Parse 155 on the free plan (H6) |
| Index behaviour (M6) | first vs deep 50-row page at 1,000 and 10,000 messages, loopback | MongoDB + real plan; check the Index Manager after setupSchema |
| Billing granularity (CC4) | n/a locally | Plan Usage delta after a known workload — the FIRST live step |
