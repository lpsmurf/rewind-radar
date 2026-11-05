/** Read an env var in Node (process.env) or Deno/Supabase Edge (Deno.env). */
export function env(k: string): string | undefined {
  const d = (globalThis as any).Deno;
  if (d?.env?.get) return d.env.get(k) ?? undefined;
  return (globalThis as any).process?.env?.[k];
}
