const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { Lexer } = require('../../dist/parser/lexer');
const { Parser } = require('../../dist/parser/parser');
const { executionPlan } = require('../../dist/ci/distribution');
const { HandoffCoordinator } = require('../../dist/runner/handoff_coordinator');
const { root, cloud, privateEngine, prepare, parallelWorkerEnv } = require('./batch5.fixtures.cjs');

const accountPassword = id => 'secret-test-account-FS-' + id + '-77';
const producer = [
  'Feature: Admin provisions the account',
  'import { provision, identifyAdmin } from "accounts.js";',
  'Scenario: Create and authorize a test account',
  'Tags: admin',
  'Given "Create a test account and register its cleanup"',
  '  flow.fixture.use provision() as "account";',
  'When "Assign the approval permission and prepare the handoff"',
  '  flow.open "/admin";',
  '  flow.call identifyAdmin(page);',
  '  flow.post "/assign/@account.id";',
  '  flow.handoff.publish {"name":"approved_member","value":{"id":"@account.id","email":"@account.email","ownerPid":"@account.ownerPid"},"credentials":{"password":"@account.password"}};',
  'Then "Verify the account is ready before publishing"',
  '  flow.get "/readiness/@account.id";',
  '  flow.expect status "200";',
  '',
].join('\n');
const consumer = [
  'Feature: Member confirms their permission',
  'import { recordConsumer } from "accounts.js";',
  'Scenario: Sign in as the approved member',
  'Tags: member',
  'Given "Read the account from the successful producer"',
  '  flow.handoff.receive {"name":"approved_member","as":"member","credentialsAs":"login"};',
  '  flow.call recordConsumer("@member");',
  '  flow.open "/login";',
  'When "Sign in with the protected test credential"',
  '  flow.log "@login.password";',
  '  flow.type input "Email" "@member.email";',
  '  flow.passcode input "Password" "@login.password";',
  '  flow.click button "Sign in";',
  'Then "The assigned action is available"',
  '  flow.expect visible "Can approve orders";',
  '',
].join('\n');
const unrelated = [
  'Feature: Independent',
  'Scenario: Progress while producer runs',
  'Given "Start"',
  '  flow.get "/independent";',
  '  flow.open "/independent";',
  'When "Read status"',
  '  flow.expect status "200";',
  'Then "Success"',
  '  flow.assert.value {"actual":true,"operator":"equals","expected":true};',
].join('\n');

