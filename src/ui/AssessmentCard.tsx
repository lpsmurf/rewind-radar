import type { Assessment, ClerkReply, GateKey, RepoSummary, Tape } from '../types';
import { RING_COLORS } from '../types';

const GATES: [GateKey, string][] = [
  ['licence', 'LICENCE'],
  ['maintenance', 'MAINTENANCE'],
  ['security', 'SECURITY'],
  ['cost', 'COST'],
  ['lockin', 'LOCK-IN'],
];

function ago(iso: string | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const d = Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  return d === 0 ? 'today' : `${d}d ago`;
}

export default function AssessmentCard({ reply, tapes, onOpen, onShelve }: {
  reply: ClerkReply; tapes: Tape[]; onOpen(t: Tape): void; onShelve(r: RepoSummary, a: Assessment): void;
}) {
  const a = reply.assessment;
  if (!a) return null;
  const repo = reply.repo;
  const fit = reply.fit;
  const overlaps = (a.overlaps ?? []).flatMap((o) => {
    const t = tapes.find((x) => x.slug === o.slug);
    return t ? [{ t, why: o.why }] : [];
  });
  const installed = reply.in_store ? tapes.find((x) => x.slug === reply.in_store) : undefined;
  const reviewed = ago(reply.reviewed_at);

  return (
    <div className="acard">
      <div className="head">
        <span className="ring" style={{ background: RING_COLORS[a.ring] }}>{String(a.ring).toUpperCase()}</span>
        <span className="conf">{Math.round((a.confidence ?? 0) * 100)}% SURE</span>
        <span className="effort" title="Effort to adopt">EFFORT {a.effort}</span>
      </div>
      {repo && (
        <a className="name" href={repo.html_url} target="_blank" rel="noopener noreferrer">{repo.full_name}</a>
      )}
      <p className="plain"><b>{a.plain}</b></p>
      <p className="what">{a.what}</p>

      {repo && (
        <div className="facts">
          <span>★ {repo.stars}</span>
          <span>{repo.license || 'no licence'}</span>
          {repo.language && <span>{repo.language}</span>}
          <span>pushed {repo.signals.days_since_push}d ago</span>
          {repo.archived && <span className="archived">ARCHIVED</span>}
        </div>
      )}

      {(a.benefits?.length > 0 || a.risks?.length > 0) && (
        <div className="pros">
          {a.benefits?.length > 0 && (
            <ul className="plus">{a.benefits.map((b, i) => <li key={i}>{b}</li>)}</ul>
          )}
          {a.risks?.length > 0 && (
            <ul className="minus">{a.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
          )}
        </div>
      )}

      <ul className="gates">
        {GATES.flatMap(([k, label]) => {
          const g = a.gates?.[k];
          if (!g) return [];
          return [
            <li key={k} className={g.ok ? 'ok' : 'no'}>
              <i aria-label={g.ok ? 'pass' : 'fail'}>{g.ok ? '✓' : '✗'}</i>
              <span><b>{label}</b> {g.note}</span>
            </li>,
          ];
        })}
      </ul>

      {overlaps.length > 0 && (
        <>
          <p className="sub">ALREADY ON THE SHELVES</p>
          <div className="chips">
            {overlaps.map(({ t, why }) => (
              <button key={t.id} className="chip" title={why} onClick={() => onOpen(t)}>{t.title}</button>
            ))}
          </div>
        </>
      )}

      {fit && (
        <div className="fit">
          <p className="sub">FIT FOR YOU · {String(fit.fit).toUpperCase()}</p>
          <p>{fit.why}</p>
          {fit.helps?.length > 0 && <ul>{fit.helps.map((h, i) => <li key={i}>{h}</li>)}</ul>}
          {fit.first_step && <p><b>FIRST STEP</b> {fit.first_step}</p>}
        </div>
      )}

      {a.steps?.length > 0 && (
        <>
          <p className="sub">STEPS</p>
          <ol className="steps">{a.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </>
      )}

      {a.evidence?.length > 0 && (
        <details>
          <summary>EVIDENCE</summary>
          <ul>{a.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </details>
      )}

      {a.ai_directed_text && <p className="warn">README tried to talk to the reviewer — ignored.</p>}

      <p className="small foot">
        {reviewed ? `reviewed ${reviewed}` : 'reviewed just now'}
        {reply.cached ? ' · cached' : ''}
        {reply.stale ? ' · may be out of date' : ''}
      </p>

      {reply.in_store ? (
        <button className="btn alt full" disabled={!installed} onClick={() => installed && onOpen(installed)}>
          ALREADY ON THE SHELF
        </button>
      ) : (
        repo && <button className="btn full" onClick={() => onShelve(repo, a)}>PUT IT ON THE COMMUNITY SHELF</button>
      )}
    </div>
  );
}
