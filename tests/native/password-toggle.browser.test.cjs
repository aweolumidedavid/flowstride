const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium, firefox, webkit } = require('playwright');
const { WebAdapter } = require('../../dist/adapters/web/playwright');
const { Lexer } = require('../../dist/parser/lexer');
const { Parser } = require('../../dist/parser/parser');
const { assertBrowser } = require('../../dist/native/assertions');

const parse = command => new Parser(new Lexer('Feature: Passwords\nScenario: Visibility\nGiven "A password field"\nWhen "Change visibility"\n' + command + '\nThen "Finished"').tokenise()).parse()[0].scenarios[0].steps[0].payload;

test('passToggle accepts field and zero-based index independently and preserves literal clicks', () => {
  for (const [source, label, index] of [
    ['passToggle', '', undefined], ['passToggle[0]', '', 0], ['passToggle for "Password"', 'Password', undefined],
    ['passToggle[1] for "Confirm password"', 'Confirm password', 1],
  ]) {
    const parsed = parse('flow.click ' + source + ';');
    assert.equal(parsed.elementType, 'passToggle');
    assert.equal(parsed.selector, label);
    assert.equal(parsed.toggleIndex, index);
  }
  for (const invalid of ['passToggle[-1]', 'passToggle[1.5]', 'passToggle[]', 'passToggle[99999999999999999]', 'passToggle for ""', 'passToggle for', 'passToggle "Password"']) {
    assert.throws(() => parse('flow.click ' + invalid + ';'));
  }
  assert.equal(parse('flow.click "passToggle";').selector, 'passToggle');
});

for (const [name, engine] of Object.entries({chromium,firefox,webkit})) {
  test(name + ' clicks only associated controls and reports ambiguous, missing or unsupported targets', async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      const web = new WebAdapter({timeout:1200});
      web.getPage = () => page;
      web.getScope = () => page;
      const check = (label, condition) => assertBrowser(page, {target:{element:'input',text:label},condition,timeout:400}, 400, undefined, web);
      const doc = '<div><label>Password<input id="pw" type="password" value="practice-only"></label>' +
        '<button aria-label="Copy password" aria-controls="pw" onclick="throw Error(\'wrong button\')">Copy</button>' +
        '<button aria-pressed="false" aria-label="Changer" aria-controls="pw" onclick="pw.type=pw.type===\'text\'?\'password\':\'text\'"></button></div>' +
        '<div><label>Confirm password<input id="confirm" type="password"></label>' +
        '<button type="button" aria-label="Afficher" onclick="confirmField()"><svg data-icon="eye"></svg></button></div>' +
        '<script>function confirmField(){const input=document.querySelector("#confirm");input.type=input.type==="text"?"password":"text"}</script>';
      await page.route('https://toggle.test/**', route => route.fulfill({contentType:'text/html',body:'<iframe src="https://frame.test/outer"></iframe>'}));
      await page.route('https://frame.test/**', route => route.fulfill({contentType:'text/html',body:'<iframe src="https://child.test/form"></iframe>'}));
      await page.route('https://child.test/**', route => route.fulfill({contentType:'text/html',body:doc}));
      await page.goto('https://toggle.test/');
      await check('Password','masked');
      await assert.rejects(web.click('', 'passToggle'), /Found more than one password toggle.*2 matches.*passToggle\[0\].*passToggle\[1\]/);
      await check('Password','masked');
      await check('Confirm password','masked');
      await web.click('Password','passToggle');
      await check('Password','revealed');
      await check('Confirm password','masked');
      await web.click('','passToggle',1);
      await check('Confirm password','revealed');
      await web.click('Password','passToggle');
      await check('Password','masked');
      await assert.rejects(check('Password','revealed'), /revealed/);
      const frame = page.frames().find(item => item.url() === 'https://child.test/form');
      await frame.setContent('<div><label>PIN<input type="password"></label><button type="button"><svg></svg></button><button type="button"><svg></svg></button></div>');
      await frame.evaluate(() => {
        window.clicks = [];
        document.querySelectorAll('button').forEach((button, i) => button.onclick = () => window.clicks.push(i));
      });
      await assert.rejects(web.click('PIN','passToggle'), /more than one password toggle for "PIN" \(2 matches\).*passToggle\[0\] for "PIN".*passToggle\[1\] for "PIN"/);
      await assert.rejects(web.click('PIN','passToggle',2), /Found 2 matching controls/);
      assert.deepEqual(await frame.evaluate(() => window.clicks), []);
      await web.click('PIN','passToggle',1);
      await web.click('PIN','passToggle',0);
      assert.deepEqual(await frame.evaluate(() => window.clicks), [1,0]);
      await frame.setContent('<label>Email<input type="text"></label><label>Password<input type="password"></label><button>Copy password</button>');
      await assert.rejects(check('Email','revealed'), /visible password field/);
      await assert.rejects(web.click('Password','passToggle'), /Found 0 matching controls/);
      await frame.setContent('<div><label>Clave<input type="password"></label></div>');
      await frame.evaluate(() => setTimeout(() => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-label', 'Cambiar');
        button.innerHTML = '<svg width="16" height="16"></svg>';
        button.onclick = () => document.querySelector('input').type = 'text';
        document.querySelector('div').append(button);
      }, 120));
      await web.click('Clave','passToggle');
      await check('Clave','revealed');
      await frame.evaluate(() => document.querySelector('button').onclick = () => document.querySelector('input').type = 'password');
      await web.click('Clave','passToggle');
      await check('Clave','masked');
      await frame.setContent('<div id="component"></div>');
      await frame.evaluate(() => {
        document.querySelector('#component').attachShadow({mode:'open'}).innerHTML =
          '<label>Secret<input type="password" autocomplete="new-password"></label><button type="button" class="password-toggle">Changer</button>';
        const root = document.querySelector('#component').shadowRoot;
        root.querySelector('button').onclick = () => root.querySelector('input').type = 'text';
      });
      await web.click('Secret','passToggle');
      await check('Secret','revealed');
    } finally { await browser.close(); }
  });
}
