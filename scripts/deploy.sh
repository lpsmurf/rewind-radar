#!/usr/bin/env bash
# One-click deploy: links the Vercel project, copies .env.local keys into Vercel (production), deploys.
set -euo pipefail
cd "$(dirname "$0")/.."
vercel whoami >/dev/null 2>&1 || vercel login
vercel link --yes --project rewind-radar >/dev/null
grep -q '^CRON_SECRET=.\+' .env.local || sed -i '' "s#^CRON_SECRET=.*#CRON_SECRET=$(openssl rand -hex 16)#" .env.local
for k in VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY ANTHROPIC_API_KEY CRON_SECRET; do
  v=$(grep -E "^$k=" .env.local | head -1 | cut -d= -f2-)
  [ -z "$v" ] && { echo "skip $k (empty)"; continue; }
  vercel env rm "$k" production -y >/dev/null 2>&1 || true
  printf '%s' "$v" | vercel env add "$k" production >/dev/null && echo "set $k"
done
vercel deploy --prod --yes
