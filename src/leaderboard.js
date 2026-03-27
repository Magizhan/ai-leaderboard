import { kvGet, kvPut, jsonResponse, CACHE_TTL_MS } from './helpers.js';

// ============================================================
// Leaderboard data (with sparklines)
// ============================================================

export async function getLeaderboardData(env) {
  // Check KV cache first
  const cached = await kvGet(env, '_cache:leaderboard', null);
  if (cached && cached._cachedAt && (Date.now() - cached._cachedAt) < CACHE_TTL_MS) {
    return jsonResponse(cached.data);
  }

  const users = await kvGet(env, 'users', []);
  const planCost = parseInt(env.PLAN_COST || '200');

  const nowMs = Date.now();

  const board = await Promise.all(users.map(async (u) => {
    const [usage, history, weeklyHistory] = await Promise.all([
      kvGet(env, `usage:${u.id}`, null),
      kvGet(env, `history:${u.id}`, []),
      kvGet(env, `weekly:${u.id}`, []),
    ]);
    // Plan-specific cost: max20=$200, max5=$100, unknown defaults to $200
    const planTypeCost = (pt) => pt === 'max5' ? 100 : 200;

    // Build sparkline from last 20 session history entries
    const sparklineEntries = history.slice(-20);
    const sessionSparkline = sparklineEntries.map(e => e.sessionPct || 0);
    const weeklySparkline = sparklineEntries.map(e => e.weeklyPct || 0);

    // Determine planType from active plan or top-level (needed before session/monthly calcs)
    let activePlanType = null;
    if (usage && usage.plans && usage.plans.length > 0) {
      const ap = usage.plans[usage.activePlan || 0];
      activePlanType = ap ? (ap.planType || null) : null;
    } else if (usage) {
      activePlanType = usage.planType || null;
    }

    // Plan-type multiplier: max5 = 0.25x per 100%, max20/null = 1.0x per 100%
    // Budget: for multi-plan, sum per-plan costs; otherwise use activePlanType
    let budget = 0;
    if (usage && usage.plans && usage.plans.length > 0) {
      budget = usage.plans.reduce((s, p) => s + planTypeCost(p.planType), 0);
    } else {
      budget = u.numPlans * planTypeCost(activePlanType);
    }

    // Read combined values (new format) or fall back to flat fields (unmigrated)
    let rawSessionPct = usage
      ? (usage.combinedSessionPct !== undefined ? usage.combinedSessionPct : (usage.sessionPct || 0))
      : 0;

    // Auto-reset: if session timer expired, show 0 for combined session
    if (usage && usage.sessionResetsAt && new Date(usage.sessionResetsAt).getTime() <= nowMs) {
      rawSessionPct = 0;
    }

    // Session display = raw combined value (frontend handles planNormFactor)
    let displaySessionPct = rawSessionPct;

    // Monthly display = sum of weekly peaks from history / 4
    // Algorithm:
    //   1. Scan history for weekly resets (weeklyPct drops >70% from previous)
    //   2. Capture peak weeklyPct before each reset
    //   3. Current week's value = latest history entry (or live combinedWeeklyPct)
    //   4. Monthly = sum(peaks + current) / 4
    //   5. Extra usage added on top: (extraSpent / (planCost * 4)) * 100
    let displayWeeklyPct = 0;

    const cutoffMs = nowMs - 28 * 86400000;

    // Max capacity per week: 100% per plan (e.g., 2 plans = 200% combined max)
    const maxWeeklyCapacity = u.numPlans * 100;

    // Track completed week peaks and current week for lost/opportunity calc
    const completedWeekPeaks = [];
    let currentWeekValue = 0;

    if (history.length >= 2) {
      const recent = history.filter(h => new Date(h.timestamp).getTime() >= cutoffMs);

      if (recent.length >= 2) {
        let runningPeak = recent[0].weeklyPct || 0;
        for (let i = 1; i < recent.length; i++) {
          const curW = recent[i].weeklyPct || 0;
          if (runningPeak > 20 && curW < runningPeak * 0.3) {
            completedWeekPeaks.push(runningPeak);
            runningPeak = curW;
          } else {
            runningPeak = Math.max(runningPeak, curW);
          }
        }
        const liveWeekly = usage
          ? (usage.combinedWeeklyPct !== undefined ? usage.combinedWeeklyPct : (usage.weeklyPct || 0))
          : 0;
        const weeklyExpired = usage && usage.weeklyResetsAt && new Date(usage.weeklyResetsAt).getTime() <= nowMs;
        currentWeekValue = weeklyExpired ? 0 : Math.max(runningPeak, liveWeekly);

        const totalRaw = completedWeekPeaks.reduce((s, v) => s + v, 0) + currentWeekValue;
        displayWeeklyPct = totalRaw / 4;
      } else if (recent.length === 1) {
        const liveWeekly = usage
          ? (usage.combinedWeeklyPct !== undefined ? usage.combinedWeeklyPct : (usage.weeklyPct || 0))
          : 0;
        const weeklyExpired = usage && usage.weeklyResetsAt && new Date(usage.weeklyResetsAt).getTime() <= nowMs;
        currentWeekValue = weeklyExpired ? 0 : Math.max(recent[0].weeklyPct || 0, liveWeekly);
        displayWeeklyPct = currentWeekValue / 4;
      }
    } else {
      const liveWeekly = usage
        ? (usage.combinedWeeklyPct !== undefined ? usage.combinedWeeklyPct : (usage.weeklyPct || usage.pct || 0))
        : 0;
      const weeklyExpired = usage && usage.weeklyResetsAt && new Date(usage.weeklyResetsAt).getTime() <= nowMs;
      currentWeekValue = weeklyExpired ? 0 : liveWeekly;
      displayWeeklyPct = currentWeekValue / 4;
    }

    // Lost = capacity from completed weeks that can never be recovered
    // e.g., week peaked at 94% of 100% capacity → lost 6% that week
    const completedWeeks = completedWeekPeaks.length;
    // Each week is worth budget/4 of the monthly subscription
    // Lost per week = (1 - peak/maxCapacity) × weeklyBudget
    // Arjun: 1 plan, peaked 24/100 → lost 76% of week → 0.76 × ($200/4) = $38
    // Mags: 2 plans, peaked 166/200 → lost 17% of week → 0.17 × ($400/4) = $17
    const weeklyBudget = budget / 4;
    const lostPct = completedWeekPeaks.reduce((s, peak) => {
      const weekLostDollars = (1 - Math.min(peak, maxWeeklyCapacity) / maxWeeklyCapacity) * weeklyBudget;
      return s + (budget > 0 ? (weekLostDollars / budget) * 100 : 0);
    }, 0);
    // Achievable = budget - utilized - lost (what's still possible this month)
    // Computed after displayWeeklyPct is finalized (below), so set placeholder
    let opportunityPct = 0; // will be set after extra usage is added

    // Base monthly (without extra usage) — for financial display
    const baseWeeklyPct = displayWeeklyPct;

    // Extra usage adds to multiplier (for ranking) but NOT to overall budget math
    if (usage && (usage.totalExtraUsageSpent || usage.extraUsageSpent)) {
      const extraSpent = usage.totalExtraUsageSpent || usage.extraUsageSpent || 0;
      displayWeeklyPct += (extraSpent / (planTypeCost(activePlanType) * 4)) * 100;
    }

    // Achievable = budget - utilized - lost (simple, bounded by budget)
    const utilizedDollars = Math.round((baseWeeklyPct / 100) * budget);
    const lostDollars = Math.round((lostPct / 100) * budget);
    opportunityPct = budget > 0 ? (Math.max(0, budget - utilizedDollars - lostDollars) / budget) * 100 : 0;

    return {
      ...u,
      budget,
      sessionPct: displaySessionPct,
      weeklyPct: displayWeeklyPct,
      baseWeeklyPct: baseWeeklyPct,
      currentWeeklyPct: usage
        ? (usage.combinedWeeklyPct !== undefined ? usage.combinedWeeklyPct : (usage.weeklyPct || 0))
        : 0,
      lastUpdated: usage ? usage.timestamp : null,
      source: usage ? usage.source : null,
      sessionSparkline,
      weeklySparkline,
      sessionResetsAt: usage ? (usage.sessionResetsAt || null) : null,
      weeklyResetsAt: usage ? (usage.weeklyResetsAt || null) : null,
      sessionResetSource: usage ? (usage.sessionResetSource || null) : null,
      weeklyResetSource: usage ? (usage.weeklyResetSource || null) : null,
      extraUsageSpent: usage ? (usage.totalExtraUsageSpent || usage.extraUsageSpent || null) : null,
      extraUsageLimit: usage ? (usage.extraUsageLimit || null) : null,
      extraUsagePct: usage ? (usage.extraUsagePct || null) : null,
      planType: activePlanType,
      extensionVersion: usage ? (usage.extensionVersion || null) : null,
      plans: usage ? (usage.plans || null) : null,
      streak: usage ? (usage.streak || { count: 0 }).count : 0,
      isStale: usage && usage.timestamp && (nowMs - new Date(usage.timestamp).getTime()) > 24 * 3600000,
      isInactive: usage && usage.timestamp && (nowMs - new Date(usage.timestamp).getTime()) > 72 * 3600000,
      // Financial: how much of the monthly budget has been utilized
      amountSpent: budget,
      amountUtilized: Math.round((displayWeeklyPct / 100) * budget),
      amountRemaining: Math.max(0, budget - Math.round((displayWeeklyPct / 100) * budget)),
      roi: displayWeeklyPct > 0 ? Math.round((displayWeeklyPct / 100) * 100) / 100 : 0,
      // Lost & opportunity
      lostPct: Math.round(lostPct * 10) / 10,
      opportunityPct: Math.round(opportunityPct * 10) / 10,
      completedWeeks,
      currentWeekPct: currentWeekValue,
      maxWeeklyCapacity,
      // Time left: hours until weekly reset (creates urgency)
      weeklyResetHoursLeft: usage && usage.weeklyResetsAt
        ? Math.max(0, Math.round((new Date(usage.weeklyResetsAt).getTime() - nowMs) / 3600000))
        : null,
    };
  }));

  function teamStats(teamUsers) {
    const active = teamUsers.filter(u => !u.isInactive);
    const avgDiv = active.length || 1;
    return {
      members: teamUsers.length,
      activeMembers: active.length,
      avgSessionPct: active.reduce((s, u) => s + u.sessionPct, 0) / avgDiv,
      avgWeeklyPct: active.reduce((s, u) => s + u.weeklyPct, 0) / avgDiv,
    };
  }

  const result = {
    users: board,
    stats: {
      totalUsers: board.length,
      totalBudget: board.reduce((s, u) => s + u.budget, 0),
      avgSessionPct: board.length > 0 ? board.reduce((s, u) => s + u.sessionPct, 0) / board.length : 0,
      avgWeeklyPct: board.length > 0 ? board.reduce((s, u) => s + u.weeklyPct, 0) / board.length : 0,
    },
    teams: {
      NY: teamStats(board.filter(u => u.team === 'NY')),
      NC: teamStats(board.filter(u => u.team === 'NC')),
      Xyne: teamStats(board.filter(u => u.team === 'Xyne')),
      HS: teamStats(board.filter(u => u.team === 'HS')),
      JP: teamStats(board.filter(u => u.team === 'JP')),
    },
    updatedAt: new Date().toISOString(),
  };

  // Cache in KV (fire-and-forget)
  kvPut(env, '_cache:leaderboard', { data: result, _cachedAt: Date.now() });

  return jsonResponse(result);
}

