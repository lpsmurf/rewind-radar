import { describe, expect, it } from 'vitest';
import { adminHeaders, safeHref, formatUsd, isAdminHash, isChannelId, failedLines, linesOf, pastedUrls, repoKey, stockLines, stockStatusLabel, stockSummary, spendTable, shortDate, runBackfill, backfillLine, type WatchRunResult, type BackfillTotals } from '../src/lib/adminPanel.ts';

describe('isAdminHash', () => {
  it('matches #admin only', () => {
    expect(isAdminHash('#admin')).toBe(true);
    expect(isAdminHash('#/admin')).toBe(true);
    expect(isAdminHash('#administrator')).toBe(false);
    expect(isAdminHash('#adm')).toBe(false);
    expect(isAdminHash('')).toBe(false);
  });
});

describe('formatUsd', () => {
  it('shows cents, and four places for tiny amounts', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd('0.02')).toBe('$0.02');
    expect(formatUsd(null)).toBe('$0.00');
  });
});

describe('pastedUrls', () => {
  it('splits on whitespace and commas, drops blanks and duplicates, keeps at most 20', () => {
    expect(pastedUrls('https://github.com/a/b, https://github.com/c/d\n\n  https://github.com/a/b ')).toEqual(['https://github.com/a/b', 'https://github.com/c/d']);
    expect(pastedUrls('')).toEqual([]);
    expect(pastedUrls(Array.from({ length: 30 }, (_, i) => `a/r${i}`).join('\n'))).toHaveLength(20);
  });
});

describe('spendTable', () => {
  const rows = [
    { day: '2026-11-05', route: 'radar', calls: 3, cost_usd: 0.02 },
    { day: '2026-11-05', route: 'source:web', calls: 1, cost_usd: '0.3' },
    { day: '2026-11-04', route: 'radar', calls: 2, cost_usd: 0.01 },
  ];
  it('groups by day, newest first, with a total per day and across all days', () => {
    const t = spendTable(rows);
    expect(t.days.map((d) => d.day)).toEqual(['2026-11-05', '2026-11-04']);
    expect(t.days[0].total).toBeCloseTo(0.32);
    expect(t.days[0].routes).toEqual([{ route: 'radar', calls: 3, cost: 0.02 }, { route: 'source:web', calls: 1, cost: 0.3 }]);
    expect(t.total).toBeCloseTo(0.33);
  });
  it('is empty for no rows', () => {
    expect(spendTable([])).toEqual({ days: [], total: 0 });
  });
});

describe('adminHeaders and shortDate', () => {
  it('sends the token as x-admin-token', () => {
    expect(adminHeaders('abc')).toEqual({ 'x-admin-token': 'abc' });
  });
  it('formats an ISO time as UTC date and time, tolerating junk', () => {
    expect(shortDate('2026-11-04T09:03:55Z')).toBe('2026-11-04 09:03');
    expect(shortDate('')).toBe('');
    expect(shortDate('nope')).toBe('nope');
  });
});

describe('linesOf', () => {
  it('splits a textarea into trimmed lines without blanks or repeats', () => {
    expect(linesOf(' a b \n\nc\r\na b\n')).toEqual(['a b', 'c']);
    expect(linesOf('')).toEqual([]);
  });
});

describe('isChannelId', () => {
  it('accepts UC plus 22 id characters only', () => {
    expect(isChannelId('UC' + 'a'.repeat(22))).toBe(true);
    expect(isChannelId('UC_-' + 'a'.repeat(20))).toBe(true);
    expect(isChannelId('UC' + 'a'.repeat(21))).toBe(false);
    expect(isChannelId('XX' + 'a'.repeat(22))).toBe(false);
    expect(isChannelId('UC' + 'a'.repeat(22) + '\n')).toBe(false);
  });
});

