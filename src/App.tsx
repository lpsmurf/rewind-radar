import { useState } from 'react';
import Store from './store/Store';
import { useStore } from './lib/useStore';
import { RING_COLORS, type Assessment, type RepoSummary, type Tape } from './types';
import TapePanel from './ui/TapePanel';
import ReleasesBrowser from './ui/ReleasesBrowser';
import { itemKey, type BrowseItem, type GithubItem } from './ui/releasesNav';
import { communityShelf, weeklyReleases } from './store/rooms';
import type { ShelfSource } from './store/Store';
import ClerkDrawer from './ui/ClerkDrawer';
import SubmitModal from './ui/SubmitModal';
import ProposalsBoard from './ui/ProposalsBoard';
import ProposeModal from './ui/ProposeModal';
import ArcadePanel from './ui/ArcadePanel';
import ChatPanel from './ui/ChatPanel';

export default function App() {
  const s = useStore();
  const [open, setOpen] = useState<Tape | null>(null);
  const [browse, setBrowse] = useState<{ items: BrowseItem[]; index: number; title: string; why?: Record<string, string> } | null>(null);
  const [radar, setRadar] = useState<{ items: BrowseItem[]; title: string; why: Record<string, string> } | null>(null);
  const [autoAsk, setAutoAsk] = useState<{ q: string; n: number } | null>(null);
  const [clerkOpen, setClerkOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitInitial, setSubmitInitial] = useState<{ title: string; url: string; note: string } | undefined>();
  const [proposeOpen, setProposeOpen] = useState(false);
  const [arcadeOpen, setArcadeOpen] = useState(false);

  const cur = open ? s.tapes.find((t) => t.id === open.id) ?? open : null;
  // The weekly and monthly shelves open the full-screen browser over their own list; any other tape opens the panel.
  const onTapeClick = (t: Tape, source?: ShelfSource) => {
    const items = source === 'weekly' ? weeklyReleases(s.tapes) : source === 'monthly' ? s.monthly : source === 'community' ? communityShelf(s.tapes) : [];
    const index = items.findIndex((x) => x.id === t.id);
    if (index < 0) return setOpen(t);
    setBrowse({ items, index, title: source === 'weekly' ? 'WEEKLY NEW RELEASES' : source === 'monthly' ? 'MONTHLY PICKS' : 'COMMUNITY PICKS' });
  };
  const githubName = (g: GithubItem) => g.full_name.split('/')[1] ?? g.full_name;
  const assessIt = (g: GithubItem) => { setBrowse(null); setAutoAsk({ q: g.html_url, n: (autoAsk?.n ?? 0) + 1 }); setClerkOpen(true); };
  const shelveIt = (g: GithubItem) => { setBrowse(null); openSubmit({ title: githubName(g), url: g.html_url, note: g.why || g.description || '' }); };
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
        </div>
      </header>
      <main>
        <section className="store">
          <Store
            tapes={s.tapes}
            visitors={s.visitors}
            me={s.me}
            chat={s.chat}
            meKey={s.meKey}
            highlighted={s.highlighted}
            top10={s.top10}
            monthly={s.monthly}
            onTapeClick={onTapeClick}
            onCounterClick={() => setClerkOpen(true)}
            onAisleChange={s.setAisle}
            onMove={s.move}
            onCabinetClick={() => setArcadeOpen(true)}
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
          <ChatPanel chat={s.chat} meKey={s.meKey} github={s.github} member={s.member} onSend={s.sendChat} onReport={s.reportChat} onConnect={() => setClerkOpen(true)} />
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
      {browse && <ReleasesBrowser items={browse.items.map((x) => (x.kind === 'github' ? x : s.tapes.find((t) => t.id === x.id) ?? x))} startIndex={browse.index} title={browse.title} why={browse.why} onAssess={assessIt} onShelve={shelveIt} onClose={() => setBrowse(null)} onRent={s.rent} onVote={s.vote} />}
      {clerkOpen && <ClerkDrawer onClose={() => setClerkOpen(false)} ask={s.askClerk} scan={s.scanProfile} chips={chips} onOpen={(t) => setOpen(t)} github={s.github} onForget={s.forgetGithub} tapes={s.tapes} onShelve={onShelve} member={s.member} canSignIn={s.canSignIn} onConnect={s.connectGithub} onSignIn={s.signIn} onSignOut={s.signOut}
        autoAsk={autoAsk} hasRadar={!!radar} onViewRadar={() => radar && setBrowse({ items: radar.items, index: 0, title: radar.title, why: radar.why })}
        onRadar={(r) => { setRadar(r); setBrowse({ items: r.items, index: 0, title: r.title, why: r.why }); }}
        onBrowse={(items, index, title) => setBrowse({ items, index, title })} />}
      {submitOpen && <SubmitModal onClose={() => setSubmitOpen(false)} submit={s.submit} initial={submitInitial} />}
      {proposeOpen && <ProposeModal onClose={() => setProposeOpen(false)} propose={s.propose} />}
      {arcadeOpen && <ArcadePanel proposals={s.proposals} onBack={s.backProposal} onPropose={s.propose} handle={s.me.name} onClose={() => setArcadeOpen(false)} />}
      {s.toast && <div className="toast">{s.toast}</div>}
    </div>
  );
}
