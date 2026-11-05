import './env';
import { admin } from '../lib/admin';
(async () => {
  const db = admin();
  for (const k of ['skill', 'repo', 'community']) {
    const live = await db.from('tapes').select('id', { count: 'exact', head: true }).eq('kind', k).eq('archived', false);
    const old = await db.from('tapes').select('id', { count: 'exact', head: true }).eq('kind', k).eq('archived', true);
    console.log(`${k.padEnd(10)} on shelves: ${live.count}   retired: ${old.count}`);
  }
  const runs = await db.from('radar_runs').select('ran_at,stocked').order('ran_at', { ascending: false }).limit(3);
  console.log('radar runs:', JSON.stringify(runs.data));
  const p = await db.from('proposals').select('id', { count: 'exact', head: true });
  console.log('proposals:', p.count);
})();
