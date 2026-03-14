/**
 * Claude Usage Leaderboard - Cloudflare Worker
 *
 * KV Keys:
 *   users       -> JSON array of { id, name, team, numPlans }
 *   usage:{id}  -> JSON { sessionPct, weeklyPct, timestamp, source }
 *   config      -> JSON { planCost }
 */

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
        const response = await handleApi(path, request, env);
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

async function handleApi(path, request, env) {
  const method = request.method;

  if (path === '/api/data' && method === 'GET') return getLeaderboardData(env);
  if (path === '/api/users' && method === 'GET') return getUsers(env);
  if (path === '/api/users' && method === 'POST') return addUser(await request.json(), env);

  if (path.startsWith('/api/users/') && method === 'DELETE') {
    const id = path.split('/api/users/')[1];
    return deleteUser(id, env);
  }

  if (path === '/api/usage' && method === 'POST') return logUsage(await request.json(), env);

  if (path.match(/^\/api\/users\/[^/]+\/plans$/) && method === 'POST') {
    const id = path.split('/')[3];
    return addPlans(id, await request.json(), env);
  }

  if (path === '/api/import' && method === 'POST') return importData(await request.json(), env);
  if (path === '/api/export' && method === 'GET') return exportData(env);

  return jsonResponse({ error: 'Not found' }, 404);
}

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
  await env.LEADERBOARD_KV.delete(`usage:${id}`);
  return jsonResponse({ ok: true, removed: user.name });
}

async function logUsage(body, env) {
  const { userId, name, sessionPct, weeklyPct, pct, source = 'manual' } = body;

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

  const usageData = {
    userId: user.id,
    sessionPct: sessionPct !== undefined ? parseFloat(sessionPct) : (existing.sessionPct || 0),
    weeklyPct: weeklyPct !== undefined ? parseFloat(weeklyPct) : (pct !== undefined ? parseFloat(pct) : (existing.weeklyPct || 0)),
    timestamp: new Date().toISOString(),
    source,
  };

  // Backwards compat: if only `pct` was sent (old bookmarklet), treat as weeklyPct
  if (pct !== undefined && weeklyPct === undefined && sessionPct === undefined) {
    usageData.weeklyPct = parseFloat(pct);
  }

  await kvPut(env, `usage:${user.id}`, usageData);
  return jsonResponse({ ok: true, user: user.name, ...usageData });
}

async function addPlans(id, body, env) {
  const users = await kvGet(env, 'users', []);
  const user = users.find(u => u.id === id);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  user.numPlans += parseInt(body.count) || 1;
  await kvPut(env, 'users', users);
  return jsonResponse({ ok: true, name: user.name, numPlans: user.numPlans });
}

async function getLeaderboardData(env) {
  const users = await kvGet(env, 'users', []);
  const planCost = parseInt(env.PLAN_COST || '200');

  const board = await Promise.all(users.map(async (u) => {
    const usage = await kvGet(env, `usage:${u.id}`, null);
    const budget = u.numPlans * planCost;
    return {
      ...u,
      budget,
      sessionPct: usage ? (usage.sessionPct || 0) : 0,
      weeklyPct: usage ? (usage.weeklyPct || usage.pct || 0) : 0,
      lastUpdated: usage ? usage.timestamp : null,
      source: usage ? usage.source : null,
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
    },
    updatedAt: new Date().toISOString(),
  });
}

async function importData(body, env) {
  const { users: importedUsers = [], usageLogs = [] } = body;

  // Merge: never remove existing users, only add/update
  const existing = await kvGet(env, 'users', []);
  const existingMap = new Map(existing.map(u => [u.id, u]));
  for (const u of importedUsers) {
    existingMap.set(u.id, u);
  }
  const merged = Array.from(existingMap.values());
  await kvPut(env, 'users', merged);

  for (const log of usageLogs) {
    if (log.userId) await kvPut(env, `usage:${log.userId}`, log);
  }
  return jsonResponse({ ok: true, imported: importedUsers.length, total: merged.length });
}

async function exportData(env) {
  const users = await kvGet(env, 'users', []);
  const usageLogs = [];
  for (const u of users) {
    const usage = await kvGet(env, `usage:${u.id}`, null);
    if (usage) usageLogs.push(usage);
  }
  return jsonResponse({ users, usageLogs });
}

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
