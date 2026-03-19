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
 *
 * Auth: Cloudflare Access (Zero Trust) gates all requests at the edge.
 *       Worker verifies CF-Access-JWT-Assertion as defense in depth.
 *       Allowed email domains: @juspay.in, @nammayatri.in
 *
 * Environment variables needed:
 *   CF_ACCESS_TEAM_DOMAIN  - Your Cloudflare Access team domain (e.g. "myteam" for myteam.cloudflareaccess.com)
 *   CF_ACCESS_AUD          - The Application Audience (AUD) tag from Access app config
 */

// ============================================================
// Cloudflare Access JWT verification
// ============================================================

const ALLOWED_EMAIL_DOMAINS = ['juspay.in', 'nammayatri.in'];

/**
 * Verify Cloudflare Access authentication.
 *
 * Supports two auth methods:
 * 1. Browser: CF-Access-JWT-Assertion header (set by CF Access after login)
 * 2. Extension/API: CF-Access-Client-Id + CF-Access-Client-Secret headers (service token)
 *
 * If CF_ACCESS_AUD is not configured, verification is skipped (local dev mode).
 */
async function verifyAccessJWT(request, env) {
  const aud = env.CF_ACCESS_AUD;

  // Skip verification if Access is not configured (local dev)
  if (!aud) {
    return { valid: true, email: 'dev@localhost', skipped: true };
  }

  // Browser/Extension JWT auth — check header first, then cookie
  let jwt = request.headers.get('CF-Access-JWT-Assertion') || '';
  if (!jwt) {
    // Browser fetch() sends the JWT as CF_Authorization cookie, not a header
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/CF_Authorization=([^\s;]+)/);
    if (match) jwt = match[1];
  }
  if (!jwt) {
    return { valid: false, error: 'Authentication required. Please sign in via Cloudflare Access.' };
  }

  try {
    // Decode JWT payload (middle part) without full crypto verification.
    // Cloudflare Access at the edge already verified the signature;
    // we validate claims as defense in depth.
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWT format' };
    }

    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Access token expired. Please re-authenticate.' };
    }

    // Check audience
    if (payload.aud && Array.isArray(payload.aud)) {
      if (!payload.aud.includes(aud)) {
        return { valid: false, error: 'Invalid token audience' };
      }
    }

    // Check email domain
    const email = payload.email || '';
    const domain = email.split('@')[1] || '';
    if (!ALLOWED_EMAIL_DOMAINS.includes(domain.toLowerCase())) {
      return { valid: false, error: `Email domain @${domain} is not allowed. Only @juspay.in and @nammayatri.in are permitted.` };
    }

    return { valid: true, email };
  } catch (err) {
    return { valid: false, error: 'Failed to verify access token: ' + err.message };
  }
}

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
const CACHE_TTL_MS = 60_000; // 60s cache for leaderboard data
const VALID_TEAMS = ['NY', 'NC', 'Xyne', 'HS', 'JP'];
const VALID_SOURCES = ['manual', 'extension', 'console', 'api'];

/** Strip HTML tags and dangerous characters from user-supplied strings */
function sanitizeString(str, maxLen = 50) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

/** Validate team against allowlist */
function sanitizeTeam(team) {
  if (typeof team !== 'string') return 'NY';
  const match = VALID_TEAMS.find(t => t.toLowerCase() === team.toLowerCase());
  return match || 'NY';
}

