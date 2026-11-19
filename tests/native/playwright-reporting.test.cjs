const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { chromium } = require('playwright');
const { listSavedRuns, readSavedRun, readRunAttachment } = require('../../dist/reporting/run_history');
const { historyCatalog } = require('../../dist/reporting/run_history_server');

const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const { name: engine } = require('../../package.json');
const guide = path.join(root, 'examples/native-workflows/playwright-reporting');
const runner = path.join(root, 'node_modules/playwright/cli.js');
const cli = path.join(root, 'dist/cli/index.js');
const marker = 'flowstride-test-redaction-value-284';
const env = { ...process.env, CI: 'true', FLOWSTRIDE_TOKEN: '', QA_REPORT_VALUE: marker };

function project(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowstride-playwright-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(guide, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"type":"commonjs"}');
  for (const [name, target] of [[engine, root], ['playwright', path.dirname(runner)]]) {
    const link = path.join(dir, 'node_modules', name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return dir;
}

async function execute(dir, entry, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [entry, ...args], {
      cwd: dir, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return { code: error.code, output: error.stdout + error.stderr };
  }
}

function configure(dir, options, playwright = {}) {
  const config = {
    testDir: './specs',
    reporter: [['list'], [engine + '/playwright-reporter', options]],
    ...playwright,
  };
  fs.writeFileSync(path.join(dir, 'playwright.config.cjs'), 'module.exports = ' + JSON.stringify(config));
}

function spec(dir, filename, source) {
  fs.writeFileSync(path.join(dir, 'specs', filename + '.spec.cjs'), source);
}

function report(dir) {
  const [latest] = listSavedRuns(dir);
  assert.ok(latest, 'Playwright should save a readable catalog entry');
  const details = readSavedRun(dir, latest.id);
  assert.ok(details, 'The catalog entry should open a valid detailed report');
  return details;
}

async function reportUrl(t, dir) {
  const child = spawn(process.execPath, [cli, 'report', '--no-open'], {
    cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      let output = '';
      const onData = data => {
        output += data;
        const match = /http:\/\/127\.0\.0\.1:\d+\/run-reports/.exec(output);
        if (match) resolve(match[0]);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Report CLI exited ' + code + '\n' + output)));
      timer = setTimeout(() => reject(new Error('Report CLI did not print its URL\n' + output)), 10000);
    });
  } finally {
    clearTimeout(timer);
  }
}

test('Playwright fixtures, parallel execution, retry evidence and shared helper appear in Saved runs', { timeout: 90000 }, async t => {
  const dir = project(t);
  configure(dir, {
    name: 'Catalog Playwright', attachments: ['screenshot', 'text', 'video', 'trace'],
    redactEnv: ['QA_REPORT_VALUE'],
  }, {
    fullyParallel: true, workers: 2, retries: 1, timeout: 20000,
    use: { trace: 'on-first-retry', video: 'on' },
  });
  spec(dir, 'fixture-retry', [
    "const fs = require('node:fs');",
    "const { test: base, expect } = require('playwright/test');",
    "const test = base.extend({ tag: [async ({}, use, worker) => use(worker.workerIndex), { scope: 'worker' }] });",
    "const overlap = async name => {",
    "  fs.mkdirSync('workers', { recursive: true });",
    "  fs.writeFileSync('workers/' + name, 'ready');",
    "  await expect.poll(() => fs.readdirSync('workers').length).toBe(2);",
    "};",
    "test('parallel companion', async ({ tag }) => {",
    "  await overlap('companion');",
    "  expect(tag).toBeGreaterThanOrEqual(0);",
    "});",
    "test('retries with browser evidence', async ({ page, tag }, info) => {",
    "  await overlap('retry');",
    "  await page.setContent('<h1>Checkout evidence</h1>');",
    "  const screenshot = info.outputPath('checkout.png');",
    "  await page.screenshot({ path: screenshot });",
    "  await info.attach('Checkout screenshot', { path: screenshot, contentType: 'image/png' });",
    "  await info.attach('Retry details', { body: JSON.stringify({ tag, retry: info.retry, password: 'fake-private-value', note: process.env.QA_REPORT_VALUE }), contentType: 'application/json' });",
    "  await info.attach('Browser log', { body: 'fixture ready ' + process.env.QA_REPORT_VALUE, contentType: 'text/plain' });",
    "  await info.attach('Ignored HTML', { body: '<h1>Complete</h1>', contentType: 'text/html' });",
    "  await info.attach('Invalid image', { body: 'not a PNG', contentType: 'image/png' });",
    "  console.log('stdout omitted from Flowstride archive');",
    "  if (!info.retry) throw new Error('Planned retry ' + process.env.QA_REPORT_VALUE);",
    "  await expect(page.getByRole('heading', { name: 'Checkout evidence' })).toBeVisible();",
    "});",
  ].join('\n'));

  const playwright = await execute(dir, runner, ['test']);
  assert.equal(playwright.code, 0, playwright.output);
  assert.match(playwright.output, /1 flaky/);
  const captured = report(dir);
  assert.equal(captured.status, 'passed');
  assert.equal(captured.source, 'playwright');
  assert.deepEqual(captured.counts, { total: 3, passed: 2, failed: 0, flaky: 1, other: 0 });
  const retry = captured.tests.find(row => row.title === 'retries with browser evidence');
  assert.equal(retry.file, 'specs/fixture-retry.spec.cjs');
  assert.equal(retry.outcome, 'flaky');
  assert.deepEqual(retry.attempts.map(attempt => [attempt.number, attempt.status]), [[1, 'failed'], [2, 'passed']]);
  assert.notEqual(retry.attempts[0].worker, captured.tests.find(row => row.title === 'parallel companion').attempts[0].worker);
  assert.match(retry.attempts[0].errors.join('\n'), /Planned retry/);
  assert.equal(captured.omittedAttachments, 2);
  const redactedReport = JSON.stringify(captured);
  for (const text of [marker, dir, 'stdout omitted from Flowstride archive']) assert.ok(!redactedReport.includes(text));

  // Playwright can remove or replace its output directory on the next run.
  fs.rmSync(path.join(dir, 'test-results'), { recursive: true, force: true });
  const [first, second] = retry.attempts;
  const attachment = (attempt, type) => {
    const item = attempt.attachments.find(value => value.contentType === type);
    assert.ok(item, 'Expected a saved ' + type + ' attachment');
    const saved = readRunAttachment(dir, captured.id, item.id);
    assert.ok(saved);
    return saved;
  };
  const screenshot = attachment(first, 'image/png');
  assert.equal(screenshot.body.subarray(1, 4).toString(), 'PNG');
  assert.equal(attachment(second, 'application/zip').body.subarray(0, 2).toString(), 'PK');
  assert.equal(attachment(second, 'video/webm').body.readUInt32BE(), 0x1a45dfa3);
  const json = JSON.parse(attachment(first, 'application/json').body);
  assert.equal(json.tag, first.worker);
  assert.equal(json.retry, 0);
  assert.notEqual(json.password, 'fake-private-value');
  assert.notEqual(json.note, marker);
  const plainText = attachment(first, 'text/plain').body.toString();
  assert.match(plainText, /fixture ready/);
  assert.ok(!plainText.includes(marker));
  if (process.platform !== 'win32') {
    const archive = path.join(dir, '.flowstride/run-history', captured.id);
    assert.equal(fs.statSync(archive).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(archive, 'attachments', screenshot.attachment.id)).mode & 0o777, 0o600);
  }

  const native = await execute(dir, cli, ['run', 'flows/discounts.flow', '--ci']);
  if (native.code !== 0) {
    const summary = path.join(dir, 'flowstride-artifacts/summary.json');
    assert.fail(native.output + (fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : ''));
  }
  const [flowRun] = listSavedRuns(dir).filter(run => run.source === 'flowstride');
  assert.equal(flowRun.status, 'passed');
  const nativeReport = readSavedRun(dir, flowRun.id);
  assert.equal(nativeReport.tests[0].title, 'Apply the catalog discount in cents');

  const url = await reportUrl(t, dir);
  const origin = new URL(url).origin;
  const route = origin + '/api/run-history';
  const rejected = await fetch(route, { headers: { Origin: 'https://report-client.example.test' } });
  assert.equal(rejected.status, 403);
  const deniedWrite = await fetch(route, { method: 'POST' });
  assert.equal(deniedWrite.status, 405);
  const wrongRun = await fetch(route + '/' + flowRun.id + '/attachments/' + screenshot.attachment.id);
  assert.equal(wrongRun.status, 404);
  const downloadUrl = route + '/' + captured.id + '/attachments/' + screenshot.attachment.id;
  const response = await fetch(downloadUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), screenshot.body);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const details = page.getByRole('article', { name: 'Run details' });
    await page.goto(url);
    await page.getByRole('heading', { name: 'Saved runs' }).waitFor();
    await page.getByRole('button', { name: /Catalog Playwright/ }).click();
    await details.getByText('retries with browser evidence').click();
    await details.getByRole('region', { name: 'Attempt 1' }).getByText('Planned retry', { exact: false }).waitFor();
    await details.getByRole('region', { name: 'Attempt 2' }).getByText('Passed', { exact: true }).waitFor();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      details.getByRole('region', { name: 'Attempt 1' }).getByRole('link', { name: 'Checkout screenshot' }).click(),
    ]);
    assert.match(download.suggestedFilename(), /\.png$/);
    await page.getByLabel('Source').selectOption('flowstride');
    await details.getByText('Apply the catalog discount in cents').waitFor();
    assert.equal(await page.getByRole('button', { name: /Catalog Playwright/ }).count(), 0);
  } finally {
    await browser.close();
  }
});

