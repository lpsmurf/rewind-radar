import './env';
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { admin } from '../lib/admin';
import { classifySkill } from '../lib/ai';
import { pool } from '../lib/radar';

// Usage: npm run seed:skills [-- --approve=slug1,slug2]
const approve = new Set(
  (process.argv.find((a) => a.startsWith('--approve=')) ?? '').replace('--approve=', '').split(',').filter(Boolean),
);
const dir = join(homedir(), '.claude', 'skills');

function frontmatter(md: string): { name?: string; description?: string; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: md };
  const get = (k: string) => m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '').trim();
  return { name: get('name'), description: get('description'), body: m[2] };
}

async function main() {
  const skills = readdirSync(dir)
    .map((d) => ({ slug: d.toLowerCase(), file: join(dir, d, 'SKILL.md') }))
    .filter((s) => existsSync(s.file));
  console.log(`Shelving ${skills.length} skills with Claude Haiku...`);

  const results = await pool(skills, 8, async (s) => {
    const md = readFileSync(s.file, 'utf8');
    const fm = frontmatter(md);
    try {
      const r = await classifySkill(fm.name ?? s.slug, fm.description ?? '', fm.body);
      return { ...s, md, title: fm.name ?? s.slug, r };
    } catch (e: any) {
      return { ...s, md, title: fm.name ?? s.slug, err: String(e.message ?? e) };
    }
  });

  const held: any[] = [];
  const rows: any[] = [];
  for (const x of results) {
    if ('err' in x) { held.push({ slug: x.slug, error: x.err }); continue; }
    const needsReview = x.r.privacy_flags.length > 0 || x.r.trust === 'flagged';
    if (needsReview && !approve.has(x.slug)) {
      held.push({ slug: x.slug, trust: x.r.trust, trust_reasons: x.r.trust_reasons, privacy_flags: x.r.privacy_flags });
      continue;
    }
    rows.push({
      kind: 'skill', slug: x.slug, title: x.title, genre: x.r.genre, blurb: x.r.blurb,
      body_md: x.md, trust: x.r.trust, source_url: null,
    });
  }

  mkdirSync('seed', { recursive: true });
  writeFileSync('seed/review.json', JSON.stringify({ published: rows.length, held }, null, 2));
  for (let i = 0; i < rows.length; i += 50) {
    const { error } = await admin().from('tapes').upsert(rows.slice(i, i + 50), { onConflict: 'slug' });
    if (error) throw new Error(error.message);
  }
  console.log(`Published ${rows.length} skills. Held ${held.length} for review → seed/review.json`);
  for (const h of held) console.log(`  HELD ${h.slug}: ${(h.privacy_flags ?? []).join('; ') || h.error || (h.trust_reasons ?? []).join('; ')}`);
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
