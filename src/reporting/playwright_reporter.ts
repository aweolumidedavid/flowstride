import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult } from 'playwright/types/testReporter';
import { loadNativeConfig } from '../ci/config';
import { readBoundedProjectFile } from '../native/project_data';
import { exportEvidence, screenshotEvidence } from '../security/evidence';
import { attachmentLimit, countTests, discardRun, newRunId, saveRun, saveRunAttachment } from './run_history';
import type { AttachmentType, RunAttachment, RunAttempt, RunStatus, RunTest, TestOutcome } from './run_history_types';
import { reportText } from './report_text';

type AttachmentKind = 'screenshot' | 'video' | 'trace' | 'text';

export interface PlaywrightReporterOptions {
  name?: string;
  attachments?: AttachmentKind[];
  redactEnv?: string[];
}

const media = new Map<string, AttachmentKind>([
  ['image/png', 'screenshot'], ['image/jpeg', 'screenshot'],
  ['video/webm', 'video'], ['video/mp4', 'video'],
  ['application/zip', 'trace'], ['application/json', 'text'], ['text/plain', 'text'],
]);
const runEvidenceLimit = 128 * 1024 * 1024;
const textLimit = 256 * 1024;

function hasMediaHeader(type: AttachmentType, body: Buffer) {
  switch (type) {
    case 'image/png': return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg': return body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
    case 'video/webm': return body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case 'video/mp4': return body.toString('ascii', 4, 8) === 'ftyp';
    case 'application/zip': return body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    default: return false;
  }
}

function attemptStatus(status: TestResult['status']): RunStatus {
  return status === 'timedOut' ? 'timed_out' : status;
}

function outcomeFor(test: TestCase, attempts: RunAttempt[]): TestOutcome {
  const last = attempts.at(-1);
  if (!last) return 'not_run';
  if (last.status === 'interrupted' || last.status === 'timed_out') return last.status;
  switch (test.outcome()) {
    case 'flaky': return 'flaky';
    case 'skipped': return 'skipped';
    case 'unexpected': return 'failed';
    default: return last.status === 'failed' ? 'expected_failure' : 'passed';
  }
}

export default class FlowstridePlaywrightReporter implements Reporter {
  private readonly root = process.cwd();
  private readonly options: PlaywrightReporterOptions;
  private runId = newRunId();
  private readonly tests = new Set<TestCase>();
  private readonly captured = new Map<TestResult, RunAttachment[]>();
  private readonly errors: TestError[] = [];
  private readonly enabled = new Set<AttachmentKind>();
  private text: ReturnType<typeof reportText>;
  private evidenceBytes = 0;
  private omitted = 0;

  constructor(options: PlaywrightReporterOptions = {}) {
    this.options = options || {};
    this.text = reportText(this.root, Array.isArray(this.options.redactEnv) ? this.options.redactEnv : []);
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    for (const test of suite.allTests()) this.tests.add(test);
    try {
      const policy = loadNativeConfig(this.root, {});
      this.text = reportText(this.root, [
        ...(Array.isArray(this.options.redactEnv) ? this.options.redactEnv : []),
        ...(Array.isArray(policy.security?.sensitiveKeys) ? policy.security.sensitiveKeys : []),
      ]);
      for (const kind of Array.isArray(this.options.attachments) ? this.options.attachments : []) this.enabled.add(kind);
      if (!screenshotEvidence(policy)) this.enabled.delete('screenshot');
      if (policy.recordVideo === false) this.enabled.delete('video');
      if (policy.trace === false) this.enabled.delete('trace');
    } catch {
      console.warn('[Flowstride] Could not load evidence settings. Attachments will be omitted.');
    }
  }