/** Validate source against allowlist */
function sanitizeSource(source) {
  if (typeof source !== 'string') return 'manual';
  return VALID_SOURCES.includes(source) ? source : 'manual';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const ALLOWED_ORIGINS = [
      'https://leaderboard.magizhan.work',
      'https://claude-leaderboard.mags-814.workers.dev',
      'https://claude.ai',
    ];
    const origin = request.headers.get('Origin') || '';
    // Allow chrome-extension:// origins (extension popup/content scripts)
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin
      : origin.startsWith('chrome-extension://') ? origin
      : ALLOWED_ORIGINS[0];
    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, CF-Access-JWT-Assertion',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Skip JWT verification for POST /api/usage — this endpoint is called
    // by the extension's sendBeacon from claude.ai. CF Access Bypass policy
    // lets it through, so we accept the data without a JWT.
    const isPublicUsageEndpoint = path === '/api/usage' && request.method === 'POST';

    // Verify Cloudflare Access JWT on all other requests (defense in depth)
    const auth = isPublicUsageEndpoint
      ? { valid: true, email: 'anonymous@extension', skipped: true }
      : await verifyAccessJWT(request, env);
    if (!auth.valid) {
      return jsonResponse({ error: auth.error }, 403, corsHeaders);
    }

    try {
      if (path.startsWith('/api/')) {
        const response = await handleApi(path, request, env, url, auth);
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

async function handleApi(path, request, env, url, auth) {
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

  if (path === '/api/usage' && method === 'POST') {
    // Accept text/plain (from sendBeacon) or application/json
    const ct = request.headers.get('content-type') || '';
    let body;
    if (ct.includes('application/json')) {
      body = await request.json();
    } else {
      const text = await request.text();
      try { body = JSON.parse(text); } catch (e) { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    }
    return logUsage(body, env);
  }

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

  // Projects & Strategies CRUD
  if (path === '/api/projects' && method === 'GET') return jsonResponse(await kvGet(env, 'projects', []));
  if (path === '/api/projects' && method === 'POST') {
    const body = await request.json();
    const projects = await kvGet(env, 'projects', []);
    const id = body.id || ('proj_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5));
    const project = { id, name: sanitizeString(body.name, 100), lead: sanitizeString(body.lead, 50), description: sanitizeString(body.description, 500), status: body.status || 'In Progress', link: sanitizeString(body.link, 200), dateAdded: new Date().toISOString().slice(0, 10) };
    if (!project.name) return jsonResponse({ error: 'Project name required' }, 400);
    projects.push(project);
    await kvPut(env, 'projects', projects);
    return jsonResponse({ ok: true, ...project });
  }
  if (path.match(/^\/api\/projects\/[^/]+$/) && method === 'PUT') {
    const id = path.split('/api/projects/')[1];
    const body = await request.json();
    const projects = await kvGet(env, 'projects', []);
    const proj = projects.find(p => p.id === id);
    if (!proj) return jsonResponse({ error: 'Project not found' }, 404);
    if (body.name) proj.name = sanitizeString(body.name, 100);
    if (body.lead) proj.lead = sanitizeString(body.lead, 50);
    if (body.description) proj.description = sanitizeString(body.description, 500);
    if (body.status) proj.status = body.status;
    if (body.link) proj.link = sanitizeString(body.link, 200);
    await kvPut(env, 'projects', projects);
    return jsonResponse({ ok: true, ...proj });
  }
  if (path.match(/^\/api\/projects\/[^/]+$/) && method === 'DELETE') {
    const id = path.split('/api/projects/')[1];
    let projects = await kvGet(env, 'projects', []);
    const removed = projects.find(p => p.id === id);
    if (!removed) return jsonResponse({ error: 'Project not found' }, 404);
    projects = projects.filter(p => p.id !== id);
    await kvPut(env, 'projects', projects);
    return jsonResponse({ ok: true, removed: removed.name });
  }

  if (path === '/api/strategies' && method === 'GET') return jsonResponse(await kvGet(env, 'strategies', []));
  if (path === '/api/strategies' && method === 'POST') {
    const body = await request.json();
    const strategies = await kvGet(env, 'strategies', []);
    const id = body.id || ('strat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5));
    const strategy = { id, title: sanitizeString(body.title, 100), type: body.type || 'technique', description: sanitizeString(body.description, 500), impact: body.impact || 'medium', example: sanitizeString(body.example, 300), dateAdded: new Date().toISOString().slice(0, 10) };
    if (!strategy.title) return jsonResponse({ error: 'Strategy title required' }, 400);
    strategies.push(strategy);
    await kvPut(env, 'strategies', strategies);
    return jsonResponse({ ok: true, ...strategy });
  }
  if (path.match(/^\/api\/strategies\/[^/]+$/) && method === 'PUT') {
    const id = path.split('/api/strategies/')[1];
    const body = await request.json();
    const strategies = await kvGet(env, 'strategies', []);
    const strat = strategies.find(s => s.id === id);
    if (!strat) return jsonResponse({ error: 'Strategy not found' }, 404);
    if (body.title) strat.title = sanitizeString(body.title, 100);
    if (body.type) strat.type = body.type;
    if (body.description) strat.description = sanitizeString(body.description, 500);
    if (body.impact) strat.impact = body.impact;
    if (body.example) strat.example = sanitizeString(body.example, 300);
    await kvPut(env, 'strategies', strategies);
    return jsonResponse({ ok: true, ...strat });
  }
  if (path.match(/^\/api\/strategies\/[^/]+$/) && method === 'DELETE') {
    const id = path.split('/api/strategies/')[1];
    let strategies = await kvGet(env, 'strategies', []);
    const removed = strategies.find(s => s.id === id);
    if (!removed) return jsonResponse({ error: 'Strategy not found' }, 404);
    strategies = strategies.filter(s => s.id !== id);
    await kvPut(env, 'strategies', strategies);
    return jsonResponse({ ok: true, removed: removed.title });
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
// Users
// ============================================================

async function getUsers(env) {
  return jsonResponse(await kvGet(env, 'users', []));
}

async function addUser(body, env) {
  const name = sanitizeString(body.name);
  const team = sanitizeTeam(body.team);
  const numPlans = Math.max(1, Math.min(100, parseInt(body.numPlans) || 1));
  if (!name) return jsonResponse({ error: 'name and team required' }, 400);

  const users = await kvGet(env, 'users', []);
  const id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  users.push({ id, name, team, numPlans });
  await kvPut(env, 'users', users);
  invalidateLeaderboardCache(env);
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
  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, removed: user.name });
}

// ============================================================
// Log Usage (with history recording & monotonic increase)
// ============================================================

async function logUsage(body, env) {
  const { userId, sessionPct, weeklyPct, pct, sessionResetsAt, weeklyResetsAt, extraUsageSpent, extraUsageLimit, extraUsagePct, planType, extensionVersion } = body;
  const name = body.name ? sanitizeString(body.name) : undefined;
  const source = sanitizeSource(body.source);

  const users = await kvGet(env, 'users', []);
  let user;
  if (userId) user = users.find(u => u.id === userId);
  else if (name) user = users.find(u => u.name.toLowerCase() === name.toLowerCase());

  // Auto-create user if not found (from extension/bookmarklet sync)
  if (!user && name) {
    const team = sanitizeTeam(body.team);
    const id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    user = { id, name, team, numPlans: 1 };
    users.push(user);
    await kvPut(env, 'users', users);
  }
  if (!user) return jsonResponse({ error: 'User not found. Provide a name to auto-register.' }, 404);

  // Update team if extension sends a different one
  if (body.team) {
    const newTeam = sanitizeTeam(body.team);
    if (newTeam !== user.team) {
      user.team = newTeam;
      await kvPut(env, 'users', users);
    }
  }

  // Get existing usage record
  const existing = await kvGet(env, `usage:${user.id}`, {});
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const numPlans = user.numPlans || 1;

  // --- Migrate old flat format to per-plan format ---
  let plans = existing.plans ? existing.plans.map(p => ({ ...p })) : null;
  let activePlan = existing.activePlan || 0;

  if (!plans) {
    // Migration: create plans array from flat fields
    // Strip weeklyBaseline and cap at 100 (old hack inflated values)
    const rawWeekly = (existing.weeklyPct || 0) - (existing.weeklyBaseline || 0);
    const migrated = {
      sessionPct: Math.min(existing.sessionPct || 0, 100),
      weeklyPct: Math.max(0, Math.min(rawWeekly, 100)),
      sessionResetsAt: existing.sessionResetsAt || null,
      weeklyResetsAt: existing.weeklyResetsAt || null,
      planType: existing.planType || null,
      extraUsageSpent: existing.extraUsageSpent || null,
      extraUsageLimit: existing.extraUsageLimit || null,
      extraUsagePct: existing.extraUsagePct || null,
      lastSyncAt: existing.timestamp || null,
    };
    plans = [migrated];
    // Pad to numPlans
    while (plans.length < numPlans) {
      plans.push({
        sessionPct: 0, weeklyPct: 0,
        sessionResetsAt: null, weeklyResetsAt: null,
        planType: null, extraUsageSpent: null, extraUsageLimit: null, extraUsagePct: null,
        lastSyncAt: null,
      });
    }
    activePlan = 0;
  }

  // Ensure plans array matches numPlans (pad if user added plans)
  while (plans.length < numPlans) {
    plans.push({
      sessionPct: 0, weeklyPct: 0,
      sessionResetsAt: null, weeklyResetsAt: null,
      planType: null, extraUsageSpent: null, extraUsageLimit: null, extraUsagePct: null,
      lastSyncAt: null,
    });
  }

  // --- Parse incoming values ---
  let incomingSession = sessionPct !== undefined ? parseFloat(sessionPct) : undefined;
  let incomingWeekly = weeklyPct !== undefined ? parseFloat(weeklyPct) : (pct !== undefined ? parseFloat(pct) : undefined);

  // Backwards compat: if only `pct` was sent (old bookmarklet), treat as weeklyPct
  if (pct !== undefined && weeklyPct === undefined && sessionPct === undefined) {
    incomingWeekly = parseFloat(pct);
  }

  // Clamp individual plan values to 0-100
  if (incomingSession !== undefined) incomingSession = Math.max(0, Math.min(100, isNaN(incomingSession) ? 0 : incomingSession));
  if (incomingWeekly !== undefined) incomingWeekly = Math.max(0, Math.min(100, isNaN(incomingWeekly) ? 0 : incomingWeekly));

  // --- Determine if timers expired (check active plan's timers) ---
  const activePlanData = plans[activePlan] || plans[0];
  const sessionExpired = activePlanData.sessionResetsAt && new Date(activePlanData.sessionResetsAt).getTime() <= nowMs;
  const weeklyExpired = activePlanData.weeklyResetsAt && new Date(activePlanData.weeklyResetsAt).getTime() <= nowMs;

  // --- Weekly reset: zero ALL plan slots ---
  if (weeklyExpired) {
    for (const p of plans) {
      p.weeklyPct = 0;
    }
  }

  // --- Plan switch detection (numPlans > 1) ---
  if (numPlans > 1 && incomingWeekly !== undefined) {
    const prevWeekly = activePlanData.weeklyPct || 0;
    const prevExtra = activePlanData.extraUsageSpent || 0;
    const prevWeeklyReset = activePlanData.weeklyResetsAt || '';
    const inExtra = extraUsageSpent !== undefined ? parseFloat(extraUsageSpent) : prevExtra;
    const inWeeklyReset = weeklyResetsAt || prevWeeklyReset;

    // Signals that this is a different plan:
    // 1. Weekly dropped significantly (but timer not expired)
    const weeklyDropped = incomingWeekly < prevWeekly - 5 && !weeklyExpired;
    // 2. Extra usage changed significantly (different $ amount)
    const extraChanged = Math.abs(inExtra - prevExtra) > 20;
    // 3. Weekly reset timer is different (different plans have different schedules)
    const resetDiffers = inWeeklyReset && prevWeeklyReset &&
      inWeeklyReset !== prevWeeklyReset &&
      Math.abs(new Date(inWeeklyReset).getTime() - new Date(prevWeeklyReset).getTime()) > 3600000;
    // 4. Session fresh (0%) while weekly jumped up (switched to a more-used plan)
    const sessionFreshWeeklyJumped = incomingSession <= 1 && incomingWeekly > prevWeekly + 20;

    const isPlanSwitch = weeklyDropped || (extraChanged && resetDiffers) || sessionFreshWeeklyJumped;

    if (isPlanSwitch) {
      // Find best matching plan slot
      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < plans.length; i++) {
        if (i === activePlan) continue;
        const diff = Math.abs(plans[i].weeklyPct - incomingWeekly);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      }
      // If no close match (diff > 20), use LRU (oldest lastSyncAt)
      if (bestIdx === -1 || bestDiff > 20) {
        let lruIdx = -1, lruTime = Infinity;
        for (let i = 0; i < plans.length; i++) {
          if (i === activePlan) continue;
          const t = plans[i].lastSyncAt ? new Date(plans[i].lastSyncAt).getTime() : 0;
          if (t < lruTime) { lruTime = t; lruIdx = i; }
        }
        if (lruIdx >= 0) bestIdx = lruIdx;
      }
      if (bestIdx >= 0) activePlan = bestIdx;
    }
  }

  // Get the plan slot we're updating
  const plan = plans[activePlan] || plans[0];

  // --- Monotonic increase within same session (using history) ---
  let history = await kvGet(env, `history:${user.id}`, []);
  const currentSlot = getSessionSlot(now);

  // Lazy migration: seed history with existing usage if empty
  if (history.length === 0 && existing.timestamp) {
    history.push({
      sessionPct: existing.sessionPct || existing.combinedSessionPct || 0,
      weeklyPct: existing.weeklyPct || existing.combinedWeeklyPct || 0,
      timestamp: existing.timestamp,
      sessionSlot: getSessionSlot(existing.timestamp),
      source: existing.source || 'manual',
    });
  }

  const lastEntry = history.length > 0 ? history[history.length - 1] : null;

  // Update active plan's values
  if (incomingSession !== undefined) {
    if (sessionExpired) {
      plan.sessionPct = incomingSession;
    } else if (lastEntry && lastEntry.sessionSlot === currentSlot) {
      // Same session slot: enforce monotonic increase for active plan only
      plan.sessionPct = Math.max(incomingSession, plan.sessionPct || 0);
    } else {
      plan.sessionPct = incomingSession;
    }
  }

  if (incomingWeekly !== undefined) {
    if (weeklyExpired) {
      // Already zeroed above; set to incoming
      plan.weeklyPct = incomingWeekly;
    } else if (lastEntry && lastEntry.sessionSlot === currentSlot) {
      // Same session slot: enforce monotonic increase for active plan only
      plan.weeklyPct = Math.max(incomingWeekly, plan.weeklyPct || 0);
    } else {
      plan.weeklyPct = incomingWeekly;
    }
  }

  // --- Update plan metadata ---
  if (sessionResetsAt) plan.sessionResetsAt = sessionResetsAt;
  if (weeklyResetsAt) plan.weeklyResetsAt = weeklyResetsAt;
  if (planType) plan.planType = planType;
  if (extraUsageSpent !== undefined) plan.extraUsageSpent = parseFloat(extraUsageSpent);
  if (extraUsageLimit !== undefined) plan.extraUsageLimit = parseFloat(extraUsageLimit);
  if (extraUsagePct !== undefined) plan.extraUsagePct = parseFloat(extraUsagePct);
  plan.lastSyncAt = now;

  // Cap per-plan values at 100 (single plan can't exceed its own limit)
  plan.sessionPct = Math.min(plan.sessionPct || 0, 100);
  plan.weeklyPct = Math.min(plan.weeklyPct || 0, 100);

  // --- Compute combined totals ---
  // sessionPct = active plan's session (only one session active at a time)
  const combinedSessionPct = plan.sessionPct || 0;
  // weeklyPct = sum of all plans' weekly
  const combinedWeeklyPct = plans.reduce((sum, p) => sum + (p.weeklyPct || 0), 0);
  // totalExtraUsageSpent = sum of all plans
  const totalExtraUsageSpent = plans.reduce((sum, p) => sum + (p.extraUsageSpent || 0), 0);

  // --- Infer reset times (from active plan) ---
  let sessionResetSource = existing.sessionResetSource || null;
  let weeklyResetSource = existing.weeklyResetSource || null;

  if (sessionResetsAt) {
    sessionResetSource = 'extension';
  } else if (incomingSession !== undefined && existing.plans) {
    const prevSession = (existing.plans[existing.activePlan || 0] || {}).sessionPct || 0;
    if (incomingSession < prevSession - 1) {
      plan.sessionResetsAt = new Date(nowMs + 5 * 3600000).toISOString();
      sessionResetSource = 'estimated';
    }
  }

  if (weeklyResetsAt) {
    weeklyResetSource = 'extension';
  } else if (incomingWeekly !== undefined && existing.plans) {
    const prevWeekly = (existing.plans[existing.activePlan || 0] || {}).weeklyPct || 0;
    if (incomingWeekly < prevWeekly - 1 && weeklyExpired) {
      plan.weeklyResetsAt = new Date(nowMs + 7 * 86400000).toISOString();
      weeklyResetSource = 'estimated';
    }
  }

  // --- Update history (store active plan's raw values, not combined) ---
  let histSessionPct = plan.sessionPct || 0;
  let histWeeklyPct = plan.weeklyPct || 0;

  const sessionDroppedHist = lastEntry && histSessionPct < (lastEntry.sessionPct || 0) - 1;
  const weeklyDroppedHist = lastEntry && histWeeklyPct < (lastEntry.weeklyPct || 0) - 1;
  const sessionResetHist = sessionDroppedHist && sessionExpired;
  const weeklyResetHist = weeklyDroppedHist && weeklyExpired;

  if (lastEntry && !sessionResetHist && !weeklyResetHist && lastEntry.sessionSlot === currentSlot) {
    histSessionPct = Math.max(combinedSessionPct, lastEntry.sessionPct || 0);
    histWeeklyPct = Math.max(combinedWeeklyPct, lastEntry.weeklyPct || 0);
    lastEntry.sessionPct = histSessionPct;
    lastEntry.weeklyPct = histWeeklyPct;
    lastEntry.timestamp = now;
    lastEntry.source = source;
  } else {
    if (sessionResetHist && !weeklyResetHist && lastEntry) {
      histWeeklyPct = Math.max(combinedWeeklyPct, lastEntry.weeklyPct || 0);
    }
    history.push({
      sessionPct: histSessionPct,
      weeklyPct: histWeeklyPct,
      timestamp: now,
      sessionSlot: currentSlot,
      source,
    });
  }

  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }

  // --- Build usage data ---
  const usageData = {
    userId: user.id,
    activePlan,
    plans,
    combinedSessionPct,
    combinedWeeklyPct,
    totalExtraUsageSpent,
    // Top-level backward compat fields
    sessionPct: combinedSessionPct,
    weeklyPct: combinedWeeklyPct,
    timestamp: now,
    source,
    sessionResetsAt: plan.sessionResetsAt || null,
    weeklyResetsAt: plan.weeklyResetsAt || null,
    sessionResetSource,
    weeklyResetSource,
    planType: plan.planType || null,
    extraUsageSpent: plan.extraUsageSpent || null,
    extraUsageLimit: plan.extraUsageLimit || null,
    extraUsagePct: plan.extraUsagePct || null,
    extensionVersion: extensionVersion || existing.extensionVersion || null,
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
  invalidateLeaderboardCache(env);

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

  const count = Math.max(1, Math.min(100, parseInt(body.count) || 1));
  user.numPlans = Math.min(user.numPlans + count, 999);
  await kvPut(env, 'users', users);
  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, name: user.name, numPlans: user.numPlans });
}

// ============================================================
// Leaderboard data (with sparklines)
// ============================================================

async function getLeaderboardData(env) {
  // Check KV cache first
  const cached = await kvGet(env, '_cache:leaderboard', null);
  if (cached && cached._cachedAt && (Date.now() - cached._cachedAt) < CACHE_TTL_MS) {
    return jsonResponse(cached.data);
  }

  const users = await kvGet(env, 'users', []);
  const planCost = parseInt(env.PLAN_COST || '200');

  const nowMs = Date.now();

  const board = await Promise.all(users.map(async (u) => {
    const [usage, history] = await Promise.all([
      kvGet(env, `usage:${u.id}`, null),
      kvGet(env, `history:${u.id}`, []),
    ]);
    const budget = u.numPlans * planCost;

    // Build sparkline from last 20 session history entries
    const sparklineEntries = history.slice(-20);
    const sessionSparkline = sparklineEntries.map(e => e.sessionPct || 0);
    const weeklySparkline = sparklineEntries.map(e => e.weeklyPct || 0);

    // Read combined values (new format) or fall back to flat fields (unmigrated)
    let displaySessionPct = usage
      ? (usage.combinedSessionPct !== undefined ? usage.combinedSessionPct : (usage.sessionPct || 0))
      : 0;
    let displayWeeklyPct = usage
      ? (usage.combinedWeeklyPct !== undefined ? usage.combinedWeeklyPct : (usage.weeklyPct || usage.pct || 0))
      : 0;

    // Auto-reset: if session timer expired, show 0 for combined session
    if (usage && usage.sessionResetsAt && new Date(usage.sessionResetsAt).getTime() <= nowMs) {
      displaySessionPct = 0;
    }
    if (usage && usage.weeklyResetsAt && new Date(usage.weeklyResetsAt).getTime() <= nowMs) {
      displayWeeklyPct = 0;
    }

    // Determine planType from active plan or top-level
    let activePlanType = null;
    if (usage && usage.plans && usage.plans.length > 0) {
      const ap = usage.plans[usage.activePlan || 0];
      activePlanType = ap ? (ap.planType || null) : null;
    } else if (usage) {
      activePlanType = usage.planType || null;
    }

    return {
      ...u,
      budget,
      sessionPct: displaySessionPct,
      weeklyPct: displayWeeklyPct,
      lastUpdated: usage ? usage.timestamp : null,
      source: usage ? usage.source : null,
      sessionSparkline,
      weeklySparkline,
      sessionResetsAt: usage ? (usage.sessionResetsAt || null) : null,
      weeklyResetsAt: usage ? (usage.weeklyResetsAt || null) : null,
      sessionResetSource: usage ? (usage.sessionResetSource || null) : null,
      weeklyResetSource: usage ? (usage.weeklyResetSource || null) : null,
      extraUsageSpent: usage ? (usage.totalExtraUsageSpent || usage.extraUsageSpent || null) : null,
      extraUsageLimit: usage ? (usage.extraUsageLimit || null) : null,
      extraUsagePct: usage ? (usage.extraUsagePct || null) : null,
      planType: activePlanType,
      extensionVersion: usage ? (usage.extensionVersion || null) : null,
      plans: usage ? (usage.plans || null) : null,
    };
  }));

  function teamStats(teamUsers) {
    return {
      members: teamUsers.length,
      avgSessionPct: teamUsers.length > 0 ? teamUsers.reduce((s, u) => s + u.sessionPct, 0) / teamUsers.length : 0,
      avgWeeklyPct: teamUsers.length > 0 ? teamUsers.reduce((s, u) => s + u.weeklyPct, 0) / teamUsers.length : 0,
    };
  }

  const result = {
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
  };

  // Cache in KV (fire-and-forget)
  kvPut(env, '_cache:leaderboard', { data: result, _cachedAt: Date.now() });

  return jsonResponse(result);
}

// ============================================================
// History & Weekly endpoints
// ============================================================

async function getUserHistory(userId, limit, env) {
  const history = await kvGet(env, `history:${userId}`, []);
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

  // Fetch all team members' histories
  const histories = await Promise.all(
    teamUsers.map(u => kvGet(env, `history:${u.id}`, []))
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

async function kvPut(env, key, val, { allowShrink = false } = {}) {
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
function invalidateLeaderboardCache(env) {
  env.LEADERBOARD_KV.delete('_cache:leaderboard');
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
