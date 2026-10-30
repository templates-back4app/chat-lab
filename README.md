# chat-lab

Companion lab for the Back4app blog post *Build a Chat with Parse LiveQuery: Delivery, Reconnects, and
Permissions* (Phase A — the article is not written yet; the headline numbers come from what this lab measures
on the live backend). Two fictitious companies, **ACME** and **Borealis**, chat in private rooms on one Parse
backend; rooms are ACL-scoped channels, and one rule holds: only the room can listen. Every "who can listen"
attack is a raw REST request or a raw LiveQuery WebSocket frame — no SDK, only what a browser holds (App ID,
REST/JS key, a session token) — and every outcome is recorded with its HTTP status, Parse code, response body,
the database state read back afterwards and, for subscriptions, the exact frames received.

Built by Back4app Engineering · MIT. Local-only for now: nothing here has run against a live backend yet, and
the evidence files say so in their first paragraph.

## What it shows

One backend, five layers, each with ONE responsibility (they compose; none is claimed to hold alone):

| Layer | Responsibility | Where |
|---|---|---|
| Class-level permissions | no anonymous reads; **no client writes at all** — every create/update/delete goes through Cloud functions | `cloud/config.js` SCHEMA |
| Row ACLs | which signed-in users see a row: the room's member role reads `Room`/`Message`; a `RoomMembership` row is read by its user + the room's moderators; `_Role` is read by nobody | set by the hooks, never by clients |
| Roles per room | `room_<id>_member` **contains** `room_<id>_moderator`, so moderators inherit member read and members inherit nothing | created by `createRoom` |
| Cloud functions + hooks | the single write path; every function declares its guard in a `GUARDS` table (the server refuses to start otherwise — administrative functions included), and `beforeSave`/`beforeDelete` hooks re-validate **even master-key writes**: `room`/`author` immutable, the author must be an active member at write time, bodies length-capped, soft deletes terminal, ACLs recomputed server-side | `cloud/main.js`, `cloud/guards.js` |
| LiveQuery | clients subscribe to `Message` with their session token. Whether the server filters events per subscriber by ACL is **hypothesis H1, tested (T3), never assumed** — it is the load-bearing security property of the whole design | `scripts/dev-server.mjs` locally; dashboard-enabled live |

The matrix (`docs/evidence/subscription-matrix-local-<date>.md`): positive controls per persona (P1–P3),
anonymous REST + LiveQuery (T1), non-member probes (T2), the load-bearing non-member subscription row with and
without a query filter (T3/H1), direct REST writes (T4), forged inputs through the write path + master-key
hook probes (T5/T5m), soft-delete semantics on direct reads AND the live event (T6), the grant direction of
membership propagation (T7), revocation mechanics (T8), interleaved-sender ordering recorded (T9/H5), the
reconnect series (T10a–f), the deliberately unguarded `demoSendMessage` in both halves (T11), races (T12), and
the administrative gate in all three states (G1–G3).

## The reconnect algorithm the client ships (amendment B2)

`client/chat-client.mjs`: resubscribe → **await the subscription acknowledgment** → **buffer** incoming live
events → **paginated catch-up query** → **dedup by message objectId** → **reconcile** the buffer against the
catch-up. The catch-up is keyed on `(updatedAt, objectId)` — `updatedAt`, so a message soft-deleted while the
client was offline is caught up too; the `objectId` tie-break makes pagination exact when two messages share a
timestamp. The cursor is rewound by a 2 s overlap before each catch-up because events arrive in commit order,
which under concurrent writers is not updatedAt order — dedup absorbs the replays. Timestamp ordering does not
establish a total order of writes, and neither the client nor the article claims it does (H5).

## Soft deletes (amendment B3)

`deleteMessage` **overwrites the body server-side** (redacted from accessible storage — direct REST reads,
history pages and LiveQuery events all carry the redacted body from that moment) and keeps `deletedAt`/
`deletedBy`/`author` as moderation metadata. Deletion is terminal: the hook refuses any further change, master
key included. Open subscribers are told via the event LiveQuery emits on the redacting save (recorded in T6).
Bodies are stored verbatim as plain text; rendering is the client's job, and the shipped renderer
(`client/render.mjs`) escapes everything — asserted with a hostile-body fixture (T5/B3 rows).

## Repository layout

