const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { chromium } = require('playwright');
const { preparePracticeProject, practiceHandoffSelected } = require('../../dist/practice/project');
const { startPracticeApp } = require('../../dist/practice/server');
const { listSavedRuns } = require('../../dist/reporting/run_history');
const { localVideoPath } = require('../../dist/reporting/local_video');

const { starter, workspace, launch, closed, session, loopbackServer, writeConfig, captureDashboardLaunch } = require('./practice-fixtures.cjs');

test('Fresh init and a CI-detected run work offline, ignore the inherited application URL, and preserve edits', { timeout: 60000 }, async t => {
  const f = workspace(t);
  const sentinel = await loopbackServer(t);
  const init = await launch(t, f, ['init']).finished;
  assert.equal(init.code, 0, init.output);
  assert.match(init.output, /Chromium is ready/);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, starter)), ['browse-catalog.flow', 'login.flow']);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'flows/examples/advanced')),
    ['admin-creates-user.flow', 'check-catalog-prices.flow', 'new-user-signs-in.flow']);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'flows/examples/api-and-ui')), ['approve-user-and-sign-in.flow']);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'helpers/practice')), ['accounts.ts', 'catalog.ts', 'user-fixtures.ts']);
  assert.ok(!fs.existsSync(path.join(f.dir, 'flows/example.flow')));
  assert.ok(!fs.existsSync(path.join(f.dir, 'flows/welcome.flow')));
  const config = path.join(f.dir, 'flowstride.config.json');
  const original = fs.readFileSync(config, 'utf8');
  fs.appendFileSync(config, '\n');
  const login = path.join(f.dir, starter, 'login.flow');
  fs.appendFileSync(login, '\n// User kept this note\n');
  const originalLogin = fs.readFileSync(login, 'utf8');
  const catalogHelper = path.join(f.dir, 'helpers/practice/catalog.ts');
  fs.appendFileSync(catalogHelper, '\n// User kept this helper note\n');
  const originalHelper = fs.readFileSync(catalogHelper, 'utf8');
  fs.writeFileSync(path.join(f.dir, '.env'), 'BASE_URL=' + sentinel.url + '\n');
  const reinit = await launch(t, f, ['init']).finished;
  assert.equal(reinit.code, 0, reinit.output);
  assert.equal(fs.readFileSync(config, 'utf8'), original + '\n');
  assert.equal(fs.readFileSync(login, 'utf8'), originalLogin);
  assert.equal(fs.readFileSync(catalogHelper, 'utf8'), originalHelper);
  assert.equal(fs.readFileSync(path.join(f.dir, '.gitignore'), 'utf8').split('\n').filter(line => line === '.flowstride').length, 1);

  const invocation = launch(t, f, ['run'], { CI: 'true', BASE_URL: sentinel.url, FLOWSTRIDE_API_URL: sentinel.url, FLOWSTRIDE_TOKEN: 'demo-offline-test-token' });
  const result = await invocation.finished;
  const summary = f.summary();
  assert.equal(result.code, 0, result.output + '\n' + JSON.stringify(summary, null, 2));
  assert.doesNotMatch(result.output, /Local server running at/);
  assert.deepEqual(summary.files, ['browse-catalog.flow', 'login.flow']);
  assert.equal(summary.status, 'passed');
  assert.equal(listSavedRuns(f.dir)[0].counts.passed, 2);
  assert.deepEqual(sentinel.requests, []);
  assert.ok(!fs.existsSync(f.env.PRACTICE_TEST_NETWORK_LOG));
  await closed(await invocation.ready());
});

