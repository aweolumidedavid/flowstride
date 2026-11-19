import { request } from 'undici';
import { z } from 'zod';
import type { StepNode } from '../parser/parser';
import type { FixtureTeardown } from '../types';
import { withDeadline } from '../ci/deadline';

export const CLEANUP_BUDGET_MS = 4000;

const registration = z.object({
  method: z.literal('DELETE'),
  url: z.string().min(1).max(4000),
}).strict();

export function cleanupRegistration(input: unknown): { method: 'DELETE'; url: string } {
  const data = registration.safeParse(input);
  if (!data.success) throw new Error('flow.cleanup.register requires method DELETE and a URL.');
  return data.data;
}

/** Substitutions stay within their URL component so IDs cannot change the request path or query. */
export function resolveCleanupTarget(template: string, resolve: (component: string) => string): string {
  return template.split(/([/?#&=])/).map((component, index) => {
    if (index % 2 || !component) return component;
    const value = resolve(component);
    if (value !== component && (!value.trim() || /[/?#&=\\]/.test(value))) {
      throw new Error('A cleanup URL variable must resolve to a nonempty URL component.');
    }
    return value;
  }).join('');
}

type CleanupEntry =
  | { step: StepNode; url: URL; headers: Record<string, string> }
  | { fixture: FixtureCleanup; release: FixtureTeardown; handoff?: string };

export async function runFixtureTeardown(release: FixtureTeardown, timeout: number): Promise<void> {
  const controller = new AbortController();
  try {
    await withDeadline(Promise.resolve().then(() => release(controller.signal)), timeout);
  } finally {
    controller.abort();
  }
}

export interface FixtureCleanup {
  name: string;
  scope: 'attempt' | 'worker';
  handoff?: string;
  fileName: string;
  sourceLine: number;
  scenario: string;
  attempt: number;
}

export type CleanupOutcome =
  | { step: StepNode; status?: number; error?: string }
  | { fixture: FixtureCleanup; error?: string };

const unsafeHeader = /^(?:host|connection|upgrade|transfer-encoding|content-length|expect|te|trailer|keep-alive|proxy-.*)$/i;

/** Cleanup is restricted to the application's configured origin. */
function cleanupURL(baseUrl: string | undefined, value: string): URL {
  if (!baseUrl) throw new Error('flow.cleanup.register requires a configured application baseUrl.');
  const base = new URL(baseUrl);
  const rawPath = value.split('?')[0];
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash ||
      /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value) ||
      value.startsWith('//') || /[\\\x00-\x20\x7f@#{}]/.test(value) ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c|%25/i.test(rawPath)) {
    throw new Error('Cleanup requires a resolved HTTP(S) URL without credentials, traversal or fragments.');
  }
  const url = new URL(/^https?:\/\//i.test(value)
    ? value
    : `${baseUrl.replace(/\/$/, '')}${value.startsWith('/') ? value : '/' + value}`);
  if (url.origin !== base.origin || url.username || url.password) {
    throw new Error('Cleanup can send requests only to the configured application origin.');
  }
  return url;
}

/** Each scenario attempt owns its queue, including on retries and cooperative cancellation. */
export class ScenarioCleanup {
  private entries: CleanupEntry[] = [];
  private result?: Promise<CleanupOutcome[]>;

  constructor(private readonly baseUrl: string | undefined) {}

  register(step: StepNode, input: unknown, headers: Record<string, string>): void {
    if (this.result) throw new Error('This scenario has already started cleanup.');
    if (this.entries.filter(entry => 'url' in entry).length >= 32) throw new Error('A scenario attempt can register at most 32 cleanup requests.');
    const data = cleanupRegistration(input);
    const url = cleanupURL(this.baseUrl, data.url);
    const captured = Object.fromEntries(Object.entries(headers).filter(([name]) => !unsafeHeader.test(name)));
    this.entries.push({ step, url, headers: captured });
  }

  defer(fixture: FixtureCleanup, release: FixtureTeardown, handoff?: string): void {
    if (this.result) throw new Error('This scope has already started cleanup.');
    this.entries.push({ fixture: handoff ? { ...fixture, handoff } : fixture, release, handoff });
  }

  transferTo(target: ScenarioCleanup, handoffs?: ReadonlySet<string>): void {
    if (this.result || target.result) throw new Error('Cannot transfer resources after cleanup starts.');
    this.entries = this.entries.filter(entry => {
      if (handoffs && !('handoff' in entry && entry.handoff && handoffs.has(entry.handoff))) return true;
      target.entries.push(entry);
      return false;
    });
  }

  get hasEntries(): boolean {
    return this.entries.length > 0;
  }

  drain(): Promise<CleanupOutcome[]> {
    return this.result ??= this.execute();
  }

  private async execute(): Promise<CleanupOutcome[]> {
    const deadline = Date.now() + CLEANUP_BUDGET_MS;
    const outcomes: CleanupOutcome[] = [];
    const entries = [...this.entries].reverse();
    for (const [index, entry] of entries.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        if ('fixture' in entry) outcomes.push({ fixture: entry.fixture, error: 'Cleanup deadline expired before this callback could start.' });
        else outcomes.push({ step: entry.step, error: 'Cleanup deadline expired before the request could start.' });
        continue;
      }
      if ('release' in entry) {
        try {
          // Leave time for earlier resources even when a user callback stalls.
          const timeout = Math.max(1, Math.min(2000, Math.floor(remaining / (entries.length - index))));
          await runFixtureTeardown(entry.release, timeout);
          outcomes.push({ fixture: entry.fixture });
        } catch (error) {
          const reason = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Callback rejected with a non-Error value.';
          outcomes.push({ fixture: entry.fixture, error: reason || 'Callback failed without an error message.' });
        }
        continue;
      }
      const { step, url, headers } = entry;
      const signal = AbortSignal.timeout(Math.min(2000, remaining));
      try {
        const response = await request(url, {
          method: 'DELETE',
          headers,
          signal,
        });
        // Cleanup only needs response status. Do not retain the response body or follow redirects.
        response.body.on('error', () => {});
        response.body.destroy();
        const status = response.statusCode;
        outcomes.push({
          step,
          status,
          ...(status < 200 || status >= 300 ? { error: `Cleanup DELETE returned HTTP ${status}. Expected a 2xx response.` } : {}),
        });
      } catch {
        const timedOut = signal.aborted;
        outcomes.push({ step, error: timedOut ? 'Cleanup DELETE timed out.' : 'Cleanup DELETE could not reach the application.' });
      }
    }
    this.entries = [];
    return outcomes;
  }
}
