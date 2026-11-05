# Handoff — Rewind Radar Video

## ▶ Next session starts here (2026-11-05, work Mac mini → Claude Code on API billing)
The plan is in **docs/ROADMAP.md** (approved by Luis). It has six phases:
1. clerk guardrails and repo assessment;
2. live store: movement sync, chat, arcade "opening soon";
3. auto-filled weekly/monthly shelves from GitHub, YouTube and X;
4. GitHub sign-in membership;
5. Study Room;
6. Hall of Fame and Candy Stand.

### Phase 1 status: code-review fixes done on branch `feat/clerk-assess`, PR open into `main`, not merged, not deployed
- **What it does:**
  - A GitHub repo pasted into the clerk gets an assessment card. Sonnet 5.5 writes it as structured output and it is cached for 7 days.
  - With a scanned GitHub username, the card adds a personal FIT check (Haiku).
  - Ordinary questions run on Haiku 5.5 with an `on_topic` guardrail over full-text-search candidates.
  - Every route that calls Anthropic (clerk, assess, fit, profile, submit, propose, radar refresh) is metered in `ai_usage` and checked against `AI_DAILY_BUDGET_USD` (default $5/day). Over budget, the clerk answers from search only; profile/submit/propose answer 503 with an in-character line; the radar refresh skips.
  - Sonnet assessments also have a database-backed cap: `AI_ASSESS_MAX_PER_HOUR` (default 20) and `AI_ASSESS_BUDGET_USD` (default $2/day). /profile has its own: `AI_PROFILE_MAX_PER_HOUR` (default 30) and `AI_PROFILE_BUDGET_USD` (default $1/day). The defaults live in code, so no new secrets are needed.
  - Before each Sonnet call a placeholder `ai_usage` row is reserved at worst-case cost (`AI_ASSESS_RESERVE_USD` default 0.12, `AI_PROFILE_RESERVE_USD` default 0.06), then the caps are checked including every concurrent reservation, so bursts can be refused but never overshoot. The row is updated with the real cost afterwards.
  - A repo that failed (or is being assessed) in the last 10 minutes is not assessed again: the stale row is served, or a 503 "still rewinding" line.
  - `budgetLeft()` fails closed on every route: if the meter can't be read, nobody spends.
- **Tests:** `npm test` (Vitest, **182 tests**; Anthropic, GitHub and Supabase are mocked, and any unmocked fetch throws). Shared data lives in `test/helpers/`. Never import from another `*.test.ts`.
- **CI:** `.github/workflows/ci.yml` runs typecheck, test, build, sync-edge and `deno check`.
- **Verified this session (2026-11-05):** `npm test` (182), `npx tsc --noEmit -p .`, `npm run build`, `bash scripts/sync-edge.sh && deno check supabase/functions/api/index.ts` all pass locally. Nothing has been run against the real Anthropic, GitHub or Supabase.

### Code-review findings: all 8 fixed (test-first, one commit each)
1. **Budget bypass, fixed.** /profile, /submit, /propose and radar/refresh are budget-gated and metered through a shared `meter()` helper. /profile fails closed and has its own database cap.
2. **Spoofable rate limits, fixed in code; one thing still to check on the deployed function.** Limits are keyed on the client IP: `cf-connecting-ip`, else the last `x-forwarded-for` hop, else 'anon'. `visitorId` is no longer used. Keys are truncated and the in-memory map is pruned. The global Sonnet limit now counts `ai_usage` rows in the database. **To check:** log the headers of one deployed request and confirm which header carries the visitor's IP on Supabase Edge (`clientKey` in `lib/routes.ts`).
3. **Failed calls not metered, fixed.** `AssessError` carries `usage`/`model`. Usage is recorded right after the Sonnet call returns, once. Failure caching was not added.
4. **Fail-open, fixed.** `budgetLeft({ failClosed: true })` is used on the Sonnet paths, and an error reading `assessments` now throws. The Haiku paths stay fail-open on purpose.
5. **Persuasive READMEs, fixed.**
   - `clampRing` applies on every fresh and cached row: archived gives hold; no licence or more than 365 days since the last push gives at most trial.
   - The README is wrapped in `<readme>` and header lines in it are neutralised.
   - `PROMPT_VERSION` is now 2.
   - The card labels its steps "from the README, unverified".
