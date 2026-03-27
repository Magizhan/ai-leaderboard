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

import { kvGet, kvPut, jsonResponse, sanitizeString } from './helpers.js';
import { verifyAccessJWT } from './auth.js';
import { getUsers, addUser, updateUser, deleteUser, getUserConfig, setUserConfig, addPlans } from './users.js';
import { logUsage } from './usage.js';
import { getLeaderboardData, getUserHistory, getUserWeekly, getTeamHistory, getTeamWeekly } from './leaderboard.js';
import { importData, exportData } from './data.js';

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

  // PATCH /api/users/:id — update user team/name
  if (path.match(/^\/api\/users\/[^/]+$/) && method === 'PATCH') {
    const id = path.split('/api/users/')[1];
    return updateUser(id, await request.json(), env);
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
