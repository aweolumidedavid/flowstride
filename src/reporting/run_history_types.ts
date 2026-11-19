export type RunSource = 'flowstride' | 'playwright';
export type RunStatus = 'passed' | 'failed' | 'skipped' | 'timed_out' | 'interrupted';
export type TestOutcome = RunStatus | 'flaky' | 'expected_failure' | 'not_run' | 'blocked';

export type AttachmentType = 'image/png' | 'image/jpeg' | 'video/webm' | 'video/mp4' |
  'application/zip' | 'application/json' | 'text/plain';

export interface RunAttachment {
  id: string;
  name: string;
  contentType: AttachmentType;
  size: number;
}

export interface RunAttempt {
  number: number;
  status: RunStatus;
  duration: number;
  worker?: number;
  errors: string[];
  attachments: RunAttachment[];
}

export interface RunTest {
  id: string;
  title: string;
  file: string;
  project?: string;
  line?: number;
  outcome: TestOutcome;
  attempts: RunAttempt[];
  reason?: string;
}

export interface RunSummary {
  id: string;
  source: RunSource;
  name: string;
  status: RunStatus;
  startedAt: number;
  duration: number;
  counts: { total: number; passed: number; failed: number; flaky: number; other: number };
}

export interface SavedRun extends RunSummary {
  protocol: 1;
  tests: RunTest[];
  errors: string[];
  omittedAttachments?: number;
}
