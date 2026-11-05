#!/usr/bin/env bash
# Copy the shared server code into the Edge Function bundle (Supabase bundles only supabase/functions/*).
set -euo pipefail
cd "$(dirname "$0")/.."
D=supabase/functions/_shared
rm -rf "$D" && mkdir -p "$D/sources"
cp lib/env.ts lib/admin.ts lib/ai.ts lib/github.ts lib/assess.ts lib/catalog.ts lib/chatGuard.ts lib/clerkGuard.ts lib/identity.ts lib/radar.ts lib/routes.ts "$D/"
# lib/sources/*: list every file here; a missing one fails the deno check
cp lib/sources/types.ts lib/sources/verify.ts lib/sources/pipeline.ts lib/sources/index.ts lib/sources/stock.ts lib/sources/youtube.ts lib/sources/web.ts "$D/sources/"
cp src/types.ts "$D/types.ts"
# lib/sources/*.ts import '../x.ts', which resolves the same way from _shared/sources/
perl -pi -e "s#'\.\./src/types\.ts'#'./types.ts'#g" "$D"/*.ts
echo "synced $(find $D -name '*.ts' | wc -l | tr -d ' ') files to $D"