describe('safeHref', () => {
  it('passes http and https links through', () => {
    expect(safeHref('https://youtu.be/x')).toBe('https://youtu.be/x');
    expect(safeHref('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
    expect(safeHref('HTTPS://EXAMPLE.COM')).toBe('HTTPS://EXAMPLE.COM');
  });
  it('refuses everything else, so a credit can never become a javascript: link', () => {
    for (const u of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'ftp://x', 'youtu.be/x', 'https:/x', '', null, undefined]) {
      expect(safeHref(u as any), String(u)).toBeNull();
    }
  });
});

describe('repoKey', () => {
  it('reads a github.com link or a bare owner/repo, case-insensitively, and nothing else', () => {
    expect(repoKey('https://github.com/Acme/Widget')).toBe('acme/widget');
    expect(repoKey('github.com/acme/widget.git')).toBe('acme/widget');
    expect(repoKey('  acme/widget ')).toBe('acme/widget');
    expect(repoKey('not a link')).toBeNull();
    expect(repoKey('https://example.com/a/b')).toBeNull();
  });
});

describe('stockLines', () => {
  it('keeps one trimmed line per row, drops blanks, and drops repeats of the same repo however it is written', () => {
    const text = ' acme/widget \n\nhttps://github.com/ACME/Widget\r\nacme/gadget\nnope\nNOPE';
    expect(stockLines(text)).toEqual(['acme/widget', 'acme/gadget', 'nope']);
    expect(stockLines('')).toEqual([]);
  });
  it('does not cap: the panel shows the 20 limit itself', () => {
    expect(stockLines(Array.from({ length: 25 }, (_, i) => `a/r${i}`).join('\n'))).toHaveLength(25);
  });
});

describe('stockStatusLabel', () => {
  it('uses plain words for every status', () => {
    expect(['added', 'restored', 'duplicate', 'not_found', 'invalid', 'error'].map(stockStatusLabel)).toEqual(['ADDED', 'RESTORED', 'ALREADY IN STORE', 'NOT FOUND', 'INVALID', 'ERROR']);
    expect(stockStatusLabel('???')).toBe('ERROR');
  });
});

describe('failedLines and stockSummary', () => {
  const results = [
    { input: 'a/ok', status: 'added' },
    { input: 'a/back', status: 'restored' },
    { input: 'a/have', status: 'duplicate' },
    { input: 'a/ghost', status: 'not_found' },
    { input: 'garbage', status: 'invalid' },
    { input: 'a/flaky', status: 'error' },
  ];
  it('keeps only the lines that failed (not found, invalid, error), so they can be fixed and retried', () => {
    expect(failedLines(results)).toEqual(['a/ghost', 'garbage', 'a/flaky']);
    expect(failedLines([])).toEqual([]);
  });
  it('summarises added and skipped', () => {
    expect(stockSummary({ added: 7, skipped: 3 })).toBe('Added 7 · skipped 3');
  });
});

describe('runBackfill', () => {
  const res = (o: Partial<WatchRunResult> = {}): WatchRunResult => ({ videos_checked: 10, added: 0, restored: 0, duplicates: 0, errors: 0, remaining: 0, ...o });
  const run = (results: (WatchRunResult | Error)[], o: Partial<Parameters<typeof runBackfill>[0]> = {}) => {
    const days: number[] = [];
    const progress: BackfillTotals[] = [];
    const sleeps: number[] = [];
    let i = 0;
    const p = runBackfill({
      days: 120,
      call: async (d) => {
        days.push(d);
        const r = results[Math.min(i++, results.length - 1)];
        if (r instanceof Error) throw r;
        return r;
      },
      onProgress: (t) => progress.push(t),
      sleep: async (ms) => void sleeps.push(ms),
      ...o,
    });
    return { p, days, progress, sleeps };
  };

  it('stops at remaining 0 and sends the days each call', async () => {
    const x = run([res({ remaining: 20 }), res({ remaining: 10 }), res({ remaining: 0 })]);
    const r = await x.p;
    expect(r.stop).toBe('done');
    expect(r.totals.calls).toBe(3);
    expect(x.days).toEqual([120, 120, 120]);
    expect(x.sleeps).toHaveLength(2);
  });

  it('accumulates totals and reports live progress', async () => {
    const x = run([res({ added: 6, duplicates: 3, restored: 1, remaining: 7 }), res({ added: 4, duplicates: 2, errors: 1, remaining: 0 })]);
    const r = await x.p;
    expect(r.totals).toMatchObject({ added: 10, duplicates: 5, restored: 1, errors: 1, videos: 20, remaining: 0 });
    expect(x.progress.map((t) => t.remaining)).toEqual([7, 0]);
    expect(backfillLine(x.progress[0])).toBe('videos left: 7 · added 6 · already in store 3 · restored 1');
  });

  it('stops on an error and says why', async () => {
    const r = await run([res({ remaining: 5, added: 2 }), new Error('Error 503')]).p;
    expect(r).toMatchObject({ stop: 'error', reason: 'Error 503' });
    expect(r.totals.added).toBe(2);
  });

  it('stops when the watcher reports a skip (budget)', async () => {
    const r = await run([res({ remaining: 5, skipped: 'AI budget spent, will retry' })]).p;
    expect(r).toMatchObject({ stop: 'skipped', reason: 'AI budget spent, will retry' });
  });

  it('stops at the call limit', async () => {
    const x = run([res({ remaining: 99 })]);
    const r = await x.p;
    expect(r.stop).toBe('limit');
    expect(r.totals.calls).toBe(30);
    expect(x.days).toHaveLength(30);
  });

  it('stops when a call makes no progress', async () => {
    const r = await run([res({ videos_checked: 0, remaining: 2 })]).p;
    expect(r.stop).toBe('stalled');
    expect(r.totals.calls).toBe(1);
  });

  it('stops when cancelled', async () => {
    let n = 0;
    const r = await run([res({ remaining: 99 })], { cancelled: () => n++ >= 2 }).p;
    expect(r).toMatchObject({ stop: 'cancelled' });
    expect(r.totals.calls).toBe(2);
  });
});
