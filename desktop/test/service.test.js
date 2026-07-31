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
