import { useState } from 'react';
import Store from './store/Store';
import { useStore } from './lib/useStore';
import { RING_COLORS, type Tape } from './types';
import TapePanel from './ui/TapePanel';
import ClerkDrawer from './ui/ClerkDrawer';
import SubmitModal from './ui/SubmitModal';

export default function App() {
  const s = useStore();
  const [open, setOpen] = useState<Tape | null>(null);
  const [clerkOpen, setClerkOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const cur = open ? s.tapes.find((t) => t.id === open.id) ?? open : null;
  const chips = s.tapes.filter((t) => s.highlighted.has(t.id));

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
          <button className="btn alt" onClick={() => setSubmitOpen(true)}>SUBMIT YOUR PROJECT</button>
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
          <div className="panel">
            <h3>TOP 10 THIS WEEK</h3>
            <ol className="top">
              {s.top10.map((t) => (
                <li key={t.id}><button onClick={() => setOpen(t)}>{t.title}<b>▲{t.votes}</b></button></li>
              ))}
            </ol>
          </div>
          <div className="panel">
            <h3>RINGS</h3>
            {(['adopt', 'trial', 'assess', 'hold'] as const).map((r) => (
              <p key={r} className="legend"><i style={{ background: RING_COLORS[r] }} />{r.toUpperCase()}</p>
            ))}
          </div>
        </aside>
      </main>
      {cur && <TapePanel tape={cur} onClose={() => setOpen(null)} onRent={() => s.rent(cur)} onVote={() => s.vote(cur)} />}
      {clerkOpen && <ClerkDrawer onClose={() => setClerkOpen(false)} ask={s.askClerk} chips={chips} onOpen={(t) => setOpen(t)} />}
      {submitOpen && <SubmitModal onClose={() => setSubmitOpen(false)} submit={s.submit} />}
      {s.toast && <div className="toast">{s.toast}</div>}
    </div>
  );
}
