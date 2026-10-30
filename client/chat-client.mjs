// File: client/chat-client.mjs · ESM, environment-agnostic (Node tests inject `ws`; a browser uses the native
// WebSocket and fetch). The shipped chat client of the brief, with the RACE-SAFE RECONNECT ALGORITHM of
// amendment B2 implemented exactly as specified:
//
//   resubscribe → await the subscription acknowledgment → BUFFER incoming live events → paginated catch-up
//   query → dedup by message objectId → reconcile the buffer against the catch-up.
//
// Why each step exists:
//   - Buffering starts AT the subscription ack, so a message that arrives DURING recovery is never lost and
//     never applied out of order with the catch-up pages (T10 "messages arriving during recovery").
//   - The catch-up query is getMessages in `since` mode: keyed on (updatedAt, objectId) ascending, so a
//     message SOFT-DELETED while the client was offline is caught up too (its createdAt is old, its updatedAt
//     is fresh — T10 "deletions while offline"), and the objectId tie-break keeps pagination exact when two
//     rows share one timestamp (T10 "equal timestamps").
//   - Dedup is by objectId with newer-wins (updatedAt), deletion terminal: a message present in both a
//     catch-up page and the buffer (created mid-recovery) lands exactly once.
//   - The since-cursor is rewound by OVERLAP_MS before each catch-up: live events are delivered in commit
//     order, which under concurrent writers is not guaranteed to be updatedAt order, so a strict `>` from the
//     newest applied event could skip a slightly older write that was never delivered. The overlap re-reads a
//     short window instead; dedup absorbs the replays. Timestamp ordering does not establish a total order of
//     writes (amendment B2 / H5) — this client never assumes it does.
//
// No SDK: the LiveQuery wire protocol and the Cloud-function REST calls are spoken directly, so the lab's
// matrix rows record exactly what crosses the network.

export const OVERLAP_MS = 2000;
const EPOCH = { at: new Date(0).toISOString(), id: '00000000' };

/** Normalize a message from either source (getMessages JSON or a raw LiveQuery event object) to one shape. */
export function normalizeMessage(raw) {
  const dateOf = (v) => (v && typeof v === 'object' && v.iso) ? v.iso : (v || null);
  return {
    id: raw.id || raw.objectId,
    roomId: raw.roomId || (raw.room && raw.room.objectId) || null,
    authorId: raw.authorId || (raw.author && raw.author.objectId) || null,
    body: raw.body,
    deleted: raw.deleted === true,
    deletedAt: dateOf(raw.deletedAt),
    deletedById: raw.deletedById || (raw.deletedBy && raw.deletedBy.objectId) || null,
    createdAt: dateOf(raw.createdAt),
    updatedAt: dateOf(raw.updatedAt) || dateOf(raw.createdAt),
  };
}