```
cloud/config.js        tunables, the schema (classes, CLPs, indexes), the SETUP gate and DEMO_UNGUARDED switches
cloud/guards.js        the guard registry: a Cloud function missing from the GUARDS table fails the deploy at load
cloud/main.js          12 Cloud functions (the single write path) + the beforeSave/beforeDelete second guard
client/chat-client.mjs the shipped chat client: raw LiveQuery protocol + the race-safe reconnect algorithm
client/render.mjs      the shipped renderer: escaped, never injected as markup (hostile fixture in the tests)
public/demo.html       two-pane local demo (feel the latency; drop & reconnect button exercises the client)
scripts/dev-server.mjs local parse-server ^7: Postgres on 5433 (db chat_dev/chat_test), LiveQuery for Message
scripts/setup.mjs      schema + CLPs: master key locally; the token-gated setupSchema on a live backend
scripts/measure-delivery.mjs    M0 contemporaneous baseline + M1 headline delivery latency + M4 readiness
scripts/measure-fanout.mjs      M2: 1/10/50 subscribers — latency, loss, duplicates, disconnects, spread
scripts/measure-reconnect.mjs   M3: controlled cut vs clean close, K missed messages, recovery timings
scripts/measure-revocation.mjs  T8: removeMember → first refused fresh read + LiveQuery drain, CSV per run
scripts/measure-throttle.mjs    M5: ramp past 16 req/s to the Parse-155 ceiling (throwaway backend, hard cap)
scripts/measure-history.mjs     M6: getMessages 50-row page at 1,000 and 10,000 messages (first + deep page)
scripts/request-budget.mjs      CC4: the request-budget inventory (HTTP measured/computed vs billable ops est.)
scripts/evidence.mjs   turns recorded rows into docs/evidence/subscription-matrix-<target>-<date>.md
scripts/lib/           env/target selection, raw REST client (throttle retry, token bucket), measurement shared lib
test/                  node:test suites (run with --test-concurrency=1), raw REST + raw ws frames, zz… run prefixes
docs/evidence/         generated evidence, labeled by target (local now; the live run adds its own dated files)
docs/notes/            build diary (decisions, findings, deviations, margins) + the computed request budget
```

## Run it locally

Prerequisites: Node 22+, PostgreSQL on port 5433 (`brew install postgresql@17`; the same instance tenant-lab
uses — chat-lab creates its own databases `chat_dev`/`chat_test`). No Back4app account, no `.env` needed — the
local server uses fixed throwaway keys (`scripts/lib/env.mjs`), and the local administrative gate uses a fixed
local token (not a secret: the server only listens on localhost).

```bash
npm install
npm test                       # 34 tests: starts its own parse-server per suite file (database chat_test),
                               # regenerates docs/evidence/subscription-matrix-local-<date>.md
npm run dev:server             # long-running server on http://localhost:1342/parse (database chat_dev),
                               # LiveQuery ws://localhost:1342/parse, demo page http://localhost:1342/demo.html
npm run measure:delivery -- --local      # M0+M1+M4 against the dev server (loopback numbers, labeled local)
npm run measure:fanout -- --local --subscribers 1,10,50
npm run measure:reconnect -- --local --runs 10 --gap 5000
npm run measure:revocation -- --local --runs 10
npm run measure:throttle -- --local      # mechanics only: the local server has no platform throttle
npm run measure:history -- --local --sizes 1000,10000
COUNT_REQUESTS=1 npm test && npm run budget   # regenerate docs/notes/request-budget.md from measured counts
```

The T11 demonstration (`demoSendMessage`, the function that forgets the membership check) only exists while
`DEMO_UNGUARDED=1` is set in the environment of a throwaway server; the suite proves both halves: 141
"Invalid function" by default, and the live leak + the guarded `sendMessage` refusing the same caller in a
separate flagged process. The administrative gate is proven in all three states: token wrong/missing (G1),
flag off (G2, the default deployment), flag on but no token configured (G3 — fails closed).

## Running against the live backend (the operator does this — nothing in this repo has)

The keys live in `.env.live` (gitignored): `APP_ID`, `JS_KEY`, `REST_KEY`, `SERVER_URL`, `SETUP_TOKEN` (the
raw administrative token) and later `LIVEQUERY_URL`. The master key is never needed: the schema, every state
read-back, the M6 seeding and the teardown go through the gated Cloud functions (`setupSchema`, `testInspect`,
`testSeedMessages`, `testCleanup`), which require `SETUP_ENABLED` **and** the token (amendment B5). Every run
stamps its own `zz…` prefix on all usernames and room names; `testCleanup` only ever deletes rooms carrying
that prefix and users younger than 2 h whose username starts with it.

1. **Generate the setup token** (never committed, never printed):
   `openssl rand -hex 24` → put the raw value in `.env.live` as `SETUP_TOKEN`; put its hash
   (`printf '%s' "<token>" | shasum -a 256`) in the Cloud Code environment as `SETUP_TOKEN_SHA256`, together
   with `SETUP_ENABLED=1` — via the dashboard's Cloud Code environment variables if the plan has them,
   otherwise by editing the two fallbacks at the top of `cloud/config.js` **before** uploading.
