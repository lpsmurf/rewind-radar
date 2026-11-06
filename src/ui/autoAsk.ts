// The browser's ASSESS IT hands the clerk drawer a question. Pure decision: send it once, never while busy.
export interface AutoAsk { q: string; n: number }
export function autoAskAction(a: AutoAsk | null | undefined, lastSent: number, busy: boolean): 'send' | 'wait' | 'skip' {
  if (!a || a.n === lastSent) return 'skip';
  return busy ? 'wait' : 'send';
}