6. **Bare `owner/repo`, fixed.** The repo must exist (as a tape or on GitHub) before any quota is used. The GitHub check is cached. A bare ref never returns an error and falls back to the normal ask path.
7. **Expired row plus rate limit, fixed.** The stale row is served instead of a 429.
8. **Notes:**
   - `GITHUB_TOKEN` must still be public-repo read-only.
   - `PRICES` only knows Haiku and Sonnet. An unknown model is priced as Sonnet, so add it to `PRICES` before changing `CLERK_MODEL`/`ASSESS_MODEL`.

A final Sonnet review of the diff led to six more fixes, also test-first: the `cf-connecting-ip` preference, the /profile database cap, budget checks running before the per-visitor slot is spent, the clamp on cached rows, metering right after the call, and the `repoExists` cache.

**Known leftovers (not fixed, low or medium):**
- In-memory limits are still per Edge isolate, and pruning is O(n) once the map holds more than 5000 keys.

### Still to do for Phase 1 (Luis, in this order)
1. **Apply `supabase/migrations/003_clerk.sql` before deploying this code**, through the SQL editor or `supabase link --project-ref onovfynfxuemvsrdetez` + `supabase db push`. The Sonnet paths now fail closed: without the migration, repo assessments and Scan my GitHub are refused, and the clerk answers from search only.
2. Set the two secrets: `npx supabase secrets set GITHUB_TOKEN=<fine-grained, read-only, public repos> AI_DAILY_BUDGET_USD=5 --project-ref onovfynfxuemvsrdetez`. The optional caps (`AI_ASSESS_*`, `AI_PROFILE_*`) have defaults in code.
3. Re-verify in your local dev server:
   - a second Postiz ask is served from cache;
   - `ai_usage` gets rows (`assess`, then `fit`/`profile`);
   - a FIT appears after scanning `lpsmurf`;
   - a bare question like "tcp/ip" gets a normal answer.

   The cached Postiz row is prompt v1, so the first ask re-assesses it once.
4. Merge the PR once CI is green.
5. Deploy (`npm run deploy:api`, `npm run deploy:site`) **only when Luis says so**. Afterwards, check which IP header Supabase sets (finding 2).
- **Optional:** add `scripts/eval-clerk.ts`, about 30 labelled on/off-topic questions run against the real API. It costs cents and needs Luis's OK. Use it before switching `ASSESS_MODEL` to Haiku.

### Phase 2 findings (already diagnosed, not started)
- Other visitors don't move because presence shares only an aisle name (`setAisle` in `src/lib/useStore.ts`). Remote characters are drawn at fixed `anchorOf(aisle)` spots (`src/store/Store.tsx` ~L230).
- Same-browser tabs share the `rr_visitor` id, so they merge into one presence entry and hide as "me".
- The fix, plus chat and the arcade, is in docs/ROADMAP.md Phase 2.

### How to work (Luis's rules)
- Delegate to subagents on the cheapest model that fits: Haiku for mechanical work and QA, Sonnet for implementation and review.
- Use one branch and one PR per phase. Commit as `lpsmurf <littleplu@gmail.com>`, with no "Generated with" line.
- The dev server writes to the **production** database. Live AI calls cost real credits, so keep them to a handful.
- Run Claude Code on API billing with its own Console key, not the app's key in `.env.local`, so the app's spend meter stays clean.

---

# Earlier handoff (2026-11-05, MacBook → work Mac mini)

## Objective
Public, visual skill + repo library for the Supabase × Anthropic hackathon: an 8-bit video-rental store where
people browse, rent, vote, submit projects, propose ideas and get a personal GitHub radar from a Claude clerk.

