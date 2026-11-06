import { Fragment, useEffect, useRef, useState } from 'react';
import type { Assessment, ClerkReply, RepoSummary, Tape } from '../types';
import AssessmentCard from './AssessmentCard';
import { gateState, type Member } from '../lib/clerkGate';
import { answerItems, scanTarget, type ClerkAnswer, type RepoHit } from '../lib/radar';
import type { ScanResult } from '../lib/useStore';
import { formatStars } from '../lib/stars';
import type { BrowseItem } from './releasesNav';
import { autoAskAction } from './autoAsk';

interface Msg { who: 'you' | 'clerk'; text: string; reply?: ClerkReply; github?: RepoHit[]; slugs?: string[] }

export default function ClerkDrawer({ onClose, ask, scan, chips, onOpen, github, onForget, tapes, onShelve, member, canSignIn, onConnect, onSignIn, onSignOut, autoAsk, hasRadar, onViewRadar, onRadar, onBrowse, onAutoAskDone }: {
  onAutoAskDone(): void;
  /** A question to send as soon as the drawer sees it (the browser's ASSESS IT); `n` makes a repeat count as new. */
  autoAsk?: { q: string; n: number } | null; hasRadar: boolean; onViewRadar(): void; onRadar(r: NonNullable<ScanResult['radar']>): void;
  /** Open the releases browser on items, starting at `index`. */
  onBrowse(items: BrowseItem[], index: number, title: string): void;
  onClose(): void; ask(q: string): Promise<ClerkAnswer>; scan(github: string): Promise<ScanResult>; chips: Tape[]; onOpen(t: Tape): void;
  github: string | null; onForget(): void; tapes: Tape[]; onShelve(r: RepoSummary, a: Assessment): void;
  member: Member | null; canSignIn: boolean; onConnect(u: string): void; onSignIn(): void; onSignOut(): void;
}) {
  const gated = gateState(github, member) === 'gate';
  const [gh, setGh] = useState('');
  const [q, setQ] = useState('');
  const [log, setLog] = useState<Msg[]>([{ who: 'clerk', text: 'Welcome! What are you looking for today?' }]);
  const [busy, setBusy] = useState(false);

  async function send(text: string) {
    if (!text || busy) return;
    setQ('');
    setBusy(true);
    setLog((l) => [...l, { who: 'you', text }]);
    const r = await ask(text);
    setLog((l) => [...l, r.assessment
      ? { who: 'clerk', text: `Here's my review of ${r.repo?.full_name ?? 'that repo'}:`, reply: r }
      : { who: 'clerk', text: r.answer, github: r.github ?? [], slugs: r.slugs }]);
    setBusy(false);
  }
  const go = (e: React.FormEvent) => { e.preventDefault(); void send(q.trim()); };
  const lastAuto = useRef(0);
  useEffect(() => {
    // Consume the handed-over question once; wait (and keep it) while the clerk is busy.
    if (autoAskAction(autoAsk, lastAuto.current, busy) !== 'send' || !autoAsk) return;
    lastAuto.current = autoAsk.n;
    onAutoAskDone();
    void send(autoAsk.q);
  }, [autoAsk, busy]);

  async function goScan(e: React.FormEvent) {
    e.preventDefault();
    const text = scanTarget(gh, github ?? member?.login ?? null);
    if (!text || busy) return;
    setBusy(true);
    setLog((l) => [...l, { who: 'you', text: `Scan my GitHub: ${text}` }]);
    const a = await scan(text);
    setLog((l) => [...l, { who: 'clerk', text: a.text }]);
    setBusy(false);
    if (a.radar) onRadar(a.radar);
  }

  return (
    <aside className="drawer panel">
      <button className="x" onClick={onClose} aria-label="close">X</button>
      <h3>THE CLERK</h3>
      <div className="log">
        {log.map((m, i) => (
          <Fragment key={i}>
            <p className={'msg ' + m.who}>{m.text}</p>
            {m.github && m.github.length > 0 && (
              <div className="ghchips">
                {answerItems({ github: m.github, slugs: m.slugs }, tapes).map((it, k, all) => (
                  <button key={it.kind === 'github' ? it.full_name : it.id} className="vhs-chip" onClick={() => onBrowse(all, k, 'CLERK PICKS')}
                    style={{ borderLeftColor: `hsl(${(k * 67) % 360} 60% 50%)` }}>
                    <span>{(it.kind === 'github' ? it.full_name : it.title).split('/').pop()}</span>
                    {it.kind === 'github' && it.stars != null && <b>★ {formatStars(it.stars)}</b>}
                  </button>
                ))}
              </div>
            )}
            {m.reply && <AssessmentCard reply={m.reply} tapes={tapes} onOpen={onOpen} onShelve={onShelve} />}
          </Fragment>
        ))}
        {busy && <p className="msg clerk">...</p>}
        {hasRadar && <button type="button" className="btn alt" onClick={onViewRadar}>VIEW MY RADAR</button>}
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
