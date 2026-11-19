import { useEffect, useState } from 'react';
import type { RunSummary, SavedRun, TestOutcome } from '../../../reporting/run_history_types';
import './run-history.css';

const labels: Record<TestOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  timed_out: 'Timed out',
  skipped: 'Skipped',
  interrupted: 'Interrupted',
  flaky: 'Flaky',
  expected_failure: 'Expected failure',
  not_run: 'Not run',
  blocked: 'Blocked',
};

const sourceLabel = (source: RunSummary['source']) => source === 'playwright' ? 'Playwright' : 'Flowstride';
const time = (duration: number) => duration < 1000 ? Math.round(duration) + ' ms' : (duration / 1000).toFixed(1) + ' s';

async function load<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) throw new Error('Report could not be loaded.');
  return response.json() as Promise<T>;
}

function Status({ value }: { value: TestOutcome }) {
  return <span className="history-status" data-status={value}>{labels[value]}</span>;
}

function Diagnostics({ errors }: { errors: string[] }) {
  return errors.map((error, index) => <pre key={index} className="history-diagnostic">{error}</pre>);
}

function Report({ report }: { report: SavedRun }) {
  return (
    <article className="history-detail" aria-label="Run details">
      <header className="history-run-heading">
        <div>
          <p className="history-muted">{sourceLabel(report.source)} · {new Date(report.startedAt).toLocaleString()}</p>
          <h2>{report.name}</h2>
        </div>
        <Status value={report.status} />
      </header>
      <div className="history-totals">
        <span>{report.counts.total} tests</span>
        <span>{report.counts.passed} passed</span>
        <span>{report.counts.failed} failed</span>
        <span>{report.counts.flaky} flaky</span>
        {report.counts.other > 0 && <span>{report.counts.other} skipped or incomplete</span>}
        <span>{time(report.duration)}</span>
      </div>
      {report.errors.length > 0 && (
        <section className="history-errors" aria-label="Run errors">
          <h3>Run errors</h3>
          <Diagnostics errors={report.errors} />
        </section>
      )}
      {!!report.omittedAttachments && (
        <p className="history-muted">{report.omittedAttachments} requested attachments could not be saved.</p>
      )}
      {report.tests.length === 0 && <p className="history-muted">No tests were recorded for this run.</p>}
      {report.tests.map(test => (
        <details key={test.id} className="history-test">
          <summary>
            <span className="history-test-name">
              <strong>{test.title}</strong>
              <span className="history-muted">
                {test.project && test.project + ' · '}{test.file}{test.line ? ':' + test.line : ''}
              </span>
            </span>
            <span className="history-test-metadata">
              {test.attempts.length > 0 && <span>{test.attempts.length} {test.attempts.length === 1 ? 'attempt' : 'attempts'}</span>}
              <Status value={test.outcome} />
            </span>
          </summary>
          <div className="history-attempts">
            {test.reason && <p>{test.reason}</p>}
            {test.attempts.map(attempt => (
              <section key={attempt.number} className="history-attempt" aria-label={'Attempt ' + attempt.number}>
                <div className="history-attempt-heading">
                  <strong>Attempt {attempt.number}</strong>
                  <Status value={attempt.status} />
                  <span className="history-muted">
                    {time(attempt.duration)}{attempt.worker === undefined ? '' : ' · Worker ' + (attempt.worker + 1)}
                  </span>
                </div>
                <Diagnostics errors={attempt.errors} />
                {attempt.attachments.length > 0 && (
                  <ul className="history-attachments">
                    {attempt.attachments.map(attachment => (
                      <li key={attachment.id}>
                        <a href={'/api/run-history/' + report.id + '/attachments/' + attachment.id} download>
                          {attachment.name}
                        </a>
                        <small>{Math.max(1, Math.round(attachment.size / 1024))} KB</small>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </details>
      ))}
    </article>
  );
}

export function RunHistoryView() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [source, setSource] = useState<RunSummary['source'] | ''>('');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [detailError, setDetailError] = useState(false);
  const [report, setReport] = useState<SavedRun>();
  const filtered = source ? runs.filter(run => run.source === source) : runs;
  const activeId = filtered.find(run => run.id === selected)?.id || filtered[0]?.id;

  useEffect(() => {
    const controller = new AbortController();
    setListError(false);
    setLoading(true);
    void load<{ runs: RunSummary[] }>('/api/run-history', controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setRuns(data.runs);
    }).catch(() => {
      if (!controller.signal.aborted) setListError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [version]);

  useEffect(() => {
    const controller = new AbortController();
    setReport(undefined);
    setDetailError(false);
    if (activeId) {
      void load<SavedRun>('/api/run-history/' + encodeURIComponent(activeId), controller.signal).then(data => {
        if (!controller.signal.aborted) setReport(data);
      }).catch(() => {
        if (!controller.signal.aborted) setDetailError(true);
      });
    }
    return () => controller.abort();
  }, [activeId, version]);

  return (
    <main className="run-history">
      <header className="history-header">
        <h1>Saved runs</h1>
        <div className="history-actions">
          <label>
            Source
            <select value={source} onChange={event => setSource(event.target.value as typeof source)}>
              <option value="">All runs</option>
              <option value="playwright">Playwright</option>
              <option value="flowstride">Flowstride</option>
            </select>
          </label>
          <button type="button" onClick={() => setVersion(value => value + 1)}>Refresh</button>
        </div>
      </header>
      <div className="history-layout">
        <nav className="history-sidebar" aria-label="Saved test runs">
          {loading && <p role="status" className="history-muted">Loading runs…</p>}
          {listError && <p role="alert">Could not load saved runs.</p>}
          {!loading && !listError && filtered.length === 0 && (
            <p className="history-muted">{source ? 'No runs from this source.' : 'No saved runs yet.'}</p>
          )}
          {filtered.map(run => (
            <button key={run.id} type="button" className="history-item"
              aria-pressed={activeId === run.id} onClick={() => setSelected(run.id)}>
              <span className="history-item-source">{sourceLabel(run.source)}</span>
              <strong>{run.name}</strong>
              <span className="history-item-footer">
                <time dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString()}</time>
                <Status value={run.status} />
              </span>
            </button>
          ))}
        </nav>
        {detailError && <p role="alert">Could not load this run.</p>}
        {report && report.id === activeId && <Report key={report.id} report={report} />}
        {!report && !detailError && activeId && <p role="status" className="history-muted">Loading run details…</p>}
      </div>
    </main>
  );
}
