Large file. Let me read it in sections and also search for key patterns in parallel.
Now I have the full file. Here's the audit.

---

# UX & Gamification Audit: Claude Usage Leaderboard

## 1. Visibility of Current Status

### 1a. No "My Status" Card — Users Can't Instantly Find Themselves
- **What's missing**: There's no concept of "the current viewer's identity." Everyone sees the same leaderboard and must scan to find their own row. No pinned/highlighted personal card at top.
- **Where**: Entirely absent from the HTML/JS — no localStorage lookup for the current user, no highlight.
- **Why it matters**: The single most important nudge is showing someone *their own* number front and center. Right now, a user with 30 participants has to scan the list. This kills the "at a glance" motivation.
- **Severity**: **Critical**
- **Suggested approach**: Store the user's ID in localStorage (the console paste already stores `claude_lb_name`). On render, pin their row at the top with a "YOU" badge and distinct styling. Show their rank, percentage, and next rank threshold in a hero card above the leaderboard.

### 1b. Multiplier Format (0.25x) Is Confusing
- **What's broken**: Lines 1244-1250 format percentages as multipliers ("0.25x" for 25%). Users on Max 5x plans show "0.25x" at 100% usage due to normalization (`planNormFactor`, line 1232-1234). This is mathematically correct but motivationally confusing — "0.25x" doesn't *feel* like you're maxing out.
- **Why it matters**: The format obscures whether you're doing well or poorly. Users need to understand the normalization model to interpret their score.
- **Severity**: **High**
- **Suggested approach**: Show the raw percentage prominently (e.g., "100%") with the normalized multiplier as a secondary annotation. Or show a user-relative progress bar: "You've used 100% of YOUR plan."

### 1c. Utilisation Gauge Is Aggregate, Not Personal
- **What's broken**: Lines 711-736 show total team budget utilisation in INR. This is useful for a manager but doesn't tell an individual user how *they're* contributing.
- **Why it matters**: Individual motivation requires individual feedback. "The org is at 47%" doesn't tell me if I'm the problem or the hero.
- **Severity**: **Medium**
- **Suggested approach**: Below the aggregate gauge, add a personal one: "You: 0.65x — Top 40%" or a "your contribution to the team gauge" marker.

---

## 2. Nudging Effectiveness

### 2a. No Rank-Up Progress / "Next Rank" Indicator
- **What's missing**: The rank system (lines 1102-1110: Bronze → Mythic) assigns a badge but shows no progress toward the *next* rank. A user at 55% (Platinum) has no visual cue that Diamond is 25% away.
- **Why it matters**: Progress bars toward the next goal are one of the most effective gamification patterns. Without it, ranks feel like static labels rather than targets.
- **Severity**: **High**
- **Suggested approach**: In the leaderboard row or detail panel, show a thin progress bar: "Platinum → Diamond: 55%/80% (31% to go)".

### 2b. No Rank Change Deltas (↑↓ Arrows)
- **What's missing**: No indication of whether a user moved up or down since the last refresh/session. No "you gained 3 positions" messaging.
- **Why it matters**: Position changes create urgency ("I dropped 2 spots!") and celebration ("I'm climbing!"). Static rankings feel stale.
- **Severity**: **High**
- **Suggested approach**: Store previous positions in localStorage or track on the server. Show ↑3 / ↓2 / — next to the rank position.

### 2c. Confetti Only Fires on User Creation, Never on Milestones
- **What's broken**: `confetti()` is called at line 1484 (add user) and line 1625 (import) — never when someone reaches 100%, hits Legendary, or achieves a new personal best.
- **Why it matters**: Celebration at the moment of achievement reinforces the behavior. Currently, the biggest moment (hitting 100%) gets no fanfare.
- **Severity**: **Medium**
- **Suggested approach**: Trigger confetti + a toast when a user's data crosses a rank threshold or hits 100% for the first time. Track previous rank in localStorage to detect transitions.