test('Unsuccessful runs retain the Playwright exit code and individual test outcomes', { timeout: 90000 }, async t => {
  const dir = project(t);
  configure(dir, {}, { workers: 1 });
  spec(dir, 'outcomes', [
    "const { test, expect } = require('playwright/test');",
    "test('deliberate failure', () => { throw new Error('intentional failure'); });",
    "test('expected failure', () => { test.fail(); expect(false).toBe(true); });",
    "test.skip('skipped case', () => {});",
    "test('timed out', async () => { test.setTimeout(250); await new Promise(resolve => setTimeout(resolve, 2000)); });",
  ].join('\n'));
  const args = ['test', 'outcomes.spec.cjs'];
  const baseline = await execute(dir, runner, [...args, '--reporter=list']);
  const withReporter = await execute(dir, runner, args);
  assert.equal(baseline.code, 1, baseline.output);
  assert.equal(withReporter.code, baseline.code, withReporter.output);
  assert.deepEqual(listSavedRuns(dir).map(run => run.status), ['failed']);
  const outcomes = report(dir).tests;
  assert.deepEqual(outcomes.map(row => row.outcome), ['failed', 'expected_failure', 'skipped', 'timed_out']);
  assert.match(outcomes[0].attempts[0].errors.join('\n'), /intentional failure/);
});

