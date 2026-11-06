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
  - Before each Sonnet call a placeholder `ai_usage` row is reserved at worst-case cost (`AI_ASSESS_RESERVE_USD` default 0.12, `AI_PROFILE_RESERVE_USD` default 0.07), then the caps are checked including every concurrent reservation, so bursts can be refused but never overshoot. The row is updated with the real cost afterwards.
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
2. Set the two secrets: `npx supabase secrets set GITHUB_TOKEN=<fine-grained, read-only, public repos> AI_DAILY_BUDGET_USD=3 AI_ASSESS_BUDGET_USD=1.5 --project-ref onovfynfxuemvsrdetez` (Luis chose $3/day on 2026-11-05). The other optional caps (`AI_ASSESS_*`, `AI_PROFILE_*`) have defaults in code.
3. Re-verify in your local dev server:
   - a second Postiz ask is served from cache;
   - `ai_usage` gets rows (`assess`, then `fit`/`profile`);
   - a FIT appears after scanning `lpsmurf`;
   - a bare question like "tcp/ip" gets a normal answer.

   The cached Postiz row is prompt v1, so the first ask re-assesses it once.
4. Merge the PR once CI is green.
5. Deploy (`npm run deploy:api`, `npm run deploy:site`) **only when Luis says so**. Afterwards, check which IP header Supabase sets (finding 2).
- **Optional:** add `scripts/eval-clerk.ts`, about 30 labelled on/off-topic questions run against the real API. It costs cents and needs Luis's OK. Use it before switching `ASSESS_MODEL` to Haiku.

### Clerk gate: branch `feat/clerk-gate`, PR stacked on PR #1 (Luis's request, 2026-11-05)
- **Rule:** only visitors who give a GitHub username or sign in with GitHub may use the clerk. Guests get 401 and a gate panel.
- **Tiers:**
  - **Light:** a GitHub username the server checks exists. The check is cached: hits 1 h, misses 10 min, in-flight checks shared. New lookups are limited per IP (`GATE_LOOKUPS_PER_HOUR`, default 20). If GitHub can't be reached for an uncached name, the request is refused with 503. Light identities are unverified, so only the IP bucket really binds them: 15 questions and 5 assessments an hour.
  - **Member:** signed in with Supabase Auth, GitHub provider. The `Bearer` token is verified with `auth.getUser`. The login comes from the GitHub identity's `identity_data`, never from the user-editable `user_metadata`. Limits: 40 questions and 10 assessments an hour per member.
- **Global ceiling:** `CLERK_MAX_PER_HOUR` (default 300) per Edge isolate. Over it, the clerk answers in search-only mode.
- **No migration needed.**
- **Luis, to switch on sign-in (tier 2):**
  1. In GitHub, go to Settings → Developer settings → OAuth Apps → New. Homepage: `https://lpsmurf.github.io/rewind-radar/`. Callback: `https://onovfynfxuemvsrdetez.supabase.co/auth/v1/callback`.
  2. In Supabase, go to Authentication → Providers → GitHub. Enable it, then paste the Client ID and Secret.
  3. In Authentication → URL Configuration, add `https://lpsmurf.github.io/rewind-radar/` and `http://localhost:5173/**` to the redirect allow-list.
  4. Build the site with `VITE_GITHUB_SIGNIN=1`, then deploy the API and the site when you say so.
- **Not tested in a real browser:** the OAuth redirect and the session being restored after it.

### Phase 2 status: code done on branch `feat/live-store`, PR stacked on the gate PR, not merged, not deployed
- **Movement:**
  - Click the floor or use arrow keys / WASD to walk. Paths go around the shelves (`src/store/movement.ts`).
  - Positions travel as Realtime broadcast `move` events, at most about 8 a second. Remote characters walk smoothly toward them.
  - Presence carries the last x/y, so newcomers see where everyone is.
  - The presence key is the visitor id plus a per-tab id, so two tabs show as two people. Votes still use the plain visitor id.
  - Incoming positions are clamped. `move` events for keys not in presence are ignored. Remote positions are capped at 200.
