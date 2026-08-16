'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  candidatePorts,
  ensureService,
  ownedDataDirectory,
  parsePort,
  requestHealth,
  serverDirectory,
  startOwnedService,
  stopOwnedService,
} = require('../service');

test('parsePort fails closed for malformed and out-of-range values', () => {
  assert.equal(parsePort('8080'), 8080);
  assert.equal(parsePort(' 8080\n'), 8080);
  assert.equal(parsePort('0'), null);
  assert.equal(parsePort('65536'), null);
  assert.equal(parsePort('8080x'), null);
});

test('candidatePorts prefers a valid recorded port and removes duplicates', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-service-'));
  const portFile = path.join(tempDir, 'port');
  fs.writeFileSync(portFile, '8123\n');
  try {
    assert.deepEqual(candidatePorts({ portFiles: [portFile, portFile], scanDefault: false }), [8123]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('requestHealth only accepts the md-read health contract', async (context) => {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/api/health') return response.end('{}');
    const { port } = server.address();
    response.end(JSON.stringify({ ok: true, service: 'md-read', port }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await requestHealth(server.address().port);
  assert.equal(result.port, server.address().port);
  assert.equal(result.payload.service, 'md-read');
});

test('ensureService reuses a healthy service without spawning', async (context) => {
  const server = http.createServer((_request, response) => {
    const { port } = server.address();
    response.end(JSON.stringify({ ok: true, service: 'md-read', port }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-service-'));
  const portFile = path.join(tempDir, 'port');
  fs.writeFileSync(portFile, String(server.address().port));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let spawns = 0;

  const service = await ensureService({
    portFiles: [portFile],
    scanDefault: false,
    startService: () => { spawns += 1; throw new Error('不应触发'); },
  });
  assert.equal(service.port, server.address().port);
  assert.equal(spawns, 0);
});

test('ensureService spawns the owned service once and discovers its port', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-service-'));
  const portFile = path.join(tempDir, 'port');
  const server = http.createServer((_request, response) => {
    const { port } = server.address();
    response.end(JSON.stringify({ ok: true, service: 'md-read', port }));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const fakeChild = { exitCode: null, killed: false, mdturnSpawnError: null, kill() { this.killed = true; } };
  let spawns = 0;

  const service = await ensureService({
    portFiles: [],
    scanDefault: false,
    readyTimeoutMs: 1_000,
    pollIntervalMs: 10,
    startService: () => {
      spawns += 1;
      // 模拟内置服务异步就绪:上线后写端口文件,轮询应能发现它。
      server.listen(0, '127.0.0.1', () => {
        fs.writeFileSync(portFile, String(server.address().port));
      });
      return { child: fakeChild, dataDir: tempDir, portFile };
    },
  });
  assert.equal(spawns, 1);
  assert.equal(service.port, server.address().port);
  assert.equal(service.ownedProcess, fakeChild);
});

test('packaged paths use resources; data directory is shared and overridable', () => {
  const resourcesPath = path.resolve(path.parse(process.cwd()).root, 'app', 'resources');
  assert.equal(
    serverDirectory({ isPackaged: true, resourcesPath }),
    path.join(resourcesPath, 'mdturn-server'),
  );
  assert.equal(ownedDataDirectory({ dataDir: '/tmp/custom-mdread' }), path.resolve('/tmp/custom-mdread'));
  const fallback = ownedDataDirectory({});
  assert.ok(fallback === path.resolve(process.env.MDREAD_DATA_DIR || path.join(os.homedir(), '.mdread')));
});

test('startOwnedService uses Electron as Node with loopback and a dynamic port', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-spawn-'));
  fs.writeFileSync(path.join(tempDir, 'server.js'), '// fixture\n');
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let invocation = null;
  const fakeChild = new (require('node:events').EventEmitter)();
  fakeChild.exitCode = null;
  fakeChild.killed = false;
  fakeChild.kill = () => { fakeChild.killed = true; return true; };
  const dataDir = path.join(tempDir, 'data');
  const started = startOwnedService({
    serverDir: tempDir,
    dataDir,
    executablePath: 'MDTurn.exe',
    spawn: (...args) => { invocation = args; return fakeChild; },
  });
  assert.equal(invocation[0], 'MDTurn.exe');
  assert.deepEqual(invocation[1], [path.join(tempDir, 'server.js')]);
  assert.equal(invocation[2].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(invocation[2].env.MDREAD_DATA_DIR, path.resolve(dataDir));
  assert.equal(invocation[2].env.MDREAD_HOST, '127.0.0.1');
  assert.equal(invocation[2].env.MDREAD_PORT, '0');
  assert.equal(invocation[2].windowsHide, true);
  assert.equal(started.portFile, path.join(path.resolve(dataDir), 'port'));
});

test('stopOwnedService is safe to call repeatedly', () => {
  let kills = 0;
  const child = { exitCode: null, killed: false, kill() { kills += 1; this.killed = true; } };
  assert.equal(stopOwnedService({ ownedProcess: child }), true);
  assert.equal(stopOwnedService({ ownedProcess: child }), false);
  assert.equal(kills, 1);
});

test('startup timeout terminates the owned service', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-timeout-'));
  fs.writeFileSync(path.join(tempDir, 'server.js'), '// fixture\n');
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const child = new (require('node:events').EventEmitter)();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };

  await assert.rejects(ensureService({
    serverDir: tempDir,
    dataDir: path.join(tempDir, 'data'),
    portFiles: [],
    scanDefault: false,
    spawn: () => child,
    readyTimeoutMs: 20,
    pollIntervalMs: 5,
  }), /没有就绪/);
  assert.equal(child.killed, true);
});

test('startup reports an owned service that exits early', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-exit-'));
  fs.writeFileSync(path.join(tempDir, 'server.js'), '// fixture\n');
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const child = new (require('node:events').EventEmitter)();
  child.exitCode = 7;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };

  await assert.rejects(ensureService({
    serverDir: tempDir,
    dataDir: path.join(tempDir, 'data'),
    portFiles: [],
    scanDefault: false,
    spawn: () => child,
    readyTimeoutMs: 100,
    pollIntervalMs: 5,
  }), /提前退出（代码 7）/);
});
