import { useState } from 'react';
import type { Tape } from '../types';

interface Msg { who: 'you' | 'clerk'; text: string }

export default function ClerkDrawer({ onClose, ask, chips, onOpen }: {
  onClose(): void; ask(q: string): Promise<string>; chips: Tape[]; onOpen(t: Tape): void;
}) {
  const [q, setQ] = useState('');
  const [log, setLog] = useState<Msg[]>([{ who: 'clerk', text: 'Welcome! What are you looking for today?' }]);
  const [busy, setBusy] = useState(false);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    setQ('');
    setBusy(true);
    setLog((l) => [...l, { who: 'you', text }]);
    const a = await ask(text);
    setLog((l) => [...l, { who: 'clerk', text: a }]);
    setBusy(false);
  }

  return (
    <aside className="drawer panel">
      <button className="x" onClick={onClose} aria-label="close">X</button>
      <h3>THE CLERK</h3>
      <div className="log">
        {log.map((m, i) => <p key={i} className={'msg ' + m.who}>{m.text}</p>)}
        {busy && <p className="msg clerk">...</p>}
        {chips.length > 0 && (
          <div className="chips">
            {chips.map((t) => <button key={t.id} className="chip" onClick={() => onOpen(t)}>{t.title}</button>)}
          </div>
        )}
      </div>
      <form onSubmit={go} className="row">
        <input value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} placeholder="Ask for a tape..." />
        <button className="btn" disabled={busy}>ASK</button>
      </form>
    </aside>
  );
}