async function fixture(t, options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowstride-handoffs-')));
  for (const name of ['flows', 'helpers', '.flowstride']) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, '.flowstride/credentials.json'), '{}');
  const requests = [];
  const accounts = new Map();
  let sequence = 0;
  let loginAttempts = 0;
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost');
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: route.pathname, method: req.method, query: Object.fromEntries(route.searchParams) });
    const json = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const html = (status, data) => res.writeHead(status, { 'Content-Type': 'text/html' }).end(data);
    if (route.pathname === '/api/auth/verify-cli') return json(200, { tier: 'business', workspaceName: 'Fixture suite' });
    if (route.pathname === '/api/workspace/status') return json(200, { workspace: { _id: 'fixture-batch5-workspace' }, manifest: { maxWorkers: 2, features: [] } });
    if (route.pathname === '/account') {
      const id = String(++sequence);
      const account = { id, email: 'member-' + id + '@example.test', password: accountPassword(id), assigned: false };
      accounts.set(id, account);
      return json(200, account);
    }
    if (route.pathname.startsWith('/account/') && req.method === 'DELETE') {
      accounts.delete(route.pathname.split('/').pop());
      return json(200, {});
    }
    if (route.pathname.startsWith('/assign/')) {
      const account = accounts.get(route.pathname.split('/').pop());
      if (!account) return json(404, {});
      account.assigned = true;
      return json(200, {});
    }
    if (route.pathname.startsWith('/readiness/')) {
      const id = route.pathname.split('/').pop();
      return json(!options.alwaysFail && (!options.firstFails || id !== '1') && accounts.get(id)?.assigned ? 200 : 503, {});
    }
    if (route.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      const account = [...accounts.values()].find(value => value.email === form.get('email') && value.password === form.get('password'));
      requests.at(-1).verifiedAccount = account?.id;
      if (req.headers.cookie?.includes('admin-session')) return html(403, '<h1>Wrong browser session</h1>');
      if (!account?.assigned) return html(403, '<h1>No permission</h1>');
      if (++loginAttempts === 1 && options.retryConsumer) return html(503, '<h1>Try again later</h1>');
      return html(200, '<h1>Can approve orders</h1>');
    }
    if (route.pathname === '/login') return html(200, '<form method="post"><label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" required></label><button>Sign in</button></form>');
    if (route.pathname === '/admin') return html(200, '<h1>Admin workspace</h1>');
    return json(200, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  fs.writeFileSync(path.join(dir, 'helpers/accounts.js'), [
    'const { setTimeout: delay } = require("node:timers/promises");',
    'let base;',
    'exports.provision = async ({ baseURL, signal, defer }) => {',
    '  base = baseURL;',
    '  const response = await fetch(base + "/account", { method: "POST", signal });',
    '  const account = await response.json();',
    '  defer(async cleanupSignal => {',
    '    const released = await fetch(baseURL + "/account/" + account.id, { method: "DELETE", signal: cleanupSignal });',
    '    if (!released.ok) throw new Error("Could not release account");',
    '  }, { handoff: "approved_member" });',
    '  await delay(' + (options.producerDelay || 0) + ', undefined, { signal });',
    '  return { ...account, ownerPid: process.pid };',
    '};',
    'exports.identifyAdmin = page => page.context().addCookies([{name:"admin-session",value:"test-admin",url:new URL(page.url()).origin}]);',
    'exports.recordConsumer = account => fetch(' + JSON.stringify(url + '/consumer?id=') + ' + account.id + "&pid=" + process.pid + "&owner=" + account.ownerPid);',
  ].join('\n'));
  const config = (extra = {}) => fs.writeFileSync(path.join(dir, 'flowstride.config.json'), JSON.stringify({
    baseUrl: url, timeout: 2200, retries: 1, recordVideo: true, trace: true, har: true, domSnapshots: true, ...extra,
  }));
  config();
  const write = (name, source) => fs.writeFileSync(path.join(dir, 'flows', name), source);
  write('a-member.flow', consumer);
  write('b-admin.flow', producer);
  const run = (target = 'flows', args = [], env = {}, onChild) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'dist/cli/index.js'), 'run', target, '--ci', ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), CI: 'true', FLOWSTRIDE_TOKEN: '', FLOWSTRIDE_API_URL: url, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => output += data);
    child.stderr.on('data', data => output += data);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(output)); }, 35000);
    child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
    onChild?.(child);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, url, requests, accounts, config, write, run,
    summary: () => JSON.parse(fs.readFileSync(path.join(dir, 'flowstride-artifacts/summary.json'))),
    junit: () => fs.readFileSync(path.join(dir, 'flowstride-artifacts/junit.xml'), 'utf8'),
  };
}

