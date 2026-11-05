// Decide whether a skill is ours (republish full text) or third-party (link to the original).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OWN = new Set<string>(JSON.parse(readFileSync(new URL('./own-skills.json', import.meta.url), 'utf8')).own);
const lockPath = join(homedir(), '.agents', '.skill-lock.json');
const LOCK: Record<string, { source: string; sourceUrl: string }> = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')).skills : {};
const ECC = new Set(['context-budget', 'iterative-retrieval', 'unified-memory']);
const MATT = new Set(['tdd', 'diagnosing-bugs', 'domain-modeling', 'prd-to-plan', 'prd-to-issues', 'write-a-prd', 'grill-with-docs', 'setup-pre-commit']);

export interface Provenance { own: boolean; author: string | null; url: string }

export function provenance(slug: string, md: string): Provenance {
  if (OWN.has(slug)) return { own: true, author: 'lpsmurf', url: '' };
  const fm = md.startsWith('---') ? md.split('---')[1] ?? '' : '';
  const field = (k: string) =>
    (fm.match(new RegExp(`^\\s*"?${k}"?\\s*:\\s*"?([^"\\n,}]+)`, 'm')) ?? fm.match(new RegExp(`"${k}"\\s*:\\s*"([^"]+)"`)))?.[1]?.trim() ?? '';
  let author = field('author');
  let url = '';
  if (LOCK[slug]) { url = LOCK[slug].sourceUrl.replace(/\.git$/, ''); author ||= LOCK[slug].source.split('/')[0]; }
  else if (ECC.has(slug)) { url = 'https://github.com/affaan-m/ECC'; author ||= 'affaan-m'; }
  else if (MATT.has(slug)) { url = 'https://github.com/mattpocock/skills'; author ||= 'mattpocock'; }
  else if (/^https?:\/\//.test(field('source'))) url = field('source');
  else if (/^https?:\/\//.test(field('homepage'))) url = field('homepage');
  if (!author && url) author = url.match(/github\.com\/([^/]+)/)?.[1] ?? '';
  // Unknown origin: send people to GitHub's search for the original SKILL.md instead of copying it.
  if (!url) url = `https://github.com/search?q=${encodeURIComponent(`"name: ${slug}" path:SKILL.md`)}&type=code`;
  return { own: false, author: author || null, url };
}