### 2d. No Streaks
- **What's missing**: No tracking of consecutive days/weeks where a user maintained high usage (e.g., "5-day streak above 50%").
- **Why it matters**: Streaks are one of the most powerful engagement mechanics (see Duolingo). They create a "don't break the chain" motivation that keeps users syncing daily.
- **Severity**: **Medium**
- **Suggested approach**: Server-side, track consecutive periods where weekly usage stayed above a threshold. Display a streak counter + flame icon in leaderboard rows.

### 2e. No "Falling Behind" / Peer Comparison Nudge
- **What's missing**: No messaging like "5 users overtook you this week" or "You're in the bottom 30%."
- **Why it matters**: Social comparison is a core driver of leaderboard engagement. Without it, the leaderboard is passive — users look but don't feel compelled to act.
- **Severity**: **Medium**
- **Suggested approach**: In the personal card (see 1a), show relative position context: "Top 15% of users" or "3 users passed you since Monday."

---

## 3. Going Beyond 1x / Value Extraction

### 3a. No "ROI" or "Money's Worth" Framing
- **What's missing**: Users pay $200/mo per plan but there's no "you've extracted $X of value" messaging. The concept of "getting more than your money's worth" is implicit but never stated.
- **Why it matters**: For a tool designed to maximize usage, showing "You've used $320 worth of Claude on a $200 plan — 1.6x ROI" is enormously motivating. It reframes usage from obligation to value capture.
- **Severity**: **High**
- **Suggested approach**: Add a "Value Extracted" stat in the detail panel and optionally in the main row. Calculate as `(weeklyPct / 100) * planCost`. Show it as "$X used / $200 plan = 1.6x value".

### 3b. "Beyond 100%?" Is a Tiny Afterthought
- **What's broken**: Line 732 has `<span class="gauge-beyond">Beyond 100%? Add more plans →</span>` — styled as 0.72rem italic dim text. This is the call-to-action for users to unlock overachievement, and it's nearly invisible.
- **Why it matters**: If the goal is to push people past 1x, the mechanism to do so needs to be prominent, not a footnote.
- **Severity**: **Medium**
- **Suggested approach**: When a user is near 100%, show a prominent banner: "You're at 95%! Add another plan to unlock Mythic rank and push past 1x." Make it contextual and urgent.

### 3c. Extra Usage Not Contextualized
- **What's broken**: Extra usage shows as `+$30` tag (line 1287) but there's no context — what percent of the limit? Is $30 a lot or a little?
- **Why it matters**: Raw dollar amounts without context don't motivate. "$30 of $200 limit (15%)" is much more actionable.
- **Severity**: **Low**
- **Suggested approach**: Show extra usage as a percentage of the limit in the tag: `+$30 (15%)`.

---

## 4. Plan Awareness & Fairness

### 4a. Pro/Free Users Are Silently Invisible
- **What's broken**: Line 1299 filters out non-Max plans: `const maxUsers = users.filter(u => !u.planType || u.planType.startsWith('max'))`. Pro/Free users exist in the system but vanish from the leaderboard without explanation.
- **Why it matters**: If a Pro user syncs their data and never appears, it's confusing and discouraging. They have no idea why they're excluded.
- **Severity**: **Medium**
- **Suggested approach**: Either show Pro/Free users in a separate section ("Non-GPU Plans") or show an explanation banner when a Pro/Free user is detected.

### 4b. Max 5x vs Max 20x Comparison Is Unfair in Presentation
- **What's broken**: Plan normalization (line 1232-1234) makes Max 5x users always appear to have 1/4 the multiplier. A Max 5x user at 100% shows "0.25x" while a Max 20x user at 25% also shows "0.25x" — they look identical despite very different behaviors.
- **Why it matters**: Max 5x users can never reach "Legendary" (would need 400% raw usage) which is demotivating. The rank system is structurally biased against cheaper plans.
- **Severity**: **Medium**
- **Suggested approach**: Consider separate leaderboards by plan type, or rank users based on their % within their own plan capacity (so 100% of Max 5x = Legendary for that user).

