import { admin } from './admin.ts';
import { AssessError, assessRepoAI, costUsd, fitForVisitor, sanitizeUntrusted, type OnUsage } from './ai.ts';
import { candidates } from './catalog.ts';
import { env } from './env.ts';
import { fetchProfile, fetchRepoFacts, repoExists, type RepoFacts, type RepoRef } from './github.ts';
import type { Assessment, Fit, GateKey, HealthSignals, Ring, RepoSummary } from '../src/types.ts';

export { sanitizeUntrusted }; // lives in ai.ts (assess.ts imports ai.ts, not the other way round)

/** Bump when the assessment prompt or schema changes: older cached rows are then re-assessed. */
export const PROMPT_VERSION = 1;
export const ASSESS_TTL_DAYS = 7;

export class RateLimitError extends Error {}
export class BudgetError extends Error {}

type Usage = Parameters<OnUsage>[1];

// ---------- signals computed in code, never by the model ----------
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MPL-2.0', 'Unlicense', '0BSD', 'CC0-1.0', 'Zlib']);

const daysSince = (iso: string, now: number, fallback: number) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / 864e5) : fallback;
};

export function healthSignals(f: RepoFacts, now = Date.now()): HealthSignals {
  const days_since_push = daysSince(f.pushed_at, now, 9999); // unknown (empty repo) counts as stale
  const licence_kind: HealthSignals['licence_kind'] = !f.license
    ? 'none'
    : PERMISSIVE.has(f.license)
      ? 'permissive'
      : /^(A?GPL|LGPL|EUPL)/.test(f.license)
        ? 'copyleft'
        : 'other';
  const load = f.open_issues / Math.max(f.stars, 1);
  return {
    days_since_push,
    active: days_since_push <= 90 && !f.archived,
    licence: f.license,
    licence_kind,
    archived: f.archived,
    stars: f.stars,
    forks: f.forks,
    open_issues: f.open_issues,
    issue_load: load > 0.2 ? 'high' : load > 0.05 ? 'medium' : 'low',
    age_days: daysSince(f.created_at, now, 0),
  };
}

// ---------- model output -> safe Assessment ----------
const RINGS: Ring[] = ['adopt', 'trial', 'assess', 'hold'];
const GATES: GateKey[] = ['licence', 'maintenance', 'security', 'cost', 'lockin'];
const AI_RISK = 'README contains text aimed at AI reviewers; treat with caution.';

const text = (v: unknown, max = 300) => (typeof v === 'string' ? v : '').slice(0, max);
const list = (v: unknown, max = 6) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string').slice(0, max).map((x) => text(x));

/** Clamp and repair what the model returned; never trust its enums, lengths or slugs. */
export function normalizeAssessment(raw: unknown, knownSlugs: string[]): Assessment {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const known = new Set(knownSlugs);
  const conf = Number(r.confidence);
  const gates = Object.fromEntries(
    GATES.map((k) => {
      const g = r.gates?.[k];
      return [k, g && typeof g.ok === 'boolean' ? { ok: g.ok, note: text(g.note) } : { ok: false, note: 'not assessed' }];
    }),
  ) as Assessment['gates'];
  const aiDirected = r.ai_directed_text === true;
  const risks = list(r.risks);
  return {
    title: text(r.title),
    what: text(r.what, 700),
    ring: aiDirected ? 'hold' : RINGS.includes(r.ring) ? r.ring : 'assess',
    confidence: Number.isNaN(conf) ? 0.5 : Math.min(1, Math.max(0, conf)),
    plain: text(r.plain),
    benefits: list(r.benefits),
    risks: aiDirected ? [AI_RISK, ...risks].slice(0, 6) : risks,
    gates,
    effort: ['S', 'M', 'L'].includes(r.effort) ? r.effort : 'M',
    overlaps: (Array.isArray(r.overlaps) ? r.overlaps : [])
      .filter((o: any) => o && typeof o.slug === 'string' && known.has(o.slug))
      .slice(0, 3)
      .map((o: any) => ({ slug: o.slug as string, why: text(o.why) })),
    steps: list(r.steps),
    evidence: list(r.evidence),
    ai_directed_text: aiDirected,
  };
}

