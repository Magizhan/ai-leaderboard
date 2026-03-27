# Phase 1: Data Integrity Fixes

## 1a. Fix deleteUser allowShrink and add duplicate name check
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: opus
- effort: high
- allowedTools: Read Grep Glob Edit Bash

You are fixing TWO specific bugs in `src/worker.js`. Read the file first, understand the full context, then make ONLY these two changes. Do not refactor surrounding code.

### Fix 1: deleteUser missing allowShrink

At approximately line 431, `deleteUser` calls `kvPut(env, 'users', users)` without passing `{ allowShrink: true }`. The shrink guard at ~line 1186-1196 may re-merge a deleted user if the array was concurrently modified.

**Change:** Add `{ allowShrink: true }` as the 4th argument to the `kvPut` call in `deleteUser`.

### Fix 2: Duplicate name check on user creation

At approximately line 385-397, `addUser` doesn't check if a user with the same name already exists. Add a case-insensitive check before creating.

**Change:** Before generating the user ID, check if `users.some(u => u.name.toLowerCase() === name.toLowerCase())`. If found, return a 409 response: `{ error: 'User with this name already exists' }`.

### Acceptance criteria
After making changes, verify by running:
```bash
grep -n 'allowShrink' src/worker.js  # Should show the deleteUser line
grep -n 'already exists' src/worker.js  # Should show the duplicate check
```

Create a git commit with message: "fix: add allowShrink to deleteUser, prevent duplicate user names"

DO NOT touch any other code. DO NOT refactor. DO NOT add comments to unchanged lines.

## 1c. Anchor extension scraping to section headings
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: opus
- effort: high
- allowedTools: Read Grep Glob Edit Bash

You are fixing the fragile positional scraping in `extension/content.js` (approximately lines 26-113, and the duplicate in `extension/popup.js` ~lines 216-298).

### The problem
Currently, `document.body.innerText` is searched with `/(\d{1,3})%\s*used/g` and percentages are assigned by position (1st = session, 2nd = weekly). If Anthropic reorders sections or adds a new meter, values silently swap.

### The fix
Instead of matching all `% used` globally and picking by index, split the body text by section headings and extract from within each section:

1. Find the text near "Current session" or "Session" heading — extract the `% used` from THAT section only → `sessionPct`
2. Find the text near "Weekly" heading — extract from THAT section → `weeklyPct`
3. For extra usage, find text near "Extra usage" — extract `% used` → `extraUsagePct`

**Implementation approach:**
```js
// Split body text into sections by looking for known headings
const bodyText = document.body.innerText;

// Extract session % - look for % near "session" context
const sessionSection = bodyText.match(/(?:current\s+)?session[\s\S]{0,200}?(\d{1,3})%\s*used/i);
const sessionPct = sessionSection ? parseInt(sessionSection[1]) : null;

// Extract weekly % - look for % near "weekly" context
const weeklySection = bodyText.match(/weekly[\s\S]{0,200}?(\d{1,3})%\s*used/i);
const weeklyPct = weeklySection ? parseInt(weeklySection[1]) : null;
```

**IMPORTANT:** Keep the existing positional matching as a FALLBACK if the anchored approach finds nothing. This ensures backward compatibility if Anthropic changes heading text.

Apply the SAME fix to `extension/popup.js` (the duplicated scrape logic around lines 216-298). Keep both files in sync.

### Acceptance criteria
```bash
grep -n 'session.*used' extension/content.js  # Should show anchored regex
grep -n 'weekly.*used' extension/content.js   # Should show anchored regex
grep -n 'session.*used' extension/popup.js    # Same pattern in popup
```

Verify that the old positional code still exists as fallback (not deleted).

Create a git commit with message: "fix: anchor extension scraping to section headings with positional fallback"

DO NOT change the sync logic, dedup logic, or anything outside the scraping function. DO NOT add new dependencies.

## 1e. Verify Phase 1
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: sonnet
- effort: medium
- allowedTools: Read Grep Glob Bash

You are a VERIFICATION agent. Your job is to check that Phase 1 fixes were applied correctly. Do NOT make any changes.

### Check 1: deleteUser allowShrink
- Read `src/worker.js` and find the `deleteUser` function
- Verify it passes `{ allowShrink: true }` to `kvPut`
- Report: PASS or FAIL with line number

### Check 2: Duplicate name check
- Read `src/worker.js` and find the `addUser` function
- Verify there's a case-insensitive name uniqueness check BEFORE user creation
- Verify it returns 409 on duplicate
- Report: PASS or FAIL with line number

### Check 3: Anchored scraping in content.js
- Read `extension/content.js` scraping logic
- Verify percentages are extracted by section heading (not just positional index)
- Verify positional fallback still exists
- Report: PASS or FAIL with line numbers

### Check 4: Anchored scraping in popup.js
- Read `extension/popup.js` scraping logic
- Verify it matches the same pattern as content.js
- Report: PASS or FAIL with line numbers

### Check 5: No regressions
- Run `npm test` and report results
- Check that no other functions in worker.js were modified (compare git diff scope)

### Output format
Write a verification report as a markdown table:

| Check | Status | Details |
|-------|--------|---------|
| deleteUser allowShrink | PASS/FAIL | line X |
| Duplicate name check | PASS/FAIL | line X |
| content.js anchored scraping | PASS/FAIL | lines X-Y |
| popup.js anchored scraping | PASS/FAIL | lines X-Y |
| Tests pass | PASS/FAIL | output |
| No unintended changes | PASS/FAIL | diff scope |

If ANY check fails, clearly explain what's wrong so it can be fixed manually.
