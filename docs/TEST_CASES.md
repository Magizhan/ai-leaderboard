# Test Cases — Claude Usage Leaderboard

Prod URL: https://leaderboard.magizhan.work

## API & Data Sync

1. **Old extension (v1.2) syncs without error**
   ```bash
   curl -X POST https://leaderboard.magizhan.work/api/usage \
     -H 'Content-Type: application/json' \
     -d '{"name":"Mags","team":"NY","sessionPct":20,"weeklyPct":45,"source":"extension"}'
   ```
   Expected: `{"ok":true, ...}` — no "Invalid time value" error

2. **New extension (v1.3) syncs with reset times**
   ```bash
   curl -X POST https://leaderboard.magizhan.work/api/usage \
     -H 'Content-Type: application/json' \
     -d '{"name":"Mags","team":"NY","sessionPct":20,"weeklyPct":45,"source":"extension","sessionResetsAt":"2026-03-15T14:00:00.000Z","weeklyResetsAt":"2026-03-20T00:00:00.000Z"}'
   ```
   Expected: `sessionResetSource: "extension"`, reset times in response

3. **Manual usage log via dashboard** — Click "Log Usage", select a user, enter values. Verify values update in the leaderboard.

4. **Auto-create user on sync** — Sync with an unknown name:
   ```bash
   curl -X POST https://leaderboard.magizhan.work/api/usage \
     -H 'Content-Type: application/json' \
     -d '{"name":"NewTestUser","team":"NY","sessionPct":10,"weeklyPct":20,"source":"manual"}'
   ```
   Expected: User created automatically, appears in leaderboard. Clean up after test.

5. **Data matches claude.ai** — Open claude.ai/settings/usage, note session % and weekly %. Sync via extension. Verify dashboard shows same values (in decimal: 45% → 0.45).

6. **Auto-refresh** — After syncing, wait up to 30s. Dashboard should update without manual refresh (progress bar at top).

## Monotonic Enforcement

7. **Same session slot — lower value rejected**
   ```bash
   # First set high
   curl -X POST .../api/usage -d '{"name":"Mags","sessionPct":80,"weeklyPct":90,"source":"manual"}'
   # Then try lower
   curl -X POST .../api/usage -d '{"name":"Mags","sessionPct":30,"weeklyPct":40,"source":"manual"}'
   ```
   Expected: sessionPct stays 80, weeklyPct stays 90

8. **New session slot — lower value accepted** — After a 5-hour window boundary, submitting a lower sessionPct should be accepted (simulates session reset). Verify via the estimation logic: the response should show `sessionResetSource: "estimated"`.

## Countdown Timers

9. **All users show countdown pills** — Open dashboard. Every user in the session leaderboard should have a cyan countdown pill. Every user in the weekly leaderboard should have a green countdown pill.

10. **Countdowns tick every second** — Watch a countdown for 5+ seconds. The seconds should decrease without page refresh.

11. **Expired countdowns roll forward** — If a session countdown reaches 0, it should immediately show the next 5-hour window (not "0" or negative).

12. **Estimated indicator (i)** — Users synced via old extension should show a gold `i` icon next to their countdown. Hover should show tooltip: "Estimated from usage drop. Update extension for accurate data."

13. **Extension-provided countdown** — Users synced with v1.3 extension should show countdown WITHOUT the `i` icon.

14. **Detail panel countdown** — Click a user row. The slide-out panel should show two countdown cards at the top (Session Resets In / Weekly Resets In) with live ticking.

## Layout & Design

15. **Side-by-side leaderboards (desktop)** — On screens >768px, session and weekly leaderboards should be side by side in two equal columns.

16. **Stacked on mobile** — On screens <768px, leaderboards should stack vertically.

17. **Compact rows** — Each row shows: rank (#), name + team badge + rank badge + countdown pill, sparkline, decimal percentage.

18. **All 5 teams visible** — Team battle section shows NY, NC, Xyne, HS, JP with distinct colors. JP has rose/red color.

19. **Team mini bar** — Top mini team overview shows all 5 teams with their average percentages.

## Detail Panel

20. **Opens on row click** — Click any user row. Slide-out panel appears from right with user's name, team badge, rank badge.

21. **Charts render** — Session history line chart and weekly history line chart should render (or show "No data yet" if no history).

22. **Hover tooltips on charts** — Hover over chart data points. A tooltip should appear showing the slot/week and exact values in decimal format.

23. **Session history table** — Below the session chart, a table should show recent entries: Time, Session Slot, Session (decimal), Weekly cumul. (decimal), Source.

24. **Weekly history table** — Below the weekly chart, a table should show: Week, Avg Session, Peak Session, Avg Weekly, Peak Weekly, Points — all in decimal.

25. **Team detail panel** — Click a team name in the team battle section. Panel should show team stats, team history chart, and member list.

## Teams

26. **JP tab works** — Click the "JP" tab in the filter row. Only JP team members (sheetal) should show.

27. **sheetal shows as JP** — Not "juspay". Team badge should be rose/red colored "JP".

28. **Add User includes JP** — Click "+ Add User". Team dropdown should include "Juspay (JP)".

29. **Console paste includes JP** — In the setup section, the console paste code should prompt for team including JP.

## Import/Export

30. **Export** — Click Export. Downloaded JSON should contain: `users`, `usageLogs`, `historyLogs`, `weeklyLogs`, `userConfigs`.

31. **Import merges** — Import a JSON file. Existing users should not be removed, only added/updated.

32. **Old history migration** — If history entries have old format (`{s, w, t}`), they should be displayed correctly as `{sessionPct, weeklyPct, timestamp}`.

## Edge Cases

33. **0% usage** — User with 0% session and 0% weekly should display as "0.00" with BRONZE rank, no errors.

34. **100%+ usage** — User at 100% should show LEGENDARY rank with fire icon and confetti.

35. **Empty team** — Teams with 0 members (e.g., NC) should show "0 members" and "0.00" average, no errors.

36. **Rapid syncs** — Sync the same user 3 times in quick succession. Should not create duplicate history entries (same session slot = update in place).

37. **Delete user** — Remove a user. All their data (usage, history, weekly, config) should be cleaned up. They should disappear from the leaderboard.

38. **Decimal display** — All percentages should show as decimals (0.xx), never as xx%. Check: leaderboard rows, detail panel stats, chart axes, chart tooltips, history tables.

## Extension Specific

39. **Auto-sync schedule** — Enable auto-sync at 5min interval. Extension should open usage page in background and sync without user action.

40. **Team selection persists** — Change team in extension popup. Close and reopen popup. Team should be remembered.

41. **Content script on usage page** — Navigate to claude.ai/settings/usage. Extension should auto-sync within 10 seconds (check badge shows checkmark briefly).

42. **Extension works on non-usage page** — Open extension popup on a non-usage page. Should show "Open claude.ai/settings/usage to sync" with a button to navigate there.
