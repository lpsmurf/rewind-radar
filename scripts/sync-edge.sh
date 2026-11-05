#!/usr/bin/env bash
# Copy the shared server code into the Edge Function bundle (Supabase bundles only supabase/functions/*).
set -euo pipefail
cd "$(dirname "$0")/.."
D=supabase/functions/_shared
rm -rf "$D" && mkdir -p "$D"
cp lib/env.ts lib/admin.ts lib/ai.ts lib/github.ts lib/radar.ts lib/routes.ts "$D/"
cp src/types.ts "$D/types.ts"
sed -i '' "s#'../src/types.ts'#'./types.ts'#" "$D/ai.ts"
echo "synced $(ls $D | wc -l | tr -d ' ') files to $D"
