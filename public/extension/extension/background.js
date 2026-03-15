// ============================================================
// Background service worker
// Handles scheduled auto-sync and badge updates
// ============================================================

const ALARM_NAME = 'claude_usage_sync';

// Listen for alarm — open usage page in background tab, let content script handle sync
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  const stored = await chrome.storage.local.get(['schedule_enabled']);
  if (!stored.schedule_enabled) return;

  // Check if usage page is already open
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
  if (tabs.length > 0) {
    // Page already open — just reload it to trigger content script
    chrome.tabs.reload(tabs[0].id);
    return;
  }

  // Open in background tab
  const tab = await chrome.tabs.create({
    url: 'https://claude.ai/settings/usage',
    active: false,
  });

  // Close the tab after content script has had time to scrape and sync
  // Content script waits up to 10s for data + sync takes ~2s
  setTimeout(async () => {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      // Tab may have been closed by user already
    }
  }, 20000);
});

// Badge update on sync success
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'sync_success') {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 5000);
  }
});

// On install/update — enable auto-sync by default, or restore existing setting
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(['schedule_enabled', 'schedule_interval', 'defaults_applied_v3']);

  if (!stored.defaults_applied_v3) {
    // First install or upgrade: default to ON at 5 min
    await chrome.storage.local.set({
      defaults_applied_v3: true,
      schedule_enabled: true,
      schedule_interval: 5,
    });
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  } else if (stored.schedule_enabled) {
    // Existing user with sync enabled — restore their alarm
    const mins = stored.schedule_interval || 5;
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: mins });
  }
});
