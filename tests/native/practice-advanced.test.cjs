const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');
const { preparePracticeProject, isBundledPracticeHandoff } = require('../../dist/practice/project');
const { loadNativeConfig } = require('../../dist/ci/config');
const { startPracticeApp } = require('../../dist/practice/server');
const { resolveProjectHelper, invokeProjectHelper } = require('../../dist/runner/project_helper');
const { captureDashboardLaunch, closed, launch, session, workspace, writeConfig } = require('./practice-fixtures.cjs');

const advanced = 'flows/examples/advanced';
const admin = 'admin-creates-user.flow';
const member = 'new-user-signs-in.flow';
const catalog = 'check-catalog-prices.flow';
const mixed = 'flows/examples/api-and-ui/approve-user-and-sign-in.flow';
const privateEngine = require('../../package.json').name === '@flowstride/pro';

function checkCredentialMasking(...values) {
  for (const value of values) {
    assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), /practice-private-[0-9a-f]{24}/);
  }
}

function runDiagnostics(result, report) {
  return result.output.split('\n').slice(-25).join('\n') + '\n' + JSON.stringify({
    errors: report.errors,
    dependencies: report.dependencies,
    attempts: report.attempts?.map(({ fileName, attempt, status }) => ({ fileName, attempt, status })),
    steps: report.steps?.filter(step => step.status === 'failed').map(({ fileName, commandLabel, error }) => ({ fileName, commandLabel, error })),
  }, null, 2);
}

function checkPassedHandoff(report) {
  assert.deepEqual(report.dependencies.map(item => [item.fileName, item.status]), [[member, 'waiting'], [member, 'ready']]);
  assert.deepEqual(report.attempts.filter(attempt => attempt.fileName === admin).map(attempt => [attempt.attempt, attempt.status]), [[1, 'failed'], [2, 'passed']]);
  assert.deepEqual(report.attempts.filter(attempt => attempt.fileName === member).map(attempt => [attempt.attempt, attempt.status]), [[1, 'passed']]);
  assert.deepEqual(report.fixtureCleanups.map(item => [item.attempt, item.status]), [[1, 'passed'], [2, 'passed']]);
  const firstAttempt = report.attempts.find(attempt => attempt.fileName === admin && attempt.attempt === 1);
  const failedRole = firstAttempt?.steps.find(step => step.status === 'failed');
  assert.equal(failedRole?.assertion?.command, 'assert.that');
  assert.match(JSON.stringify(failedRole), /Saved role · Booking approver/);
  assert.ok(report.steps.some(step => step.fileName === member && step.commandLabel === 'flow.assert.that' && step.status === 'passed'));
}

test('Bundled advanced examples pass in CI with the catalog and the two handoff flows separately reported', { timeout: 90000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  if (privateEngine) fs.writeFileSync(path.join(f.dir, 'package.json'), '{"type":"module"}\n');
  const args = ['run', advanced, '--ci', ...(privateEngine ? ['--workers', '2'] : [])];
  const invocation = launch(t, f, args, {}, 55000);
  const result = await invocation.finished;
  const report = f.summary();
  assert.equal(result.code, 0, runDiagnostics(result, report));
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.files.toSorted(), [catalog, admin, member].toSorted());
  assert.equal(report.attempts.find(attempt => attempt.fileName === catalog).status, 'passed');
  assert.deepEqual(report.steps.filter(step => step.fileName === catalog && step.commandLabel === 'flow.assert.value').map(step => step.status), ['passed', 'passed']);
  checkPassedHandoff(report);
  checkCredentialMasking(result.output, report, fs.readFileSync(path.join(f.dir, 'flowstride-artifacts/junit.xml'), 'utf8'));
  assert.ok(!fs.existsSync(f.env.PRACTICE_TEST_NETWORK_LOG));
  await closed(await invocation.ready());
});

test('Direct selection includes its admin prerequisite, and exhausting the retry budget blocks user login', { timeout: 60000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  writeConfig(f.dir, { practiceApp: true, testDir: 'flows/examples/starter', recordVideo: false, retries: 0 });
  const invocation = launch(t, f, ['run', advanced + '/' + member, '--ci'], {}, 40000);
  const result = await invocation.finished;
  const report = f.summary();
  assert.equal(result.code, 1, runDiagnostics(result, report));
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.files.toSorted(), [admin, member].toSorted());
  assert.deepEqual(report.dependencies.map(item => [item.fileName, item.status]), [[member, 'waiting'], [member, 'blocked']]);
  assert.deepEqual(report.attempts.map(attempt => [attempt.fileName, attempt.attempt, attempt.status]), [[admin, 1, 'failed']]);
  assert.deepEqual(report.fixtureCleanups.map(item => [item.attempt, item.status]), [[1, 'passed']]);
  checkCredentialMasking(result.output, report);
  await closed(await invocation.ready());
});

