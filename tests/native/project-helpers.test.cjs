
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Lexer } = require('../../dist/parser/lexer');
const { Parser } = require('../../dist/parser/parser');
const { callProjectHelper } = require('../../dist/runner/project_helper');
const { root, cloud, privateEngine, fixture, execute, prepare } = require('./batch5.fixtures.cjs');

function parse(source) {
  return new Parser(new Lexer(source).tokenise()).parse();
}

function scenario(imports, when, then = 'flow.expect visible "Customer workspace";') {
  return `Feature: Plain project helpers
${imports}
Scenario: Use normal functions
  Given "Open the local app"
    flow.open "/";
  When "Run project code"
    ${when}
  Then "Check the outcome"
    ${then}
`;
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('Feature imports and parenthesized calls parse without changing .flowpart calls', () => {
  const [feature] = parse(scenario(
    'import { calculate, verify } from "catalog/prices.ts";',
    'flow.call calculate();\nflow.call verify(page, {"name":"title ) \\"quoted\\"", "rows":[1,true,null]});\nflow.call "parts/save.flowpart";',
  ));

  assert.deepEqual(feature.declarations.map(({ alias, path, kind }) => [alias, path, kind]), [
    ['calculate', 'catalog/prices.ts', 'helper'],
    ['verify', 'catalog/prices.ts', 'helper'],
  ]);
  const [empty, withPage, fragment] = feature.scenarios[0].steps.slice(1, 4);
  assert.equal(empty.action, 'helper');
  assert.deepEqual(empty.payload, { name: 'calculate', args: [], usePage: false });
  assert.deepEqual(withPage.payload, {
    name: 'verify', args: [{ name: 'title ) "quoted"', rows: [1, true, null] }], usePage: true,
  });
  assert.equal(fragment.action, 'native');
  assert.equal(fragment.payload.data, 'parts/save.flowpart');
});

test('Helper syntax preserves Feature scope and assertion-only And blocks', () => {
  const importLine = 'import { verify } from "verify.js";';
  assert.throws(() => parse(scenario(importLine + '\n' + importLine, 'flow.call verify();')), /already imported/);
  assert.throws(() => parse(scenario('', importLine)), /Import helpers under Feature/);
  assert.throws(() => parse(scenario('', 'flow.call verify(1, page);')), /Helper arguments must be JSON values/);
  assert.throws(() => parse(scenario('', 'flow.call verify(page,);')), /Helper arguments must be JSON values/);
  assert.throws(() => parse(scenario('', 'flow.call verify(')), /missing its closing/);
  assert.throws(() => parse(scenario(importLine, 'flow.call verify();\nAnd "Assert" \nflow.call verify();')), /And blocks are strictly for assertions/);
  assert.throws(() => parse(scenario(importLine + '\nflow.call verify();', 'flow.call verify();')), /inside a scenario block/);
});

test('Helper modules use normal JavaScript exports and project path rules', async t => {
  const f = await fixture();
  t.after(f.close);
  const flowFile = write(f.dir, 'flows/nested/sample.flow', 'Fixture');
  const config = { projectRoot: f.dir, helpersDir: 'lib' };
  const call = { args: ['example'], usePage: false };
  const noPage = () => { throw new Error('Pure helpers do not need a page.'); };
  write(f.dir, 'lib/package.json', '{"type":"module"}');
  write(f.dir, 'lib/message.js', 'export async function message(name) { await Promise.resolve(); return name; }');
  write(f.dir, 'flows/nested/local.js', 'module.exports = { message: name => "local " + name };');
  assert.equal(await callProjectHelper(config, flowFile, { path: 'message.js', alias: 'message' }, call, noPage), 'example');
  assert.equal(await callProjectHelper(config, flowFile, { path: './local.js', alias: 'message' }, call, noPage), 'local example');
  await assert.rejects(callProjectHelper(config, flowFile, { path: 'message.js', alias: 'missing' }, call, noPage), /not a named function export/);
  await assert.rejects(callProjectHelper(config, flowFile, { path: 'missing.js', alias: 'message' }, call, noPage), /ENOENT/);
  await assert.rejects(callProjectHelper(config, flowFile, { path: 'nested/../../flows/nested/local.js', alias: 'message' }, call, noPage), /inside the project/);
  await assert.rejects(callProjectHelper(config, flowFile, { path: '../../../../outside.js', alias: 'message' }, call, noPage), /inside the project/);
  fs.symlinkSync(__filename, path.join(f.dir, 'lib/outside.js'));
  await assert.rejects(callProjectHelper(config, flowFile, { path: 'outside.js', alias: 'message' }, call, noPage), /Symlink escapes/);
  write(f.dir, 'lib/invalid.ts', 'export function broken() {\n  const value = ;\n}');
  await assert.rejects(callProjectHelper(config, flowFile, { path: 'invalid.ts', alias: 'broken' }, call, noPage), /invalid\.ts\(2,\d+\).*TS1109/);
});

for (const mode of ['direct', 'handoff', 'older']) {
  test(`Plain JS, TS, SDK plugins and fragments work through the ${mode} CLI`, {
    skip: mode !== 'direct' && (privateEngine || !cloud),
    timeout: 45000,
  }, async t => {
    const f = await fixture();
    t.after(f.close);
    if (mode === 'handoff') prepare(f, 'handoff');
    if (mode === 'older') {
      prepare(f, 'older');
      for (const name of ['flow_worker', 'flow_orchestrator']) {
        const file = path.join(f.dir, 'node_modules/@flowstride/pro/dist/runner', name + '.js');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('nativeDataProtocol', 'nativeHelperProtocol'));
      }
    }
    const helper = write(f.dir, 'helpers/logic.js', `
      const assert = require('node:assert/strict');
      module.exports = {
        checkLogic(options) {
          const prices = Array.from({ length: options.count }, (_, i) => i + 1);
          let sum = 0;
          for (const price of prices) sum += price;
          assert.equal(sum, 1275);
        },
        async setName(page, name) {
          await page.getByLabel('Customer name').fill(name);
        },
      };
    `);
    write(f.dir, 'helpers/esm/package.json', '{"type":"module"}');
    write(f.dir, 'helpers/esm/assertion.ts', `
      enum Result { Saved = "Saved" }
      export async function seeSaved(page: import('playwright').Page, name: string) {
        await page.getByText(Result.Saved + ' ' + name, { exact: true }).waitFor();
      }
    `);
    write(f.dir, 'helpers/validate.ts', `
      enum Catalog { Expected = 50 }
      export function expectCount(count: number) {
        if (count !== Catalog.Expected) throw new Error('Unexpected number of products');
      }
    `);
    write(f.dir, 'plugins/existing.ts', `
      export async function check(sdk: any) {
        await sdk.browser.page().getByRole('heading', { name: 'Customer workspace' }).waitFor();
      }
    `);
    write(f.dir, 'parts/save.flowpart', 'flow.click button "Save customer";');
    const imports = [
      'import { checkLogic, setName } from "logic.js";',
      'import { seeSaved } from "esm/assertion.ts";',
      'import { expectCount } from "validate.ts";',
      'let existing = "existing";',
    ].join('\n');
    for (const [file, name] of [['plain.flow', 'Lagos customer'], ['nested/plain.flow', 'Abuja customer']]) {
      write(f.dir, 'flows/' + file, scenario(
        imports,
        `flow.call checkLogic({"count":50});\n    flow.call expectCount(50);\n    flow.call setName(page, "${name}");\n    flow.call "parts/save.flowpart";`,
        `flow.call seeSaved(page, "${name}");\n    existing.check {};`,
      ));
    }

    const run = await execute(f);
    assert.equal(run.code, 0, run.output);
    const summary = f.summary();
    assert.equal(summary.status, 'passed');
    assert.equal(summary.steps.filter(step => step.commandLabel === 'flow.call').length, 8);
    if (mode === 'handoff') assert.equal(summary.engine, 'Enterprise (Pro)');
    if (mode === 'older') {
      assert.match(summary.engine, /Open Source/i);
      assert.match(run.output, /Installed Pro engine does not support JavaScript and TypeScript helpers/);
    }

    if (mode === 'direct') {
      const playwrightTest = path.join(root, 'node_modules/playwright/test');
      write(f.dir, 'reuse.spec.cjs', `
        const { test, expect } = require(${JSON.stringify(playwrightTest)});
        const { setName } = require(${JSON.stringify(helper)});
        test('reuse the same existing project helper', async ({ page }) => {
          await page.goto(${JSON.stringify(f.url)});
          await setName(page, 'Playwright customer');
          await expect(page.getByLabel('Customer name')).toHaveValue('Playwright customer');
        });
      `);
      await promisify(execFile)(process.execPath, [path.join(root, 'node_modules/playwright/cli.js'), 'test', '--workers=1', 'reuse.spec.cjs'], {
        cwd: f.dir, env: { ...process.env, CI: 'true' }, encoding: 'utf8', timeout: 20000,
      });
    }
  });
}



