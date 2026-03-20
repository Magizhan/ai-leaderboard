// ============================================================
// CONFIG
// ============================================================
const API_BASE = 'https://leaderboard.magizhan.work';
const ALARM_NAME = 'claude_usage_sync';

// ============================================================
// DOM refs
// ============================================================
const statusEl       = document.getElementById('status');
const syncBtn        = document.getElementById('syncBtn');
const navBtn         = document.getElementById('navBtn');
const preview        = document.getElementById('dataPreview');
const userEl         = document.getElementById('userName');
const sessEl         = document.getElementById('sessionPct');
const weekEl         = document.getElementById('weeklyPct');
const dashLink       = document.getElementById('dashLink');
const teamSelect     = document.getElementById('teamSelect');
const scheduleToggle = document.getElementById('scheduleToggle');
const scheduleRow    = document.getElementById('scheduleRow');
const scheduleLabel  = document.getElementById('scheduleLabel');
const freqSelect     = document.getElementById('freqSelect');
const authRow        = document.getElementById('authRow');
const authDot        = document.getElementById('authDot');
const authLabel      = document.getElementById('authLabel');
const authDesc       = document.getElementById('authDesc');
const authBtn        = document.getElementById('authBtn');

dashLink.href = API_BASE;
dashLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: API_BASE });
});

let scrapedData = null;

// ============================================================
// Check auth status
// ============================================================
function updateAuthUI(authenticated, email) {
  if (authenticated) {
    authRow.className = 'auth-row authenticated';
    authDot.className = 'auth-dot green';
    authLabel.textContent = 'Signed in';
    authDesc.textContent = email || '';
    authBtn.textContent = 'Re-auth';
    authBtn.style.display = 'block';
  } else {
    authRow.className = 'auth-row unauthenticated';
    authDot.className = 'auth-dot red';
    authLabel.textContent = 'Not signed in';
    authDesc.textContent = 'Sign in with your @juspay.in email';
    authBtn.textContent = 'Sign In';
    authBtn.style.display = 'block';
  }
}

chrome.runtime.sendMessage({ type: 'check_auth_status' }, (response) => {
  if (response) {
    updateAuthUI(response.authenticated, response.email);
  } else {
    updateAuthUI(false);
  }
});

authBtn.addEventListener('click', () => {
  authBtn.disabled = true;
  authBtn.textContent = 'Opening...';
  chrome.runtime.sendMessage({ type: 'trigger_auth' }, (result) => {
    authBtn.disabled = false;
    if (result && result.success) {
      updateAuthUI(true, result.email);
    } else {
      updateAuthUI(false);
      authBtn.textContent = 'Retry';
    }
  });
});

// ============================================================
// Restore saved preferences
// ============================================================
chrome.storage.local.get(
  ['claude_lb_team', 'schedule_enabled', 'schedule_interval', 'last_sync_time', 'last_sync_session', 'last_sync_weekly', 'defaults_applied_v2'],
  (stored) => {
    if (stored.claude_lb_team) teamSelect.value = stored.claude_lb_team;

    // Apply defaults: auto-sync ON at 5 min (once per install/upgrade)
    if (!stored.defaults_applied_v2) {
      chrome.storage.local.set({
        defaults_applied_v2: true,
        schedule_enabled: true,
        schedule_interval: 5,
      });
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
      stored.schedule_enabled = true;
      stored.schedule_interval = 5;
    }

    if (stored.schedule_interval) freqSelect.value = String(stored.schedule_interval);

    const isEnabled = !!stored.schedule_enabled;
    const interval = stored.schedule_interval || 5;
    scheduleToggle.checked = isEnabled;
    updateScheduleUI(isEnabled, interval);

    if (stored.last_sync_time) {
      const ago = timeAgo(stored.last_sync_time);
      document.getElementById('lastSync').textContent =
        'Last sync: ' + (stored.last_sync_session || 0) + '% session / ' + (stored.last_sync_weekly || 0) + '% weekly — ' + ago;
      document.getElementById('lastSync').style.display = 'block';
    }
  }
);

// ============================================================
// Team change
// ============================================================
teamSelect.addEventListener('change', () => {
  chrome.storage.local.set({ claude_lb_team: teamSelect.value });
});

// ============================================================
// Schedule toggle & frequency
// ============================================================
scheduleToggle.addEventListener('change', async () => {
  const enabled = scheduleToggle.checked;
  const mins = parseInt(freqSelect.value);
  await chrome.storage.local.set({ schedule_enabled: enabled, schedule_interval: mins });

  if (enabled) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: mins });
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
  updateScheduleUI(enabled, mins);
});

freqSelect.addEventListener('change', async () => {
  const mins = parseInt(freqSelect.value);
  await chrome.storage.local.set({ schedule_interval: mins });

  if (scheduleToggle.checked) {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: mins });
    updateScheduleUI(true, mins);
  }
});