async function practiceUsers(app, cookie) {
  const response = await fetch(app + '/api/admin/users', { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return (await response.json()).users;
}

test('One scenario creates and approves a user through the API and signs in as that user in the browser', { timeout: 45000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  writeConfig(f.dir, { practiceApp: true, recordVideo: false });
  const invocation = launch(t, f, ['run', mixed, '--ci'], {}, 35000);
  const result = await invocation.finished;
  const report = f.summary();
  assert.equal(result.code, 0, runDiagnostics(result, report));
  assert.deepEqual(report.files, [path.basename(mixed)]);
  assert.deepEqual(report.attempts.map(item => item.status), ['passed']);
  const steps = report.steps.filter(step => step.status === 'passed').map(step => step.commandLabel);
  assert.equal(steps.filter(label => label === 'flow.api.request').length, 3);
  assert.ok(steps.lastIndexOf('flow.api.request') < steps.indexOf('open'));
  assert.ok(steps.includes('passcode') && steps.includes('flow.assert.that'));
  assert.deepEqual(report.fixtureCleanups.map(item => item.status), ['passed']);
  checkCredentialMasking(result.output, report);
  await closed(await invocation.ready());
});

test('The advanced live dashboard shows waiting, per-step screenshots and protected cleanup', { timeout: 120000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  const invocation = launch(t, f, ['run', advanced, ...(privateEngine ? ['--workers', '2'] : [])], captureDashboardLaunch(f), 110000);
  const app = await invocation.ready();
  const dashboard = await invocation.outputMatch(/\[Test dashboard\] (http:\/\/localhost:\d+)/);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const events = [];
    const runComplete = Promise.withResolvers();
    page.on('websocket', socket => {
      socket.on('framereceived', ({ payload }) => {
        const event = JSON.parse(String(payload));
        events.push(event);
        if (event.type === 'RUN_COMPLETE') runComplete.resolve(event.payload.status);
      });
    });
    await page.goto(dashboard);
    const adminRow = page.locator('[data-flow-result="' + admin + '"]');
    const memberRow = page.locator('[data-flow-result="' + member + '"]');
    await adminRow.and(page.locator('[data-flow-status="running"]')).waitFor({ timeout: 15000 });
    const waiting = memberRow.and(page.locator('[data-flow-status="waiting"]'));
    await waiting.getByText('Waiting for ' + admin, { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await adminRow.isVisible(), true);

    // The admin retries before the handoff. Compare the rendered result once the runner finishes.
    try {
      const status = await Promise.race([
        runComplete.promise,
        invocation.finished.then(() => 'CLI exited before RUN_COMPLETE'),
        delay(80000, 'Timed out waiting for RUN_COMPLETE', { ref: false }),
      ]);
      assert.equal(status, 'success');
      for (const row of [adminRow, memberRow]) {
        await row.and(page.locator('[data-flow-status="passed"]')).waitFor({ timeout: 5000 });
      }
    } catch (error) {
      const outcomes = events
        .filter(event => ['SCENARIO_RESULT', 'FLOW_DEPENDENCY', 'RUN_COMPLETE'].includes(event.type))
        .map(({ type, payload }) => [type, payload.fileName, payload.attempt, payload.status]);
      const rows = await page.locator('[data-flow-result]').evaluateAll(elements =>
        elements.map(row => [row.dataset.flowResult, row.dataset.flowStatus]));
      throw new Error('Runner outcomes ' + JSON.stringify(outcomes) + '; dashboard rows ' + JSON.stringify(rows), { cause: error });
    }
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor();
    for (const file of [admin, catalog, member]) {
      assert.ok(events.some(event => event.type === 'BROWSER_FRAME' &&
        event.payload.fileName === file && event.payload.base64?.length > 1000), 'Missing live browser frame for ' + file);
      assert.ok(events.some(event => event.type === 'STEP_UPDATE' &&
        event.payload.fileName === file && event.payload.status === 'passed' && event.payload.screenshot?.length > 1000),
        'Missing step screenshot for ' + file);
      await page.locator('[data-flow-result="' + file + '"]').getByText(file, { exact: true }).click();
      const frame = page.getByRole('img', { name: 'Browser frame' });
      await frame.waitFor();
      assert.ok(await frame.evaluate(image => image.complete && image.naturalWidth > 0), 'The dashboard could not render ' + file);
    }
    assert.ok(events.some(event => event.type === 'URL_CHANGE' && event.payload.url === app + '/admin'));
    assert.ok(events.some(event => event.type === 'URL_CHANGE' && event.payload.url === app + '/account'));
    assert.ok(!events.some(event => event.type === 'LOCAL_VIDEO_READY'));
    assert.ok(!fs.readdirSync(path.join(f.dir, '.flowstride'), { recursive: true }).some(file => /\.(webm|har|html|jpeg|jpg|png)$/.test(file)));
    assert.equal((await fetch(dashboard + '/videos/' + encodeURIComponent(member))).status, 404);

    const adminLines = fs.readFileSync(path.join(f.dir, advanced, admin), 'utf8').split('\n');
    for (const command of ['flow.type input "Full name"', 'flow.passcode input "Temporary password"',
      'flow.click button "Create user"', 'flow.select "Booking approver"', 'flow.click ".member']) {
      const line = adminLines.findIndex(text => text.trim().startsWith(command)) + 1;
      const step = events.find(event => event.type === 'STEP_ADD' && event.payload.fileName === admin &&
        event.payload.attempt === 2 && event.payload.sourceLine === line);
      assert.ok(step, 'Missing individual admin step ' + command);
      assert.ok(events.some(event => event.type === 'STEP_UPDATE' && event.payload.fileName === admin &&
        event.payload.attempt === 2 && event.payload.id === step.payload.id && event.payload.screenshot?.length > 1000),
      'Missing screenshot for ' + command);
    }

    const lifecycle = events.flatMap(({ type, payload }) => {
      if (type === 'FLOW_DEPENDENCY' && payload.fileName === member) return [payload.status];
      if (type === 'SCENARIO_ATTEMPT' && payload.fileName === admin) return ['admin ' + payload.attempt + ' starts'];
      if (type === 'SCENARIO_RESULT' && payload.fileName === admin) return ['admin ' + payload.attempt + ' ' + payload.status];
      if (type === 'RUN_START' && payload.fileName === member) return ['user starts'];
      if (type === 'SCENARIO_RESULT' && payload.fileName === member) return ['user ' + payload.status];
      if (type === 'FIXTURE_CLEANUP') return ['cleanup ' + payload.attempt + ' ' + payload.status];
      if (type === 'RUN_COMPLETE') return [payload.status];
      return [];
    });
    assert.deepEqual(lifecycle, [
      'waiting', 'admin 1 starts', 'cleanup 1 passed', 'admin 1 failed', 'admin 2 starts', 'admin 2 passed',
      'ready', 'user starts', 'user passed', 'cleanup 2 passed', 'success',
    ]);
    const cookie = await session(app, 'admin@example.test', 'practice-admin');
    assert.deepEqual((await practiceUsers(app, cookie)).map(user => user.id).toSorted(), ['admin', 'driver']);
    checkCredentialMasking(events);
    await page.close();
  } finally {
    await browser.close();
  }
  const result = await invocation.finished;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Dashboard disconnected/);
  await closed(app);
});

test('Only an owned practice run with the original flows and helpers qualifies for masked frames', t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  const origin = 'http://127.0.0.1:12345';
  writeConfig(f.dir, { practiceApp: true, practiceDashboardOrigin: origin });
  const config = loadNativeConfig(f.dir, {});
  assert.equal(config.practiceDashboardOrigin, undefined);
  Object.assign(config, { ci: false, baseUrl: origin, practiceDashboardOrigin: origin });
  const jobs = [admin, catalog, member].map(name => {
    const file = path.join(f.dir, advanced, name);
    return { file, sha256: createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex') };
  });
  assert.equal(isBundledPracticeHandoff(config, jobs), true);
  assert.equal(isBundledPracticeHandoff({ ...config, ci: true }, jobs), false);
  const helper = path.join(f.dir, 'helpers/practice/user-fixtures.ts');
  fs.appendFileSync(helper, '\n// Local changes\n');
  assert.equal(isBundledPracticeHandoff(config, jobs), false);
});

test('Cancelling the admin flow while the user is waiting cleans up the pending account', { timeout: 55000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  const file = path.join(f.dir, advanced, admin);
  const source = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, source.replace('    flow.handoff.publish', '    flow.wait 20000;\n    flow.handoff.publish'));
  const invocation = launch(t, f, ['run', advanced + '/' + member, '--ci'], {}, 45000);
  const app = await invocation.ready();
  const cookie = await session(app, 'admin@example.test', 'practice-admin');
  const deadline = Date.now() + 30000;
  while (!(await practiceUsers(app, cookie)).some(user => user.id.startsWith('user-') && user.role === 'approver')) {
    assert.ok(Date.now() < deadline, 'The test admin did not grant booking approval before cancellation.');
    await delay(25);
  }
  assert.ok(invocation.child.kill('SIGTERM'));
  const result = await invocation.finished;
  const report = f.summary();
  assert.equal(result.code, 130, runDiagnostics(result, report));
  assert.equal(report.status, 'interrupted');
  assert.deepEqual(report.dependencies.map(item => [item.fileName, item.status]), [[member, 'waiting'], [member, 'blocked']]);
  assert.deepEqual(report.attempts.map(item => [item.fileName, item.status]), [[admin, 'failed'], [admin, 'interrupted']]);
  assert.deepEqual(report.fixtureCleanups.map(item => [item.attempt, item.status]), [[1, 'passed'], [2, 'passed']]);
  checkCredentialMasking(result.output, report);
  await closed(app);
});