test('The default practice run opens the live dashboard, plays its recordings and supports rerun', { timeout: 60000 }, async t => {
  const f = workspace(t);
  const sentinel = await loopbackServer(t);
  preparePracticeProject(f.dir, false);
  const invocation = launch(t, f, ['run'], {
    ...captureDashboardLaunch(f),
    BASE_URL: sentinel.url, FLOWSTRIDE_API_URL: sentinel.url, FLOWSTRIDE_TOKEN: 'demo-offline-test-token',
  }, 55000);
  const app = await invocation.ready();
  const dashboard = await invocation.outputMatch(/\[Test dashboard\] (http:\/\/localhost:\d+)/);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const events = [];
    page.on('websocket', socket => {
      socket.on('framereceived', ({ payload }) => {
        const event = JSON.parse(String(payload));
        if (['RUN_START', 'RUN_COMPLETE'].includes(event.type)) events.push(event);
      });
    });
    await page.goto(dashboard);
    await page.locator('[data-flow-result="browse-catalog.flow"][data-flow-status="passed"]').waitFor({ timeout: 15000 });
    await page.locator('[data-flow-result="login.flow"][data-flow-status="passed"]').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor({ timeout: 15000 });
    assert.deepEqual(events.filter(event => event.type === 'RUN_START').map(event => event.payload.fileName),
      ['browse-catalog.flow', 'login.flow']);
    assert.deepEqual(events.filter(event => event.type === 'RUN_COMPLETE').map(event => event.payload.status), ['success']);
    assert.equal((await fetch(app + '/health')).status, 200);
    await page.locator('nav').getByText('Logs', { exact: true }).click();
    for (const file of ['browse-catalog.flow', 'login.flow']) {
      await page.getByRole('button', { name: 'Watch ' + file }).click();
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return video && video.currentTime > 0.2 && video.videoWidth > 0 && !video.error;
      }, null, { timeout: 10000 });
      await page.getByRole('button', { name: /Close/ }).click();
    }
    const videoUrl = dashboard + '/videos/' + encodeURIComponent('browse-catalog.flow');
    const range = await fetch(videoUrl, { headers: { Range: 'bytes=0-3' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-type'), 'video/webm');
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    assert.equal((await fetch(videoUrl, { headers: { Range: 'bytes=-4' } })).status, 206);
    assert.equal((await fetch(videoUrl, { headers: { Range: 'bytes=invalid' } })).status, 416);
    await page.locator('nav').getByText('Flows', { exact: true }).click();

    const flow = path.join(f.dir, starter, 'login.flow');
    const source = fs.readFileSync(flow, 'utf8');
    fs.writeFileSync(flow, source.replace('flow.expect text "Signed in as Practice Driver";',
      'flow.assert.value {"actual":"Practice Driver","operator":"equals","expected":"Different driver"};'));
    await page.getByRole('button', { name: 'Rerun' }).click();
    await page.locator('[data-flow-result="login.flow"][data-flow-status="failed"]').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor();
    assert.deepEqual(events.filter(event => event.type === 'RUN_COMPLETE').map(event => event.payload.status), ['success', 'failed']);
    assert.deepEqual(sentinel.requests, []);
    await page.close();
  } finally {
    await browser.close();
  }
  const result = await invocation.finished;
  assert.equal(result.signal, null, result.output);
  assert.match(result.output, /Dashboard disconnected/, result.output);
  await closed(app);
});

test('A dashboard run with recording off hides Watch and never serves a stale recording', { timeout: 30000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  writeConfig(f.dir, { practiceApp: true, testDir: starter, recordVideo: false });
  const file = 'browse-catalog.flow';
  const stale = localVideoPath(f.dir, file);
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, 'stale recording');
  const invocation = launch(t, f, ['run', starter + '/' + file], captureDashboardLaunch(f), 28000);
  const dashboard = await invocation.outputMatch(/\[Test dashboard\] (http:\/\/localhost:\d+)/);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(dashboard);
    await page.locator('[data-flow-result="' + file + '"][data-flow-status="passed"]').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Run', exact: true }).waitFor();
    await page.locator('nav').getByText('Logs', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /^Watch / }).count(), 0);
    assert.equal((await fetch(dashboard + '/videos/' + encodeURIComponent(file))).status, 404);
    await page.close();
  } finally {
    await browser.close();
  }
  assert.equal((await invocation.finished).code, 0);
});

test('Reinitializing a practice project built before the example rename preserves its edited handoff', t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  const advanced = path.join(f.dir, 'flows/examples/advanced');
  const oldAdmin = path.join(advanced, 'provision-user.flow');
  const oldUser = path.join(advanced, 'provision-user-and-login.flow');
  fs.renameSync(path.join(advanced, 'admin-creates-user.flow'), oldAdmin);
  fs.renameSync(path.join(advanced, 'new-user-signs-in.flow'), oldUser);
  fs.appendFileSync(oldAdmin, '\n// Local practice note\n');
  const edited = fs.readFileSync(oldAdmin, 'utf8');
  preparePracticeProject(f.dir, false);
  assert.deepEqual(fs.readdirSync(advanced), ['check-catalog-prices.flow', 'provision-user-and-login.flow', 'provision-user.flow']);
  assert.equal(fs.readFileSync(oldAdmin, 'utf8'), edited);
  assert.equal(practiceHandoffSelected(f.dir, oldUser), true);
});

