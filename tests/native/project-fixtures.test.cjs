const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { Lexer } = require('../../dist/parser/lexer');
const { Parser } = require('../../dist/parser/parser');
const { root, cloud, privateEngine, fixture, execute, prepare, parallelWorkerEnv } = require('./batch5.fixtures.cjs');

const imports = [
  'import { setup, failingSetup, saveIdentity, checkIdentity, baseline } from "workspace.ts";',
  'import { shared } from "service.js";',
].join('\n');
function scenario(name, given, when = 'flow.get "/api/check";', then = 'flow.expect status "200";') {
  return [
    'Scenario: ' + name,
    '  Given "Prepare the test"',
    '    ' + given,
    '  When "Exercise the application"',
    '    ' + when,
    '  Then "Check the outcome"',
    '    ' + then,
  ].join('\n');
}
function flow(...scenarios) {
  return ['Feature: Project fixtures', imports, ...scenarios, ''].join('\n');
}
function parse(source) {
  return new Parser(new Lexer(source).tokenise());
}

async function fixtures(t, browser) {
  const f = await fixture(browser);
  t.after(f.close);
  const helpers = path.join(f.dir, 'helpers');
  fs.mkdirSync(helpers);
  fs.writeFileSync(path.join(helpers, 'workspace.ts'), [
    'import assert from "node:assert/strict";',
    'import { setTimeout as delay } from "node:timers/promises";',
    'async function record(baseURL: string, signal: AbortSignal, event: string, id: string) {',
    '  const res = await fetch(new URL("/api/fixture-" + event + "?id=" + id, baseURL), { signal });',
    '  assert.equal(res.status, 200);',
    '}',
    'let count = 0;',
    'export const baseline = () => ({ id: "original" });',
    'export async function setup({ baseURL, signal, defer, profile }, options = {}) {',
    '  const id = (options.distinct ? process.pid + "-" : "") + "lease-" + (++count);',
    '  await record(baseURL, signal, "acquire", id);',
    '  defer(cleanupSignal => record(baseURL, cleanupSignal, "release", id));',
    '  if (options.failCleanup) defer(() => { throw new Error("Attempt cleanup error"); });',
    '  if (options.interrupt) {',
    '    await record(baseURL, signal, "awaiting", id);',
    '    await delay(20000, undefined, { signal });',
    '  }',
    '  if (options.retrySetup && count === 1) throw new Error("Setup failed at first attempt");',
    '  if (options.browser) { profile("administrator"); profile("member"); }',
    '  if (options.extraProfile) profile(options.extraProfile);',
    '  return { id };',
    '}',
    'export async function failingSetup({ baseURL, signal, defer }, credentials) {',
    '  await record(baseURL, signal, "acquire", "partial");',
    '  defer(cleanupSignal => record(baseURL, cleanupSignal, "release", "partial"));',
    '  defer(() => { throw new Error("Resource disposal failed: " + credentials.password); });',
    '  throw new Error("Fixture setup stopped before completion");',
    '}',
    'export async function saveIdentity(page, name) {',
    '  await checkIdentity(page, null);',
    '  await page.context().addCookies([{ name: "fixture-identity", value: name, url: new URL(page.url()).origin }]);',
    '}',
    'export async function checkIdentity(page, expected) {',
    '  const cookies = await page.context().cookies();',
    '  assert.equal(cookies.find(cookie => cookie.name === "fixture-identity")?.value ?? null, expected);',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(helpers, 'service.js'), [
    'const assert = require("node:assert/strict");',
    'let count = 0;',
    'async function record(baseURL, signal, event, id) {',
    '  const res = await fetch(new URL("/api/fixture-" + event + "?id=" + id, baseURL), { signal });',
    '  assert.equal(res.status, 200);',
    '}',
    'exports.shared = async function ({ baseURL, signal, defer, profile }, options = {}) {',
    '  const id = (options.name || "service") + "-" + process.pid + "-" + (++count);',
    '  await record(baseURL, signal, "start-service", id);',
    '  defer(async cleanupSignal => {',
    '    await record(baseURL, cleanupSignal, "stop-service", id);',
    '    if (options.failCleanup) throw new Error("Service teardown failed");',
    '  });',
    '  if (options.retrySetup && count === 1) throw new Error("Service setup failed");',
    '  if (options.profile) profile("invalid-shared-profile");',
    '  return { id };',
    '};',
  ].join('\n'));
  f.events = () => f.requests.map(event => event.url).filter(url => url.startsWith('/api/fixture-'));
  return f;
}

test('Fixture syntax accepts typed inputs and limits declarations to scenario setup', () => {
  const [feature] = parse(flow(scenario('Provision', 'flow.fixture.use setup({"browser":true}, "@input") as "workspace";'))).parse();
  assert.equal(feature.scenarios[0].steps[0].action, 'fixture');
  assert.deepEqual(feature.scenarios[0].steps[0].payload, {
    name: 'setup', args: [{ browser: true }, '@input'], usePage: false, scope: 'attempt',
    capture: { name: 'workspace', isGlobal: false },
  });
  assert.throws(() => parse(flow(scenario('Unexpected source', 'flow.fixture.use setup(page);'))).parse(), /receive a context automatically/);
  assert.throws(() => parse(flow(scenario('Invalid scope', 'flow.fixture.use setup() as global "workspace";'))).parse(), /current scenario attempt/);
  assert.throws(() => parse(flow(scenario('Misplaced setup', 'flow.open "/";', 'flow.fixture.use setup();'))).parse(), /Given block/);
  assert.throws(() => parse(flow(scenario('Invalid args', 'flow.fixture.use setup(new Object());'))).parse(), /Fixture arguments must be JSON values/);
  assert.throws(() => parse('flow.fixture.use setup();').parseFragment(), /Given block/);
});

for (const browser of ['chromium', 'firefox', 'webkit']) {
  test('Scenario fixtures give each identity its own ' + browser + ' session and restore file data after use', { timeout: 45000 }, async t => {
    const f = await fixtures(t, browser);
    f.write(flow(scenario('Create two isolated identities', [
      'flow.call baseline() as "workspace";',
      'flow.fixture.use setup({"browser":true}) as "workspace";',
    ].join('\n'), [
      'flow.open "/";',
      'flow.call checkIdentity(page, null);',
      'flow.browser.use {"name":"administrator"};',
      'flow.open "/";',
      'flow.call saveIdentity(page, "administrator");',
      'flow.browser.use {"name":"member"};',
      'flow.open "/";',
      'flow.call saveIdentity(page, "member");',
      'flow.browser.use {"name":"administrator"};',
      'flow.call checkIdentity(page, "administrator");',
    ].join('\n'), 'flow.assert.value {"actual":"@workspace.id","operator":"equals","expected":"lease-1"};'), scenario('Reuse the names with a fresh fixture', [
      'flow.assert.value {"actual":"@workspace.id","operator":"equals","expected":"original"};',
      'flow.fixture.use setup({"browser":true}) as "workspace";',
    ].join('\n'), [
      'flow.browser.use {"name":"administrator"};',
      'flow.open "/";',
      'flow.call checkIdentity(page, null);',
      'flow.browser.use {"name":"member"};',
      'flow.open "/";',
      'flow.call checkIdentity(page, null);',
    ].join('\n'), 'flow.assert.value {"actual":"@workspace.id","operator":"equals","expected":"lease-2"};')));
    const result = await execute(f);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(f.events(), [
      '/api/fixture-acquire?id=lease-1', '/api/fixture-release?id=lease-1',
      '/api/fixture-acquire?id=lease-2', '/api/fixture-release?id=lease-2',
    ]);
    assert.deepEqual(f.summary().fixtureCleanups.map(item => item.status), Array(6).fill('passed'));
    assert.equal(f.summary().status, 'passed');
  });
}

test('Partial setup releases earlier resources and reports cleanup failure separately with redaction', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.config({ retries: 1 });
  const privateValue = 'fixture-password-must-stay-private';
  f.write(flow(scenario('Fail during setup and teardown',
    'flow.fixture.use failingSetup({"password":"' + privateValue + '"});')));
  const result = await execute(f);
  assert.equal(result.code, 1, result.output);
  assert.deepEqual(f.events(), ['/api/fixture-acquire?id=partial', '/api/fixture-release?id=partial']);
  const report = f.summary();
  assert.match(report.steps.find(item => item.status === 'failed').error, /stopped before completion/);
  assert.equal(report.metrics.total, 3);
  assert.deepEqual(report.fixtureCleanups.map(item => item.status), ['failed', 'passed']);
  assert.match(report.fixtureCleanups[0].error, /Resource disposal failed: \[REDACTED\]/);
  assert.match(report.errors.join(' '), /Fixture "failingSetup" cleanup failed/);
  assert.equal(report.attempts.length, 1);
  const junit = fs.readFileSync(path.join(f.dir, 'flowstride-artifacts/junit.xml'), 'utf8');
  assert.match(junit, /Fixture &quot;failingSetup&quot; cleanup failed/);
  assert(![JSON.stringify(report), result.output, junit].some(value => value.includes(privateValue)));
});

