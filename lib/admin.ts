import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';

let c: SupabaseClient | null = null;
/** Service-role client. Server-side only (api/*, scripts/*). */
export function admin(): SupabaseClient {
  if (!c) {
    const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Supabase server environment is not configured');
    // Node < 22 has no native WebSocket; supabase-js needs one even if we never subscribe.
    c = createClient(url, key, { auth: { persistSession: false }, realtime: { transport: ws as any } });
  }
  return c;
}
