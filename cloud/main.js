// File: cloud/main.js · CommonJS · Parse Server 7.x (Back4app runs Cloud Code on Node 19: no Node 20+ only features)
//
// ONE write path: every create/update/delete of chat data (Room, RoomMembership, Message, _Role membership)
// goes through the Cloud functions below, which run with the master key. Clients only read, through a session
// plus the row ACL, and subscribe to LiveQuery with their session token. The class-level permissions
// (cloud/config.js, applied by scripts/setup.mjs or setupSchema) close every client write before an ACL or
// hook is even consulted, and the hooks in the last section are the second guard: they validate even
// master-key writes, so a Cloud function that forgets a check cannot post into a foreign room or hand out a
// foreign ACL.
//
// Guards: every function is registered through `define` (cloud/guards.js), which refuses to start the server
// unless the function is listed in the GUARDS table below — administrative functions included (amendment B5).
// 'member'/'moderator' functions declare how to resolve their target room and the wrapper runs
// requireMembership before the handler ever sees the request. 'setup' functions require BOTH the
// SETUP_ENABLED flag and a server-checked administrative token (SHA-256 compared in constant time).
//
// Error convention (same as the sibling repos): functions throw Parse.Error with a numeric Parse code and a
// JSON string message {"code":"NOT_A_MEMBER","message":"…", …extra}. Parse.Error only carries (number,
// string), so the string is the envelope; scripts/lib/rest.mjs parseCloudError() unwraps it.
'use strict';

const crypto = require('crypto');
const config = require('./config.js');
const guards = require('./guards.js');

const MASTER = { useMasterKey: true };
const PE = Parse.Error;

// ---------------------------------------------------------------------------------------------------------
// 1. Helpers
// ---------------------------------------------------------------------------------------------------------

function fail(code, message, extra, parseCode) {
  const payload = Object.assign({ code: code, message: message }, extra || {});
  throw new PE(parseCode || PE.VALIDATION_ERROR, JSON.stringify(payload));
}

function requireUser(request) {
  if (!request.user) {
    fail('UNAUTHENTICATED', 'Sign in before calling this function.', null, PE.INVALID_SESSION_TOKEN);
  }
  return request.user;
}

function requireName(value, field) {
  if (typeof value !== 'string') fail('INVALID_ARGS', field + ' must be a string', { field: field });
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length < config.NAME_MIN || trimmed.length > config.NAME_MAX) {
    fail('INVALID_ARGS', field + ' must be ' + config.NAME_MIN + '..' + config.NAME_MAX + ' characters', { field: field });
  }
  return trimmed;
}

// Message bodies are kept VERBATIM (chat whitespace matters); only type and length are checked. Rendering/
// escaping is the client's job and the shipped client does it (client/render.mjs, asserted with a hostile
// fixture) — the server never interprets the body as markup.
function requireBody(value) {
  if (typeof value !== 'string') fail('INVALID_ARGS', 'body must be a string', { field: 'body' });
  if (value.length < config.BODY_MIN || value.length > config.BODY_MAX) {
    fail('BODY_LENGTH', 'body must be ' + config.BODY_MIN + '..' + config.BODY_MAX + ' characters', { field: 'body', length: value.length, max: config.BODY_MAX });
  }
  return value;
}

function requireId(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9]{8,32}$/.test(value)) {
    fail('INVALID_ARGS', field + ' must be an objectId', { field: field });
  }
  return value;
}

