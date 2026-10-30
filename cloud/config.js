// File: cloud/config.js · CommonJS · Parse Server 7.x (Back4app runs Cloud Code on Node 19 — no Node 20+ only
// features here). Tunables, the schema definition and the switches, shared by cloud/main.js, the scripts and
// the tests. Upload this file together with main.js and guards.js.
'use strict';

// ---------------------------------------------------------------------------------------------------------
// Switches (amendment B5: the DEFAULT DEPLOYMENT disables the administrative helpers — both values ship
// unset, so a fresh upload answers SETUP_DISABLED until the operator deliberately turns them on)
// ---------------------------------------------------------------------------------------------------------

// Administrative helpers (setupSchema, testInspect, testCleanup, testSeedMessages in cloud/main.js). They run
// with the master key on behalf of a caller that holds (a) this flag turned on AND (b) the raw setup token
// whose SHA-256 hex is configured below — checked server-side on every call (amendment B5: a trusted
// administrative credential in addition to the flag). Turn on via the Cloud Code environment
// (SETUP_ENABLED=1), or edit the fallback after the `||` before uploading; turn OFF the same way when the
// live run is over, re-upload, Deploy, and verify: setupSchema must answer SETUP_DISABLED.
// Read PER CALL (a function, not a load-time constant): the gate always reflects the current environment, so
// no stale value can be cached from whatever module loaded this file first.
function setupEnabled() {
  return (process.env.SETUP_ENABLED || '0') === '1';
}

// SHA-256 hex of the raw setup token (generate one: `openssl rand -hex 24`, hash it:
// `printf '%s' "<token>" | shasum -a 256`). The raw token never lands in this repo or on the server — only
// its hash does, and callers pass the raw token as the `setupToken` parameter. Empty = no token configured =
// every administrative call refuses (SETUP_TOKEN_UNSET), even while SETUP_ENABLED is true.
function setupTokenSha256() {
  return (process.env.SETUP_TOKEN_SHA256 || '').toLowerCase();
}

// The deliberately vulnerable demonstration function (demoSendMessage, test T11 of the brief): a Cloud
// function that writes a Message with the master key and NO membership check, modeling the naive app that has
// neither the function guard nor the hook check. With DEMO_UNGUARDED=false (the default, and the only value
// that should ever be deployed) the function is NOT registered at all — calling it answers Parse 141
// "Invalid function" — and the Message hook never honours the demo bypass either. The local test suite
// enables it for one test file only, via the environment variable DEMO_UNGUARDED=1 in a throwaway process.
const DEMO_UNGUARDED = process.env.DEMO_UNGUARDED === '1';

// ---------------------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------------------

const NAME_MIN = 1;
const NAME_MAX = 80;                 // Room.name
const BODY_MIN = 1;
const BODY_MAX = 2000;               // Message.body length cap (characters), enforced by function AND hook
const PAGE_DEFAULT = 50;             // getMessages default page size
const PAGE_MAX = 200;                // getMessages hard cap per page
const SEED_BATCH_MAX = 500;          // testSeedMessages: messages created per call (M6 seeding; caller loops)
const DELETE_PAGE_SIZE = 200;        // rows deleted per query page in wipeRoom / testCleanup
const MEMBERSHIP_ROLES = ['moderator', 'member'];

// Soft delete (amendment B3, "redacted from accessible storage"): deleteMessage overwrites the body with this
// value server-side — the original text is gone from every read path, REST and LiveQuery alike — and keeps
// `deleted`, `deletedAt`, `deletedBy` as moderation metadata. The author pointer is retained too (moderation
// needs to know whose message was removed).
const REDACTED_BODY = '';

// Role names carry the room's objectId, never user-identifying text.
function roleName(roomId, which) {
  return 'room_' + roomId + '_' + which;
}

// ---------------------------------------------------------------------------------------------------------
// Schema: fields, class-level permissions, indexes. One definition for the local parse-server (Postgres)
// and for Back4app (MongoDB), applied by scripts/setup.mjs (master key) or the Cloud function setupSchema.
//
// The write path is ONE: every create/update/delete of chat data goes through the Cloud functions in main.js.
// The CLPs below therefore deny every client write; clients only read, through a session plus the row ACL.
// What each layer is responsible for:
//   - CLP:      no anonymous reads, no client writes at all (even before any ACL or hook is consulted).
//   - row ACL:  which signed-in users see a row — read via the room's member role (Room, Message), or
//               owner + moderator role (RoomMembership). It never grants client writes.
//   - roles:    room_<id>_member CONTAINS room_<id>_moderator, so moderators inherit member read and members
//               inherit nothing (Parse grants a containing role's permissions to the roles it contains).
//   - hooks:    second guard behind the functions — they validate even master-key writes (room/author
//               immutable, author must be an active member at write time, body cap, ACL recomputed
//               server-side). See cloud/main.js section "Hooks".
//   - functions:the only write path; each one declares its guard in the GUARDS table (cloud/main.js) and the
//               server refuses to start if a function is registered without one — administrative functions
//               included (amendment B5).
//   - LiveQuery: clients subscribe to Message filtered by room. Whether the server filters events by ACL per
//               subscriber is hypothesis H1 — tested (T3), never assumed.
// ---------------------------------------------------------------------------------------------------------

