/**
 * Claude Usage Leaderboard - Cloudflare Worker
 *
 * KV Keys:
 *   users            -> JSON array of { id, name, team, numPlans }
 *   usage:{id}       -> JSON { sessionPct, weeklyPct, timestamp, source }
 *   history:{id}     -> JSON array of { sessionPct, weeklyPct, timestamp, sessionSlot, source } (capped at 500)
 *   weekly:{id}      -> JSON array of { weekKey, peakSessionPct, avgSessionPct, peakWeeklyPct, avgWeeklyPct, dataPoints, lastUpdated } (capped at 52)
 *   userconfig:{id}  -> JSON { weekStartDay }
 *   config           -> JSON { planCost }
 */

// ============================================================
// Session & Week helpers
// ============================================================

/** Compute session slot string (5-hour windows): "2026-03-15S2" */
function getSessionSlot(timestamp) {
  const d = new Date(timestamp);
  const slot = Math.floor(d.getUTCHours() / 5); // 0-4
  return d.toISOString().slice(0, 10) + 'S' + slot;
}

/** Compute week key (ISO date of week start) respecting user's weekStartDay */
function getWeekKey(timestamp, weekStartDay = 'monday') {
  const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const startDayNum = dayMap[weekStartDay.toLowerCase()] || 1;
  const d = new Date(timestamp);
  const currentDay = d.getUTCDay();
  const diff = (currentDay - startDayNum + 7) % 7;
  const weekStart = new Date(d);
  weekStart.setUTCDate(weekStart.getUTCDate() - diff);
  weekStart.setUTCHours(0, 0, 0, 0);
  return weekStart.toISOString().slice(0, 10);
}

const MAX_HISTORY = 500;
const MAX_WEEKLY = 52;

/** Normalize old-format history entries ({s, w, t} -> standard format) */
function migrateHistoryEntries(entries) {
  return entries.map(e => {
    if (e.t !== undefined || e.s !== undefined) {
      const ts = e.t || e.timestamp || new Date().toISOString();
      return {
        sessionPct: e.s !== undefined ? e.s : (e.sessionPct || 0),
        weeklyPct: e.w !== undefined ? e.w : (e.weeklyPct || 0),
        timestamp: ts,
        sessionSlot: e.sessionSlot || getSessionSlot(ts),
        source: e.source || 'migrated',
      };
    }
    return e;
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path.startsWith('/api/')) {
        const response = await handleApi(path, request, env, url);
        const newHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
        return new Response(response.body, {
          status: response.status,
          headers: newHeaders,
        });
      }

      return env.ASSETS
        ? env.ASSETS.fetch(request)
        : new Response('Dashboard not found. Deploy static assets.', { status: 404 });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, corsHeaders);
    }
  },
};

async function handleApi(path, request, env, url) {
  const method = request.method;

  if (path === '/api/data' && method === 'GET') return getLeaderboardData(env);
  if (path === '/api/users' && method === 'GET') return getUsers(env);
  if (path === '/api/users' && method === 'POST') return addUser(await request.json(), env);

  // GET/PUT /api/users/:id/config
  if (path.match(/^\/api\/users\/[^/]+\/config$/) && method === 'GET') {
    const id = path.split('/')[3];
    return getUserConfig(id, env);
  }
  if (path.match(/^\/api\/users\/[^/]+\/config$/) && method === 'PUT') {
    const id = path.split('/')[3];
    return setUserConfig(id, await request.json(), env);
  }

  if (path.startsWith('/api/users/') && path.endsWith('/plans') && method === 'POST') {
    const id = path.split('/')[3];
    return addPlans(id, await request.json(), env);
  }

  if (path.startsWith('/api/users/') && method === 'DELETE') {
    const id = path.split('/api/users/')[1];
    return deleteUser(id, env);
  }

  if (path === '/api/usage' && method === 'POST') return logUsage(await request.json(), env);

  // History endpoints
  if (path.match(/^\/api\/history\/[^/]+$/) && method === 'GET') {
    const userId = path.split('/api/history/')[1];
    const limit = parseInt(url.searchParams.get('limit') || '200');
    return getUserHistory(userId, limit, env);
  }
  if (path.match(/^\/api\/weekly\/[^/]+$/) && method === 'GET') {
    const userId = path.split('/api/weekly/')[1];
    const limit = parseInt(url.searchParams.get('limit') || '26');
    return getUserWeekly(userId, limit, env);
  }

  // Team history endpoints
  if (path.match(/^\/api\/team-history\/[^/]+$/) && method === 'GET') {
    const team = decodeURIComponent(path.split('/api/team-history/')[1]);
    const limit = parseInt(url.searchParams.get('limit') || '200');
    return getTeamHistory(team, limit, env);
  }
  if (path.match(/^\/api\/team-weekly\/[^/]+$/) && method === 'GET') {
    const team = decodeURIComponent(path.split('/api/team-weekly/')[1]);
    const limit = parseInt(url.searchParams.get('limit') || '26');
    return getTeamWeekly(team, limit, env);
  }

  if (path === '/api/import' && method === 'POST') return importData(await request.json(), env);
  if (path === '/api/export' && method === 'GET') return exportData(env);

  return jsonResponse({ error: 'Not found' }, 404);
}