function requireRoleKind(value) {
  if (config.MEMBERSHIP_ROLES.indexOf(value) === -1) {
    fail('INVALID_ARGS', "role must be one of '" + config.MEMBERSHIP_ROLES.join("'/'") + "'", { field: 'role' });
  }
  return value;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function iso(d) {
  return d instanceof Date ? d.toISOString() : d || null;
}

function roomPointer(roomId) {
  const r = new Parse.Object('Room');
  r.id = roomId;
  return r;
}

function userPointer(userId) {
  const u = new Parse.Object('_User');
  u.id = userId;
  return u;
}

async function fetchById(className, objectId) {
  const q = new Parse.Query(className);
  q.equalTo('objectId', objectId);
  return q.first(MASTER); // undefined when missing — never throws 101 like .get()
}

// Active membership of `user` in `room`, or null. The RoomMembership row is the source of truth the write
// path trusts; the per-room roles only grant row READS (ACLs), so a half-granted role never widens the write
// path. Self-heals the duplicate rows concurrent writes can create (the Parse schema API cannot declare a
// unique index on {user, room}): active-before-removed, then oldest, wins; the rest are deleted. Best effort,
// same pattern and caveat as the sibling repos — see README "Guarantees and limits".
async function findMembership(userId, roomId, anyStatus) {
  const q = new Parse.Query('RoomMembership');
  q.equalTo('user', userPointer(userId));
  q.equalTo('room', roomPointer(roomId));
  if (!anyStatus) q.equalTo('status', 'active');
  q.ascending('createdAt');
  q.limit(5);
  const rows = await q.find(MASTER);
  if (rows.length > 1) {
    rows.sort(function (a, b) {
      const act = (a.get('status') === 'active' ? 0 : 1) - (b.get('status') === 'active' ? 0 : 1);
      return act !== 0 ? act : a.createdAt - b.createdAt;
    });
    await Parse.Object.destroyAll(rows.slice(1), MASTER);
  }
  return rows[0] || null;
}

// The guard helper every room-scoped function goes through (wired in by `define` below, never called ad hoc
// by a handler alone). role === 'moderator' additionally requires the membership's role to be moderator.
async function requireMembership(user, roomId, role) {
  const room = await fetchById('Room', roomId);
  if (!room) fail('NOT_A_MEMBER', 'No such room, or you are not an active member of it.', { roomId: roomId }, PE.OPERATION_FORBIDDEN);
  const membership = await findMembership(user.id, roomId);
  if (!membership) fail('NOT_A_MEMBER', 'No such room, or you are not an active member of it.', { roomId: roomId }, PE.OPERATION_FORBIDDEN);
  if (room.get('status') === 'deleting') {
    fail('ROOM_DELETING', 'This room is being deleted.', { roomId: roomId }, PE.OPERATION_FORBIDDEN);
  }
  if (role === 'moderator' && membership.get('role') !== 'moderator') {
    fail('MODERATOR_REQUIRED', 'Only a room moderator may do this.', { roomId: roomId }, PE.OPERATION_FORBIDDEN);
  }
  return { room: room, membership: membership };
}

async function findRole(name) {
  const q = new Parse.Query(Parse.Role);
  q.equalTo('name', name);
  return q.first(MASTER);
}

// Adds `user` to the room role for `roleKind`. Idempotent: Parse relations ignore duplicate adds.
async function addUserToRoomRole(user, roomId, roleKind) {
  const role = await findRole(config.roleName(roomId, roleKind));
  if (!role) fail('ROLE_MISSING', 'Role ' + config.roleName(roomId, roleKind) + ' does not exist.', { roomId: roomId }, PE.INTERNAL_SERVER_ERROR);
  role.getUsers().add(user);
  await role.save(null, MASTER);
}

async function removeUserFromRoomRoles(user, roomId) {
  for (const kind of config.MEMBERSHIP_ROLES) {
    const role = await findRole(config.roleName(roomId, kind));
    if (!role) continue; // a cleanup sweep may have removed it already
    role.getUsers().remove(user);
    await role.save(null, MASTER);
  }
}

async function userHasRoleEntry(userId, name) {
  const q = new Parse.Query(Parse.Role);
  q.equalTo('name', name);
  q.equalTo('users', userPointer(userId));
  return !!(await q.first(MASTER));
}

function membershipJson(membership, room) {
  return {
    roomId: room.id,
    name: room.get('name'),
    role: membership.get('role'),
    status: membership.get('status'),
    since: iso(membership.createdAt),
  };
}

function messageJson(m) {
  return {
    id: m.id,
    roomId: m.get('room') ? m.get('room').id : null,
    authorId: m.get('author') ? m.get('author').id : null,
    body: m.get('body'),
    deleted: m.get('deleted') === true,
    deletedAt: iso(m.get('deletedAt')),
    deletedById: m.get('deletedBy') ? m.get('deletedBy').id : null,
    createdAt: iso(m.createdAt),
    updatedAt: iso(m.updatedAt),
  };
}

// ---------------------------------------------------------------------------------------------------------
// 2. Guard registration: the GUARDS table and the `define` wrapper
// ---------------------------------------------------------------------------------------------------------
// Every Parse.Cloud.define in this file goes through `define(name, spec)`. cloud/guards.js refuses names that
// are missing from this table (the server throws while loading Cloud Code — a forgotten guard fails the
// deploy, not the room). For 'member'/'moderator' guards the spec must say how to find the target room:
//   spec.roomFrom: 'params'  → request.params.roomId names the room (the caller knows which room).
//   spec.target:   className → request.params.<idParam> names an object; its `room` pointer is the target,
//                              and refusals answer OBJECT_NOT_FOUND (101) whether the object is missing or
//                              belongs to a room the caller is no member of, so probing ids cannot
//                              distinguish "does not exist" from "not yours".

const GUARDS = {
  createRoom: 'authenticated',
  myRooms: 'authenticated',
  sendMessage: 'member',
  getMessages: 'member',
  deleteMessage: 'member',          // author-or-moderator policy enforced in the handler
  addMember: 'moderator',
  removeMember: 'moderator',
  setupSchema: 'setup',
  testInspect: 'setup',       // live test runs: master-key state read-backs without the master key leaving the dashboard
  testCleanup: 'setup',       // live test runs: delete ONLY what a suite run created (its run prefix, users < 2 h old)
  testSeedMessages: 'setup',  // M6 history seeding: N server-side messages per call instead of N HTTP requests
  demoSendMessage: 'demo-unguarded', // T11: only registered when config.DEMO_UNGUARDED (never in a default deploy)
};

const registry = guards.createRegistry(GUARDS, { demoEnabled: config.DEMO_UNGUARDED });

function define(name, spec) {
  registry.define(name, function (guard) {
    Parse.Cloud.define(name, async function (request) {
      if (guard === 'setup') {
        requireSetupEnabled();
        requireSetupToken(request);
        return spec.handler(request, {});
      }
      if (guard === 'demo-unguarded') {
        return spec.handler(request, {});
      }
      const user = requireUser(request);
      if (guard === 'authenticated') {
        return spec.handler(request, { user: user });
      }
      // 'member' / 'moderator'
      const ctx = { user: user };
      let roomId;
      if (spec.roomFrom === 'params') {
        roomId = requireId(request.params && request.params.roomId, 'roomId');
      } else {
        const idParam = spec.idParam;
        const objectId = requireId(request.params && request.params[idParam], idParam);
        const target = await fetchById(spec.target, objectId);
        if (!target || !target.get('room')) {
          fail('OBJECT_NOT_FOUND', 'Object not found.', { id: objectId }, PE.OBJECT_NOT_FOUND);
        }
        ctx[spec.targetAs || 'target'] = target;
        roomId = target.get('room').id;
      }
      try {
        const got = await requireMembership(user, roomId, guard === 'moderator' ? 'moderator' : undefined);
        ctx.room = got.room;
        ctx.membership = got.membership;
      } catch (e) {
        // Id-targeted functions hide the object's existence from non-members.
        if (spec.target && e instanceof PE) {
          let env = null;
          try { env = JSON.parse(e.message); } catch (_) { /* not an envelope */ }
          if (env && env.code === 'NOT_A_MEMBER') {
            fail('OBJECT_NOT_FOUND', 'Object not found.', { id: request.params[spec.idParam] }, PE.OBJECT_NOT_FOUND);
          }
        }
        throw e;
      }
      return spec.handler(request, ctx);
    });
  });
}

function requireSetupEnabled() {
  if (!config.SETUP_ENABLED) {
    fail('SETUP_DISABLED', 'Administrative helpers are disabled (SETUP_ENABLED is off).', null, PE.OPERATION_FORBIDDEN);
  }
}

// Amendment B5: the administrative credential, checked server-side on EVERY setup-guarded call, in addition
// to SETUP_ENABLED. The caller sends the raw token; only its SHA-256 is configured server-side. Constant-time
// comparison of the two digests; an unset hash refuses everything (the default deployment).
function requireSetupToken(request) {
  const supplied = request.params && request.params.setupToken;
  if (!config.SETUP_TOKEN_SHA256 || !/^[0-9a-f]{64}$/.test(config.SETUP_TOKEN_SHA256)) {
    fail('SETUP_TOKEN_UNSET', 'No administrative setup token is configured on this backend (SETUP_TOKEN_SHA256).', null, PE.OPERATION_FORBIDDEN);
  }
  if (typeof supplied !== 'string' || supplied.length < 16) {
    fail('SETUP_TOKEN_INVALID', 'This call requires the administrative setup token (parameter setupToken).', null, PE.OPERATION_FORBIDDEN);
  }
  const a = Buffer.from(sha256(supplied), 'hex');
  const b = Buffer.from(config.SETUP_TOKEN_SHA256, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    fail('SETUP_TOKEN_INVALID', 'This call requires the administrative setup token (parameter setupToken).', null, PE.OPERATION_FORBIDDEN);
  }
}

// ---------------------------------------------------------------------------------------------------------
// 3. Room lifecycle and membership
// ---------------------------------------------------------------------------------------------------------

// createRoom({name}) → {roomId, name, role:'moderator'}. Any signed-in user can open a room and becomes its
// first moderator. Write order (here and in addMember): Membership row first, then the role entry — the
// Membership row is what the function guard checks, so a crash in between leaves the user able to call
// functions but unable to READ rows (fail-closed); myRooms() reconciles the missing role entry from the
// Membership row on the user's next listing. The reverse order would leave readable rows with no governing
// membership, which has no safe reconciliation.
define('createRoom', {
  handler: async function (request, ctx) {
    const name = requireName(request.params && request.params.name, 'name');
    const user = ctx.user;

    const room = new Parse.Object('Room');
    room.set('name', name);
    room.set('status', 'active');
    room.set('createdBy', user);
    await room.save(null, MASTER); // ACL is recomputed by the hook on the update below, once the id exists

    // Roles: room_<id>_member CONTAINS room_<id>_moderator, so moderators inherit member read; members
    // inherit nothing. Role rows carry an empty ACL: master-key-only, like everything role-related.
    const moderatorRole = new Parse.Role(config.roleName(room.id, 'moderator'), new Parse.ACL());
    await moderatorRole.save(null, MASTER);
    const memberRole = new Parse.Role(config.roleName(room.id, 'member'), new Parse.ACL());
    memberRole.getRoles().add(moderatorRole);
    await memberRole.save(null, MASTER);

    room.set('memberRole', memberRole);
    room.set('moderatorRole', moderatorRole);
    await room.save(null, MASTER);

    const membership = new Parse.Object('RoomMembership');
    membership.set('user', user);
    membership.set('room', room);
    membership.set('role', 'moderator');
    membership.set('status', 'active');
    await membership.save(null, MASTER);

    await addUserToRoomRole(user, room.id, 'moderator');

    return { roomId: room.id, name: name, role: 'moderator' };
  },
});

// myRooms() → {rooms:[{roomId, name, role, status, since}]}. Also the reconciliation path for the
// half-granted case: for every active membership it checks the role entry the Membership row implies and
// re-adds it when missing (master-key write, scoped to the caller's own memberships).
define('myRooms', {
  handler: async function (request, ctx) {
    const q = new Parse.Query('RoomMembership');
    q.equalTo('user', ctx.user);
    q.equalTo('status', 'active');
    q.include('room');
    q.ascending('createdAt');
    q.limit(1000);
    const memberships = await q.find(MASTER);
    const out = [];
    let repaired = 0;
    for (const m of memberships) {
      const room = m.get('room');
      if (!room) continue; // room deleted mid-flight
      const kind = m.get('role') === 'moderator' ? 'moderator' : 'member';
      if (!(await userHasRoleEntry(ctx.user.id, config.roleName(room.id, kind)))) {
        await addUserToRoomRole(ctx.user, room.id, kind);
        repaired++;
      }
      out.push(membershipJson(m, room));
    }
    return { rooms: out, repairedRoleEntries: repaired };
  },
});

// addMember({roomId, userId, role?='member'}) → {roomId, userId, role}. Moderator only; membership is managed
// by moderators (invite tokens are out of scope — tenant-lab designed and tested them; this lab links it).
// Reactivates a removed membership, changes the role of an active one (promote/demote), creates it otherwise.
// Role entries follow the membership row (fail-closed order; see createRoom). T7 measures when an open
// subscription of the added user starts receiving — the mirror of revocation.
define('addMember', {
  roomFrom: 'params',
  handler: async function (request, ctx) {
    const userId = requireId(request.params.userId, 'userId');
    const roleKind = request.params.role === undefined ? 'member' : requireRoleKind(request.params.role);
    const target = await fetchById('_User', userId);
    if (!target) fail('USER_NOT_FOUND', 'No such user.', { userId: userId }, PE.OBJECT_NOT_FOUND);

    let membership = await findMembership(userId, ctx.room.id, true);
    const already = !!(membership && membership.get('status') === 'active' && membership.get('role') === roleKind);
    if (!membership) {
      membership = new Parse.Object('RoomMembership');
      membership.set('user', target);
      membership.set('room', ctx.room);
    }
    const previousRole = membership.get('role');
    membership.set('role', roleKind);
    membership.set('status', 'active');
    await membership.save(null, MASTER);
    if (previousRole && previousRole !== roleKind) {
      await removeUserFromRoomRoles(target, ctx.room.id); // demotions must drop the old entry
    }
    await addUserToRoomRole(target, ctx.room.id, roleKind);
    return { roomId: ctx.room.id, userId: userId, role: roleKind, already: already };
  },
});

// removeMember({roomId, userId}) → {removed:true}. Moderator only. Revocation model (amendment B4, defined
// BEFORE measuring): when this function returns, every FRESH request by the removed user against this room is
// refused — the RoomMembership row is 'removed' (function guard) and both role entries are gone (row reads).
// Open LiveQuery subscriptions are a measured delay, never claimed instant (measure-revocation.mjs, 10 runs);
// already-delivered messages are unrecoverable by definition — the window measures NEW delivery only.
// Order: Membership first (writes die), then roles (reads die). Retrying after a half-failure finishes the
// role cleanup ({alreadyRemoved:true}).
define('removeMember', {
  roomFrom: 'params',
  handler: async function (request, ctx) {
    const userId = requireId(request.params.userId, 'userId');
    const membership = await findMembership(userId, ctx.room.id, true);
    if (!membership) fail('MEMBER_NOT_FOUND', 'That user has no membership in this room.', { userId: userId }, PE.OBJECT_NOT_FOUND);
    const target = userPointer(userId);

    const alreadyRemoved = membership.get('status') === 'removed';
    if (!alreadyRemoved) {
      if (membership.get('role') === 'moderator') {
        // Best-effort last-moderator check: not safe under concurrent removals (no cross-row transaction
        // here); see README "Guarantees and limits".
        const moderators = new Parse.Query('RoomMembership');
        moderators.equalTo('room', ctx.room);
        moderators.equalTo('role', 'moderator');
        moderators.equalTo('status', 'active');
        if ((await moderators.count(MASTER)) <= 1) {
          fail('LAST_MODERATOR', 'This is the last moderator of the room.', null, PE.OPERATION_FORBIDDEN);
        }
      }
      membership.set('status', 'removed');
      await membership.save(null, MASTER);
    }
    await removeUserFromRoomRoles(target, ctx.room.id);
    return { removed: true, alreadyRemoved: alreadyRemoved };
  },
});

// ---------------------------------------------------------------------------------------------------------
// 4. Messages
// ---------------------------------------------------------------------------------------------------------

// sendMessage({roomId, body}) → message JSON (incl. createdAt/updatedAt, which the reconnect client uses as
// its cursor). The author is ALWAYS the caller — there is no author parameter, and a spoofed one is ignored
// by this handler and rejected by the hook (the second guard checks the author's active membership at write
// time even for master-key writes).
define('sendMessage', {
  roomFrom: 'params',
  handler: async function (request, ctx) {
    const body = requireBody(request.params.body);
    const message = new Parse.Object('Message');
    message.set('room', ctx.room);
    message.set('author', ctx.user);
    message.set('body', body);
    message.set('deleted', false);
    await message.save(null, MASTER); // the hook stamps the ACL (member-role read, no writes)
    return messageJson(message);
  },
});

// getMessages({roomId, limit?, before?, since?}) → {messages:[…], more}. Member only. Two modes, one index
// each (stated next to M6):
//   - history (default; optional `before` cursor): newest-first scrollback, keyed on (createdAt, objectId)
//     DESCENDING — index message_room_createdAt.
//   - catch-up (`since` cursor): oldest-first replay of everything that CHANGED after the cursor, keyed on
//     (updatedAt, objectId) ASCENDING — index message_room_updatedAt. updatedAt, not createdAt, on purpose:
//     a message that was soft-deleted while the client was offline has an old createdAt but a fresh
//     updatedAt, so the redaction is caught up too (amendment B2's "deletions while offline" row).
// Cursors are tuples {at: ISO date, id: objectId}; the objectId tie-break makes pagination exact under equal
// timestamps (two messages in the same millisecond — amendment B2) instead of skipping or repeating rows.
// Deleted messages are returned REDACTED (body already overwritten server-side), with the moderation fields.
define('getMessages', {
  roomFrom: 'params',
  handler: async function (request, ctx) {
    const p = request.params;
    const limit = p.limit === undefined ? config.PAGE_DEFAULT : p.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > config.PAGE_MAX) {
      fail('INVALID_ARGS', 'limit must be an integer in 1..' + config.PAGE_MAX, { field: 'limit' });
    }
    if (p.before !== undefined && p.since !== undefined) {
      fail('INVALID_ARGS', 'pass before (history) or since (catch-up), not both', { field: 'before' });
    }
    const cursor = function (raw, field) {
      if (!raw || typeof raw !== 'object' || typeof raw.at !== 'string' || isNaN(Date.parse(raw.at))) {
        fail('INVALID_ARGS', field + ' must be {at: ISO date, id: objectId}', { field: field });
      }
      return { at: new Date(raw.at), id: requireId(raw.id, field + '.id') };
    };

    let q;
    let mode;
    if (p.since !== undefined) {
      mode = 'catch-up';
      const c = cursor(p.since, 'since');
      const after = new Parse.Query('Message');
      after.greaterThan('updatedAt', c.at);
      const tie = new Parse.Query('Message');
      tie.equalTo('updatedAt', c.at);
      tie.greaterThan('objectId', c.id);
      q = Parse.Query.or(after, tie);
      q.equalTo('room', ctx.room);
      q.ascending('updatedAt');
      q.addAscending('objectId');
    } else {
      mode = 'history';
      q = new Parse.Query('Message');
      q.equalTo('room', ctx.room);
      if (p.before !== undefined) {
        const c = cursor(p.before, 'before');
        const older = new Parse.Query('Message');
        older.lessThan('createdAt', c.at);
        const tie = new Parse.Query('Message');
        tie.equalTo('createdAt', c.at);
        tie.lessThan('objectId', c.id);
        q = Parse.Query.or(older, tie);
        q.equalTo('room', ctx.room);
      }
      q.descending('createdAt');
      q.addDescending('objectId');
    }
    q.limit(limit + 1); // one extra row answers `more` without a count
    const rows = await q.find(MASTER);
    const page = rows.slice(0, limit);
    return { mode: mode, messages: page.map(messageJson), more: rows.length > limit };
  },
});

