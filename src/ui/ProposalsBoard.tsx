import type { Proposal } from '../types';

const KIND_LABEL: Record<Proposal['kind'], string> = { idea: 'IDEA', skill: 'SKILL', repo: 'REPO' };

export default function ProposalsBoard({ proposals, onBack, onPropose }: {
  proposals: Proposal[];
  onBack(p: Proposal): void;
  onPropose(): void;
}) {
  return (
    <div className="panel">
      <h3>REQUEST BOX</h3>
      <p className="small">Propose a skill to build, a repo to stock, or an idea. Most-backed wins the week.</p>
      <button className="btn alt full" onClick={onPropose}>PROPOSE AN IDEA</button>
      {proposals.length === 0 && <p className="small">Empty box. Be the first!</p>}
      <ol className="proposals">
        {proposals.slice(0, 12).map((p) => (
          <li key={p.id}>
            <button className="back" onClick={() => onBack(p)} aria-label={`Back ${p.title}`}>▲<b>{p.votes}</b></button>
            <div>
              <p className="ptitle"><span className="badge">{KIND_LABEL[p.kind]}</span> {p.link ? <a href={p.link} target="_blank" rel="noreferrer noopener">{p.title}</a> : p.title}</p>
              {p.pitch && <p className="small">{p.pitch}</p>}
              {p.submitter && <p className="small dim">by {p.submitter}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
