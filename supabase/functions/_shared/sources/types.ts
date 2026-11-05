import type { OnUsage } from '../ai.ts';

/** What a source found: a repo or skill, with where it was featured. `repo` may be `owner/repo` or a github.com URL; it is verified before queueing. */
export interface Candidate {
  repo: string;
  kind: 'repo' | 'skill';
  title?: string;
  why?: string;
  credit_url?: string;
  credit_title?: string;
  credit_author?: string;
}

export interface SourceCtx {
  /** Report every Anthropic call's usage; the pipeline records it under route `source:<name>`. */
  onUsage: OnUsage;
  /** False once today's AI budget is spent: stop before the next paid call. */
  budget: () => Promise<boolean>;
  /** A row of source_config (e.g. 'youtube', 'web'), or null when absent. */
  config: (key: string) => Promise<unknown>;
  now: Date;
}

/** A place to find repos. `name` must be one of the ingest_queue.source values ('github' | 'youtube' | 'web' | 'manual'). */
export interface Source {
  name: string;
  run(ctx: SourceCtx): Promise<Candidate[]>;
}

export interface SourceSummary {
  name: string;
  found: number;
  queued: number;
  cost_usd: number;
  error?: string;
}