function checkSuccessfulHandoff(f, result, parallel) {
  assert.equal(result.code, 0, result.output);
  const report = f.summary();
  assert.equal(report.status, 'passed');
  const visits = f.requests;
  assert.deepEqual(visits.filter(visit => visit.url === '/login' && visit.method === 'POST').map(visit => visit.verifiedAccount), ['2', '2']);
  assert.deepEqual(visits.filter(visit => visit.url === '/consumer').map(visit => visit.query.id), ['2', '2']);
  const position = (url, method) => visits.findIndex(visit => visit.url === url && (!method || visit.method === method));
  const last = visits.findLastIndex(visit => visit.url === '/login' && visit.method === 'POST');
  assert(position('/account/1', 'DELETE') >= 0);
  assert(position('/account/1', 'DELETE') < position('/readiness/2'));
  assert(position('/readiness/2') < position('/consumer'));
  assert(last < position('/account/2', 'DELETE'));
  assert.equal(f.accounts.size, 0);
  const consumerRequest = visits.find(visit => visit.url === '/consumer');
  if (parallel) {
    assert.equal(report.engine, 'Enterprise (Pro)', result.output);
    assert.notEqual(consumerRequest.query.pid, consumerRequest.query.owner, result.output);
    assert(position('/independent') >= 0 && position('/independent') < position('/readiness/2'));
  }
  assert.deepEqual(report.dependencies.map(item => [item.fileName, item.status]), [['a-member.flow', 'waiting'], ['a-member.flow', 'ready']]);
  assert.deepEqual(report.attempts.filter(item => item.fileName === 'b-admin.flow').map(item => item.status), ['failed', 'passed']);
  assert.deepEqual(report.attempts.filter(item => item.fileName === 'a-member.flow').map(item => item.status), ['failed', 'passed']);
  assert(report.steps.some(step => step.userMessage?.includes('[REDACTED]')));
  assert.equal(report.distribution.handoffs, undefined);
  const artifacts = [report.artifactsDir, path.join(f.dir, '.flowstride')].flatMap(dir =>
    fs.readdirSync(dir, { recursive: true }));
  assert(artifacts.every(file => !/\.(zip|png|jpg|jpeg|har|html|webm)$/i.test(file)), artifacts.join(', '));
  for (const secret of [accountPassword('1'), accountPassword('2')]) {
    assert(![result.output, JSON.stringify(report), f.junit()].some(source => source.includes(secret)));
  }
}

test('Single-file selection adds the producer, retries both files, masks the credential and cleans the account last', { timeout: 45000 }, async t => {
  const f = await fixture(t, { firstFails: true, retryConsumer: true });
  const result = await f.run('flows/a-member.flow', ['--tag', 'member']);
  checkSuccessfulHandoff(f, result, false);
});

test('Real Pro workers dispatch independent work while a handoff waits and pass the successful credential across processes', {
  skip: !privateEngine && !cloud, timeout: 45000,
}, async t => {
  const f = await fixture(t, { firstFails: true, retryConsumer: true, producerDelay: 1300 });
  f.write('c-independent.flow', unrelated);
  const env = { ...(privateEngine ? {} : prepare(f, 'handoff')), ...parallelWorkerEnv(f) };
  const result = await f.run('flows', ['--workers', '2'], env);
  checkSuccessfulHandoff(f, result, true);
});

test('Exhausted producer retries block the consumer, preserve the reason in CI and clean each attempted account', { timeout: 45000 }, async t => {
  const f = await fixture(t, { alwaysFail: true });
  const result = await f.run();
  assert.equal(result.code, 1, result.output);
  const report = f.summary();
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.dependencies.map(item => item.status), ['waiting', 'blocked']);
  assert.match(report.dependencies[1].reason, /b-admin.flow.*did not complete/);
  assert(report.steps.filter(step => step.fileName === 'a-member.flow').every(step => step.status === 'blocked'));
  assert.equal(report.attempts.filter(item => item.fileName === 'a-member.flow').length, 0);
  assert.equal(report.metrics.incomplete, 0);
  assert.match(f.junit(), /skipped message="Blocked because b-admin.flow/);
  assert(!f.requests.some(visit => visit.url === '/login' || visit.url === '/consumer'));
  assert.equal(f.accounts.size, 0);
});

test('Cancellation cleans the active account and blocks work that never started', { timeout: 45000 }, async t => {
  const f = await fixture(t, { producerDelay: 8000 });
  f.config({ timeout: 20000 });
  let child;
  const result = f.run('flows', [], {}, process => { child = process; });
  const deadline = Date.now() + 12000;
  while (!f.accounts.size) {
    assert(Date.now() < deadline, 'Account setup did not start.');
    await delay(20);
  }
  // Give the fixture a turn to register its release after the create response.
  await delay(150);
  child.kill('SIGTERM');
  const interrupted = await result;
  assert.equal(interrupted.code, 130, interrupted.output);
  assert.equal(f.summary().status, 'interrupted');
  assert.equal(f.summary().dependencies.at(-1).status, 'blocked');
  assert(!f.requests.some(visit => visit.url === '/login' || visit.url === '/consumer'));
  assert.equal(f.accounts.size, 0);
});

