import { useState } from 'react';

export default function SubmitModal({ onClose, submit, initial }: {
  onClose(): void;
  submit(f: { title: string; url: string; note: string; submitter: string }): Promise<boolean>;
  initial?: Partial<{ title: string; url: string; note: string; submitter: string }>;
}) {
  const [f, setF] = useState(() => ({
    title: (initial?.title ?? '').slice(0, 80),
    url: initial?.url ?? '',
    note: (initial?.note ?? '').slice(0, 200),
    submitter: initial?.submitter ?? '',
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(f.url.trim())) {
      setErr('Use https://github.com/owner/repo');
      return;
    }
    setErr('');
    setBusy(true);
    const ok = await submit({ ...f, url: f.url.trim() });
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <form className="panel" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <button type="button" className="x" onClick={onClose} disabled={busy} aria-label="close">X</button>
        <h3>SUBMIT YOUR PROJECT</h3>
        <fieldset disabled={busy}>
          <label>PROJECT NAME<input required maxLength={80} value={f.title} onChange={set('title')} /></label>
          <label>GITHUB URL<input required value={f.url} onChange={set('url')} placeholder="https://github.com/owner/repo" /></label>
          <label>ONE-LINER<input maxLength={200} value={f.note} onChange={set('note')} /></label>
          <label>YOUR HANDLE<input maxLength={30} value={f.submitter} onChange={set('submitter')} /></label>
        </fieldset>
        {err && <p className="err">{err}</p>}
        {busy ? <p className="small">The clerk is watching your tape...</p> : <button className="btn">SUBMIT</button>}
      </form>
    </div>
  );
}