for (const retrySetup of [true, false]) {
  test('A failed ' + (retrySetup ? 'setup' : 'test') + ' releases its lease before retrying', { timeout: 45000 }, async t => {
    const f = await fixtures(t);
    f.config({ retries: 1 });
    f.write(flow(scenario('Retry with a clean lease',
      'flow.fixture.use setup(' + JSON.stringify({ retrySetup, browser: true }) + ') as "workspace";',
      retrySetup ? 'flow.get "/api/check";' : 'flow.get "/api/retry?case=fixture";')));
    const result = await execute(f);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(f.events(), [
      '/api/fixture-acquire?id=lease-1', '/api/fixture-release?id=lease-1',
      '/api/fixture-acquire?id=lease-2', '/api/fixture-release?id=lease-2',
    ]);
    assert.deepEqual(f.summary().attempts.map(item => item.status), ['failed', 'passed']);
    assert(f.summary().attempts[1].flaky);
  });
}

async function interruptOnceReady(t, f, ready, args = [], extra = {}) {
  const child = spawn(process.execPath, [path.join(root, 'dist/cli/index.js'), 'run', 'flows', '--ci', ...args], {
    cwd: f.dir,
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), CI: 'true', FLOWSTRIDE_TOKEN: '', FLOWSTRIDE_API_URL: f.url, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  const deadline = Date.now() + 15000;
  while (!ready()) {
    assert(child.exitCode === null && Date.now() < deadline, output);
    await delay(20);
  }
  assert(child.kill('SIGTERM'));
  assert.equal(await exit, 130, output);
}

test('SIGTERM during async fixture setup releases registered resources and records interruption', { timeout: 30000 }, async t => {
  const f = await fixtures(t);
  f.config({ timeout: 18000 });
  f.write(flow(scenario('Interrupt fixture setup', 'flow.fixture.use setup({"interrupt":true});')));
  await interruptOnceReady(t, f, () => f.events().includes('/api/fixture-awaiting?id=lease-1'));
  assert.equal(f.summary().status, 'interrupted');
  assert.deepEqual(f.events(), [
    '/api/fixture-acquire?id=lease-1', '/api/fixture-awaiting?id=lease-1', '/api/fixture-release?id=lease-1',
  ]);
  assert.equal(f.summary().fixtureCleanups[0].status, 'passed');
});

for (const mode of ['handoff', 'older']) {
  test('Open CLI uses the correct engine for fixtures with ' + mode + ' Pro', {
    skip: privateEngine || !cloud,
    timeout: 45000,
  }, async t => {
    const f = await fixtures(t);
    prepare(f, mode);
    if (mode === 'older') {
      for (const name of ['flow_worker', 'flow_orchestrator']) {
        const file = path.join(f.dir, 'node_modules/@flowstride/pro/dist/runner', name + '.js');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('nativeDataProtocol', 'nativeFixtureProtocol'));
      }
    }
    f.write(flow(scenario('Run on a compatible engine', 'flow.fixture.use setup();')));
    const result = await execute(f);
    assert.equal(result.code, 0, result.output);
    assert.equal(f.summary().engine, mode === 'handoff' ? 'Enterprise (Pro)' : 'Open Source');
    assert.equal(f.summary().fixtureCleanups[0].status, 'passed');
    if (mode === 'older') assert.match(result.output, /does not support runner-managed fixtures/);
  });
}