test('Plan rejects unknown, duplicate and circular producers before opening an application', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  const config = { projectRoot: f.dir, testDir: 'flows', timeout: 2000, headless: true };
  const target = path.join(f.dir, 'flows');
  f.write('b-admin.flow', producer.replace('"name":"approved_member"', '"name":"different"'));
  assert.throws(() => executionPlan(target, config), /Missing producer.*approved_member/);
  f.write('b-admin.flow', producer);
  f.write('c-extra.flow', producer);
  assert.throws(() => executionPlan(target, config), /more than one producer/);
  f.write('c-extra.flow', unrelated);
  f.write('a-member.flow', consumer.replace('Then "The assigned action is available"', 'Then "The assigned action is available"\n  flow.handoff.publish {"name":"another","value":true};'));
  f.write('b-admin.flow', producer.replace('Given "Create a test account and register its cleanup"', 'Given "Create a test account and register its cleanup"\n  flow.handoff.receive {"name":"another","as":"other"};'));
  const failed = await f.run();
  assert.equal(failed.code, 1, failed.output);
  assert.match(f.summary().errors.join(' '), /Circular handoff dependencies/);
  assert.deepEqual(f.requests, []);
});

test('A handoff chain stays together when CI distributes shards', async t => {
  const f = await fixture(t);
  f.write('c-independent.flow', unrelated);
  const config = { projectRoot: f.dir, timeout: 2000, headless: true };
  const target = path.join(f.dir, 'flows');
  const plans = [executionPlan(target, { ...config, shard: '1/2' }), executionPlan(target, { ...config, shard: '2/2' })];
  const related = plans.find(plan => plan.files.some(file => file.endsWith('a-member.flow')));
  assert(related.files.some(file => file.endsWith('b-admin.flow')));
  assert(plans.find(plan => plan !== related).files.some(file => file.endsWith('c-independent.flow')));
});

test('The coordinator exposes protected values only to a file with a credentials binding and clears its run state', async () => {
  const jobs = [
    { file: '/project/provider.flow', publishes: ['account'], receives: [], credentialInputs: [] },
    { file: '/project/report.flow', publishes: [], receives: ['account'], credentialInputs: [] },
    { file: '/project/login.flow', publishes: [], receives: ['account'], credentialInputs: ['account'] },
  ];
  const statuses = [];
  const coordinator = new HandoffCoordinator(jobs, '/project', event => statuses.push(event));
  const producer = coordinator.source('first'), metadata = coordinator.source('second'), login = coordinator.source('third');
  assert.equal((await producer.next()).job.file, jobs[0].file);
  producer.done({ passed: true, outputs: { account: { value: { id: '1' }, credentials: { password: 'dummy-account-secret' } } } });
  const [metadataAssignment, loginAssignment] = await Promise.all([metadata.next(), login.next()]);
  const publicInput = metadataAssignment.inputs.account;
  const privateInput = loginAssignment.inputs.account;
  assert.equal(publicInput.protectedCredentials.reference, privateInput.protectedCredentials.reference);
  assert.equal(publicInput.protectedCredentials.values, undefined);
  assert.equal(privateInput.protectedCredentials.values.password, 'dummy-account-secret');
  assert(!JSON.stringify(statuses).includes('dummy-account-secret'));
  metadata.done({ passed: true });
  login.done({ passed: true });
  assert.equal(await login.next(), undefined);
  coordinator.clear();
});

test('Handoff syntax requires Given to receive, rejects literal credentials and rejects fragments', () => {
  const parse = source => new Parser(new Lexer(source).tokenise());
  assert.throws(() => parse(consumer.replace('Given "Read the account from the successful producer"', 'Given "Start"\nWhen "Too late to receive"')).parse(), /receive in Given/);
  assert.throws(() => parse(producer.replace('"@account.password"', '"hardcoded-value"')).parse(), /named credential references/);
  assert.throws(() => parse('flow.handoff.receive {"name":"member","as":"user"};').parseFragment(), /directly inside a scenario/);
});