function updateScheduleUI(enabled, mins) {
  if (enabled) {
    scheduleLabel.textContent = 'Active — every ' + formatMins(mins);
    scheduleRow.classList.add('active');
  } else {
    scheduleLabel.textContent = 'Disabled';
    scheduleRow.classList.remove('active');
  }
}

function formatMins(m) {
  if (m < 60) return m + ' min';
  if (m === 60) return '1 hour';
  return (m / 60) + ' hours';
}

// ============================================================
// On popup open — check page
// ============================================================
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('claude.ai/settings/usage')) {
      setStatus('Open claude.ai/settings/usage to sync now, or enable auto-sync below.', 'info');
      navBtn.style.display = 'block';
      syncBtn.style.display = 'none';
      navBtn.addEventListener('click', () => {
        chrome.tabs.update(tab.id, { url: 'https://claude.ai/settings/usage' });
        window.close();
      });
      return;
    }

    // On the right page — scrape
    setStatus('<span class="spinner"></span> Reading...', 'loading');

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeUsagePage,
    });

    const data = results[0]?.result;
    if (!data || data.error) {
      setStatus(data?.error || 'Could not read usage data. Refresh the page.', 'error');
      return;
    }

    scrapedData = data;
    userEl.textContent = data.name;
    sessEl.textContent = data.sessionPct !== null ? data.sessionPct + '%' : '--';
    weekEl.textContent = data.weeklyPct !== null ? data.weeklyPct + '%' : '--';
    preview.classList.add('visible');

    setStatus('Auto-sync active on this page. Or sync manually:', 'info');
    syncBtn.style.display = 'block';
    syncBtn.addEventListener('click', doSync);

  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  }
})();

