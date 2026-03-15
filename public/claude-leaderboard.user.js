// ==UserScript==
// @name         Claude Usage Leaderboard Sync
// @namespace    https://leaderboard.magizhan.work
// @version      1.4
// @description  Auto-syncs your Claude AI usage to the team leaderboard
// @author       Mags
// @match        https://claude.ai/settings/usage*
// @icon         https://claude.ai/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      leaderboard.magizhan.work
// @updateURL    https://leaderboard.magizhan.work/claude-leaderboard.user.js
// @downloadURL  https://leaderboard.magizhan.work/claude-leaderboard.user.js
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  const API_BASE = 'https://leaderboard.magizhan.work';
  const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // ============================================================
  // Settings menu commands
  // ============================================================
  const TEAMS = ['NY', 'NC', 'Xyne', 'HS', 'JP'];
  const currentTeam = GM_getValue('team', 'NY');

  GM_registerMenuCommand(`Team: ${currentTeam} (click to change)`, () => {
    const team = prompt('Enter your team (' + TEAMS.join(', ') + '):', currentTeam);
    if (team && TEAMS.includes(team)) {
      GM_setValue('team', team);
      location.reload();
    } else if (team) {
      alert('Invalid team. Choose from: ' + TEAMS.join(', '));
    }
  });

  GM_registerMenuCommand('Open Leaderboard', () => {
    window.open(API_BASE, '_blank');
  });

  GM_registerMenuCommand('Sync Now', () => {
    scrapeAndSync(true);
  });

  // ============================================================
  // Wait for usage data to render (Claude is a SPA)
  // ============================================================
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

  // ============================================================
  // Scrape and sync
  // ============================================================
  async function scrapeAndSync(manual = false) {
    const found = await waitForUsageData();
    if (!found) {
      if (manual) showToast('No usage data found on page', 'error');
      return;
    }

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
    if (!name) {
      if (manual) showToast('Could not detect username', 'error');
      return;
    }

    // Scrape percentages
    const bodyText = document.body.innerText;
    const re = /(\d{1,3})%\s*used/g;
    const all = [];
    let m;
    while ((m = re.exec(bodyText)) !== null) all.push(parseInt(m[1]));

    const sessionPct = all.length >= 1 ? all[0] : null;
    const weeklyPct = all.length >= 2 ? all[1] : null;
    if (sessionPct === null && weeklyPct === null) {
      if (manual) showToast('No usage percentages found', 'error');
      return;
    }

    // Scrape session reset timer
    let sessionResetsAt = null;
    const hrMin = bodyText.match(/in\s+(\d+)\s*hr?\s+(\d+)\s*min/i);
    const minOnly = bodyText.match(/in\s+(\d+)\s*min/i);
    const hrOnly = bodyText.match(/in\s+(\d+)\s*hr/i);
    if (hrMin) {
      sessionResetsAt = new Date(Date.now() + (parseInt(hrMin[1]) * 3600 + parseInt(hrMin[2]) * 60) * 1000).toISOString();
    } else if (minOnly) {
      sessionResetsAt = new Date(Date.now() + parseInt(minOnly[1]) * 60 * 1000).toISOString();
    } else if (hrOnly) {
      sessionResetsAt = new Date(Date.now() + parseInt(hrOnly[1]) * 3600 * 1000).toISOString();
    }

    // Scrape weekly reset timer
    let weeklyResetsAt = null;
    const weeklyMatch = bodyText.match(/(sun|mon|tue|wed|thu|fri|sat)\w*\s+(\d+):(\d+)\s*(am|pm)/i);
    if (weeklyMatch) {
      const dayNames = ['sun','mon','tue','wed','thu','fri','sat'];
      const targetDay = dayNames.indexOf(weeklyMatch[1].toLowerCase().slice(0, 3));
      let hour = parseInt(weeklyMatch[2]);
      const min = parseInt(weeklyMatch[3]);
      const isPM = weeklyMatch[4].toLowerCase() === 'pm';
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

    // Dedup: skip if same data synced recently
    const cacheKey = `${name}_${sessionPct}_${weeklyPct}`;
    const lastKey = GM_getValue('lastSyncKey', '');
    const lastTime = GM_getValue('lastSyncTime', 0);
    if (!manual && lastKey === cacheKey && (Date.now() - lastTime) < 60000) {
      return;
    }

    // Build payload
    const team = GM_getValue('team', 'NY');
    const payload = { name, team, source: 'extension' };
    if (sessionPct !== null) payload.sessionPct = sessionPct;
    if (weeklyPct !== null) payload.weeklyPct = weeklyPct;
    if (sessionResetsAt) payload.sessionResetsAt = sessionResetsAt;
    if (weeklyResetsAt) payload.weeklyResetsAt = weeklyResetsAt;

    // Sync via GM_xmlhttpRequest (bypasses CORS)
    const cfClientId = GM_getValue('cfClientId', '');
    const cfClientSecret = GM_getValue('cfClientSecret', '');
    const headers = { 'Content-Type': 'application/json' };
    if (cfClientId && cfClientSecret) {
      headers['CF-Access-Client-Id'] = cfClientId;
      headers['CF-Access-Client-Secret'] = cfClientSecret;
    }

    GM_xmlhttpRequest({
      method: 'POST',
      url: API_BASE + '/api/usage',
      headers,
      data: JSON.stringify(payload),
      onload: function(response) {
        try {
          const data = JSON.parse(response.responseText);
          if (data.ok) {
            GM_setValue('lastSyncKey', cacheKey);
            GM_setValue('lastSyncTime', Date.now());
            if (manual) {
              showToast(`Synced! Session: ${data.sessionPct || 0}%, Weekly: ${data.weeklyPct || 0}%`, 'success');
            }
            updateBadge(data.sessionPct, data.weeklyPct);
          } else {
            if (manual) showToast('Error: ' + (data.error || 'Unknown'), 'error');
          }
        } catch (e) {
          if (manual) showToast('Invalid response from server', 'error');
        }
      },
      onerror: function() {
        if (manual) showToast('Network error — check your connection', 'error');
      }
    });
  }

  // ============================================================
  // Floating status badge
  // ============================================================
  function updateBadge(sessionPct, weeklyPct) {
    let badge = document.getElementById('claude-lb-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'claude-lb-badge';
      badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:99999;' +
        'background:linear-gradient(135deg,#1e1b4b,#312e81);color:#e0e7ff;' +
        'padding:8px 14px;border-radius:10px;font-size:12px;font-family:system-ui,sans-serif;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.3);cursor:pointer;opacity:0.9;transition:opacity 0.2s;' +
        'border:1px solid rgba(99,102,241,0.3);';
      badge.addEventListener('mouseenter', () => badge.style.opacity = '1');
      badge.addEventListener('mouseleave', () => badge.style.opacity = '0.9');
      badge.addEventListener('click', () => window.open(API_BASE, '_blank'));
      document.body.appendChild(badge);
    }
    const team = GM_getValue('team', 'NY');
    badge.innerHTML = `<span style="color:#818cf8;font-weight:700;">LB</span> ` +
      `<span style="color:#a5b4fc;">${team}</span> ` +
      `S:${sessionPct || 0}% W:${weeklyPct || 0}% ` +
      `<span style="color:#6ee7b7;">&#10003;</span>`;
  }

  // ============================================================
  // Toast notifications
  // ============================================================
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    const colors = {
      success: 'background:#065f46;color:#6ee7b7;border-color:#10b981;',
      error: 'background:#7f1d1d;color:#fca5a5;border-color:#ef4444;',
      info: 'background:#1e1b4b;color:#a5b4fc;border-color:#6366f1;',
    };
    toast.style.cssText = 'position:fixed;top:20px;right:20px;z-index:999999;' +
      'padding:12px 20px;border-radius:10px;font-size:13px;font-family:system-ui,sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.3);border:1px solid;transition:opacity 0.5s;' +
      (colors[type] || colors.info);
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 500); }, 3000);
  }

  // ============================================================
  // Init: run on page load, then every 5 minutes
  // ============================================================
  scrapeAndSync();
  setInterval(scrapeAndSync, SYNC_INTERVAL_MS);

})();
