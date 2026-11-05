// Supabase Edge Function "api": all Rewind Radar backend routes (clerk, submit, tape, radar/refresh).
import { handle } from '../_shared/routes.ts';
Deno.serve(handle);
