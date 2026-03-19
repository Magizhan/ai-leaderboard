/**
 * End-to-end API tests for Claude Usage Leaderboard
 *
 * Run: npm test
 * Requires: local dev server running (npm run dev) OR test against production
 *
 * Usage:
 *   API_BASE=http://localhost:8787 npm test     # local dev
 *   API_BASE=https://leaderboard.magizhan.work npm test  # production (needs auth)
 */

const API_BASE = process.env.API_BASE || 'http://localhost:8787';
const TEST_USER = `_test_user_${Date.now()}`;
const TEST_TEAM = 'NY';

let testUserId = null;
let passed = 0;
let failed = 0;
const failures = [];

// ============================================================
// Helpers
// ============================================================

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

function assertEq(actual, expected, message) {
  assert(actual === expected, `${message} (expected: ${expected}, got: ${actual})`);
}

function assertApprox(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message} (expected: ~${expected}, got: ${actual})`);
}

// ============================================================
// Tests
// ============================================================

async function testUserCRUD() {
  console.log('\n▸ User CRUD');

  // Create user
  const { status, data } = await api('/api/users', 'POST', {
    name: TEST_USER, team: TEST_TEAM,
  });
  assertEq(status, 200, 'Create user returns 200');
  assert(data.id && data.id.startsWith('u_'), 'User ID has correct format');
  assertEq(data.name, TEST_USER, 'Name matches');
  assertEq(data.team, TEST_TEAM, 'Team matches');
  testUserId = data.id;

  // Get users list
  const list = await api('/api/users');
  assert(list.data.some(u => u.id === testUserId), 'User appears in list');

  // Create with XSS in name
  const xss = await api('/api/users', 'POST', {
    name: '<script>alert(1)</script>', team: 'NY',
  });
  assert(!xss.data.name.includes('<script>'), 'XSS tags stripped from name');
  // Clean up XSS user
  if (xss.data.id) await api(`/api/users/${xss.data.id}`, 'DELETE');

  // Invalid team defaults to NY
  const badTeam = await api('/api/users', 'POST', {
    name: `_test_badteam_${Date.now()}`, team: 'INVALID',
  });
  assertEq(badTeam.data.team, 'NY', 'Invalid team defaults to NY');
  if (badTeam.data.id) await api(`/api/users/${badTeam.data.id}`, 'DELETE');
}

async function testUsageBasic() {
  console.log('\n▸ Usage — basic sync');

  // Log usage by name
  const { data } = await api('/api/usage', 'POST', {
    name: TEST_USER, team: TEST_TEAM, sessionPct: 10, weeklyPct: 20, source: 'extension',
  });
  assertEq(data.ok, true, 'Usage logged successfully');
  assertEq(data.sessionPct, 10, 'Session % stored correctly');
  assertEq(data.weeklyPct, 20, 'Weekly % stored correctly');
}

async function testMonotonicIncrease() {
  console.log('\n▸ Usage — monotonic increase within session');

  // Send higher value — should accept
  const higher = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 15, weeklyPct: 25, source: 'extension',
  });
  assertEq(higher.data.sessionPct, 15, 'Higher session % accepted');
  assertEq(higher.data.weeklyPct, 25, 'Higher weekly % accepted');

  // Send lower value within same session — should keep higher (monotonic)
  const lower = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 14, weeklyPct: 24, source: 'extension',
  });
  assertEq(lower.data.sessionPct, 15, 'Lower session % rejected (monotonic)');
  assertEq(lower.data.weeklyPct, 25, 'Lower weekly % rejected (monotonic)');
}

async function testSessionReset() {
  console.log('\n▸ Usage — session reset detection');

  // Set a high session value with a reset time in the past (expired session)
  const pastReset = new Date(Date.now() - 60000).toISOString(); // 1 min ago
  await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 30, weeklyPct: 40, source: 'extension',
    sessionResetsAt: pastReset,
  });

  // Drop within expired session — should be accepted
  const reset = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 4, weeklyPct: 42, source: 'extension',
  });
  assertEq(reset.data.sessionPct, 4, 'Session reset accepted (expired timer + drop)');
  assert(reset.data.weeklyPct >= 42, 'Weekly preserved/increased after session reset');

  // Drop within active session — should be REJECTED (monotonic)
  const futureReset = new Date(Date.now() + 3600000).toISOString(); // 1 hr from now
  await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 20, weeklyPct: 45, source: 'extension',
    sessionResetsAt: futureReset,
  });
  const rejected = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 5, weeklyPct: 45, source: 'extension',
  });
  assertEq(rejected.data.sessionPct, 20, 'Session drop rejected within active session');
}

async function testWeeklyReset() {
  console.log('\n▸ Usage — weekly reset detection');

  // Set high values with expired weekly timer
  const pastWeekly = new Date(Date.now() - 60000).toISOString();
  const pastSession = new Date(Date.now() - 60000).toISOString();
  await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 50, weeklyPct: 80, source: 'extension',
    sessionResetsAt: pastSession, weeklyResetsAt: pastWeekly,
  });

  // Both drop with expired timers — should be accepted
  const reset = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 2, weeklyPct: 2, source: 'extension',
  });
  assertEq(reset.data.sessionPct, 2, 'Session accepted after weekly reset');
  assertEq(reset.data.weeklyPct, 2, 'Weekly reset accepted (expired timer + drop)');
}

async function testAutoCreateUser() {
  console.log('\n▸ Usage — auto-create user');

  const autoName = `_test_auto_${Date.now()}`;
  const { data } = await api('/api/usage', 'POST', {
    name: autoName, team: 'NC', sessionPct: 5, weeklyPct: 10, source: 'extension',
  });
  assertEq(data.ok, true, 'Auto-create user on usage sync');

  // Verify user exists
  const list = await api('/api/users');
  const user = list.data.find(u => u.name === autoName);
  assert(!!user, 'Auto-created user appears in user list');
  assertEq(user.team, 'NC', 'Auto-created user has correct team');

  // Clean up
  if (user) await api(`/api/users/${user.id}`, 'DELETE');
}

async function testOldPluginFormat() {
  console.log('\n▸ Usage — old plugin format (pct only)');

  const oldUser = `_test_old_${Date.now()}`;
  const { data } = await api('/api/usage', 'POST', {
    name: oldUser, team: 'NY', pct: 42, source: 'manual',
  });
  assertEq(data.ok, true, 'Old format accepted');
  assertEq(data.weeklyPct, 42, 'pct mapped to weeklyPct');

  // Clean up
  const list = await api('/api/users');
  const user = list.data.find(u => u.name === oldUser);
  if (user) await api(`/api/users/${user.id}`, 'DELETE');
}

async function testExtraUsage() {
  console.log('\n▸ Usage — extra usage fields');

  const { data } = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 5, weeklyPct: 10,
    extraUsageSpent: 30.90, extraUsageLimit: 200, extraUsagePct: 15,
    source: 'extension',
  });
  assertEq(data.ok, true, 'Extra usage fields accepted');
}

async function testResetTimers() {
  console.log('\n▸ Usage — reset timer storage');

  const sessionResetsAt = new Date(Date.now() + 3600000).toISOString();
  const weeklyResetsAt = new Date(Date.now() + 86400000).toISOString();

  const { data } = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 8, weeklyPct: 12,
    sessionResetsAt, weeklyResetsAt, source: 'extension',
  });
  assertEq(data.ok, true, 'Reset timers accepted');
  assertEq(data.sessionResetSource, 'extension', 'Session reset source is extension');
  assertEq(data.weeklyResetSource, 'extension', 'Weekly reset source is extension');
}

async function testLeaderboardData() {
  console.log('\n▸ Leaderboard data');

  const { status, data } = await api('/api/data');
  assertEq(status, 200, 'Leaderboard data returns 200');
  const board = data.users || data;
  assert(Array.isArray(board), 'Returns users array');

  const testEntry = board.find(u => u.name === TEST_USER);
  assert(!!testEntry, 'Test user in leaderboard');
  if (testEntry) {
    assert(testEntry.sessionSparkline && Array.isArray(testEntry.sessionSparkline), 'Has session sparkline');
    assert(testEntry.weeklySparkline && Array.isArray(testEntry.weeklySparkline), 'Has weekly sparkline');
    assert(testEntry.budget > 0, 'Has budget calculated');
  }
}

async function testHistory() {
  console.log('\n▸ History endpoints');

  const { status, data } = await api(`/api/history/${testUserId}?limit=10`);
  assertEq(status, 200, 'User history returns 200');
  assert(Array.isArray(data), 'Returns array');
  assert(data.length > 0, 'Has history entries');

  // Team history
  const team = await api(`/api/team-history/${TEST_TEAM}?limit=5`);
  assertEq(team.status, 200, 'Team history returns 200');
}

async function testUserConfig() {
  console.log('\n▸ User config');

  // Set week start day
  const { data } = await api(`/api/users/${testUserId}/config`, 'PUT', {
    weekStartDay: 'sunday',
  });
  assertEq(data.ok, true, 'Config update succeeds');
  assertEq(data.weekStartDay, 'sunday', 'Week start day updated');

  // Invalid day rejected
  const bad = await api(`/api/users/${testUserId}/config`, 'PUT', {
    weekStartDay: 'notaday',
  });
  assertEq(bad.data.weekStartDay, 'sunday', 'Invalid day rejected, kept previous');
}

async function testExportImport() {
  console.log('\n▸ Export/Import');

  const { status, data } = await api('/api/export');
  assertEq(status, 200, 'Export returns 200');
  assert(data.users && Array.isArray(data.users), 'Export has users array');
  assert(data.usageLogs && Array.isArray(data.usageLogs), 'Export has usage logs');
}

async function testInputValidation() {
  console.log('\n▸ Input validation');

  // Clamping
  const clamped = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 999, weeklyPct: -5, source: 'extension',
  });
  assert(clamped.data.sessionPct <= 200, 'Session % clamped to max 200');
  assert(clamped.data.weeklyPct >= 0, 'Weekly % clamped to min 0');

  // Invalid source
  const badSource = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 5, weeklyPct: 10, source: 'hacker',
  });
  assertEq(badSource.data.ok, true, 'Invalid source accepted (sanitized to manual)');

  // Empty name
  const noName = await api('/api/users', 'POST', { name: '', team: 'NY' });
  assertEq(noName.status, 400, 'Empty name returns 400');
}

async function testSendBeacon() {
  console.log('\n▸ Usage — sendBeacon (text/plain body)');

  const beaconUser = `_test_beacon_${Date.now()}`;
  const res = await fetch(`${API_BASE}/api/usage`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ name: beaconUser, team: 'NY', sessionPct: 12, weeklyPct: 34, source: 'console' }),
  });
  const data = await res.json();
  assertEq(data.ok, true, 'sendBeacon (text/plain) accepted');
  assertEq(data.sessionPct, 12, 'sendBeacon session % correct');
  assertEq(data.weeklyPct, 34, 'sendBeacon weekly % correct');

  // Clean up
  const list = await api('/api/users');
  const user = list.data.find(u => u.name === beaconUser);
  if (user) await api(`/api/users/${user.id}`, 'DELETE');
}

async function testPlanType() {
  console.log('\n▸ Usage — plan type storage');

  // Send with planType
  const { data } = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 20, weeklyPct: 30, source: 'extension', planType: 'max5',
  });
  assertEq(data.ok, true, 'Usage with planType accepted');
  assertEq(data.planType, 'max5', 'planType stored correctly');

  // Update to max20
  const { data: d2 } = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 25, weeklyPct: 35, source: 'extension', planType: 'max20',
  });
  assertEq(d2.planType, 'max20', 'planType updated to max20');
}

async function testDataIntegrity() {
  console.log('\n▸ Data integrity — users array never shrinks');

  // Get current user count
  const before = await api('/api/users');
  const countBefore = before.data.length;

  // Add a user
  const added = await api('/api/users', 'POST', { name: `_test_integrity_${Date.now()}`, team: 'NY' });
  assert(added.data.id, 'Integrity test user created');

  // Verify count increased
  const after = await api('/api/users');
  assert(after.data.length >= countBefore + 1, 'User count increased after add');

  // Delete the test user
  await api(`/api/users/${added.data.id}`, 'DELETE');

  // Verify original users still exist
  const final = await api('/api/users');
  assert(final.data.length >= countBefore, 'Original users preserved after delete');
}

async function testMultiPlanAccumulation() {
  console.log('\n▸ Usage — multi-plan accumulation');

  // Set test user to 2 plans
  await api(`/api/users/${testUserId}/config`, 'PUT', { numPlans: 2 });

  // First sync: 80% weekly
  await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 50, weeklyPct: 80, source: 'extension',
  });

  // Max clamp should be 200 (2 plans * 100)
  const clamped = await api('/api/usage', 'POST', {
    name: TEST_USER, sessionPct: 250, weeklyPct: 250, source: 'extension',
  });
  assert(clamped.data.sessionPct <= 200, 'Session clamped to numPlans * 100');
  assert(clamped.data.weeklyPct <= 200, 'Weekly clamped to numPlans * 100');

  // Reset to 1 plan for other tests
  await api(`/api/users/${testUserId}/config`, 'PUT', { numPlans: 1 });
}

async function testCleanup() {
  console.log('\n▸ Cleanup');

  if (testUserId) {
    const { data } = await api(`/api/users/${testUserId}`, 'DELETE');
    assertEq(data.ok, true, 'Test user deleted');
  }

  // Verify deleted
  const list = await api('/api/users');
  assert(!list.data.some(u => u.id === testUserId), 'Test user no longer in list');
}

// ============================================================
// Runner
// ============================================================

async function run() {
  console.log(`\nClaude Leaderboard E2E Tests`);
  console.log(`API: ${API_BASE}\n${'─'.repeat(50)}`);

  try {
    await testUserCRUD();
    await testUsageBasic();
    await testMonotonicIncrease();
    await testSessionReset();
    await testWeeklyReset();
    await testAutoCreateUser();
    await testOldPluginFormat();
    await testExtraUsage();
    await testResetTimers();
    await testLeaderboardData();
    await testHistory();
    await testUserConfig();
    await testExportImport();
    await testInputValidation();
    await testSendBeacon();
    await testPlanType();
    await testDataIntegrity();
    await testMultiPlanAccumulation();
  } catch (e) {
    console.error('\n  FATAL:', e.message);
    failed++;
  } finally {
    await testCleanup();
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  ✗ ${f}`));
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

run();