---

## 5. Freshness Indicators

### 5a. "Last Updated" Shows Client Fetch Time, Not Data Freshness
- **What's broken**: Line 1458 sets `'Last updated: ' + new Date().toLocaleString()` — this is when the *browser* last polled the API, not when any user last synced their data. Every 30-second auto-refresh updates this timestamp.
- **Why it matters**: "Last updated: just now" creates false confidence. The data could be hours old if nobody has synced recently.
- **Severity**: **Medium**
- **Suggested approach**: Show the most recent `lastUpdated` timestamp from any user in the dataset. Or show both: "Data refreshed: now | Newest sync: 2h ago".

### 5b. No Staleness Warning for Individual Users
- **What's broken**: Per-user "ago" timestamps (line 1280) are tiny (`0.62rem`, `color: var(--text-dim)`) and don't visually warn about staleness. A user who hasn't synced in 3 days looks the same as one who synced 5 minutes ago.
- **Why it matters**: Stale data reduces trust and makes the leaderboard feel dead. Users who haven't synced should be visually de-emphasized to encourage re-syncing.
- **Severity**: **High**
- **Suggested approach**: Add a stale indicator (e.g., faded row, "STALE" badge) for users who haven't synced in >24h. Use the existing `lb-outdated-tag` pattern but for data freshness, not extension version.

