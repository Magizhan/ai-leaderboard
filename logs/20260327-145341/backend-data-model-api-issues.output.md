Here's the full audit report.

---

# Backend Audit Report — `src/worker.js`

## 1. Data Integrity / Race Conditions

### 1.1 Read-Modify-Write races on the `users` array (CRITICAL)
**File:** `src/worker.js:391-394`, `447-463`, `399-419`, `356-374`, `807-814`  
**Severity:** Critical

Every mutation of the `users` array follows a read-modify-write pattern (`kvGet` → mutate → `kvPut`) with no locking or CAS (compare-and-swap). Cloudflare KV is eventually consistent and provides no atomic read-modify-write. Two concurrent `POST /api/usage` calls that both auto-create a user will each read the same `users` array, append a user, and write — the second write silently overwrites the first, losing a user.

The `kvPut` shrink guard (line 1186-1196) mitigates *some* of this by detecting when the array shrinks by >1, but it doesn't catch the exact race where two concurrent writes both add 1 user — the resulting array has `length = original + 1` (not shrunk), so the guard doesn't trigger, and one user is lost.

This same race applies to: `addUser`, `updateUser`, `setUserConfig` (numPlans update), `addPlans`, `logUsage` (auto-create + team update), `deleteUser`, and `importData`.

**Suggested fix:** Use Cloudflare Durable Objects for the `users` key to serialize writes, or implement optimistic concurrency control with a version counter stored alongside the data.

### 1.2 Concurrent usage writes for the same user overwrite each other (HIGH)
**File:** `src/worker.js:447-754`  
**Severity:** High

`logUsage` reads `usage:{id}`, `history:{id}`, and `weekly:{id}`, mutates all three, then writes them back via `Promise.all`. Two concurrent syncs for the same user will each read the same state, compute independently, and the last writer wins — losing one data point entirely and potentially corrupting plan slot assignments.

**Suggested fix:** Gate per-user writes through a Durable Object or use KV's metadata field as a version stamp to detect conflicts and retry.

### 1.3 `deleteUser` doesn't use `allowShrink` flag (MEDIUM)
**File:** `src/worker.js:431`  
**Severity:** Medium

