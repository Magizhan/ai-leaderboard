# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Claude Usage Leaderboard — a gamified dashboard tracking Claude AI usage across teams. Built as a Cloudflare Worker with KV storage, serving a static frontend and REST API.

## Architecture

- **Backend**: Single Cloudflare Worker (`src/worker.js`) handling all API routes and serving static assets
- **Frontend**: Vanilla HTML/JS in `public/index.html` (no build step, no framework)
- **Storage**: Cloudflare KV (`LEADERBOARD_KV`) with keys: `users` (array), `usage:{userId}` (per-user usage data)
- **Browser Extension**: Chrome MV3 extension in `extension/` that auto-syncs usage from claude.ai/settings/usage via content script + background service worker
- **Teams**: NY, NC, Xyne, HS — used for team battle comparisons

## Commands

```bash
npm run dev        # Local dev server at localhost:8787 (wrangler dev)
npm run deploy     # Deploy to Cloudflare Workers
```

## API

All endpoints under `/api/`. Key routes: `/api/data` (full leaderboard), `/api/users` (CRUD), `/api/usage` (log usage), `/api/export` + `/api/import` (data portability). The worker auto-creates users on usage submission if they don't exist.

## KV Schema

- `users` → `[{ id, name, team, numPlans }]`
- `usage:{id}` → `{ userId, sessionPct, weeklyPct, timestamp, source }`
- User IDs are generated as `u_<timestamp_base36>_<random>`