// deleteMessage({messageId}) → redacted message JSON. Policy: the author deletes their own message; a
// moderator deletes anyone's; any other member is refused. Soft delete per amendment B3's accepted default:
// the body is OVERWRITTEN server-side (redacted from accessible storage — direct REST reads and LiveQuery
// events alike carry the redacted body from here on), while deletedBy/deletedAt/author are retained as
// moderation metadata. Deletion is terminal (the hook refuses any further change) and idempotent.
define('deleteMessage', {
  target: 'Message', idParam: 'messageId', targetAs: 'message',
  handler: async function (request, ctx) {
    const mine = ctx.message.get('author') && ctx.message.get('author').id === ctx.user.id;
    if (!mine && ctx.membership.get('role') !== 'moderator') {
      fail('NOT_ALLOWED', 'Only the author or a room moderator may delete this message.', { messageId: ctx.message.id }, PE.OPERATION_FORBIDDEN);
    }
    if (ctx.message.get('deleted') === true) {
      return Object.assign(messageJson(ctx.message), { already: true });
    }
    ctx.message.set('body', config.REDACTED_BODY);
    ctx.message.set('deleted', true);
    ctx.message.set('deletedAt', new Date());
    ctx.message.set('deletedBy', ctx.user);
    await ctx.message.save(null, MASTER);
    return messageJson(ctx.message);
  },
});

