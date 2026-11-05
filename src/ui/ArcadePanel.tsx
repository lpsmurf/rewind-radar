import { useState } from 'react';
import type { Proposal } from '../types';
import { ARCADE_PROPOSAL_PITCH, ARCADE_PROPOSAL_TITLE, findArcadeProposal } from '../store/arcade';

export default function ArcadePanel({ proposals, onBack, onPropose, handle, onClose }: {
  proposals: Proposal[];
  onBack(p: Proposal): Promise<void>;
  onPropose(f: { title: string; pitch: string; link: string; submitter: string }): Promise<string | null>;
  handle: string;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(false);
  const existing = findArcadeProposal(proposals);

  async function notify() {
    setBusy(true);
    setErr('');
    if (existing) {
      await onBack(existing);
      setDone(true);
    } else {
      const problem = await onPropose({ title: ARCADE_PROPOSAL_TITLE, pitch: ARCADE_PROPOSAL_PITCH, link: '', submitter: handle });
      if (problem) setErr(problem);
      else setDone(true);
    }
    setBusy(false);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel arcade-panel" onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose} aria-label="close">X</button>
        <h3>THE ARCADE · OPENING SOON</h3>
        <p className="blurb">This cabinet is still being wired up. Nothing to play yet.</p>
        <p className="small">
          {existing
            ? `${existing.votes} ${existing.votes === 1 ? 'person has' : 'people have'} asked for it in the Request Box.`
            : 'Be the first to ask for it in the Request Box.'}
        </p>
        {err && <p className="err">{err}</p>}
        {done
          ? <p className="small">You are on the list. We will open it when enough people ask.</p>
          : <button className="btn" onClick={notify} disabled={busy}>TELL ME WHEN IT OPENS</button>}
      </div>
    </div>
  );
}
