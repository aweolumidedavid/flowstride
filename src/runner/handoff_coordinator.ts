import { randomUUID } from 'node:crypto';
import { flowIdentity } from '../utils/projectPaths';
import type { HandoffInput, HandoffValue } from '../native/handoff';
import type { HandoffJob } from '../native/handoff_plan';

export interface HandoffAssignment {
  job: HandoffJob;
  inputs: Record<string, HandoffInput>;
}

export interface HandoffResult {
  passed: boolean;
  outputs?: Record<string, HandoffValue>;
}

export interface HandoffWorkerSource {
  next(): Promise<HandoffAssignment | undefined>;
  done(result: HandoffResult): void;
  cancel(reason: string): void;
}

export interface HandoffStatus {
  fileName: string;
  status: 'waiting' | 'ready' | 'blocked';
  reason?: string;
}

type StoredOutput = { value: unknown; worker: string; reference?: string };

export class HandoffCoordinator {
  private readonly pending: Map<string, HandoffJob>;
  private readonly owners = new Map<string, HandoffJob>();
  private readonly running = new Map<string, HandoffJob>();
  private readonly finished = new Set<string>();
  private readonly outputs = new Map<string, StoredOutput>();
  private readonly credentials = new Map<string, Record<string, string>>();
  private readonly requests = new Map<string, (assignment?: HandoffAssignment) => void>();
  private readonly lostWorkers = new Set<string>();
  private cancelled = false;
  public failed = false;

  constructor(jobs: HandoffJob[], private readonly root: string, private readonly emit: (event: HandoffStatus) => void) {
    this.pending = new Map(jobs.map(job => [job.file, job]));
    for (const job of jobs) for (const name of job.publishes) this.owners.set(name, job);
    for (const job of jobs) {
      const waitingFor = this.prerequisiteNames(job.receives);
      if (waitingFor.length) this.status(job, 'waiting', 'Waiting for ' + waitingFor.join(', '));
    }
  }

  source(worker: string): HandoffWorkerSource {
    return {
      next: () => this.next(worker),
      done: result => this.finish(worker, result),
      cancel: reason => this.cancel(reason),
    };
  }

  cancel(reason: string): void {
    this.cancelled = true;
    this.unblockOrBlock();
    for (const job of this.pending.values()) this.block(job, reason);
    this.dispatch();
  }

  workerLost(worker: string): void {
    this.lostWorkers.add(worker);
    for (const [name, output] of this.outputs) {
      if (output.worker !== worker) continue;
      if (output.reference) this.credentials.delete(output.reference);
      this.outputs.delete(name);
    }
    this.failed = true;
    this.finish(worker, { passed: false });
    this.dispatch();
  }

  clear(): void {
    this.outputs.clear();
    this.credentials.clear();
  }

  private prerequisiteNames(names: string[]): string[] {
    return [...new Set(names.map(name => flowIdentity(this.owners.get(name)!.file, this.root)))];
  }

  private status(job: HandoffJob, status: HandoffStatus['status'], reason?: string): void {
    this.emit({ fileName: flowIdentity(job.file, this.root), status, ...(reason && { reason }) });
  }

  private block(job: HandoffJob, reason: string): void {
    this.pending.delete(job.file);
    this.finished.add(job.file);
    this.failed = true;
    this.status(job, 'blocked', reason);
  }

  private unblockOrBlock(): HandoffJob | undefined {
    // Detect terminal failures to a fixed point, including chains appearing before their owners in the queue.
    let removed = true;
    while (removed) {
      removed = false;
      for (const job of this.pending.values()) {
        const missing = job.receives.filter(name => !this.outputs.has(name) && this.finished.has(this.owners.get(name)!.file));
        if (!missing.length) continue;
        this.block(job, 'Blocked because ' + this.prerequisiteNames(missing).join(', ') + ' did not complete successfully with the required handoff.');
        removed = true;
      }
    }
    const setup = (job: HandoffJob) => job.file.endsWith('.first.flow') && !job.publishes.length && !job.receives.length;
    if ([...this.running.values()].some(setup)) return;
    const waiting = [...this.pending.values()];
    return waiting.find(setup) ?? waiting.find(job => job.receives.every(name => this.outputs.has(name)));
  }

  private next(worker: string): Promise<HandoffAssignment | undefined> {
    if (this.lostWorkers.has(worker)) return Promise.resolve(undefined);
    return new Promise(resolve => {
      this.requests.set(worker, resolve);
      this.dispatch();
    });
  }

  private dispatch(): void {
    for (const [worker, resolve] of this.requests) {
      if (this.lostWorkers.has(worker)) {
        this.requests.delete(worker);
        resolve();
        continue;
      }
      const job = this.unblockOrBlock();
      if (!job && this.running.size) continue;
      this.requests.delete(worker);
      if (!job) {
        resolve();
        continue;
      }
      this.pending.delete(job.file);
      this.running.set(worker, job);
      if (job.receives.length) this.status(job, 'ready');
      const inputs = Object.fromEntries(job.receives.map(name => {
        const { value, reference } = this.outputs.get(name)!;
        const protectedCredentials = reference
          ? { reference, values: job.credentialInputs.includes(name) ? this.credentials.get(reference) : undefined }
          : undefined;
        return [name, { value, protectedCredentials }];
      }));
      resolve({ job, inputs });
    }
  }

  private finish(worker: string, result: HandoffResult): void {
    const job = this.running.get(worker);
    if (!job) return;
    this.running.delete(worker);
    this.finished.add(job.file);
    this.failed ||= !result.passed;
    if (result.passed && !this.cancelled) {
      for (const name of job.publishes) {
        if (!result.outputs || !Object.hasOwn(result.outputs, name)) continue;
        const output = result.outputs[name]!;
        const reference = output.credentials ? randomUUID() : undefined;
        if (reference) this.credentials.set(reference, output.credentials!);
        this.outputs.set(name, { value: output.value, worker, reference });
      }
    }
    this.dispatch();
  }

}
