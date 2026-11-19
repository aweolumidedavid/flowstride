import fs from 'node:fs';
import path from 'node:path';
import type { NativeRunResult } from '../ci/runtime';
import { readBoundedProjectFile } from '../native/project_data';
import { projectPath } from '../utils/projectPaths';
import { countTests, newRunId, saveRun } from './run_history';
import type { RunStatus, RunTest, SavedRun, TestOutcome } from './run_history_types';
import { reportText } from './report_text';

export const latestNativeId = 'latest-flowstride';

interface NativeAttempt {
  fileName: string;
  scenario: string;
  attempt: number;
  status: RunStatus;
  duration: number;
  flaky?: boolean;
  skipReason?: string;
  dataCase?: { index: number };
  steps?: { status: string; error?: string; assertion?: { reason?: string } }[];
}

type NativeHistoryInput = NativeRunResult & { attempts?: NativeAttempt[] };

function asSavedRun(root: string, result: NativeHistoryInput, startedAt: number, id: string): SavedRun {
  const { clean } = reportText(root);
  const tests: RunTest[] = [];
  const current = new Map<string, RunTest>();
  const covered = new Set<string>();

  for (const entry of result.attempts || []) {
    if (!entry || typeof entry.fileName !== 'string' || typeof entry.scenario !== 'string') continue;
    covered.add(entry.fileName);
    const dataCase = entry.dataCase?.index;
    const key = JSON.stringify([entry.fileName, entry.scenario, dataCase]);
    let test = current.get(key);
    if (!test || entry.attempt === 1) {
      test = {
        id: 'test-' + (tests.length + 1),
        title: clean(entry.scenario + (dataCase === undefined ? '' : ' · Case ' + dataCase), 2000),
        file: clean(entry.fileName, 2000),
        outcome: entry.status,
        attempts: [],
      };
      tests.push(test);
      current.set(key, test);
    }
    test.outcome = entry.flaky && entry.status === 'passed' ? 'flaky' : entry.status;
    if (typeof entry.skipReason === 'string') test.reason = clean(entry.skipReason);
    const errors = (entry.steps || [])
      .filter(step => step?.status === 'failed')
      .flatMap(step => {
        const message = step.error || step.assertion?.reason;
        return typeof message === 'string' ? [clean(message)] : [];
      });
    test.attempts.push({
      number: entry.attempt,
      status: entry.status,
      duration: entry.duration,
      errors,
      attachments: [],
    });
  }

  const fallback = new Map<string, RunTest>();
  for (const step of result.steps) {
    if (!step || typeof step.fileName !== 'string' || covered.has(step.fileName)) continue;
    const outcomes: Record<string, TestOutcome> = {
      blocked: 'blocked', skipped: 'skipped', failed: 'failed', passed: 'passed',
    };
    const outcome = Object.hasOwn(outcomes, step.status) ? outcomes[step.status]! : 'not_run';
    let test = fallback.get(step.fileName);
    if (!test) {
      const file = clean(step.fileName, 2000);
      test = { id: 'test-' + (tests.length + 1), file, title: file, outcome, attempts: [] };
      fallback.set(step.fileName, test);
      tests.push(test);
    }
    if (outcome === 'failed' || test.outcome === 'not_run') test.outcome = outcome;
    const diagnostic = step.error || step.skipReason;
    if (typeof diagnostic === 'string') {
      test.reason = clean(diagnostic);
    }
  }

  return {
    id, source: 'flowstride', protocol: 1, status: result.status, startedAt, duration: result.duration,
    name: result.files.length === 1 ? clean(String(result.files[0]), 2000) : 'Flowstride suite',
    counts: countTests(tests), tests,
    errors: result.errors.filter(error => typeof error === 'string').map(error => clean(error)),
  };
}

export function archiveNativeRun(root: string, result: NativeHistoryInput, startedAt: number): void {
  saveRun(root, asSavedRun(root, result, startedAt, newRunId(startedAt)));
}

export function readLatestNativeRun(root: string, directory = 'flowstride-artifacts'): SavedRun | undefined {
  try {
    const file = projectPath(root, path.join(directory, 'summary.json'));
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(readBoundedProjectFile({ projectRoot: root }, file, 32 * 1024 * 1024).toString('utf8')) as NativeHistoryInput;
    if (data?.protocol !== 1 || !['passed', 'failed', 'skipped', 'interrupted'].includes(data.status) ||
        typeof data.duration !== 'number' || data.duration < 0 || !Array.isArray(data.steps) ||
        !Array.isArray(data.files) || !Array.isArray(data.errors)) return;
    const started = Math.max(0, Math.round(fs.statSync(file).mtimeMs - data.duration));
    return asSavedRun(root, data, started, latestNativeId);
  } catch { return undefined; }
}