// ---------- spend meter ----------
/**
 * False once today's AI spend has reached AI_DAILY_BUDGET_USD. If the meter is unavailable it fails open,
 * or closed with `failClosed` (use that before any Sonnet call).
 */
export async function budgetLeft(o: { failClosed?: boolean } = {}): Promise<boolean> {
  const cap = Number(env('AI_DAILY_BUDGET_USD') || '5');
  try {
    const { data, error } = await admin().rpc('ai_spend_today');
    if (error) throw error;
    return Number(data ?? 0) < cap;
  } catch (e) {
    console.warn(`[budget] spend meter unavailable, ${o.failClosed ? 'blocking' : 'allowing'}`, e);
    return !o.failClosed;
  }
}

/**
 * Database-backed caps on new Sonnet assessments, shared by every Edge isolate: assessments per hour, and
 * assess spend per UTC day (its own, smaller budget than the clerk's). Fails closed if the query breaks.
 */
async function checkAssessLimits(): Promise<void> {
  const now = Date.now();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const maxPerHour = Number(env('AI_ASSESS_MAX_PER_HOUR') || '20');
  const budget = Number(env('AI_ASSESS_BUDGET_USD') || '2');
  let rows: { at: string; cost_usd: number }[];
  try {
    const { data, error } = await admin().from('ai_usage').select('at,cost_usd').eq('route', 'assess').gte('at', dayStart.toISOString());
    if (error) throw error;
    rows = (data ?? []) as typeof rows;
  } catch (e) {
    console.warn('[assess] usage query failed, blocking', e);
    throw new BudgetError();
  }
  if (rows.filter((r) => now - Date.parse(r.at) < 3600_000).length >= maxPerHour) throw new RateLimitError();
  if (rows.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0) >= budget) throw new BudgetError();
}

/** Log one Anthropic call to ai_usage and return its cost. Never throws. */
export async function recordUsage(route: string, model: string, usage: Usage, repo?: string): Promise<number> {
  const cost = costUsd(model, usage);
  try {
    const { error } = await admin().from('ai_usage').insert({
      route,
      model,
      repo: repo ?? null,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: cost,
    });
    if (error) console.warn('[usage]', error.message);
  } catch (e) {
    console.warn('[usage]', e);
  }
  return cost;
}

// ---------- the assessment service ----------
export interface AssessmentResult {
  assessment: Assessment;
  repo: RepoSummary;
  reviewed_at: string;
  cached: boolean;
  stale?: boolean;
}

interface Row { data: Assessment; facts: RepoSummary; updated_at: string; prompt_version: number; hits: number | null }

const fromRow = (row: Row, stale = false): AssessmentResult => ({
  assessment: row.data,
  repo: row.facts,
  reviewed_at: row.updated_at,
  cached: true,
  ...(stale ? { stale: true } : {}),
});

/**
 * Cached for ASSESS_TTL_DAYS. A miss costs one GitHub read and one Sonnet call, so it must pass `allowMiss`
 * (per-IP limit), the database hourly/assess-budget caps and the daily budget; if any of them says no, or the
 * refresh breaks, an old row is served as stale (RateLimitError/BudgetError only when there is no row).
 * null = GitHub has no such repo. A bare owner/repo is verified to exist first.
 */
