#!/usr/bin/env bash
# Deploy the backend (Supabase Edge Function "api"). Needs: `npx supabase login` once on this machine.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/sync-edge.sh
npx -y supabase@latest functions deploy api --project-ref onovfynfxuemvsrdetez --no-verify-jwt --use-api --yes
echo "✅ API live: https://onovfynfxuemvsrdetez.supabase.co/functions/v1/api"