  onError(error: TestError): void {
    this.errors.push(error);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.tests.add(test);
    if (!this.enabled.size || !result.attachments.length) return;

    const copied: RunAttachment[] = [];
    for (const input of result.attachments) {
      const mime = input.contentType.split(';', 1)[0]!.trim().toLowerCase();
      const kind = media.get(mime);
      if (!kind || !this.enabled.has(kind) || (kind === 'trace' && input.name !== 'trace')) continue;
      try {
        const type = mime as AttachmentType;
        const body = this.attachmentBytes(input, type, kind);
        if (body.length > runEvidenceLimit - this.evidenceBytes) throw new Error('Run evidence budget is exhausted.');
        const name = this.text.clean(input.name, 300) || 'Attachment';
        copied.push(saveRunAttachment(this.root, this.runId, name, type, body));
        this.evidenceBytes += body.length;
      } catch {
        this.omitted++;
      }
    }
    if (copied.length) this.captured.set(result, copied);
  }

  onEnd(result: FullResult): void {
    try {
      const tests = [...this.tests].map((test, index) => this.testRecord(test, index));
      const status = result.status === 'timedout' ? 'timed_out' : result.status;
      saveRun(this.root, {
        protocol: 1,
        id: this.runId,
        source: 'playwright',
        name: (typeof this.options.name === 'string' && this.text.clean(this.options.name, 200)) || 'Playwright Test',
        status,
        startedAt: result.startTime.getTime(),
        duration: result.duration,
        counts: countTests(tests),
        tests,
        errors: this.errors.map(error => this.errorText(error)).filter(Boolean),
        ...(this.omitted && { omittedAttachments: this.omitted }),
      });
    } catch {
      try { discardRun(this.root, this.runId); } catch {}
      // Reporter failures must leave Playwright's result and other reporters alone.
      console.warn('[Flowstride] Could not save the Playwright run report.');
    } finally {
      this.captured.clear();
      this.errors.length = 0;
      this.tests.clear();
      this.enabled.clear();
      this.evidenceBytes = 0;
      this.omitted = 0;
      this.runId = newRunId();
    }
  }

  private errorText(error: TestError): string {
    return this.text.clean(error.stack || error.message || error.value || error.snippet || '');
  }

  private testRecord(test: TestCase, index: number): RunTest {
    const attempts = test.results.map(entry => ({
      number: entry.retry + 1,
      status: attemptStatus(entry.status),
      duration: Math.max(0, entry.duration),
      ...(entry.workerIndex >= 0 && { worker: entry.workerIndex }),
      errors: entry.errors.map(error => this.errorText(error)).filter(Boolean),
      attachments: this.captured.get(entry) || [],
    }));
    const relative = path.relative(this.root, test.location.file);
    const file = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
      ? path.basename(test.location.file)
      : relative.split(path.sep).join('/');
    const project = test.parent.project()?.name;
    return {
      id: 'test-' + (index + 1),
      title: this.text.clean(test.titlePath().slice(3).join(' › ') || test.title, 2000),
      file: this.text.clean(file, 2000),
      ...(project && { project: this.text.clean(project, 300) }),
      line: test.location.line,
      outcome: outcomeFor(test, attempts),
      attempts,
    };
  }

  private attachmentBytes(input: TestResult['attachments'][number], type: AttachmentType, kind: AttachmentKind): Buffer {
    const limit = kind === 'text' ? textLimit : attachmentLimit;
    const body = Buffer.isBuffer(input.body)
      ? input.body
      : input.path ? readBoundedProjectFile({ projectRoot: this.root }, input.path, limit) : undefined;
    if (!body || body.length > limit) throw new Error('Attachment is missing or too large.');
    if (kind === 'text') {
      const text = new TextDecoder('utf8', { fatal: true }).decode(body);
      const clean = type === 'application/json'
        ? JSON.stringify(exportEvidence(JSON.parse(text), this.text.secrets), null, 2)
        : this.text.clean(text, textLimit);
      return Buffer.from(clean);
    }
    if (!hasMediaHeader(type, body)) throw new Error('Attachment does not match its media type.');
    return body;
  }
}