test('Helper captures parse with the existing local and global variable grammar', () => {
  const imports = 'import { generateEmail } from "email.js";';
  const [feature] = parse(scenario(imports,
    'flow.call generateEmail() as "signupEmail";\nflow.call generateEmail() as global "sharedEmail";'));
  assert.deepEqual(feature.scenarios[0].steps.slice(1, 3).map(step => step.payload.capture), [
    { name: 'signupEmail', isGlobal: false },
    { name: 'sharedEmail', isGlobal: true },
  ]);
  assert.throws(() => parse(scenario(imports, 'flow.call generateEmail() as global "__proto__";')), /safe variable name/);
  assert.throws(() => parse(scenario(imports, 'flow.call generateEmail() as;')), /quoted variable name/);
});

for (const mode of ['direct', 'handoff']) {
  test(`Captured JSON and generated emails preserve type and scope through the ${mode} CLI`, {
    skip: mode === 'handoff' && (privateEngine || !cloud),
    timeout: 45000,
  }, async t => {
    const f = await fixture();
    t.after(f.close);
    if (mode === 'handoff') prepare(f, 'handoff');
    write(f.dir, 'helpers/returns.js', `
      const assert = require('node:assert/strict');
      const { randomUUID } = require('node:crypto');
      const order = { items: [{ sku: "CAR-1", quantity: 2 }], discounted: true, note: null };
      exports.generateEmail = () => 'signup-' + randomUUID() + '@example.test';
      exports.makeOrder = () => order;
      exports.opaque = () => '{{env.HELPER_MUST_NOT_EXPAND}} $randomEmail';
      exports.verifyOpaque = value => assert.equal(value, exports.opaque());
      exports.verifyOrder = (value, quantity) => {
        assert.deepEqual(value, order);
        assert.equal(quantity, 2);
        value.items[0].quantity = 99;
      };
      exports.checkAddresses = (first, second) => {
        assert.match(first, /^signup-[a-f0-9-]+@example\\.test$/);
        assert.match(second, /^signup-[a-f0-9-]+@example\\.test$/);
        assert.notEqual(first, second);
      };
      exports.checkNextFile = (shared, local) => {
        assert.deepEqual(shared, order);
        assert.equal(local, '@signupEmail');
      };
    `);
    const imports = 'import { generateEmail, makeOrder, checkAddresses, verifyOrder, opaque, verifyOpaque } from "returns.js";';
    write(f.dir, 'flows/capture.first.flow', scenario(imports, [
      'flow.call generateEmail() as "signupEmail";',
      'flow.call generateEmail() as "otherEmail";',
      'flow.call makeOrder() as "order";',
      'flow.call makeOrder() as global "sharedOrder";',
      'flow.call opaque() as "opaqueResult";',
      'flow.type input "Customer name" "@signupEmail";',
      'flow.click button "Save customer";',
    ].join('\n'), [
      'flow.expect visible "Saved @signupEmail";',
      'flow.call checkAddresses("@signupEmail", "@otherEmail");',
      'flow.call verifyOpaque("@opaqueResult");',
      'flow.call verifyOrder("@order", "@order.items[0].quantity");',
    ].join('\n')) + `
Scenario: Read the earlier scenario's captured value
  Given "Open the local app"
    flow.open "/";
  When "Read both email addresses"
    flow.call checkAddresses("@signupEmail", "@otherEmail");
  Then "Check that the stored object was detached from the helper arguments"
    flow.call verifyOrder("@order", "@order.items[0].quantity");
`);
    write(f.dir, 'flows/read.flow', scenario(
      'import { checkNextFile } from "returns.js";',
      'flow.call checkNextFile("@global[sharedOrder]", "@signupEmail");',
    ));
    const result = await execute(f);
    assert.equal(result.code, 0, result.output);
    assert.equal(f.summary().status, 'passed');
    assert.equal(f.summary().attempts.length, 3);
    if (mode === 'handoff') assert.equal(f.summary().engine, 'Enterprise (Pro)');
  });
}