test('Existing projects retain their configured test target and opt in through an isolated workspace', { timeout: 60000 }, async t => {
  const f = workspace(t);
  const app = await loopbackServer(t);
  fs.mkdirSync(path.join(f.dir, 'specs'));
  fs.mkdirSync(path.join(f.dir, '.flowstride'), { mode: 0o700 });
  fs.writeFileSync(path.join(f.dir, '.flowstride/credentials.json'), '{}', { mode: 0o600 });
  const flow = path.join(f.dir, 'specs/test.flow');
  const source = [
    'Feature: Existing suite', 'Scenario: Test the configured application',
    '  Given "Open the application"', '    flow.open "/";', '  When "Locate the application"',
    '    flow.expect visible "Existing app";', '  Then "Check the application"', '    flow.expect text "Existing app";',
  ].join('\n');
  fs.writeFileSync(flow, source);
  writeConfig(f.dir, { testDir: '.', baseUrl: app.url, recordVideo: false });
  const config = fs.readFileSync(path.join(f.dir, 'flowstride.config.json'), 'utf8');
  const init = await launch(t, f, ['init']).finished;
  assert.equal(init.code, 0, init.output);
  assert.ok(!fs.existsSync(path.join(f.dir, 'flows/examples')));
  const optIn = await launch(t, f, ['init', '--practice']).finished;
  assert.equal(optIn.code, 0, optIn.output);
  assert.ok(fs.existsSync(path.join(f.dir, '.flowstride/practice', starter, 'login.flow')));
  assert.equal(fs.readFileSync(path.join(f.dir, 'flowstride.config.json'), 'utf8'), config);
  assert.equal(fs.readFileSync(flow, 'utf8'), source);

  const parent = await launch(t, f, ['run', '--ci'], { BASE_URL: app.url }).finished;
  assert.equal(parent.code, 0, parent.output);
  assert.doesNotMatch(parent.output, /Practice app/);
  assert.deepEqual(f.summary().files, ['specs/test.flow']);
  assert.ok(app.requests.includes('/'));
  app.requests.length = 0;
  const sub = { ...f, dir: path.join(f.dir, '.flowstride/practice') };
  const invocation = launch(t, sub, ['run', starter + '/login.flow', '--ci'], { BASE_URL: app.url });
  const result = await invocation.finished;
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(app.requests, []);
  await closed(await invocation.ready());
});

