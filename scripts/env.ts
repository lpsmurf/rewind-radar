// Minimal .env.local loader for local scripts (values are never printed).
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
try {
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {
  console.error('No .env.local found — copy .env.example and fill it in.');
  process.exit(1);
}
if (!process.env.GITHUB_TOKEN) {
  try { process.env.GITHUB_TOKEN = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
}
for (const k of ['VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY']) {
  if (!process.env[k]) { console.error(`Missing ${k} in .env.local`); process.exit(1); }
}