function useService(options = {}) {
  return 'flow.fixture.worker shared(' + JSON.stringify(options) + ') as "service";';
}

function recordService(route = 'use-service') {
  return 'flow.get "/api/fixture-' + route + '?id=@service.id";';
}

test('Worker fixture reuse spans scenarios and files, with a separate instance for different arguments', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.write(flow(
    scenario('Scenario one', useService(), recordService()),
    scenario('Scenario two', useService(), recordService()),
    scenario('Different settings', useService({ name: 'alternate' }), recordService()),
  ), 'a.flow');
  f.write(flow(scenario('Another file on the same worker', useService(), recordService())), 'b.flow');
  const result = await execute(f);
  assert.equal(result.code, 0, result.output);
  const [start, use1, use2, alternate, useAlternate, use3, stopAlt, stop] = f.events();
  assert.equal(f.events().length, 8);
  assert.match(start, /^\/api\/fixture-start-service\?id=service-\d+-1$/);
  assert.match(alternate, /^\/api\/fixture-start-service\?id=alternate-\d+-2$/);
  assert.deepEqual([use1, use2, use3], Array(3).fill(start.replace('start-service', 'use-service')));
  assert.equal(useAlternate, alternate.replace('start-service', 'use-service'));
  assert.equal(stopAlt, alternate.replace('start-service', 'stop-service'));
  assert.equal(stop, start.replace('start-service', 'stop-service'));
  assert.deepEqual(f.summary().fixtureCleanups.map(item => [item.scope, item.status]), [
    ['worker', 'passed'], ['worker', 'passed'],
  ]);
});