// ============================================================
// Scrape function — injected into the claude.ai tab
// ============================================================
function scrapeUsagePage() {
  let name = null;
  const profileBtn = document.querySelector('button[aria-label*="Settings"]');
  if (profileBtn) {
    const label = profileBtn.getAttribute('aria-label');
    const match = label.match(/^(.+?),\s*Settings/);
    if (match) name = match[1].trim();
  }
  if (!name && profileBtn) {
    const nameSpan = profileBtn.querySelector('span.truncate, span[class*="truncate"]');
    if (nameSpan && nameSpan.textContent.trim().length > 0 && nameSpan.textContent.trim().length < 50) {
      name = nameSpan.textContent.trim();
    }
  }
  if (!name) return { error: 'Could not detect your Claude username.' };

  const bodyText = document.body.innerText;
  const re = /(\d{1,3})%\s*used/g;
  const all = [];
  let m;
  while ((m = re.exec(bodyText)) !== null) all.push(parseInt(m[1]));

  let sessionPct = all.length >= 1 ? all[0] : null;
  let weeklyPct = all.length >= 2 ? all[1] : null;
  if (sessionPct === null && weeklyPct === null) {
    return { error: 'No usage data found. Make sure you are on the Usage tab.' };
  }

  let sessionResetsAt = null;
  const sessionSection = bodyText.split(/Weekly limits/i)[0] || bodyText;
  const sessionResetHrMin = sessionSection.match(/in\s+(\d+)\s*hr?\s+(\d+)\s*min/i);
  const sessionResetMinOnly = sessionSection.match(/in\s+(\d+)\s*min/i);
  const sessionResetHrOnly = sessionSection.match(/in\s+(\d+)\s*hr/i);
  if (sessionResetHrMin) {
    const ms = (parseInt(sessionResetHrMin[1]) * 3600 + parseInt(sessionResetHrMin[2]) * 60) * 1000;
    sessionResetsAt = new Date(Date.now() + ms).toISOString();
  } else if (sessionResetMinOnly) {
    const ms = parseInt(sessionResetMinOnly[1]) * 60 * 1000;
    sessionResetsAt = new Date(Date.now() + ms).toISOString();
  } else if (sessionResetHrOnly) {
    const ms = parseInt(sessionResetHrOnly[1]) * 3600 * 1000;
    sessionResetsAt = new Date(Date.now() + ms).toISOString();
  }
  let weeklyResetsAt = null;
  const weeklyResetMatch = bodyText.match(/(sun|mon|tue|wed|thu|fri|sat)\w*\s+(\d+):(\d+)\s*(am|pm)/i);
  if (weeklyResetMatch) {
    const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
    const targetDay = dayNames.indexOf(weeklyResetMatch[1].toLowerCase().slice(0, 3));
    let hour = parseInt(weeklyResetMatch[2]);
    const min = parseInt(weeklyResetMatch[3]);
    const isPM = weeklyResetMatch[4].toLowerCase() === 'pm';
    if (isPM && hour !== 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
    const now = new Date();
    const reset = new Date(now);
    let daysAhead = (targetDay - now.getDay() + 7) % 7;
    if (daysAhead === 0) {
      const todayTarget = new Date(now);
      todayTarget.setHours(hour, min, 0, 0);
      if (todayTarget <= now) daysAhead = 7;
    }
    reset.setDate(reset.getDate() + daysAhead);
    reset.setHours(hour, min, 0, 0);
    weeklyResetsAt = reset.toISOString();
  }

  // Scrape extra usage data
  // Page order: session % → weekly (All models) % → Sonnet only % → Extra usage %
  let extraUsageSpent = null;
  let extraUsageLimit = null;
  let extraUsagePct = null;
  const spentMatch = bodyText.match(/\$(\d+(?:\.\d{1,2})?)\s*spent/i);
  if (spentMatch) extraUsageSpent = parseFloat(spentMatch[1]);
  const limitMatch = bodyText.match(/\$(\d+(?:,\d{3})*)\s*\n?\s*Monthly spend limit/i);
  if (limitMatch) extraUsageLimit = parseFloat(limitMatch[1].replace(/,/g, ''));
  // Extra usage % is the 4th "X% used" (after session, weekly, sonnet)
  if (spentMatch && all.length >= 4) extraUsagePct = all[3];

  // Detect plan type (Max 5x, Max 20x, Pro, Free, etc.)
  let planType = null;
  const maxMatch = bodyText.match(/(Max)\s*(?:\((\d+)\s*[×x]\s*usage\))?/i);
  if (maxMatch) {
    planType = `max${maxMatch[2] ? parseInt(maxMatch[2]) : 20}`;
  } else if (/\bPro\b/i.test(bodyText) && /usage/i.test(bodyText)) {
    planType = 'pro';
  } else if (/\bFree\b/i.test(bodyText) && /usage/i.test(bodyText)) {
    planType = 'free';
  }

  return { name, sessionPct, weeklyPct, sessionResetsAt, weeklyResetsAt, extraUsageSpent, extraUsageLimit, extraUsagePct, planType };
}

// ============================================================
// Manual sync
// ============================================================
async function doSync() {
  if (!scrapedData) return;
  syncBtn.disabled = true;
  setStatus('<span class="spinner"></span> Syncing...', 'loading');

  try {
    const manifest = chrome.runtime.getManifest();
    const payload = {
      name: scrapedData.name,
      team: teamSelect.value,
      source: 'extension',
      extensionVersion: manifest.version,
    };
    if (scrapedData.sessionPct !== null) payload.sessionPct = scrapedData.sessionPct;
    if (scrapedData.weeklyPct !== null) payload.weeklyPct = scrapedData.weeklyPct;
    if (scrapedData.sessionResetsAt) payload.sessionResetsAt = scrapedData.sessionResetsAt;
    if (scrapedData.weeklyResetsAt) payload.weeklyResetsAt = scrapedData.weeklyResetsAt;
    if (scrapedData.extraUsageSpent !== null) payload.extraUsageSpent = scrapedData.extraUsageSpent;
    if (scrapedData.extraUsageLimit !== null) payload.extraUsageLimit = scrapedData.extraUsageLimit;
    if (scrapedData.extraUsagePct !== null) payload.extraUsagePct = scrapedData.extraUsagePct;
    if (scrapedData.planType) payload.planType = scrapedData.planType;

    // Route through background service worker to avoid CORS (CF Access blocks OPTIONS preflight)
    const result = await chrome.runtime.sendMessage({
      type: 'api_fetch',
      url: API_BASE + '/api/usage',
      method: 'POST',
      body: payload,
    });

    if (!result || result.error === 'auth_expired') {
      setStatus('Session expired. Please sign in again.', 'error');
      updateAuthUI(false);
      syncBtn.disabled = false;
      return;
    }

    if (result.error) {
      setStatus('Network error: ' + result.error, 'error');
      syncBtn.disabled = false;
      return;
    }

    const data = result.data;

    if (data.ok) {
      await chrome.storage.local.set({
        claude_lb_team: teamSelect.value,
        last_sync_name: scrapedData.name,
        last_sync_session: data.sessionPct || 0,
        last_sync_weekly: data.weeklyPct || 0,
        last_sync_time: Date.now(),
      });
      setStatus('&#10003; Synced! Session: ' + (data.sessionPct || 0) + '%, Weekly: ' + (data.weeklyPct || 0) + '%', 'success');
      syncBtn.textContent = 'Synced!';
    } else {
      setStatus('Error: ' + (data.error || 'Unknown'), 'error');
      syncBtn.disabled = false;
    }
  } catch (err) {
    setStatus('Network error: ' + err.message, 'error');
    syncBtn.disabled = false;
  }
}

// ============================================================
// Helpers
// ============================================================
function setStatus(html, type) {
  statusEl.innerHTML = html;
  statusEl.className = 'status ' + type;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}
