import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pool, withTransaction } from './pool';
import { logger } from '../lib/logger';
import { env } from '../config';

/**
 * Migration runner.
 *
 * Deliberately small and dependency-free. Each `.sql` file in `migrations/`
 * runs once, inside a transaction, in filename order, and its checksum is
 * recorded. Editing a migration that has already run is refused — a schema that
 * differs between staging and production because someone "just tweaked" an old
 * file is a genuinely dangerous class of bug.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL
    )
  `);
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents.replace(/\r\n/g, '\n')).digest('hex');
}

async function listMigrations(): Promise<Array<{ name: string; sql: string; checksum: string }>> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();

  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    }),
  );
}

export async function migrateUp(): Promise<{ applied: string[] }> {
  await ensureMigrationsTable();

  const applied = new Map<string, string>();
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  for (const row of rows) applied.set(row.name, row.checksum);

  const migrations = await listMigrations();
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    const existing = applied.get(migration.name);

    if (existing) {
      if (existing !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} has changed since it was applied. ` +
            'Applied migrations are immutable — add a new migration instead.',
        );
      }
      continue;
    }

    const started = Date.now();
    logger.info({ migration: migration.name }, 'Applying migration');

    await withTransaction(async (client) => {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
        [migration.name, migration.checksum, Date.now() - started],
      );
    });

    newlyApplied.push(migration.name);
    logger.info({ migration: migration.name, elapsedMs: Date.now() - started }, 'Migration applied');
  }

  if (newlyApplied.length === 0) logger.info('Database is already up to date');
  return { applied: newlyApplied };
}

/**
 * Drops and recreates the public schema. Refuses to run in production — this
 * is the command that deletes every trip, payment and payroll record.
 */
export async function resetDatabase(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to reset the database in production');
  }

  logger.warn('Dropping and recreating the public schema');
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrateUp();
}

export async function migrationStatus(): Promise<void> {
  await ensureMigrationsTable();
  const { rows } = await pool.query<{ name: string; applied_at: Date }>(
    'SELECT name, applied_at FROM schema_migrations ORDER BY name',
  );
  const migrations = await listMigrations();

  for (const migration of migrations) {
    const record = rows.find((row) => row.name === migration.name);
    logger.info(
      { migration: migration.name, applied: Boolean(record), appliedAt: record?.applied_at },
      record ? 'applied' : 'pending',
    );
  }
}

if (require.main === module) {
  const command = process.argv[2] ?? 'up';

  const run = async (): Promise<void> => {
    if (command === 'up') await migrateUp();
    else if (command === 'reset') await resetDatabase();
    else if (command === 'status') await migrationStatus();
    else throw new Error(`Unknown command: ${command}. Use up | reset | status.`);
  };

  run()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Migration failed');
      process.exit(1);
    });
}
