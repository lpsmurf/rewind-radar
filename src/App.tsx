import { useEffect, useState } from 'react';
import Store from './store/Store';
import { useStore } from './lib/useStore';
import { RING_COLORS, type Assessment, type RepoSummary, type Tape } from './types';
import TapePanel from './ui/TapePanel';
import ClerkDrawer from './ui/ClerkDrawer';
import SubmitModal from './ui/SubmitModal';
import ProposalsBoard from './ui/ProposalsBoard';
import ProposeModal from './ui/ProposeModal';
import { BigQR, JoinCard } from './ui/JoinQR';

export default function App() {
  const s = useStore();
  const [open, setOpen] = useState<Tape | null>(null);
  const [clerkOpen, setClerkOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitInitial, setSubmitInitial] = useState<{ title: string; url: string; note: string } | undefined>();
  const [proposeOpen, setProposeOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  // Presenter shortcut: press Q to toggle the big QR (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'q' || e.key === 'Q') setQrOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const cur = open ? s.tapes.find((t) => t.id === open.id) ?? open : null;
  const chips = s.tapes.filter((t) => s.highlighted.has(t.id));
  const openSubmit = (initial?: { title: string; url: string; note: string }) => {
    setSubmitInitial(initial);
    setSubmitOpen(true);
  };
  const onShelve = (r: RepoSummary, a: Assessment) =>
    openSubmit({ title: r.full_name.split('/')[1] ?? r.full_name, url: r.html_url, note: a.plain });

  return (
    <div className="app">
      <header>
        <div>
          <h1>REWIND RADAR VIDEO</h1>
          <p className="tag">Be kind, rewind your skills</p>
        </div>
        <span className="live">{s.live ? '● LIVE' : '○ LOCAL'} · {s.visitors.length + 1} in store</span>
        <div className="row">
          <button className="btn" onClick={() => setClerkOpen(true)}>ASK THE CLERK</button>
          <button className="btn alt" onClick={() => openSubmit()}>SUBMIT YOUR PROJECT</button>
          <button className="btn" onClick={() => setProposeOpen(true)}>PROPOSE AN IDEA</button>
          <button className="btn alt" onClick={() => setQrOpen(true)}>SHOW QR</button>
        </div>
      </header>
      <main>
        <section className="store">
          <Store
            tapes={s.tapes}
            visitors={s.visitors}
            me={s.me}
            highlighted={s.highlighted}
            top10={s.top10}
            onTapeClick={setOpen}
            onCounterClick={() => setClerkOpen(true)}
            onAisleChange={s.setAisle}
          />
        </section>
        <aside className="side">
          <JoinCard onShowBig={() => setQrOpen(true)} />
          <div className="panel">
            <h3>TOP 10 THIS WEEK</h3>
            <ol className="top">
              {s.top10.map((t) => (
                <li key={t.id}><button onClick={() => setOpen(t)}>{t.title}<b>▲{t.votes}</b></button></li>
              ))}
            </ol>
          </div>
          <ProposalsBoard proposals={s.proposals} onBack={s.backProposal} onPropose={() => setProposeOpen(true)} />
          <div className="panel">
            <h3>RINGS</h3>
            {(['adopt', 'trial', 'assess', 'hold'] as const).map((r) => (
              <p key={r} className="legend"><i style={{ background: RING_COLORS[r] }} />{r.toUpperCase()}</p>
            ))}
          </div>
        </aside>
      </main>
      {cur && <TapePanel tape={cur} onClose={() => setOpen(null)} onRent={() => s.rent(cur)} onVote={() => s.vote(cur)} />}
      {clerkOpen && <ClerkDrawer onClose={() => setClerkOpen(false)} ask={s.askClerk} scan={s.scanProfile} chips={chips} onOpen={(t) => setOpen(t)} github={s.github} onForget={s.forgetGithub} tapes={s.tapes} onShelve={onShelve} />}
      {submitOpen && <SubmitModal onClose={() => setSubmitOpen(false)} submit={s.submit} initial={submitInitial} />}
      {proposeOpen && <ProposeModal onClose={() => setProposeOpen(false)} propose={s.propose} />}
      {qrOpen && <BigQR inStore={s.visitors.length + 1} onClose={() => setQrOpen(false)} />}
      {s.toast && <div className="toast">{s.toast}</div>}
    </div>
  );
}
