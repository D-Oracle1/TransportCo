#!/usr/bin/env node
/**
 * Isolated end-to-end smoke test.
 *
 * Runs the full vertical slice (scripts/smoke.cjs) against a THROWAWAY Postgres
 * schema so it never reads or writes the real data — useful when the only
 * database available is a shared/hosted one (e.g. a single Supabase project).
 *
 * What it does, and undoes:
 *   1. Creates a unique schema  smoke_<timestamp>  on the configured database.
 *   2. Migrates + seeds into it (search_path pinned to that schema).
 *   3. Boots the API on :4000 pointed at that schema.
 *   4. Runs scripts/smoke.cjs (asserts 51 properties).
 *   5. ALWAYS drops the schema and stops the API — even on failure.
 *
 * It NEVER runs `db:reset` (which drops the public schema) and never touches
 * any schema but the one it created. The real `public` data is left untouched.
 *
 * Usage:  pnpm --filter @transportco/api smoke:isolated
 * Requires DATABASE_URL (from .env at the workspace root, or the environment).
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiDir = join(__dirname, '..');
const isWin = process.platform === 'win32';
const PORT = 4000;

// ── Resolve the base DATABASE_URL ────────────────────────────────────────────
// Prefer the environment; otherwise read the nearest .env walking upward.
function readEnvFile() {
  let dir = apiDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}
function envValue(name) {
  if (process.env[name]) return process.env[name];
  const line = readEnvFile()
    .split('\n')
    .find((l) => l.trim().startsWith(`${name}=`));
  if (!line) return undefined;
  return line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
}

const baseUrl = envValue('DATABASE_URL');
if (!baseUrl) {
  console.error('DATABASE_URL is not set (checked env and .env). Aborting.');
  process.exit(1);
}
const databaseSsl = (envValue('DATABASE_SSL') ?? 'true') !== 'false';

// Pin the connection to a given schema via the libpq `options` parameter,
// preserving any other query params and replacing any existing options.
function urlWithSchema(url, schema) {
  const [head, query = ''] = url.split('?');
  const params = query.split('&').filter((p) => p && !/^options=/i.test(p));
  params.push(`options=-c%20search_path%3D${schema}`);
  return `${head}?${params.join('&')}`;
}

const schema = `smoke_${Date.now()}`;
const schemaUrl = urlWithSchema(baseUrl, schema);
const childEnv = {
  ...process.env,
  DATABASE_URL: schemaUrl,
  DATABASE_SSL: String(databaseSsl),
  NODE_ENV: 'development',
};

const pgClient = () =>
  new pg.Client({ connectionString: baseUrl, ssl: databaseSsl ? { rejectUnauthorized: false } : false });

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: apiDir, env: childEnv, stdio: 'inherit', shell: isWin, ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${res.status}`);
}

async function waitForHealth(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error('API did not become healthy within timeout');
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

let apiProc = null;
let created = false;

async function main() {
  // Guard: refuse to run against an obviously-production configuration.
  if ((process.env.NODE_ENV ?? '') === 'production') {
    throw new Error('Refusing to run the isolated smoke test with NODE_ENV=production');
  }

  console.log(`\n[isolated-smoke] using throwaway schema: ${schema}\n`);

  // 1. Create the isolated schema.
  {
    const c = pgClient();
    await c.connect();
    await c.query(`CREATE SCHEMA "${schema}"`);
    await c.end();
    created = true;
  }

  // 2. Migrate + seed into it.
  console.log('[isolated-smoke] migrating…');
  run('pnpm', ['exec', 'tsx', 'src/db/migrate.ts', 'up']);
  console.log('[isolated-smoke] seeding…');
  run('pnpm', ['exec', 'tsx', 'src/db/seed.ts']);

  // 3. Boot the API against the schema.
  console.log('[isolated-smoke] starting API…');
  apiProc = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: apiDir,
    env: childEnv,
    stdio: 'ignore',
    shell: isWin,
    detached: !isWin,
  });
  await waitForHealth();

  // 4. Run the smoke test.
  console.log('[isolated-smoke] running smoke.cjs…\n');
  run('node', ['scripts/smoke.cjs']);
}

let exitCode = 0;
try {
  await main();
  console.log('\n[isolated-smoke] PASSED');
} catch (err) {
  exitCode = 1;
  console.error(`\n[isolated-smoke] FAILED: ${err.message}`);
} finally {
  // 5. Always tear down.
  killTree(apiProc?.pid);
  if (created) {
    try {
      const c = pgClient();
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await c.end();
      console.log(`[isolated-smoke] dropped schema ${schema}`);
    } catch (e) {
      console.error(`[isolated-smoke] WARNING: could not drop schema ${schema}: ${e.message}`);
    }
  }
}
process.exit(exitCode);
