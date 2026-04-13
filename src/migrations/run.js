import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Run all .sql migration files in order on boot.
 * Every migration must be idempotent (use IF NOT EXISTS, etc.)
 * so re-running is always safe.
 */
export async function runMigrations(pool) {
  const files = readdirSync(__dirname)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.join(__dirname, file), 'utf-8');
    await pool.query(sql);
    console.log(`  migration: ${file}`);
  }
}
