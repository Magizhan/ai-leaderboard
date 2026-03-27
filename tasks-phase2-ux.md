# Phase 2: UX Foundations

## 2a. Personal identity card, rank progress, staleness, team battle
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: opus
- effort: high
- allowedTools: Read Grep Glob Edit Bash

You are adding UX improvements to `public/index.html`. Read the full file first to understand the existing structure. Make ONLY the changes described below. Do NOT refactor existing code.

### Change 1: "My Status" personal identity card

Add a pinned card above the leaderboard that shows the current user's stats. The user's name is stored in `localStorage.getItem('claude_lb_name')`.

- When rendering the leaderboard (in the existing render function), check if `localStorage.getItem('claude_lb_name')` matches a user in the data
- If found, render a hero card above the leaderboard table with:
  - Their name, rank badge, and current multiplier/percentage prominently
  - "Rank #X of Y"
  - Next rank threshold: "→ Diamond: 25% to go" with a thin progress bar
  - If no match found, show nothing (don't break the page)
- Style it with a subtle gradient border to distinguish from the leaderboard rows
- Add a small "Not you? Change" link that opens the settings/user picker

### Change 2: Rank-up progress bar in leaderboard rows

In each leaderboard row, after the rank badge, add a tiny inline progress bar (40px wide, 4px tall) showing progress toward the next rank. Use the existing rank thresholds from the `getRank` function.

### Change 3: Rank change deltas

- On each leaderboard render, store current positions in `localStorage` as `lb_prev_positions` (JSON map of userId → position)
- On next render, compare and show ↑N / ↓N / — next to the rank number
- Use green for up, red for down, dim for no change
- First render (no previous data) shows nothing

### Change 4: Staleness indicators

- For users whose `lastUpdated` is older than 24 hours, add a dim opacity (0.5) to the row
- Add a small "STALE" tag (similar to existing tag styles) next to the "ago" timestamp
- For users older than 72 hours, show "INACTIVE" instead

### Change 5: Team battle mini-bar on Individual tab

The team mini-battle bar currently only shows in the Team tab. Move/copy it so it also appears on the Individual tab, positioned between the utilisation gauge and the leaderboard table. Keep it compact (single row, ~40px tall).

### Acceptance criteria
After changes, verify:
```bash
grep -n 'claude_lb_name\|my-status\|MY.STATUS' public/index.html | head -5  # Personal card
grep -n 'rank-progress\|progress-bar' public/index.html | head -3  # Progress bar
grep -n 'lb_prev_positions' public/index.html | head -3  # Rank deltas
grep -n 'STALE\|INACTIVE\|isStale' public/index.html | head -3  # Staleness
grep -n 'team-mini.*individual\|mini-battle' public/index.html | head -3  # Team bar
```

Create a git commit: "feat: add personal status card, rank progress, deltas, staleness, team bar on individual tab"

DO NOT modify src/worker.js. DO NOT add new files. DO NOT add external dependencies.

## 2b. Add ROI data and staleness flag to leaderboard API
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: opus
- effort: high
- allowedTools: Read Grep Glob Edit Bash

You are adding two fields to the leaderboard API response in `src/worker.js`. Read the file first, find the `getLeaderboardData` function (around line 850-1000), and make ONLY these changes.

### Change 1: Add `isStale` flag

In the leaderboard user object (where `lastUpdated` is set), add:
```js
isStale: lastUpdated && (Date.now() - new Date(lastUpdated).getTime()) > 24 * 60 * 60 * 1000,
isInactive: lastUpdated && (Date.now() - new Date(lastUpdated).getTime()) > 72 * 60 * 60 * 1000,
```

### Change 2: Add ROI / value extraction data

In the same leaderboard user object, add:
```js
valueExtracted: Math.round((displayWeeklyPct / 100) * planCost),
planCost: planCost,
roi: displayWeeklyPct > 0 ? Math.round((displayWeeklyPct / 100) * 100) / 100 : 0,
```

Where `planCost` is already calculated in the function (look for the existing plan cost calculation). `roi` is the multiplier (1.0 = breaking even, 1.6 = getting 60% more value).

### Acceptance criteria
```bash
grep -n 'isStale\|isInactive' src/worker.js | head -3
grep -n 'valueExtracted\|roi:' src/worker.js | head -3
npm test 2>&1 | tail -5  # All tests must pass
```

Create a git commit: "feat: add isStale, isInactive, valueExtracted, roi to leaderboard API"

DO NOT touch public/index.html. DO NOT modify any other function besides `getLeaderboardData`.

## 2c. Verify Phase 2
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: sonnet
- effort: medium
- allowedTools: Read Grep Glob Bash

You are a VERIFICATION agent. Check that Phase 2 fixes were applied correctly. Do NOT make changes.

### Checks

1. **Personal identity card**: Read `public/index.html`, verify there's code that reads `claude_lb_name` from localStorage and renders a personal status card above the leaderboard.

2. **Rank progress bar**: Verify leaderboard rows include a progress indicator toward the next rank.

3. **Rank deltas**: Verify `lb_prev_positions` is stored/read from localStorage and ↑/↓ indicators are rendered.

4. **Staleness**: Verify rows get dimmed/tagged for stale (>24h) and inactive (>72h) users.

5. **Team battle on Individual tab**: Verify the team mini-battle bar renders on the Individual tab, not just Team tab.

6. **API changes**: Verify `src/worker.js` `getLeaderboardData` returns `isStale`, `isInactive`, `valueExtracted`, `roi` fields.

7. **Tests**: Run `npm test` and report results.

8. **No regressions**: Check git diff scope — only `public/index.html` and `src/worker.js` should be modified.

### Output format

| Check | Status | Details |
|-------|--------|---------|
| Personal identity card | PASS/FAIL | line X |
| Rank progress bar | PASS/FAIL | line X |
| Rank deltas | PASS/FAIL | line X |
| Staleness indicators | PASS/FAIL | line X |
| Team battle on Individual tab | PASS/FAIL | line X |
| API: isStale/isInactive | PASS/FAIL | line X |
| API: valueExtracted/roi | PASS/FAIL | line X |
| Tests pass | PASS/FAIL | output |
| No unintended changes | PASS/FAIL | diff scope |
