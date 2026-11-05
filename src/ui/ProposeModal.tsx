import { useState } from 'react';

export default function ProposeModal({ onClose, propose }: {
  onClose(): void;
  propose(f: { title: string; pitch: string; link: string; submitter: string }): Promise<string | null>;
}) {
  const [f, setF] = useState({ title: '', pitch: '', link: '', submitter: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (f.link.trim() && !/^https:\/\//.test(f.link.trim())) return setErr('Link must start with https://');
    setErr('');
    setBusy(true);
    const problem = await propose({ ...f, title: f.title.trim(), link: f.link.trim() });
    setBusy(false);
    if (problem) setErr(problem);
    else onClose();
  }

  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <form className="panel" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <button type="button" className="x" onClick={onClose} disabled={busy} aria-label="close">X</button>
        <h3>PROPOSE AN IDEA</h3>
        <fieldset disabled={busy}>
          <label>WHAT SHOULD WE STOCK?<input required minLength={3} maxLength={80} value={f.title} onChange={set('title')} placeholder="A skill that turns Figma into SwiftUI" /></label>
          <label>WHY / PITCH<textarea maxLength={400} rows={3} value={f.pitch} onChange={set('pitch')} placeholder="Who it helps and what it does" /></label>
          <label>LINK (OPTIONAL)<input value={f.link} onChange={set('link')} placeholder="https://github.com/owner/repo" /></label>
          <label>YOUR HANDLE<input maxLength={30} value={f.submitter} onChange={set('submitter')} /></label>
        </fieldset>
        {err && <p className="err">{err}</p>}
        {busy ? <p className="small">The clerk is reading your request...</p> : <button className="btn">DROP IT IN THE BOX</button>}
      </form>
    </div>
  );
}
