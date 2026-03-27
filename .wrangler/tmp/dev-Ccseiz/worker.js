var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var ALLOWED_EMAIL_DOMAINS = ["juspay.in", "nammayatri.in"];
async function verifyAccessJWT(request, env) {
  const aud = env.CF_ACCESS_AUD;
  if (!aud) {
    return { valid: true, email: "dev@localhost", skipped: true };
  }
  let jwt = request.headers.get("CF-Access-JWT-Assertion") || "";
  if (!jwt) {
    const cookieHeader = request.headers.get("Cookie") || "";
    const match = cookieHeader.match(/CF_Authorization=([^\s;]+)/);
    if (match) jwt = match[1];
  }
  if (!jwt) {
    return { valid: false, error: "Authentication required. Please sign in via Cloudflare Access." };
  }
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) {
      return { valid: false, error: "Invalid JWT format" };
    }
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    const now = Math.floor(Date.now() / 1e3);
    if (payload.exp && payload.exp < now) {
      return { valid: false, error: "Access token expired. Please re-authenticate." };
    }
    if (payload.aud && Array.isArray(payload.aud)) {
      if (!payload.aud.includes(aud)) {
        return { valid: false, error: "Invalid token audience" };
      }
    }
    const email = payload.email || "";
    const domain = email.split("@")[1] || "";
    if (!ALLOWED_EMAIL_DOMAINS.includes(domain.toLowerCase())) {
      return { valid: false, error: `Email domain @${domain} is not allowed. Only @juspay.in and @nammayatri.in are permitted.` };
    }
    return { valid: true, email };
  } catch (err) {
    return { valid: false, error: "Failed to verify access token: " + err.message };
  }
}
__name(verifyAccessJWT, "verifyAccessJWT");
function getSessionSlot(timestamp) {
  const d = new Date(timestamp);
  const slot = Math.floor(d.getUTCHours() / 5);
  return d.toISOString().slice(0, 10) + "S" + slot;
}
__name(getSessionSlot, "getSessionSlot");
function getWeekKey(timestamp, weekStartDay = "monday") {
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
__name(getWeekKey, "getWeekKey");
var MAX_HISTORY = 500;
var MAX_WEEKLY = 52;
var CACHE_TTL_MS = 6e4;
var VALID_TEAMS = ["NY", "NC", "Xyne", "HS", "JP"];
var VALID_SOURCES = ["manual", "extension", "console", "api"];
function sanitizeString(str, maxLen = 50) {
  if (typeof str !== "string") return "";
  return str.replace(/<[^>]*>/g, "").replace(/[<>"'`]/g, "").trim().slice(0, maxLen);
}
__name(sanitizeString, "sanitizeString");
function sanitizeTeam(team) {
  if (typeof team !== "string") return "NC";
  const match = VALID_TEAMS.find((t) => t.toLowerCase() === team.toLowerCase());
  return match || "NC";
}
__name(sanitizeTeam, "sanitizeTeam");
function sanitizeSource(source) {
  if (typeof source !== "string") return "manual";
  return VALID_SOURCES.includes(source) ? source : "manual";
}
__name(sanitizeSource, "sanitizeSource");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const ALLOWED_ORIGINS = [
      "https://leaderboard.magizhan.work",
      "https://claude-leaderboard.mags-814.workers.dev",
      "https://claude.ai"
    ];
    const origin = request.headers.get("Origin") || "";
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : origin.startsWith("chrome-extension://") ? origin : ALLOWED_ORIGINS[0];
    const corsHeaders = {
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, CF-Access-JWT-Assertion"
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const isPublicUsageEndpoint = path === "/api/usage" && request.method === "POST";
    const auth = isPublicUsageEndpoint ? { valid: true, email: "anonymous@extension", skipped: true } : await verifyAccessJWT(request, env);
    if (!auth.valid) {
      return jsonResponse({ error: auth.error }, 403, corsHeaders);
    }
    try {
      if (path.startsWith("/api/")) {
        const response = await handleApi(path, request, env, url, auth);
        const newHeaders = new Headers(response.headers);
        Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
        return new Response(response.body, {
          status: response.status,
          headers: newHeaders
        });
      }
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Dashboard not found. Deploy static assets.", { status: 404 });
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, corsHeaders);
    }
  }
};
async function handleApi(path, request, env, url, auth) {
  const method = request.method;
  if (path === "/api/data" && method === "GET") return getLeaderboardData(env);
  if (path === "/api/users" && method === "GET") return getUsers(env);
  if (path === "/api/users" && method === "POST") return addUser(await request.json(), env);
  if (path.match(/^\/api\/users\/[^/]+\/config$/) && method === "GET") {
    const id = path.split("/")[3];
    return getUserConfig(id, env);
  }
  if (path.match(/^\/api\/users\/[^/]+\/config$/) && method === "PUT") {
    const id = path.split("/")[3];
    return setUserConfig(id, await request.json(), env);
  }
  if (path.startsWith("/api/users/") && path.endsWith("/plans") && method === "POST") {
    const id = path.split("/")[3];
    return addPlans(id, await request.json(), env);
  }
  if (path.startsWith("/api/users/") && method === "DELETE") {
    const id = path.split("/api/users/")[1];
    return deleteUser(id, env);
  }
  if (path.match(/^\/api\/users\/[^/]+$/) && method === "PATCH") {
    const id = path.split("/api/users/")[1];
    return updateUser(id, await request.json(), env);
  }
  if (path === "/api/usage" && method === "POST") {
    const ct = request.headers.get("content-type") || "";
    let body;
    if (ct.includes("application/json")) {
      body = await request.json();
    } else {
      const text = await request.text();
      try {
        body = JSON.parse(text);
      } catch (e) {
        return jsonResponse({ error: "Invalid JSON" }, 400);
      }
    }
    return logUsage(body, env);
  }
  if (path.match(/^\/api\/history\/[^/]+$/) && method === "GET") {
    const userId = path.split("/api/history/")[1];
    const limit = parseInt(url.searchParams.get("limit") || "200");
    return getUserHistory(userId, limit, env);
  }
  if (path.match(/^\/api\/weekly\/[^/]+$/) && method === "GET") {
    const userId = path.split("/api/weekly/")[1];
    const limit = parseInt(url.searchParams.get("limit") || "26");
    return getUserWeekly(userId, limit, env);
  }
  if (path.match(/^\/api\/team-history\/[^/]+$/) && method === "GET") {
    const team = decodeURIComponent(path.split("/api/team-history/")[1]);
    const limit = parseInt(url.searchParams.get("limit") || "200");
    return getTeamHistory(team, limit, env);
  }
  if (path.match(/^\/api\/team-weekly\/[^/]+$/) && method === "GET") {
    const team = decodeURIComponent(path.split("/api/team-weekly/")[1]);
    const limit = parseInt(url.searchParams.get("limit") || "26");
    return getTeamWeekly(team, limit, env);
  }
  if (path === "/api/projects" && method === "GET") return jsonResponse(await kvGet(env, "projects", []));
  if (path === "/api/projects" && method === "POST") {
    const body = await request.json();
    const projects = await kvGet(env, "projects", []);
    const id = body.id || "proj_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 5);
    const project = { id, name: sanitizeString(body.name, 100), lead: sanitizeString(body.lead, 50), description: sanitizeString(body.description, 500), status: body.status || "In Progress", link: sanitizeString(body.link, 200), dateAdded: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) };
    if (!project.name) return jsonResponse({ error: "Project name required" }, 400);
    projects.push(project);
    await kvPut(env, "projects", projects);
    return jsonResponse({ ok: true, ...project });
  }
  if (path.match(/^\/api\/projects\/[^/]+$/) && method === "PUT") {
    const id = path.split("/api/projects/")[1];
    const body = await request.json();
    const projects = await kvGet(env, "projects", []);
    const proj = projects.find((p) => p.id === id);
    if (!proj) return jsonResponse({ error: "Project not found" }, 404);
    if (body.name) proj.name = sanitizeString(body.name, 100);
    if (body.lead) proj.lead = sanitizeString(body.lead, 50);
    if (body.description) proj.description = sanitizeString(body.description, 500);
    if (body.status) proj.status = body.status;
    if (body.link) proj.link = sanitizeString(body.link, 200);
    await kvPut(env, "projects", projects);
    return jsonResponse({ ok: true, ...proj });
  }
  if (path.match(/^\/api\/projects\/[^/]+$/) && method === "DELETE") {
    const id = path.split("/api/projects/")[1];
    let projects = await kvGet(env, "projects", []);
    const removed = projects.find((p) => p.id === id);
    if (!removed) return jsonResponse({ error: "Project not found" }, 404);
    projects = projects.filter((p) => p.id !== id);
    await kvPut(env, "projects", projects);
    return jsonResponse({ ok: true, removed: removed.name });
  }
  if (path === "/api/strategies" && method === "GET") return jsonResponse(await kvGet(env, "strategies", []));
  if (path === "/api/strategies" && method === "POST") {
    const body = await request.json();
    const strategies = await kvGet(env, "strategies", []);
    const id = body.id || "strat_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 5);
    const strategy = { id, title: sanitizeString(body.title, 100), type: body.type || "technique", description: sanitizeString(body.description, 500), impact: body.impact || "medium", example: sanitizeString(body.example, 300), dateAdded: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) };
    if (!strategy.title) return jsonResponse({ error: "Strategy title required" }, 400);
    strategies.push(strategy);
    await kvPut(env, "strategies", strategies);
    return jsonResponse({ ok: true, ...strategy });
  }
  if (path.match(/^\/api\/strategies\/[^/]+$/) && method === "PUT") {
    const id = path.split("/api/strategies/")[1];
    const body = await request.json();
    const strategies = await kvGet(env, "strategies", []);
    const strat = strategies.find((s) => s.id === id);
    if (!strat) return jsonResponse({ error: "Strategy not found" }, 404);
    if (body.title) strat.title = sanitizeString(body.title, 100);
    if (body.type) strat.type = body.type;
    if (body.description) strat.description = sanitizeString(body.description, 500);
    if (body.impact) strat.impact = body.impact;
    if (body.example) strat.example = sanitizeString(body.example, 300);
    await kvPut(env, "strategies", strategies);
    return jsonResponse({ ok: true, ...strat });
  }
  if (path.match(/^\/api\/strategies\/[^/]+$/) && method === "DELETE") {
    const id = path.split("/api/strategies/")[1];
    let strategies = await kvGet(env, "strategies", []);
    const removed = strategies.find((s) => s.id === id);
    if (!removed) return jsonResponse({ error: "Strategy not found" }, 404);
    strategies = strategies.filter((s) => s.id !== id);
    await kvPut(env, "strategies", strategies);
    return jsonResponse({ ok: true, removed: removed.title });
  }
  if (path === "/api/import" && method === "POST") return importData(await request.json(), env);
  if (path === "/api/export" && method === "GET") return exportData(env);
  return jsonResponse({ error: "Not found" }, 404);
}
__name(handleApi, "handleApi");
async function getUserConfig(id, env) {
  const config = await kvGet(env, `userconfig:${id}`, { weekStartDay: "monday" });
  return jsonResponse(config);
}
__name(getUserConfig, "getUserConfig");
async function setUserConfig(id, body, env) {
  const existing = await kvGet(env, `userconfig:${id}`, { weekStartDay: "monday" });
  const validDays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  if (body.weekStartDay && validDays.includes(body.weekStartDay.toLowerCase())) {
    existing.weekStartDay = body.weekStartDay.toLowerCase();
  }
  if (body.numPlans !== void 0) {
    const numPlans = Math.max(1, Math.min(10, parseInt(body.numPlans) || 1));
    const users = await kvGet(env, "users", []);
    const user = users.find((u) => u.id === id);
    if (user) {
      user.numPlans = numPlans;
      await kvPut(env, "users", users);
      invalidateLeaderboardCache(env);
    }
  }
  await kvPut(env, `userconfig:${id}`, existing);
  return jsonResponse({ ok: true, ...existing });
}
__name(setUserConfig, "setUserConfig");
async function getUsers(env) {
  return jsonResponse(await kvGet(env, "users", []));
}
__name(getUsers, "getUsers");
async function addUser(body, env) {
  const name = sanitizeString(body.name);
  const team = sanitizeTeam(body.team);
  const numPlans = Math.max(1, Math.min(100, parseInt(body.numPlans) || 1));
  if (!name) return jsonResponse({ error: "name and team required" }, 400);
  const users = await kvGet(env, "users", []);
  const id = "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
  users.push({ id, name, team, numPlans });
  await kvPut(env, "users", users);
  invalidateLeaderboardCache(env);
  return jsonResponse({ id, name, team, numPlans });
}
__name(addUser, "addUser");
async function updateUser(id, body, env) {
  const users = await kvGet(env, "users", []);
  const user = users.find((u) => u.id === id);
  if (!user) return jsonResponse({ error: "User not found" }, 404);
  let changed = false;
  if (body.team) {
    const newTeam = sanitizeTeam(body.team);
    if (newTeam !== user.team) {
      user.team = newTeam;
      changed = true;
    }
  }
  if (body.name) {
    const newName = sanitizeString(body.name);
    if (newName && newName !== user.name) {
      user.name = newName;
      changed = true;
    }
  }
  if (body.numPlans !== void 0) {
    const n = Math.max(1, Math.min(10, parseInt(body.numPlans) || 1));
    if (n !== user.numPlans) {
      user.numPlans = n;
      changed = true;
    }
  }
  if (changed) {
    await kvPut(env, "users", users);
    invalidateLeaderboardCache(env);
  }
  return jsonResponse({ ok: true, user });
}
__name(updateUser, "updateUser");
async function deleteUser(id, env) {
  let users = await kvGet(env, "users", []);
  const user = users.find((u) => u.id === id);
  if (!user) return jsonResponse({ error: "User not found" }, 404);
  users = users.filter((u) => u.id !== id);
  await kvPut(env, "users", users);
  await Promise.all([
    env.LEADERBOARD_KV.delete(`usage:${id}`),
    env.LEADERBOARD_KV.delete(`history:${id}`),
    env.LEADERBOARD_KV.delete(`weekly:${id}`),
    env.LEADERBOARD_KV.delete(`userconfig:${id}`)
  ]);
  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, removed: user.name });
}
__name(deleteUser, "deleteUser");
async function logUsage(body, env) {
  const { userId, sessionPct, weeklyPct, pct, sessionResetsAt, weeklyResetsAt, extraUsageSpent, extraUsageLimit, extraUsagePct, planType, extensionVersion } = body;
  const name = body.name ? sanitizeString(body.name) : void 0;
  const source = sanitizeSource(body.source);
  const users = await kvGet(env, "users", []);
  let user;
  if (userId) user = users.find((u) => u.id === userId);
  else if (name) user = users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (!user && name) {
    const team = sanitizeTeam(body.team);
    const id = "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    user = { id, name, team, numPlans: 1 };
    users.push(user);
    await kvPut(env, "users", users);
  }
  if (!user) return jsonResponse({ error: "User not found. Provide a name to auto-register." }, 404);
  if (body.team && source !== "extension") {
    const newTeam = sanitizeTeam(body.team);
    if (newTeam !== user.team) {
      user.team = newTeam;
      await kvPut(env, "users", users);
    }
  }
  const existing = await kvGet(env, `usage:${user.id}`, {});
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const nowMs = Date.now();
  const numPlans = user.numPlans || 1;
  let plans = existing.plans ? existing.plans.map((p) => ({ ...p })) : null;
  let activePlan = existing.activePlan || 0;
  if (!plans) {
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
      lastSyncAt: existing.timestamp || null
    };
    plans = [migrated];
    while (plans.length < numPlans) {
      plans.push({
        sessionPct: 0,
        weeklyPct: 0,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        planType: null,
        extraUsageSpent: null,
        extraUsageLimit: null,
        extraUsagePct: null,
        lastSyncAt: null
      });
    }
    activePlan = 0;
  }
  while (plans.length < numPlans) {
    plans.push({
      sessionPct: 0,
      weeklyPct: 0,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      planType: null,
      extraUsageSpent: null,
      extraUsageLimit: null,
      extraUsagePct: null,
      lastSyncAt: null
    });
  }
  let incomingSession = sessionPct !== void 0 ? parseFloat(sessionPct) : void 0;
  let incomingWeekly = weeklyPct !== void 0 ? parseFloat(weeklyPct) : pct !== void 0 ? parseFloat(pct) : void 0;
  if (pct !== void 0 && weeklyPct === void 0 && sessionPct === void 0) {
    incomingWeekly = parseFloat(pct);
  }
  if (incomingSession !== void 0) incomingSession = Math.max(0, Math.min(100, isNaN(incomingSession) ? 0 : incomingSession));
  if (incomingWeekly !== void 0) incomingWeekly = Math.max(0, Math.min(100, isNaN(incomingWeekly) ? 0 : incomingWeekly));
  const activePlanData = plans[activePlan] || plans[0];
  const sessionExpired = activePlanData.sessionResetsAt && new Date(activePlanData.sessionResetsAt).getTime() <= nowMs;
  const weeklyExpired = activePlanData.weeklyResetsAt && new Date(activePlanData.weeklyResetsAt).getTime() <= nowMs;
  if (weeklyExpired) {
    for (const p of plans) {
      p.weeklyPct = 0;
    }
  }
  if (numPlans > 1 && incomingWeekly !== void 0) {
    const prevWeekly = activePlanData.weeklyPct || 0;
    const prevExtra = activePlanData.extraUsageSpent || 0;
    const prevWeeklyReset = activePlanData.weeklyResetsAt || "";
    const inExtra = extraUsageSpent !== void 0 ? parseFloat(extraUsageSpent) : prevExtra;
    const inWeeklyReset = weeklyResetsAt || prevWeeklyReset;
    const weeklyDropped = incomingWeekly < prevWeekly - 5 && !weeklyExpired;
    const extraChanged = Math.abs(inExtra - prevExtra) > 20;
    const resetDiffers = inWeeklyReset && prevWeeklyReset && inWeeklyReset !== prevWeeklyReset && Math.abs(new Date(inWeeklyReset).getTime() - new Date(prevWeeklyReset).getTime()) > 36e5;
    const sessionFreshWeeklyJumped = incomingSession <= 1 && incomingWeekly > prevWeekly + 20;
    const isPlanSwitch = weeklyDropped || extraChanged && resetDiffers || sessionFreshWeeklyJumped;
    if (isPlanSwitch) {
      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < plans.length; i++) {
        if (i === activePlan) continue;
        const diff = Math.abs(plans[i].weeklyPct - incomingWeekly);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      }
      if (bestIdx === -1 || bestDiff > 20) {
        let lruIdx = -1, lruTime = Infinity;
        for (let i = 0; i < plans.length; i++) {
          if (i === activePlan) continue;
          const t = plans[i].lastSyncAt ? new Date(plans[i].lastSyncAt).getTime() : 0;
          if (t < lruTime) {
            lruTime = t;
            lruIdx = i;
          }
        }
        if (lruIdx >= 0) bestIdx = lruIdx;
      }
      if (bestIdx >= 0) activePlan = bestIdx;
    }
  }
  const plan = plans[activePlan] || plans[0];
  let history = await kvGet(env, `history:${user.id}`, []);
  const currentSlot = getSessionSlot(now);
  if (history.length === 0 && existing.timestamp) {
    history.push({
      sessionPct: existing.sessionPct || existing.combinedSessionPct || 0,
      weeklyPct: existing.weeklyPct || existing.combinedWeeklyPct || 0,
      timestamp: existing.timestamp,
      sessionSlot: getSessionSlot(existing.timestamp),
      source: existing.source || "manual"
    });
  }
  const lastEntry = history.length > 0 ? history[history.length - 1] : null;
  if (incomingSession !== void 0) {
    if (sessionExpired) {
      plan.sessionPct = incomingSession;
    } else if (lastEntry && lastEntry.sessionSlot === currentSlot) {
      plan.sessionPct = Math.max(incomingSession, plan.sessionPct || 0);
    } else {
      plan.sessionPct = incomingSession;
    }
  }
  if (incomingWeekly !== void 0) {
    if (weeklyExpired) {
      plan.weeklyPct = incomingWeekly;
    } else if (lastEntry && lastEntry.sessionSlot === currentSlot) {
      plan.weeklyPct = Math.max(incomingWeekly, plan.weeklyPct || 0);
    } else {
      plan.weeklyPct = incomingWeekly;
    }
  }
  if (sessionResetsAt) plan.sessionResetsAt = sessionResetsAt;
  if (weeklyResetsAt) plan.weeklyResetsAt = weeklyResetsAt;
  if (planType) plan.planType = planType;
  if (extraUsageSpent !== void 0) plan.extraUsageSpent = parseFloat(extraUsageSpent);
  if (extraUsageLimit !== void 0) plan.extraUsageLimit = parseFloat(extraUsageLimit);
  if (extraUsagePct !== void 0) plan.extraUsagePct = parseFloat(extraUsagePct);
  plan.lastSyncAt = now;
  plan.sessionPct = Math.min(plan.sessionPct || 0, 100);
  plan.weeklyPct = Math.min(plan.weeklyPct || 0, 100);
  const combinedSessionPct = plan.sessionPct || 0;
  const combinedWeeklyPct = plans.reduce((sum, p) => sum + (p.weeklyPct || 0), 0);
  const totalExtraUsageSpent = plans.reduce((sum, p) => sum + (p.extraUsageSpent || 0), 0);
  let sessionResetSource = existing.sessionResetSource || null;
  let weeklyResetSource = existing.weeklyResetSource || null;
  if (sessionResetsAt) {
    sessionResetSource = "extension";
  } else if (incomingSession !== void 0 && existing.plans) {
    const prevSession = (existing.plans[existing.activePlan || 0] || {}).sessionPct || 0;
    if (incomingSession < prevSession - 1) {
      plan.sessionResetsAt = new Date(nowMs + 5 * 36e5).toISOString();
      sessionResetSource = "estimated";
    }
  }
  if (weeklyResetsAt) {
    weeklyResetSource = "extension";
  } else if (incomingWeekly !== void 0 && existing.plans) {
    const prevWeekly = (existing.plans[existing.activePlan || 0] || {}).weeklyPct || 0;
    if (incomingWeekly < prevWeekly - 1 && weeklyExpired) {
      plan.weeklyResetsAt = new Date(nowMs + 7 * 864e5).toISOString();
      weeklyResetSource = "estimated";
    }
  }
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
      source
    });
  }
  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }
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
    extensionVersion: extensionVersion || existing.extensionVersion || null
  };
  const userConfig = await kvGet(env, `userconfig:${user.id}`, { weekStartDay: "monday" });
  const currentWeekKey = getWeekKey(now, userConfig.weekStartDay);
  let weeklyHistory = await kvGet(env, `weekly:${user.id}`, []);
  weeklyHistory = updateWeeklyAggregation(weeklyHistory, history, currentWeekKey, userConfig.weekStartDay, now);
  await Promise.all([
    kvPut(env, `usage:${user.id}`, usageData),
    kvPut(env, `history:${user.id}`, history),
    kvPut(env, `weekly:${user.id}`, weeklyHistory)
  ]);
  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, user: user.name, ...usageData });
}
__name(logUsage, "logUsage");
function updateWeeklyAggregation(weeklyHistory, sessionHistory, currentWeekKey, weekStartDay, now) {
  const weekEntries = sessionHistory.filter((e) => {
    return getWeekKey(e.timestamp, weekStartDay) === currentWeekKey;
  });
  if (weekEntries.length === 0) return weeklyHistory;
  const peakSessionPct = Math.max(...weekEntries.map((e) => e.sessionPct || 0));
  const avgSessionPct = weekEntries.reduce((s, e) => s + (e.sessionPct || 0), 0) / weekEntries.length;
  const peakWeeklyPct = Math.max(...weekEntries.map((e) => e.weeklyPct || 0));
  const avgWeeklyPct = weekEntries.reduce((s, e) => s + (e.weeklyPct || 0), 0) / weekEntries.length;
  const weekRecord = {
    weekKey: currentWeekKey,
    peakSessionPct: Math.round(peakSessionPct * 100) / 100,
    avgSessionPct: Math.round(avgSessionPct * 100) / 100,
    peakWeeklyPct: Math.round(peakWeeklyPct * 100) / 100,
    avgWeeklyPct: Math.round(avgWeeklyPct * 100) / 100,
    dataPoints: weekEntries.length,
    lastUpdated: now
  };
  const existingIdx = weeklyHistory.findIndex((w) => w.weekKey === currentWeekKey);
  if (existingIdx >= 0) {
    weeklyHistory[existingIdx] = weekRecord;
  } else {
    weeklyHistory.push(weekRecord);
  }
  weeklyHistory.sort((a, b) => a.weekKey.localeCompare(b.weekKey));
  if (weeklyHistory.length > MAX_WEEKLY) {
    weeklyHistory = weeklyHistory.slice(weeklyHistory.length - MAX_WEEKLY);
  }
  return weeklyHistory;
}
__name(updateWeeklyAggregation, "updateWeeklyAggregation");
async function addPlans(id, body, env) {
  const users = await kvGet(env, "users", []);
  const user = users.find((u) => u.id === id);
  if (!user) return jsonResponse({ error: "User not found" }, 404);
  const count = Math.max(1, Math.min(100, parseInt(body.count) || 1));
  user.numPlans = Math.min(user.numPlans + count, 999);
  await kvPut(env, "users", users);
  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, name: user.name, numPlans: user.numPlans });
}
__name(addPlans, "addPlans");
async function getLeaderboardData(env) {
  const cached = await kvGet(env, "_cache:leaderboard", null);
  if (cached && cached._cachedAt && Date.now() - cached._cachedAt < CACHE_TTL_MS) {
    return jsonResponse(cached.data);
  }
  const users = await kvGet(env, "users", []);
  const planCost = parseInt(env.PLAN_COST || "200");
  const nowMs = Date.now();
  const board = await Promise.all(users.map(async (u) => {
    const [usage, history] = await Promise.all([
      kvGet(env, `usage:${u.id}`, null),
      kvGet(env, `history:${u.id}`, [])
    ]);
    const budget = u.numPlans * planCost;
    const sparklineEntries = history.slice(-20);
    const sessionSparkline = sparklineEntries.map((e) => e.sessionPct || 0);
    const weeklySparkline = sparklineEntries.map((e) => e.weeklyPct || 0);
    let displaySessionPct = usage ? usage.combinedSessionPct !== void 0 ? usage.combinedSessionPct : usage.sessionPct || 0 : 0;
    let displayWeeklyPct = usage ? usage.combinedWeeklyPct !== void 0 ? usage.combinedWeeklyPct : usage.weeklyPct || usage.pct || 0 : 0;
    if (usage && usage.sessionResetsAt && new Date(usage.sessionResetsAt).getTime() <= nowMs) {
      displaySessionPct = 0;
    }
    if (usage && usage.weeklyResetsAt && new Date(usage.weeklyResetsAt).getTime() <= nowMs) {
      displayWeeklyPct = 0;
    }
    let activePlanType = null;
    if (usage && usage.plans && usage.plans.length > 0) {
      const ap = usage.plans[usage.activePlan || 0];
      activePlanType = ap ? ap.planType || null : null;
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
      sessionResetsAt: usage ? usage.sessionResetsAt || null : null,
      weeklyResetsAt: usage ? usage.weeklyResetsAt || null : null,
      sessionResetSource: usage ? usage.sessionResetSource || null : null,
      weeklyResetSource: usage ? usage.weeklyResetSource || null : null,
      extraUsageSpent: usage ? usage.totalExtraUsageSpent || usage.extraUsageSpent || null : null,
      extraUsageLimit: usage ? usage.extraUsageLimit || null : null,
      extraUsagePct: usage ? usage.extraUsagePct || null : null,
      planType: activePlanType,
      extensionVersion: usage ? usage.extensionVersion || null : null,
      plans: usage ? usage.plans || null : null
    };
  }));
  function teamStats(teamUsers) {
    return {
      members: teamUsers.length,
      avgSessionPct: teamUsers.length > 0 ? teamUsers.reduce((s, u) => s + u.sessionPct, 0) / teamUsers.length : 0,
      avgWeeklyPct: teamUsers.length > 0 ? teamUsers.reduce((s, u) => s + u.weeklyPct, 0) / teamUsers.length : 0
    };
  }
  __name(teamStats, "teamStats");
  const result = {
    users: board,
    stats: {
      totalUsers: board.length,
      totalBudget: board.reduce((s, u) => s + u.budget, 0),
      avgSessionPct: board.length > 0 ? board.reduce((s, u) => s + u.sessionPct, 0) / board.length : 0,
      avgWeeklyPct: board.length > 0 ? board.reduce((s, u) => s + u.weeklyPct, 0) / board.length : 0
    },
    teams: {
      NY: teamStats(board.filter((u) => u.team === "NY")),
      NC: teamStats(board.filter((u) => u.team === "NC")),
      Xyne: teamStats(board.filter((u) => u.team === "Xyne")),
      HS: teamStats(board.filter((u) => u.team === "HS")),
      JP: teamStats(board.filter((u) => u.team === "JP"))
    },
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  kvPut(env, "_cache:leaderboard", { data: result, _cachedAt: Date.now() });
  return jsonResponse(result);
}
__name(getLeaderboardData, "getLeaderboardData");
async function getUserHistory(userId, limit, env) {
  const history = await kvGet(env, `history:${userId}`, []);
  return jsonResponse(history.slice(-limit));
}
__name(getUserHistory, "getUserHistory");
async function getUserWeekly(userId, limit, env) {
  const weekly = await kvGet(env, `weekly:${userId}`, []);
  return jsonResponse(weekly.slice(-limit));
}
__name(getUserWeekly, "getUserWeekly");
async function getTeamHistory(teamName, limit, env) {
  const users = await kvGet(env, "users", []);
  const teamUsers = users.filter((u) => u.team === teamName);
  if (teamUsers.length === 0) return jsonResponse([]);
  const histories = await Promise.all(
    teamUsers.map((u) => kvGet(env, `history:${u.id}`, []))
  );
  const slotMap = {};
  for (const hist of histories) {
    for (const entry of hist) {
      if (!slotMap[entry.sessionSlot]) {
        slotMap[entry.sessionSlot] = { sessionPcts: [], weeklyPcts: [], timestamp: entry.timestamp };
      }
      slotMap[entry.sessionSlot].sessionPcts.push(entry.sessionPct || 0);
      slotMap[entry.sessionSlot].weeklyPcts.push(entry.weeklyPct || 0);
      if (entry.timestamp > slotMap[entry.sessionSlot].timestamp) {
        slotMap[entry.sessionSlot].timestamp = entry.timestamp;
      }
    }
  }
  const aggregated = Object.entries(slotMap).map(([slot, data]) => ({
    sessionSlot: slot,
    sessionPct: Math.round(data.sessionPcts.reduce((a, b) => a + b, 0) / data.sessionPcts.length * 100) / 100,
    weeklyPct: Math.round(data.weeklyPcts.reduce((a, b) => a + b, 0) / data.weeklyPcts.length * 100) / 100,
    memberCount: data.sessionPcts.length,
    timestamp: data.timestamp
  })).sort((a, b) => a.sessionSlot.localeCompare(b.sessionSlot)).slice(-limit);
  return jsonResponse(aggregated);
}
__name(getTeamHistory, "getTeamHistory");
async function getTeamWeekly(teamName, limit, env) {
  const users = await kvGet(env, "users", []);
  const teamUsers = users.filter((u) => u.team === teamName);
  if (teamUsers.length === 0) return jsonResponse([]);
  const weeklies = await Promise.all(
    teamUsers.map((u) => kvGet(env, `weekly:${u.id}`, []))
  );
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
  const aggregated = Object.entries(weekMap).map(([weekKey, data]) => ({
    weekKey,
    peakSessionPct: Math.round(Math.max(...data.peakSessions) * 100) / 100,
    avgSessionPct: Math.round(data.avgSessions.reduce((a, b) => a + b, 0) / data.avgSessions.length * 100) / 100,
    peakWeeklyPct: Math.round(Math.max(...data.peakWeeklies) * 100) / 100,
    avgWeeklyPct: Math.round(data.avgWeeklies.reduce((a, b) => a + b, 0) / data.avgWeeklies.length * 100) / 100,
    memberCount: data.avgSessions.length,
    lastUpdated: data.lastUpdated
  })).sort((a, b) => a.weekKey.localeCompare(b.weekKey)).slice(-limit);
  return jsonResponse(aggregated);
}
__name(getTeamWeekly, "getTeamWeekly");
async function importData(body, env) {
  const { users: importedUsers = [], usageLogs = [], historyLogs = [], weeklyLogs = [], userConfigs = [] } = body;
  const existing = await kvGet(env, "users", []);
  const existingMap = new Map(existing.map((u) => [u.id, u]));
  for (const u of importedUsers) {
    u.name = sanitizeString(u.name);
    u.team = sanitizeTeam(u.team);
    u.numPlans = Math.max(1, Math.min(100, parseInt(u.numPlans) || 1));
    if (u.name) existingMap.set(u.id, u);
  }
  const merged = Array.from(existingMap.values());
  await kvPut(env, "users", merged);
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
    if (cfg.userId) writes.push(kvPut(env, `userconfig:${cfg.userId}`, cfg.config || { weekStartDay: "monday" }));
  }
  await Promise.all(writes);
  invalidateLeaderboardCache(env);
  return jsonResponse({ ok: true, imported: importedUsers.length, total: merged.length });
}
__name(importData, "importData");
async function exportData(env) {
  const users = await kvGet(env, "users", []);
  const usageLogs = [];
  const historyLogs = [];
  const weeklyLogs = [];
  const userConfigs = [];
  await Promise.all(users.map(async (u) => {
    const [usage, history, weekly, config] = await Promise.all([
      kvGet(env, `usage:${u.id}`, null),
      kvGet(env, `history:${u.id}`, []),
      kvGet(env, `weekly:${u.id}`, []),
      kvGet(env, `userconfig:${u.id}`, null)
    ]);
    if (usage) usageLogs.push(usage);
    if (history.length > 0) historyLogs.push({ userId: u.id, entries: history });
    if (weekly.length > 0) weeklyLogs.push({ userId: u.id, entries: weekly });
    if (config) userConfigs.push({ userId: u.id, config });
  }));
  return jsonResponse({ users, usageLogs, historyLogs, weeklyLogs, userConfigs });
}
__name(exportData, "exportData");
async function kvGet(env, key, defaultVal) {
  const val = await env.LEADERBOARD_KV.get(key, "json");
  return val !== null ? val : defaultVal;
}
__name(kvGet, "kvGet");
async function kvPut(env, key, val, { allowShrink = false } = {}) {
  if (key === "users" && Array.isArray(val) && !allowShrink) {
    const existing = await kvGet(env, "users", []);
    if (val.length < existing.length - 1) {
      const valMap = new Map(val.map((u) => [u.id, u]));
      const merged = existing.map((u) => valMap.get(u.id) || u);
      const existingIds = new Set(existing.map((u) => u.id));
      val.forEach((u) => {
        if (!existingIds.has(u.id)) merged.push(u);
      });
      val = merged;
    }
  }
  await env.LEADERBOARD_KV.put(key, JSON.stringify(val));
}
__name(kvPut, "kvPut");
function invalidateLeaderboardCache(env) {
  env.LEADERBOARD_KV.delete("_cache:leaderboard");
}
__name(invalidateLeaderboardCache, "invalidateLeaderboardCache");
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders }
  });
}
__name(jsonResponse, "jsonResponse");

// ../../../.nvm/versions/node/v22.22.0/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// .wrangler/tmp/bundle-oST7F8/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../.nvm/versions/node/v22.22.0/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-oST7F8/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
