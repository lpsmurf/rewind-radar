import './env';
import { refreshRadar } from '../lib/radar';

refreshRadar(20)
  .then((n) => console.log(`New Releases wall stocked with ${n} repos.`))
  .catch((e) => { console.error(e.message ?? e); process.exit(1); });
