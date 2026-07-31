#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const MDREVIEW = path.join(PROJECT, 'mdreview.js');
const MDSHARE = path.join(PROJECT, 'mdshare.js');
const DAEMON = path.join(PROJECT, 'serve-daemon.sh');

function fixture(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(base, '数据 目录');
  const docs = path.join(base, '中文 文档');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  return { base, dataDir, docs };
}

function runNode(script, args, env = {}, cwd = '/') {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function runNodeAsync(script, args, env = {}, cwd = '/') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

async function waitFor(predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

test('mdreview open 严格校验 health 身份与响应端口', async (t) => {
  const f = fixture('mdread-health-');
  const source = path.join(f.docs, '方案 一.md');
  fs.writeFileSync(source, '# 方案\n');
  const opened = path.join(f.base, 'opened.txt');
  const preload = path.join(f.base, 'preload.js');
  fs.writeFileSync(preload, [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    'const original = cp.spawnSync;',
    'cp.spawnSync = function(command, args) {',
    "  if (command === '/bin/launchctl') return { status: 99, stdout: '', stderr: 'INTERCEPTED_NO_PRODUCTION' };",
    "  if (command === '/usr/bin/open' && args[0] === '-a') return { status: 1, stdout: '', stderr: 'MDTurn not installed' };",
    "  if (command === '/usr/bin/open') { fs.writeFileSync(process.env.OPEN_CAPTURE, args[0]); return { status: 0, stdout: '', stderr: '' }; }",
    '  return original.apply(this, arguments);',
    '};',
  ].join('\n'));

  let response = { ok: true, service: 'unrelated', port: null };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  response.port = port;
  fs.writeFileSync(path.join(f.dataDir, 'port'), `${port}\n`);
  const env = {
    MDREAD_DATA_DIR: f.dataDir,
    MDREAD_PORT: '65535',
    NODE_OPTIONS: `--require=${preload}`,
    OPEN_CAPTURE: opened,
  };

  const rejected = await runNodeAsync(MDREVIEW, ['open', source], env);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /SERVICE_START_FAILED/);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'reviews.json')), false);

  response = { ok: true, service: 'md-read', port: port === 65535 ? 65534 : port + 1 };
  const wrongPort = await runNodeAsync(MDREVIEW, ['open', source], env);
  assert.equal(wrongPort.status, 1);
  assert.match(wrongPort.stderr, /SERVICE_START_FAILED/);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'reviews.json')), false);

  response = { ok: true, service: 'md-read', port };
  const accepted = await runNodeAsync(MDREVIEW, ['open', source], env);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(fs.readFileSync(opened, 'utf8'), new RegExp(`^http://127\\.0\\.0\\.1:${port}/r/`));
});

test('mdreview open 优先把文档交给已安装的 MDTurn，并保留本地 URL 输出', async (t) => {
  const f = fixture('mdturn-open-');
  const source = path.join(f.docs, 'MDTurn 优先.md');
  fs.writeFileSync(source, '# MDTurn\n');
  const appBundle = path.join(f.base, 'MDTurn.app');
  fs.mkdirSync(appBundle);
  const opened = path.join(f.base, 'opened.json');
  const preload = path.join(f.base, 'preload.js');
  fs.writeFileSync(preload, [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    'const original = cp.spawnSync;',
    'cp.spawnSync = function(command, args) {',
    "  if (command === '/bin/launchctl') return { status: 99, stdout: '', stderr: 'INTERCEPTED_NO_PRODUCTION' };",
    "  if (command === '/usr/bin/open') { fs.writeFileSync(process.env.OPEN_CAPTURE, JSON.stringify(args)); return { status: 0, stdout: '', stderr: '' }; }",
    '  return original.apply(this, arguments);',
    '};',
  ].join('\n'));

  const server = http.createServer((_req, res) => {
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'md-read', port }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  fs.writeFileSync(path.join(f.dataDir, 'port'), `${port}\n`);

  const result = await runNodeAsync(MDREVIEW, ['open', source], {
    MDREAD_DATA_DIR: f.dataDir,
    MDREAD_PORT: '65535',
    MDTURN_APP_PATH: appBundle,
    NODE_OPTIONS: `--require=${preload}`,
    OPEN_CAPTURE: opened,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(opened, 'utf8')), ['-a', fs.realpathSync(appBundle), fs.realpathSync(source)]);
  assert.match(result.stdout, new RegExp(`本地审阅: http://127\\.0\\.0\\.1:${port}/r/`));
});

test('端口文件与 MDREAD_PORT 必须是完整十进制整数', async () => {
  const f = fixture('mdread-port-strict-');
  const source = path.join(f.docs, '端口.md');
  fs.writeFileSync(source, '# 端口\n');
  fs.writeFileSync(path.join(f.dataDir, 'port'), '8080junk\n');
  const result = runNode(MDSHARE, [source], {
    MDREAD_DATA_DIR: f.dataDir,
    MDREAD_PORT: '1.5',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim().split('\n').at(-1), /^http:\/\/localhost:8080\/d\//);
});

test('mdshare 只接受 realpath 后的普通 .md 文件', () => {
  const f = fixture('mdread-share-file-');
  const directory = path.join(f.docs, '目录.md');
  fs.mkdirSync(directory);
  const rejected = runNode(MDSHARE, [directory], { MDREAD_DATA_DIR: f.dataDir });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /不是普通 \.md 文件/);

  const source = path.join(f.docs, '真实.md');
  const alias = path.join(f.docs, '别名.md');
  fs.writeFileSync(source, '# 真实\n');
  fs.symlinkSync(source, alias);
  const accepted = runNode(MDSHARE, [alias], { MDREAD_DATA_DIR: f.dataDir });
  assert.equal(accepted.status, 0, accepted.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'registry.json'), 'utf8'));
  assert.equal(Object.values(registry.links)[0].absPath, fs.realpathSync(source));
});