// ============================================================
// User config
// ============================================================

async function getUserConfig(id, env) {
  const config = await kvGet(env, `userconfig:${id}`, { weekStartDay: 'monday' });
  return jsonResponse(config);
}

async function setUserConfig(id, body, env) {
  const existing = await kvGet(env, `userconfig:${id}`, { weekStartDay: 'monday' });
  if (body.weekStartDay) existing.weekStartDay = body.weekStartDay.toLowerCase();
  await kvPut(env, `userconfig:${id}`, existing);
  return jsonResponse({ ok: true, ...existing });
}

// ============================================================
// Users
// ============================================================

async function getUsers(env) {
  return jsonResponse(await kvGet(env, 'users', []));
}

async function addUser(body, env) {
  const { name, team, numPlans = 1 } = body;
  if (!name || !team) return jsonResponse({ error: 'name and team required' }, 400);

  const users = await kvGet(env, 'users', []);
  const id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  users.push({ id, name, team, numPlans: parseInt(numPlans) || 1 });
  await kvPut(env, 'users', users);
  return jsonResponse({ id, name, team, numPlans });
}

async function deleteUser(id, env) {
  let users = await kvGet(env, 'users', []);
  const user = users.find(u => u.id === id);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  users = users.filter(u => u.id !== id);
  await kvPut(env, 'users', users);
  // Clean up all related keys
  await Promise.all([
    env.LEADERBOARD_KV.delete(`usage:${id}`),
    env.LEADERBOARD_KV.delete(`history:${id}`),
    env.LEADERBOARD_KV.delete(`weekly:${id}`),
    env.LEADERBOARD_KV.delete(`userconfig:${id}`),
  ]);
  return jsonResponse({ ok: true, removed: user.name });
}

// ============================================================
// Log Usage (with history recording & monotonic increase)
// ============================================================

