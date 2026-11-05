import { useCallback, useEffect, useState } from 'react';
import { API } from '../lib/api';
import { adminHeaders, formatUsd, pastedUrls, shortDate, spendTable, type SpendRow } from '../lib/adminPanel';

const KEY = 'rr-admin-token'; // sessionStorage only: gone when the tab closes
type Tab = 'queue' | 'paste' | 'spend' | 'runs';
interface QueueItem { id: number; source: string; repo: string; title: string; why: string; credit_url: string; credit_title: string; credit_author: string; at: string; facts?: { stars?: number } | null }
interface Run { id: number; at: string; source: string; found: number; queued: number; cost_usd: number | string; error: string | null }

class Forbidden extends Error {}

async function api<T>(token: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
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
          {(['queue', 'paste', 'spend', 'runs'] as Tab[]).map((t) => (
            <button key={t} className={t === tab ? 'btn' : 'btn alt'} onClick={() => { setTab(t); setErr(''); }}>{t.toUpperCase()}</button>
          ))}
          <button className="btn alt" onClick={() => signOut()}>SIGN OUT</button>
          <a className="btn alt" href="#">STORE</a>
        </div>
      </header>
      <main className="panel">
        {err && <p className="err">{err}</p>}
        {tab === 'queue' && <Queue token={token} fail={fail} />}
        {tab === 'paste' && <Paste token={token} fail={fail} />}
        {tab === 'spend' && <Spend token={token} fail={fail} />}
        {tab === 'runs' && <Runs token={token} fail={fail} />}
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
              Featured in <a href={it.credit_url} target="_blank" rel="noreferrer">{it.credit_title || it.credit_url}</a>
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

function Paste({ token, fail }: TabProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const urls = pastedUrls(text);
  const go = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await api<{ found: number; queued: number; ignored: number }>(token, 'admin/paste', { urls });
      setMsg(`Found ${r.found}, queued ${r.queued} (already known or not on GitHub: ${r.found - r.queued}), ignored ${r.ignored} that were not repo links.`);
      setText('');
    } catch (e) {
      if (e instanceof Forbidden) fail(e);
      else setMsg(e instanceof Error ? e.message : 'Failed');
    }
    setBusy(false);
  };
  return (
    <>
      <h3>PASTE LINKS</h3>
      <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'https://github.com/owner/repo\nowner/other-repo'} />
      <p className="small">{urls.length} link{urls.length === 1 ? '' : 's'} (max 20). They go to the queue as "manual".</p>
      {msg && <p className="small">{msg}</p>}
      <button className="btn" disabled={busy || urls.length === 0} onClick={go}>{busy ? 'CHECKING...' : 'QUEUE THEM'}</button>
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