`deleteUser` calls `kvPut(env, 'users', users)` at line 431 without `{ allowShrink: true }`. The shrink guard at line 1186-1196 will trigger if the filtered array shrank by >1 (which shouldn't happen for a single delete), but the intent was clearly to pass `allowShrink: true` here. If the `users` array was concurrently modified, the guard could re-merge the deleted user back in.

**Suggested fix:** Pass `{ allowShrink: true }` in the `deleteUser` call.

### 1.4 Cache invalidation is fire-and-forget (LOW)
**File:** `src/worker.js:1012`, `1201-1203`  
**Severity:** Low

`invalidateLeaderboardCache` calls `env.LEADERBOARD_KV.delete()` without awaiting it. If the delete fails silently, stale cached data could persist for up to 60 seconds. Similarly, the cache write at line 1012 is fire-and-forget — if it fails, every subsequent request recomputes the full leaderboard.

**Suggested fix:** Await the delete in `invalidateLeaderboardCache`. Consider awaiting the cache write too.

---

## 2. Schema Gaps

### 2.1 No historical per-plan tracking in history entries (HIGH)
**File:** `src/worker.js:683-710`  
**Severity:** High

History entries store flat `sessionPct` / `weeklyPct` values but no `planType`, `activePlan` index, or per-plan breakdown. When the leaderboard reconstructs monthly usage from history (lines 892-946), it tries to infer per-plan splits heuristically (e.g., "excess above 100% = plan 2" at line 913). This is fragile and will misattribute usage when users switch between plans mid-week.

**Suggested fix:** Add `planType`, `activePlan`, and per-plan values to history entries so reconstruction doesn't rely on heuristics.

### 2.2 No `createdAt` or `lastSeen` on user records (MEDIUM)
**File:** `src/worker.js:392-393`  
**Severity:** Medium

User records only have `id`, `name`, `team`, `numPlans`. There's no `createdAt` timestamp, making it impossible to tell when a user joined. The `lastUpdated` field is derived from `usage:{id}` at leaderboard query time, but if a user has never synced, there's no way to know when they were added.

**Suggested fix:** Add `createdAt` to user records on creation.

### 2.3 Weekly aggregation doesn't track plan type per data point (MEDIUM)
**File:** `src/worker.js:758-801`  
**Severity:** Medium

`updateWeeklyAggregation` tries to get `planType` from the latest history entry (line 773), but history entries don't store `planType` (see 2.1). `latestHistoryEntry.planType` will always be `null`/`undefined`, so weekly records never have an accurate `planType`.

**Suggested fix:** Either add `planType` to history entries, or look it up from the `usage:{id}` record.

### 2.4 `numPlans` inconsistency between config and user record (LOW)
**File:** `src/worker.js:362-371` vs `413-415`  
**Severity:** Low

`numPlans` is stored on the user record in the `users` array, but can be set via two different endpoints: `PUT /api/users/:id/config` (line 362-371) and `PATCH /api/users/:id` (line 413-415). The config endpoint caps at 10 (`Math.min(10, ...)`), but `addPlans` (line 812-813) caps at 999 (`Math.min(user.numPlans + count, 999)`), and `addUser` (line 388) caps at 100. Inconsistent max values.

**Suggested fix:** Centralize `numPlans` validation to a single max value.

---

## 3. API Design Flaws

### 3.1 `POST /api/usage` is completely unauthenticated (HIGH)
**File:** `src/worker.js:167-174`  
**Severity:** High

The usage endpoint bypasses JWT verification entirely (line 170-174). Anyone who knows the API URL can submit arbitrary usage data for any user by name, create fake users, and pollute the leaderboard. The comment says it's because the extension uses `sendBeacon` from `claude.ai`, but there's no alternative authentication (e.g., API key, HMAC signature, or user-scoped token).

**Suggested fix:** Add a lightweight authentication mechanism — e.g., a shared secret in the extension that's sent as a header, or HMAC-sign the payload with a per-user token.

### 3.2 User lookup by name is case-insensitive but creation is case-preserving (MEDIUM)
**File:** `src/worker.js:455`  
**Severity:** Medium

`logUsage` finds users with `u.name.toLowerCase() === name.toLowerCase()`, but `addUser` stores the name as-is. Two calls with different casing (e.g., "Alice" and "alice") will create one user then match it — but if two `addUser` calls arrive, you get duplicate users with different casing that `logUsage` will both match (first match wins via `Array.find`).

**Suggested fix:** Normalize name casing on storage, or add a uniqueness check (case-insensitive) on user creation.

### 3.3 No duplicate name check on user creation (MEDIUM)
**File:** `src/worker.js:385-397`  
**Severity:** Medium

`addUser` doesn't check if a user with the same name already exists. Multiple `POST /api/users` calls with the same name create duplicate entries. `logUsage` will only ever match the first one (via `Array.find`), making the others orphaned.

**Suggested fix:** Check for existing user with the same name (case-insensitive) before creating.

### 3.4 Import endpoint accepts unsanitized usage data (MEDIUM)
**File:** `src/worker.js:1117-1148`  
**Severity:** Medium

`importData` sanitizes user names and teams, but writes `usageLogs`, `historyLogs`, and `weeklyLogs` directly to KV without any validation (lines 1133-1144). An import payload with malformed `userId` keys could write to arbitrary KV keys (e.g., `usage:../../something`), or inject corrupted data that crashes the leaderboard computation.

**Suggested fix:** Validate that imported `userId` values exist in the merged user list and sanitize the data structure.

### 3.5 History/weekly endpoints don't validate user exists (LOW)
**File:** `src/worker.js:1021-1029`  
**Severity:** Low

`getUserHistory` and `getUserWeekly` accept any `userId` without checking if it's a valid user. Returns `[]` for non-existent users, which is benign but could mask typos.

### 3.6 `limit` parameter not clamped (LOW)
**File:** `src/worker.js:249, 254`  
**Severity:** Low

`parseInt(url.searchParams.get('limit') || '200')` has no upper bound. A client could pass `?limit=999999` — though the data is capped at 500 history entries anyway, so impact is minimal.

### 3.7 Projects/Strategies `status`, `type`, `impact` fields not validated (LOW)
**File:** `src/worker.js:276, 291, 311, 324`  
**Severity:** Low

`project.status`, `strategy.type`, and `strategy.impact` are stored as-is from the request body without validation against an allowlist. The `name`/`description` fields are sanitized via `sanitizeString`, but these enum-like fields aren't.

---

## 4. Usage Tracking Accuracy

### 4.1 Monotonic enforcement uses session slot, not actual session identity (HIGH)
**File:** `src/worker.js:615-636`  
**Severity:** High

Monotonic increase is enforced by comparing the current 5-hour slot (`getSessionSlot`) with the last history entry's slot. But Claude's actual session window doesn't align with arbitrary 5-hour blocks. If a user's session resets in the middle of a 5-hour window, the monotonic guard will reject the legitimately lower value because the slot hasn't changed. Conversely, if a session spans two slots, a new slot allows any value — even a false decrease.

**Suggested fix:** Use the `sessionResetsAt` timer as the primary session identity instead of time-based slots.

### 4.2 Combined session/weekly values mix raw and combined in history (MEDIUM)
**File:** `src/worker.js:683-710`  
**Severity:** Medium

At line 693-694, history entries are updated with `combinedSessionPct` and `combinedWeeklyPct` (which aggregate across all plan slots), but the comment at line 683 says "store active plan's raw values." This inconsistency means multi-plan users' history entries contain inflated values (sum of all plans), which corrupts the weekly aggregation and monthly calculation that reads from history.

**Suggested fix:** Decide whether history tracks raw per-plan or combined values, and be consistent. The monthly calculation at lines 892-946 already tries to decompose combined values back into per-plan values, which is lossy.

### 4.3 Session reset estimation is inaccurate (MEDIUM)
**File:** `src/worker.js:663-671`  
**Severity:** Medium

When the extension doesn't send `sessionResetsAt`, the worker estimates it as `now + 5 hours` (line 668). This is hardcoded and may not match Claude's actual session window length, which can vary. An inaccurate estimate will cause either premature resets (accepting drops too early) or delayed resets (rejecting legitimate drops).

### 4.4 `extraUsageSpent` contributes to `displayWeeklyPct` without bounds (MEDIUM)
**File:** `src/worker.js:958-961`  
**Severity:** Medium

Extra usage adds `(extraSpent / (planCost * 4)) * 100` to `displayWeeklyPct`. If `extraUsageSpent` is very large (e.g., $2000), this produces 250% on top of existing values. There's no cap, so a single user could dominate the leaderboard with uncapped extra spending.

**Suggested fix:** Cap the extra usage contribution or apply diminishing returns.

### 4.5 Weekly reset zeroes all plan slots indiscriminately (LOW)
**File:** `src/worker.js:543-547`  
**Severity:** Low

When the active plan's weekly timer expires, ALL plan slots are zeroed (line 544-546). But different plans may have different billing cycles. Plan 2's weekly timer hasn't expired, yet its `weeklyPct` is wiped.

**Suggested fix:** Only zero plans whose own `weeklyResetsAt` has expired.

---

## 5. Multi-Plan Support

### 5.1 Plan switch detection heuristics are fragile (HIGH)
**File:** `src/worker.js:549-592`  
**Severity:** High

Plan switch detection relies on heuristics: weekly dropped >5%, extra usage changed >$20, reset timer differs by >1hr, or session is fresh while weekly jumped >20%. These magic numbers will misfire:
- A legitimate large session within the same plan that happens to push weekly up by >20% with a fresh session triggers `sessionFreshWeeklyJumped`.
- Two plans with similar usage patterns (<$20 extra difference, similar reset times) will never trigger a switch.
- The `weeklyDropped` check fires when weekly goes down by >5 without an expired timer, but normal Claude rate-limit fluctuations could cause small drops.

**Suggested fix:** Have the extension explicitly report which plan it's observing (e.g., send a `planId` or account identifier).

### 5.2 LRU fallback can overwrite active plan data (MEDIUM)
**File:** `src/worker.js:581-589`  
**Severity:** Medium

When no close plan-slot match is found (diff > 20), the code picks the least-recently-used slot. But the LRU slot may contain valid data from a plan that just hasn't been used recently. Overwriting it with new data from a misidentified "switch" corrupts that plan's tracking.

### 5.3 Plans array can grow beyond `numPlans` and never shrinks (LOW)
**File:** `src/worker.js:514-522`  
**Severity:** Low

The `plans` array is padded to match `numPlans` but never trimmed if `numPlans` decreases. If a user reduces from 3 plans to 1, the array stays at 3 elements, and combined totals still sum all 3.

---

## 6. Data Freshness

### 6.1 No staleness indicator for user data (MEDIUM)
**File:** `src/worker.js:963-982`  
**Severity:** Medium

The leaderboard shows `lastUpdated` from the usage record, but there's no visual/data distinction between a user who synced 5 minutes ago and one who synced 3 weeks ago. Stale users skew team averages and rankings.

**Suggested fix:** Add an `isStale` flag (e.g., `lastUpdated > 24h ago`) to leaderboard output, or exclude very stale users from rankings.

### 6.2 Session auto-reset in leaderboard display, but not in stored data (MEDIUM)
**File:** `src/worker.js:875-877`  
**Severity:** Medium

`getLeaderboardData` shows `rawSessionPct = 0` if the session timer expired (line 876), but the stored `usage:{id}` record still holds the old `sessionPct`. This means the next sync will compare against the stale stored value for monotonic enforcement. If the user's real session reset and started climbing, the old stored value may be higher, causing legitimate updates to be silently rejected.

**Suggested fix:** Actually zero the stored `sessionPct` when the timer expires (write-through), not just display it as 0.

### 6.3 Leaderboard cache stored in KV has eventual consistency lag (LOW)
**File:** `src/worker.js:825-828`, `1012`  
**Severity:** Low

The leaderboard cache is stored in KV with a 60s TTL. But KV itself has eventual consistency (writes may take up to 60s to propagate globally). So in the worst case, a user could see data up to ~120s stale (60s cache TTL + 60s KV propagation).

---

## 7. Security

### 7.1 JWT not cryptographically verified (MEDIUM)
**File:** `src/worker.js:57-64`  
**Severity:** Medium

The JWT is decoded with `atob` but never cryptographically verified (comment at line 57-59 says "Cloudflare Access at the edge already verified the signature"). While CF Access does validate at the edge, if the Access policy is misconfigured or bypassed (e.g., direct worker URL access), the worker would accept any well-formed JWT with the right claims.

### 7.2 CORS allows any `chrome-extension://` origin (LOW)
**File:** `src/worker.js:155`  
**Severity:** Low

Any Chrome extension can make cross-origin requests to this API. Combined with the unauthenticated `/api/usage` endpoint (3.1), any malicious extension could submit fake data.

---

## 8. Test Coverage Gaps

Reviewing `test/e2e.test.mjs`, the following scenarios are **NOT tested**:

| Gap | Severity |
|-----|----------|
| Concurrent writes / race conditions | High |
| Multi-plan switch detection accuracy | High |
| Leaderboard `displayWeeklyPct` / monthly calculation correctness | High |
| Import with malformed/malicious data | Medium |
| History entry content correctness (raw vs combined values) | Medium |
| Session auto-reset on expired timers (stored vs displayed) | Medium |
| Weekly reset zeroing all plans vs. only expired plans | Medium |
| Duplicate user name creation | Medium |
| `PATCH /api/users/:id` endpoint | Medium |
| `DELETE` + `allowShrink` guard interaction | Medium |
| Projects & Strategies CRUD (no tests at all) | Low |
| `GET /api/team-weekly/:team` endpoint | Low |
| Cache invalidation / staleness behavior | Low |
| `addPlans` endpoint | Low |
| Export completeness (all KV keys included) | Low |
