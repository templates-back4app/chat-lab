// File: scripts/dev-server.mjs · local parse-server ^7 with the Postgres adapter, the same Cloud Code as a
// Back4app deploy, and LiveQuery enabled for Message — Phase A proves the LiveQuery mechanics end to end
// against this server before the live phase re-measures them on Back4app.
//   npm run dev:server            → http://localhost:1342/parse (database postgres://localhost:5433/chat_dev)
//                                   LiveQuery: ws://localhost:1342/parse (class Message)
// Imported by the tests, which start their own instance on a free port and the database chat_test.
// Needs a Postgres listening on 5433 (brew: postgresql@17 — the same instance tenant-lab uses; distinct
// database names). The database is created with `createdb` if missing.
//
// Setup gate (amendment B5): cloud/config.js ships DISABLED (SETUP_ENABLED and SETUP_TOKEN_SHA256 both unset).
// The LOCAL server turns the helpers on with the fixed local token below — they are not secrets here, the
// server only listens on localhost. Tests that prove the disabled/tokenless halves override these variables
// in their own processes BEFORE importing this module.
import express from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { LOCAL, ROOT, loadDotEnv, sha256hex } from './lib/env.mjs';

const PG_BIN = [process.env.PG_BIN, '/opt/homebrew/opt/postgresql@17/bin', '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);

export function ensureDatabase(databaseURI) {
  const u = new URL(databaseURI);
  const dbName = u.pathname.replace(/^\//, '');
  const dir = PG_BIN.find((d) => existsSync(path.join(d, 'createdb')));
  if (!dir) { console.warn(`createdb not found in ${PG_BIN.join(', ')} (set PG_BIN) — assuming ${dbName} exists`); return; }
  const common = ['-h', u.hostname, '-p', u.port || '5432', ...(u.username ? ['-U', u.username] : [])];
  const list = execFileSync(path.join(dir, 'psql'), [...common, '-lqt'], { encoding: 'utf8' });
  if (list.split('\n').some((l) => l.split('|')[0].trim() === dbName)) return;
  execFileSync(path.join(dir, 'createdb'), [...common, dbName], { stdio: 'inherit' });
  console.log(`created database ${dbName}`);
}

/** Runs `sql` against the given database via psql (the tests use it for below-the-API state manipulation,
 *  e.g. forcing two messages onto the same timestamp — the equal-createdAt row of the reconnect matrix). */
export function runSql(databaseURI, sql) {
  const u = new URL(databaseURI);
  const dir = PG_BIN.find((d) => existsSync(path.join(d, 'psql')));
  if (!dir) throw new Error(`psql not found in ${PG_BIN.join(', ')} (set PG_BIN)`);
  const commonArgs = ['-h', u.hostname, '-p', u.port || '5432', ...(u.username ? ['-U', u.username] : []), '-d', u.pathname.replace(/^\//, ''), '-qAt', '-c', sql];
  return execFileSync(path.join(dir, 'psql'), commonArgs, { encoding: 'utf8' }).trim();
}

/** Starts parse-server + express + LiveQuery. Returns { server, http, url, close() }. */
export async function startServer({ port = LOCAL.PORT, databaseURI = LOCAL.DATABASE_URL, quiet = false } = {}) {
  // Local default: administrative helpers ON with the fixed local token (see header). ??= so a test process
  // that set SETUP_ENABLED='0' or a different token keeps its value.
  process.env.SETUP_ENABLED ??= '1';
  process.env.SETUP_TOKEN_SHA256 ??= sha256hex(LOCAL.SETUP_TOKEN);

  ensureDatabase(databaseURI);
  const serverURL = `http://localhost:${port}/parse`;
  const { ParseServer } = await import('parse-server'); // after the env defaults above: cloud code reads them at load

  const parseOptions = {
    appId: LOCAL.APP_ID,
    javascriptKey: LOCAL.JS_KEY,
    restAPIKey: LOCAL.REST_KEY,
    masterKey: LOCAL.MASTER_KEY,
    serverURL,
    databaseURI,
    cloud: path.join(ROOT, 'cloud', 'main.js'),
    appName: 'chat-lab (local)',
    // Mirrors the Back4app settings that matter for the matrix; any difference found on the live run is a
    // finding for docs/evidence/local-vs-live.md.
    allowClientClassCreation: false,
    enableAnonymousUsers: false,       // personas sign up with username/password; "anonymous" = no session at all
    enforcePrivateUsers: true,
    allowExpiredAuthDataToken: false,
    masterKeyIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
    liveQuery: { classNames: ['Message'] },
    logLevel: quiet ? 'error' : (process.env.PARSE_LOG_LEVEL || 'info'),
    silent: quiet,
    verbose: process.env.PARSE_VERBOSE === '1',
  };
  const server = new ParseServer(parseOptions);

  const app = express();
  app.disable('x-powered-by');
  // COUNT_REQUESTS=1 (request-budget inventory, amendment CC4): count every HTTP request this in-process
  // server handles and append one JSON line per server lifetime to docs/notes/.request-counts.jsonl, tagged
  // with the suite file that started it. `npm run budget` reads the latest complete run.
  let requestCount = null;
  if (process.env.COUNT_REQUESTS === '1') {
    requestCount = { n: 0 };
    app.use((_req, _res, next) => { requestCount.n++; next(); });
  }
  if (!quiet) {
    app.use((req, _res, next) => { // one line per request, so the diary can show what a client really sent
      console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
      next();
    });
  }
  app.use('/parse', server.app);
  app.use(express.static(path.join(ROOT, 'public'))); // the two-pane demo page (client/ served as modules)
  app.use('/client', express.static(path.join(ROOT, 'client')));
  // Listen first: start() probes serverURL over HTTP and warns "Unable to connect" if nothing answers yet.
  const http = await new Promise((resolve) => { const h = app.listen(port, () => resolve(h)); });
  await server.start();
  const liveQueryServer = await ParseServer.createLiveQueryServer(
    http,
    { appId: LOCAL.APP_ID, masterKey: LOCAL.MASTER_KEY, serverURL },
    parseOptions,
  );
  const startedAt = Date.now();
  if (!quiet) console.log(`parse-server ${version()} on ${serverURL} · db ${databaseURI} · cloud/main.js mounted · LiveQuery ws://localhost:${port}/parse (Message) · demo page http://localhost:${port}/demo.html`);
  return {
    server, http, url: serverURL, databaseURI,
    close: async () => {
      // parse-server probes serverURL/health ~1 s after mount; a suite faster than that would log a spurious warning.
      await new Promise((r) => setTimeout(r, Math.max(0, 1500 - (Date.now() - startedAt))));
      if (liveQueryServer && liveQueryServer.server && liveQueryServer.server !== http) {
        await new Promise((r) => liveQueryServer.server.close(r));
      }
      // http.close() waits for open connections — a test's still-open (or deliberately abandoned) WebSocket
      // would deadlock the suite's teardown, so destroy whatever is left.
      await new Promise((r) => { http.close(r); if (http.closeAllConnections) http.closeAllConnections(); });
      await server.handleShutdown();
      if (requestCount) {
        const { appendFileSync, mkdirSync } = await import('node:fs');
        const dir = path.join(ROOT, 'docs', 'notes');
        mkdirSync(dir, { recursive: true });
        appendFileSync(path.join(dir, '.request-counts.jsonl'),
          JSON.stringify({ suite: path.basename(process.argv[1] || 'unknown'), requests: requestCount.n, at: new Date().toISOString() }) + '\n');
      }
    },
  };
}

function version() {
  try { return createRequire(import.meta.url)('parse-server/package.json').version; } catch { return ''; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts', 'dev-server.mjs')) {
  loadDotEnv();
  startServer({ databaseURI: process.env.DATABASE_URL || LOCAL.DATABASE_URL }).catch((e) => { console.error(e); process.exit(1); });
}