test('serve-daemon 在隔离目录中重启 Node 后使用新端口重建 Tunnel', { timeout: 15000 }, async (t) => {
  assert.equal(spawnSync('/bin/bash', ['-n', DAEMON]).status, 0);
  const f = fixture('mdread-daemon-');
  const bin = path.join(f.base, 'bin');
  fs.mkdirSync(bin);
  const nodePids = path.join(f.base, 'node-pids');
  const tunnelCalls = path.join(f.base, 'tunnel-calls');
  writeExecutable(path.join(bin, 'node'), `#!/bin/bash\nprintf '%s\\n' "$$" >> "$MDREAD_FAKE_NODE_PIDS"\nexec "${process.execPath}" "$@"\n`);
  writeExecutable(path.join(bin, 'cloudflared'), '#!/bin/bash\n' +
    'printf \'%s\\n\' "$*" >> "$MDREAD_FAKE_CF_CALLS"\n' +
    'echo \'INF https://unit-test.trycloudflare.com\'\n' +
    "trap 'exit 0' TERM INT HUP\n" +
    'while true; do sleep 1; done\n');
  writeExecutable(path.join(bin, 'curl'), '#!/bin/bash\nprintf \'200\'\n');

  const env = {
    ...process.env,
    MDREAD_BIN_DIR: bin,
    MDREAD_PROJECT_DIR: PROJECT,
    MDREAD_DATA_DIR: f.dataDir,
    MDREAD_PORT: '0',
    MDREAD_SERVER_LOG: path.join(f.base, 'server.log'),
    MDREAD_TUNNEL_LOG: path.join(f.base, 'tunnel.log'),
    MDREAD_TUNNEL_PREV_LOG: path.join(f.base, 'tunnel.prev.log'),
    MDREAD_CHECK_INTERVAL: '0.05',
    MDREAD_FAKE_NODE_PIDS: nodePids,
    MDREAD_FAKE_CF_CALLS: tunnelCalls,
  };
  const daemon = spawn('/bin/bash', [DAEMON], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  daemon.stderr.on('data', (chunk) => { stderr += chunk; });
  let stopped = false;
  async function stopDaemon() {
    if (stopped) return;
    stopped = true;
    daemon.kill('SIGTERM');
    await new Promise((resolve) => daemon.once('close', resolve));
  }
  t.after(stopDaemon);

  const first = await waitFor(() => {
    if (!fs.existsSync(nodePids) || !fs.existsSync(tunnelCalls) || !fs.existsSync(path.join(f.dataDir, 'port'))) return null;
    const pids = fs.readFileSync(nodePids, 'utf8').trim().split('\n').filter(Boolean);
    const calls = fs.readFileSync(tunnelCalls, 'utf8').trim().split('\n').filter(Boolean);
    const port = Number(fs.readFileSync(path.join(f.dataDir, 'port'), 'utf8').trim());
    return pids.length >= 1 && calls.length >= 1 && port ? { pid: Number(pids[0]), port, call: calls[0] } : null;
  }, '首次 Node/Tunnel 未就绪');
  assert.match(first.call, new RegExp(`--url http://127\\.0\\.0\\.1:${first.port}$`));

  process.kill(first.pid, 'SIGTERM');
  const second = await waitFor(() => {
    try {
      const pids = fs.readFileSync(nodePids, 'utf8').trim().split('\n').filter(Boolean);
      const calls = fs.readFileSync(tunnelCalls, 'utf8').trim().split('\n').filter(Boolean);
      const port = Number(fs.readFileSync(path.join(f.dataDir, 'port'), 'utf8').trim());
      return pids.length >= 2 && calls.length >= 2 && port ? { pid: Number(pids.at(-1)), port, call: calls.at(-1) } : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }, 'Node 重启后 Tunnel 未重建');
  assert.notEqual(second.pid, first.pid);
  assert.notEqual(second.port, first.port);
  assert.match(second.call, new RegExp(`--url http://127\\.0\\.0\\.1:${second.port}$`));

  await stopDaemon();
  assert.equal(daemon.exitCode, 0, stderr);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'url')), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, 'port')), false);
});