test('Attachments are opt-in and respect the project evidence settings', { timeout: 90000 }, async t => {
  const dir = project(t);
  spec(dir, 'evidence', [
    "const { test } = require('playwright/test');",
    "test('attaches permitted evidence', async ({ page }, info) => {",
    "  await page.setContent('<h1>Evidence</h1>');",
    "  await info.attach('Screenshot', { body: await page.screenshot(), contentType: 'image/png' });",
    "  await info.attach('Notes', { body: 'fixture passage', contentType: 'text/plain' });",
    "});",
  ].join('\n'));
  const args = ['test', 'evidence.spec.cjs'];
  let result = await execute(dir, runner, args);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(report(dir).tests[0].attempts[0].attachments, []);

  fs.writeFileSync(path.join(dir, 'flowstride.config.json'), JSON.stringify({
    recordVideo: false, trace: false, security: { evidence: { screenshots: false } },
  }));
  configure(dir, { attachments: ['screenshot', 'video', 'trace', 'text'] }, { use: { video: 'on', trace: 'on' } });
  result = await execute(dir, runner, args);
  assert.equal(result.code, 0, result.output);
  const attachments = report(dir).tests[0].attempts[0].attachments;
  assert.deepEqual(attachments.map(item => item.name), ['Notes']);
});

test('Saved runs can open the most recent older Flowstride CI report', t => {
  const dir = project(t);
  const legacy = path.join(dir, 'custom-ci-results');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'summary.json'), JSON.stringify({
    protocol: 1, status: 'passed', duration: 21, files: ['flows/discounts.flow'], errors: [],
    steps: [{ fileName: 'flows/discounts.flow', status: 'passed' }],
  }));
  const [entry] = historyCatalog(dir, legacy);
  assert.equal(entry.source, 'flowstride');
  assert.equal(entry.name, 'flows/discounts.flow');
  assert.equal(entry.status, 'passed');
});
