// File: scripts/lib/env.mjs · Node 22 ESM
// .env loading, the fixed LOCAL target, target selection and CLI flags — shared by scripts and tests.
// Same pattern as the sibling repos (tenant-lab, game-backend-starter).
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Fixed keys of the LOCAL parse-server (scripts/dev-server.mjs). They are not secrets: the server only listens
// on localhost and the database is a throwaway. Keeping them constant lets the dev server, the scripts and the
// tests agree without touching .env, which is reserved for a Back4app app (live phase, later).
// Ports: 1342 (tenant-lab holds 1341); Postgres instance shared with tenant-lab on 5433, databases chat_dev /
// chat_test. LiveQuery is served by the same HTTP server (ws://localhost:1342/parse) — no separate port needed.
export const LOCAL = {
  name: 'local',
  APP_ID: 'chat-lab-dev',
  JS_KEY: 'chat-lab-dev-js',
  REST_KEY: 'chat-lab-dev-rest',
  MASTER_KEY: 'chat-lab-dev-master',
  SETUP_TOKEN: 'chat-lab-dev-setup-token', // raw admin token the LOCAL server accepts (hash set by dev-server.mjs)
  SERVER_URL: 'http://localhost:1342/parse',
  PORT: 1342,
  DATABASE_URL: 'postgres://localhost:5433/chat_dev',
};

export const sha256hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

/**
 * Target selection: `--local` (or TARGET=local) → the local dev server; `--live` → the Back4app backend from
 * .env.live (keys are never printed); otherwise the backend from .env, falling back to LOCAL.
 * SETUP_TOKEN is the raw administrative token (amendment B5) the setup-gated Cloud helpers require; the live
 * phase puts it in .env.live, locally it is the fixed LOCAL constant.
 */
export function target(a = args()) {
  if (a.live) {
    if (!loadDotEnv(path.join(ROOT, '.env.live'))) {
      console.error('--live: no .env.live found. It must hold APP_ID, JS_KEY, REST_KEY, SERVER_URL, SETUP_TOKEN.');
      process.exit(2);
    }
    if (!process.env.APP_ID) { console.error('--live: .env.live has no APP_ID.'); process.exit(2); }
    return {
      name: 'back4app',
      APP_ID: process.env.APP_ID,
      JS_KEY: process.env.JS_KEY || '',
      REST_KEY: process.env.REST_KEY || '',
      MASTER_KEY: '', // the master key stays in the dashboard; everything privileged runs inside Cloud Code
      SETUP_TOKEN: process.env.SETUP_TOKEN || '',
      SERVER_URL: (process.env.SERVER_URL || 'https://parseapi.back4app.com').replace(/\/+$/, ''),
    };
  }
  loadDotEnv();
  if (a.local || process.env.TARGET === 'local' || !process.env.APP_ID) {
    if (!a.local && process.env.TARGET !== 'local' && !process.env.APP_ID) {
      console.log('no APP_ID in .env — using the LOCAL dev server (start it with `npm run dev:server`)');
    }
    return { ...LOCAL };
  }
  return {
    name: 'live',
    APP_ID: process.env.APP_ID,
    JS_KEY: process.env.JS_KEY || '',
    REST_KEY: process.env.REST_KEY || '',
    MASTER_KEY: process.env.MASTER_KEY || '',
    SETUP_TOKEN: process.env.SETUP_TOKEN || '',
    SERVER_URL: (process.env.SERVER_URL || 'https://parseapi.back4app.com').replace(/\/+$/, ''),
  };
}

/** Parse command-line flags of the form --name value / --name=value / --flag. */
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}
