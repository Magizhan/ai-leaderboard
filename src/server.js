import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPgKV } from './pg-kv.js';
import { createAuthManager } from './auth-tokens.js';
import { runMigrations } from './migrations/run.js';
import worker from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/ai_leaderboard';

// Run migrations then create KV adapter
const kv = await createPgKV(DATABASE_URL);
console.log('Running migrations...');
await runMigrations(kv._pool);
console.log('Connected to PostgreSQL');

const auth = createAuthManager(kv._pool);

const env = {
  LEADERBOARD_KV: kv,
  PLAN_COST: process.env.PLAN_COST || '200',
  CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || '',       // empty = skip auth
  CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || '',
};

const app = express();
app.use(express.json());

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================================
// Auth endpoints (Pomerium SSO → token)
// ============================================================

// GET /api/me — returns Pomerium identity
app.get('/api/me', (req, res) => {
  const email = req.headers['x-pomerium-claim-email'] || '';
  const name = req.headers['x-pomerium-claim-name'] || req.headers['x-pomerium-claim-given-name'] || '';
  const groups = req.headers['x-pomerium-claim-groups'] || '';
  if (!email) {
    return res.status(401).json({ error: 'Not authenticated. No Pomerium identity found.' });
  }
  res.json({ email, name, groups: groups ? groups.split(',').map(g => g.trim()) : [] });
});

// POST /api/auth/setup — called from setup page after Pomerium SSO
// Creates/returns a lifetime token and optionally claims a leaderboard user
app.post('/api/auth/setup', async (req, res) => {
  const email = req.headers['x-pomerium-claim-email'] || '';
  if (!email) {
    return res.status(401).json({ error: 'Pomerium authentication required.' });
  }

  try {
    // Get or create token for this email
    const record = await auth.getOrCreateToken(email);

    // If userId provided, claim that user
    const { userId, newUserName, newUserTeam } = req.body || {};

    if (userId) {
      const result = await auth.claimUser(record.token, userId);
      if (result.error) return res.status(409).json(result);
      record.user_id = userId;
    } else if (newUserName) {
      // Create a new leaderboard user and claim it
      const createRes = await worker.fetch(
        new Request(`http://localhost/api/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newUserName, team: newUserTeam || 'NC' }),
        }),
        env
      );
      const created = await createRes.json();
      if (created.error) return res.status(createRes.status).json(created);

      const result = await auth.claimUser(record.token, created.id);
      if (result.error) return res.status(409).json(result);
      record.user_id = created.id;
    }

    // Resolve userName if we have a userId
    let userName = null;
    if (record.user_id) {
      const users = await kv.get('users', 'json') || [];
      const u = users.find(u => u.id === record.user_id);
      if (u) userName = u.name;
    }

    res.json({
      token: record.token,
      email: record.email,
      userId: record.user_id,
      userName,
    });
  } catch (err) {
    console.error('Auth setup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/verify — verify a token, return associated user info
app.get('/api/auth/verify', async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'No token provided.' });

  try {
    const record = await auth.getByToken(token);
    if (!record) return res.status(401).json({ error: 'Invalid token.' });
    res.json({ email: record.email, userId: record.user_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/unclaimed-users — list users not yet claimed by any token
app.get('/api/auth/unclaimed-users', async (req, res) => {
  const email = req.headers['x-pomerium-claim-email'] || '';
  if (!email) return res.status(401).json({ error: 'Pomerium authentication required.' });

  try {
    const users = await kv.get('users', 'json') || [];
    const claimed = await auth.getClaimedUserIds();
    const unclaimed = users.filter(u => !claimed.has(u.id));
    res.json(unclaimed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Token extraction helper
// ============================================================

function extractToken(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.query?.token || null;
}

// ============================================================
// All other API routes → worker fetch handler
// All write endpoints require token auth
// ============================================================

app.use('/api', async (req, res) => {
  try {
    const token = extractToken(req);
    const record = token ? await auth.getByToken(token) : null;

    // POST /api/usage requires a valid token
    if (req.path === '/usage' && req.method === 'POST') {
      if (!record) {
        return res.status(401).json({ error: 'Valid token required. Get yours at /setup.html' });
      }
    } else if (token && !record) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    // Build a Web API Request from the Express request
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
    }

    const init = { method: req.method, headers };
    if (!['GET', 'HEAD'].includes(req.method)) {
      // Read raw body for the worker to parse
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks);
      // express.json() may have consumed the body; re-serialize if needed
      if (body.length === 0 && req.body) {
        body = Buffer.from(JSON.stringify(req.body));
      }
      if (body.length > 0) init.body = body;
    }

    const webRequest = new Request(url, init);
    const webResponse = await worker.fetch(webRequest, env);

    res.status(webResponse.status);
    for (const [key, val] of webResponse.headers.entries()) {
      res.set(key, val);
    }
    const responseBody = await webResponse.text();
    res.send(responseBody);
  } catch (err) {
    console.error('Request error:', err);
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Leaderboard server running on http://localhost:${PORT}`);
});

// Graceful shutdown
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => {
      kv.quit().then(() => process.exit(0));
    });
  });
}