// ============================================================
// History & Weekly endpoints
// ============================================================

export async function getUserHistory(userId, limit, env) {
  const history = await kvGet(env, `history:${userId}`, []);
  return jsonResponse(history.slice(-limit));
}

export async function getUserWeekly(userId, limit, env) {
  const weekly = await kvGet(env, `weekly:${userId}`, []);
  return jsonResponse(weekly.slice(-limit));
}

export async function getTeamHistory(teamName, limit, env) {
  const users = await kvGet(env, 'users', []);
  const teamUsers = users.filter(u => u.team === teamName);
  if (teamUsers.length === 0) return jsonResponse([]);

  // Fetch all team members' histories
  const histories = await Promise.all(
    teamUsers.map(u => kvGet(env, `history:${u.id}`, []))
  );

  // Aggregate by session slot: average across members
  const slotMap = {};
  for (const hist of histories) {
    for (const entry of hist) {
      if (!slotMap[entry.sessionSlot]) {
        slotMap[entry.sessionSlot] = { sessionPcts: [], weeklyPcts: [], timestamp: entry.timestamp };
      }
      slotMap[entry.sessionSlot].sessionPcts.push(entry.sessionPct || 0);
      slotMap[entry.sessionSlot].weeklyPcts.push(entry.weeklyPct || 0);
      // Keep the latest timestamp
      if (entry.timestamp > slotMap[entry.sessionSlot].timestamp) {
        slotMap[entry.sessionSlot].timestamp = entry.timestamp;
      }
    }
  }

  const aggregated = Object.entries(slotMap)
    .map(([slot, data]) => ({
      sessionSlot: slot,
      sessionPct: Math.round(data.sessionPcts.reduce((a, b) => a + b, 0) / data.sessionPcts.length * 100) / 100,
      weeklyPct: Math.round(data.weeklyPcts.reduce((a, b) => a + b, 0) / data.weeklyPcts.length * 100) / 100,
      memberCount: data.sessionPcts.length,
      timestamp: data.timestamp,
    }))
    .sort((a, b) => a.sessionSlot.localeCompare(b.sessionSlot))
    .slice(-limit);

  return jsonResponse(aggregated);
}

