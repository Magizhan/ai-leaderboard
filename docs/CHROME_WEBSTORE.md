# Publishing Claude Usage Sync to Chrome Web Store

## Prerequisites

- A Google account with a **Chrome Web Store Developer** registration ($5 one-time fee)
- If you already have a developer account, skip to "Upload & Publish"

## Register as Developer

1. Go to https://chrome.google.com/webstore/devconsole
2. Sign in with your Google account
3. Pay the **$5 USD** one-time registration fee
4. Accept the developer agreement

> **Note:** If the payment form declines your card, try a different Google account, a different browser, or contact Google support. Some corporate cards are blocked.

## Upload & Publish

### 1. Prepare the ZIP

The extension is in the `extension/` directory. A pre-built ZIP is at `public/extension/extension.zip`.

To rebuild:
```bash
zip -j extension.zip extension/manifest.json extension/content.js extension/background.js extension/popup.js extension/popup.html extension/icon48.png extension/icon128.png
```

### 2. Required Store Listing Assets

| Asset | Spec | Notes |
|-------|------|-------|
| Store icon | 128x128 PNG | Already have `extension/icon128.png` |
| Screenshot(s) | 1280x800 or 640x400 PNG/JPG | At least 1 required. Take a screenshot of the popup on the claude.ai usage page |
| Short description | Max 132 chars | `Auto-syncs your Claude AI usage percentages and reset timers to your team's leaderboard dashboard.` |
| Full description | Up to 16,384 chars | See below |
| Category | Productivity | |
| Privacy policy URL | Required | Must disclose that we read usage data from claude.ai and send it to leaderboard.magizhan.work |

### 3. Suggested Full Description

```
Claude Usage Sync automatically tracks your Claude AI usage and syncs it to your team's leaderboard.

Features:
- Auto-syncs session and weekly usage percentages from claude.ai/settings/usage
- Detects your Claude username automatically
- Scrapes session and weekly reset countdown timers
- Configurable auto-sync schedule (5min / 15min / 30min)
- Supports multiple teams (NY, NC, Xyne, HS, JP)
- Manual sync button for on-demand updates

How it works:
1. Install the extension
2. Visit claude.ai/settings/usage
3. The extension reads your usage percentages and reset timers
4. Data is sent to your team's leaderboard at leaderboard.magizhan.work

Data collected:
- Your Claude display name
- Usage percentages (session and weekly)
- Reset timer information
- Your selected team

No passwords, conversation content, or personal data is collected.
```

### 4. Privacy Policy

You need a privacy policy URL. Host this on the worker by adding a `/privacy` route, or create a simple page. It must state:
- What data is collected (usage %, name, reset timers)
- Where it's sent (leaderboard.magizhan.work)
- What is NOT collected (passwords, conversations, personal data)
- No data is sold or shared with third parties

### 5. Submit

1. In the Developer Dashboard, click "New Item"
2. Upload the ZIP
3. Fill in all listing details
4. Submit for review

### 6. Review Timeline

- First submission: **1-3 business days** (can take up to a week)
- Updates: Usually **under 24 hours**

## Automatic Updates

Once published, Chrome auto-updates extensions for all users (checks every few hours). To push an update:

1. Bump `version` in `extension/manifest.json`
2. Rebuild the ZIP
3. Upload to Developer Dashboard
4. Submit for review

No action needed from users — Chrome handles it automatically.

## Permissions Justification

If Google asks why these permissions are needed:

| Permission | Reason |
|------------|--------|
| `activeTab` | Read usage data when user clicks the extension |
| `scripting` | Inject content script to scrape usage page |
| `storage` | Save user preferences (team, sync schedule) |
| `alarms` | Schedule periodic auto-sync |
| `tabs` | Open usage page for background sync |

## Important Notes

- **Manifest V3** is required — our extension already uses MV3
- **No obfuscated code** — all code is readable (no minification issues)
- **Single purpose** — the extension only syncs Claude usage data
- Content script only runs on `https://claude.ai/settings/usage*`