test('Two real CLI runs use isolated fixture state and shut down after a pass or cancellation', { timeout: 60000 }, async t => {
  const first = workspace(t);
  const second = workspace(t);
  for (const f of [first, second]) preparePracticeProject(f.dir, false);
  const slow = path.join(second.dir, starter, 'login.flow');
  fs.writeFileSync(slow, fs.readFileSync(slow, 'utf8').replace('    flow.type input "Email"', '    flow.wait 20000;\n    flow.type input "Email"'));
  // Give the test time to exercise both live apps before the first run finishes.
  const regular = path.join(first.dir, starter, 'login.flow');
  fs.writeFileSync(regular, fs.readFileSync(regular, 'utf8').replace('    flow.type input "Email"', '    flow.wait 1800;\n    flow.type input "Email"'));
  const a = launch(t, first, ['run', starter + '/login.flow', '--ci']);
  const b = launch(t, second, ['run', starter + '/login.flow', '--ci']);
  const [aUrl, bUrl] = await Promise.all([a.ready(), b.ready()]);
  assert.notEqual(aUrl, bUrl);
  const [aCookie, bCookie] = await Promise.all([aUrl, bUrl].map(url => session(url, 'admin@example.test', 'practice-admin')));
  assert.notEqual(aCookie.split('=')[0], bCookie.split('=')[0]);
  const created = await fetch(aUrl + '/api/admin/users', {
    method: 'POST', headers: { Cookie: aCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fixture driver', email: 'fixture@example.test', password: 'practice-fixture' }),
  });
  assert.equal(created.status, 201);
  const list = async (url, cookie) => (await (await fetch(url + '/api/admin/users', { headers: { Cookie: cookie } })).json()).users;
  const [aUsers, bUsers] = await Promise.all([list(aUrl, aCookie), list(bUrl, bCookie)]);
  assert.ok(aUsers.some(user => user.email === 'fixture@example.test'));
  assert.ok(!bUsers.some(user => user.email === 'fixture@example.test'));
  assert.equal(b.child.kill('SIGTERM'), true);
  const [finished, cancelled] = await Promise.all([a.finished, b.finished]);
  assert.equal(finished.code, 0, finished.output);
  assert.equal(cancelled.code, 130, cancelled.output);
  assert.equal(first.summary().status, 'passed');
  assert.equal(second.summary().status, 'interrupted');
  await Promise.all([closed(aUrl), closed(bUrl)]);
});

test('A failing practice run retains its report and stops its app', { timeout: 30000 }, async t => {
  const f = workspace(t);
  preparePracticeProject(f.dir, false);
  writeConfig(f.dir, { practiceApp: true, testDir: starter, timeout: 1400, recordVideo: false });
  const file = path.join(f.dir, starter, 'login.flow');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Signed in as Practice Driver', 'Wrong driver name'));
  const invocation = launch(t, f, ['run', starter + '/login.flow', '--ci']);
  const result = await invocation.finished;
  assert.equal(result.code, 1, result.output);
  const summary = f.summary();
  assert.equal(summary.status, 'failed');
  assert.ok(summary.steps.some(step => step.status === 'failed' && step.error?.includes('Wrong driver name')), JSON.stringify(summary.errors));
  await closed(await invocation.ready());
});

test('The local catalog and admin forms support assigning a permission and signing in as that user', { timeout: 45000 }, async t => {
  const app = await startPracticeApp();
  t.after(() => app.close());
  const catalog = await (await fetch(app.origin + '/api/cars')).json();
  assert.equal(catalog.cars.length, 50);
  assert.equal(new Set(catalog.cars.map(car => car.sku)).size, 50);
  assert.equal(catalog.cars.find(car => car.sku === 'CAR-001').finalPriceCents, 1080000);
  const denied = await fetch(app.origin + '/api/admin/users', { headers: { Origin: 'https://example.test' } });
  assert.equal(denied.status, 403);
  assert.equal((await fetch(app.origin + '/api/admin/users')).status, 401);

  const browser = await chromium.launch();
  try {
    const admin = await browser.newPage();
    const origins = new Set();
    admin.on('request', request => origins.add(new URL(request.url()).origin));
    await admin.goto(app.origin);
    await admin.getByRole('heading', { name: 'Car catalog' }).waitFor();
    assert.equal(await admin.locator('li[data-sku]').count(), 50);
    const togglePassword = async (page, label, placeholder, value) => {
      const input = page.getByLabel(label, { exact: true });
      assert.equal(await input.getAttribute('placeholder'), placeholder);
      assert.equal(await input.getAttribute('type'), 'password');
      await input.fill(value);
      const show = page.getByRole('button', { name: 'Show password', exact: true });
      assert.equal(await show.getAttribute('aria-controls'), await input.getAttribute('id'));
      assert.ok(await show.locator('svg').isVisible());
      await show.focus();
      await page.keyboard.press('Space');
      assert.equal(await input.getAttribute('type'), 'text');
      assert.equal(await input.inputValue(), value);
      await page.getByRole('button', { name: 'Hide password', exact: true }).click();
      assert.equal(await input.getAttribute('type'), 'password');
      assert.equal(await input.inputValue(), value);
    };
    const logIn = async (page, email, password) => {
      await page.goto(app.origin + '/login');
      await page.getByLabel('Email').fill(email);
      await togglePassword(page, 'Password', 'Enter password', password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('heading', { name: 'Your account' }).waitFor();
    };
    await logIn(admin, 'admin@example.test', 'practice-admin');
    await admin.getByRole('link', { name: 'Manage users' }).click();
    await admin.getByLabel('Full name').fill('QA Driver & Approver');
    await admin.getByLabel('User email').fill('approver@example.test');
    await togglePassword(admin, 'Temporary password', 'Create a password', 'practice-approver');
    await admin.getByRole('button', { name: 'Create user' }).click();
    const row = admin.locator('.member').filter({ hasText: 'QA Driver & Approver' });
    await row.getByLabel('Role for QA Driver & Approver').selectOption('approver');
    await row.getByRole('button', { name: 'Assign role' }).click();
    await admin.getByRole('heading', { name: 'Workspace users' }).waitFor();
    assert.equal(await row.getByLabel('Role for QA Driver & Approver').inputValue(), 'approver');
    const member = await browser.newPage();
    await logIn(member, 'approver@example.test', 'practice-approver');
    await member.getByText('Can approve bookings').waitFor();
    assert.equal((await member.goto(app.origin + '/admin')).status(), 403);
    assert.deepEqual([...origins], [app.origin]);

    const cookie = await session(app.origin, 'admin@example.test', 'practice-admin');
    const users = await (await fetch(app.origin + '/api/admin/users', { headers: { Cookie: cookie } })).json();
    const added = users.users.find(user => user.email === 'approver@example.test');
    assert.equal(added.role, 'approver');
    assert.ok(!Object.hasOwn(added, 'password'));
    assert.equal((await fetch(app.origin + '/api/admin/users/' + added.id, { method: 'DELETE', headers: { Cookie: cookie } })).status, 204);
    assert.equal((await member.goto(app.origin + '/api/account')).status(), 401);
  } finally {
    await browser.close();
  }
});
