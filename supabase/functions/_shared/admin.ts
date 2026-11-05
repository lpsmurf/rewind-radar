import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.ts';

let c: SupabaseClient | null = null;
/** Service-role client. Server-side only (lib/routes.ts, scripts/*). */
export function admin(): SupabaseClient {
  if (!c) {
    const url = env('SUPABASE_URL') || env('VITE_SUPABASE_URL');
    // SERVICE_KEY is our own secret on Supabase Edge; SUPABASE_SERVICE_ROLE_KEY locally / injected by Supabase.
    const key = env('SERVICE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('Supabase server environment is not configured');
    c = createClient(url, key, { auth: { persistSession: false } });
  }
  return c;
}
