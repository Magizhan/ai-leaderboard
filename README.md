# Claude Usage Leaderboard

Real-time gamified leaderboard to track and maximize Claude AI usage across your team.

## Features

- **Live leaderboard** with rank system (Bronze → Silver → Gold → Platinum → Diamond → Legendary)
- **Team Battle** - NY vs Xyne with animated progress bars
- **Bookmarklet** - one-click usage reporting from claude.ai
- **Click-to-update** - click any row to quickly update usage %
- **Multiple $200 plans** per user supported
- **Auto-refresh** every 30 seconds
- **Import/Export** JSON data
- **Confetti** celebrations when users hit 100%

## Quick Setup

### 1. Install dependencies

```bash
cd src/leaderboard
npm install
```

### 2. Create KV namespace

```bash
npx wrangler kv namespace create LEADERBOARD_KV
```

Copy the output ID and paste it into `wrangler.toml` replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 3. Seed default user (Mags, NY)

```bash
# After deploying, run:
curl -X POST https://your-domain.com/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Mags", "team": "NY", "numPlans": 1}'
```

### 4. Deploy

```bash
npx wrangler deploy
```

### 5. Custom domain (Magizhan.work)

In your Cloudflare dashboard:
1. Go to Workers & Pages → your worker
2. Settings → Triggers → Custom Domains
3. Add `Magizhan.work` (or a subdomain like `leaderboard.magizhan.work`)

### 6. Install the bookmarklet

1. Visit your deployed dashboard
2. Drag the "Report Usage" button to your bookmarks bar
3. When on claude.ai, click the bookmarklet to auto-report your usage %

## How the bookmarklet works

1. First use: asks for your leaderboard name (saved in browser)
2. Scans the page for percentage values
3. Shows found percentages and lets you pick the right one
4. Posts your usage % to the leaderboard API
5. Dashboard updates in real-time

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/data` | Full leaderboard data |
| GET | `/api/users` | List users |
| POST | `/api/users` | Add user |
| DELETE | `/api/users/:id` | Remove user |
| POST | `/api/usage` | Log usage (bookmarklet/manual) |
| POST | `/api/users/:id/plans` | Add plans to user |
| GET | `/api/export` | Export all data |
| POST | `/api/import` | Import data |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `a` | Add user |
| `u` | Log usage |
| `r` | Refresh |
| `Esc` | Close modal |

## Local Development

```bash
npx wrangler dev
```

Opens at `http://localhost:8787`.
