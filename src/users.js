import { kvGet, kvPut, invalidateLeaderboardCache, jsonResponse, sanitizeString, sanitizeTeam } from './helpers.js';

// ============================================================
// User config
// ============================================================

export async function getUserConfig(id, env) {
  const config = await kvGet(env, `userconfig:${id}`, { weekStartDay: 'monday' });
  return jsonResponse(config);
}

export async function setUserConfig(id, body, env) {
  const existing = await kvGet(env, `userconfig:${id}`, { weekStartDay: 'monday' });
  const validDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  if (body.weekStartDay && validDays.includes(body.weekStartDay.toLowerCase())) {
    existing.weekStartDay = body.weekStartDay.toLowerCase();
  }
  // Allow setting numPlans via config endpoint
  if (body.numPlans !== undefined) {
    const numPlans = Math.max(1, Math.min(10, parseInt(body.numPlans) || 1));
    const users = await kvGet(env, 'users', []);
    const user = users.find(u => u.id === id);
    if (user) {
      user.numPlans = numPlans;
      await kvPut(env, 'users', users);
      invalidateLeaderboardCache(env);
    }
  }
  await kvPut(env, `userconfig:${id}`, existing);
  return jsonResponse({ ok: true, ...existing });
}

// ============================================================
// Users CRUD
// ============================================================

export async function getUsers(env) {
  return jsonResponse(await kvGet(env, 'users', []));
}

export async function addUser(body, env) {
  const name = sanitizeString(body.name);
  const team = sanitizeTeam(body.team);
  const numPlans = Math.max(1, Math.min(100, parseInt(body.numPlans) || 1));
  if (!name) return jsonResponse({ error: 'name and team required' }, 400);

  const users = await kvGet(env, 'users', []);
  if (users.some(u => u.name.toLowerCase() === name.toLowerCase())) {
    return jsonResponse({ error: 'User with this name already exists' }, 409);
  }
  const id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  users.push({ id, name, team, numPlans });
  await kvPut(env, 'users', users);
  invalidateLeaderboardCache(env);
  return jsonResponse({ id, name, team, numPlans });
}

export async function updateUser(id, body, env) {
  const users = await kvGet(env, 'users', []);
  const user = users.find(u => u.id === id);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  let changed = false;
  if (body.team) {
    const newTeam = sanitizeTeam(body.team);
    if (newTeam !== user.team) { user.team = newTeam; changed = true; }
  }
  if (body.name) {
    const newName = sanitizeString(body.name);
    if (newName && newName !== user.name) { user.name = newName; changed = true; }
  }
  if (body.numPlans !== undefined) {
    const n = Math.max(1, Math.min(10, parseInt(body.numPlans) || 1));
    if (n !== user.numPlans) { user.numPlans = n; changed = true; }
  }

  if (changed) {
    await kvPut(env, 'users', users);
    invalidateLeaderboardCache(env);
  }
  return jsonResponse({ ok: true, user });
}

export async function deleteUser(id, env) {
  let users = await kvGet(env, 'users', []);
  const user = users.find(u => u.id === id);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  users = users.filter(u => u.id !== id);
  await kvPut(env, 'users', users, { allowShrink: true });
  // Clean up all related keys
  await Promise.all([
    env.LEADERBOARD_KV.delete(`usage:${id}`),
    env.LEADERBOARD_KV.delete(`history:${id}`),
    env.LEADERBOARD_KV.delete(`weekly:${id}`),
    env.LEADERBOARD_KV.delete(`userconfig:${id}`),
  ]);
  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, removed: user.name });
}

// ============================================================
// Plans
// ============================================================

export async function addPlans(id, body, env) {
  const users = await kvGet(env, 'users', []);
  const user = users.find(u => u.id === id);
  if (!user) return jsonResponse({ error: 'User not found' }, 404);

  const count = Math.max(1, Math.min(100, parseInt(body.count) || 1));
  user.numPlans = Math.min(user.numPlans + count, 999);
  await kvPut(env, 'users', users);
  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, name: user.name, numPlans: user.numPlans });
}
