# Build diary — chat-lab

## 2026-10-30 — Phase A built and green locally (34 tests, 0 skipped, 0 failed)

Built against the amended brief (`brief-livequery-realtime-chat-blog-post-v1.md` + amendments 2026-10-30,
amendments win). Local only: parse-server ^7 (installed 7.5.x), Postgres 17 on :5433 (databases `chat_dev` /
`chat_test` — tenant-lab keeps 1341/its own databases; chat-lab runs on **1342**, LiveQuery on the same HTTP
server at `ws://localhost:1342/parse`), Node 25 (engines >=22). **No Back4app backend was touched; no network
call left this machine.**

### Decisions

- **Room model** per brief §4.2: `Room`, `RoomMembership`, `Message`; roles `room_<id>_member` **contains**
  `room_<id>_moderator`. One write path (12 Cloud functions), CLPs close every client write, hooks re-validate
  under the master key: `room`/`author` immutable, **author must be an active member of the room at write
  time** (the hook-level form of "a message's room must match the sender's active membership"), body
  length-capped, ACL recomputed. Membership managed by moderators via `addMember`/`removeMember` — invite
  tokens are out of scope per brief §3 (tenant-lab already built and tested them).
- **Reconnect algorithm (B2), shipped and tested**: `client/chat-client.mjs` implements exactly
  resubscribe → await ack → buffer → paginated catch-up → dedup by objectId → reconcile. Two design points on
  top of the amendment's wording, both justified by its own matrix rows:
  1. the **catch-up cursor is keyed on `(updatedAt, objectId)`, not `createdAt`** — a message soft-deleted
     while the client was offline has an old createdAt but a fresh updatedAt; a createdAt cursor would
     *provably* miss the redaction (T10d is the test that forced this choice);
  2. the cursor is **rewound by a 2 s overlap** before each catch-up, because events arrive in commit order
     and commit order is not updatedAt order under concurrent writers (H5); dedup absorbs the replayed
     overlap (visible as `dedup ignored ≥ 1` in every M3 run — expected, counted, not hidden).
- **Soft delete (B3), accepted default implemented**: `deleteMessage` overwrites `body` server-side
  (redacted from accessible storage), keeps `deletedAt`/`deletedBy`/`author` as moderation metadata, and the
  hook makes deletion **terminal** (no edit, no un-delete, master key included). Messages have no edit feature
  at all — the hook admits exactly one update transition (the redaction), which is what makes "redacted from
  accessible storage" a provable claim instead of a UI promise. Both read paths asserted: direct REST read and
  the LiveQuery event (locally the event is `op:update` carrying the redacted body — recorded per B3).
- **Administrative gate (B5)**: `setupSchema`/`testInspect`/`testCleanup`/`testSeedMessages` all declare the
  `setup` guard in the GUARDS registry (a missing entry fails the deploy at load — R-series proves the
  mechanism, G-series the behaviour). The guard checks `SETUP_ENABLED` **and** a raw `setupToken` parameter
  whose SHA-256 must equal the server-configured `SETUP_TOKEN_SHA256` (constant-time compare). **The default
  deployment ships with both unset** → `SETUP_DISABLED`; flag on without a hash → `SETUP_TOKEN_UNSET` (fails
  closed, G3). The two switches are read per call (lazy), so a dashboard env-var change applies without
  re-upload; `DEMO_UNGUARDED` stays load-time because it gates function *registration*.
- **T11 demo**: `demoSendMessage` models the naive app with NEITHER guard layer, so it asks the Message hook
  to stand down via save-context — honoured **only** while `DEMO_UNGUARDED=1`. The test shows all three
  stances: the real leak (outsider's message delivered live to a member's subscription), the guarded
  `sendMessage` refusing the same caller, and the hook alone blocking a context-less master write. Default
  deploy: Parse 141, proven in the matrix suite.
