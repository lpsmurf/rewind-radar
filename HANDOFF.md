# Handoff — Rewind Radar Video

## ▶ Next session starts here (2026-11-05, work Mac mini → Claude Code on API billing)
The plan is in **docs/ROADMAP.md** (approved by Luis). It has six phases:
1. clerk guardrails and repo assessment;
2. live store: movement sync, chat, arcade "opening soon";
3. auto-filled weekly/monthly shelves from GitHub, YouTube and X;
4. GitHub sign-in membership;
5. Study Room;
6. Hall of Fame and Candy Stand.

### Phase 1 status: code done on branch `feat/clerk-assess` (commit 1ee1f98), not merged, not deployed
- **What it does:**
  - A GitHub repo pasted into the clerk gets an assessment card. Sonnet 5.5 writes it as structured output and it is cached for 7 days.
  - With a scanned GitHub username, the card adds a personal FIT check (Haiku).
  - Ordinary questions run on Haiku 5.5 with an `on_topic` guardrail over full-text-search candidates.
  - Spend is metered in `ai_usage` against `AI_DAILY_BUDGET_USD` (default $5/day). Over budget, the clerk answers from search only.
- **Code:**
  - new `lib/assess.ts`, `lib/catalog.ts`, `lib/clerkGuard.ts` and `src/ui/AssessmentCard.tsx`;
  - changed `lib/ai.ts`, `lib/github.ts`, `lib/routes.ts`, `ClerkDrawer`, `useStore` and `SubmitModal` (it takes `initial`).
- **Tests:** `npm test` (Vitest, 79 tests; Anthropic, GitHub and Supabase are mocked, and any unmocked fetch throws). The tests live in `test/`; shared data is in `test/helpers/samples.ts`. Never import from another `*.test.ts`.
- **CI:** `.github/workflows/ci.yml` runs typecheck, test, build, sync-edge and `deno check`.
- **Verified:**
  - tsc, build, sync-edge and `deno check` pass.
  - Live in the dev server, the Postiz URL gives TRIAL at 0.8 confidence with the AGPL gate, in 17 seconds.
  - Off-topic and "ignore your rules" questions get the in-character redirect; "diagrams" gets `diagram-design` (Haiku, about 2 seconds).
- **Still to do for Phase 1 (in order):**
  1. Act on the code-review findings below.
  2. Luis applies `supabase/migrations/003_clerk.sql`, through the SQL editor or `supabase link --project-ref onovfynfxuemvsrdetez` + `supabase db push`. Until then the app runs without cache or meter, and logs `[budget] spend meter unavailable`.
  3. Luis sets the secrets: `npx supabase secrets set GITHUB_TOKEN=<fine-grained read-only public repos> AI_DAILY_BUDGET_USD=5 --project-ref onovfynfxuemvsrdetez`.
  4. Re-verify in the dev server: a second Postiz ask is served from cache, there is an `ai_usage` row, and a FIT appears after scanning `lpsmurf`.
  5. Push the branch, open the PR, and wait for green CI.
  6. Deploy (`npm run deploy:api`, `npm run deploy:site`) **only when Luis says so**.
- **Optional:** add `scripts/eval-clerk.ts`, about 30 labelled on/off-topic questions run against the real API. It costs cents and needs Luis's OK. Use it before switching `ASSESS_MODEL` to Haiku.

### Code-review findings to fix before the PR (Sonnet review, 2026-11-05, most severe first)
Already fixed: `search_tapes` is no longer executable by anon/public (migration 003), and CI has `permissions: contents: read`.
The review also confirmed that migration 003 runs cleanly and idempotently on Postgres 17, that the tsquery cast is injection-safe, that the card has no XSS, and that the API request shape is valid.

1. **HIGH, budget bypass.**
   - `/profile` runs Sonnet over 400 tapes with no `budgetLeft()` check and no `recordUsage()`. `/submit` and `/propose` (Haiku) and `radar/refresh` aren't metered either.
   - Fix: gate and meter every route that calls Anthropic, using the `meter()`/`recordUsage` pattern from the clerk route.
2. **HIGH, spoofable rate limits.**
   - `who = body.visitorId ?? ip`, so a fresh visitorId gets a fresh bucket.
   - The counters live in memory per Edge isolate, the Map never shrinks, and keys have no length limit.
   - Fix: key limits on the client IP (last `x-forwarded-for` hop) and truncate keys.
   - Count Sonnet assessments per hour in the database (`ai_usage` rows), and give them their own smaller budget (`AI_ASSESS_BUDGET_USD`), so one attacker can't push the whole clerk into free mode.
3. **MEDIUM, failed calls aren't metered.**
   - `structured()` throws `AssessError` on refusal, `max_tokens` or bad JSON, and the usage is lost.
   - Fix: attach `usage` to `AssessError` and record it in the `getAssessment` catch. Optionally cache the failure for a few minutes.
4. **MEDIUM, fail-open.**
   - `budgetLeft()` returns true when the meter is missing, and an error on the `assessments` select counts as a cache miss.
   - Fix: fail closed on the Sonnet paths (an rpc error counts as over budget), and throw when the select errors. Apply migration 003 **before** deploying this code.
5. **MEDIUM, persuasive READMEs.**
   - Fix: clamp the ring in code from `HealthSignals` (archived → hold; no licence or more than a year since the last push → at most trial).
   - Wrap the README in its own delimiter, so it can't forge the `HEALTH SIGNALS` or `STORE CANDIDATES` lines.
   - Label `steps` on the card as "from the README, unverified".
6. **MEDIUM-LOW, bare `owner/repo`.**
   - "tcp/ip"-style questions use up the assess quota, and in free or rate-limited mode return 429 or budget messages instead of an answer.
   - Fix: for `ref.bare`, check that the repo exists first (or that it's in `tapes`/`assessments`), and never throw for a bare ref; fall back to the ask path.
7. **LOW, expired row + rate limit.** This returns 429 instead of the stale row; the comment in `lib/assess.ts` says it should serve stale. Fix: serve stale when the row exists.
8. **Notes:**
   - `GITHUB_TOKEN` must be public-repo read-only, because results are cached publicly.
   - `PRICES` only knows Haiku and Sonnet. Add any model set in `CLERK_MODEL`/`ASSESS_MODEL`.
   - Add tests for every one of the above. That's TDD: red first.

Suggested split: give items 1, 2, 4, 6 and 7 to one Sonnet implementer (routes and assess) and items 3 and 5 to another (ai and assess prompt). Their files overlap in `lib/assess.ts`, so run them one after the other, not in parallel. Then a Haiku QA pass and a Sonnet review.

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
