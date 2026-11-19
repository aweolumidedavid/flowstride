import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ensurePrivateDirectory, privateStatePath, readPrivateState, readPrivateStateBytes, removePrivateState, writePrivateState } from '../security/privateState';
import type { AttachmentType, RunAttachment, RunSummary, RunTest, SavedRun } from './run_history_types';

const folder = 'run-history';
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
export const archivedRunId = new RegExp('^[0-9]{13}-' + uuid + '$');
export const attachmentId = new RegExp('^' + uuid + '$');
export const attachmentLimit = 32 * 1024 * 1024;
const natural = z.number().int().nonnegative();
const status = z.enum(['passed', 'failed', 'skipped', 'timed_out', 'interrupted']);
const contentType = z.enum(['image/png', 'image/jpeg', 'video/webm', 'video/mp4', 'application/zip', 'application/json', 'text/plain']);
const summary = z.object({
  id: z.string().regex(archivedRunId),
  source: z.enum(['flowstride', 'playwright']),
  name: z.string(),
  status,
  startedAt: natural,
  duration: z.number().nonnegative(),
  counts: z.object({ total: natural, passed: natural, failed: natural, flaky: natural, other: natural }),
});
const savedRun = summary.extend({
  protocol: z.literal(1),
  errors: z.array(z.string()),
  omittedAttachments: natural.optional(),
  tests: z.array(z.object({
    id: z.string(),
    title: z.string(),
    file: z.string(),
    project: z.string().optional(),
    line: natural.optional(),
    outcome: z.enum([...status.options, 'flaky', 'expected_failure', 'not_run', 'blocked']),
    reason: z.string().optional(),
    attempts: z.array(z.object({
      number: natural,
      status,
      duration: z.number().nonnegative(),
      worker: natural.optional(),
      errors: z.array(z.string()),
      attachments: z.array(z.object({
        id: z.string().regex(attachmentId),
        name: z.string(),
        contentType,
        size: natural.max(attachmentLimit),
      })),
    })),
  })),
});

const reportPath = (id: string) => folder + '/' + id;

export function newRunId(startedAt = Date.now()): string {
  return String(startedAt).padStart(13, '0') + '-' + randomUUID();
}

export function countTests(tests: RunTest[]): RunSummary['counts'] {
  const counts = { total: tests.length, passed: 0, failed: 0, flaky: 0, other: 0 };
  for (const test of tests) {
    if (test.outcome === 'passed' || test.outcome === 'expected_failure') counts.passed++;
    else if (test.outcome === 'failed' || test.outcome === 'timed_out') counts.failed++;
    else if (test.outcome === 'flaky') counts.flaky++;
    else counts.other++;
  }
  return counts;
}

export function saveRunAttachment(root: string, runId: string, name: string, type: AttachmentType, body: Buffer): RunAttachment {
  if (!archivedRunId.test(runId) || body.length > attachmentLimit) throw new Error('Invalid report attachment.');
  const id = randomUUID();
  writePrivateState(root, reportPath(runId) + '/attachments/' + id, body);
  return { id, name, contentType: type, size: body.length };
}

export function saveRun(root: string, report: SavedRun): void {
  const meta = summary.parse(report);
  const directory = reportPath(meta.id);
  try {
    writePrivateState(root, directory + '/report.json', JSON.stringify(report));
    // The index entry is the commit point for attachments and report data.
    writePrivateState(root, directory + '/summary.json', JSON.stringify(meta));
  } catch (error) {
    try { discardRun(root, meta.id); } catch {}
    throw error;
  }
}

export function discardRun(root: string, id: string): void {
  if (archivedRunId.test(id)) removePrivateState(root, reportPath(id));
}

export function listSavedRuns(root: string): RunSummary[] {
  let names: string[];
  try {
    const directory = privateStatePath(root, folder);
    if (!fs.existsSync(directory)) return [];
    names = fs.readdirSync(ensurePrivateDirectory(root, folder), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && archivedRunId.test(entry.name)).map(entry => entry.name);
  } catch { return []; }

  const results: RunSummary[] = [];
  for (const id of names.sort().reverse()) {
    try {
      const text = readPrivateState(root, reportPath(id) + '/summary.json', 16384);
      if (!text) continue;
      const candidate = summary.safeParse(JSON.parse(text));
      if (candidate.success && candidate.data.id === id) results.push(candidate.data);
    } catch { /* An unreadable archive cannot hide the other runs. */ }
  }
  return results;
}

export function readSavedRun(root: string, id: string): SavedRun | undefined {
  if (!archivedRunId.test(id)) return;
  try {
    if (!readPrivateState(root, reportPath(id) + '/summary.json', 16384)) return;
    const text = readPrivateState(root, reportPath(id) + '/report.json');
    if (!text) return;
    const candidate = savedRun.safeParse(JSON.parse(text));
    if (candidate.success && candidate.data.id === id) return candidate.data;
  } catch { /* Invalid, damaged and unsafe archives are unavailable. */ }
}

export function readRunAttachment(root: string, runId: string, id: string) {
  if (!attachmentId.test(id)) return;
  const report = readSavedRun(root, runId);
  if (!report) return;
  for (const test of report.tests) for (const attempt of test.attempts) {
    const attachment = attempt.attachments.find(item => item.id === id);
    if (!attachment) continue;
    try {
      const body = readPrivateStateBytes(root, reportPath(runId) + '/attachments/' + id, attachmentLimit);
      if (body?.length === attachment.size) return { attachment, body };
    } catch { return; }
  }
}
