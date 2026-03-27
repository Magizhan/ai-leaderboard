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

  // Scrape percentages — anchored to section headings, with positional fallback
  const bodyText = document.body.innerText;

  // Get email for multi-plan identification
  let email = null;
  const emailMatch = bodyText.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) email = emailMatch[1].toLowerCase();

  // Anchored extraction: find % near known section headings
  const sessionMatch = bodyText.match(/(?:current\s+)?session[\s\S]{0,200}?(\d{1,3})%\s*used/i);
  const weeklyMatch = bodyText.match(/weekly[\s\S]{0,200}?(\d{1,3})%\s*used/i);
  const extraMatch = bodyText.match(/extra\s+usage[\s\S]{0,200}?(\d{1,3})%\s*used/i);

  // Positional fallback: collect all "X% used" by order of appearance
  const re = /(\d{1,3})%\s*used/g;
  const all = [];
  let m;
  while ((m = re.exec(bodyText)) !== null) all.push(parseInt(m[1]));

  // Prefer anchored match, fall back to positional
  let sessionPct = sessionMatch ? parseInt(sessionMatch[1]) : (all.length >= 1 ? all[0] : null);
  let weeklyPct = weeklyMatch ? parseInt(weeklyMatch[1]) : (all.length >= 2 ? all[1] : null);
  if (sessionPct === null && weeklyPct === null) return;

  // Scrape reset timers — use section-specific text to avoid matching Sonnet's timer
  // Page layout: "Current session ... Resets in X min ... Weekly limits ... Sonnet only ... Resets in 23 hr 49 min"
  let sessionResetsAt = null;
  const sessionSection = bodyText.split(/Weekly limits/i)[0] || bodyText; // text before "Weekly limits"
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

  // Scrape extra usage data ($ spent, spend limit, % used)
  // Page order: session % → weekly (All models) % → Sonnet only % → Extra usage %
  let extraUsageSpent = null;
  let extraUsageLimit = null;
  let extraUsagePct = null;
  const spentMatch = bodyText.match(/\$(\d+(?:\.\d{1,2})?)\s*spent/i);
  if (spentMatch) extraUsageSpent = parseFloat(spentMatch[1]);
  const limitMatch = bodyText.match(/\$(\d+(?:,\d{3})*)\s*\n?\s*Monthly spend limit/i);
  if (limitMatch) extraUsageLimit = parseFloat(limitMatch[1].replace(/,/g, ''));
  // Extra usage %: prefer anchored match, fall back to 4th positional
  if (extraMatch) extraUsagePct = parseInt(extraMatch[1]);
  else if (spentMatch && all.length >= 4) extraUsagePct = all[3];

  // Detect plan type — resilient to Claude UI changes
  let planType = null;
  if (/\b20\s*[×x]\b/i.test(bodyText)) planType = 'max20';
  else if (/\b5\s*[×x]\b/i.test(bodyText)) planType = 'max5';
  else if (/\bPro\b/i.test(bodyText) && /plan/i.test(bodyText)) planType = 'pro';
  else if (/\bFree\b/i.test(bodyText) && /plan/i.test(bodyText)) planType = 'free';

  // Get saved team preference (default to NC)
  const stored = await chrome.storage.local.get(['claude_lb_team']);
  const team = stored.claude_lb_team || 'NC';

  // Don't sync if we just synced the same values recently (avoid spam)
  const cacheKey = `${name}_${sessionPct}_${weeklyPct}`;
  const lastSync = await chrome.storage.local.get(['last_sync_key', 'last_sync_time']);
  const now = Date.now();
  if (lastSync.last_sync_key === cacheKey && lastSync.last_sync_time && (now - lastSync.last_sync_time) < 60000) {
    return; // Same data synced less than 60s ago, skip
  }

  // Sync via background service worker (avoids CORS — CF Access blocks OPTIONS preflight)
  try {
    const manifest = chrome.runtime.getManifest();
    const payload = { name, team, source: 'extension', extensionVersion: manifest.version };
    if (email) payload.email = email;
    if (planType) payload.planType = planType;
    if (sessionPct !== null) payload.sessionPct = sessionPct;
    if (weeklyPct !== null) payload.weeklyPct = weeklyPct;
    if (sessionResetsAt) payload.sessionResetsAt = sessionResetsAt;
    if (weeklyResetsAt) payload.weeklyResetsAt = weeklyResetsAt;
    if (extraUsageSpent !== null) payload.extraUsageSpent = extraUsageSpent;
    if (extraUsageLimit !== null) payload.extraUsageLimit = extraUsageLimit;
    if (extraUsagePct !== null) payload.extraUsagePct = extraUsagePct;

    const result = await chrome.runtime.sendMessage({
      type: 'api_fetch',
      url: API_BASE + '/api/usage',
      method: 'POST',
      body: payload,
    });

    if (!result || result.error === 'auth_expired') {
      console.log('[Claude Leaderboard] Auth expired, please re-authenticate');
      return;
    }

    if (result.error) {
      console.log('[Claude Leaderboard] Sync failed:', result.error);
      return;
    }

    const data = result.data;

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
