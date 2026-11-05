#!/usr/bin/env bash
# One-time Supabase setup for Rewind Radar: sign in, store secrets, deploy the "api" Edge Function.
# Your keys go from .env.local straight to Supabase; nothing is printed.
set -euo pipefail
cd "$(dirname "$0")/.."
REF=onovfynfxuemvsrdetez
SB="npx -y supabase@latest"

echo "== 1/3 Sign in to Supabase (a browser window opens; approve, then paste the code here if asked)"
$SB projects list >/dev/null 2>&1 || $SB login

echo "== 2/3 Saving secrets to Supabase"
grep -q '^CRON_SECRET=.\+' .env.local || sed -i '' "s#^CRON_SECRET=.*#CRON_SECRET=$(openssl rand -hex 16)#" .env.local
get() { grep -E "^$1=" .env.local | head -1 | cut -d= -f2-; }
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
printf 'ANTHROPIC_API_KEY=%s\nSERVICE_KEY=%s\nCRON_SECRET=%s\n' "$(get ANTHROPIC_API_KEY)" "$(get SUPABASE_SERVICE_ROLE_KEY)" "$(get CRON_SECRET)" > "$tmp"
$SB secrets set --env-file "$tmp" --project-ref "$REF"

echo "== 3/3 Deploying the api Edge Function"
scripts/sync-edge.sh
$SB functions deploy api --project-ref "$REF" --no-verify-jwt --use-api
echo "✅ Supabase backend is live: https://$REF.supabase.co/functions/v1/api"
