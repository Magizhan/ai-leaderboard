import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRedisKV } from './redis-kv.js';
import worker from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Build the env object matching what the worker expects
const kv = createRedisKV(REDIS_URL);
const env = {
  LEADERBOARD_KV: kv,
  PLAN_COST: process.env.PLAN_COST || '200',
  CF_ACCESS_AUD: process.env.CF_ACCESS_AUD || '',       // empty = skip auth
  CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN || '',
};

const app = express();

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// Pomerium SSO: /api/me returns the authenticated user's identity
app.get('/api/me', (req, res) => {
  const email = req.headers['x-pomerium-claim-email'] || '';
  const name = req.headers['x-pomerium-claim-name'] || req.headers['x-pomerium-claim-given-name'] || '';
  const groups = req.headers['x-pomerium-claim-groups'] || '';
  if (!email) {
    return res.status(401).json({ error: 'Not authenticated. No Pomerium identity found.' });
  }
  res.json({ email, name, groups: groups ? groups.split(',').map(g => g.trim()) : [] });
});

// All API routes go through the worker's fetch handler
app.use('/api', async (req, res) => {
  try {
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
      const body = Buffer.concat(chunks);
      if (body.length > 0) init.body = body;
    }

    const webRequest = new Request(url, init);

    // Call the worker's fetch handler
    const webResponse = await worker.fetch(webRequest, env);

    // Convert Web Response back to Express response
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
