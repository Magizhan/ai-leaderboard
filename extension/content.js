// ============================================================
// Content script — runs automatically on claude.ai/settings/usage
// Silently scrapes usage data and syncs to leaderboard
// ============================================================
const API_BASE = 'https://leaderboard.magizhan.work';

// Wait for the page to fully render (Claude is a SPA, content loads async)
function waitForUsageData(maxWait = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      const text = document.body.innerText;
      const matches = text.match(/(\d{1,3})%\s*used/g);
      if (matches && matches.length >= 1) {
        resolve(true);
      } else if (Date.now() - start > maxWait) {
        resolve(false);
      } else {
        setTimeout(check, 500);
      }
    }
    check();
  });
}

async function scrapeAndSync() {
  // Wait for usage data to appear on the page
  const found = await waitForUsageData();
  if (!found) return;

  // Get user name from profile button
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
  if (!name) return; // Can't identify user, skip silently

  // Scrape percentages
  const bodyText = document.body.innerText;
  const re = /(\d{1,3})%\s*used/g;
  const all = [];
  let m;
  while ((m = re.exec(bodyText)) !== null) all.push(parseInt(m[1]));

  let sessionPct = all.length >= 1 ? all[0] : null;
  let weeklyPct = all.length >= 2 ? all[1] : null;
  if (sessionPct === null && weeklyPct === null) return;

  // Scrape reset timers
  // Session: "in X hr Y min" -> compute absolute reset timestamp
  let sessionResetsAt = null;
  const sessionResetHrMin = bodyText.match(/in\s+(\d+)\s*hr?\s+(\d+)\s*min/i);
  const sessionResetMinOnly = bodyText.match(/in\s+(\d+)\s*min/i);
  const sessionResetHrOnly = bodyText.match(/in\s+(\d+)\s*hr/i);
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
  // Weekly: "Day H:MM AM/PM" -> compute absolute reset timestamp
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

  // Get saved team preference (default to NY)
  const stored = await chrome.storage.local.get(['claude_lb_team']);
  const team = stored.claude_lb_team || 'NY';

  // Don't sync if we just synced the same values recently (avoid spam)
  const cacheKey = `${name}_${sessionPct}_${weeklyPct}`;
  const lastSync = await chrome.storage.local.get(['last_sync_key', 'last_sync_time']);
  const now = Date.now();
  if (lastSync.last_sync_key === cacheKey && lastSync.last_sync_time && (now - lastSync.last_sync_time) < 60000) {
    return; // Same data synced less than 60s ago, skip
  }

  // Sync to leaderboard
  try {
    const payload = { name, team, source: 'extension' };
    if (sessionPct !== null) payload.sessionPct = sessionPct;
    if (weeklyPct !== null) payload.weeklyPct = weeklyPct;
    if (sessionResetsAt) payload.sessionResetsAt = sessionResetsAt;
    if (weeklyResetsAt) payload.weeklyResetsAt = weeklyResetsAt;

    // Include Cloudflare Access service token if configured
    const authStore = await chrome.storage.local.get(['cf_access_client_id', 'cf_access_client_secret']);
    const headers = { 'Content-Type': 'application/json' };
    if (authStore.cf_access_client_id && authStore.cf_access_client_secret) {
      headers['CF-Access-Client-Id'] = authStore.cf_access_client_id;
      headers['CF-Access-Client-Secret'] = authStore.cf_access_client_secret;
    }

    const res = await fetch(API_BASE + '/api/usage', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.ok) {
      // Save sync state
      await chrome.storage.local.set({
        last_sync_key: cacheKey,
        last_sync_time: now,
        last_sync_name: name,
        last_sync_session: sessionPct,
        last_sync_weekly: weeklyPct,
      });
      // Notify background to update badge
      chrome.runtime.sendMessage({
        type: 'sync_success',
        name,
        sessionPct: data.sessionPct,
        weeklyPct: data.weeklyPct,
      });
    }
  } catch (e) {
    // Fail silently — don't disrupt the user
    console.log('[Claude Leaderboard] Sync failed:', e.message);
  }
}

// Run on page load
scrapeAndSync();

// Also re-scrape periodically while the page is open (catches resets)
setInterval(scrapeAndSync, 300000); // every 5 minutes
