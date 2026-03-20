// ============================================================
// Background service worker
// Handles scheduled auto-sync, badge updates, and auth flow
// ============================================================

const ALARM_NAME = 'claude_usage_sync';
const API_BASE = 'https://leaderboard.magizhan.work';
const COOKIE_NAME = 'CF_Authorization';
const COOKIE_DOMAIN = 'leaderboard.magizhan.work';

// ============================================================
// Auth: JWT from Cloudflare Access cookie
// ============================================================

/** Read CF_Authorization cookie from leaderboard domain */
async function getAccessCookie() {
  try {
    const cookie = await chrome.cookies.get({
      url: API_BASE,
      name: COOKIE_NAME,
    });
    return cookie ? cookie.value : null;
  } catch (e) {
    return null;
  }
}

/** Decode JWT payload and check expiry */
function isJWTExpired(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const now = Math.floor(Date.now() / 1000);
    // Treat as expired 5 minutes early to avoid edge cases
    return payload.exp ? payload.exp < now + 300 : false;
  } catch (e) {
    return true;
  }
}

/** Get email from JWT payload */
function getJWTEmail(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email || null;
  } catch (e) {
    return null;
  }
}

/** Get a valid JWT — from cookie, or null if not available */
async function getValidJWT() {
  const jwt = await getAccessCookie();
  if (jwt && !isJWTExpired(jwt)) return jwt;
  return null;
}

/**
 * Open leaderboard in a tab to trigger CF Access login.
 * Polls for the CF_Authorization cookie until found or timeout.
 */
async function triggerAuth() {
  // Prevent multiple auth tabs
  const state = await chrome.storage.local.get(['auth_in_progress']);
  if (state.auth_in_progress) return { success: false, error: 'Auth already in progress' };

  await chrome.storage.local.set({ auth_in_progress: true });

  let tab;
  try {
    tab = await chrome.tabs.create({ url: API_BASE, active: true });
  } catch (e) {
    await chrome.storage.local.remove(['auth_in_progress']);
    return { success: false, error: 'Failed to open auth tab' };
  }

  const tabId = tab.id;

  // Listen for tab close
  const tabClosedPromise = new Promise((resolve) => {
    const listener = (closedId) => {
      if (closedId === tabId) {
        chrome.tabs.onRemoved.removeListener(listener);
        resolve('closed');
      }
    };
    chrome.tabs.onRemoved.addListener(listener);
  });

  // Poll for cookie (every 2s, up to 2 minutes)
  const pollPromise = new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 60;
    const interval = setInterval(async () => {
      attempts++;
      const jwt = await getAccessCookie();
      if (jwt && !isJWTExpired(jwt)) {
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
    // Close the auth tab
    try { await chrome.tabs.remove(tabId); } catch (e) { /* already closed */ }
    const jwt = await getAccessCookie();
    const email = jwt ? getJWTEmail(jwt) : null;
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 5000);
    return { success: true, email };
  } else if (result === 'closed') {
    return { success: false, error: 'Auth tab was closed before login completed' };
  } else {
    try { await chrome.tabs.remove(tabId); } catch (e) { /* already closed */ }
    return { success: false, error: 'Auth timed out. Please try again.' };
  }
}

// ============================================================
// Message handling from content.js and popup.js
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_jwt') {
    getValidJWT().then(jwt => sendResponse({ jwt }));
    return true; // async response
  }

  if (msg.type === 'check_auth_status') {
    getValidJWT().then(jwt => {
      if (jwt) {
        sendResponse({ authenticated: true, email: getJWTEmail(jwt) });
      } else {
        sendResponse({ authenticated: false });
      }
    });
    return true;
  }

  if (msg.type === 'trigger_auth') {
    triggerAuth().then(result => sendResponse(result));
    return true;
  }

  // Proxy API calls through background to avoid CORS (CF Access blocks OPTIONS preflight)
  if (msg.type === 'api_fetch') {
    (async () => {
      try {
        const jwt = await getValidJWT();
        const headers = { 'Content-Type': 'application/json' };
        if (jwt) headers['CF-Access-JWT-Assertion'] = jwt;

        const res = await fetch(msg.url, {
          method: msg.method || 'POST',
          headers,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });

        if (res.status === 403) {
          sendResponse({ error: 'auth_expired', status: 403 });
          return;
        }

        const data = await res.json();
        sendResponse({ ok: true, data, status: res.status });
      } catch (e) {
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

  // Check auth before syncing
  const jwt = await getValidJWT();
  if (!jwt) {
    // Show red badge to indicate auth needed
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

  // Open in background tab
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

/**
 * Open claude.ai/settings/billing in a hidden tab, scrape plan info,
 * cache in chrome.storage.local. Runs on install/update and periodically.
 */
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

  // Wait for page to load
  await new Promise(r => setTimeout(r, 5000));

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const text = document.body.innerText || '';
        // Match "5x more usage" or "20x more usage"
        const match = text.match(/(\d+)x\s+more\s+usage/i);
        if (match) return `max${parseInt(match[1])}`;
        // Match "Max (5× usage)" or "Max (20× usage)"
        const match2 = text.match(/Max\s*\((\d+)[×x]\s*usage\)/i);
        if (match2) return `max${parseInt(match2[1])}`;
        // Match "Max plan" without multiplier
        if (text.match(/Max\s+plan/i)) return 'max20';
        // Match Pro or Free plans
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
    // Page may not be accessible (not logged in, etc.)
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) { /* already closed */ }
  }
}

// ============================================================
// On install/update
// ============================================================

chrome.runtime.onInstalled.addListener(async (details) => {
  // Clean up old auth storage keys from v1.4
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

  // Check if already authenticated (user may have visited leaderboard before)
  const jwt = await getValidJWT();
  if (!jwt) {
    // Prompt auth on install
    triggerAuth();
  }

  // Detect plan type from billing page (after a short delay to let auth complete)
  const planStore = await chrome.storage.local.get(['detected_plan_type']);
  if (!planStore.detected_plan_type) {
    setTimeout(detectPlanType, 15000); // Wait 15s for auth to settle
  }
});