- **Arcade:** an "ARCADE →" door leads to an OPENING SOON room with cabinets. "Tell me when it opens" backs or creates an "Open the arcade" proposal. No emulator, games or ROMs.
- **Chat, gated like the clerk:**
  - Guests can watch. Light visitors chat as `@login (unverified)`; members get a ✓. Switching to members-only is a one-line change in the `/chat` route, but chat would then be off until the GitHub OAuth App exists.
  - Each message goes through free checks first (`lib/chatGuard.ts`: 140 chars; links only to github.com or the store; Unicode dots normalised; blocklist), then Haiku moderation.
  - Moderation has its own budget, `AI_CHAT_BUDGET_USD` (default $0.50/day, `chat_spend_today()`). When that is spent, or the meter is broken, chat rests with a 503. It never posts unmoderated.
  - Limits: 1 message every 2 s, 30 an hour per identity, 60 an hour per IP.
  - Three distinct reporters remove a message, through an atomic `report_chat` RPC. Self-reports are refused.
  - An admin can delete with the `x-admin-token` header.
  - A removed message is a hard DELETE, so it vanishes for everyone through Realtime.
  - Speech bubbles appear above the sender for about 6 s, with the login and tier mark. The chat log panel is in the sidebar.
- **Migration `004_chat.sql`** (written, not applied): `chat_messages` (public SELECT on the last 24 h only), the server-only tables `chat_senders` and `chat_reports`, `report_chat` and `chat_spend_today` (service_role only), the Realtime publication, and an hourly pg_cron cleanup.
  - Tested on a throwaway local Postgres 17 container: it applies, it re-runs idempotently, the report logic works, and anon is denied on writes, sender ids and the RPC.
  - Not tested: the pg_cron and Realtime parts, since the container has neither.
- **Tests:** 358. tsc, build, sync-edge and `deno check` pass.
- **Browser-verified (2026-11-05):** headless Chromium with separate browser contexts, against a local Supabase stack in Docker. GitHub and Anthropic were mocked; nothing touched production. All 10 scenarios pass:
  - presence, walking, and two tabs as two people;
  - the arcade, seen by others;
  - the guest gate;
  - chat bubbles and BADWORD rejection;
  - removal after 3 reports in both windows;
  - the clerk;
  - a stress run of 8+ aisles and arcade trips in under 30 s with no presence rate limit;
  - forced socket closes reconnecting in about 1 s.

  Three bugs found this way are fixed: the stale presence meta, the presence rate limit closing the channel, and reconnect recursion.
- **Not browser-tested:** real GitHub OAuth, real Haiku moderation, shelves with real tapes, and mobile.
- **Known trade-off:** any `word.word` token counts as a link, so "node.js" or "next.js" in a message is refused.
- **Luis, in this order (after Phase 1 and the gate are live):**
  1. Apply `supabase/migrations/004_chat.sql`.
  2. Set the secret: `npx supabase secrets set ADMIN_TOKEN=<long random> --project-ref onovfynfxuemvsrdetez`. Optionally set `AI_CHAT_BUDGET_USD`.
  3. Run a two-browser test in your dev server:
     - walking in one window shows in the other;
     - two tabs are two people;
     - entering the arcade shows for others;
     - a chat message appears, with its bubble;
     - a message reported by 3 identities disappears in both windows.
  4. Deploy when you say so.

### Phase 3 status: code done on branch `feat/sources`, PR stacked on the Phase 2 PR, not merged, not deployed
- **Sources:**
  - **GitHub weekly** (as before).
  - **YouTube** (`lib/sources/youtube.ts`): the YouTube Data API searches the configured queries and channels for the last 7 days. GitHub links are pulled out of descriptions in code, and Haiku names explicit mentions only when there is no link. Usage is about 1,500 of the 10,000 daily quota units.
  - **Web/X** (`lib/sources/web.ts`): one weekly Sonnet `web_search_20260209` call (max 5 searches), then a Haiku extraction. X posts are found only through web search, because the X API is paid and scraping breaks its terms.
  - **Manual paste** in the admin panel.
  - Every candidate is verified on GitHub before it is queued, and credited to the video or article it came from. Nothing is stocked without an admin approving it.
  - Cost is about $0.15 a week.