async function logUsage(body, env) {
  const { userId, name, sessionPct, weeklyPct, pct, source = 'manual', sessionResetsAt, weeklyResetsAt } = body;

  const users = await kvGet(env, 'users', []);
  let user;
  if (userId) user = users.find(u => u.id === userId);
  else if (name) user = users.find(u => u.name.toLowerCase() === name.toLowerCase());

  // Auto-create user if not found (from extension/bookmarklet sync)
  if (!user && name) {
    const team = body.team || 'NY';
    const id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    user = { id, name, team, numPlans: 1 };
    users.push(user);
    await kvPut(env, 'users', users);
  }
  if (!user) return jsonResponse({ error: 'User not found. Provide a name to auto-register.' }, 404);

  // Get existing usage to preserve values not being updated
  const existing = await kvGet(env, `usage:${user.id}`, {});

  let newSessionPct = sessionPct !== undefined ? parseFloat(sessionPct) : (existing.sessionPct || 0);
  let newWeeklyPct = weeklyPct !== undefined ? parseFloat(weeklyPct) : (pct !== undefined ? parseFloat(pct) : (existing.weeklyPct || 0));

  // Backwards compat: if only `pct` was sent (old bookmarklet), treat as weeklyPct
  if (pct !== undefined && weeklyPct === undefined && sessionPct === undefined) {
    newWeeklyPct = parseFloat(pct);
  }

  const now = new Date().toISOString();
  const currentSlot = getSessionSlot(now);

  // --- Monotonic increase within same session slot ---
  // Load history to check current slot values
  let history = await kvGet(env, `history:${user.id}`, []);

  // Migrate old-format history entries
  history = migrateHistoryEntries(history);

  // Lazy migration: seed history with existing usage if empty
  if (history.length === 0 && existing.timestamp) {
    history.push({
      sessionPct: existing.sessionPct || 0,
      weeklyPct: existing.weeklyPct || 0,
      timestamp: existing.timestamp,
      sessionSlot: getSessionSlot(existing.timestamp),
      source: existing.source || 'manual',
    });
  }

  const lastEntry = history.length > 0 ? history[history.length - 1] : null;

  if (lastEntry && lastEntry.sessionSlot === currentSlot) {
    // Same session slot: only allow increase (monotonic)
    newSessionPct = Math.max(newSessionPct, lastEntry.sessionPct || 0);
    newWeeklyPct = Math.max(newWeeklyPct, lastEntry.weeklyPct || 0);
    // Update in place
    lastEntry.sessionPct = newSessionPct;
    lastEntry.weeklyPct = newWeeklyPct;
    lastEntry.timestamp = now;
    lastEntry.source = source;
  } else {
    // New session slot: append
    history.push({
      sessionPct: newSessionPct,
      weeklyPct: newWeeklyPct,
      timestamp: now,
      sessionSlot: currentSlot,
      source,
    });
  }

  // Trim history to max entries
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }

  // --- Infer reset times from usage drops (fallback when extension doesn't provide them) ---
  let inferredSessionResetsAt = existing.sessionResetsAt || null;
  let inferredWeeklyResetsAt = existing.weeklyResetsAt || null;
  let sessionResetSource = existing.sessionResetSource || null;
  let weeklyResetSource = existing.weeklyResetSource || null;

  if (sessionResetsAt) {
    // Extension provided real data
    inferredSessionResetsAt = sessionResetsAt;
    sessionResetSource = 'extension';
  } else if (sessionPct !== undefined && existing.sessionPct !== undefined) {
    // Detect session reset: usage dropped = new session started
    if (parseFloat(sessionPct) < (existing.sessionPct || 0) - 1) {
      // New session just started, estimate reset at now + 5 hours
      inferredSessionResetsAt = new Date(Date.now() + 5 * 3600000).toISOString();
      sessionResetSource = 'estimated';
    }
  }

  if (weeklyResetsAt) {
    inferredWeeklyResetsAt = weeklyResetsAt;
    weeklyResetSource = 'extension';
  } else if (weeklyPct !== undefined && existing.weeklyPct !== undefined) {
    // Detect weekly reset: weekly usage dropped = new week started
    if (parseFloat(weeklyPct) < (existing.weeklyPct || 0) - 1) {
      inferredWeeklyResetsAt = new Date(Date.now() + 7 * 86400000).toISOString();
      weeklyResetSource = 'estimated';
    }
  }

  const usageData = {
    userId: user.id,
    sessionPct: newSessionPct,
    weeklyPct: newWeeklyPct,
    timestamp: now,
    source,
    sessionResetsAt: inferredSessionResetsAt,
    weeklyResetsAt: inferredWeeklyResetsAt,
    sessionResetSource,
    weeklyResetSource,
  };

  // Update weekly aggregation
  const userConfig = await kvGet(env, `userconfig:${user.id}`, { weekStartDay: 'monday' });
  const currentWeekKey = getWeekKey(now, userConfig.weekStartDay);
  let weeklyHistory = await kvGet(env, `weekly:${user.id}`, []);
  weeklyHistory = updateWeeklyAggregation(weeklyHistory, history, currentWeekKey, userConfig.weekStartDay, now);

  // Write all data
  await Promise.all([
    kvPut(env, `usage:${user.id}`, usageData),
    kvPut(env, `history:${user.id}`, history),
    kvPut(env, `weekly:${user.id}`, weeklyHistory),
  ]);

  return jsonResponse({ ok: true, user: user.name, ...usageData });
}

/** Recompute weekly aggregation for the current week from session history */
function updateWeeklyAggregation(weeklyHistory, sessionHistory, currentWeekKey, weekStartDay, now) {
  // Find entries in session history that belong to the current week
  const weekEntries = sessionHistory.filter(e => {
    return getWeekKey(e.timestamp, weekStartDay) === currentWeekKey;
  });

  if (weekEntries.length === 0) return weeklyHistory;

  const peakSessionPct = Math.max(...weekEntries.map(e => e.sessionPct || 0));
  const avgSessionPct = weekEntries.reduce((s, e) => s + (e.sessionPct || 0), 0) / weekEntries.length;
  const peakWeeklyPct = Math.max(...weekEntries.map(e => e.weeklyPct || 0));
  const avgWeeklyPct = weekEntries.reduce((s, e) => s + (e.weeklyPct || 0), 0) / weekEntries.length;

  const weekRecord = {
    weekKey: currentWeekKey,
    peakSessionPct: Math.round(peakSessionPct * 100) / 100,
    avgSessionPct: Math.round(avgSessionPct * 100) / 100,
    peakWeeklyPct: Math.round(peakWeeklyPct * 100) / 100,
    avgWeeklyPct: Math.round(avgWeeklyPct * 100) / 100,
    dataPoints: weekEntries.length,
    lastUpdated: now,
  };

  // Upsert into weekly history
  const existingIdx = weeklyHistory.findIndex(w => w.weekKey === currentWeekKey);
  if (existingIdx >= 0) {
    weeklyHistory[existingIdx] = weekRecord;
  } else {
    weeklyHistory.push(weekRecord);
  }

  // Sort by weekKey and trim
  weeklyHistory.sort((a, b) => a.weekKey.localeCompare(b.weekKey));
  if (weeklyHistory.length > MAX_WEEKLY) {
    weeklyHistory = weeklyHistory.slice(weeklyHistory.length - MAX_WEEKLY);
  }

  return weeklyHistory;
}