test('The coordinator gives an already idle worker the ready consumer and releases workers lost while waiting', async () => {
  const jobs = [
    { file: '/project/a.flow', publishes: ['account'], receives: [], credentialInputs: [] },
    { file: '/project/b.flow', publishes: [], receives: ['account'], credentialInputs: [] },
  ];
  const coordinator = new HandoffCoordinator(jobs, '/project', () => {});
  const producer = coordinator.source('producer');
  const idle = coordinator.source('idle');
  const lost = coordinator.source('lost');
  assert.equal((await producer.next()).job.file, jobs[0].file);
  const lostRequest = lost.next();
  const idleRequest = idle.next();
  coordinator.workerLost('lost');
  assert.equal(await lostRequest, undefined);
  producer.done({ passed: true, outputs: { account: { value: { id: 1 } } } });
  const producerNext = producer.next();
  assert.equal((await idleRequest).job.file, jobs[1].file);
  idle.done({ passed: true });
  assert.equal(await producerNext, undefined);
});

test('An explicitly skipped consumer does not run an otherwise unselected producer', { timeout: 45000 }, async t => {
  const f = await fixture(t);
  f.write('a-member.flow', consumer.replace('  flow.handoff.receive', '  flow.skipIf {"browser":"chromium","reason":"Skip this browser"};\n  flow.handoff.receive'));
  const result = await f.run('flows/a-member.flow');
  assert.equal(result.code, 0, result.output);
  assert.equal(f.summary().status, 'skipped');
  assert(!f.requests.some(visit => visit.url === '/account'));
});

test('A successful producer on retry with failOnFlaky still blocks the handoff and deletes both attempts', { timeout: 45000 }, async t => {
  const f = await fixture(t, { firstFails: true });
  f.config({ failOnFlaky: true });
  const result = await f.run();
  assert.equal(result.code, 1, result.output);
  assert(f.summary().attempts.some(attempt => attempt.flaky));
  assert.equal(f.summary().dependencies.at(-1).status, 'blocked');
  assert(!f.requests.some(visit => visit.url === '/consumer'));
  assert.equal(f.accounts.size, 0);
});

test('Stopping while the consumer holds a retained account still releases it across Pro workers', {
  skip: !privateEngine && !cloud, timeout: 45000,
}, async t => {
  const f = await fixture(t);
  f.write('a-member.flow', consumer.replace('  flow.open "/login";', '  flow.wait 20000;\n  flow.open "/login";'));
  const env = { ...(privateEngine ? {} : prepare(f, 'handoff')), ...parallelWorkerEnv(f) };
  let child;
  const running = f.run('flows', ['--workers', '2'], env, process => { child = process; });
  const deadline = Date.now() + 13000;
  while (!f.requests.some(visit => visit.url === '/consumer')) {
    assert(Date.now() < deadline, 'The consumer did not receive the account.');
    await delay(20);
  }
  assert.equal(f.accounts.size, 1);
  assert(child.kill('SIGTERM'));
  const result = await running;
  assert.equal(result.code, 130, result.output);
  assert.equal(f.summary().status, 'interrupted');
  assert.equal(f.accounts.size, 0);
  assert(f.summary().fixtureCleanups.some(item => item.handoff === 'approved_member' && item.status === 'passed'));
});

test('The public CLI safely falls back from Pro releases that lack the handoff protocol', {
  skip: privateEngine || !cloud, timeout: 45000,
}, async t => {
  const f = await fixture(t);
  prepare(f, 'older');
  for (const name of ['flow_worker', 'flow_orchestrator']) {
    const file = path.join(f.dir, 'node_modules/@flowstride/pro/dist/runner', name + '.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('nativeDataProtocol', 'nativeHandoffProtocol'));
  }
  const result = await f.run();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /does not support test dependencies/);
  assert.equal(f.summary().engine, 'Open Source');
});

test('A missing output is blocked even when the handoff name is a built-in Object property', async () => {
  const jobs = [
    { file: '/project/a.flow', publishes: ['constructor'], receives: [], credentialInputs: [] },
    { file: '/project/b.flow', publishes: [], receives: ['constructor'], credentialInputs: [] },
  ];
  const events = [];
  const coordinator = new HandoffCoordinator(jobs, '/project', event => events.push(event));
  const source = coordinator.source('worker');
  assert.equal((await source.next()).job.file, jobs[0].file);
  source.done({ passed: true, outputs: {} });
  assert.equal(await source.next(), undefined);
  assert.equal(events.at(-1).status, 'blocked');
});