// ---------------------------------------------------------------------------------------------------------
// 5. T11: the deliberately vulnerable function (never in a default deploy — cloud/config.js DEMO_UNGUARDED)
// ---------------------------------------------------------------------------------------------------------

// demoSendMessage({roomId, body}): writes into ANY room with the master key and no membership check — the
// naive implementation the article demonstrates ("a missing authorization check can leak room data": the
// outsider's message is delivered to every member's open subscription, and the function's master-key write
// path would equally serve as a read oracle). It models the app that has NEITHER the function guard NOR the
// hook's second check, so it asks the hook to stand down via save-context — which the hook only honours while
// DEMO_UNGUARDED is on. In a default deploy the function is not even registered (Parse 141) and the hook
// never skips. The guarded version is sendMessage.
define('demoSendMessage', {
  handler: async function (request) {
    const user = requireUser(request); // authentication alone does NOT scope rooms — that is the point
    const roomId = requireId(request.params && request.params.roomId, 'roomId');
    const body = requireBody(request.params && request.params.body);
    const room = await fetchById('Room', roomId);
    if (!room) fail('OBJECT_NOT_FOUND', 'Object not found.', null, PE.OBJECT_NOT_FOUND);
    const message = new Parse.Object('Message');
    message.set('room', room);
    message.set('author', user);
    message.set('body', body);
    message.set('deleted', false);
    await message.save(null, { useMasterKey: true, context: { demoUnguarded: true } });
    return messageJson(message);
  },
});