- **testSeedMessages** (not in the brief's function list — added, justification CC4): M6 needs 10,000
  messages; one HTTP request per message would be ~11,000 requests of budget for seeding alone. The gated
  batch function makes it ~23 HTTP calls while the request-budget inventory counts the ~30,000 per-object
  server-side writes as billable operations anyway (a batch is never assumed to be one billable request). It
  is run-prefix-scoped (target room's name must carry the zz… prefix) and goes through the same hooks.
- **Clock protocol (B1)** encoded in `scripts/lib/measure.mjs` + `measure-delivery.mjs`: headline = send
  request **started** → event received, one process, one `performance.now()` clock; REST-ack→event recorded as
  a **signed** secondary per message; M0 contemporaneous baseline in the same session (CC1).

### Practical-equivalence margins (CC2 — defined NOW, before any live run)

| H | Hypothesis | Margin for "supported" | Below/over the margin |
|---|---|---|---|
| H1 | LiveQuery honours ACLs | 0 events on the non-member subscription (filtered AND unfiltered) across ≥3 messages while a same-run member control delivers them | **any** single foreign event ⇒ rejected; control not delivering ⇒ inconclusive (re-run) |
| H2 | "real time" has a tail | a tail "exists" if live p95 − p50 > max(50 ms, 0.5 × p50) over the 100 timed M1 runs | smaller gap ⇒ "no meaningful tail observed in these runs" — reported, not spun |
| H3 | missed messages are not replayed | 0 of the K×runs offline messages arrive as live events on resubscribe, in every M3 run (buffered-on-resubscribe counts only mid-recovery sends) | any replayed offline message ⇒ H3 rejected and the catch-up design re-argued from the data |
| H4 | membership changes propagate on a delay to OPEN subscriptions | a "delay" exists if the open-subscription median (grant T7 / revocation T8, 10 runs) exceeds the fresh-request median by > 1 s | both under 1 s apart ⇒ inconclusive at this resolution (stated with M0's spread as the resolution floor) |
| H5 | arrival order ≠ createdAt order | supported if ≥ 1 inversion observed across the live T9 runs | 0 inversions ⇒ **inconclusive, never "ordered"** — absence of a counterexample is not a guarantee, and the article says so wherever ordering is discussed |
| H6 | the throttle, not the WebSocket, is the ceiling | supported if Parse 155 appears while M2-style delivery still shows 0 loss and per-subscriber p95 < 2× the same-session M0 p95 | delivery loss > 1% or p95 ≥ 2× baseline **before** any 155 ⇒ rejected (the socket gave out first) |

Detectability is stated from M0's measured spread of the same session (CC1), never from a prior date's number.

### Findings while running it locally (loopback numbers — labeled local, never quoted as the platform's)

- **The B1 signed interval went negative immediately**: on loopback the LiveQuery event beats the REST ack in
  99/100 M1 runs (ack→event p50 −0.6 ms). Exactly the finding the amendment anticipated — with the old
  "REST-ack→event" definition the headline latency would have been *negative*; with send-start→event it is
  well-defined (p50 7.8 ms, p95 9.8 ms locally). The live run will show whether a real network keeps the sign.
- **M0 baseline** (same session, no subscriber): p50 8.2 / p95 11.0 ms. M1 headline p50 7.8 / p95 9.8 ms —
  delivery to an open socket is *not slower* than the REST round trip itself on loopback.
- **M4 readiness**: subscribe ack p50 0.4 ms; send-right-after-ack → event p50 5.8 ms; **0 of 100 first
  messages lost** after the ack locally — the ack is an actionable "joined" signal here; live to confirm.
- **M2 fan-out** (1/10/50 subscribers, 100 msgs each): 0 loss, 0 duplicates, 0 disconnects at every rung;
  per-subscriber p50 7.4 → 7.8 → 9.5 ms; first→last spread p50 0.0 → 0.4 → 2.2 ms (max 12.4 ms at 50).
  50 subscribers is a tested configuration on one machine, not a ceiling (B6).
- **M3 reconnect**: 20/20 runs (TCP cut and clean close) recovered K=10/10 via catch-up, **zero replay by the
  server in every run** (H3 supported locally), catch-up 6–8 ms, total recovery p50 ~10 ms. The `dedup
  ignored 1` per run is the 2 s overlap re-reading the warm message — the overlap working as designed.
- **T8 revocation (room model, 10 runs)**: fresh read refused min 1 / median 2 / max 4 ms after `removeMember`
  returned; open subscription last event min 4568 / median 4581 / max 4598 ms, silence confirmed by ~7.6 s —
  the LiveQuery server's session/role cache (default `cacheTimeout` 5 s). Same mechanism tenant-lab saw
  (2026-10-29: ~3.4–4.0 s drain); chat-lab's own live distribution replaces, never inherits, that figure (B4).
- **T7 grant direction (H4's mirror)**: a subscription opened *before* membership stayed silent, and after
  `addMember` the *open* subscription started delivering ~4.9 s later (same cache); a *fresh* subscription
  delivered immediately. Grant and revocation are symmetric around the auth cache locally.
- **T9 ordering (H5)**: 50 concurrent-pair messages: 50/50 delivered, 0 dups, 0 leaks; arrival order differed
  from (createdAt, objectId) order at 22/50 positions and 14 messages shared a createdAt millisecond — H5 has
  local support; equal timestamps are *common* under concurrent senders, which is why the tuple cursor exists.
- **M5 throttle**: no 155 locally through 64 req/s up to the 1,500-request cap (expected: no platform throttle
  configured locally — mechanics proof only; the ladder achieved its target rates, so the ramp code is sound).
- **M6 history**: at 1,000 messages first/deep 50-row page p50 6.1/7.0 ms; at 10,000 p50 16.5/10.4 ms. The
  *first* page got slower with room size than the deep cursor page — unexpected (descending no-cursor query vs
  the $or cursor query planning differently on Postgres); recorded as a question for the live/MongoDB run.
- **Anonymous LiveQuery (T1)**: connect + subscribe are *acknowledged* without a session; rejection is at
  event time (zero deliveries, frames `connected,subscribed`). A silent "subscribed" is NOT authorization —
  article material.
- **T3 (H1 load-bearing)**: outsider subscriptions, filtered and unfiltered, received zero events while
  members chatted; the member's own unfiltered subscription received only their rooms' events. H1 supported
  locally; the live run is the claim the article leads with.
- **Engineering traps found and fixed during the build**:
  - `http.close()` never resolves while a test's abandoned WebSocket is open → suite teardown deadlocked;
    fixed with `closeAllConnections()` in the dev server's close path (and the failed-reconnect test now
    drops its socket in a `finally`).
  - Module-load order froze the setup gate: `cloud/config.js` was required (via the schema import) *before*
    the dev server set its env defaults, so a load-time constant cached `SETUP_ENABLED=false`; the two gate
    switches are now read per call.
  - An un-handled late `ws` 'error' event can crash the whole test process — both the helper and the shipped
    client attach persistent error handlers after the open handshake.
  - Node's test runner buffers a hung file silently; the deadlock above looked like "no output" — diagnosis
    went through a standalone repro script, worth remembering.
- **Equal timestamps forced below the API**: Postgres `UPDATE "Message" SET "createdAt"=…,"updatedAt"=…`
  (house pattern from tenant-lab's T5) put three messages in one millisecond; catch-up with pageSize 2 crossed
  the group exactly once (T10c). Live runs cannot force this; T9 records natural collisions instead.
- **Token expiry (T10e)**: after deleting the victim's sessions, reconnection failed at the REST catch-up with
  Parse 209 — the LiveQuery resubscribe itself was *acknowledged* with the dead token locally (the LQ server
  did not reject it); the client surfaces the failure and never fires `recovered`. Live behaviour to record.

### Request budget (CC4 — computed from the real inventory; full table in `request-budget.md`)

- Test suites, **measured** (`COUNT_REQUESTS=1 npm test`, in-process server counted every HTTP request):
  demo-unguarded 40 · livequery 93 · matrix 79 · positive 54 · reconnect 67 · revocation 84 · setup-disabled
  22 · setup-tokenless 18 → **457 HTTP requests per full suite run**.
- Measurement scripts, computed from their own default parameters: delivery 350 · fan-out 463 · reconnect 285
  · revocation 301 · throttle **3,000 (the explicit M5 cap)** · history 555 → **4,954**.
- Phase A live grand total ≈ **6,750 HTTP requests** (suite + one independent README run + measurements,
  ×1.15 retry contingency) — fits the free plan's 25K/month *if* billing meters HTTP requests. The estimated
  **server-side object operations are ~84,500** (M6's seeding alone is 20 HTTP calls but ~30,000 writes), so
  **the first live step is the billing-granularity probe** (Plan Usage delta after a known workload), and the
  budget file is corrected from that finding before anything else runs.
- The ~3.5-day effort estimate from the brief's §10 stands unchanged by the inventory: the two B-additions
  (reconnect algorithm, revocation re-measurement) are built and rehearsed, so the live phase is execution,
  not construction — roughly: granularity probe + deploy + suite 0.5 day, measurements 0.5–1 day (M2/M3
  babysitting), evidence + local-vs-live 0.5 day.

### Deviations from the brief (each against the amendments)

1. **Catch-up keyed on updatedAt** (brief §6 says "the recovery query closes the gap" without a key): required
   by B2's own "deletions while offline" row — a createdAt catch-up cannot see redactions. T10d proves it.
2. **`testSeedMessages` added** to the function surface: CC4 (budget) forced it; B5 (registry + token) covers
   it; the hooks validate every seeded object. Alternative (11,000 HTTP sends) would burn half the M5 cap.
3. **`demoSendMessage` uses a context bypass** so the demo leaks despite the hooks: the brief's T11 expects a
   leak; with both guard layers active the "leak" would silently become a refusal and demonstrate nothing.
   The flag gates both the registration AND the hook's stand-down; the default-deploy half (141) is tested.
4. **deleteMessage policy made explicit** (brief T6 "per policy"): author may delete own, moderator anyone's,
   peers refused (NOT_ALLOWED), non-members get 101 (no existence oracle).
5. **No message editing at all**, enforced by hook: hardens B3's "redacted from accessible storage" into an
   invariant (the only legal update is the redaction). The article can state it as a design choice.
6. **`addMember` takes an existing userId** (no invite tokens): brief §3 scopes invites out; tenant-lab owns
   that machinery and the posts cross-link.
7. **M5's live cap set at 3,000 requests** from the inventory (CC4 asks for an explicit cap; the number keeps
   suite + measurements + two throttle attempts under ~50% of the free-plan month).
8. **Presence**: not built, per B6 (closed as cut-to-future-work). Nothing in the lab pretends otherwise.

### Open questions for the coordinator (live phase)

1. **Back4app Cloud Code env vars**: does the dashboard expose environment variables for Cloud Code
   (`SETUP_ENABLED`, `SETUP_TOKEN_SHA256`)? If not, the fallbacks at the top of `cloud/config.js` must be
   edited before upload (the README documents both paths) — and the disable-and-verify step is then an
   edit + re-upload + Deploy + probe.
2. **Billing granularity** (CC4): run the probe first; if operations (not HTTP requests) are metered, M6's
   10,000-message seeding (~30k writes) may need a smaller size ladder or a paid plan — decide before M6.
3. **LiveQuery connection allowance** on the free plan is still **to source** from the pricing page before M2
   (brief §0 decision 4): 50 concurrent subscriptions may hit a plan limit — the script stops and reports the
   tested maximum if connections start failing.
4. **T10e live**: is there a way to force session expiry on Back4app without the master key? If not, the row
   stays local-only (it is marked as such) and the article's token-expiry advice cites the local mechanism.
5. **The M6 first-page-slower-than-deep-page anomaly** (local Postgres): check whether MongoDB shows it too;
   if yes it becomes article material (query shape matters more than data volume), if no it is a
   local-vs-live row.

Next: hand back for the live phase. Nothing in this repo has been pushed anywhere, and no remote backend has
been contacted.
