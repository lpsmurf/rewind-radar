import './env';
import { admin } from '../lib/admin';
(async () => {
  for (const k of ['skill', 'repo', 'community']) {
    const r = await admin().from('tapes').select('id', { count: 'exact', head: true }).eq('kind', k);
    console.log(`${k.padEnd(10)} tapes: ${r.count ?? r.error?.message}`);
  }
  const v = await admin().from('votes').select('*', { count: 'exact', head: true });
  const r = await admin().from('rentals').select('*', { count: 'exact', head: true });
  console.log(`votes: ${v.count}   rentals: ${r.count}`);
})();
