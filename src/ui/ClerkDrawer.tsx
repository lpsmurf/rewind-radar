import { Fragment, useState } from 'react';
import type { Assessment, ClerkReply, RepoSummary, Tape } from '../types';
import AssessmentCard from './AssessmentCard';
import { gateState, type Member } from '../lib/clerkGate';

interface Msg { who: 'you' | 'clerk'; text: string; reply?: ClerkReply }

export default function ClerkDrawer({ onClose, ask, scan, chips, onOpen, github, onForget, tapes, onShelve, member, canSignIn, onConnect, onSignIn, onSignOut }: {
  onClose(): void; ask(q: string): Promise<ClerkReply>; scan(github: string): Promise<string>; chips: Tape[]; onOpen(t: Tape): void;
  github: string | null; onForget(): void; tapes: Tape[]; onShelve(r: RepoSummary, a: Assessment): void;
  member: Member | null; canSignIn: boolean; onConnect(u: string): void; onSignIn(): void; onSignOut(): void;
}) {
  const gated = gateState(github, member) === 'gate';
  const [gh, setGh] = useState('');
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
    const r = await ask(text);
    setLog((l) => [...l, r.assessment
      ? { who: 'clerk', text: `Here's my review of ${r.repo?.full_name ?? 'that repo'}:`, reply: r }
      : { who: 'clerk', text: r.answer }]);
    setBusy(false);
  }

  async function goScan(e: React.FormEvent) {
    e.preventDefault();
    const text = gh.trim();
    if (!text || busy) return;
    setBusy(true);
    setLog((l) => [...l, { who: 'you', text: `Scan my GitHub: ${text}` }]);
    const a = await scan(text);
    setLog((l) => [...l, { who: 'clerk', text: a }]);
    setBusy(false);
  }

  return (
    <aside className="drawer panel">
      <button className="x" onClick={onClose} aria-label="close">X</button>
      <h3>THE CLERK</h3>
      <div className="log">
        {log.map((m, i) => (
          <Fragment key={i}>
            <p className={'msg ' + m.who}>{m.text}</p>
            {m.reply && <AssessmentCard reply={m.reply} tapes={tapes} onOpen={onOpen} onShelve={onShelve} />}
          </Fragment>
        ))}
        {busy && <p className="msg clerk">...</p>}
        {chips.length > 0 && (
          <div className="chips">
            {chips.map((t) => <button key={t.id} className="chip" onClick={() => onOpen(t)}>{t.title}</button>)}
          </div>
        )}
      </div>
      {gated ? (
        <div className="gate">
          <p className="small">The clerk only serves GitHub folks. Pick one:</p>
          <form onSubmit={(e) => { e.preventDefault(); onConnect(gh); }} className="row">
            <input value={gh} maxLength={39} onChange={(e) => setGh(e.target.value)} placeholder="Your GitHub username" aria-label="Your GitHub username" />
            <button className="btn" disabled={busy}>LET ME IN</button>
          </form>
          <form onSubmit={goScan} className="row scan">
            <input value={gh} maxLength={120} onChange={(e) => setGh(e.target.value)} placeholder="GitHub user or repo URL" aria-label="GitHub user or repo" />
            <button className="btn" disabled={busy}>SCAN MY GITHUB</button>
          </form>
          {canSignIn && <button type="button" className="btn" onClick={onSignIn}>SIGN IN WITH GITHUB</button>}
        </div>
      ) : (
        <>
          <form onSubmit={goScan} className="row scan">
            <input value={gh} maxLength={120} onChange={(e) => setGh(e.target.value)} placeholder="GitHub user or repo URL" aria-label="GitHub user or repo" />
            <button className="btn" disabled={busy}>SCAN MY GITHUB</button>
          </form>
          {member ? (
            <p className="small ghnote">signed in as @{member.login} · <button type="button" className="linkbtn" onClick={onSignOut}>sign out</button></p>
          ) : (
            <p className="small ghnote">connected as @{github} · <button type="button" className="linkbtn" onClick={onForget}>forget</button></p>
          )}
          <form onSubmit={go} className="row">
            <input value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} placeholder="Ask for a tape or paste a GitHub repo..." />
            <button className="btn" disabled={busy}>ASK</button>
          </form>
        </>
      )}
    </aside>
  );
}