export async function getTeamWeekly(teamName, limit, env) {
  const users = await kvGet(env, 'users', []);
  const teamUsers = users.filter(u => u.team === teamName);
  if (teamUsers.length === 0) return jsonResponse([]);

  const weeklies = await Promise.all(
    teamUsers.map(u => kvGet(env, `weekly:${u.id}`, []))
  );

  // Aggregate by weekKey
  const weekMap = {};
  for (const weekly of weeklies) {
    for (const entry of weekly) {
      if (!weekMap[entry.weekKey]) {
        weekMap[entry.weekKey] = { peakSessions: [], avgSessions: [], peakWeeklies: [], avgWeeklies: [], lastUpdated: entry.lastUpdated };
      }
      weekMap[entry.weekKey].peakSessions.push(entry.peakSessionPct);
      weekMap[entry.weekKey].avgSessions.push(entry.avgSessionPct);
      weekMap[entry.weekKey].peakWeeklies.push(entry.peakWeeklyPct);
      weekMap[entry.weekKey].avgWeeklies.push(entry.avgWeeklyPct);
      if (entry.lastUpdated > weekMap[entry.weekKey].lastUpdated) {
        weekMap[entry.weekKey].lastUpdated = entry.lastUpdated;
      }
    }
  }

  const aggregated = Object.entries(weekMap)
    .map(([weekKey, data]) => ({
      weekKey,
      peakSessionPct: Math.round(Math.max(...data.peakSessions) * 100) / 100,
      avgSessionPct: Math.round(data.avgSessions.reduce((a, b) => a + b, 0) / data.avgSessions.length * 100) / 100,
      peakWeeklyPct: Math.round(Math.max(...data.peakWeeklies) * 100) / 100,
      avgWeeklyPct: Math.round(data.avgWeeklies.reduce((a, b) => a + b, 0) / data.avgWeeklies.length * 100) / 100,
      memberCount: data.avgSessions.length,
      lastUpdated: data.lastUpdated,
    }))
    .sort((a, b) => a.weekKey.localeCompare(b.weekKey))
    .slice(-limit);

  return jsonResponse(aggregated);
}