/** Total order on (time, objectId) tuples — the tie-break that makes equal timestamps unambiguous. */
export function compareTuple(a, b) {
  const ta = Date.parse(a.at); const tb = Date.parse(b.at);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Apply one normalized message to the state map (dedup by objectId, newer-wins by updatedAt, deletion
 * terminal — once a client saw deleted:true for an id it never un-deletes). Returns 'new' | 'updated' |
 * 'duplicate' | 'stale'. Pure; unit-tested with equal-timestamp fixtures in test/reconnect.test.mjs.
 */
export function applyMessage(map, msg) {
  const have = map.get(msg.id);
  if (!have) { map.set(msg.id, msg); return 'new'; }
  if (have.deleted) return msg.deleted ? 'duplicate' : 'stale';
  if (msg.deleted) { map.set(msg.id, msg); return 'updated'; }
  const dt = Date.parse(msg.updatedAt) - Date.parse(have.updatedAt);
  if (dt > 0) { map.set(msg.id, msg); return 'updated'; }
  return dt === 0 ? 'duplicate' : 'stale';
}

/** Display order: (createdAt, objectId) ascending — stable under equal timestamps, and explicitly NOT a claim
 *  about write order (H5). */
export function sortedMessages(map) {
  return [...map.values()].sort((a, b) => compareTuple({ at: a.createdAt, id: a.id }, { at: b.createdAt, id: b.id }));
}

/**
 * createChatClient({serverUrl, appId, restKey?, jsKey?, sessionToken, roomId, lqUrl?, WebSocketImpl?,
 *                   fetchImpl?, pageSize?, requestTimeoutMs?, on = {subscribed, recovered, message, error, close}})
 *
 * Methods: connect() (first connect and every reconnect — same algorithm), sendMessage(body), close() (clean),
 * dropConnection() (TCP cut, no close frame — the "crash" used by the reconnect tests), plus read access to
 * state (messages map, cursor, counters).
 */
export function createChatClient(opts) {
  const WS = opts.WebSocketImpl || globalThis.WebSocket;
  const doFetch = opts.fetchImpl || globalThis.fetch.bind(globalThis);
  const lqUrl = opts.lqUrl || opts.serverUrl.replace(/^http/, 'ws');
  const pageSize = opts.pageSize || 50;
  const on = opts.on || {};
  const messages = new Map();
  const counters = { eventsReceived: 0, eventsBuffered: 0, duplicatesIgnored: 0, caughtUp: 0, pages: 0 };
  let cursor = null; // {at: updatedAt ISO, id} of the newest APPLIED version
  let ws = null;
  let recovering = false;
  let buffer = [];
  let requestId = 0;
  let lastEventAt = null; // performance.now() of the last create/update event (measurement scripts read it)

  async function callFunction(name, params) {
    const headers = { 'Content-Type': 'application/json', 'X-Parse-Application-Id': opts.appId };
    if (opts.restKey) headers['X-Parse-REST-API-Key'] = opts.restKey;
    else if (opts.jsKey) headers['X-Parse-Javascript-Key'] = opts.jsKey;
    if (opts.sessionToken) headers['X-Parse-Session-Token'] = opts.sessionToken;
    const res = await doFetch(`${opts.serverUrl}/functions/${name}`, { method: 'POST', headers, body: JSON.stringify(params || {}) });
    const json = await res.json().catch(() => null);
    if (res.status !== 200 || !json || !('result' in json)) {
      const err = new Error(`${name} failed: HTTP ${res.status} ${JSON.stringify(json)}`);
      err.status = res.status;
      err.parseCode = json && json.code;
      throw err;
    }
    return json.result;
  }

  function advanceCursor(msg) {
    const tuple = { at: msg.updatedAt, id: msg.id };
    if (!cursor || compareTuple(tuple, cursor) > 0) cursor = tuple;
  }

  function applyAndCount(msg) {
    const outcome = applyMessage(messages, msg);
    if (outcome === 'duplicate' || outcome === 'stale') counters.duplicatesIgnored++;
    advanceCursor(msg);
    if ((outcome === 'new' || outcome === 'updated') && on.message) on.message(msg, outcome);
    return outcome;
  }

  /** The paginated catch-up (step 3 of the algorithm). Rewinds the cursor by OVERLAP_MS; pages until done. */
  async function catchUp() {
    let since = cursor
      ? { at: new Date(Date.parse(cursor.at) - OVERLAP_MS).toISOString(), id: EPOCH.id }
      : EPOCH; // first connect: replay the room from the start (lab-sized rooms; a product would bound this with a history page)
    for (;;) {
      const page = await callFunction('getMessages', { roomId: opts.roomId, since, limit: pageSize });
      counters.pages++;
      for (const raw of page.messages) {
        const msg = normalizeMessage(raw);
        applyAndCount(msg);
        since = { at: msg.updatedAt, id: msg.id }; // page cursor advances by what the SERVER returned, exact tuple
        counters.caughtUp++;
      }
      if (!page.more) break;
    }
  }

  /**
   * connect(): the full amendment-B2 sequence. Used for the first connection and every reconnect — the
   * algorithm does not distinguish them (the first connect is a reconnect from the epoch).
   */
  async function connect() {
    const tStart = (globalThis.performance || Date).now();
    ws = new WS(lqUrl);
    const myRequestId = ++requestId;

    const fatal = (err) => { if (on.error) on.error(err); };
    let onControl = null;
    const control = (op) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for op:${op}`)), opts.requestTimeoutMs || 8000);
      onControl = (msg) => {
        if (msg.op === op) { clearTimeout(timer); onControl = null; resolve(msg); }
        else if (msg.op === 'error') {
          clearTimeout(timer); onControl = null;
          const err = new Error(`LiveQuery error: ${JSON.stringify(msg)}`);
          err.lqCode = msg.code; err.reconnectAdvised = msg.reconnect;
          reject(err);
        }
      };
    });

    ws.addEventListener ? ws.addEventListener('message', (e) => route(e.data)) : ws.on('message', (d) => route(d));
    if (ws.on) ws.on('close', () => { if (on.close) on.close(); });
    else ws.addEventListener('close', () => { if (on.close) on.close(); });

    function route(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (['create', 'update', 'delete', 'enter', 'leave'].includes(msg.op)) {
        counters.eventsReceived++;
        lastEventAt = (globalThis.performance || Date).now();
        const normalized = normalizeMessage(msg.object || {});
        normalized._op = msg.op;
        if (recovering) { buffer.push(normalized); counters.eventsBuffered++; }
        else applyAndCount(normalized);
        if (on.event) on.event(msg.op, normalized);
      } else if (msg.op === 'error' && !onControl) {
        const err = new Error(`LiveQuery error: ${JSON.stringify(msg)}`);
        err.lqCode = msg.code;
        fatal(err);
      } else if (onControl) {
        onControl(msg);
      }
    }

    await new Promise((resolve, reject) => {
      if (ws.on) { ws.on('open', resolve); ws.on('error', reject); }
      else { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); }
    });
    // Late socket errors (after open) surface through on.error and must never crash the host process.
    if (ws.on) ws.on('error', fatal);
    else ws.addEventListener('error', fatal);

    // 1. connect, then (re)subscribe and WAIT FOR THE ACK — events before the ack do not exist.
    const connected = control('connected');
    ws.send(JSON.stringify({ op: 'connect', applicationId: opts.appId, javascriptKey: opts.jsKey, sessionToken: opts.sessionToken }));
    await connected;

    recovering = true; // 2. buffer from here: the ack means the server may start pushing at any moment
    buffer = [];
    const subscribed = control('subscribed');
    ws.send(JSON.stringify({
      op: 'subscribe', requestId: myRequestId,
      query: { className: 'Message', where: { room: { __type: 'Pointer', className: 'Room', objectId: opts.roomId } } },
      sessionToken: opts.sessionToken,
    }));
    await subscribed;
    const tAck = (globalThis.performance || Date).now();
    if (on.subscribed) await on.subscribed(); // test injection point: sends that land DURING recovery

    // 3. paginated catch-up, 4.+5. dedup + reconcile the buffer against it.
    const pagesBefore = counters.pages;
    await catchUp();
    const tCaughtUp = (globalThis.performance || Date).now();
    const buffered = buffer;
    buffer = [];
    recovering = false;
    for (const msg of buffered) applyAndCount(msg);
    const result = {
      caughtUp: counters.caughtUp, buffered: buffered.length,
      ackMs: tAck - tStart, catchUpMs: tCaughtUp - tAck, catchUpPages: counters.pages - pagesBefore,
    };
    if (on.recovered) on.recovered({ ...result, counters: { ...counters } });
    return result;
  }

  return {
    connect,
    sendMessage: (body) => callFunction('sendMessage', { roomId: opts.roomId, body }),
    callFunction,
    close() {
      if (!ws) return;
      try { ws.send(JSON.stringify({ op: 'unsubscribe', requestId })); } catch { /* already closing */ }
      ws.close();
    },
    dropConnection() { // the TCP cut: no close frame, no unsubscribe — what a crash or a dead uplink looks like
      if (!ws) return;
      if (ws.terminate) ws.terminate();
      else ws.close();
    },
    get messages() { return messages; },
    get sorted() { return sortedMessages(messages); },
    get cursor() { return cursor; },
    get counters() { return { ...counters }; },
    get lastEventAt() { return lastEventAt; },
    get recovering() { return recovering; },
  };
}