const CLP_MASTER_ONLY = {};                              // nobody but the master key
const CLP_AUTHENTICATED = { requiresAuthentication: true };
const pointerTo = function (targetClass) { return { type: 'Pointer', targetClass: targetClass }; };

// Readable classes: a session is required, then the row ACL decides. All writes are master-only.
function readableByMembers(extra) {
  return Object.assign({
    find: CLP_AUTHENTICATED, get: CLP_AUTHENTICATED, count: CLP_AUTHENTICATED,
    create: CLP_MASTER_ONLY, update: CLP_MASTER_ONLY, delete: CLP_MASTER_ONLY, addField: CLP_MASTER_ONLY,
  }, extra || {});
}

const CLP_ALL_MASTER = {
  find: CLP_MASTER_ONLY, get: CLP_MASTER_ONLY, count: CLP_MASTER_ONLY,
  create: CLP_MASTER_ONLY, update: CLP_MASTER_ONLY, delete: CLP_MASTER_ONLY, addField: CLP_MASTER_ONLY,
};

const SCHEMA = [
  {
    className: 'Room',
    why: 'one row per room; row ACL read = member role, so only members ever see it. Rooms are ACL-scoped channels.',
    fields: {
      name: { type: 'String' },
      createdBy: pointerTo('_User'),
      memberRole: pointerTo('_Role'),
      moderatorRole: pointerTo('_Role'),
      status: { type: 'String' }, // 'active' | 'deleting' (deleting only during testCleanup sweeps)
    },
    classLevelPermissions: readableByMembers(),
    indexes: { room_status: { status: 1 } },
  },
  {
    className: 'RoomMembership',
    why: 'one row per user × room; the source of truth the function guard checks. Row ACL: the user + the room moderator role (moderators list members, a member sees only their own row).',
    fields: {
      user: pointerTo('_User'),
      room: pointerTo('Room'),
      role: { type: 'String' },   // 'moderator' | 'member'
      status: { type: 'String' }, // 'active' | 'removed'
    },
    classLevelPermissions: readableByMembers(),
    indexes: {
      membership_user_room: { user: 1, room: 1 },
      membership_room: { room: 1 },
    },
  },
  {
    className: 'Message',
    why: 'one row per message. room and author are immutable after create; body is length-capped; soft delete redacts body server-side and keeps deletedBy/deletedAt for moderation. The history index (room, createdAt) backs M6 pagination; the catch-up index (room, updatedAt) backs the reconnect query — keyed on updatedAt so a redaction that happened while a client was offline is caught up too.',
    fields: {
      room: pointerTo('Room'),
      author: pointerTo('_User'),
      body: { type: 'String' },
      deleted: { type: 'Boolean' },
      deletedAt: { type: 'Date' },
      deletedBy: pointerTo('_User'),
    },
    classLevelPermissions: readableByMembers(),
    indexes: {
      message_room_createdAt: { room: 1, createdAt: 1 },
      message_room_updatedAt: { room: 1, updatedAt: 1 },
    },
  },
];

// _Role gets a master-only CLP too (applied by setup): role membership is managed by Cloud Code alone, and
// clients have no reason to read role rows. Role resolution for ACL checks happens server-side and is not
// affected by the CLP.
const ROLE_CLP = CLP_ALL_MASTER;

module.exports = {
  // Lazy getters: see setupEnabled()/setupTokenSha256() above. DEMO_UNGUARDED stays load-time on purpose —
  // it decides whether demoSendMessage is REGISTERED at all, which only happens while Cloud Code loads.
  get SETUP_ENABLED() { return setupEnabled(); },
  get SETUP_TOKEN_SHA256() { return setupTokenSha256(); },
  DEMO_UNGUARDED: DEMO_UNGUARDED,
  NAME_MIN: NAME_MIN,
  NAME_MAX: NAME_MAX,
  BODY_MIN: BODY_MIN,
  BODY_MAX: BODY_MAX,
  PAGE_DEFAULT: PAGE_DEFAULT,
  PAGE_MAX: PAGE_MAX,
  SEED_BATCH_MAX: SEED_BATCH_MAX,
  DELETE_PAGE_SIZE: DELETE_PAGE_SIZE,
  MEMBERSHIP_ROLES: MEMBERSHIP_ROLES,
  REDACTED_BODY: REDACTED_BODY,
  roleName: roleName,
  SCHEMA: SCHEMA,
  ROLE_CLP: ROLE_CLP,
};