// ---------------------------------------------------------------------------------------------------------
// 6. Administrative helpers (amendment B5: SETUP_ENABLED **and** the server-checked setup token; the default
// deployment has both unset and refuses everything here)
// ---------------------------------------------------------------------------------------------------------

async function fetchSchema(className) {
  try {
    return await new Parse.Schema(className).get();
  } catch (e) {
    if (e && e.code === PE.INVALID_CLASS_NAME) return null; // 103: class does not exist
    throw e;
  }
}

function addFieldsTo(schema, fields) {
  Object.keys(fields).forEach(function (name) {
    const spec = fields[name];
    if (spec.type === 'Pointer') schema.addPointer(name, spec.targetClass);
    else schema.addField(name, spec.type);
  });
}

// setupSchema({allowRerun?, setupToken}) → {classes:[…]}. Creates the classes with fields, CLPs and indexes,
// or brings existing ones up to date (fields and indexes added, CLPs re-applied, nothing removed), plus the
// master-only CLP on _Role. Idempotent. Tripwire: refuses once 2+ Rooms exist unless {allowRerun:true} — a
// stray call on an app with data should be noisy, not silent. It is not a security boundary: the setup gate is.
define('setupSchema', {
  handler: async function (request) {
    const p = request.params || {};
    const roomCount = (await fetchSchema('Room')) ? await new Parse.Query('Room').count(MASTER) : 0;
    if (roomCount >= 2 && p.allowRerun !== true) {
      fail('SETUP_LOCKED', 'Room already holds ' + roomCount + ' rows; pass {allowRerun:true} to re-apply the schema.', { roomCount: roomCount });
    }
    const classes = [];
    for (const def of config.SCHEMA) {
      const have = await fetchSchema(def.className);
      const schema = new Parse.Schema(def.className);
      schema.setCLP(def.classLevelPermissions);
      if (!have) {
        addFieldsTo(schema, def.fields);
        Object.keys(def.indexes || {}).forEach(function (name) { schema.addIndex(name, def.indexes[name]); });
        await schema.save();
        classes.push({ className: def.className, action: 'created', newFields: Object.keys(def.fields), newIndexes: Object.keys(def.indexes || {}) });
        continue;
      }
      const newFields = {};
      Object.keys(def.fields).forEach(function (name) { if (!have.fields || !have.fields[name]) newFields[name] = def.fields[name]; });
      const haveIdx = have.indexes || {};
      const newIndexes = Object.keys(def.indexes || {}).filter(function (name) { return !haveIdx[name]; });
      addFieldsTo(schema, newFields);
      newIndexes.forEach(function (name) { schema.addIndex(name, def.indexes[name]); });
      await schema.update();
      classes.push({ className: def.className, action: 'updated', newFields: Object.keys(newFields), newIndexes: newIndexes });
    }
    const roleSchema = new Parse.Schema('_Role');
    roleSchema.setCLP(config.ROLE_CLP);
    await roleSchema.update();
    classes.push({ className: '_Role', action: 'updated', newFields: [], newIndexes: [] });
    return { classes: classes, roomCount: roomCount };
  },
});

