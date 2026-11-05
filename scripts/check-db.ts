import './env';
import { admin } from '../lib/admin';
(async () => {
  for (const t of ['tapes', 'votes', 'rentals', 'tape_votes', 'radar_runs', 'proposals', 'proposal_votes']) {
    const r = await admin().from(t).select('*').limit(1);
    console.log(t.padEnd(15), r.error ? 'MISSING — ' + r.error.message : 'ok');
  }
  const a = await admin().from('tapes').select('archived').limit(1);
  console.log('tapes.archived ', a.error ? 'MISSING — ' + a.error.message : 'ok');
})();
