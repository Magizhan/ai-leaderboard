#!/usr/bin/env node

/**
 * Migration script: Export data from Cloudflare Worker and import into PostgreSQL.
 *
 * Usage:
 *   # Step 1: Export from CF (saves to export.json)
 *   node scripts/migrate-to-pg.mjs export --from https://leaderboard.magizhan.work
 *
 *   # Step 2: Import into PostgreSQL
 *   node scripts/migrate-to-pg.mjs import --db postgresql://localhost:5432/ai_leaderboard --file export.json
 *
 *   # Or one-shot: export from CF and import into PostgreSQL
 *   node scripts/migrate-to-pg.mjs sync --from https://leaderboard.magizhan.work --db postgresql://localhost:5432/ai_leaderboard
 */

import { writeFileSync, readFileSync } from 'fs';
import pg from 'pg';

const args = process.argv.slice(2);
const command = args[0];

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

async function exportFromCF(baseUrl) {
  console.log(`Exporting from ${baseUrl}/api/export ...`);
  const res = await fetch(`${baseUrl}/api/export`);
  if (!res.ok) throw new Error(`Export failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  console.log(`  Users: ${data.users?.length || 0}`);
  console.log(`  Usage logs: ${data.usageLogs?.length || 0}`);
  console.log(`  History logs: ${data.historyLogs?.length || 0}`);
  console.log(`  Weekly logs: ${data.weeklyLogs?.length || 0}`);
  console.log(`  User configs: ${data.userConfigs?.length || 0}`);
  return data;
}

async function importToPg(data, dbUrl) {
  const pool = new pg.Pool({ connectionString: dbUrl });

  // Create table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL
    )
  `);

  console.log(`\nImporting into PostgreSQL at ${dbUrl} ...`);

  async function upsert(key, val) {
    await pool.query(
      'INSERT INTO kv_store (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(val)]
    );
  }

  // Users array
  await upsert('users', data.users || []);
  console.log(`  users: ${data.users?.length || 0} users written`);

  // Usage logs
  for (const log of (data.usageLogs || [])) {
    if (log.userId) await upsert(`usage:${log.userId}`, log);
  }
  console.log(`  usage: ${data.usageLogs?.length || 0} logs written`);

  // History logs
  for (const log of (data.historyLogs || [])) {
    if (log.userId) await upsert(`history:${log.userId}`, log.entries || []);
  }
  console.log(`  history: ${data.historyLogs?.length || 0} logs written`);

  // Weekly logs
  for (const log of (data.weeklyLogs || [])) {
    if (log.userId) await upsert(`weekly:${log.userId}`, log.entries || []);
  }
  console.log(`  weekly: ${data.weeklyLogs?.length || 0} logs written`);

  // User configs
  for (const cfg of (data.userConfigs || [])) {
    if (cfg.userId) await upsert(`userconfig:${cfg.userId}`, cfg.config || { weekStartDay: 'monday' });
  }
  console.log(`  configs: ${data.userConfigs?.length || 0} configs written`);

  // Projects & Strategies
  if (data.projects) {
    await upsert('projects', data.projects);
    console.log(`  projects: ${data.projects.length} written`);
  }
  if (data.strategies) {
    await upsert('strategies', data.strategies);
    console.log(`  strategies: ${data.strategies.length} written`);
  }

  // Config
  if (data.config) {
    await upsert('config', data.config);
    console.log(`  config: written`);
  }

  await pool.end();
  console.log('\nImport complete!');
}

async function main() {
  if (!command || command === '--help') {
    console.log(`Usage:
  node scripts/migrate-to-pg.mjs export --from <cf-url>
  node scripts/migrate-to-pg.mjs import --db <database-url> --file <export.json>
  node scripts/migrate-to-pg.mjs sync --from <cf-url> --db <database-url>`);
    process.exit(0);
  }

  if (command === 'export') {
    const from = getArg('from');
    if (!from) { console.error('--from <url> required'); process.exit(1); }
    const data = await exportFromCF(from);
    const outFile = getArg('file') || 'export.json';
    writeFileSync(outFile, JSON.stringify(data, null, 2));
    console.log(`\nSaved to ${outFile}`);
  }

  else if (command === 'import') {
    const dbUrl = getArg('db') || 'postgresql://localhost:5432/ai_leaderboard';
    const file = getArg('file') || 'export.json';
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    await importToPg(data, dbUrl);
  }

  else if (command === 'sync') {
    const from = getArg('from');
    const dbUrl = getArg('db') || 'postgresql://localhost:5432/ai_leaderboard';
    if (!from) { console.error('--from <url> required'); process.exit(1); }
    const data = await exportFromCF(from);
    await importToPg(data, dbUrl);
  }

  else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
