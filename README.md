# Rewind Radar Video

An 8-bit isometric video-rental store for **Claude Code skills** and **this week's top new GitHub repos**.
Built at the Supabase × Anthropic hackathon (Nov 2026).

**Live:** https://lpsmurf.github.io/rewind-radar/

## What visitors can do
- Browse ~115 skills on genre aisles and 20 GitHub New Releases (Claude rates each: Adopt / Trial / Assess / Hold).
- **Ask the clerk** (Claude Sonnet) for a tape, or **Scan my GitHub**: paste a user or repo and get a personal radar of skills + repos.
- **Rent**: own skills copy a one-line install; third-party skills link to their original source (we don't republish other people's work).
- **Vote** on tapes (live Top 10), **submit a project** (Claude reviews the repo), **propose an idea** in the Request Box and back others.
- See other visitors as pixel avatars, live.

## Architecture
| Part | Where |
|---|---|
| Site (Vite + React + TS, canvas renderer) | GitHub Pages, `gh-pages` branch |
| API (clerk, profile, submit, propose, tape, radar/refresh) | Supabase Edge Function `api` — source in `lib/routes.ts`, copied into `supabase/functions/_shared` by `scripts/sync-edge.sh` |
| Data, live votes, presence | Supabase project `onovfynfxuemvsrdetez` (Postgres + RLS + Realtime) |
| Radar refresh | `pg_cron` job `rewind-radar-refresh`, Mon + Thu 09:00 UTC; the API refuses re-runs within 60 h |
| AI | `claude-haiku-5-5` (reviews, screening), `claude-sonnet-5-5` (clerk, profile radar) |

Schema: `supabase/migrations/001_init.sql`, `002_refresh_and_proposals.sql` (run in the Supabase SQL editor).

## Local development
```bash
npm ci
cp .env.example .env.local   # fill in the values (never commit this file)
npm run dev                  # http://localhost:5173 — /api/* is served by lib/routes.ts locally
```
`.env.local` needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (publishable), `SUPABASE_SERVICE_ROLE_KEY` (secret), `ANTHROPIC_API_KEY`, `CRON_SECRET`.

## Scripts
| Command | Does |
|---|---|
| `npm run deploy:api` | Deploy the Edge Function (needs `npx supabase login` once) |
| `npm run deploy:site` | Build and publish to GitHub Pages |
| `npm run seed:skills -- --approve=a,b` | Claude-classify `~/.claude/skills`, publish clean ones (+ approved held ones) |
| `npm run seed:radar` | Refresh the New Releases wall now |
| `npm run provenance` | Re-apply own vs third-party rules from `scripts/own-skills.json` |
| `npm run stats` / `npm run check:db` | Row counts / table check |
| `scripts/supabase-setup.sh` | First-time: Supabase login + secrets + deploy |

Secrets live only in `.env.local` and Supabase secrets (`ANTHROPIC_API_KEY`, `SERVICE_KEY`, `CRON_SECRET`).