test('A worker fixture with failed setup releases its partial resources and is retried', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.config({ retries: 1 });
  f.write(flow(scenario('Set up the shared service', useService({ retrySetup: true }), recordService())));
  const result = await execute(f);
  assert.equal(result.code, 0, result.output);
  const [start1, stop1, start2, use2, stop2] = f.events();
  assert.equal(f.events().length, 5);
  assert.notEqual(start1, start2);
  assert.equal(stop1, start1.replace('start-service', 'stop-service'));
  assert.equal(use2, start2.replace('start-service', 'use-service'));
  assert.equal(stop2, start2.replace('start-service', 'stop-service'));
  assert.deepEqual(f.summary().attempts.map(item => item.status), ['failed', 'passed']);
});

test('Worker fixture teardown errors fail CI separately from passing test steps', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.write(flow(scenario('Test succeeds', useService({ failCleanup: true }), recordService())));
  const result = await execute(f);
  assert.equal(result.code, 1, result.output);
  const report = f.summary();
  assert.equal(report.status, 'failed');
  assert.equal(report.metrics.passed, 3);
  assert.equal(report.metrics.failed, 0);
  assert.equal(report.attempts[0].status, 'passed');
  assert.equal(report.fixtureCleanups[0].scope, 'worker');
  assert.equal(report.fixtureCleanups[0].status, 'failed');
  assert.match(report.fixtureCleanups[0].error, /Service teardown failed/);
});

test('Worker fixtures cannot hold attempt-owned profiles and release partial setup immediately', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.write(flow(scenario('Invalid fixture scope for a browser profile', useService({ profile: true }))));
  const result = await execute(f);
  assert.equal(result.code, 1, result.output);
  assert.equal(f.events().length, 2);
  assert.equal(f.events()[1], f.events()[0].replace('start-service', 'stop-service'));
  assert.match(f.summary().steps.find(item => item.status === 'failed').error, /Browser profiles belong to scenario-attempt fixtures/);
});