### 5c. LIVE Badge Is Decorative
- **What's broken**: Lines 76-86 show a pulsing "LIVE" dot that's always visible regardless of API connectivity or data freshness.
- **Why it matters**: "LIVE" implies real-time data. If the API fails or data is stale, this badge is misleading and erodes trust.
- **Severity**: **Low**
- **Suggested approach**: Hide or change the LIVE badge to "OFFLINE" when the API fetch fails (line 1182-1190 already catches errors but doesn't update the badge).

---

## 6. Team Dynamics

### 6a. Team Battle Hidden Behind Tab
- **What's broken**: The team mini-battle bar exists in CSS (lines 142-166) and has elements for `#nyMiniPct` etc. (line 1455), but it's rendered only inside the Team tab. The Individual tab — the default view — has no team context.
- **Why it matters**: Team competition only works if it's constantly visible. Hiding it behind a tab means most users never see it. The passive awareness of "NY is beating Xyne" should be ever-present.
- **Severity**: **High**
- **Suggested approach**: Bring the compact team mini-battle bar back to the Individual tab, positioned between the utilisation gauge and the leaderboard. It's small (40px tall) and high-value.

### 6b. Team Averages Are Gameable
- **What's broken**: Team scores use `avgWeeklyPct` (line 1445). A team with one user at 200% and four at 0% would average 40%, beating a team where all five users are at 35%.
- **Why it matters**: Averages reward extreme individual usage over broad team participation. This undermines the goal of getting *everyone* to use Claude.
- **Severity**: **Medium**
- **Suggested approach**: Consider alternative metrics: median usage, % of team members above a threshold, or a weighted score that rewards breadth (e.g., sum of min(pct, 100) across team members).

### 6c. No Team Challenges or Time-Boxed Competitions
- **What's missing**: No weekly/monthly team challenges like "First team to average 50% wins" or "Team with most members above Diamond this week."
- **Why it matters**: Ongoing leaderboards become wallpaper. Time-boxed competitions create urgency and event-based engagement.
- **Severity**: **Low**
- **Suggested approach**: Add a "This Week's Challenge" banner with a specific, achievable team goal and a countdown timer.

---

## 7. Missing Motivational Features (Summary of Additional Gaps)

| Feature | Severity | Notes |
|---|---|---|
| **Billing cycle countdown on main view** | Medium | Countdown timers exist in the detail panel (line 2286+) but not on the main leaderboard. Showing "5 days left in billing cycle" on the main view creates urgency. |
| **Achievement badges** | Medium | Beyond ranks, there are no one-time achievements ("First Sync", "100% Club", "7-Day Streak", "Team MVP"). These provide collectible motivation. |
| **"Who's online" indicator** | Low | No way to see who's currently active. Showing active session indicators would create FOMO. |
| **Personal best tracking** | Low | The detail panel shows peak session/monthly (lines 1886-1888) but there's no "New Personal Best!" celebration or badge in the main view. |
| **Notification preferences** | Low | No opt-in for browser notifications when rank changes or milestones are hit. |

---

## 8. Mobile Responsiveness & Accessibility

### 8a. Mobile Strips Critical Data
- **What's broken**: Lines 653-655 hide sparklines, usage bars, and plans columns on mobile. Users on mobile see only: rank number, name, team tag, rank badge, and percentage.
- **Why it matters**: Mobile is likely the most common casual-check platform. Losing trend data and usage context makes the mobile experience purely informational with no motivational depth.
- **Severity**: **Medium**
- **Suggested approach**: Replace the hidden columns with a compact inline progress bar under the name, or show a tiny sparkline next to the percentage. Prioritize keeping *some* visual progress indicator on mobile.

### 8b. No Accessibility Support
- **What's broken**: No ARIA labels on interactive elements, no `role` attributes, no screen reader support, no focus indicators beyond browser defaults, no skip-to-content link. Charts (SVG) have no `aria-label` or `<title>` elements.
- **Why it matters**: Excludes users relying on assistive technology. Also a compliance concern.
- **Severity**: **Medium** (for internal tool)
- **Suggested approach**: Add `aria-label` to buttons, `role="img"` + `aria-label` to chart SVGs, visible focus styles for keyboard navigation.

### 8c. Very Small Font Sizes
- **What's broken**: Multiple elements use `0.5rem` (8px), `0.55rem` (8.8px), or `0.6rem` (9.6px) — for example team-mini-name (line 156), lb-plan-tag (line 345), stat-label on mobile (line 591: 0.5rem → 0.45rem at 480px!). WCAG recommends minimum 12px for body text.
- **Why it matters**: Difficult to read on mobile, especially in bright environments. Labels like plan type and update timestamps become illegible.
- **Severity**: **Low**
- **Suggested approach**: Audit font sizes to ensure nothing goes below 10px (0.625rem). Use abbreviations or icons instead of tiny text where space is constrained.

### 8d. No Reduced Motion Support
- **What's broken**: Multiple animations: `bgPulse` (line 62), `livePulse` (line 86), `slideIn` (line 321), `maxPulse` (line 378), `overflowShift` (line 376), `fireFlicker` (line 383), confetti (line 1709-1728). No `prefers-reduced-motion` media query.
- **Why it matters**: Users with vestibular disorders or motion sensitivity may find the animations disorienting.
- **Severity**: **Low**
- **Suggested approach**: Add `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }`.

---

## Priority Summary

| Priority | Issue | Impact |
|---|---|---|
| **Critical** | No "My Status" / personal identity card | Users can't find themselves instantly |
| **High** | No rank-up progress indicator | Missing the #1 gamification driver |
| **High** | No rank change deltas (↑↓) | No urgency or celebration on movement |
| **High** | Team battle hidden behind tab | Team competition invisible by default |
| **High** | No staleness warning per user | Stale data reduces trust |
| **High** | No ROI / "money's worth" framing | Missing the core motivation narrative |
| **High** | Multiplier format is confusing | Users can't interpret their score intuitively |
| **Medium** | No streaks | Missing proven engagement mechanic |
| **Medium** | No "falling behind" nudges | Passive leaderboard, no active motivation |
| **Medium** | Confetti only on user creation | Biggest moments go uncelebrated |
| **Medium** | Pro/Free users silently invisible | Confusing for those users |
| **Medium** | "Last updated" shows client time | False freshness signal |
| **Medium** | Mobile strips critical data | Casual checks lose motivational context |
| **Medium** | Billing cycle countdown not on main view | Urgency hidden in detail panel |
