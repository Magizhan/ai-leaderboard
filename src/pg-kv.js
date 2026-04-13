import pg from 'pg';

/**
 * PostgreSQL-backed KV adapter that matches the Cloudflare KV interface.
 * Uses a simple key-value table: kv_store(key TEXT PRIMARY KEY, value JSONB).
 * Drop-in replacement for env.LEADERBOARD_KV used throughout the codebase.
 */
export async function createPgKV(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err.message);
  });

  return {
    _pool: pool,
    async get(key, type) {
      const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
      if (rows.length === 0) return null;
      return type === 'json' ? rows[0].value : JSON.stringify(rows[0].value);
    },

    async put(key, val) {
      const jsonVal = typeof val === 'string' ? JSON.parse(val) : val;
      await pool.query(
        'INSERT INTO kv_store (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, JSON.stringify(jsonVal)]
      );
    },

    async delete(key) {
      await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
    },

    async quit() {
      await pool.end();
    },
  };
}
