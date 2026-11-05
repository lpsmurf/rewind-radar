/**
 * A tiny stand-in for the supabase-js query builder. Every chained call is recorded; when the query is
 * awaited, the handler registered for its table (or `rpc:<name>`) decides the result.
 */
export type Call = [string, ...unknown[]];
export interface Query { table: string; calls: Call[] }
export type Result = { data: unknown; error: { code?: string; message?: string } | null };
type Handler = (q: Query) => Result | Promise<Result>;

const CHAIN = [
  'select', 'insert', 'upsert', 'update', 'delete', 'eq', 'neq', 'in', 'not', 'is', 'gt', 'gte', 'lt', 'lte',
  'ilike', 'like', 'or', 'order', 'limit', 'range', 'maybeSingle', 'single',
];

export function fakeDb(handlers: Record<string, Handler> = {}) {
  const queries: Query[] = [];
  const run = (q: Query): Promise<Result> =>
    Promise.resolve((handlers[q.table] ?? (() => ({ data: null, error: null })))(q));

  function builder(table: string) {
    const q: Query = { table, calls: [] };
    queries.push(q);
    const b: Record<string, unknown> = {};
    for (const m of CHAIN) b[m] = (...args: unknown[]) => (q.calls.push([m, ...args]), b);
    b.then = (ok: (r: Result) => unknown, bad?: (e: unknown) => unknown) => run(q).then(ok, bad);
    return b as any;
  }

  return {
    queries,
    on(table: string, h: Handler) {
      handlers[table] = h;
    },
    /** Queries against one table (or `rpc:<name>`). */
    calls(table: string) {
      return queries.filter((q) => q.table === table);
    },
    client: {
      from: (table: string) => builder(table),
      rpc: (name: string, args?: unknown) => {
        const q: Query = { table: 'rpc:' + name, calls: [['args', args]] };
        queries.push(q);
        return run(q);
      },
    } as any,
  };
}

/** The value passed to a recorded call, e.g. arg(q, 'insert'). */
export function arg(q: Query, method: string, i = 0): any {
  return q.calls.find((c) => c[0] === method)?.[i + 1];
}
export function has(q: Query, method: string, ...args: unknown[]): boolean {
  return q.calls.some((c) => c[0] === method && args.every((a, i) => JSON.stringify(c[i + 1]) === JSON.stringify(a)));
}

/**
 * The ai_usage table as the reserve-then-check code sees it: an insert (`.select('id').single()`) returns the
 * reservation id, a plain select returns `rows` (or an error), update/delete succeed.
 */
export function usageTable(rows: unknown[] | 'error' = [], o: { insertError?: boolean } = {}) {
  return (q: Query): Result => {
    if (has(q, 'insert')) return o.insertError ? { data: null, error: { message: 'boom' } } : { data: { id: 900 }, error: null };
    if (has(q, 'select')) return rows === 'error' ? { data: null, error: { message: 'boom' } } : { data: rows, error: null };
    return { data: null, error: null };
  };
}
