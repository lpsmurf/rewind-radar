// One-off + repeatable: strip third-party skill text from the store and record its source + author.
import './env';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { admin } from '../lib/admin';
import { provenance } from './provenance';

(async () => {
  const db = admin();
  const { data, error } = await db.from('tapes').select('id,slug').eq('kind', 'skill');
  if (error) throw new Error(error.message);
  let own = 0, linked = 0, missing = 0;
  for (const t of data ?? []) {
    const f = join(homedir(), '.claude', 'skills', t.slug, 'SKILL.md');
    if (!existsSync(f)) { missing++; continue; }
    const md = readFileSync(f, 'utf8');
    const p = provenance(t.slug, md);
    const patch = p.own
      ? { body_md: md, source_url: null, submitter: 'lpsmurf' }
      : { body_md: null, source_url: p.url, submitter: p.author };
    const r = await db.from('tapes').update(patch).eq('id', t.id);
    if (r.error) throw new Error(r.error.message);
    p.own ? own++ : linked++;
  }
  console.log(`own (full text kept): ${own}   third-party (text removed, linked to source): ${linked}   no local file: ${missing}`);
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
