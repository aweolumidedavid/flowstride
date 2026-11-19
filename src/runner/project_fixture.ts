import { withDeadline } from '../ci/deadline';
import { runFixtureTeardown } from '../native/scenario_cleanup';
import { name as profileName } from '../native/validation';
import type { FixtureContext, FixtureTeardown, FlowstrideConfig } from '../types';

export const FIXTURE_CANCEL_GRACE_MS = 1000;
export interface FixtureRelease { release: FixtureTeardown; handoff?: string }

export async function setupFixture(
  config: FlowstrideConfig,
  cancellation: AbortSignal,
  releases: FixtureRelease[],
  profiles: Map<string, unknown> | undefined,
  invoke: (fixture: FixtureContext) => Promise<unknown>,
  handoffs?: ReadonlySet<string>,
  attempt?: number,
): Promise<unknown> {
  const timeout = new AbortController();
  const signal = AbortSignal.any([cancellation, timeout.signal]);
  const ms = config.timeout;
  const timer = setTimeout(() => timeout.abort(new Error(`Fixture setup exceeded its ${ms}ms timeout.`)), ms);
  let accepting = true;

  const fixture: FixtureContext = {
    baseURL: config.baseUrl,
    ...(attempt === undefined ? {} : { attempt }),
    signal,
    defer(release, options) {
      if (typeof release !== 'function') throw new Error('Fixture defer requires a cleanup function.');
      if (accepting) {
        const handoff = options?.handoff;
        if (handoff !== undefined && !handoffs?.has(handoff)) {
          releases.push({ release });
          throw new Error('Fixture cleanup can follow only a handoff published by this scenario.');
        }
        releases.push({ release, handoff });
      } else if (signal.aborted) {
        // A resource acquired by a late, uncooperative setup still needs release.
        void runFixtureTeardown(release, 2000).catch(() => {});
      } else {
        throw new Error('Register cleanup during fixture setup.');
      }
    },
    profile(name, options) {
      signal.throwIfAborted();
      if (!accepting) throw new Error('Declare browser profiles during fixture setup.');
      if (!profiles) throw new Error('Browser profiles belong to scenario-attempt fixtures.');
      const key = profileName.parse(name);
      if (key === 'default' || profiles.has(key)) throw new Error(`Fixture browser profile "${key}" is already declared or reserved.`);
      profiles.set(key, options);
    },
  };

  const operation = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return invoke(fixture);
  });
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const value = await Promise.race([operation, interrupted]);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    if (signal.aborted) {
      // Give cooperative setup a chance to finish registering its resources.
      try {
        await withDeadline(operation.then(() => undefined, () => undefined), FIXTURE_CANCEL_GRACE_MS);
      } catch {
        releases.push({ release: () => { throw new Error('Fixture setup did not stop after cancellation.'); } });
      }
      throw signal.reason;
    }
    throw error;
  } finally {
    accepting = false;
    signal.removeEventListener('abort', onAbort);
    clearTimeout(timer);
  }
}
