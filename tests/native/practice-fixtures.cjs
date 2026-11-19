const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const cli = path.resolve(__dirname, '../../dist/cli/index.js');
const starter = 'flows/examples/starter';

function workspace(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowstride-practice-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'local-network.cjs');
  fs.writeFileSync(preload, [
    "const { Socket } = require('node:net');",
    "const fs = require('node:fs');",
    "const connect = Socket.prototype.connect;",
    "Socket.prototype.connect = function (...args) {",
    "  const settings = Array.isArray(args[0]) ? args[0][0] : args[0];",
    "  const host = typeof settings === 'object' && settings ? settings.host : args[1];",
    "  if (typeof host === 'string' && !['localhost', '127.0.0.1', '::1'].includes(host)) {",
    "    fs.appendFileSync(process.env.PRACTICE_TEST_NETWORK_LOG, host + '\\n');",
    "    throw new Error('The practice test denies non-loopback connections.');",
    "  }",
    "  return connect.apply(this, args);",
    "};",
  ].join('\n'));
  return {
    dir,
    env: { ...process.env, NODE_OPTIONS: '--require=' + JSON.stringify(preload), FLOWSTRIDE_TOKEN: '',
      PRACTICE_TEST_NETWORK_LOG: path.join(dir, 'network-attempts.txt') },
    summary: () => JSON.parse(fs.readFileSync(path.join(dir, 'flowstride-artifacts/summary.json'), 'utf8')),
  };
}

function launch(t, f, args, extraEnv = {}, timeoutMs = 26000) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: f.dir, env: { ...f.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const onData = data => { output += data; };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const finished = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out: flowstride ' + args.join(' ') + '\n' + output));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, output }); });
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  async function outputMatch(pattern) {
    for (let retry = 0; retry < 500; retry++) {
      const match = pattern.exec(output);
      if (match) return match[1];
      if (child.exitCode !== null || child.signalCode) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('CLI output did not match ' + pattern + '\n' + output);
  }
  return {
    child, finished, outputMatch,
    ready: () => outputMatch(/\[Practice app\] Ready at (http:\/\/127\.0\.0\.1:\d+)/),
  };
}

async function loopbackServer(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h1>Existing app</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { url: 'http://127.0.0.1:' + server.address().port, requests };
}

async function closed(url) {
  await assert.rejects(fetch(url + '/health', { signal: AbortSignal.timeout(1500) }));
}

async function session(url, email, password) {
  const response = await fetch(url + '/api/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}

const writeConfig = (dir, config) => fs.writeFileSync(path.join(dir, 'flowstride.config.json'), JSON.stringify(config));

function captureDashboardLaunch(f) {
  for (const key of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL', 'FLOWSTRIDE_NATIVE_CI', 'FLOWSTRIDE_API_KEY']) delete f.env[key];
  const launcher = path.join(f.dir, 'dashboard-launch.cjs');
  const dashboardModule = path.resolve(__dirname, '../../dist/native/dashboard');
  fs.writeFileSync(launcher, [
    'const { DashboardBrowser } = require(' + JSON.stringify(dashboardModule) + ');',
    "DashboardBrowser.prototype.open = async url => console.log('[Test dashboard] ' + url);",
  ].join('\n'));
  return { NODE_OPTIONS: f.env.NODE_OPTIONS + ' --require=' + JSON.stringify(launcher) };
}

module.exports = { starter, workspace, launch, closed, session, loopbackServer, writeConfig, captureDashboardLaunch };
