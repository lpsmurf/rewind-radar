/** Backend base URL: Vite dev serves /api; production uses the Supabase Edge Function "api". */
export const API: string =
  import.meta.env.VITE_API_BASE ||
  (import.meta.env.DEV ? '/api' : `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api`);
/** Absolute form, for commands people paste into a terminal. */
export const API_ABS: string = API.startsWith('http') ? API : `${location.origin}${API}`;
