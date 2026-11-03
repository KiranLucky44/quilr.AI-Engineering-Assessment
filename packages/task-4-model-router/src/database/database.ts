import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';

export interface SqliteDatabaseOptions {
  readonly dbPath: string;
  readonly busyTimeoutMs?: number;
}

function loadSchemaSql(): string {
  const adjacentPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
  if (existsSync(adjacentPath)) {
    return readFileSync(adjacentPath, 'utf8');
  }

  const fallbackSrcPath = resolve(
    dirname(adjacentPath),
    '..',
    '..',
    'src',
    'database',
    'schema.sql',
  );
  return readFileSync(fallbackSrcPath, 'utf8');
}

export const DEFAULT_ROUTER_DB_PATH = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  'data',
  'model-router.sqlite',
);

/**
 * Opens an on-disk SQLite database configured for concurrent gateway workloads:
 * - WAL journal mode for concurrent readers and low-latency commits
 * - Busy timeout to coordinate lock acquisition cleanly
 * - Foreign key enforcement enabled
 * - Strict relational schema initialization
 */
export function openRouterDatabase(options: SqliteDatabaseOptions): BetterSqliteDatabase {
  const resolvedPath = resolve(options.dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;

  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  const schemaSql = loadSchemaSql();
  db.exec(schemaSql);

  return db;
}