- **Admin panel `/#admin`** (ADMIN_TOKEN, at least 32 chars, kept in sessionStorage):
  - Queue: approve or reject. Approve claims the row atomically and un-archives old tapes. A stocked tape's trust is "caution" unless it has a licence, is active and isn't archived.
  - Paste, Spend per day/route, Runs, and Config (YouTube queries and channels, the web query).
  - 20 failed logins an hour lock the admin for 15 minutes.
- **Monthly Picks shelf:** on the 1st, `/sources/monthly` scores last month's tapes as votes cast that month × 3 + stars gained, from `star_snapshots`. The top 10 go into `monthly_picks`. The Weekly New Releases shelf shows only the latest week; older repo tapes move to their genre aisle.
- **Batch pre-assessment:** newly stocked repos are assessed through Message Batches at half price, so the clerk card is instant.
  - It is submitted after the radar refresh and collected on the next sources run.
  - Collection is claimed first, so it never runs twice. Each result is done once, and failures are retried.
  - The spend reservation stays open until collection. Own cap: `AI_BATCH_BUDGET_USD`, default $2, inside the daily budget.
- **Migration `005_sources.sql`** (not applied): the queue, config, runs, snapshots, monthly picks, batches, admin failures and `spend_by_day`, plus two pg_cron jobs: sources Tue 09:00 UTC and monthly on the 1st at 09:30. The cron reads the secret from Vault. It runs twice cleanly on a local Postgres 17.
- **Tests:** 545. tsc, build, sync-edge, `deno check` and gitleaks (no leaks) pass. A Sonnet review found six issues and a browser test found two (monthly votes always 0; old tapes stuck on the weekly shelf). All are fixed.
- **Browser-verified locally** (mocked APIs):
  - both shelves render;
  - the admin login, paste, approve (the tape appears live) and reject;
  - spend, runs, and config with validation;
  - the cron routes refuse requests without the secret.
- **Known small gaps:** the clerk's "go to aisle" for an old repo tape still points at New Releases. The batch reservation is all-or-nothing. In-memory rate limits are per isolate.

### Everything Luis does by hand, in order (all phases)
1. **Database:** apply migrations `003_clerk.sql`, then `004_chat.sql`, then `005_sources.sql` (SQL editor, or `supabase link` + `db push`). The new code refuses AI calls until 003 exists.
2. **Secrets** (in your own terminal, never in chat):
   `npx supabase secrets set GITHUB_TOKEN=github_pat_... AI_DAILY_BUDGET_USD=3 AI_ASSESS_BUDGET_USD=1.5 ADMIN_TOKEN=$(openssl rand -hex 32) YOUTUBE_API_KEY=... --project-ref onovfynfxuemvsrdetez`
   - `GITHUB_TOKEN`: fine-grained, Public repositories, no permissions.
   - `YOUTUBE_API_KEY`: Google Cloud → enable YouTube Data API v3 → API key restricted to that API. Optional; without it YouTube is skipped.
   - Save the ADMIN_TOKEN in your password manager.
3. **Cron secret in Vault** (SQL editor, once): `select vault.create_secret('<CRON_SECRET>', 'rewind_cron_secret');`
4. **Optional, for GitHub sign-in:**
   - create a GitHub OAuth App with callback `https://onovfynfxuemvsrdetez.supabase.co/auth/v1/callback`;
   - turn on the GitHub provider in Supabase and add the site and localhost to the redirect allow-list;
   - build the site with `VITE_GITHUB_SIGNIN=1`.
5. **Merge** PR #1, then #2, #3 and the Phase 3 PR, retargeting each to `main`. CI is green on all of them.
6. **Deploy** when you say so: `npm run deploy:api`, then `npm run deploy:site`. Afterwards, confirm on one request which header carries the visitor IP (`clientKey`).

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