2. **Deploy Cloud Code** — upload `cloud/main.js`, `cloud/config.js` **and** `cloud/guards.js` (three files;
   `cloud/package.json` is not needed), confirm the badge "Files pending deploy (3)", Deploy. Prove it with a
   request, never with the dialog: `POST /functions/myRooms` with the REST key must answer `{"code":209,…}`;
   `141 Invalid function` means it did not ship (known first-deploy quirk: reload the editor, make each file
   dirty, confirm the badge, Deploy again).
3. **Billing granularity probe (CC4, FIRST live step)**: note Plan Usage, run
   `npm run measure:delivery -- --live --warmups 2 --runs 10 --m4-runs 0` (a known tiny workload), read the
   Plan Usage delta, and correct `docs/notes/request-budget.md` if operations meter differently than HTTP.
4. **Schema**: `npm run setup -- --live` (reads `.env.live`, calls `setupSchema`, prints the probe).
5. **Enable LiveQuery** for class `Message`: App Settings → Server Settings → Live Query → add `Message`;
   note the `wss://<subdomain>.b4a.io` URL into `.env.live` as `LIVEQUERY_URL`. Proof-by-event before any
   measurement: step 6's P1 does exactly that (subscribe, send through the function, see the event).
6. **The suite**: `TEST_SERVER_URL=https://parseapi.back4app.com LIVEQUERY_URL=wss://<subdomain>.b4a.io npm test`
   — regenerates `docs/evidence/subscription-matrix-back4app-<date>.md`. Parts needing the master key or SQL
   (hook-vs-master probes, forced equal timestamps, session deletion, the demo flag) skip with a printed
   reason; the local evidence file holds those rows.
7. **Measurements** (each deletes what it created; LIVEQUERY_URL required):
   ```bash
   npm run measure:delivery   -- --live                 # M0 baseline + M1 headline + M4 readiness
   npm run measure:fanout     -- --live --subscribers 1,10,50
   npm run measure:reconnect  -- --live --runs 10 --gap 5000
   npm run measure:revocation -- --live --runs 10       # B4: re-measured in THIS room model
   npm run measure:history    -- --live --sizes 1000,10000
   npm run measure:throttle   -- --live --max-requests 3000   # THROWAWAY backend only (155 punishes the app)
   ```
8. **Local-vs-live**: fill `docs/evidence/local-vs-live.md` from any suite rows or measurements that differ.
9. **Disable-and-verify (B5, before the backend outlives the campaign)**: set `SETUP_ENABLED=0` (or flip the
   `cloud/config.js` fallback and re-upload + Deploy), then verify the gate with a request:
   `setupSchema` must answer `{"code":"SETUP_DISABLED"}`. Rotate or delete the token from `.env.live`.

## Measurement honesty (what the numbers mean)

- **Clock protocol (B1):** sender and receiver run in one process on one machine, timestamps from one
  monotonic clock. The headline delivery latency **starts when the send request is initiated** and ends when
  the event arrives on the other, already-open connection. The REST-ack→event interval is a secondary,
  **signed** number — it goes negative when the event beats the ack (observed locally; reported, not hidden).
  The definition includes the sender's REST round trip up to the response; both clients share one uplink.
- **Baseline (CC1/M0):** every delivery number is read against a same-session `sendMessage` round-trip
  baseline from the same machine — never against another repo's or another day's figure.
- **Fan-out (B6/M2):** 50 subscribers from one machine is a tested configuration, not a ceiling; loss,
  duplicates, disconnects and the first→last spread are recorded alongside latency.
- Local numbers are loopback numbers; only the live run will be quoted in the article.

## Guarantees and limits (do not overstate them)

- Hooks are validation, **not database constraints**. Cross-record invariants are best effort under
  concurrency: duplicate `RoomMembership` rows from racing writes are self-healed on the next membership
  check; the last-moderator check can race; the Parse schema API cannot declare unique indexes (T12 records
  the observed outcomes).
- Revocation: fresh requests are refused when `removeMember` returns; an open LiveQuery subscription drains
  within the server's auth-cache window (~5–7 s locally; the live distribution is the B4 measurement); data
  already delivered is unrecoverable by definition.
- Soft deletion redacts **accessible storage** through the live API. Backups, platform logs and copies readers
  already made are out of scope, and the article says so.
- LiveQuery delivers **events, not state**: anything sent while the socket was down never replays on
  resubscribe (H3, measured) — the catch-up query is mandatory and the shipped client runs it. Arrival order
  is not a write order (H5): whatever T9/M-runs observe is reported, no ordering guarantee is claimed.
- No rate limiting is configured by this lab; M5 locates the platform's own throttle (Parse 155, not 429).

## License

MIT — see `LICENSE`.
