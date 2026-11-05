import './env';
import { admin } from '../lib/admin';
(async () => {
  for (const t of ['tapes', 'votes', 'rentals', 'tape_votes']) {
    const r = await admin().from(t).select('*').limit(1);
    console.log(t.padEnd(11), r.error ? 'MISSING — ' + r.error.message : 'ok');
  }
})();
