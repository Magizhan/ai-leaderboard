#!/usr/bin/env node

/**
 * Migration script: Export data from Cloudflare Worker and import into Redis.
 *
 * Usage:
 *   # Step 1: Export from CF (saves to export.json)
 *   node scripts/migrate-to-redis.mjs export --from https://leaderboard.magizhan.work
 *
 *   # Step 2: Import into Redis
 *   node scripts/migrate-to-redis.mjs import --redis redis://localhost:6379 --file export.json
 *
 *   # Or one-shot: export from CF and import into Redis
 *   node scripts/migrate-to-redis.mjs sync --from https://leaderboard.magizhan.work --redis redis://localhost:6379
 */

import { writeFileSync, readFileSync } from 'fs';

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

async function importToRedis(data, redisUrl) {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(redisUrl);

  console.log(`\nImporting into Redis at ${redisUrl} ...`);

  // Users array
  await redis.set('users', JSON.stringify(data.users || []));
  console.log(`  users: ${data.users?.length || 0} users written`);

  // Usage logs
  for (const log of (data.usageLogs || [])) {
    if (log.userId) {
      await redis.set(`usage:${log.userId}`, JSON.stringify(log));
    }
  }
  console.log(`  usage: ${data.usageLogs?.length || 0} logs written`);

  // History logs
  for (const log of (data.historyLogs || [])) {
    if (log.userId) {
      await redis.set(`history:${log.userId}`, JSON.stringify(log.entries || []));
    }
  }
  console.log(`  history: ${data.historyLogs?.length || 0} logs written`);

  // Weekly logs
  for (const log of (data.weeklyLogs || [])) {
    if (log.userId) {
      await redis.set(`weekly:${log.userId}`, JSON.stringify(log.entries || []));
    }
  }
  console.log(`  weekly: ${data.weeklyLogs?.length || 0} logs written`);

  // User configs
  for (const cfg of (data.userConfigs || [])) {
    if (cfg.userId) {
      await redis.set(`userconfig:${cfg.userId}`, JSON.stringify(cfg.config || { weekStartDay: 'monday' }));
    }
  }
  console.log(`  configs: ${data.userConfigs?.length || 0} configs written`);

  // Projects & Strategies (if present in export)
  if (data.projects) {
    await redis.set('projects', JSON.stringify(data.projects));
    console.log(`  projects: ${data.projects.length} written`);
  }
  if (data.strategies) {
    await redis.set('strategies', JSON.stringify(data.strategies));
    console.log(`  strategies: ${data.strategies.length} written`);
  }

  // Config
  if (data.config) {
    await redis.set('config', JSON.stringify(data.config));
    console.log(`  config: written`);
  }

  await redis.quit();
  console.log('\nImport complete!');
}

async function main() {
  if (!command || command === '--help') {
    console.log(`Usage:
  node scripts/migrate-to-redis.mjs export --from <cf-url>
  node scripts/migrate-to-redis.mjs import --redis <redis-url> --file <export.json>
  node scripts/migrate-to-redis.mjs sync --from <cf-url> --redis <redis-url>`);
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
    const redisUrl = getArg('redis') || 'redis://localhost:6379';
    const file = getArg('file') || 'export.json';
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    await importToRedis(data, redisUrl);
  }

  else if (command === 'sync') {
    const from = getArg('from');
    const redisUrl = getArg('redis') || 'redis://localhost:6379';
    if (!from) { console.error('--from <url> required'); process.exit(1); }
    const data = await exportFromCF(from);
    await importToRedis(data, redisUrl);
  }

  else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