function catalogHelper(f, alias) {
  const helper = resolveProjectHelper({ projectRoot: f.dir }, path.join(advanced, catalog),
    { kind: 'helper', alias, path: 'practice/catalog.ts', line: 1 });
  return (...args) => invokeProjectHelper(helper, () => args);
}

test('The catalog helper detects a missing card, a duplicate card, and the wrong displayed price', { timeout: 30000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  const app = await startPracticeApp();
  t.after(() => app.close());
  const { cars } = await (await fetch(app.origin + '/api/cars')).json();
  const check = catalogHelper(f, 'checkCatalogPrices');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(app.origin);
    assert.equal(await check(page, cars), 50);
    const card = page.locator('li[data-sku="CAR-001"]');
    await card.evaluate(item => item.remove());
    await assert.rejects(check(page, cars), /Missing catalog cards CAR-001/);
    await page.reload();
    await card.evaluate(item => item.after(item.cloneNode(true)));
    await assert.rejects(check(page, cars), /Duplicate catalog card CAR-001/);
    await page.reload();
    await card.locator('.price span').evaluate(item => { item.textContent = '$0.00'; });
    await assert.rejects(check(page, cars), /Displayed price mismatch for CAR-001/);
    await assert.rejects(check(page, [cars[0], ...cars.slice(0, -1)]), /Duplicate API SKU CAR-001/);
  } finally {
    await browser.close();
  }
});

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

