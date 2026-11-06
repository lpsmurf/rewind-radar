import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../lib/api';
import { adminHeaders, formatUsd, channelEntries, CHANNEL_INPUT_HINT, failedLines, linesOf, pastedUrls, safeHref, shortDate, spendTable, stockLines, stockStatusLabel, stockSummary, watchSummaryLine, backfillLine, runBackfill, type SpendRow, type WatchRunResult } from '../lib/adminPanel';

const KEY = 'rr-admin-token'; // sessionStorage only: gone when the tab closes
type Tab = 'queue' | 'add' | 'spend' | 'runs' | 'config';
interface QueueItem { id: number; source: string; repo: string; title: string; why: string; credit_url: string; credit_title: string; credit_author: string; at: string; facts?: { stars?: number } | null }
interface Run { id: number; at: string; source: string; found: number; queued: number; cost_usd: number | string; error: string | null }

class Forbidden extends Error {}

async function api<T>(token: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const r = await fetch(`${API}/${path}`, {
    method,
    headers: { ...adminHeaders(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 403) throw new Forbidden('Wrong token');
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `Error ${r.status}`);
  return j as T;
}

export default function AdminPanel() {
  const [token, setToken] = useState(() => sessionStorage.getItem(KEY) ?? '');
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<Tab>('queue');
  const [err, setErr] = useState('');

  const signOut = (why = '') => {
    sessionStorage.removeItem(KEY);
    setToken('');
    setErr(why);
  };
  const fail = (e: unknown) => (e instanceof Forbidden ? signOut('Wrong token') : setErr(e instanceof Error ? e.message : 'Something went wrong'));

  if (!token) {
    return (
      <div className="admin">
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            sessionStorage.setItem(KEY, draft.trim());
            setToken(draft.trim());
            setErr('');
          }}
        >
          <h3>ADMIN</h3>
          <label>TOKEN<input type="password" autoComplete="off" value={draft} onChange={(e) => setDraft(e.target.value)} /></label>
          {err && <p className="err">{err}</p>}
          <button className="btn" disabled={!draft.trim()}>ENTER</button>
        </form>
      </div>
    );
  }
  return (
    <div className="admin">
      <header>
        <h1>ADMIN</h1>
        <div className="row">
          {(['queue', 'add', 'spend', 'runs', 'config'] as Tab[]).map((t) => (
            <button key={t} className={t === tab ? 'btn' : 'btn alt'} onClick={() => { setTab(t); setErr(''); }}>{t === 'add' ? 'ADD REPOS' : t.toUpperCase()}</button>
          ))}
          <button className="btn alt" onClick={() => signOut()}>SIGN OUT</button>
          <a className="btn alt" href="#">STORE</a>
        </div>
      </header>
      <main className="panel">
        {err && <p className="err">{err}</p>}
        {tab === 'queue' && <Queue token={token} fail={fail} />}
        {tab === 'add' && <AddRepos token={token} fail={fail} />}
        {tab === 'spend' && <Spend token={token} fail={fail} />}
        {tab === 'runs' && <Runs token={token} fail={fail} />}
        {tab === 'config' && <Config token={token} fail={fail} />}
      </main>
    </div>
  );
}

type TabProps = { token: string; fail: (e: unknown) => void };

