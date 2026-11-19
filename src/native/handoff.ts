import { dataSecrets } from './project_data';
import { dataSnapshot } from './paths';
import type { FlowstrideConfig } from '../types';

export { handoffPattern, parseHandoff, type HandoffCommand } from '../parser/workflow_contract';

/** Payloads for the private in-process/IPC scheduler only. */
export interface HandoffValue {
  value: unknown;
  credentials?: Record<string, string>;
}

export interface HandoffInput {
  value: unknown;
  protectedCredentials?: { reference: string; values?: Record<string, string> };
}

export function snapshotHandoff(value: unknown, credentials?: Record<string, unknown>): HandoffValue {
  const snapshot = dataSnapshot(value);
  if (!credentials || Object.keys(credentials).length === 0) return { value: snapshot };
  const values: Record<string, string> = Object.create(null);
  const serialized = JSON.stringify(snapshot);
  for (const [key, secret] of Object.entries(dataSnapshot(credentials) as Record<string, unknown>)) {
    if (typeof secret !== 'string' || secret.length < 4 || secret.length > 16384) {
      throw new Error('A protected credential must resolve to a string of 4–16384 characters so it can be masked.');
    }
    if (serialized.includes(JSON.stringify(secret).slice(1, -1))) {
      throw new Error('Put protected credentials only in the credentials object.');
    }
    values[key] = secret;
  }
  return { value: snapshot, credentials: values };
}

export function handoffSecrets(input: HandoffValue): string[] {
  return [...dataSecrets(input.value), ...Object.values(input.credentials || {})]
    .flatMap(value => [value, encodeURIComponent(Buffer.from(value).toString('utf8')), Buffer.from(value).toString('base64')]);
}

/** Keep automatic browser artifacts out of a run carrying credentials. */
export function protectHandoffEvidence(config: FlowstrideConfig, practiceFrames = false): () => void {
  const previous = {
    protectedHandoff: config.protectedHandoff,
    practiceDashboardOrigin: config.practiceDashboardOrigin,
    recordVideo: config.recordVideo,
    trace: config.trace,
    har: config.har,
    domSnapshots: config.domSnapshots,
    security: config.security,
  };
  Object.assign(config, {
    protectedHandoff: true,
    practiceDashboardOrigin: practiceFrames ? config.practiceDashboardOrigin : undefined,
    recordVideo: false,
    trace: false,
    har: false,
    domSnapshots: false,
    security: { ...config.security, evidence: { ...config.security?.evidence, screenshots: false, cloudVideo: false } },
  });
  return () => { Object.assign(config, previous); };
}