test('The quote helper backs off on temporary HTTP errors and stops immediately on a terminal error', { timeout: 15000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  const statusByRoute = { '/retry': [503, 502, 200], '/terminal': [404], '/exhausted': [503, 503, 503] };
  const visits = [];
  const url = await serve(t, (req, res) => {
    visits.push(req.url);
    const status = statusByRoute[req.url]?.shift() ?? 500;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end('{"method":"pickup"}');
  });
  const request = catalogHelper(f, 'requestQuote');
  const waits = [];
  const wait = async ms => { waits.push(ms); };
  assert.deepEqual(await request(new URL('/retry', url), wait), { method: 'pickup' });
  assert.deepEqual(waits.splice(0), [50, 100]);
  await assert.rejects(request(new URL('/terminal', url), wait), /HTTP 404/);
  assert.deepEqual(waits.splice(0), []);
  await assert.rejects(request(new URL('/exhausted', url), wait), /HTTP 503/);
  assert.deepEqual(waits, [50, 100]);
  assert.deepEqual(visits, ['/retry', '/retry', '/retry', '/terminal', '/exhausted', '/exhausted', '/exhausted']);
});

test('One flow can keep the seeded admin and driver signed in on separate browser profiles', { timeout: 45000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  const file = 'isolated-profiles.flow';
  fs.writeFileSync(path.join(f.dir, advanced, file), [
    'Feature: Use two practice accounts in one test',
    'Scenario: Keep admin and driver sessions separate',
    '  Given "Sign in as the administrator"',
    '    flow.browser.create {"name":"administrator"};',
    '    flow.open "/login";',
    '    flow.type input "Email" "admin@example.test";',
    '    flow.passcode input "Password" "practice-admin";',
    '    flow.click button "Sign in";',
    '  When "Sign in as the driver in another profile"',
    '    flow.browser.create {"name":"driver"};',
    '    flow.open "/login";',
    '    flow.type input "Email" "driver@example.test";',
    '    flow.passcode input "Password" "practice-driver";',
    '    flow.click button "Sign in";',
    '    flow.expect visible "Signed in as Practice Driver";',
    '  Then "The administrator remains signed in in the first profile"',
    '    flow.browser.use {"name":"administrator"};',
    '    flow.open "/admin";',
    '    flow.expect visible "Workspace users";',
    '    flow.browser.use {"name":"driver"};',
    '    flow.expect visible "Signed in as Practice Driver";',
  ].join('\n'));
  const invocation = launch(t, f, ['run', advanced + '/' + file, '--ci']);
  const result = await invocation.finished;
  const report = f.summary();
  assert.equal(result.code, 0, runDiagnostics(result, report));
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.files, [file]);
  await closed(await invocation.ready());
});

