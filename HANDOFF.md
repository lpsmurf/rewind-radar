# Handoff — Rewind Radar Video (2026-11-05, MacBook → Mac Mini)

## Objective
Public, visual skill + repo library for the Supabase × Anthropic hackathon: an 8-bit video-rental store where
people browse, rent, vote, submit projects, propose ideas and get a personal GitHub radar from a Claude clerk.

## Current state (all live and tested 2026-11-05)
- Site: https://lpsmurf.github.io/rewind-radar/ · code: https://github.com/lpsmurf/rewind-radar (`main`, public, no secrets)
- Supabase project `skill-data-room` (`onovfynfxuemvsrdetez`): migrations 001 + 002 applied; Edge Function `api` deployed;
  secrets set (`ANTHROPIC_API_KEY`, `SERVICE_KEY`, `CRON_SECRET`); pg_cron `rewind-radar-refresh` Mon + Thu 09:00 UTC (first run Thu).
- Data: 114 skills (2 own with full text; 112 third-party linked to source), 20 GitHub repos, 0 community, 0 proposals.
- Verified live: clerk, Scan my GitHub, submit, propose + spam filter, votes via Realtime, rent rules, refresh guard, QR decodes to the site URL.

## Set up the Mac Mini (≈5 min)
1. Clone without overwriting anything:
   ```bash
   [ -e ~/dev/projects/rewind-radar ] && echo "folder exists — stop" || git clone https://github.com/lpsmurf/rewind-radar.git ~/dev/projects/rewind-radar
   ```
   (Once the ax-harness PR adding it to `config/projects.tsv` is merged, `ax projects` does this too.)
2. `cd ~/dev/projects/rewind-radar && npm ci`
3. Bring the keys over — `.env.local` is not in git. From the MacBook, copy the file across yourself
   (AirDrop, or `scp ~/dev/projects/rewind-radar/.env.local <mac-mini-ssh-host>:~/dev/projects/rewind-radar/`).
   Never paste keys into chat or commit them.
4. Check: `npm run check:db` → all tables `ok`. Then `npm run dev`.
5. For deploys: `npx supabase login` (browser, no email) and `gh auth status` (lpsmurf).

## Gotchas
- `claude-sonnet-5-5` rejects forced `tool_choice`; `lib/ai.ts` uses `auto` + text fallback for Sonnet.
- Node 20 needs the `ws` WebSocket polyfill for supabase-js (done in `scripts/env.ts` and `vite.config.mts`).
- Edit API code in `lib/`, never in `supabase/functions/_shared` (it is overwritten by `scripts/sync-edge.sh`).
- Imports in `lib/` keep explicit `.ts` extensions (Deno needs them).
- Supabase CLI asks for consent on deploys; `deploy:api` passes `--yes`.
- Vercel was abandoned (sign-in email never arrived); hosting is GitHub Pages + Supabase.
- `seed/review.json` (held skills) is gitignored — regenerate with `npm run seed:skills`.
- Visitor identity is a random localStorage id: votes can be stuffed by clearing storage; rate limits are per Edge instance.

## Remaining work / ideas (priority order)
1. Hackathon submission blurb + 90-second demo script (open with the QR, then clerk → scan → vote).
2. Publish more own skills: 21 held by the privacy check (client names, email, IPs). Clean, then `npm run seed:skills -- --approve=…`.
3. Weekly winners: "Hall of Fame" shelf for top tape + top proposal each week (retired repos already keep votes via `tapes.archived`).
4. Skene growth aisle (Skene `plg-skills`, link-only) and memories "Staff Picks" (scrubbed, approved).
5. Harden voting: Supabase anonymous auth instead of localStorage ids.