// ============================================================
// Plans
// ============================================================

async function addPlans(id, body, env) {
  const users = await kvGet(env, 'users', []);
  const user = users.find(u => u.id === id);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  user.numPlans += parseInt(body.count) || 1;
  await kvPut(env, 'users', users);
  return jsonResponse({ ok: true, name: user.name, numPlans: user.numPlans });
}

// ============================================================
// Leaderboard data (with sparklines)
// ============================================================

async function getLeaderboardData(env) {
  const users = await kvGet(env, 'users', []);
  const planCost = parseInt(env.PLAN_COST || '200');

  const board = await Promise.all(users.map(async (u) => {
    const [usage, history] = await Promise.all([
      kvGet(env, `usage:${u.id}`, null),
      kvGet(env, `history:${u.id}`, []),
    ]);
    const budget = u.numPlans * planCost;

    // Build sparkline from last 20 session history entries (migrate old format)
    const migrated = migrateHistoryEntries(history);
    const sparklineEntries = migrated.slice(-20);
    const sessionSparkline = sparklineEntries.map(e => e.sessionPct || 0);
    const weeklySparkline = sparklineEntries.map(e => e.weeklyPct || 0);

    return {
      ...u,
      budget,
      sessionPct: usage ? (usage.sessionPct || 0) : 0,
      weeklyPct: usage ? (usage.weeklyPct || usage.pct || 0) : 0,
      lastUpdated: usage ? usage.timestamp : null,
      source: usage ? usage.source : null,
      sessionSparkline,
      weeklySparkline,
      sessionResetsAt: usage ? (usage.sessionResetsAt || null) : null,
      weeklyResetsAt: usage ? (usage.weeklyResetsAt || null) : null,
      sessionResetSource: usage ? (usage.sessionResetSource || null) : null,
      weeklyResetSource: usage ? (usage.weeklyResetSource || null) : null,
    };
  }));

  function teamStats(teamUsers) {
    return {
      members: teamUsers.length,
      avgSessionPct: teamUsers.length > 0 ? teamUsers.reduce((s, u) => s + u.sessionPct, 0) / teamUsers.length : 0,
      avgWeeklyPct: teamUsers.length > 0 ? teamUsers.reduce((s, u) => s + u.weeklyPct, 0) / teamUsers.length : 0,
    };
  }

  return jsonResponse({
    users: board,
    stats: {
      totalUsers: board.length,
      totalBudget: board.reduce((s, u) => s + u.budget, 0),
      avgSessionPct: board.length > 0 ? board.reduce((s, u) => s + u.sessionPct, 0) / board.length : 0,
      avgWeeklyPct: board.length > 0 ? board.reduce((s, u) => s + u.weeklyPct, 0) / board.length : 0,
    },
    teams: {
      NY: teamStats(board.filter(u => u.team === 'NY')),
      NC: teamStats(board.filter(u => u.team === 'NC')),
      Xyne: teamStats(board.filter(u => u.team === 'Xyne')),
      HS: teamStats(board.filter(u => u.team === 'HS')),
      JP: teamStats(board.filter(u => u.team === 'JP')),
    },
    updatedAt: new Date().toISOString(),
  });
}

// ============================================================
// History & Weekly endpoints
// ============================================================

async function getUserHistory(userId, limit, env) {
  const history = migrateHistoryEntries(await kvGet(env, `history:${userId}`, []));
  return jsonResponse(history.slice(-limit));
}

async function getUserWeekly(userId, limit, env) {
  const weekly = await kvGet(env, `weekly:${userId}`, []);
  return jsonResponse(weekly.slice(-limit));
}

