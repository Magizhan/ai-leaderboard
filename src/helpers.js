// ============================================================
// Constants
// ============================================================

export const MAX_HISTORY = 500;
export const MAX_WEEKLY = 52;
export const CACHE_TTL_MS = 60_000; // 60s cache for leaderboard data
export const VALID_TEAMS = ['NY', 'NC', 'Xyne', 'HS', 'JP'];
export const VALID_SOURCES = ['manual', 'extension', 'console', 'api'];

// ============================================================
// Session & Week helpers
// ============================================================

/** Compute session slot string (5-hour windows): "2026-03-15S2" */
export function getSessionSlot(timestamp) {
  const d = new Date(timestamp);
  const slot = Math.floor(d.getUTCHours() / 5); // 0-4
  return d.toISOString().slice(0, 10) + 'S' + slot;
}

/** Compute week key (ISO date of week start) respecting user's weekStartDay */
export function getWeekKey(timestamp, weekStartDay = 'monday') {
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

// ============================================================
// Sanitizers
// ============================================================

/** Strip HTML tags and dangerous characters from user-supplied strings */
export function sanitizeString(str, maxLen = 50) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

/** Validate team against allowlist */
export function sanitizeTeam(team) {
  if (typeof team !== 'string') return 'NC';
  const match = VALID_TEAMS.find(t => t.toLowerCase() === team.toLowerCase());
  return match || 'NC';
}

/** Validate source against allowlist */
export function sanitizeSource(source) {
  if (typeof source !== 'string') return 'manual';
  return VALID_SOURCES.includes(source) ? source : 'manual';
}

// ============================================================
// KV helpers
// ============================================================

export async function kvGet(env, key, defaultVal) {
  const val = await env.LEADERBOARD_KV.get(key, 'json');
  return val !== null ? val : defaultVal;
}

export async function kvPut(env, key, val, { allowShrink = false } = {}) {
  // Safety: never shrink the users array by more than 1 (prevents accidental data loss from stale writes)
  // allowShrink=true is used by deleteUser (intentional single removal)
  if (key === 'users' && Array.isArray(val) && !allowShrink) {
    const existing = await kvGet(env, 'users', []);
    if (val.length < existing.length - 1) {
      // Lost more than 1 user — merge to prevent data loss
      const valMap = new Map(val.map(u => [u.id, u]));
      const merged = existing.map(u => valMap.get(u.id) || u);
      const existingIds = new Set(existing.map(u => u.id));
      val.forEach(u => { if (!existingIds.has(u.id)) merged.push(u); });
      val = merged;
    }
  }
  await env.LEADERBOARD_KV.put(key, JSON.stringify(val));
}

/** Invalidate leaderboard cache — call after any data mutation */
export function invalidateLeaderboardCache(env) {
  env.LEADERBOARD_KV.delete('_cache:leaderboard');
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
