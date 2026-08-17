'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const store = require('../lib/review-store');
const { createReviewEventHub, sseFrame } = require('../lib/review-events');

const PROJECT = path.resolve(__dirname, '..');
const MDREVIEW = path.join(PROJECT, 'mdreview.js');

function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
        if (Date.now() >= deadline) return reject(new Error(message));
        setTimeout(check, 15);
      } catch (error) { reject(error); }
    };
    check();
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}),
        ...(options.headers || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function connectSse(port, pathname = '/api/app/events') {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: pathname }, (res) => {
      let raw = '';
      let buffer = '';
      const events = [];
      const waiters = [];

      function deliver(event) {
        const waiterIndex = waiters.findIndex((waiter) => !waiter.name || waiter.name === event.name);
        if (waiterIndex >= 0) {
          const [waiter] = waiters.splice(waiterIndex, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(event);
        } else events.push(event);
      }

      function consume(frame) {
        if (!frame || frame.startsWith(':') || frame.startsWith('retry:')) return;
        let name = 'message';
        const data = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) return;
        const text = data.join('\n');
        let payload = text;
        try { payload = JSON.parse(text); } catch {}
        deliver({ name, data: payload });
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
        buffer += chunk.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          consume(frame);
        }
      });
      res.on('error', reject);

      resolve({
        status: res.statusCode,
        headers: res.headers,
        raw: () => raw,
        next(name, timeoutMs = 15_000) {
          const index = events.findIndex((event) => !name || event.name === name);
          if (index >= 0) return Promise.resolve(events.splice(index, 1)[0]);
          return new Promise((resolveEvent, rejectEvent) => {
            const waiter = { name, resolve: resolveEvent, reject: rejectEvent, timer: null };
            waiter.timer = setTimeout(() => {
              const position = waiters.indexOf(waiter);
              if (position >= 0) waiters.splice(position, 1);
              rejectEvent(new Error(`SSE event timeout: ${name || '*'}`));
            }, timeoutMs);
            waiters.push(waiter);
          });
        },
        close() { req.destroy(); },
      });
    });
    req.on('error', reject);
  });
}

async function waitForPort(portFile, child) {
  return waitFor(() => {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').trim());
      return Number.isInteger(port) && port > 0 ? port : null;
    } catch { return null; }
  }, 'server port timeout');
}