test('CLI reports the flow call and the original nested JS and TS source lines', { timeout: 45000 }, async t => {
  const f = await fixture();
  t.after(f.close);
  const fixturePassword = 'fixture-helper-masked-063449';
  write(f.dir, 'helpers/fail.js', [
    'function failInside(value) {',
    '  throw new Error("JS fixture failure " + value.password);',
    '}',
    'exports.runJS = async value => failInside(value);',
  ].join('\n'));
  write(f.dir, 'helpers/module/package.json', '{"type":"module"}');
  write(f.dir, 'helpers/module/fail.ts', [
    'import { failInside } from "./details.js";',
    'export async function runTS() {',
    '  await Promise.resolve();',
    '  failInside();',
    '}',
  ].join('\n'));
  write(f.dir, 'helpers/module/details.ts', [
    'enum FixtureError { Message = "TS fixture failure" }',
    'export function failInside(): never {',
    '  throw new Error(FixtureError.Message);',
    '}',
  ].join('\n'));
  write(f.dir, 'flows/js.flow', scenario('import { runJS } from "fail.js";',
    'flow.call runJS(' + JSON.stringify({ password: fixturePassword }) + ');'));
  write(f.dir, 'flows/ts.flow', scenario('import { runTS } from "module/fail.ts";', 'flow.call runTS();'));

  const result = await execute(f);
  assert.equal(result.code, 1, result.output);
  const calls = f.summary().steps.filter(step => step.commandLabel === 'flow.call' && step.status === 'failed');
  assert.equal(calls.length, 2, result.output);
  const js = calls.find(step => step.fileName === 'js.flow');
  const ts = calls.find(step => step.fileName === 'ts.flow');
  assert.match(js.error, /Location: js\.flow:7/);
  assert.match(js.error, /helpers\/fail\.js:2:\d+/);
  assert.match(js.error, /JS fixture failure \[REDACTED\]/);
  assert.match(ts.error, /Location: ts\.flow:7/);
  assert.match(ts.error, /helpers\/module\/details\.ts:3:\d+/);
  assert.match(ts.error, /TS fixture failure/);
  assert(!result.output.includes(fixturePassword), 'raw argument in CLI output');
  assert(!JSON.stringify(f.summary()).includes(fixturePassword), 'raw argument in summary');
});

