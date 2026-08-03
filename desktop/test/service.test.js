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
  parsePort,
  requestHealth,
  serverDirectory,
  startWindowsService,
  stopOwnedService,
  windowsDataDirectory,
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

test('ensureService does not kickstart when a healthy service already exists', async (context) => {
  const server = http.createServer((_request, response) => {
    const { port } = server.address();
    response.end(JSON.stringify({ ok: true, service: 'md-read', port }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  let kickstarts = 0;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-service-'));
  const portFile = path.join(tempDir, 'port');
  fs.writeFileSync(portFile, String(server.address().port));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const service = await ensureService({
    platform: 'darwin',
    portFiles: [portFile],
    scanDefault: false,
    kickstart: async () => { kickstarts += 1; },
  });
  assert.equal(service.port, server.address().port);
  assert.equal(kickstarts, 0);
});

test('ensureService kickstarts once and then discovers the helper port', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-service-'));
  const portFile = path.join(tempDir, 'port');
  const server = http.createServer((_request, response) => {
    const { port } = server.address();
    response.end(JSON.stringify({ ok: true, service: 'md-read', port }));
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let kickstarts = 0;

  const service = await ensureService({
    platform: 'darwin',
    portFiles: [portFile],
    scanDefault: false,
    readyTimeoutMs: 1_000,
    pollIntervalMs: 10,
    kickstart: async () => {
      kickstarts += 1;
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      fs.writeFileSync(portFile, String(server.address().port));
    },
  });

  assert.equal(service.port, server.address().port);
  assert.equal(kickstarts, 1);
});

test('packaged Windows paths use resources and the Electron user data directory', () => {
  const resourcesPath = path.resolve(path.parse(process.cwd()).root, 'app', 'resources');
  const userDataPath = path.resolve(path.parse(process.cwd()).root, 'Users', 'test', 'AppData', 'MDTurn');
  assert.equal(
    serverDirectory({ isPackaged: true, resourcesPath }),
    path.join(resourcesPath, 'mdturn-server'),
  );
  assert.equal(
    windowsDataDirectory({ userDataDir: userDataPath }),
    path.join(userDataPath, 'mdread'),
  );
});

test('startWindowsService uses Electron as Node with loopback and a dynamic port', (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-win-spawn-'));
  fs.writeFileSync(path.join(tempDir, 'server.js'), '// fixture\n');
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let invocation = null;
  const fakeChild = new (require('node:events').EventEmitter)();
  fakeChild.exitCode = null;
  fakeChild.killed = false;
  fakeChild.kill = () => { fakeChild.killed = true; return true; };
  const started = startWindowsService({
    serverDir: tempDir,
    userDataDir: path.join(tempDir, 'user-data'),
    executablePath: 'MDTurn.exe',
    spawn: (...args) => { invocation = args; return fakeChild; },
  });
  assert.equal(invocation[0], 'MDTurn.exe');
  assert.deepEqual(invocation[1], [path.join(tempDir, 'server.js')]);
  assert.equal(invocation[2].env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(invocation[2].env.MDREAD_HOST, '127.0.0.1');
  assert.equal(invocation[2].env.MDREAD_PORT, '0');
  assert.equal(invocation[2].windowsHide, true);
  assert.equal(started.portFile, path.join(tempDir, 'user-data', 'mdread', 'port'));
});

test('stopOwnedService is safe to call repeatedly', () => {
  let kills = 0;
  const child = { exitCode: null, killed: false, kill() { kills += 1; this.killed = true; } };
  assert.equal(stopOwnedService({ ownedProcess: child }), true);
  assert.equal(stopOwnedService({ ownedProcess: child }), false);
  assert.equal(kills, 1);
});

test('Windows startup timeout terminates the owned service', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-win-timeout-'));
  fs.writeFileSync(path.join(tempDir, 'server.js'), '// fixture\n');
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const child = new (require('node:events').EventEmitter)();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };

  await assert.rejects(ensureService({
    platform: 'win32',
    serverDir: tempDir,
    userDataDir: path.join(tempDir, 'user-data'),
    portFiles: [],
    scanDefault: false,
    spawn: () => child,
    readyTimeoutMs: 20,
    pollIntervalMs: 5,
  }), /没有就绪/);
  assert.equal(child.killed, true);
});

test('Windows startup reports an owned service that exits early', async (context) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-win-exit-'));
  fs.writeFileSync(path.join(tempDir, 'server.js'), '// fixture\n');
  context.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const child = new (require('node:events').EventEmitter)();
  child.exitCode = 7;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };

  await assert.rejects(ensureService({
    platform: 'win32',
    serverDir: tempDir,
    userDataDir: path.join(tempDir, 'user-data'),
    portFiles: [],
    scanDefault: false,
    spawn: () => child,
    readyTimeoutMs: 100,
    pollIntervalMs: 5,
  }), /提前退出（代码 7）/);
});