const INSPECT_CLASSES = config.SCHEMA.map(function (d) { return d.className; }).concat(['_Role', '_User']);

// Parse Server may hand Cloud functions their params already decoded (pointers as Parse.Object) or raw
// (REST JSON, as on Back4app). Normalize either into what Parse.Query accepts.
function decodeParam(value) {
  if (value instanceof Parse.Object || value instanceof Date) return value;
  return Parse._decode(null, value);
}

// A Parse.Query from a `where` object of field → value EQUALITIES (values REST-encoded: a pointer is
// {__type:'Pointer',…}, a date {__type:'Date', iso}). Operators ($in, $regex, …) are not accepted; an
// equality on a relation column (e.g. _Role.users or _Role.roles against a pointer) works and is how the
// suite asserts role state. Same pattern as the sibling repo.
function queryFromWhere(className, where) {
  const q = new Parse.Query(className);
  Object.keys(where).forEach(function (key) {
    const value = decodeParam(where[key]);
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Parse.Object) && !(value instanceof Date) && !(value instanceof Parse.File)) {
      fail('INVALID_ARGS', 'where.' + key + ' must be a plain value or a REST-encoded pointer/date (no operators)', { field: 'where.' + key });
    }
    q.equalTo(key, value);
  });
  return q;
}

// testInspect({className, where?, limit?, count?, setupToken}) → {results:[toJSON…]} or {count}.
// Master-rights read of one whitelisted class, equality-where only. The live suite's state assertions run
// through this.
define('testInspect', {
  handler: async function (request) {
    const p = request.params || {};
    if (INSPECT_CLASSES.indexOf(p.className) === -1) {
      fail('INVALID_ARGS', 'className must be one of ' + INSPECT_CLASSES.join(', '), { field: 'className' });
    }
    const where = p.where === undefined ? {} : p.where;
    if (!where || typeof where !== 'object' || Array.isArray(where)) fail('INVALID_ARGS', 'where must be an object', { field: 'where' });
    const q = queryFromWhere(p.className, where);
    if (p.count === true) return { className: p.className, count: await q.count(MASTER) };
    const limit = p.limit === undefined ? 100 : p.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_ARGS', 'limit must be an integer in 1..1000', { field: 'limit' });
    q.limit(limit);
    q.ascending('createdAt');
    const rows = await q.find(MASTER);
    return { className: p.className, results: rows.map(function (r) { return r.toJSON(); }) };
  },
});

// The sweep testCleanup uses. Order: messages, then roles (reads die), memberships, and the Room row last.
async function wipeRoom(room) {
  if (room.get('status') !== 'deleting') {
    room.set('status', 'deleting'); // from here the guard refuses every new call into this room
    await room.save(null, MASTER);
  }
  const deleted = { messages: 0, memberships: 0, roles: 0, room: 0 };
  for (;;) {
    const q = new Parse.Query('Message');
    q.equalTo('room', room);
    q.limit(config.DELETE_PAGE_SIZE);
    const rows = await q.find(MASTER);
    if (!rows.length) break;
    await Parse.Object.destroyAll(rows, MASTER);
    deleted.messages += rows.length;
  }
  for (const kind of config.MEMBERSHIP_ROLES) {
    const role = await findRole(config.roleName(room.id, kind));
    if (role) {
      await role.destroy(MASTER);
      deleted.roles++;
    }
  }
  for (;;) {
    const q = new Parse.Query('RoomMembership');
    q.equalTo('room', room);
    q.limit(config.DELETE_PAGE_SIZE);
    const rows = await q.find(MASTER);
    if (!rows.length) break;
    await Parse.Object.destroyAll(rows, MASTER);
    deleted.memberships += rows.length;
  }
  await room.destroy(MASTER);
  deleted.room = 1;
  return deleted;
}

