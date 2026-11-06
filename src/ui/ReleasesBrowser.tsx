import { useEffect, useState } from 'react';
import { RING_COLORS } from '../types';
import { formatStars } from '../lib/stars';
import { TapeActions } from './TapePanel';
import {
  isGithubItem, itemKey, itemStars, itemTitle, neighbourWindow, positionLabel, shortTitle, spineHue, stepIndex,
  type BrowseItem, type GithubItem,
} from './releasesNav';
import type { Tape } from '../types';

const PER_SIDE = 3; // the outermost one hides on narrow screens (CSS)

/**
 * Full-screen browser over any list of items: a store tape (RENT / VOTE) or a light GitHub repo
 * (clone / open). Wraps around at both ends. Left/Right scroll, Esc closes.
 */
export default function ReleasesBrowser({ items, startIndex = 0, title, why, onClose, onRent, onVote, onAssess, onShelve }: {
  items: BrowseItem[];
  startIndex?: number;
  title: string;
  onClose(): void;
  onRent(t: Tape): void;
  onVote(t: Tape): void;
  /** A "why this is for you" line per item key (itemKey), shown on the cover. */
  why?: Record<string, string>;
  /** GitHub items only: send the repo URL to the clerk / prefill the submit form. */
  onAssess?(g: GithubItem): void;
  onShelve?(g: GithubItem): void;
}) {
  const [i, setI] = useState(Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1)));
  const go = (d: number) => setI((x) => stepIndex(x, items.length, d));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    };
    // Capture phase + stopPropagation: the store canvas also walks on the arrow keys.
    const h = (e: KeyboardEvent) => { if (['Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { e.stopPropagation(); onKey(e); } };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  });
  const cur = items[i];
  if (!cur) return null;
  const { left, right } = neighbourWindow(items.length, i, PER_SIDE);
  const spine = (idx: number, far: boolean) => {
    const it = items[idx];
    const st = itemStars(it);
    return (
      <button key={itemKey(it)} className={'vhs-spine' + (far ? ' far' : '')} style={{ background: `hsl(${spineHue(itemKey(it))} 60% 50%)` }}
        onClick={() => setI(idx)} aria-label={itemTitle(it)}>
        <span className="sp-title">{shortTitle(it, 12)}</span>
        {st != null && <span className="sp-stars">★{formatStars(st)}</span>}
      </button>
    );
  };
  return (
    <div className="overlay browser" onClick={onClose}>
      <div className="browser-inner" onClick={(e) => e.stopPropagation()}>
        <button className="x" onClick={onClose} aria-label="close">X</button>
        <h3 className="browser-title">{title} · {positionLabel(i, items.length)}</h3>
        <div className="browser-row">
          <button className="btn alt arrow" onClick={() => go(-1)} aria-label="previous">◀</button>
          <div className="spines left">{left.map((idx, k) => spine(idx, k === 0 && left.length === PER_SIDE))}</div>
          <Cover item={cur} why={why?.[itemKey(cur)] || (isGithubItem(cur) ? cur.why : '')} onRent={onRent} onVote={onVote} onAssess={onAssess} onShelve={onShelve} />
          <div className="spines right">{right.map((idx, k) => spine(idx, k === right.length - 1 && right.length === PER_SIDE))}</div>
          <button className="btn alt arrow" onClick={() => go(1)} aria-label="next">▶</button>
        </div>
      </div>
    </div>
  );
}

function Cover({ item, why, onRent, onVote, onAssess, onShelve }: {
  item: BrowseItem; why: string; onRent(t: Tape): void; onVote(t: Tape): void; onAssess?(g: GithubItem): void; onShelve?(g: GithubItem): void;
}) {
  const st = itemStars(item);
  return (
    <div className="vhs-cover">
      <div className="vhs-top"><span className="badge">{isGithubItem(item) ? 'FOR YOU' : item.kind === 'repo' ? 'NEW RELEASE' : item.kind.toUpperCase()}</span>
        {!isGithubItem(item) && item.ring && <span className="sticker" style={{ background: RING_COLORS[item.ring] }}>{item.ring.toUpperCase()}</span>}
      </div>
      <h2>{itemTitle(item)}</h2>
      <div className="meta">
        {st != null && <span>★ {formatStars(st)}</span>}
        {!isGithubItem(item) && <span>{item.genre}</span>}
        {item.language && <span>{item.language}</span>}
        {isGithubItem(item) && item.license && <span>{item.license}</span>}
      </div>
      <p className="blurb">{isGithubItem(item) ? item.description ?? '' : item.blurb}</p>
      {why && <p className="why"><b>WHY FOR YOU:</b> {why}</p>}
      {isGithubItem(item) ? <GithubActions item={item} onAssess={onAssess} onShelve={onShelve} /> : <TapeActions tape={item} onRent={() => onRent(item)} onVote={() => onVote(item)} />}
    </div>
  );
}

function GithubActions({ item, onAssess, onShelve }: { item: GithubItem; onAssess?(g: GithubItem): void; onShelve?(g: GithubItem): void }) {
  const [copied, setCopied] = useState(false);
  const clone = () => {
    navigator.clipboard?.writeText(`git clone ${item.html_url}.git`).then(() => setCopied(true), () => {});
  };
  return (
    <div className="row">
      <button className="btn" onClick={clone}>{copied ? 'COPIED' : 'COPY CLONE'}</button>
      <a className="btn alt" href={item.html_url} target="_blank" rel="noreferrer noopener">OPEN ON GITHUB</a>
      {onAssess && <button className="btn alt" onClick={() => onAssess(item)}>ASSESS IT</button>}
      {onShelve && <button className="btn alt" onClick={() => onShelve(item)}>PUT ON COMMUNITY SHELF</button>}
    </div>
  );
}
