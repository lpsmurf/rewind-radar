import { isLinkedSkill } from '../lib/useStore';
import type { Tape } from '../types';
import { RING_COLORS } from '../types';

const KIND: Record<string, string> = {
  skill: 'SKILL', memory: 'SKILL', repo: 'NEW RELEASE', community: 'COMMUNITY', skene: 'SKILL',
};

export default function TapePanel({ tape, onClose, onRent, onVote }: {
  tape: Tape; onClose(): void; onRent(): void; onVote(): void;
}) {
  const linked = isLinkedSkill(tape);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel tape-panel" onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose} aria-label="close">X</button>
        <div className="cover">
          <span className="badge">{KIND[tape.kind] ?? tape.kind.toUpperCase()}</span>
          <h2>{tape.title}</h2>
          {tape.ring && (
            <span className="sticker" style={{ background: RING_COLORS[tape.ring] }}>{tape.ring.toUpperCase()}</span>
          )}
        </div>
        <div className="meta">
          {tape.rating != null && <span>{'★'.repeat(Math.round(tape.rating))}{'☆'.repeat(5 - Math.round(tape.rating))}</span>}
          {tape.stars != null && <span>★ {tape.stars}</span>}
          {tape.language && <span>{tape.language}</span>}
          <span className={'trust ' + tape.trust}>{tape.trust.toUpperCase()}</span>
        </div>
        {tape.kind === 'community' && tape.submitter && <p className="small">Submitted by {tape.submitter}</p>}
        {linked && <p className="small">Original by {tape.submitter ?? 'its author'}. We link to it, we don't copy it.</p>}
        {tape.kind === 'skill' && !linked && <p className="small">Made by {tape.submitter ?? 'the house'}. Free to rent.</p>}
        <p className="blurb">{tape.blurb}</p>
        <p className="small">{tape.rentals} rentals · {tape.votes} votes this week</p>
        <div className="row">
          <button className="btn" onClick={onRent}>{linked ? 'GET FROM SOURCE' : tape.kind === 'skill' ? 'RENT · COPY INSTALL' : 'RENT · COPY CLONE'}</button>
          <button className="btn alt" onClick={onVote}>VOTE ▲</button>
          {tape.source_url && !linked && (
            <a className="btn alt" href={tape.source_url} target="_blank" rel="noreferrer noopener">OPEN ON GITHUB</a>
          )}
        </div>
      </div>
    </div>
  );
}