// testCleanup({runPrefix, setupToken}) → {rooms, users, sessions}. Deletes ONLY what one suite run created:
//   - every Room whose name contains the run prefix (full wipeRoom sweep: messages, roles, memberships), and
//   - every _User whose username starts with the prefix AND was created less than 2 hours ago (+ its sessions).
// The prefix shape is enforced (zz + ≥8 base36 chars, as test/helpers.mjs generates) so a stray call can
// never sweep real rooms or users. Parallel runs have distinct prefixes and never touch each other.
define('testCleanup', {
  handler: async function (request) {
    const p = request.params || {};
    if (typeof p.runPrefix !== 'string' || !/^zz[a-z0-9]{8,32}$/.test(p.runPrefix)) {
      fail('INVALID_ARGS', 'runPrefix must match ^zz[a-z0-9]{8,32}$ (the suite run prefix)', { field: 'runPrefix' });
    }
    const counts = { rooms: 0, users: 0, sessions: 0 };
    for (;;) {
      const rq = new Parse.Query('Room');
      rq.contains('name', p.runPrefix);
      rq.limit(20);
      const rooms = await rq.find(MASTER);
      if (!rooms.length) break;
      for (const room of rooms) {
        await wipeRoom(room);
        counts.rooms++;
      }
    }
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (;;) {
      const uq = new Parse.Query('_User');
      uq.startsWith('username', p.runPrefix);
      uq.greaterThan('createdAt', cutoff);
      uq.limit(100);
      const users = await uq.find(MASTER);
      if (!users.length) break;
      const sq = new Parse.Query('_Session');
      sq.containedIn('user', users);
      sq.limit(1000);
      const sessions = await sq.find(MASTER);
      if (sessions.length) await Parse.Object.destroyAll(sessions, MASTER);
      counts.sessions += sessions.length;
      await Parse.Object.destroyAll(users, MASTER);
      counts.users += users.length;
    }
    return counts;
  },
});

// testSeedMessages({roomId, authorId, count, bodyPrefix?, runPrefix, setupToken}) → {created}. M6 history
// seeding: `count` messages (≤ SEED_BATCH_MAX per call; the caller loops) are created SERVER-SIDE in one
// Cloud call instead of `count` HTTP requests — the request-budget inventory counts the per-object writes as
// billable operations anyway (amendment CC4: a batch is never assumed to be one billable request). Scoped
// hard: the target room's name must carry the zz… run prefix, and the author must be an active member (the
// Message hook re-checks both membership and body rules per object — the seed goes through the same second
// guard as every write).
define('testSeedMessages', {
  handler: async function (request) {
    const p = request.params || {};
    if (typeof p.runPrefix !== 'string' || !/^zz[a-z0-9]{8,32}$/.test(p.runPrefix)) {
      fail('INVALID_ARGS', 'runPrefix must match ^zz[a-z0-9]{8,32}$', { field: 'runPrefix' });
    }
    const roomId = requireId(p.roomId, 'roomId');
    const authorId = requireId(p.authorId, 'authorId');
    if (!Number.isInteger(p.count) || p.count < 1 || p.count > config.SEED_BATCH_MAX) {
      fail('INVALID_ARGS', 'count must be an integer in 1..' + config.SEED_BATCH_MAX, { field: 'count' });
    }
    const bodyPrefix = p.bodyPrefix === undefined ? 'seed' : requireBody(p.bodyPrefix);
    const room = await fetchById('Room', roomId);
    if (!room || room.get('name').indexOf(p.runPrefix) === -1) {
      fail('INVALID_ARGS', 'roomId must name a room whose name carries the run prefix', { field: 'roomId' });
    }
    const membership = await findMembership(authorId, roomId);
    if (!membership) fail('INVALID_ARGS', 'authorId must be an active member of the room', { field: 'authorId' });
    const author = userPointer(authorId);
    let created = 0;
    while (created < p.count) {
      const batch = [];
      const n = Math.min(100, p.count - created);
      for (let i = 0; i < n; i++) {
        const m = new Parse.Object('Message');
        m.set('room', room);
        m.set('author', author);
        m.set('body', bodyPrefix + ' ' + (created + i));
        m.set('deleted', false);
        batch.push(m);
      }
      await Parse.Object.saveAll(batch, MASTER); // hooks run per object
      created += n;
    }
    return { created: created };
  },
});

registry.assertAllRegistered();

// ---------------------------------------------------------------------------------------------------------
// 7. Hooks: the second guard. They run for EVERY write, master key included, so a Cloud function that forgot
// its membership check (or a future seed script) still cannot post into a foreign room.
// ---------------------------------------------------------------------------------------------------------

function hookFail(code, message, extra) {
  throw new PE(PE.OPERATION_FORBIDDEN, JSON.stringify(Object.assign({ code: code, message: message }, extra || {})));
}

function denyClientWrites(request, className, action) {
  if (!request.master) {
    hookFail('CLOUD_CODE_ONLY', className + ' rows are ' + action + ' by Cloud Code only.');
  }
}

// Reject a changed pointer field on update. On create, require it.
function enforceImmutablePointer(request, className, field) {
  const obj = request.object;
  if (!obj.existed()) {
    if (!obj.get(field)) hookFail(field.toUpperCase() + '_REQUIRED', className + ' rows must carry a ' + field + ' pointer.');
    return;
  }
  if (obj.dirty(field)) {
    const before = request.original ? request.original.get(field) : null;
    const after = obj.get(field);
    if (!after || !before || before.id !== after.id) {
      hookFail(field.toUpperCase() + '_IMMUTABLE', className + '.' + field + ' is immutable after create.', { className: className });
    }
  }
}

// New rows are refused while their room is being deleted; missing rooms are refused too.
async function requireActiveRoom(request) {
  const room = await fetchById('Room', request.object.get('room').id);
  if (!room) hookFail('ROOM_MISSING', 'The room of this row does not exist.');
  if (room.get('status') === 'deleting') hookFail('ROOM_DELETING', 'This room is being deleted; no new writes.');
  return room;
}

