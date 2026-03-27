# Phase 3: Nudge Engine

## 3a. Confetti on milestones and ROI display
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: opus
- effort: high
- allowedTools: Read Grep Glob Edit Bash

You are adding two features to `public/index.html`. Read the file first, find the existing confetti function and the renderData/renderLeaderboard functions.

### Change 1: Confetti on milestones

Currently `confetti()` only fires on user creation (search for existing confetti calls). Add milestone celebrations:

- In `renderData` or `renderMyStatus`, after rendering the personal status card, check if the user crossed a rank threshold since last render
- Store previous rank in `localStorage` as `lb_prev_rank`
- If rank changed upward (e.g., Platinum → Diamond), fire confetti and show a brief toast notification: "Rank up! Diamond 💎"
- Also fire confetti if user crosses 100% (1.0x) for the first time in a session — store `lb_celebrated_100` in sessionStorage

The toast should be a simple fixed-position div at top center, auto-dismiss after 3 seconds. Add minimal CSS for it.

### Change 2: ROI / Value display in personal status card

The API now returns `valueExtracted`, `planCost`, and `roi` per user. In the `renderMyStatus` function (search for `my-status-card`), add after the percentage display:

- Show ROI as: "$X / $Y plan" (e.g., "$320 / $200 plan")
- If roi >= 1.0, show in green with "🎯 Getting your money's worth!"
- If roi < 0.5, show in orange with "Room to grow"
- Keep it compact — one line, small font (0.75rem)

### Acceptance criteria
```bash
grep -n 'lb_prev_rank\|rank.*up\|milestone' public/index.html | head -5
grep -n 'valueExtracted\|roi\|money.*worth' public/index.html | head -5
```

Create a git commit: "feat: confetti on rank milestones, ROI display in personal card"

DO NOT modify src/worker.js. Keep changes minimal and focused.

## 3b. Streak tracking in worker
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: opus
- effort: high
- allowedTools: Read Grep Glob Edit Bash

You are adding streak tracking to `src/worker.js`. Read the file first.

### What is a streak?
A streak counts consecutive days where a user has synced AND their weekly usage is above 20%. This incentivizes daily engagement.

### Changes to `logUsage` function

After the history update section (after the history push), add streak calculation:

```js
// --- Streak tracking ---
const streakData = usage.streak || { count: 0, lastActiveDate: null };
const today = new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD
if (combinedWeeklyPct >= 20 && today !== streakData.lastActiveDate) {
  const yesterday = new Date(nowMs - 86400000).toISOString().slice(0, 10);
  if (streakData.lastActiveDate === yesterday) {
    streakData.count += 1;
  } else if (!streakData.lastActiveDate) {
    streakData.count = 1;
  } else {
    streakData.count = 1; // streak broken, restart
  }
  streakData.lastActiveDate = today;
}
```

Store `streak` in the usage data object (alongside `plans`, `activePlan`, etc.).

### Changes to `getLeaderboardData`

In the board map where user objects are built, add:
```js
streak: usage ? (usage.streak || { count: 0 }).count : 0,
```

### Acceptance criteria
```bash
grep -n 'streak' src/worker.js | head -10
npm test 2>&1 | tail -5
```

Create a git commit: "feat: add streak tracking (consecutive active days)"

DO NOT touch public/index.html. Only modify src/worker.js.

## 3c. Streak display and billing countdown in frontend
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: opus
- effort: high
- allowedTools: Read Grep Glob Edit Bash

You are adding streak display and billing countdown to `public/index.html`. Read the file first.

### Change 1: Streak display in leaderboard rows

In the `buildRowHTML` function, after the rank badge, if `u.streak > 0`, add a streak badge:
```html
<span class="lb-streak" title="N-day streak">🔥N</span>
```

Add CSS for `.lb-streak`:
```css
.lb-streak { font-size: 0.65rem; color: #ff6b35; font-weight: 700; margin-left: 4px; }
```

### Change 2: Billing cycle countdown on main view

In the `renderData` function, after the utilisation gauge section, add a compact billing countdown:
- Find the user with the soonest `weeklyResetsAt` timestamp
- Display: "Weekly reset in X days Y hours" as a small line below the gauge
- Style: 0.72rem, dim color, centered

### Acceptance criteria
```bash
grep -n 'lb-streak\|streak' public/index.html | head -5
grep -n 'countdown\|reset in\|billing' public/index.html | head -5
```

Create a git commit: "feat: streak badges in leaderboard, billing countdown on main view"

DO NOT modify src/worker.js.

## 3d. Verify Phase 3
- workdir: /Users/ilamara/Documents/code/ai-leaderboard
- model: sonnet
- effort: medium
- allowedTools: Read Grep Glob Bash

Verification agent. Do NOT make changes. Wait 30 seconds before starting checks (to let fix tasks finish).

### Checks

1. **Confetti on milestones**: Verify `public/index.html` has `lb_prev_rank` in localStorage and confetti fires on rank change
2. **ROI display**: Verify personal status card shows `valueExtracted` / `planCost`
3. **Streak tracking in worker**: Verify `src/worker.js` has streak calculation in `logUsage` and streak field in leaderboard output
4. **Streak display**: Verify `public/index.html` shows streak badges (🔥) in leaderboard rows
5. **Billing countdown**: Verify countdown display in main view
6. **Tests pass**: Run `npm test`

| Check | Status | Details |
|-------|--------|---------|
| Confetti milestones | PASS/FAIL | line X |
| ROI display | PASS/FAIL | line X |
| Streak in worker | PASS/FAIL | line X |
| Streak in UI | PASS/FAIL | line X |
| Billing countdown | PASS/FAIL | line X |
| Tests pass | PASS/FAIL | output |
