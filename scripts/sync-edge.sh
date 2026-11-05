#!/usr/bin/env bash
# Copy the shared server code into the Edge Function bundle (Supabase bundles only supabase/functions/*).
set -euo pipefail
cd "$(dirname "$0")/.."
D=supabase/functions/_shared
rm -rf "$D" && mkdir -p "$D/sources"
cp lib/env.ts lib/admin.ts lib/ai.ts lib/github.ts lib/assess.ts lib/catalog.ts lib/chatGuard.ts lib/clerkGuard.ts lib/identity.ts lib/radar.ts lib/routes.ts "$D/"
# lib/sources/*: one file each so a new source cannot be forgotten silently (it fails the deno check instead)
cp lib/sources/types.ts lib/sources/verify.ts lib/sources/pipeline.ts lib/sources/index.ts "$D/sources/"
cp src/types.ts "$D/types.ts"
# lib/*.ts import '../src/types.ts'; lib/sources/*.ts import '../x.ts' (-> '../x.ts' is unchanged: sources sits one level below _shared, as lib/sources sits below lib)
perl -pi -e "s#'\.\./src/types\.ts'#'./types.ts'#g" "$D"/*.ts
echo "synced $(find $D -name '*.ts' | wc -l | tr -d ' ') files to $D"