test('A browser download is verified, its ZIP manifest inspected, and a summary attached', { timeout: 45000 }, async t => {
  const { yazl } = require('playwright-core/lib/utilsBundle');
  const f = workspace(t);
  const expected = { sku: 'CAR-001', fulfillment: 'pickup', totalCents: 1080000 };
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(expected)), 'manifest.json');
  zip.end();
  const chunks = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk);
  const archive = Buffer.concat(chunks);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const baseUrl = await serve(t, (req, res) => {
    if (req.url === '/catalog.zip') {
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="catalog.zip"',
      }).end(archive);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<a href="/catalog.zip">Download catalog archive</a>');
  });
  writeConfig(f.dir, { baseUrl, recordVideo: false });
  fs.mkdirSync(path.join(f.dir, 'flows'));
  fs.mkdirSync(path.join(f.dir, 'plugins'));
  fs.writeFileSync(path.join(f.dir, 'plugins/archive.ts'), [
    'import { readFileSync } from "node:fs";',
    'import assert from "node:assert/strict";',
    'const { yauzl } = require(' + JSON.stringify(require.resolve('playwright-core/lib/utilsBundle')) + ');',
    'export async function summarize(sdk: any) {',
    '  const archive = readFileSync("downloads/catalog.zip");',
    '  const contents = await new Promise<Buffer>((resolve, reject) => {',
    '    yauzl.fromBuffer(archive, { lazyEntries: true }, (error: Error, zip: any) => {',
    '      if (error) return reject(error);',
    '      zip.on("error", reject);',
    '      zip.once("entry", (entry: any) => {',
    '        if (entry.fileName !== "manifest.json" || entry.uncompressedSize > 4096 || zip.entryCount !== 1) {',
    '          zip.close();',
    '          return reject(new Error("Unexpected catalog manifest"));',
    '        }',
    '        zip.openReadStream(entry, async (error: Error, stream: NodeJS.ReadableStream) => {',
    '          if (error) { zip.close(); return reject(error); }',
    '          try {',
    '            const chunks: Buffer[] = [];',
    '            for await (const chunk of stream) chunks.push(chunk);',
    '            resolve(Buffer.concat(chunks));',
    '          } catch (error) {',
    '            reject(error);',
    '          } finally {',
    '            zip.close();',
    '          }',
    '        });',
    '      });',
    '      zip.once("end", () => reject(new Error("The catalog ZIP has no manifest")));',
    '      zip.readEntry();',
    '    });',
    '  });',
    '  const manifest = JSON.parse(contents.toString("utf8"));',
    '  assert.deepEqual(manifest, ' + JSON.stringify(expected) + ');',
    '  sdk.run.attach("archive-summary.json", JSON.stringify({ verified: true, manifest }));',
    '}',
  ].join('\n'));
  const flow = path.join(f.dir, 'flows/inspect-catalog-zip.flow');
  fs.writeFileSync(flow, [
    'Feature: Review a catalog export',
    'let archive = "archive";',
    'Scenario: Save a ZIP and verify its manifest',
    '  Given "Open the catalog export"',
    '    flow.open "/";',
    '  When "Download the catalog ZIP"',
    '    flow.download.arm {"name":"cars"};',
    '    flow.click link "Download catalog archive";',
    '    flow.download.save {"name":"cars","file":"downloads/catalog.zip"};',
    '  Then "Verify the ZIP and attach a summary of its manifest"',
    '    flow.download.expect {"name":"cars","filename":"catalog.zip","sha256":"' + sha256 + '"};',
    '    archive.summarize {};',
  ].join('\n'));

  const result = await launch(t, f, ['run', 'flows', '--ci'], { BASE_URL: baseUrl }).finished;
  const report = f.summary();
  assert.equal(result.code, 0, runDiagnostics(result, report));
  assert.equal(report.status, 'passed');
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'downloads/catalog.zip')), archive);
  const artifacts = path.join(f.dir, 'flowstride-artifacts');
  const attachment = fs.readdirSync(artifacts, { recursive: true }).find(file => file.endsWith('archive-summary.json'));
  assert.ok(attachment, 'Missing ZIP evidence attachment');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(artifacts, attachment), 'utf8')), { verified: true, manifest: expected });
});
