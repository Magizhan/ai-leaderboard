# Leaderboard Fix Plan — Phased with Verification

## Why fleet tasks fail & how we prevent it

**Common failure modes:**
1. **Task too broad** → Agent wanders, reads everything, runs out of tokens before writing code
2. **No clear success criteria** → Agent doesn't know when it's done, keeps "improving"
3. **Parallel tasks touching same files** → Merge conflicts, one overwrites the other
4. **No verification** → Bad code gets committed, compounds errors in later phases

**Our guardrails:**
- Each task targets **1-2 files max** with exact line numbers
- Each task has **explicit acceptance criteria** (grep patterns, test commands)
- **No two parallel tasks edit the same file**
- Separate **verification tasks** after each phase
- **Manual checkpoint** between phases — you review diffs before proceeding

---

## Sequencing: Fix data layer BEFORE nudging more syncs

**Do fixes first, then nudges.** Here's why:

If you add sync nudges now (staleness warnings, "you haven't synced" alerts), you'll drive more concurrent syncs — which amplifies the race conditions, the fragile scraping, and the silent data loss. You'd be pouring water into a leaky bucket faster.

**Order:**
1. **Phase 1 — Data integrity** (backend race conditions, schema fixes, extension reliability)
2. **Phase 2 — UX foundations** (personal identity card, rank progress, ROI framing)
3. **Phase 3 — Nudge engine** (staleness warnings, streaks, team battle visibility, sync prompts)

Each phase has its own fleet file. Run one at a time. Review between phases.

---

## Phase 1: Data Integrity (run first)

**File: `tasks-phase1-data.md`** — 4 focused tasks, no file overlap

| Task | Files touched | Parallel-safe? |
|------|--------------|----------------|
| 1a. Fix deleteUser allowShrink + add duplicate name check | `src/worker.js` (lines 385-431 only) | Solo — owns worker.js |
| 1b. Fix history entries to store per-plan values | `src/worker.js` (lines 683-710, 758-801) | **WAIT for 1a** |
| 1c. Anchor extension scraping to section headings | `extension/content.js` (lines 26-113) | Yes — different file |
| 1d. Add sync retry queue | `extension/content.js` (lines 120-179), `extension/background.js` | **WAIT for 1c** |
| 1e. Verify Phase 1 | Read-only verification | After all fixes |

**Why sequential for worker.js:** Two agents editing `src/worker.js` simultaneously WILL conflict. Run 1a, commit, then 1b.

**Why sequential for extension:** 1d (retry queue) modifies the same sync flow that 1c (scraping anchor) changes. Avoid merge hell.

**Safe to parallelize:** 1a + 1c (worker.js vs content.js)

---

## Phase 2: UX Foundations (run after Phase 1 verified)

**File: `tasks-phase2-ux.md`** — 3 tasks

| Task | Files touched | Parallel-safe? |
|------|--------------|----------------|
| 2a. Add "My Status" personal identity card | `public/index.html` (JS section) | Solo — owns index.html |
| 2b. Add ROI/value framing to leaderboard API | `src/worker.js` (lines 958-982) | Yes — different file |
| 2c. Verify Phase 2 | Read-only | After all fixes |

---

## Phase 3: Nudge Engine (run after Phase 2 verified)

**File: `tasks-phase3-nudge.md`** — 4 tasks

| Task | Files touched | Parallel-safe? |
|------|--------------|----------------|
| 3a. Add rank-up progress bars + rank deltas | `public/index.html` (leaderboard render) | Solo — owns index.html |
| 3b. Add staleness indicators (API + UI) | `src/worker.js` (leaderboard output) | Yes — different file |
| 3c. Show team battle on Individual tab | `public/index.html` (tab section) | **WAIT for 3a** |
| 3d. Verify Phase 3 | Read-only | After all fixes |

---

## Manual Checkpoints

Between each phase:
1. Review git diff
2. Run `npm run dev` and visually check the dashboard
3. Run tests: `npm test`
4. If anything looks wrong, fix manually before proceeding

---

## What we're NOT fixing yet (and why)

| Issue | Why deferred |
|-------|-------------|
| Race conditions (Durable Objects) | Architecture change — needs design discussion, not a fleet task |
| JWT verification | Security policy decision — needs alignment on threat model |
| CORS restriction to known extension ID | Needs extension ID coordination |
| Session auto-reset write-through | Coupled with monotonic enforcement — needs careful design |
| Plan switch detection overhaul | Needs extension to send plan ID — cross-cutting change |
| Accessibility (ARIA, reduced motion) | Important but independent — separate sprint |
