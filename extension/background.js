// ============================================================
// Background service worker
// Handles scheduled auto-sync, badge updates, and token auth
// ============================================================

const ALARM_NAME = 'claude_usage_sync';
const DEFAULT_API_BASE = 'https://leaderboard.sso.integ.internal.svc.movingtech.net';
const TOKEN_COOKIE = 'leaderboard_token';

/** Get the configured API base URL */
async function getApiBase() {
  const stored = await chrome.storage.local.get(['api_base']);
  return stored.api_base || DEFAULT_API_BASE;
}

// ============================================================
// Auth: Token-based (lifetime token from Pomerium SSO setup)
// ============================================================

/** Get stored token from chrome.storage */
async function getStoredToken() {
  const stored = await chrome.storage.local.get(['auth_token', 'auth_email', 'auth_user_id']);
  if (stored.auth_token) return stored;
  return null;
}

/** Try to read the leaderboard_token cookie (set by /setup page) */
async function getTokenCookie() {
  try {
    const apiBase = await getApiBase();
    const cookie = await chrome.cookies.get({ url: apiBase, name: TOKEN_COOKIE });
    return cookie ? cookie.value : null;
  } catch (e) {
    return null;
  }
}

/** Verify a token with the server and store the result */
async function verifyAndStore(token) {
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/auth/verify`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      const storeData = { auth_token: token, auth_email: data.email };
      if (data.userId) storeData.auth_user_id = data.userId;
      await chrome.storage.local.set(storeData);
      // Ensure the dashboard cookie is set so the website can use the token
      try {
        await chrome.cookies.set({
          url: apiBase,
          name: 'leaderboard_token',
          value: token,
          path: '/',
          secure: true,
          sameSite: 'lax',
          expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        });
      } catch (e) { /* ignore */ }
      return { authenticated: true, auth_token: token, auth_email: data.email, auth_user_id: data.userId };
    }
    // 401 = invalid token — clear stored credentials
    if (res.status === 401) {
      await chrome.storage.local.remove(['auth_token', 'auth_email', 'auth_user_id']);
    }
  } catch (e) { /* network error — keep existing stored state */ }
  return null;
}

/** Check if we have a valid token (stored or from cookie) */
async function checkAuth() {
  // First check storage
  const stored = await getStoredToken();
  if (stored) {
    // Re-verify to refresh user_id (in case user linked account on setup page)
    const verified = await verifyAndStore(stored.auth_token);
    if (verified) return verified;
    // If verification failed due to network, still treat as authenticated
    return { authenticated: true, ...stored };
  }

  // Check cookie (may have been set by /setup page)
  const cookieToken = await getTokenCookie();
  if (cookieToken) {
    const verified = await verifyAndStore(cookieToken);
    if (verified) return verified;
  }

  return { authenticated: false };
}

/**
 * Open /setup page to trigger Pomerium SSO and user selection.
 * Polls for the leaderboard_token cookie until found or timeout.
 */
async function triggerAuth() {
  const state = await chrome.storage.local.get(['auth_in_progress']);
  if (state.auth_in_progress) return { success: false, error: 'Auth already in progress' };

  await chrome.storage.local.set({ auth_in_progress: true });

  let tab;
  try {
    const apiBase = await getApiBase();
    tab = await chrome.tabs.create({ url: `${apiBase}/setup.html`, active: true });
  } catch (e) {
    await chrome.storage.local.remove(['auth_in_progress']);
    return { success: false, error: 'Failed to open setup page' };
  }

  const tabId = tab.id;

  const tabClosedPromise = new Promise((resolve) => {
    const listener = (closedId) => {
      if (closedId === tabId) {
        chrome.tabs.onRemoved.removeListener(listener);
        resolve('closed');
      }
    };
    chrome.tabs.onRemoved.addListener(listener);
  });

  // Poll for cookie (every 2s, up to 3 minutes)
  const pollPromise = new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 90;
    const interval = setInterval(async () => {
      attempts++;
      const token = await getTokenCookie();
      if (token) {
        clearInterval(interval);
        resolve('authenticated');
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        resolve('timeout');
      }
    }, 2000);
  });

  const result = await Promise.race([pollPromise, tabClosedPromise]);
  await chrome.storage.local.remove(['auth_in_progress']);

  if (result === 'authenticated') {
    try { await chrome.tabs.remove(tabId); } catch (e) { /* already closed */ }

    // Verify and store token
    const authState = await checkAuth();
    if (authState.authenticated) {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
      return { success: true, email: authState.auth_email, userId: authState.auth_user_id };
    }
    return { success: false, error: 'Token verification failed' };
  } else if (result === 'closed') {
    // Tab closed — check if cookie was set before close
    const authState = await checkAuth();
    if (authState.authenticated) {
      return { success: true, email: authState.auth_email, userId: authState.auth_user_id };
    }
    return { success: false, error: 'Setup page closed before completing' };
  } else {
    try { await chrome.tabs.remove(tabId); } catch (e) { /* already closed */ }
    return { success: false, error: 'Auth timed out. Please try again.' };
  }
}

// ============================================================
// Message handling from content.js and popup.js
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'check_auth_status') {
    checkAuth().then(state => sendResponse(state));
    return true;
  }

  if (msg.type === 'trigger_auth') {
    triggerAuth().then(result => sendResponse(result));
    return true;
  }

  // Proxy API calls through background with token auth
  if (msg.type === 'api_fetch') {
    (async () => {
      try {
        const stored = await getStoredToken();
        const headers = { 'Content-Type': 'application/json' };
        if (stored && stored.auth_token) {
          headers['Authorization'] = `Bearer ${stored.auth_token}`;
        }

        console.log('[Leaderboard BG] api_fetch', msg.method, msg.url, 'hasToken:', !!stored?.auth_token);

        const res = await fetch(msg.url, {
          method: msg.method || 'POST',
          headers,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });

        console.log('[Leaderboard BG] api_fetch response:', res.status);

        if (res.status === 401) {
          sendResponse({ error: 'auth_expired', status: 401 });
          return;
        }

        const data = await res.json();
        sendResponse({ ok: true, data, status: res.status });
      } catch (e) {
        console.error('[Leaderboard BG] api_fetch error:', e);
        sendResponse({ error: e.message, status: 0 });
      }
    })();
    return true;
  }

  if (msg.type === 'sync_success') {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
  }
});

// ============================================================
// Scheduled auto-sync via alarm
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const stored = await chrome.storage.local.get(['schedule_enabled']);
  if (!stored.schedule_enabled) return;

  const authState = await checkAuth();
  if (!authState.authenticated) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    return;
  }

  // Check if usage page is already open
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
  if (tabs.length > 0) {
    chrome.tabs.reload(tabs[0].id);
    return;
  }

  const tab = await chrome.tabs.create({
    url: 'https://claude.ai/settings/usage',
    active: false,
  });

  setTimeout(async () => {
    try { await chrome.tabs.remove(tab.id); } catch (e) { /* already closed */ }
  }, 20000);
});

// ============================================================
// Plan detection — scrape billing page for plan type
// ============================================================

async function detectPlanType() {
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: 'https://claude.ai/settings/billing',
      active: false,
    });
  } catch (e) {
    return;
  }

  await new Promise(r => setTimeout(r, 5000));

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const text = document.body.innerText || '';
        const match = text.match(/(\d+)x\s+more\s+usage/i);
        if (match) return `max${parseInt(match[1])}`;
        const match2 = text.match(/Max\s*\((\d+)[×x]\s*usage\)/i);
        if (match2) return `max${parseInt(match2[1])}`;
        if (text.match(/Max\s+plan/i)) return 'max20';
        if (/\bPro\s+plan\b/i.test(text)) return 'pro';
        if (/\bFree\s+plan\b/i.test(text)) return 'free';
        return null;
      },
    });

    const planType = results[0]?.result;
    if (planType) {
      await chrome.storage.local.set({ detected_plan_type: planType, plan_detected_at: Date.now() });
    }
  } catch (e) {
    // Page may not be accessible
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) { /* already closed */ }
  }
}

// ============================================================
// On install/update
// ============================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.storage.local.remove(['cf_access_client_id', 'cf_access_client_secret']);

  const stored = await chrome.storage.local.get(['schedule_enabled', 'schedule_interval', 'defaults_applied_v3']);

  if (!stored.defaults_applied_v3) {
    await chrome.storage.local.set({
      defaults_applied_v3: true,
      schedule_enabled: true,
      schedule_interval: 5,
    });
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  } else if (stored.schedule_enabled) {
    const mins = stored.schedule_interval || 5;
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: mins });
  }

  // Check if already has token
  const authState = await checkAuth();
  if (!authState.authenticated) {
    triggerAuth();
  }

  const planStore = await chrome.storage.local.get(['detected_plan_type']);
  if (!planStore.detected_plan_type) {
    setTimeout(detectPlanType, 15000);
  }
});