export async function getAssessment(ref: RepoRef, o: { allowMiss: () => boolean }): Promise<AssessmentResult | null> {
  const key = ref.full.toLowerCase();
  const { data, error } = await admin().from('assessments').select('data,facts,prompt_version,updated_at,hits').eq('repo', key).maybeSingle();
  if (error) throw new Error(`assessments read failed: ${error.message}`); // never treat a broken cache as a miss
  const row = (data ?? null) as Row | null;

  if (row && row.prompt_version === PROMPT_VERSION && Date.now() - Date.parse(row.updated_at) < ASSESS_TTL_DAYS * 864e5) {
    await admin().from('assessments').update({ hits: (row.hits ?? 0) + 1 }).eq('repo', key);
    return fromRow(row);
  }

  // A bare "owner/repo" is only a guess ("tcp/ip"): make sure it is real before it costs any quota or budget.
  if (ref.bare && !row) {
    const { data: tape, error: tapeErr } = await admin()
      .from('tapes')
      .select('slug')
      .in('slug', [`gh-${key.replace('/', '-')}`, `c-${key.replace('/', '-')}`])
      .limit(1)
      .maybeSingle();
    if (!tapeErr && !tape && !(await repoExists(ref))) return null;
  }

  if (!o.allowMiss()) {
    if (row) return fromRow(row, true);
    throw new RateLimitError();
  }
  if (!(await budgetLeft({ failClosed: true }))) {
    if (row) return fromRow(row, true);
    throw new BudgetError();
  }
  try {
    await checkAssessLimits();
  } catch (e) {
    if (row) return fromRow(row, true);
    throw e;
  }

  try {
    const facts = await fetchRepoFacts(ref);
    if (!facts) return null;
    const signals = healthSignals(facts);
    const cands = await candidates(`${facts.full_name} ${facts.description ?? ''} ${facts.topics.join(' ')}`, 20);
    const { raw, usage, model } = await assessRepoAI(facts, signals, facts.readme, cands);
    const assessment = normalizeAssessment(raw, cands.map((c) => c.slug));
    const repo: RepoSummary = {
      full_name: facts.full_name,
      html_url: facts.html_url,
      description: facts.description,
      language: facts.language,
      topics: facts.topics,
      stars: facts.stars,
      forks: facts.forks,
      license: facts.license,
      pushed_at: facts.pushed_at,
      archived: facts.archived,
      open_issues: facts.open_issues,
      signals,
    };
    const cost = await recordUsage('assess', model, usage, key);
    const reviewed_at = new Date().toISOString();
    const { error } = await admin().from('assessments').upsert({
      repo: key,
      data: assessment,
      facts: repo,
      model,
      prompt_version: PROMPT_VERSION,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: cost,
      hits: 1,
      updated_at: reviewed_at,
    });
    if (error) console.warn('[assess] could not cache', error.message); // the visitor still gets the answer we paid for
    return { assessment, repo, reviewed_at, cached: false };
  } catch (e) {
    // A refusal, cut-off or unreadable answer still cost tokens: count them toward both budgets.
    if (e instanceof AssessError && e.usage && e.model) await recordUsage('assess', e.model, e.usage, key);
    if (row) {
      console.warn('[assess] refresh failed, serving stale', e);
      return fromRow(row, true);
    }
    throw e;
  }
}

// ---------- personal fit ----------
const profiles = new Map<string, { at: number; text: string }>();

/** How well a repo suits a visitor's connected GitHub profile. null on anything wrong: it is a bonus, never an error. */
export async function personalFit(a: Assessment, repoName: string, github: string): Promise<Fit | null> {
  const user = github.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9-]{1,39}$/.test(user)) return null;
  try {
    if (!(await budgetLeft())) return null;
    const id = user.toLowerCase();
    let profile = profiles.get(id);
    if (!profile || Date.now() - profile.at > 3600_000) {
      const p = await fetchProfile(user);
      if (!p || p.kind !== 'user') return null;
      profile = { at: Date.now(), text: p.text };
      profiles.set(id, profile);
    }
    const used: [string, Usage][] = [];
    try {
      return await fitForVisitor(a, repoName, profile.text, (m, u) => used.push([m, u]));
    } finally {
      for (const [m, u] of used) await recordUsage('fit', m, u, repoName.toLowerCase());
    }
  } catch (e) {
    console.warn('[fit]', e);
    return null;
  }
}
