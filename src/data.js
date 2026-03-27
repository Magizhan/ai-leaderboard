import { kvGet, kvPut, invalidateLeaderboardCache, jsonResponse, sanitizeString, sanitizeTeam } from './helpers.js';

// ============================================================
// Import / Export (includes history)
// ============================================================

export async function importData(body, env) {
  const { users: importedUsers = [], usageLogs = [], historyLogs = [], weeklyLogs = [], userConfigs = [] } = body;

  // Merge: never remove existing users, only add/update
  const existing = await kvGet(env, 'users', []);
  const existingMap = new Map(existing.map(u => [u.id, u]));
  for (const u of importedUsers) {
    u.name = sanitizeString(u.name);
    u.team = sanitizeTeam(u.team);
    u.numPlans = Math.max(1, Math.min(100, parseInt(u.numPlans) || 1));
    if (u.name) existingMap.set(u.id, u);
  }
  const merged = Array.from(existingMap.values());
  await kvPut(env, 'users', merged);

  const writes = [];
  for (const log of usageLogs) {
    if (log.userId) writes.push(kvPut(env, `usage:${log.userId}`, log));
  }
  for (const log of historyLogs) {
    if (log.userId) writes.push(kvPut(env, `history:${log.userId}`, log.entries || []));
  }
  for (const log of weeklyLogs) {
    if (log.userId) writes.push(kvPut(env, `weekly:${log.userId}`, log.entries || []));
  }
  for (const cfg of userConfigs) {
    if (cfg.userId) writes.push(kvPut(env, `userconfig:${cfg.userId}`, cfg.config || { weekStartDay: 'monday' }));
  }
  await Promise.all(writes);

  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, imported: importedUsers.length, total: merged.length });
}

export async function exportData(env) {
  const users = await kvGet(env, 'users', []);
  const usageLogs = [];
  const historyLogs = [];
  const weeklyLogs = [];
  const userConfigs = [];

  await Promise.all(users.map(async (u) => {
    const [usage, history, weekly, config] = await Promise.all([
      kvGet(env, `usage:${u.id}`, null),
      kvGet(env, `history:${u.id}`, []),
      kvGet(env, `weekly:${u.id}`, []),
      kvGet(env, `userconfig:${u.id}`, null),
    ]);
    if (usage) usageLogs.push(usage);
    if (history.length > 0) historyLogs.push({ userId: u.id, entries: history });
    if (weekly.length > 0) weeklyLogs.push({ userId: u.id, entries: weekly });
    if (config) userConfigs.push({ userId: u.id, config });
  }));

  return jsonResponse({ users, usageLogs, historyLogs, weeklyLogs, userConfigs });
}