test('Pro parallel workers get separate worker fixtures and fresh attempt leases on retry', {
  skip: !privateEngine && !cloud,
  timeout: 45000,
}, async t => {
  const f = await fixtures(t);
  const env = { ...(privateEngine ? {} : prepare(f, 'handoff')), ...parallelWorkerEnv(f) };
  const setup = [
    useService(),
    'flow.fixture.use setup({"browser":true,"distinct":true}) as "workspace";',
  ].join('\n');
  const when = [
    recordService(),
    'flow.browser.use {"name":"member"};',
    'flow.open "/";',
    'flow.call saveIdentity(page, "@workspace.id");',
  ].join('\n');
  f.config({ retries: 1 });
  f.write(flow(scenario('Retries after an application error', setup, when + '\nflow.get "/api/retry?case=parallel";')), 'a.flow');
  f.write(flow(scenario('Maintains its own lease', setup, when + '\nflow.get "/api/check";')), 'b.flow');
  const result = await execute(f, ['--workers', '2'], env);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Distributing 2 files to 2 workers/);
  const events = f.events();
  const started = events.filter(url => url.includes('start-service'));
  assert.equal(started.length, 2);
  assert.notEqual(started[0], started[1]);
  const uses = started.map(start => {
    const use = start.replace('start-service', 'use-service');
    const stop = start.replace('start-service', 'stop-service');
    assert(events.indexOf(stop) > events.lastIndexOf(use));
    assert.equal(events.filter(url => url === stop).length, 1);
    return events.filter(url => url === use).length;
  });
  assert.deepEqual(uses.sort(), [1, 2]);
  const report = f.summary();
  assert.equal(report.status, 'passed');
  assert.equal(report.attempts.filter(item => item.flaky).length, 1);
  assert.equal(report.fixtureCleanups.filter(item => item.scope === 'worker').length, 2);
  const leases = events.filter(url => url.includes('fixture-acquire'));
  assert.equal(new Set(leases).size, 3);
  const owners = new Set(leases.map(url => url.split('?id=')[1].split('-lease-')[0]));
  assert.equal(owners.size, 2);
  for (const lease of leases) {
    const release = lease.replace('acquire', 'release');
    assert.equal(events.filter(url => url === release).length, 1);
    assert(events.indexOf(release) > events.indexOf(lease));
    const retry = lease.replace(/1$/, '2');
    if (lease.endsWith('-1') && leases.includes(retry)) {
      assert(events.indexOf(release) < events.indexOf(retry));
    }
  }
});

test('Fixture timeout records the failed setup and still releases the acquired resource', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.config({ timeout: 2200 });
  f.write(flow(scenario('Setup exceeds its deadline', 'flow.fixture.use setup({"interrupt":true});')));
  const result = await execute(f);
  assert.equal(result.code, 1, result.output);
  const report = f.summary();
  assert.match(report.steps.find(item => item.status === 'failed').error, /Fixture setup exceeded its 2200ms timeout/);
  assert.deepEqual(f.events(), [
    '/api/fixture-acquire?id=lease-1', '/api/fixture-awaiting?id=lease-1', '/api/fixture-release?id=lease-1',
  ]);
  assert.equal(report.fixtureCleanups[0].status, 'passed');
});

test('A test assertion and a failing fixture callback retain independent failure details', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.write(flow(scenario('Test and cleanup both fail', [
    'flow.fixture.use setup({"failCleanup":true});',
    'flow.cleanup.register {"method":"DELETE","url":"/api/fixture-manual-release"};',
  ].join('\n'), 'flow.get "/api/check";', 'flow.expect status "201";')));
  const result = await execute(f);
  assert.equal(result.code, 1, result.output);
  const report = f.summary();
  assert.equal(report.metrics.total, 4);
  assert.match(report.steps.find(item => item.command === 'expect').error, /201/);
  assert.match(report.fixtureCleanups[0].error, /Attempt cleanup error/);
  assert.deepEqual(f.events(), [
    '/api/fixture-acquire?id=lease-1', '/api/fixture-manual-release', '/api/fixture-release?id=lease-1',
  ]);
});

