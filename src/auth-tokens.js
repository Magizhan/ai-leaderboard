import crypto from 'crypto';

/**
 * Auth token management.
 * Tokens are lifetime-scoped per SSO email — one token per email, never expires.
 * Stored in the auth_tokens table (created by migration 002).
 */

export function createAuthManager(pool) {
  return {
    /** Generate a cryptographically secure token */
    generateToken() {
      return crypto.randomBytes(32).toString('hex');
    },

    /** Get token record by email (returns { token, email, user_id } or null) */
    async getByEmail(email) {
      const { rows } = await pool.query(
        'SELECT token, email, user_id FROM auth_tokens WHERE email = $1',
        [email.toLowerCase()]
      );
      return rows[0] || null;
    },

    /** Get token record by token string */
    async getByToken(token) {
      const { rows } = await pool.query(
        'SELECT token, email, user_id FROM auth_tokens WHERE token = $1',
        [token]
      );
      return rows[0] || null;
    },

    /** Create a new token for an email (or return existing) */
    async getOrCreateToken(email) {
      email = email.toLowerCase();
      const existing = await this.getByEmail(email);
      if (existing) return existing;

      const token = this.generateToken();
      await pool.query(
        'INSERT INTO auth_tokens (token, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
        [token, email]
      );
      // Re-fetch in case of race condition
      return await this.getByEmail(email);
    },

    /** Claim a leaderboard user for this token */
    async claimUser(token, userId) {
      // Ensure no other token already has this user
      const { rows: conflict } = await pool.query(
        'SELECT email FROM auth_tokens WHERE user_id = $1 AND token != $2',
        [userId, token]
      );
      if (conflict.length > 0) {
        return { error: `This user is already claimed by ${conflict[0].email}` };
      }

      await pool.query(
        'UPDATE auth_tokens SET user_id = $1 WHERE token = $2',
        [userId, token]
      );
      return { ok: true };
    },

    /** Get all user_ids that are already claimed */
    async getClaimedUserIds() {
      const { rows } = await pool.query(
        'SELECT user_id FROM auth_tokens WHERE user_id IS NOT NULL'
      );
      return new Set(rows.map(r => r.user_id));
    },
  };
}
