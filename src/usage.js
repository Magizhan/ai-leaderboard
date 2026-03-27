import { kvGet, kvPut, invalidateLeaderboardCache, jsonResponse, sanitizeString, sanitizeTeam, sanitizeSource, getSessionSlot, getWeekKey, MAX_HISTORY, MAX_WEEKLY } from './helpers.js';

// ============================================================
// Log Usage (with history recording & monotonic increase)
// ============================================================

export async function logUsage(body, env) {
  const { userId, sessionPct, weeklyPct, pct, sessionResetsAt, weeklyResetsAt, extraUsageSpent, extraUsageLimit, extraUsagePct, planType, extensionVersion } = body;
  const name = body.name ? sanitizeString(body.name) : undefined;
  const source = sanitizeSource(body.source);

  const users = await kvGet(env, 'users', []);
  let user;
  if (userId) user = users.find(u => u.id === userId);
  else if (name) user = users.find(u => u.name.toLowerCase() === name.toLowerCase());

  // Auto-create user if not found (from extension/bookmarklet sync)
  if (!user && name) {
    const team = sanitizeTeam(body.team);
    const id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    user = { id, name, team, numPlans: 1 };
    users.push(user);
    await kvPut(env, 'users', users);
  }
  if (!user) return jsonResponse({ error: 'User not found. Provide a name to auto-register.' }, 404);

  // Only update team from non-extension sources (extension defaults to NY which overwrites real team)
  if (body.team && source !== 'extension') {
    const newTeam = sanitizeTeam(body.team);
    if (newTeam !== user.team) {
      user.team = newTeam;
      await kvPut(env, 'users', users);
    }
  }

  // Get existing usage record
  const existing = await kvGet(env, `usage:${user.id}`, {});
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const numPlans = user.numPlans || 1;

  // --- Migrate old flat format to per-plan format ---
  let plans = existing.plans ? existing.plans.map(p => ({ ...p })) : null;
  let activePlan = existing.activePlan || 0;

  if (!plans) {
    // Migration: create plans array from flat fields
    // Strip weeklyBaseline and cap at 100 (old hack inflated values)
    const rawWeekly = (existing.weeklyPct || 0) - (existing.weeklyBaseline || 0);
    const migrated = {
      sessionPct: Math.min(existing.sessionPct || 0, 100),
      weeklyPct: Math.max(0, Math.min(rawWeekly, 100)),
      sessionResetsAt: existing.sessionResetsAt || null,
      weeklyResetsAt: existing.weeklyResetsAt || null,
      planType: existing.planType || null,
      extraUsageSpent: existing.extraUsageSpent || null,
      extraUsageLimit: existing.extraUsageLimit || null,
      extraUsagePct: existing.extraUsagePct || null,
      lastSyncAt: existing.timestamp || null,
    };
    plans = [migrated];
    // Pad to numPlans
    while (plans.length < numPlans) {
      plans.push({
        sessionPct: 0, weeklyPct: 0,
        sessionResetsAt: null, weeklyResetsAt: null,
        planType: null, extraUsageSpent: null, extraUsageLimit: null, extraUsagePct: null,
        lastSyncAt: null,
      });
    }
    activePlan = 0;
  }

  // Ensure plans array matches numPlans (pad if user added plans)
  while (plans.length < numPlans) {
    plans.push({
      sessionPct: 0, weeklyPct: 0,
      sessionResetsAt: null, weeklyResetsAt: null,
      planType: null, extraUsageSpent: null, extraUsageLimit: null, extraUsagePct: null,
      lastSyncAt: null,
    });
  }

  // --- Parse incoming values ---
  let incomingSession = sessionPct !== undefined ? parseFloat(sessionPct) : undefined;
  let incomingWeekly = weeklyPct !== undefined ? parseFloat(weeklyPct) : (pct !== undefined ? parseFloat(pct) : undefined);

  // Backwards compat: if only `pct` was sent (old bookmarklet), treat as weeklyPct
  if (pct !== undefined && weeklyPct === undefined && sessionPct === undefined) {
    incomingWeekly = parseFloat(pct);
  }

  // Clamp individual plan values to 0-100
  if (incomingSession !== undefined) incomingSession = Math.max(0, Math.min(100, isNaN(incomingSession) ? 0 : incomingSession));
  if (incomingWeekly !== undefined) incomingWeekly = Math.max(0, Math.min(100, isNaN(incomingWeekly) ? 0 : incomingWeekly));

  // --- Determine if timers expired (check active plan's timers) ---
  const activePlanData = plans[activePlan] || plans[0];
  const sessionExpired = activePlanData.sessionResetsAt && new Date(activePlanData.sessionResetsAt).getTime() <= nowMs;
  const weeklyExpired = activePlanData.weeklyResetsAt && new Date(activePlanData.weeklyResetsAt).getTime() <= nowMs;

  // --- Weekly reset: zero ALL plan slots ---
  if (weeklyExpired) {
    for (const p of plans) {
      p.weeklyPct = 0;
    }
  }

  // --- Plan switch detection (numPlans > 1) ---
  if (numPlans > 1 && incomingWeekly !== undefined) {
    const prevWeekly = activePlanData.weeklyPct || 0;
    const prevExtra = activePlanData.extraUsageSpent || 0;
    const prevWeeklyReset = activePlanData.weeklyResetsAt || '';
    const inExtra = extraUsageSpent !== undefined ? parseFloat(extraUsageSpent) : prevExtra;
    const inWeeklyReset = weeklyResetsAt || prevWeeklyReset;

    // Signals that this is a different plan:
    // 1. Weekly dropped significantly (but timer not expired)
    const weeklyDropped = incomingWeekly < prevWeekly - 5 && !weeklyExpired;
    // 2. Extra usage changed significantly (different $ amount)
    const extraChanged = Math.abs(inExtra - prevExtra) > 20;
    // 3. Weekly reset timer is different (different plans have different schedules)
    const resetDiffers = inWeeklyReset && prevWeeklyReset &&
      inWeeklyReset !== prevWeeklyReset &&
      Math.abs(new Date(inWeeklyReset).getTime() - new Date(prevWeeklyReset).getTime()) > 3600000;
    // 4. Session fresh (0%) while weekly jumped up (switched to a more-used plan)
    const sessionFreshWeeklyJumped = incomingSession <= 1 && incomingWeekly > prevWeekly + 20;

    const isPlanSwitch = weeklyDropped || (extraChanged && resetDiffers) || sessionFreshWeeklyJumped;

    if (isPlanSwitch) {
      // Find best matching plan slot
      let bestIdx = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < plans.length; i++) {
        if (i === activePlan) continue;
        const diff = Math.abs(plans[i].weeklyPct - incomingWeekly);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      }
      // If no close match (diff > 20), use LRU (oldest lastSyncAt)
      if (bestIdx === -1 || bestDiff > 20) {
        let lruIdx = -1, lruTime = Infinity;
        for (let i = 0; i < plans.length; i++) {
          if (i === activePlan) continue;
          const t = plans[i].lastSyncAt ? new Date(plans[i].lastSyncAt).getTime() : 0;
          if (t < lruTime) { lruTime = t; lruIdx = i; }
        }
        if (lruIdx >= 0) bestIdx = lruIdx;
      }
      if (bestIdx >= 0) activePlan = bestIdx;
    }
  }

  // Get the plan slot we're updating
  const plan = plans[activePlan] || plans[0];

  // --- Monotonic increase within same session (using history) ---
  let history = await kvGet(env, `history:${user.id}`, []);
  const currentSlot = getSessionSlot(now);

  // Lazy migration: seed history with existing usage if empty
  if (history.length === 0 && existing.timestamp) {
    history.push({
      sessionPct: existing.sessionPct || existing.combinedSessionPct || 0,
      weeklyPct: existing.weeklyPct || existing.combinedWeeklyPct || 0,
      timestamp: existing.timestamp,
      sessionSlot: getSessionSlot(existing.timestamp),
      source: existing.source || 'manual',
    });
  }

  const lastEntry = history.length > 0 ? history[history.length - 1] : null;

  // Update active plan's values
  if (incomingSession !== undefined) {
    if (sessionExpired) {
      plan.sessionPct = incomingSession;
    } else if (lastEntry && lastEntry.sessionSlot === currentSlot) {
      // Same session slot: enforce monotonic increase for active plan only
      plan.sessionPct = Math.max(incomingSession, plan.sessionPct || 0);
    } else {
      plan.sessionPct = incomingSession;
    }
  }

  if (incomingWeekly !== undefined) {
    if (weeklyExpired) {
      // Already zeroed above; set to incoming
      plan.weeklyPct = incomingWeekly;
    } else if (lastEntry && lastEntry.sessionSlot === currentSlot) {
      // Same session slot: enforce monotonic increase for active plan only
      plan.weeklyPct = Math.max(incomingWeekly, plan.weeklyPct || 0);
    } else {
      plan.weeklyPct = incomingWeekly;
    }
  }

  // --- Update plan metadata ---
  if (sessionResetsAt) plan.sessionResetsAt = sessionResetsAt;
  if (weeklyResetsAt) plan.weeklyResetsAt = weeklyResetsAt;
  if (planType) plan.planType = planType;
  if (extraUsageSpent !== undefined) plan.extraUsageSpent = parseFloat(extraUsageSpent);
  if (extraUsageLimit !== undefined) plan.extraUsageLimit = parseFloat(extraUsageLimit);
  if (extraUsagePct !== undefined) plan.extraUsagePct = parseFloat(extraUsagePct);
  plan.lastSyncAt = now;

  // Cap per-plan values at 100 (single plan can't exceed its own limit)
  plan.sessionPct = Math.min(plan.sessionPct || 0, 100);
  plan.weeklyPct = Math.min(plan.weeklyPct || 0, 100);

  // --- Compute combined totals ---
  // sessionPct = active plan's session (only one session active at a time)
  const combinedSessionPct = plan.sessionPct || 0;
  // weeklyPct = active plan's weekly (summing all slots picked up stale data from inactive plans)
  const combinedWeeklyPct = plan.weeklyPct || 0;
  // totalExtraUsageSpent = max across plans (extra is per-account, not per-plan —
  // same $549 gets written to whichever plan is active during sync, so take max not sum)
  const totalExtraUsageSpent = Math.max(...plans.map(p => p.extraUsageSpent || 0), 0);

  // --- Infer reset times (from active plan) ---
  let sessionResetSource = existing.sessionResetSource || null;
  let weeklyResetSource = existing.weeklyResetSource || null;

  if (sessionResetsAt) {
    sessionResetSource = 'extension';
  } else if (incomingSession !== undefined && existing.plans) {
    const prevSession = (existing.plans[existing.activePlan || 0] || {}).sessionPct || 0;
    if (incomingSession < prevSession - 1) {
      plan.sessionResetsAt = new Date(nowMs + 5 * 3600000).toISOString();
      sessionResetSource = 'estimated';
    }
  }

  if (weeklyResetsAt) {
    weeklyResetSource = 'extension';
  } else if (incomingWeekly !== undefined && existing.plans) {
    const prevWeekly = (existing.plans[existing.activePlan || 0] || {}).weeklyPct || 0;
    if (incomingWeekly < prevWeekly - 1 && weeklyExpired) {
      plan.weeklyResetsAt = new Date(nowMs + 7 * 86400000).toISOString();
      weeklyResetSource = 'estimated';
    }
  }

  // --- Update history (store active plan's raw values, not combined) ---
  let histSessionPct = plan.sessionPct || 0;
  let histWeeklyPct = plan.weeklyPct || 0;

  const sessionDroppedHist = lastEntry && histSessionPct < (lastEntry.sessionPct || 0) - 1;
  const weeklyDroppedHist = lastEntry && histWeeklyPct < (lastEntry.weeklyPct || 0) - 1;
  const sessionResetHist = sessionDroppedHist && sessionExpired;
  const weeklyResetHist = weeklyDroppedHist && weeklyExpired;

  if (lastEntry && !sessionResetHist && !weeklyResetHist && lastEntry.sessionSlot === currentSlot) {
    // Use current combined values — don't max with history (old inflated values from
    // multi-plan summing bug would get stuck forever via Math.max)
    histSessionPct = combinedSessionPct;
    histWeeklyPct = combinedWeeklyPct;
    lastEntry.sessionPct = histSessionPct;
    lastEntry.weeklyPct = histWeeklyPct;
    lastEntry.timestamp = now;
    lastEntry.source = source;
  } else {
    if (sessionResetHist && !weeklyResetHist && lastEntry) {
      histWeeklyPct = combinedWeeklyPct;
    }
    history.push({
      sessionPct: histSessionPct,
      weeklyPct: histWeeklyPct,
      timestamp: now,
      sessionSlot: currentSlot,
      source,
    });
  }

  if (history.length > MAX_HISTORY) {
    history = history.slice(history.length - MAX_HISTORY);
  }

  // --- Build usage data ---
  const usageData = {
    userId: user.id,
    activePlan,
    plans,
    combinedSessionPct,
    combinedWeeklyPct,
    totalExtraUsageSpent,
    // Top-level backward compat fields
    sessionPct: combinedSessionPct,
    weeklyPct: combinedWeeklyPct,
    timestamp: now,
    source,
    sessionResetsAt: plan.sessionResetsAt || null,
    weeklyResetsAt: plan.weeklyResetsAt || null,
    sessionResetSource,
    weeklyResetSource,
    planType: plan.planType || existing.planType || null,
    extraUsageSpent: plan.extraUsageSpent || null,
    extraUsageLimit: plan.extraUsageLimit || null,
    extraUsagePct: plan.extraUsagePct || null,
    extensionVersion: extensionVersion || existing.extensionVersion || null,
  };

  // Update weekly aggregation
  const userConfig = await kvGet(env, `userconfig:${user.id}`, { weekStartDay: 'monday' });
  const currentWeekKey = getWeekKey(now, userConfig.weekStartDay);
  let weeklyHistory = await kvGet(env, `weekly:${user.id}`, []);
  weeklyHistory = updateWeeklyAggregation(weeklyHistory, history, currentWeekKey, userConfig.weekStartDay, now);

  // Write all data
  await Promise.all([
    kvPut(env, `usage:${user.id}`, usageData),
    kvPut(env, `history:${user.id}`, history),
    kvPut(env, `weekly:${user.id}`, weeklyHistory),
  ]);
  invalidateLeaderboardCache(env);

  return jsonResponse({ ok: true, user: user.name, ...usageData });
}