function aclReadRole(roleNames, userIds) {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  (roleNames || []).forEach(function (name) { acl.setRoleReadAccess(name, true); });
  (userIds || []).forEach(function (id) { acl.setReadAccess(id, true); });
  return acl;
}

Parse.Cloud.beforeSave('Room', async function (request) {
  denyClientWrites(request, 'Room', 'written');
  const obj = request.object;
  if (obj.existed()) {
    for (const field of ['memberRole', 'moderatorRole', 'createdBy']) {
      if (obj.dirty(field) && request.original && request.original.get(field)) {
        hookFail('IMMUTABLE_FIELD', 'Room.' + field + ' is immutable once set.', { field: field });
      }
    }
    // The row ACL is recomputed from the room's own id, whatever the caller supplied (forged-ACL class).
    obj.setACL(aclReadRole([config.roleName(obj.id, 'member')]));
  } else {
    obj.setACL(new Parse.ACL()); // unreadable until the roles exist; createRoom's second save fixes it
  }
  if (['active', 'deleting'].indexOf(obj.get('status')) === -1) hookFail('INVALID_ROW', 'Room.status must be active or deleting.');
});

Parse.Cloud.beforeSave('RoomMembership', async function (request) {
  denyClientWrites(request, 'RoomMembership', 'written');
  const obj = request.object;
  enforceImmutablePointer(request, 'RoomMembership', 'room');
  if (!obj.existed()) {
    if (!obj.get('user')) hookFail('INVALID_ROW', 'RoomMembership rows must carry a user pointer.');
    await requireActiveRoom(request);
  } else if (obj.dirty('user')) {
    hookFail('IMMUTABLE_FIELD', 'RoomMembership.user is immutable after create.', { field: 'user' });
  }
  if (config.MEMBERSHIP_ROLES.indexOf(obj.get('role')) === -1) hookFail('INVALID_ROW', 'RoomMembership.role must be moderator or member.');
  if (['active', 'removed'].indexOf(obj.get('status')) === -1) hookFail('INVALID_ROW', 'RoomMembership.status must be active or removed.');
  // ACL: the member themselves + the room's moderators read it; nobody writes it.
  obj.setACL(aclReadRole([config.roleName(obj.get('room').id, 'moderator')], [obj.get('user').id]));
});

// Message rules, enforced for EVERY writer including the master key:
//   create: room + author required; room active; author an ACTIVE MEMBER of the room at write time (the
//           "message's room must match the sender's active membership" rule — skipped only for the T11 demo
//           while DEMO_UNGUARDED is on); body length-capped; deleted must start false.
//   update: room/author immutable; a live message admits exactly ONE transition — the soft delete (deleted
//           true + body = REDACTED_BODY + deletedAt + deletedBy); a deleted message is terminal (no edits,
//           no un-delete). Messages have no edit feature by design, and the hook enforces it.
Parse.Cloud.beforeSave('Message', async function (request) {
  denyClientWrites(request, 'Message', 'written');
  const obj = request.object;
  enforceImmutablePointer(request, 'Message', 'room');
  enforceImmutablePointer(request, 'Message', 'author');

  if (!obj.existed()) {
    await requireActiveRoom(request);
    const demoBypass = config.DEMO_UNGUARDED && request.context && request.context.demoUnguarded === true;
    if (!demoBypass) {
      const membership = await findMembership(obj.get('author').id, obj.get('room').id);
      if (!membership) {
        hookFail('AUTHOR_NOT_MEMBER', 'Message.author must be an active member of the message\'s room at write time.', { field: 'author' });
      }
    }
    if (obj.get('deleted') === true) hookFail('INVALID_ROW', 'Messages are created live; soft-delete them afterwards.');
    const body = obj.get('body');
    if (typeof body !== 'string' || body.length < config.BODY_MIN || body.length > config.BODY_MAX) {
      hookFail('BODY_LENGTH', 'Message.body must be ' + config.BODY_MIN + '..' + config.BODY_MAX + ' characters.', { max: config.BODY_MAX });
    }
  } else {
    const was = request.original;
    if (was && was.get('deleted') === true) {
      hookFail('MESSAGE_DELETED', 'A deleted message is immutable (deletion is terminal).');
    }
    const becomingDeleted = obj.get('deleted') === true;
    if (!becomingDeleted) {
      // No edit feature: the only legal update is the soft delete.
      hookFail('MESSAGE_IMMUTABLE', 'Messages cannot be edited; the only update is deleteMessage\'s redaction.');
    }
    if (obj.get('body') !== config.REDACTED_BODY) {
      hookFail('INVALID_ROW', 'A deleted message\'s body must be the redacted value.');
    }
    if (!(obj.get('deletedAt') instanceof Date) || !obj.get('deletedBy')) {
      hookFail('INVALID_ROW', 'Soft deletes must carry deletedAt and deletedBy (moderation metadata).');
    }
  }
  obj.setACL(aclReadRole([config.roleName(obj.get('room').id, 'member')]));
});

// _Role: membership in room roles is managed by Cloud Code alone. The CLP already denies clients; this hook
// is the second guard for the role class itself.
Parse.Cloud.beforeSave('_Role', function (request) {
  denyClientWrites(request, '_Role', 'written');
});
Parse.Cloud.beforeDelete('_Role', function (request) {
  denyClientWrites(request, '_Role', 'deleted');
});

['Room', 'RoomMembership', 'Message'].forEach(function (className) {
  Parse.Cloud.beforeDelete(className, function (request) {
    denyClientWrites(request, className, 'deleted'); // hard deletes only via the cleanup sweep (master)
  });
});