async function getTeamHistory(teamName, limit, env) {
  const users = await kvGet(env, 'users', []);
  const teamUsers = users.filter(u => u.team === teamName);
  if (teamUsers.length === 0) return jsonResponse([]);

  // Fetch all team members' histories (migrate old format)
  const histories = await Promise.all(
    teamUsers.map(async u => migrateHistoryEntries(await kvGet(env, `history:${u.id}`, [])))
  );

  // Aggregate by session slot: average across members
  const slotMap = {};
  for (const hist of histories) {
    for (const entry of hist) {
      if (!slotMap[entry.sessionSlot]) {
        slotMap[entry.sessionSlot] = { sessionPcts: [], weeklyPcts: [], timestamp: entry.timestamp };
      }
      slotMap[entry.sessionSlot].sessionPcts.push(entry.sessionPct || 0);
      slotMap[entry.sessionSlot].weeklyPcts.push(entry.weeklyPct || 0);
      // Keep the latest timestamp
      if (entry.timestamp > slotMap[entry.sessionSlot].timestamp) {
        slotMap[entry.sessionSlot].timestamp = entry.timestamp;
      }
    }
  }

  const aggregated = Object.entries(slotMap)
    .map(([slot, data]) => ({
      sessionSlot: slot,
      sessionPct: Math.round(data.sessionPcts.reduce((a, b) => a + b, 0) / data.sessionPcts.length * 100) / 100,
      weeklyPct: Math.round(data.weeklyPcts.reduce((a, b) => a + b, 0) / data.weeklyPcts.length * 100) / 100,
      memberCount: data.sessionPcts.length,
      timestamp: data.timestamp,
    }))
    .sort((a, b) => a.sessionSlot.localeCompare(b.sessionSlot))
    .slice(-limit);

  return jsonResponse(aggregated);
}

async function getTeamWeekly(teamName, limit, env) {
  const users = await kvGet(env, 'users', []);
  const teamUsers = users.filter(u => u.team === teamName);
  if (teamUsers.length === 0) return jsonResponse([]);

  const weeklies = await Promise.all(
    teamUsers.map(u => kvGet(env, `weekly:${u.id}`, []))
  );

  // Aggregate by weekKey
  const weekMap = {};
  for (const weekly of weeklies) {
    for (const entry of weekly) {
      if (!weekMap[entry.weekKey]) {
        weekMap[entry.weekKey] = { peakSessions: [], avgSessions: [], peakWeeklies: [], avgWeeklies: [], lastUpdated: entry.lastUpdated };
      }
      weekMap[entry.weekKey].peakSessions.push(entry.peakSessionPct);
      weekMap[entry.weekKey].avgSessions.push(entry.avgSessionPct);
      weekMap[entry.weekKey].peakWeeklies.push(entry.peakWeeklyPct);
      weekMap[entry.weekKey].avgWeeklies.push(entry.avgWeeklyPct);
      if (entry.lastUpdated > weekMap[entry.weekKey].lastUpdated) {
        weekMap[entry.weekKey].lastUpdated = entry.lastUpdated;
      }
    }
  }

  const aggregated = Object.entries(weekMap)
    .map(([weekKey, data]) => ({
      weekKey,
      peakSessionPct: Math.round(Math.max(...data.peakSessions) * 100) / 100,
      avgSessionPct: Math.round(data.avgSessions.reduce((a, b) => a + b, 0) / data.avgSessions.length * 100) / 100,
      peakWeeklyPct: Math.round(Math.max(...data.peakWeeklies) * 100) / 100,
      avgWeeklyPct: Math.round(data.avgWeeklies.reduce((a, b) => a + b, 0) / data.avgWeeklies.length * 100) / 100,
      memberCount: data.avgSessions.length,
      lastUpdated: data.lastUpdated,
    }))
    .sort((a, b) => a.weekKey.localeCompare(b.weekKey))
    .slice(-limit);

  return jsonResponse(aggregated);
}

// ============================================================
// Import / Export (includes history)
// ============================================================

async function importData(body, env) {
  const { users: importedUsers = [], usageLogs = [], historyLogs = [], weeklyLogs = [], userConfigs = [] } = body;

  // Merge: never remove existing users, only add/update
  const existing = await kvGet(env, 'users', []);
  const existingMap = new Map(existing.map(u => [u.id, u]));
  for (const u of importedUsers) {
    existingMap.set(u.id, u);
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

  return jsonResponse({ ok: true, imported: importedUsers.length, total: merged.length });
}

async function exportData(env) {
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

// ============================================================
// Helpers
// ============================================================

async function kvGet(env, key, defaultVal) {
  const val = await env.LEADERBOARD_KV.get(key, 'json');
  return val !== null ? val : defaultVal;
}

async function kvPut(env, key, val) {
  await env.LEADERBOARD_KV.put(key, JSON.stringify(val));
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