async function fixture(t, prefix = 'mdturn-events-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  fs.mkdirSync(docRoot, { recursive: true });
  store.ensureDataDir({ dataDir });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT,
    env: {
      ...process.env,
      MDREAD_DATA_DIR: dataDir,
      MDREAD_PORT: '0',
      MDREAD_EVENT_HEARTBEAT_MS: '40',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const port = await waitForPort(store.getPaths({ dataDir }).port, child);
  return { root, dataDir, docRoot, child, port, stderr: () => stderr };
}

function writeMd(root, name, content = '# 测试\n') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function makeApplyingReview(file, dataDir, mode = 'agent') {
  const opened = await store.openReview(file, { dataDir });
  await store.mutateAnnotations(file, (data) => {
    data.annotations.push({ id: `note-${opened.review.id}`, comment: '待修改', status: 'open' });
  });
  await store.submitReview(opened.review.id, { dataDir });
  await store.beginApply(file, {
    dataDir,
    applyMode: mode,
    applyActor: mode === 'manual' ? '测试者' : 'agent',
  });
  await store.mutateAnnotations(file, (data) => {
    const note = data.annotations.find((item) => item.id === `note-${opened.review.id}`);
    note.status = 'applied';
    note.appliedAt = new Date().toISOString();
    note.appliedBy = mode === 'manual' ? '测试者' : 'codex';
    note.appliedNote = '已修改';
  });
  return opened.review.id;
}

test('review event hub 输出标准 SSE，发送心跳并在断线后清理客户端', async (t) => {
  assert.equal(
    sseFrame('review-changed', { reviewSessionId: 'r1', reason: 'test', at: 'now' }, 7),
    'id: 7\nevent: review-changed\ndata: {"reviewSessionId":"r1","reason":"test","at":"now"}\n\n',
  );

  const hub = createReviewEventHub({ heartbeatMs: 20, now: () => 'fixed-time' });
  const server = http.createServer((req, res) => hub.subscribe(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { hub.close(); server.close(); });
  const sse = await connectSse(server.address().port, '/');
  t.after(() => sse.close());
  assert.equal(sse.status, 200);
  assert.match(sse.headers['content-type'], /^text\/event-stream/);
  await waitFor(() => hub.clientCount() === 1, 'SSE client was not registered');
  await waitFor(() => sse.raw().includes(': heartbeat fixed-time'), 'SSE heartbeat missing');

  const waiting = sse.next('review-changed');
  assert.equal(hub.broadcast('review-changed', {
    reviewSessionId: 'r1', reason: 'unit', at: 'fixed-time',
  }), 1);
  assert.deepEqual((await waiting).data, {
    reviewSessionId: 'r1', reason: 'unit', at: 'fixed-time',
  });

  sse.close();
  await waitFor(() => hub.clientCount() === 0, 'SSE client was not removed after disconnect');
});

test('SSE/notify 仅限本机，通知必须重读磁盘真实状态', async (t) => {
  const f = await fixture(t);
  const file = writeMd(f.docRoot, '真实状态.md');
  const opened = await store.openReview(file, { dataDir: f.dataDir });

  const crossSite = { Origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site' };
  assert.equal((await request(f.port, '/api/app/events', { headers: crossSite })).status, 404);
  assert.equal((await request(f.port, '/api/app/review/notify', {
    method: 'POST', headers: crossSite, body: { reviewSessionId: opened.review.id, reason: 'forged' },
  })).status, 404);

  const sse = await connectSse(f.port);
  t.after(() => sse.close());
  await waitFor(() => sse.raw().includes(': connected'), 'SSE connection prelude missing');
  await waitFor(() => sse.raw().includes(': heartbeat'), 'server heartbeat missing');

  const eventPromise = sse.next('review-changed');
  const notified = await request(f.port, '/api/app/review/notify', {
    method: 'POST',
    body: {
      reviewSessionId: opened.review.id,
      reason: 'external-check',
      status: 'complete',
      finalHash: 'forged',
      at: 'forged',
    },
  });
  assert.equal(notified.status, 200, notified.text);
  assert.equal(notified.json.event.status, 'reviewing');
  assert.notEqual(notified.json.event.finalHash, 'forged');
  assert.notEqual(notified.json.event.at, 'forged');
  assert.equal(notified.json.event.reviewSessionId, opened.review.id);
  assert.equal(notified.json.event.reason, 'external-check');
  assert.equal(notified.json.delivered, 1);
  assert.deepEqual((await eventPromise).data, notified.json.event);

  const missing = await request(f.port, '/api/app/review/notify', {
    method: 'POST', body: { reviewSessionId: 'missing', reason: 'test' },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'review_not_found');
});

test('服务内 open、submit 和 begin-apply 状态迁移均广播', async (t) => {
  const f = await fixture(t, 'mdturn-service-state-events-');
  const file = writeMd(f.docRoot, '服务状态.md');
  const sse = await connectSse(f.port);
  t.after(() => sse.close());
  await waitFor(() => sse.raw().includes(': connected'), 'SSE connection prelude missing');

  const openedEvent = sse.next('review-changed');
  const opened = await request(f.port, '/api/app/open', {
    method: 'POST', body: { path: file },
  });
  assert.equal(opened.status, 200, opened.text);
  const reviewId = opened.json.review.id;
  assert.deepEqual(
    Object.fromEntries(Object.entries((await openedEvent).data).filter(([key]) =>
      ['reviewSessionId', 'reason', 'status'].includes(key))),
    { reviewSessionId: reviewId, reason: 'review-opened', status: 'reviewing' },
  );

  await store.mutateAnnotations(file, (data) => {
    data.annotations.push({ id: 'service-note', comment: '待修改', status: 'open' });
  });
  const submittedEvent = sse.next('review-changed');
  const submitted = await request(f.port, `/api/review/submit?r=${encodeURIComponent(reviewId)}`, {
    method: 'POST', body: {},
  });
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal(submitted.json.review.status, 'ready_to_apply');
  assert.equal((await submittedEvent).data.reason, 'review-submitted');

  const begunEvent = sse.next('review-changed');
  const begun = await request(f.port, `/api/app/review/begin-apply?r=${encodeURIComponent(reviewId)}`, {
    method: 'POST', body: { mode: 'manual' },
  });
  assert.equal(begun.status, 200, begun.text);
  assert.equal(begun.json.review.status, 'applying');
  const begunPayload = (await begunEvent).data;
  assert.equal(begunPayload.reason, 'manual-apply-started');
  assert.equal(begunPayload.status, 'applying');
  assert.equal(begunPayload.applyMode, 'manual');
});

test('服务内手工 complete 与独立 CLI complete 均主动广播真实终态', async (t) => {
  const f = await fixture(t, 'mdturn-complete-events-');
  const sse = await connectSse(f.port);
  t.after(() => sse.close());
  await waitFor(() => sse.raw().includes(': connected'), 'SSE connection prelude missing');

  const manualFile = writeMd(f.docRoot, '手工完成.md');
  const manualId = await makeApplyingReview(manualFile, f.dataDir, 'manual');
  const manualEvent = sse.next('review-changed');
  const completed = await request(f.port, `/api/app/review/complete?r=${encodeURIComponent(manualId)}`, {
    method: 'POST', body: {},
  });
  assert.equal(completed.status, 200, completed.text);
  const manualPayload = (await manualEvent).data;
  assert.equal(manualPayload.reviewSessionId, manualId);
  assert.equal(manualPayload.reason, 'manual-complete');
  assert.equal(manualPayload.status, 'complete');
  assert.equal(manualPayload.finalHash, store.sha256File(manualFile));

  const agentFile = writeMd(f.docRoot, 'Agent 完成.md');
  const agentId = await makeApplyingReview(agentFile, f.dataDir, 'agent');
  const agentEvent = sse.next('review-changed');
  const cli = spawnSync(process.execPath, [MDREVIEW, 'complete', agentFile], {
    cwd: '/',
    env: {
      ...process.env,
      MDREAD_DATA_DIR: f.dataDir,
      MDREAD_PORT: String(f.port),
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /状态: complete/);
  const agentPayload = (await agentEvent).data;
  assert.equal(agentPayload.reviewSessionId, agentId);
  assert.equal(agentPayload.reason, 'agent-complete');
  assert.equal(agentPayload.status, 'complete');
  assert.equal(agentPayload.finalHash, store.sha256File(agentFile));
  assert.equal((await store.getReviewById(agentId, { dataDir: f.dataDir })).status, 'complete');
});

test('CLI complete 的主动通知不可达时仍保持成功终态', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-notify-best-effort-'));
  try {
    const dataDir = path.join(root, '.mdread');
    const docs = path.join(root, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    store.ensureDataDir({ dataDir });
    const file = writeMd(docs, '无服务完成.md');
    const reviewId = await makeApplyingReview(file, dataDir, 'agent');
    const cli = spawnSync(process.execPath, [MDREVIEW, 'complete', file], {
      cwd: '/',
      env: {
        ...process.env,
        MDREAD_DATA_DIR: dataDir,
        MDREAD_PORT: '65535',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /状态: complete/);
    const persisted = await store.getReviewById(reviewId, { dataDir });
    assert.equal(persisted.status, 'complete');
    assert.equal(persisted.finalHash, store.sha256File(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
