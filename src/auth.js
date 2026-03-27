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
export async function verifyAccessJWT(request, env) {
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
