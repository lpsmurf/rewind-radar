import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API, API_ABS } from './api';
import type { Aisle, ClerkReply, Proposal, Tape, Visitor } from '../types';
import { GENRES } from '../types';
import { MOCK_TAPES } from '../data/mock';
import { sb } from './supabase';
import { canSignIn, clerkHeaders, gateReply, memberOf, type Member } from './clerkGate';
import { clearGithub, getGithub, getVisitor, setGithub } from './visitor';

const COLS =
  'id,kind,slug,title,genre,blurb,source_url,stars,language,ring,rating,trust,submitter,rentals,created_at';

/** A skill written by someone else: we link to its source rather than serve its text. */
export function isLinkedSkill(t: Tape): boolean {
  return (t.kind === 'skill' || t.kind === 'memory') && !!t.source_url;
}

function rentCommand(t: Tape): string {
  if (t.kind === 'skill' || t.kind === 'memory') {
    return `mkdir -p ~/.claude/skills/${t.slug} && curl -fsSL ${API_ABS}/tape/${t.slug} -o ~/.claude/skills/${t.slug}/SKILL.md`;
  }
  return `git clone ${t.source_url ?? ''}`;
}

export function useStore() {
  const meRef = useRef<Visitor>(getVisitor());
  const [aisle, setAisleState] = useState<Aisle>('entrance');
  const [tapes, setTapes] = useState<Tape[]>(sb ? [] : MOCK_TAPES);
  const [visitors, setVisitors] = useState<Visitor[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const backedRef = useRef<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [github, setGithubState] = useState<string | null>(getGithub);
  const githubRef = useRef<string | null>(github);
  githubRef.current = github;
  const [member, setMember] = useState<Member | null>(null);
  const memberRef = useRef<Member | null>(null);
  memberRef.current = member;
  const chanRef = useRef<ReturnType<NonNullable<typeof sb>['channel']> | null>(null);
  const toastTimer = useRef<number>();

  const say = useCallback((m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const me = useMemo<Visitor>(() => ({ ...meRef.current, aisle }), [aisle]);

  // The Supabase session (GitHub sign-in): lets members use the clerk with higher limits.
  useEffect(() => {
    if (!sb) return;
    let dead = false;
    sb.auth.getSession().then(({ data }) => {
      if (!dead) setMember(memberOf(data.session));
    });
    const { data } = sb.auth.onAuthStateChange((_e, session) => setMember(memberOf(session)));
    return () => {
      dead = true;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!sb) return;
    const c = sb;
    let dead = false;
    (async () => {
      const [tr, vr] = await Promise.all([
        c.from('tapes').select(COLS).eq('archived', false).order('created_at', { ascending: false }).limit(500),
        c.from('tape_votes').select('tape_id,votes'),
      ]);
      if (dead) return;
      const vm = new Map<string, number>((vr.data ?? []).map((r: any) => [r.tape_id, r.votes]));
      setTapes(((tr.data ?? []) as any[]).map((t) => ({ ...t, votes: vm.get(t.id) ?? 0 }) as Tape));
      const pr = await c.from('proposals').select('id,kind,title,pitch,link,submitter,genre,votes,created_at').order('votes', { ascending: false }).order('created_at', { ascending: false }).limit(100);
      if (!dead) setProposals((pr.data ?? []) as Proposal[]);
    })();

    const ch = c.channel('store', { config: { presence: { key: meRef.current.id } } });
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'votes' }, (p: any) => {
      if (p.new?.visitor_id === meRef.current.id) return; // our own vote was already counted optimistically
      const id = p.new?.tape_id;
      setTapes((ts) => ts.map((t) => (t.id === id ? { ...t, votes: t.votes + 1 } : t)));
    });
    const upsert = (p: any) => {
      const n = p.new;
      if (!n?.id) return;
      if (n.archived) return setTapes((ts) => ts.filter((t) => t.id !== n.id)); // retired New Release
      setTapes((ts) => {
        const i = ts.findIndex((t) => t.id === n.id);
        if (i < 0) return [{ ...n, votes: 0 }, ...ts];
        const copy = ts.slice();
        copy[i] = { ...ts[i], ...n, votes: ts[i].votes };
        return copy;
      });
    };
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'tapes' }, upsert);
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tapes' }, upsert);
    const upsertProposal = (p: any) => {
      const n = p.new as Proposal;
      if (!n?.id) return;
      setProposals((ps) => {
        const i = ps.findIndex((x) => x.id === n.id);
        const next = i < 0 ? [n, ...ps] : ps.map((x) => (x.id === n.id ? { ...x, ...n } : x));
        return next.sort((a, b) => b.votes - a.votes || b.created_at.localeCompare(a.created_at));
      });
    };
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'proposals' }, upsertProposal);
    ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'proposals' }, upsertProposal);
    ch.on('presence', { event: 'sync' }, () => {
      const st = ch.presenceState() as Record<string, any[]>;
      setVisitors(
        Object.entries(st)
          .filter(([k]) => k !== meRef.current.id)
          .map(([k, v]) => ({ id: k, name: v[0]?.name, color: v[0]?.color, aisle: v[0]?.aisle ?? 'entrance' })),
      );
    });
    ch.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') {
        setLive(true);
        const m = meRef.current;
        ch.track({ name: m.name, color: m.color, aisle: 'entrance' });
      }
    });
    chanRef.current = ch;
    return () => {
      dead = true;
      c.removeChannel(ch);
      chanRef.current = null;
      setLive(false);
    };
  }, []);

  const setAisle = useCallback((a: Aisle) => {
    setAisleState(a);
    const m = meRef.current;
    chanRef.current?.track({ name: m.name, color: m.color, aisle: a });
  }, []);

  const bump = (id: string, k: 'votes' | 'rentals') =>
    setTapes((ts) => ts.map((t) => (t.id === id ? { ...t, [k]: t[k] + 1 } : t)));

  const vote = useCallback(
    async (t: Tape) => {
      if (!sb) {
        bump(t.id, 'votes');
        return;
      }
      bump(t.id, 'votes');
      const { error } = await sb.from('votes').insert({ visitor_id: meRef.current.id, tape_id: t.id });
      if (error) {
        setTapes((ts) => ts.map((x) => (x.id === t.id ? { ...x, votes: Math.max(0, x.votes - 1) } : x)));
        say(error.code === '23505' ? 'Already voted for this one this week' : 'Vote failed');
      }
    },
    [say],
  );

  const rent = useCallback(
    async (t: Tape) => {
      if (isLinkedSkill(t)) {
        // Third-party skill: send people to the original instead of copying someone else's work.
        window.open(t.source_url!, '_blank', 'noopener,noreferrer');
        say(`Opening the original${t.submitter ? ` by ${t.submitter}` : ''}. Be kind, rewind.`);
      } else {
        try {
          await navigator.clipboard.writeText(rentCommand(t));
        } catch {
          /* clipboard blocked */
        }
        say('Copied! Be kind, rewind.');
      }
      if (sb) {
        const { error } = await sb.from('rentals').insert({ tape_id: t.id, visitor_id: meRef.current.id });
        if (!error) bump(t.id, 'rentals');
      } else bump(t.id, 'rentals');
    },
    [say],
  );

  const submit = useCallback(
    async (f: { title: string; url: string; note: string; submitter: string }): Promise<boolean> => {
      try {
        const r = await fetch(`${API}/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...f, visitorId: meRef.current.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          say(j.error || 'Submit failed');
          return false;
        }
        const t = { ...j, votes: 0 } as Tape;
        setTapes((ts) => (ts.some((x) => x.id === t.id) ? ts : [t, ...ts]));
        setHighlighted(new Set([t.id]));
        setAisle('community');
        say('Tape accepted! It is on the community shelf.');
        return true;
      } catch {
        say('Submit failed');
        return false;
      }
    },
    [say, setAisle],
  );

  const askClerk = useCallback(
    async (q: string): Promise<ClerkReply> => {
      const onBreak = (answer = 'The clerk is on break.'): ClerkReply => ({ answer, slugs: [], aisle: 'counter' });
      try {
        const r = await fetch(`${API}/clerk`, {
          method: 'POST',
          headers: clerkHeaders(memberRef.current),
          body: JSON.stringify({ question: q, visitorId: meRef.current.id, ...(githubRef.current ? { github: githubRef.current } : {}) }),
        });
        const j = await r.json().catch(() => ({}));
        const gate = gateReply(r.status, j, !!githubRef.current);
        if (gate) {
          if (gate.forget) {
            clearGithub();
            setGithubState(null);
          }
          return onBreak(gate.line);
        }
        if (!r.ok) return onBreak(j.error || undefined);
        const slugs: string[] = [...(j.slugs ?? []), ...(j.in_store ? [j.in_store] : [])];
        setHighlighted(new Set(tapesRef.current.filter((t) => slugs.includes(t.slug)).map((t) => t.id)));
        const valid = ['new', 'community', 'counter', 'entrance', ...GENRES];
        if (valid.includes(j.aisle)) setAisle(j.aisle as Aisle);
        return { ...j, answer: j.answer ?? '', slugs: j.slugs ?? [], aisle: j.aisle ?? 'counter' } as ClerkReply;
      } catch {
        return onBreak();
      }
    },
    [setAisle],
  );

  const scanProfile = useCallback(
    async (github: string): Promise<string> => {
      try {
        const r = await fetch(`${API}/profile`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ github, visitorId: meRef.current.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return j.error || 'The clerk is on break.';
        if (j.kind === 'user' && typeof j.name === 'string' && j.name) {
          setGithub(j.name);
          setGithubState(j.name);
        }
        const picks: { slug: string; why: string }[] = j.picks ?? [];
        const slugs = picks.map((p) => p.slug);
        setHighlighted(new Set(tapesRef.current.filter((t) => slugs.includes(t.slug)).map((t) => t.id)));
        const valid = ['new', 'community', 'counter', 'entrance', ...GENRES];
        if (valid.includes(j.aisle)) setAisle(j.aisle as Aisle);
        const title = (slug: string) => tapesRef.current.find((t) => t.slug === slug)?.title ?? slug;
        return [`RADAR FOR ${String(j.name ?? github).toUpperCase()}: ${j.answer ?? ''}`, ...picks.map((p) => `★ ${title(p.slug)} — ${p.why}`)].join('\n');
      } catch {
        return 'The clerk is on break.';
      }
    },
    [setAisle],
  );

  const propose = useCallback(
    async (f: { title: string; pitch: string; link: string; submitter: string }): Promise<string | null> => {
      if (!sb) return 'Proposals need the live store';
      try {
        const r = await fetch(`${API}/propose`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...f, visitorId: meRef.current.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return j.error || 'Could not send your proposal';
        setProposals((ps) => (ps.some((x) => x.id === j.id) ? ps : [...ps, j as Proposal]));
        say('In the Request Box! Rally some votes.');
        return null;
      } catch {
        return 'Could not send your proposal';
      }
    },
    [say],
  );

  const backProposal = useCallback(
    async (p: Proposal) => {
      if (!sb) return;
      if (backedRef.current.has(p.id)) return say('You already backed this one');
      backedRef.current.add(p.id);
      setProposals((ps) => ps.map((x) => (x.id === p.id ? { ...x, votes: x.votes + 1 } : x)));
      const { error } = await sb.from('proposal_votes').insert({ visitor_id: meRef.current.id, proposal_id: p.id });
      if (error) {
        setProposals((ps) => ps.map((x) => (x.id === p.id ? { ...x, votes: Math.max(0, x.votes - 1) } : x)));
        say(error.code === '23505' ? 'You already backed this one' : 'Vote failed');
      }
    },
    [say],
  );

  const connectGithub = useCallback((u: string) => {
    const login = u.trim().replace(/^@/, '');
    if (!login) return;
    setGithub(login);
    setGithubState(login);
  }, []);

  const signIn = useCallback(async () => {
    if (!sb) return;
    const { error } = await sb.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: location.origin + location.pathname } });
    if (error) say('GitHub sign-in is not available right now');
  }, [say]);

  const signOut = useCallback(async () => {
    await sb?.auth.signOut();
    setMember(null);
  }, []);

  const forgetGithub = useCallback(() => {
    clearGithub();
    setGithubState(null);
  }, []);

  const tapesRef = useRef<Tape[]>(tapes);
  tapesRef.current = tapes;

  const top10 = useMemo(
    () => tapes.slice().sort((a, b) => b.votes - a.votes || (b.stars ?? 0) - (a.stars ?? 0)).slice(0, 10),
    [tapes],
  );

  return { tapes, top10, visitors, me, setAisle, vote, rent, submit, askClerk, scanProfile, github, forgetGithub, connectGithub, memberLogin: member?.login ?? null, member, canSignIn: canSignIn(import.meta.env.VITE_GITHUB_SIGNIN, !!sb), signIn, signOut, proposals, propose, backProposal, highlighted, toast, live };
}
