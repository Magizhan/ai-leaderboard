Let me read all the extension files first.
Now let me check the server-side handler for `/api/usage` to understand the full data pipeline.
---

# Chrome Extension Audit Report — `extension/`

## 1. Data Accuracy

### 1a. Percentage Scraping Relies on Positional Ordering — **HIGH severity**

**File:** `extension/content.js:48-55`, also duplicated in `extension/popup.js:232-239`

The scraper uses `document.body.innerText` with regex `/(\d{1,3})%\s*used/g` and assigns percentages **by position**: first match = session, second = weekly. The comment at line 100 reveals the actual page order is:

> session % → weekly (All models) % → Sonnet only % → Extra usage %

**Problem:** This is extremely fragile. If Anthropic:
- Reorders sections, the values silently swap
- Adds a new "X% used" element (e.g., a new model tier), session/weekly shift
- Removes the session meter (e.g., for Free users who don't have one), weekly gets misassigned to session

**There is no structural validation** — no check that the scraped text near each `%` actually says "Current session" or "Weekly limits". The scraper grabs naked numbers by position only.

**Fix approach:** Anchor each percentage to its section heading. Split `bodyText` by known headings ("Current session", "Weekly limits") and extract `%` from within each section independently, rather than relying on global match order.

### 1b. `sessionPct` vs `weeklyPct` Confusion for Single-Metric Plans — **MEDIUM severity**

**File:** `extension/content.js:54-56`

```js
let sessionPct = all.length >= 1 ? all[0] : null;
let weeklyPct = all.length >= 2 ? all[1] : null;
```

If only **one** `X% used` is on the page (e.g., Free plan with only weekly limits, or a simplified UI), it gets assigned to `sessionPct`. This is wrong for plans that only show a weekly limit. There's no semantic check to distinguish which metric is being shown.

### 1c. Plan Detection Regex is Too Greedy — **MEDIUM severity**

**File:** `extension/content.js:112-113`

```js
const planMatch = bodyText.match(/(Max)\s*(?:\((\d+)\s*[×x]\s*usage\))?/i);
const planType = planMatch ? `max${planMatch[2] ? parseInt(planMatch[2]) : 20}` : null;
```

The word "Max" appears in many English sentences. This regex matches any occurrence of "Max" in the page body and defaults to `max20`. If someone's username contains "Max" or any page text says "Maximum", this incorrectly triggers. Also, it **only detects Max plans** — Pro, Team, and Free plans get `null`, making `planType` unreliable for non-Max users.

The `detectPlanType` function in `background.js:237-277` has a **separate, different regex** for the billing page, which can produce conflicting results.

### 1d. Extra Usage Percentage Assumes Exactly 4 Matches — **LOW severity**

**File:** `extension/content.js:109`

```js
if (spentMatch && all.length >= 4) extraUsagePct = all[3];
```

This hardcodes that extra usage is the **4th** `% used` on the page. If the page layout has fewer or more meters, this silently picks the wrong value or returns null.

---

## 2. Sync Reliability

### 2a. Silent Failure with No Retry — **HIGH severity**

**File:** `extension/content.js:176-179`

```js
} catch (e) {
  // Fail silently — don't disrupt the user
  console.log('[Claude Leaderboard] Sync failed:', e.message);
}
```

If a sync fails (network error, API down, service worker inactive), the data is **permanently lost**. There is no retry queue, no exponential backoff, no offline storage. The only recovery is the next 5-minute interval or page refresh, by which point the values may have changed.

**Fix approach:** On failure, save the payload to `chrome.storage.local` as a pending sync. Retry from the background worker on the next alarm or when connectivity returns.

### 2b. Deduplication Cache Hides Real Updates — **MEDIUM severity**

**File:** `extension/content.js:120-125`

```js
const cacheKey = `${name}_${sessionPct}_${weeklyPct}`;
if (lastSync.last_sync_key === cacheKey && (now - lastSync.last_sync_time) < 60000) {
  return; // Same data synced less than 60s ago, skip
}
```

The cache key only includes `name`, `sessionPct`, and `weeklyPct`. If those stay the same but **reset timers, extra usage, or plan type** change, the sync is suppressed. Timer data (`sessionResetsAt`, `weeklyResetsAt`) is never synced if percentages haven't changed.

### 2c. Auto-Sync Opens Background Tabs Without Guaranteed Cleanup — **MEDIUM severity**

**File:** `extension/background.js:219-226`

```js
const tab = await chrome.tabs.create({
  url: 'https://claude.ai/settings/usage',
  active: false,
});
setTimeout(async () => {
  try { await chrome.tabs.remove(tab.id); } catch (e) {}
}, 20000);
```

The background tab is closed after a **fixed 20 seconds** via `setTimeout`. Problems:
- If the service worker goes inactive before the timeout fires, the tab stays open forever
- If the page takes >20s to load (slow network), the tab is closed before the content script can scrape
- If the user is not logged into claude.ai, this opens a login page that's never cleaned up
- Creates user-visible tab flicker even with `active: false`

### 2d. `waitForUsageData` Can Return `false` with No Notification — **LOW severity**

**File:** `extension/content.js:8-24`

If no `X% used` text appears within 10 seconds (SPA still loading, user not logged in, page changed), `scrapeAndSync` returns silently. No badge update, no console warning, no retry.

---

## 3. Plan Detection

### 3a. No Detection of Pro, Team, or Free Plans — **HIGH severity**

**File:** `extension/content.js:112-113`

Only "Max" plans are detected. The regex `/(Max)\s*(?:\((\d+)\s*[×x]\s*usage\))?/i` returns `null` for Pro and Free plans. This means:
- The leaderboard has no idea if someone is on a Pro plan vs Free
- The server-side cost calculation (`worker.js:842`) assumes `max5` = $100, `max20` = $200, but Pro users get `null` and likely break budget math

### 3b. Dual Plan Detection Paths Can Conflict — **MEDIUM severity**

**Files:** `extension/content.js:112` (usage page scrape) and `extension/background.js:237-277` (billing page scrape)

Two independent mechanisms detect the plan:
1. Content script scrapes the usage page on every visit
2. Background script scrapes the billing page on install (once)

The content script's detection goes directly in the API payload. The background script's detection is stored in `chrome.storage.local['detected_plan_type']` but **is never read or sent in any sync**. The billing page detection is effectively dead code.

### 3c. Plan Switch Detection Is Server-Side Heuristic Only — **LOW severity**

**File:** `src/worker.js:549-591`

The extension sends raw numbers with no plan identifier. The server uses heuristics (weekly % drop, extra usage change, reset timer difference) to guess plan switches. This can misfire when:
- The user's usage genuinely drops (rate limit lifted)
- Timer differences are due to timezone/DST changes
- The "5% threshold" at line 559 doesn't account for edge cases near 0%

---

## 4. Edge Cases

### 4a. Multiple Tabs Create Duplicate Syncs — **MEDIUM severity**

**File:** `extension/manifest.json:12-17`

The content script runs on **every** tab matching `https://claude.ai/settings/usage*`. If the user has 2+ tabs open on the usage page:
- Each tab runs `scrapeAndSync()` independently
- Each tab sets its own 5-minute `setInterval`
- The 60-second dedup window (content.js:123) uses shared `chrome.storage.local`, which mitigates duplicates across tabs, but there's a race condition — two tabs could both read the cache as stale and both sync

### 4b. Multiple Accounts Not Handled — **MEDIUM severity**

The extension identifies users by **name** (scraped from the profile button). If someone has two Claude accounts (personal + work) in different browser profiles, they'd each run the extension independently. If they use the same browser (switching accounts), the name changes but the team selection persists. There's no account ID — just the display name. Name changes or collisions (two people named "John") cause data corruption on the server.

### 4c. Incognito Mode — **LOW severity**

**File:** `extension/manifest.json`

No `"incognito": "spanning"` or `"split"` key. Default behavior is that the extension doesn't run in incognito. This is fine but worth noting — incognito usage won't be tracked.

### 4d. Extension Updates Interrupt Running Timers — **LOW severity**

**File:** `extension/background.js:283-313`

`onInstalled` fires on update and recreates the alarm. The `setInterval` in content.js (line 186) would be killed if the content script is reloaded. No state is lost since it's just a polling interval, but there could be a gap.

---

## 5. Version Tracking

### 5a. Version Is Sent but "Outdated Nudge" Config Is Missing — **MEDIUM severity**

**File:** `extension/content.js:130`

```js
const payload = { name, team, source: 'extension', extensionVersion: manifest.version };
```

The version (`"1.8"`) is sent to the API and stored (`worker.js:737`). However, there is **no client-side logic** in the extension to:
- Fetch the latest version from the server
- Compare versions
- Display an "update available" nudge

The recent commit message mentions "outdated nudge config", but the extension code has no such feature. The nudge must be implemented entirely server-side in the dashboard, not in the extension itself.

---

## 6. Data Transformation Issues

### 6a. Scraped Reset Times Have Precision Drift — **MEDIUM severity**

**File:** `extension/content.js:62-74`

The session reset timer is computed as `Date.now() + parsed_minutes * 60000`. This means:
- Every scrape computes a **different** `sessionResetsAt` even if the underlying reset hasn't changed
- If scraped at 12:00 showing "Resets in 5 hr 0 min" → `sessionResetsAt = 17:00:00.123`
- If scraped at 12:05 showing "Resets in 4 hr 55 min" → `sessionResetsAt = 17:00:00.456`

These are close but not identical, which could trigger the plan-switch detector on the server (`worker.js:563-565`) that checks for timer differences > 1 hour.

### 6b. Weekly Reset Day Parsing Uses Local Timezone — **MEDIUM severity**

**File:** `extension/content.js:77-97`

```js
const now = new Date();
const reset = new Date(now);
```

The weekly reset date/time is computed in the **browser's local timezone** then converted to ISO string. But `toISOString()` outputs UTC. If the user is in IST (UTC+5:30), a "Monday 12:00 AM" reset target in local time becomes Sunday 6:30 PM UTC in the ISO string. The server has no way to know the user's timezone, so the stored value may be off.

### 6c. The `pct` Backward Compatibility Path in the Server — **LOW severity**

**File:** `src/worker.js:528-531`

The server still accepts a `pct` field for backward compatibility with old bookmarklets, treating it as `weeklyPct`. The extension never sends `pct`, but this code path means anyone with an old bookmarklet could inject data that overwrites weekly percentages.

---

## 7. Privacy Concerns

### 7a. `/api/usage` POST Endpoint Is Unauthenticated — **HIGH severity**

**File:** `src/worker.js:167-174`

```js
const isPublicUsageEndpoint = path === '/api/usage' && request.method === 'POST';
const auth = isPublicUsageEndpoint
  ? { valid: true, email: 'anonymous@extension', skipped: true }
  : await verifyAccessJWT(request, env);
```

The usage submission endpoint **skips all authentication**. Anyone can POST arbitrary data:
```
curl -X POST https://leaderboard.magizhan.work/api/usage \
  -d '{"name":"AnyUser","sessionPct":100,"weeklyPct":100}'
```

This allows:
- Spoofing anyone's usage numbers by name
- Auto-creating fake users
- Flooding the leaderboard with junk data

The comment says "CF Access Bypass policy lets it through" — this means the Cloudflare Access gateway also doesn't protect this endpoint.

### 7b. User's Full Display Name Is Transmitted — **LOW severity**

**File:** `extension/content.js:31-44`

The user's Claude display name (first + last name) is scraped and sent in plaintext. This is expected behavior for a leaderboard, but the name is sent to a third-party domain (`leaderboard.magizhan.work`) without explicit user consent beyond installing the extension.

### 7c. CF_Authorization JWT Sent to Leaderboard Server — **LOW severity**

**File:** `extension/background.js:163`

```js
if (jwt) headers['CF-Access-JWT-Assertion'] = jwt;
```

The Cloudflare Access JWT (which contains the user's email) is forwarded to the leaderboard API. This is by design for auth but means the server sees the user's corporate email address on every API call.

### 7d. Extension Has Broad `cookies` Permission — **LOW severity**

**File:** `extension/manifest.json:6`

The `cookies` permission + `host_permissions` for `https://leaderboard.magizhan.work/*` and `https://claude.ai/*` means the extension can read **all cookies** for both domains. This is needed for the CF_Authorization cookie, but it also grants access to claude.ai session cookies.

---

## 8. Code Quality Issues

### 8a. Scrape Logic Duplicated Across Two Files — **MEDIUM severity**

**Files:** `extension/content.js:26-113` and `extension/popup.js:216-298`

The scraping logic is fully duplicated between `content.js` (auto-sync) and `popup.js` (manual sync). Any bug fix in one must be manually applied to the other. They can easily drift.

**Fix:** Extract the scraping function into a shared module imported by both, or have the popup invoke the content script's function via messaging.

### 8b. Team Default "NC" in Content Script vs Popup Selection — **MEDIUM severity**

**File:** `extension/content.js:117`

```js
const team = stored.claude_lb_team || 'NC';
```

Content script defaults to "NC" if no team is stored. But the server (`worker.js:467-473`) **ignores team from extension syncs**:

```js
if (body.team && source !== 'extension') {
  // only update team from non-extension sources
}
```

So the "NC" default never actually writes, but it's misleading. The team field in the payload from the extension is dead data on every auto-sync after user creation. Only the **first** auto-sync (which auto-creates the user at `worker.js:458-463`) uses the team.

---

## Summary by Severity

| Severity | Count | Key Issues |
|----------|-------|------------|
| **HIGH** | 3 | Positional % scraping, unauthenticated API, silent sync failures |
| **MEDIUM** | 9 | Plan detection gaps, dedup hiding changes, duplicate scrape code, timezone issues, multiple tabs |
| **LOW** | 6 | Incognito, backward compat paths, cookie permissions, precision drift |

**Top 3 recommendations for immediate action:**

1. **Add structural anchoring to the scraper** — tie each `% used` to its section heading rather than relying on match order
2. **Add authentication to `/api/usage`** — even a shared secret or API key would prevent arbitrary data injection
3. **Add a retry queue for failed syncs** — store pending payloads in `chrome.storage.local` and retry on next alarm