test('A profile collision releases profiles already acquired and preserves the original profile', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.write(flow(
    scenario('Partially create fixture profiles', [
      'flow.browser.create {"name":"existing"};',
      'flow.open "/";',
      'flow.call saveIdentity(page, "existing");',
      'flow.fixture.use setup({"browser":true,"extraProfile":"existing"});',
    ].join('\n')),
    scenario('Reuse a released name and check the original identity',
      'flow.fixture.use setup({"browser":true});', [
        'flow.browser.use {"name":"existing"};',
        'flow.call checkIdentity(page, "existing");',
        'flow.browser.use {"name":"administrator"};',
        'flow.call checkIdentity(page, null);',
      ].join('\n'), 'flow.assert.value {"actual":true,"operator":"equals","expected":true};'),
  ));
  const result = await execute(f);
  assert.equal(result.code, 1, result.output);
  const report = f.summary();
  assert.deepEqual(report.attempts.map(item => item.status), ['failed', 'passed']);
  assert.match(report.steps.find(item => item.status === 'failed').error, /Browser profile already exists: existing/);
  assert.deepEqual(report.fixtureCleanups.map(item => item.status), Array(6).fill('passed'));
});

test('Cancelling a parallel Pro run tears down fixtures in both workers', {
  skip: !privateEngine && !cloud,
  timeout: 35000,
}, async t => {
  const f = await fixtures(t);
  f.config({ timeout: 18000 });
  const env = { ...(privateEngine ? {} : prepare(f, 'handoff')), ...parallelWorkerEnv(f) };
  const given = useService() + '\nflow.fixture.use setup({"interrupt":true,"distinct":true});';
  f.write(flow(scenario('Interrupt the first worker', given)), 'a.flow');
  f.write(flow(scenario('Interrupt the second worker', given)), 'b.flow');
  await interruptOnceReady(t, f, () => f.events().filter(event => event.includes('fixture-awaiting')).length === 2, ['--workers', '2'], env);
  const report = f.summary();
  assert.equal(report.status, 'interrupted');
  const events = f.events();
  for (const start of events.filter(url => url.includes('start-service'))) {
    const pid = start.split('?id=service-')[1].split('-')[0];
    const release = events.indexOf('/api/fixture-release?id=' + pid + '-lease-1');
    const stop = events.indexOf(start.replace('start-service', 'stop-service'));
    assert(release > -1 && stop > release);
  }
  assert.deepEqual(report.fixtureCleanups.map(item => item.status), Array(4).fill('passed'));
});

test('Merged CI shard summaries preserve fixture cleanup from each shard', { timeout: 45000 }, async t => {
  const f = await fixtures(t);
  f.write(flow(scenario('First file', 'flow.fixture.use setup();')), 'a.flow');
  f.write(flow(scenario('Second file', 'flow.fixture.use setup();')), 'b.flow');
  for (const shard of [1, 2]) {
    const result = await execute(f, ['--shard', shard + '/2']);
    assert.equal(result.code, 0, result.output);
    fs.renameSync(path.join(f.dir, 'flowstride-artifacts'), path.join(f.dir, 'shard-' + shard));
  }
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, [
    path.join(root, 'dist/cli/index.js'), 'merge', 'shard-1/summary.json', 'shard-2/summary.json',
  ], { cwd: f.dir });
  const result = JSON.parse(fs.readFileSync(path.join(f.dir, 'flowstride-merged/summary.json')));
  assert.deepEqual(result.fixtureCleanups.map(item => [item.fileName, item.status, item.shard]), [
    ['a.flow', 'passed', 1], ['b.flow', 'passed', 2],
  ]);
});
