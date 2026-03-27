# Claude Leaderboard — Migration to NY Servers

## Why
Cloudflare Access has a 50-seat limit. We have 40 users and growing. Moving to NY infra removes the cap.

## Current Stack
- **Runtime:** Cloudflare Worker (single JS file: `src/worker.js`)
- **Storage:** Cloudflare KV (127 keys, 240K total data)
- **Frontend:** Vanilla HTML/JS in `public/` (no build step)
- **Auth:** Cloudflare Access (the bottleneck)

## What We Need on NY Side
1. **Redis instance** (or a shared one) — CF KV is key-value, Redis is drop-in replacement
2. **One container slot** — Node.js server, ~50MB image, minimal CPU/memory
3. **Ingress rule** — e.g. `leaderboard.nammayatri.in` (internal or public)
4. **No special auth needed** — if it's behind internal network, no SSO required

## Migration Steps
1. Convert CF Worker → Node.js server (same logic, just swap KV calls → Redis)
2. Import data (attached `kv-dump-latest.json`, 127 keys) into Redis
3. Containerize and deploy to K8s
4. Point DNS / add ingress
5. Update Chrome extension API URL

## Data Summary
- **40 users** across teams: NY, NC, Xyne, HS, JP
- **39 usage records** with session/weekly percentages, sparkline history
- **7 user configs**, projects & strategies data
- Total: **127 keys, 240K**

## Effort Estimate
- Server conversion: I can do this
- Infra (Redis + K8s + ingress): Need someone from platform team
- Extension update: I'll handle

## Repo
https://github.com/mags-814/ai-leaderboard (or wherever it's hosted)

## Attached
- `kv-dump-latest.json` — full data export, ready to import into Redis
