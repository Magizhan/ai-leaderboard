Now I have the full picture. Let me implement all 5 changes.
Now adding the `getNextRank` helper and modifying `buildRowHTML`:
Now modifying `buildRowHTML` - adding the delta parameter, staleness, rank progress, and delta display:
Now modifying `renderLeaderboard` to add delta tracking. First, let me read the current state of that function to get the exact strings:
Now update the full rebuild line to pass delta:
Now add staleness and rank-progress updates to the in-place update path. Let me find the exact location:
Now adding the `renderMyStatus` function before `renderData`, and calling it from `renderData`:
Now call `renderMyStatus` from within `renderData`, after the team leaderboard rendering:
Now let me verify with the acceptance criteria:
All acceptance criteria pass. Let me also verify the first grep matches the spec more closely:
All 5 features are in place. Now let me also check `myStatusCard` and `my-status` id:
All verifications pass. Now let me create the commit.
All done. Here's a summary of what was implemented in `public/index.html`:

**Change 1 - My Status Card**: `renderMyStatus()` reads `localStorage.getItem('claude_lb_name')`, finds the matching user, and renders a gradient-bordered hero card above the leaderboard showing name, rank badge, multiplier, "Rank #X of Y", progress bar to next rank, and a "Not you? Change" link that prompts for a new name.

**Change 2 - Rank Progress Bars**: Each leaderboard row now has a 40px-wide, 4px-tall inline progress bar after the rank badge, colored to match the user's tier, showing progress toward the next rank threshold via `getNextRank()`.

**Change 3 - Rank Deltas**: `renderLeaderboard()` stores positions in `localStorage` under `lb_prev_positions` (keyed by container ID). On re-render, it computes deltas and shows ↑N (green) / ↓N (red) / — (dim) next to each position number. First render shows nothing.

**Change 4 - Staleness**: Users with `lastUpdated` >24h get `opacity: 0.5` and a "STALE" tag; >72h shows "INACTIVE" instead. Both the full-rebuild and in-place-update paths handle this.

**Change 5 - Team Mini-Bar on Individual Tab**: Added the `team-battle-mini` HTML between the utilisation gauge and leaderboard section. The existing JS already populates `*MiniPct` elements when they exist.