test('Retry restores local helper captures before the next attempt', { timeout: 45000 }, async t => {
  const f = await fixture();
  t.after(f.close);
  f.config({ retries: 1 });
  write(f.dir, 'helpers/retry.js', `
    const assert = require('node:assert/strict');
    let times = 0;
    exports.assertClean = value => assert.equal(value, '@prepared');
    exports.prepare = () => ({ ok: true });
    exports.failOnce = () => { if (++times === 1) throw new Error('retry fixture'); };
  `);
  write(f.dir, 'flows/retry.flow', scenario(
    'import { assertClean, prepare, failOnce } from "retry.js";',
    'flow.call assertClean("@prepared");\nflow.call prepare() as "prepared";\nflow.call failOnce();',
    'flow.assert.value {"actual":"@prepared.ok","operator":"equals","expected":true};',
  ));
  const result = await execute(f);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(f.summary().attempts.map(attempt => attempt.status), ['failed', 'passed']);
  assert.equal(f.summary().attempts.at(-1).flaky, true);
});

test('Timed out and unsupported helper results cannot mutate a capture', { timeout: 45000 }, async t => {
  const f = await fixture();
  t.after(f.close);
  f.config({ timeout: 700 });
  write(f.dir, 'helpers/invalid.js', `
    exports.startValue = () => 'initial';
    exports.late = () => new Promise(resolve => setTimeout(() => resolve('too late'), 1200));
    exports.unsupported = () => new Date(0);
    exports.throwObject = () => { throw Object.create(null); };
  `);

  write(f.dir, 'flows/invalid.flow', scenario(
    'import { startValue, late, unsupported, throwObject } from "invalid.js";',
    'flow.call startValue() as global "captured";\nflow.call late() as global "captured";',
  ) + `
Scenario: An unsupported result leaves the original value
  Given "Open the local app"
    flow.open "/";
  When "Give the late helper time to finish"
    flow.wait 850;
  Then "The captured value still comes from the successful call"
    flow.assert.value {"actual":"@global[captured]","operator":"equals","expected":"initial"};
    flow.call unsupported() as global "captured";
Scenario: Verify the snapshot and report an unusual thrown value
  Given "Open the local app"
    flow.open "/";
  When "Use the earlier capture"
    flow.assert.value {"actual":"@global[captured]","operator":"equals","expected":"initial"};
  Then "Report the thrown object as a step failure"
    flow.call throwObject();
`);
  const result = await execute(f);
  assert.equal(result.code, 1, result.output);
  const summary = f.summary();
  const failures = summary.steps.filter(step => step.status === 'failed');
  assert.equal(failures.length, 3, result.output);
  assert(failures.every(step => step.commandLabel === 'flow.call'), result.output);
  assert.match(failures[0].error, /exceeded its 700ms timeout/);
  assert.match(failures[1].error, /Return plain JSON data/);
  assert.match(failures[2].error, /Helper "throwObject" failed/);
});