## Current state (all live and tested 2026-11-05)
- Site: https://lpsmurf.github.io/rewind-radar/ · code: https://github.com/lpsmurf/rewind-radar (`main`, public, no secrets)
- Supabase project `skill-data-room` (`onovfynfxuemvsrdetez`): migrations 001 + 002 applied; Edge Function `api` deployed;
  secrets set (`ANTHROPIC_API_KEY`, `SERVICE_KEY`, `CRON_SECRET`); pg_cron `rewind-radar-refresh` Mon + Thu 09:00 UTC (first run Thu).
- Data: 114 skills (2 own with full text; 112 third-party linked to source), 20 GitHub repos, 0 community, 0 proposals.
- Verified live: clerk, Scan my GitHub, submit, propose + spam filter, votes via Realtime, rent rules, refresh guard, QR decodes to the site URL.

## Set up the work Mac mini (≈5 min)
This is the **work** Mac mini — not the always-on server (`luiss-mac-mini`, which runs the AX dashboard).
Nothing below needs the server, Tailscale or the AX harness.

1. Clone without overwriting anything:
   ```bash
   mkdir -p ~/dev/projects && cd ~/dev/projects
   [ -e rewind-radar ] && echo "folder exists — stop" || git clone https://github.com/lpsmurf/rewind-radar.git
   ```
   (If this Mac has the AX harness, `ax projects` does the same once ax-harness PR #65 is merged.)
2. Node 20+ and packages: `node -v` then `cd ~/dev/projects/rewind-radar && npm ci`
3. Keys: `.env.local` is not in git. **AirDrop** it from the MacBook (`~/dev/projects/rewind-radar/.env.local`)
   into `~/dev/projects/rewind-radar/` (in Finder press ⌘⇧. to see dot-files). Never paste keys into chat or commit them.
4. Check: `npm run check:db` → every table `ok`. Then `npm run dev` → http://localhost:5173
5. To ship from this Mac: `gh auth login` (as lpsmurf) and `npx supabase login` (browser, no email), then
   `npm run deploy:api` / `npm run deploy:site`.
6. Re-seeding skills (`npm run seed:skills`, `npm run provenance`) reads `~/.claude/skills` on *this* Mac — only run
   them on a machine with the full skill set, or the shelves will shrink to what's installed there.

## Gotchas
- `claude-sonnet-5-5` rejects forced `tool_choice`; `lib/ai.ts` uses `auto` + text fallback for Sonnet.
- Node 20 needs the `ws` WebSocket polyfill for supabase-js (done in `scripts/env.ts` and `vite.config.mts`).
- Edit API code in `lib/`, never in `supabase/functions/_shared` (it is overwritten by `scripts/sync-edge.sh`).
- Imports in `lib/` keep explicit `.ts` extensions (Deno needs them).
- Supabase CLI asks for consent on deploys; `deploy:api` passes `--yes`.
- Vercel was abandoned (sign-in email never arrived); hosting is GitHub Pages + Supabase.
- `seed/review.json` (held skills) is gitignored — regenerate with `npm run seed:skills`.
- Visitor identity is a random localStorage id: votes can be stuffed by clearing storage; rate limits are per Edge instance.

## Remaining work / ideas (superseded by docs/ROADMAP.md)
1. Hackathon submission blurb + 90-second demo script (open with the QR, then clerk → scan → vote).
2. Publish more own skills: 21 held by the privacy check (client names, email, IPs). Clean, then `npm run seed:skills -- --approve=…`.
3. Weekly winners: "Hall of Fame" shelf for top tape + top proposal each week (retired repos already keep votes via `tapes.archived`).
4. Skene growth aisle (Skene `plg-skills`, link-only) and memories "Staff Picks" (scrubbed, approved).
5. Harden voting: Supabase anonymous auth instead of localStorage ids.