/** Recompute weekly aggregation for the current week from session history */
function updateWeeklyAggregation(weeklyHistory, sessionHistory, currentWeekKey, weekStartDay, now) {
  // Find entries in session history that belong to the current week
  const weekEntries = sessionHistory.filter(e => {
    return getWeekKey(e.timestamp, weekStartDay) === currentWeekKey;
  });

  if (weekEntries.length === 0) return weeklyHistory;

  const peakSessionPct = Math.max(...weekEntries.map(e => e.sessionPct || 0));
  const avgSessionPct = weekEntries.reduce((s, e) => s + (e.sessionPct || 0), 0) / weekEntries.length;
  const peakWeeklyPct = Math.max(...weekEntries.map(e => e.weeklyPct || 0));
  const avgWeeklyPct = weekEntries.reduce((s, e) => s + (e.weeklyPct || 0), 0) / weekEntries.length;

  // Determine planType from latest history entry for this week
  const latestHistoryEntry = weekEntries[weekEntries.length - 1];
  const weekPlanType = latestHistoryEntry ? (latestHistoryEntry.planType || null) : null;

  const weekRecord = {
    weekKey: currentWeekKey,
    peakSessionPct: Math.round(peakSessionPct * 100) / 100,
    avgSessionPct: Math.round(avgSessionPct * 100) / 100,
    peakWeeklyPct: Math.round(peakWeeklyPct * 100) / 100,
    avgWeeklyPct: Math.round(avgWeeklyPct * 100) / 100,
    dataPoints: weekEntries.length,
    lastUpdated: now,
    planType: weekPlanType,
  };

  // Upsert into weekly history
  const existingIdx = weeklyHistory.findIndex(w => w.weekKey === currentWeekKey);
  if (existingIdx >= 0) {
    weeklyHistory[existingIdx] = weekRecord;
  } else {
    weeklyHistory.push(weekRecord);
  }

  // Sort by weekKey and trim
  weeklyHistory.sort((a, b) => a.weekKey.localeCompare(b.weekKey));
  if (weeklyHistory.length > MAX_WEEKLY) {
    weeklyHistory = weeklyHistory.slice(weeklyHistory.length - MAX_WEEKLY);
  }

  return weeklyHistory;
}
