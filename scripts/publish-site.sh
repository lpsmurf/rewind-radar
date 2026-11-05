#!/usr/bin/env bash
# Build the site and publish it to GitHub Pages (gh-pages branch). Needs: .env.local + gh auth.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run -s build
if grep -rlE 'sk-ant-[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{10,}' dist >/dev/null; then echo "❌ secret found in dist — aborting"; exit 1; fi
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp -R dist/. "$tmp"/ && touch "$tmp/.nojekyll" && cp "$tmp/index.html" "$tmp/404.html"
cd "$tmp"
git init -q -b gh-pages && git add -A
git -c user.name=lpsmurf -c user.email=littleplu@gmail.com commit -qm "Publish site $(date -u +%Y-%m-%dT%H:%MZ)"
git push -qf https://github.com/lpsmurf/rewind-radar.git gh-pages
echo "✅ Site published: https://lpsmurf.github.io/rewind-radar/ (GitHub Pages rebuilds in ~1 min)"
