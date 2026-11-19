const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const engine = process.env.FLOWSTRIDE_ENGINE_ROOT || path.resolve(__dirname, '../..');
const fromEngine = createRequire(path.join(engine, 'package.json'));
const { chromium } = fromEngine('playwright');
const { WebAdapter } = fromEngine('./dist/adapters/web/playwright');
const { ApiAdapter } = fromEngine('./dist/adapters/api/undici');
const { FlowWorker } = fromEngine('./dist/runner/flow_worker');
const { FlowOrchestrator } = fromEngine('./dist/runner/flow_orchestrator');

const provider = [
  'Feature: Admin creates the account',
  'Scenario: Confirm the record before handing it off',
  'Given "Open the app"',
  '  flow.open "/";',
  'When "Stage account metadata"',
  '  flow.handoff.publish {"name":"account","value":{"id":"test-account"}};',
  'Then "The admin must confirm the account"',
  '  flow.get "/confirm";',
  '  flow.expect status "200";',
].join('\n');
const consumer = [
  'Feature: Member logs in',
  'Scenario: Use the approved record',
  'Given "Wait for the admin test"',
  '  flow.handoff.receive {"name":"account","as":"member"};',
  'When "Open the account"',
  '  flow.open "/member/@member.id";',
  'Then "The member account is available"',
  '  flow.expect visible "Member page";',
].join('\n');

async function until(check) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    assert(Date.now() < deadline, 'The dashboard did not start in time.');
    await delay(20);
  }
}

test('Dashboard shows waiting and blocked states, preserves the reason on reconnect, and never opens the member test', { timeout: 45000 }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowstride-dependency-dashboard-')));
  const flows = path.join(dir, 'flows');
  fs.mkdirSync(flows);
  fs.writeFileSync(path.join(flows, 'admin.flow'), provider);
  fs.writeFileSync(path.join(flows, 'member.flow'), consumer);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const visits = [];
  const app = http.createServer(async (req, res) => {
    visits.push(req.url);
    if (req.url === '/confirm') {
      await gate;
      res.writeHead(503).end('{}');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Admin page</h1>');
    }
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const cwd = process.cwd(), argv = [...process.argv];
  process.chdir(dir);
  process.argv.push('--headless');
  const events = [];
  const config = {
    projectRoot: dir, testDir: 'flows', ci: false, browser: 'chromium', headless: true, timeout: 9000,
    baseUrl: 'http://127.0.0.1:' + app.address().port,
    onRunEvent: event => events.push(event),
  };
  const worker = new FlowWorker(config, new WebAdapter(config), new ApiAdapter(config), {}, {});
  const orchestrator = new FlowOrchestrator(worker, 1, config);
  let browser, run;
  try {
    const execute = orchestrator.executeTestRun.bind(orchestrator);
    orchestrator.executeTestRun = async target => {
      await until(() => orchestrator.wss?.clients.size);
      return execute(target);
    };
    run = orchestrator.start(flows);
    await until(() => orchestrator.httpServer?.listening);
    const origin = 'http://127.0.0.1:' + orchestrator.httpServer.address().port;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(origin);
    const waiting = page.locator('[data-flow-result="member.flow"][data-flow-status="waiting"]');
    await waiting.getByText('Waiting for admin.flow').waitFor();
    // Open a second dashboard while the dependency is unresolved.
    const reconnect = await browser.newPage();
    await reconnect.goto(origin);
    await reconnect.getByText('Waiting for admin.flow').waitFor();
    await until(() => visits.includes('/confirm'));
    assert(!visits.some(url => url.startsWith('/member/')));
    release();
    assert.equal(await run, false);
    const blocked = page.locator('[data-flow-result="member.flow"][data-flow-status="blocked"]');
    await blocked.getByText(/admin.flow did not complete successfully/).waitFor();
    assert(!events.some(event => event.type === 'RUN_START' && event.payload.fileName === 'member.flow'));
    assert(!events.some(event => event.type === 'BROWSER_FRAME' ||
      event.type === 'LOCAL_VIDEO_READY' || event.type === 'STEP_UPDATE' && event.payload.screenshot));
    assert(!visits.some(url => url.startsWith('/member/')));
  } finally {
    release();
    await orchestrator.close();
    if (browser) await browser.close();
    if (run) await run.catch(() => {});
    await worker.shutdown();
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
    process.argv.splice(0, process.argv.length, ...argv);
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
