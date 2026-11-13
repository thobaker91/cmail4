#!/usr/bin/env node
// Cmail — self-healing deploy: resolves missing / placeholder D1 database_ids
// before running `wrangler deploy`.
//
// Why this exists: the public repository ships `wrangler.jsonc` with
// REPLACE_WITH_D1_ID (no real database id ever lives in a public repo). The
// Deploy-to-Cloudflare button provisions resources and rewrites ids ONLY for
// newly created resources — when a database with the same name already exists
// in the target account it is reused as-is and the config keeps the
// placeholder, so a plain `wrangler deploy` inside CI dies with
// "binding DB of type d1 must have a valid `database_id`" (error 10021).
//
// This script is the `deploy` npm script: the button pipeline detects
// package.json deploy scripts and pre-populates its Deploy step with it, and
// humans can run `npm run deploy` too. It resolves every D1 entry by
// database_name (creating the database when it truly does not exist), patches
// the working copy of the config in place, then hands over to wrangler.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CONFIG = 'wrangler.jsonc';
const PLACEHOLDER = 'REPLACE_WITH_D1_ID';
const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

const run = (cmd) => spawnSync(cmd, { shell: true, encoding: 'utf8' });

function d1Entries(src) {
  // pull every d1 binding out of the jsonc — comments and // lines tolerated
  const arr = src.match(/"d1_databases"\s*:\s*\[([\s\S]*?)\n\s*\]/);
  if (!arr) return [];
  const out = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(arr[1]))) {
    const name = (m[0].match(/"database_name"\s*:\s*"([^"]+)"/) || [])[1];
    const id = (m[0].match(/"database_id"\s*:\s*"([^"]*)"/) || [])[1];
    if (name) out.push({ name, id, raw: m[0] });
  }
  return out;
}

function listDatabases() {
  const j = run('npx wrangler d1 list --json');
  if (j.status === 0) {
    try {
      const rows = JSON.parse(j.stdout);
      return rows.map((r) => ({ name: r.name, uuid: r.uuid }));
    } catch { /* fall through to text parsing */ }
  }
  const t = run('npx wrangler d1 list');
  const rows = [];
  for (const line of (t.stdout || '').split('\n')) {
    const id = (line.match(UUID_RE) || [])[0];
    const name = line.trim().split(/\s+/)[0];
    if (id && name && !name.startsWith('─')) rows.push({ name, uuid: id });
  }
  return rows;
}

function createDatabase(name) {
  const c = run(`npx wrangler d1 create "${name}"`);
  const out = `${c.stdout || ''}\n${c.stderr || ''}`;
  if (c.status !== 0 && !/already exists/i.test(out)) {
    console.error(`✖ could not create D1 database "${name}":\n${out.slice(0, 600)}`);
    process.exit(1);
  }
  const id = (out.match(/database_id\s*[=:]\s*"([a-f0-9-]{36})"/i) || out.match(UUID_RE) || [])[1]
    || (out.match(UUID_RE) || [])[0];
  if (!id) {
    console.error(`✖ created "${name}" but could not read its id:\n${out.slice(0, 600)}`);
    process.exit(1);
  }
  return id;
}

// ---------------------------------------------------------------------------
let src = readFileSync(CONFIG, 'utf8');
const entries = d1Entries(src);
if (!entries.length) {
  console.log('no d1_databases in config — deploying as-is');
} else {
  const rows = listDatabases();
  let patched = 0;
  for (const e of entries) {
    const needsId = !e.id || e.id === PLACEHOLDER || !UUID_RE.test(e.id);
    if (!needsId) continue;
    const found = rows.find((r) => r.name === e.name);
    const id = found ? found.uuid : createDatabase(e.name);
    console.log(`D1 "${e.name}" → ${id}${found ? '' : ' (created)'}`);
    if (e.raw.includes('"database_id"')) {
      src = src.replace(e.raw, e.raw.replace(/"database_id"\s*:\s*"[^"]*"/, `"database_id": "${id}"`));
    } else {
      // config ships without an id key at all — insert after database_name
      src = src.replace(
        new RegExp(`("database_name"\\s*:\\s*"${e.name}"\\s*),?`),
        `$1\n      "database_id": "${id}",`
      );
    }
    patched++;
  }
  if (patched) {
    writeFileSync(CONFIG, src);
    console.log(`wrangler.jsonc patched (${patched} binding${patched > 1 ? 's' : ''}) — working copy only, nothing is committed`);
  } else {
    console.log('all database ids already resolved — config untouched');
  }
}

// ---------------------------------------------------------------------------
console.log('deploying…');
if (process.env.CMAIL_RESOLVE_ONLY === '1') {
  console.log('CMAIL_RESOLVE_ONLY=1 — stopping before the actual deploy');
  process.exit(0);
}
const d = spawnSync('npx wrangler deploy', { shell: true, stdio: 'inherit' });
process.exit(d.status ?? 1);