/** Load once on mount and on demand. */
function useLoad<T>(token: string, path: string, fail: (e: unknown) => void) {
  const [data, setData] = useState<T | null>(null);
  const load = useCallback(() => {
    api<T>(token, path).then(setData, fail);
  }, [token, path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);
  return [data, load] as const;
}

function Queue({ token, fail }: TabProps) {
  const [data, load] = useLoad<{ items: QueueItem[] }>(token, 'admin/queue?status=pending', fail);
  const [busy, setBusy] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const act = async (id: number, what: 'approve' | 'reject') => {
    setBusy(id);
    setNote('');
    try {
      await api(token, `admin/queue/${id}/${what}`, {});
      setNote(what === 'approve' ? 'Stocked.' : 'Rejected.');
    } catch (e) {
      if (e instanceof Forbidden) fail(e);
      else setNote(e instanceof Error ? e.message : 'Failed');
    }
    setBusy(null);
    load();
  };
  if (!data) return <p className="small">Loading...</p>;
  return (
    <>
      <h3>PENDING ({data.items.length})</h3>
      {note && <p className="small">{note}</p>}
      {data.items.length === 0 && <p className="small">Nothing waiting.</p>}
      {data.items.map((it) => (
        <div className="admin-item" key={it.id}>
          <b><a href={`https://github.com/${it.repo}`} target="_blank" rel="noreferrer">{it.repo}</a></b>
          {it.facts?.stars != null && <span className="small"> ★ {it.facts.stars}</span>}
          <span className="small"> · {it.source} · {shortDate(it.at)}</span>
          {it.why && <p className="small">{it.why}</p>}
          {it.credit_url && (
            <p className="small">
              Featured in {safeHref(it.credit_url) ? <a href={safeHref(it.credit_url)!} target="_blank" rel="noreferrer">{it.credit_title || it.credit_url}</a> : <span>{it.credit_title || it.credit_url}</span>}
              {it.credit_author && ` by ${it.credit_author}`}
            </p>
          )}
          <div className="row">
            <button className="btn" disabled={busy === it.id} onClick={() => act(it.id, 'approve')}>APPROVE</button>
            <button className="btn alt" disabled={busy === it.id} onClick={() => act(it.id, 'reject')}>REJECT</button>
          </div>
        </div>
      ))}
    </>
  );
}

interface StockResult { input: string; repo?: string; status: string; slug?: string; genre?: string; message?: string }

function AddRepos({ token, fail }: TabProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [results, setResults] = useState<StockResult[]>([]);
  const lines = stockLines(text);
  const tooMany = lines.length > 20;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
    } catch (e) {
      if (e instanceof Forbidden) fail(e);
      else setMsg(e instanceof Error ? e.message : 'Failed');
    }
    setBusy(false);
  };
  const add = () =>
    run(async () => {
      const r = await api<{ results: StockResult[]; added: number; skipped: number }>(token, 'admin/stock', { urls: lines });
      setResults(r.results);
      setMsg(stockSummary(r));
      setText(failedLines(r.results).join('\n')); // only what failed stays, to fix and retry
    });
  const queue = () =>
    run(async () => {
      const urls = pastedUrls(text);
      const r = await api<{ found: number; queued: number; ignored: number }>(token, 'admin/paste', { urls });
      setResults([]);
      setMsg(`Found ${r.found}, queued ${r.queued} (already known or not on GitHub: ${r.found - r.queued}), ignored ${r.ignored} that were not repo links.`);
      setText('');
    });
  return (
    <>
      <h3>ADD REPOS</h3>
      <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'https://github.com/owner/repo\nowner/other-repo'} />
      <p className={tooMany ? 'err' : 'small'}>{lines.length} repo{lines.length === 1 ? '' : 's'} (max 20, one per line). Repeats are dropped. ADD puts new ones on the shelves now (a few cents of AI each); SEND TO QUEUE waits for your approval.</p>
      {msg && <p className="small">{msg}</p>}
      <div className="row">
        <button className="btn" disabled={busy || lines.length === 0 || tooMany} onClick={add}>{busy ? 'WORKING...' : 'ADD TO SHELVES'}</button>
        <button className="btn alt" disabled={busy || lines.length === 0 || tooMany} onClick={queue}>SEND TO QUEUE</button>
      </div>
      {results.length > 0 && (
        <table className="admin-table">
          <thead><tr><th>REPO</th><th>STATUS</th><th>GENRE</th></tr></thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={i}>
                <td>{r.repo ?? r.input}</td>
                <td><span className="badge" title={r.message}>{stockStatusLabel(r.status)}</span></td>
                <td>{r.status === 'added' || r.status === 'restored' ? r.genre ?? '' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Spend({ token, fail }: TabProps) {
  const [data] = useLoad<{ rows: SpendRow[] }>(token, 'admin/spend?days=14', fail);
  if (!data) return <p className="small">Loading...</p>;
  const t = spendTable(data.rows);
  return (
    <>
      <h3>SPEND, LAST 14 DAYS: {formatUsd(t.total)}</h3>
      {t.days.length === 0 && <p className="small">No AI calls yet.</p>}
      {t.days.length > 0 && (
        <table className="admin-table">
          <thead><tr><th>DAY</th><th>ROUTE</th><th>CALLS</th><th>COST</th></tr></thead>
          <tbody>
            {t.days.map((d) => [
              ...d.routes.map((r, i) => (
                <tr key={d.day + r.route}><td>{i === 0 ? d.day : ''}</td><td>{r.route}</td><td>{r.calls}</td><td>{formatUsd(r.cost)}</td></tr>
              )),
              <tr key={d.day + 'total'} className="tot"><td></td><td>DAY TOTAL</td><td></td><td>{formatUsd(d.total)}</td></tr>,
            ])}
          </tbody>
        </table>
      )}
    </>
  );
}

function Runs({ token, fail }: TabProps) {
  const [data] = useLoad<{ runs: Run[] }>(token, 'admin/runs', fail);
  if (!data) return <p className="small">Loading...</p>;
  return (
    <>
      <h3>LAST {data.runs.length} SOURCE RUNS</h3>
      {data.runs.length === 0 && <p className="small">No runs yet.</p>}
      {data.runs.length > 0 && (
        <table className="admin-table">
          <thead><tr><th>WHEN (UTC)</th><th>SOURCE</th><th>FOUND</th><th>QUEUED</th><th>COST</th><th>ERROR</th></tr></thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.id}><td>{shortDate(r.at)}</td><td>{r.source}</td><td>{r.found}</td><td>{r.queued}</td><td>{formatUsd(r.cost_usd)}</td><td className="err">{r.error ?? ''}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

interface YoutubeConfig { queries?: string[]; channels?: string[] }

function Config({ token, fail }: TabProps) {
  const [yt, loadYt] = useLoad<{ value: YoutubeConfig | null }>(token, 'admin/config/youtube', fail);
  const [web, loadWeb] = useLoad<{ value: { query?: string } | null }>(token, 'admin/config/web', fail);
  const [queries, setQueries] = useState('');
  const [channels, setChannels] = useState('');
  const [watch, loadWatch] = useLoad<{ value: { channels?: { handle?: string; channel_id?: string }[] } | null }>(token, 'admin/config/watch', fail);
  const [query, setQuery] = useState('');
  const [handles, setHandles] = useState('');
  const [msg, setMsg] = useState('');
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState('');
  const [backDays, setBackDays] = useState('120');
  const [backfilling, setBackfilling] = useState(false);
  const [backNote, setBackNote] = useState('');
  const stopBackfill = useRef(false);
  useEffect(() => {
    if (watch) setHandles((watch.value?.channels ?? []).map((c) => c.handle ?? c.channel_id ?? '').join('\n'));
  }, [watch]);
  useEffect(() => {
    if (yt) {
      setQueries((yt.value?.queries ?? []).join('\n'));
      setChannels((yt.value?.channels ?? []).join('\n'));
    }
  }, [yt]);
  useEffect(() => {
    if (web) setQuery(web.value?.query ?? '');
  }, [web]);
  const save = async (key: 'youtube' | 'web' | 'watch', value: unknown, reload: () => void) => {
    setMsg('');
    try {
      await api(token, `admin/config/${key}`, value, 'PUT');
      setMsg(`Saved ${key}.`);
      reload();
    } catch (e) {
      if (e instanceof Forbidden) fail(e);
      else setMsg(e instanceof Error ? e.message : 'Failed');
    }
  };
  const runWatcher = async () => {
    setRunning(true);
    setRunNote('');
    try {
      setRunNote(watchSummaryLine(await api(token, 'admin/watch/run', {})));
      loadWatch();
    } catch (e) {
      if (e instanceof Forbidden) fail(e);
      else setRunNote(e instanceof Error ? e.message : 'Failed');
    }
    setRunning(false);
  };
  const backfill = async () => {
    const days = Math.min(180, Math.max(1, Math.floor(Number(backDays)) || 120));
    setBackDays(String(days));
    stopBackfill.current = false;
    setBackfilling(true);
    setBackNote('Starting...');
    try {
      const out = await runBackfill({
        days,
        call: (d) => api<WatchRunResult>(token, 'admin/watch/run', { days: d }),
        onProgress: (t) => setBackNote(`${backfillLine(t)} · call ${t.calls}`),
        cancelled: () => stopBackfill.current,
      });
      const head = { done: 'Done.', cancelled: 'Stopped.', error: 'Stopped on an error:', skipped: 'Stopped:', stalled: 'Stopped:', limit: 'Stopped:' }[out.stop];
      setBackNote(`${head} ${out.reason ? `${out.reason} ` : ''}${backfillLine(out.totals)}`);
      loadWatch();
    } catch (e) {
      if (e instanceof Forbidden) fail(e);
      else setBackNote(e instanceof Error ? e.message : 'Failed');
    }
    setBackfilling(false);
  };
  if (!yt || !web || !watch) return <p className="small">Loading...</p>;
  const { entries: hs, bad: badHandles } = channelEntries(handles);
  const qs = linesOf(queries);
  const { entries: chs, bad: badChannels } = channelEntries(channels);
  return (
    <>
      <h3>YOUTUBE</h3>
      <label>QUERIES (one per line, max 5, 100 characters each)<textarea rows={4} value={queries} onChange={(e) => setQueries(e.target.value)} /></label>
      <label>CHANNELS (one per line, max 10: channel link, @handle or channel ID)<textarea rows={4} placeholder="channel link, @handle or channel ID" value={channels} onChange={(e) => setChannels(e.target.value)} /></label>
      {badChannels.length > 0 && <p className="err">{CHANNEL_INPUT_HINT}: {badChannels.join(', ')}</p>}
      <button className="btn" disabled={qs.length > 5 || chs.length > 10 || badChannels.length > 0 || qs.length + chs.length === 0 || qs.some((q) => q.length > 100)} onClick={() => save('youtube', { queries: qs, channels: chs }, loadYt)}>SAVE YOUTUBE</button>
      <h3>WEB SEARCH</h3>
      <label>WEEKLY QUERY (max 300 characters)<input value={query} maxLength={300} onChange={(e) => setQuery(e.target.value)} /></label>
      <button className="btn" disabled={!query.trim()} onClick={() => save('web', { query: query.trim() }, loadWeb)}>SAVE WEB</button>
      <h3>WATCHED CHANNELS</h3>
      <label>CHANNELS (one per line, max 10: channel link, @handle or channel ID). New uploads are checked every 3 hours: repos the channel lists in its own comments go on the shelves.<textarea rows={3} placeholder="channel link, @handle or channel ID" value={handles} onChange={(e) => setHandles(e.target.value)} /></label>
      {badHandles.length > 0 && <p className="err">{CHANNEL_INPUT_HINT}: {badHandles.join(', ')}</p>}
      <div className="row">
        <button className="btn" disabled={hs.length > 10 || badHandles.length > 0} onClick={() => save('watch', { channels: hs }, loadWatch)}>SAVE CHANNELS</button>
        <button className="btn alt" disabled={running} onClick={runWatcher}>{running ? 'RUNNING...' : 'RUN WATCHER NOW'}</button>
      </div>
      <div className="row">
        <label>BACKFILL LAST <input type="number" min={1} max={180} value={backDays} disabled={backfilling} onChange={(e) => setBackDays(e.target.value)} style={{ width: '5em' }} /> DAYS</label>
        <button className="btn alt" disabled={backfilling || running} onClick={backfill}>{backfilling ? 'BACKFILLING...' : 'BACKFILL'}</button>
        {backfilling && <button className="btn" onClick={() => { stopBackfill.current = true; }}>STOP</button>}
      </div>
      {backNote && <p className="small">{backNote}</p>}
      {runNote && <p className="small">{runNote}</p>}
      {msg && <p className="small">{msg}</p>}
    </>
  );
}
