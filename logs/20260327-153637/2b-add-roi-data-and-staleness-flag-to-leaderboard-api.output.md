

Let me read the relevant section of `src/worker.js`.
I can see the return object at lines 966-985. `budget` (lines 864-870) is the plan cost. Let me add both changes.
Wait - I need to fix a scoping issue. In an object literal, you can't reference `lastUpdated` as it's being defined. Let me extract it as a local variable.
I need to add a local variable before the return statement.
Now let me run the acceptance checks and tests.
All 61 tests pass. Now let me commit.
Done. Added 4 new fields to the leaderboard user object in `getLeaderboardData`:

- **`isStale`** — `true` if last update was >24h ago
- **`isInactive`** — `true` if last update was >72h ago
- **`valueExtracted`** — dollar value extracted based on weekly usage % and plan cost
- **`planCost`** — the user's total plan cost (same as `budget`)
- **`roi`** — usage multiplier (e.g., 0.60 = 60% utilization)

All 61 tests pass. Only `src/worker.js` was modified, only within `getLeaderboardData`.
