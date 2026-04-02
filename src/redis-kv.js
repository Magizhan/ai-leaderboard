import Redis from 'ioredis';

/**
 * Redis-backed KV adapter that matches the Cloudflare KV interface.
 * Drop-in replacement for env.LEADERBOARD_KV used throughout the codebase.
 */
export function createRedisKV(redisUrl) {
  const redis = new Redis(redisUrl);

  redis.on('error', (err) => {
    console.error('Redis connection error:', err.message);
  });

  redis.on('connect', () => {
    console.log('Connected to Redis');
  });

  return {
    async get(key, type) {
      const val = await redis.get(key);
      if (val === null) return null;
      if (type === 'json') {
        try { return JSON.parse(val); } catch { return null; }
      }
      return val;
    },

    async put(key, val) {
      await redis.set(key, typeof val === 'string' ? val : JSON.stringify(val));
    },

    async delete(key) {
      await redis.del(key);
    },

    // Expose for graceful shutdown
    quit() {
      return redis.quit();
    },
  };
}
