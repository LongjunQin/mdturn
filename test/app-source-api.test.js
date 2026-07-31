'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const store = require('../lib/review-store');
const PROJECT = path.resolve(__dirname, '..');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
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
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForPort(portFile, child) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const port = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (port > 0) return port;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('server port timeout');
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-app-api-'));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  fs.mkdirSync(docRoot, { recursive: true });
  store.ensureDataDir({ dataDir });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT,
    env: { ...process.env, MDREAD_DATA_DIR: dataDir, MDREAD_PORT: '0' },
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
  return { root, dataDir, docRoot, port, stderr: () => stderr };
}

function writeMd(root, name, content) {
  const absPath = path.join(root, name);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, { encoding: 'utf8', mode: 0o640 });
  fs.chmodSync(absPath, 0o640);
  return absPath;
}

function backupFiles(dataDir) {
  const base = path.join(dataDir, 'backups');
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else out.push(target);
    }
  }
  walk(base);
  return out;
}

test('MDTurn API 手工改稿闭环：旧批注、备份、原子写、幂等与完成', async (t) => {
  const f = await fixture(t);
  const file = writeMd(f.docRoot, '手工改稿.md', '# 旧标题\n旧正文\n');
  fs.writeFileSync(store.sidecarFor(file), JSON.stringify({
    version: 1,
    annotations: [{ id: 'legacy-open', comment: '请改标题', quote: '旧标题' }],
  }, null, 2));

  const cloudflare = await request(f.port, '/api/app/open', {
    method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.1' }, body: { path: file },
  });
  assert.equal(cloudflare.status, 404);
  const crossSite = await request(f.port, '/api/app/open', {
    method: 'POST',
    headers: { Origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site' },
    body: { path: file },
  });
  assert.equal(crossSite.status, 404);

  const opened = await request(f.port, '/api/app/open', { method: 'POST', body: { path: file } });
  assert.equal(opened.status, 200);
  assert.equal(opened.json.review.status, 'reviewing');
  assert.equal(opened.json.review.openCount, 1, '缺少 status 的旧批注必须视为 open');
  const ref = opened.json.review.id;

  const bundle = await request(f.port, `/api/app/bundle?r=${ref}`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.json.annotations[0].status, 'open');
  assert.equal(bundle.json.source.hash, store.sha256File(file));
  assert.equal(bundle.json.source.revision, 0);

  const submitted = await request(f.port, `/api/review/submit?r=${ref}`, { method: 'POST', body: {} });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.review.status, 'ready_to_apply');
  const begun = await request(f.port, `/api/app/review/begin-apply?r=${ref}`, {
    method: 'POST', body: { mode: 'manual' },
  });
  assert.equal(begun.status, 200);
  assert.equal(begun.json.review.applyMode, 'manual');
  assert.equal(begun.json.review.applyActor, '我(本机)');

  const firstHash = bundle.json.source.hash;
  const firstSave = await request(f.port, `/api/app/source?r=${ref}`, {
    method: 'PUT',
    body: { content: '# 新标题\n旧正文\n', expectedHash: firstHash, clientRequestId: 'save-1' },
  });
  assert.equal(firstSave.status, 200);
  assert.equal(firstSave.json.reused, false);
  assert.equal(firstSave.json.revision, 1);
  assert.equal(firstSave.json.backupCreated, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, '原文档模式必须保留');
  assert.equal(fs.readFileSync(file, 'utf8'), '# 新标题\n旧正文\n');
  assert.equal(backupFiles(f.dataDir).length, 1);
  assert.equal(fs.readFileSync(backupFiles(f.dataDir)[0], 'utf8'), '# 旧标题\n旧正文\n');
  assert.equal(fs.statSync(backupFiles(f.dataDir)[0]).mode & 0o777, 0o600);

  const replay = await request(f.port, `/api/app/source?r=${ref}`, {
    method: 'PUT',
    body: { content: '# 新标题\n旧正文\n', expectedHash: firstHash, clientRequestId: 'save-1' },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.reused, true);
  assert.equal(replay.json.hash, firstSave.json.hash);
  assert.equal(replay.json.revision, 1);
  assert.equal(backupFiles(f.dataDir).length, 1);

  const secondSave = await request(f.port, `/api/app/source?r=${ref}`, {
    method: 'PUT',
    body: {
      content: '# 新标题\n新正文\n',
      expectedHash: firstSave.json.hash,
      clientRequestId: 'save-2',
    },
  });
  assert.equal(secondSave.status, 200);
  assert.equal(secondSave.json.revision, 2);
  assert.equal(backupFiles(f.dataDir).length, 1, '多次保存仍只保留首次备份');
  const lateReplay = await request(f.port, `/api/app/source?r=${ref}`, {
    method: 'PUT',
    body: { content: '# 新标题\n旧正文\n', expectedHash: firstHash, clientRequestId: 'save-1' },
  });
  assert.equal(lateReplay.status, 200);
  assert.equal(lateReplay.json.reused, true);
  assert.equal(lateReplay.json.superseded, true);
  assert.equal(lateReplay.json.currentHash, secondSave.json.hash);

  const stale = await request(f.port, `/api/app/source?r=${ref}`, {
    method: 'PUT',
    body: { content: '# 不应写入\n', expectedHash: firstHash, clientRequestId: 'save-stale' },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'source_changed');
  assert.equal(fs.readFileSync(file, 'utf8'), '# 新标题\n新正文\n');
  assert.equal(backupFiles(f.dataDir).length, 1);

  const marked = await request(f.port, `/api/app/annotation?r=${ref}&id=legacy-open`, {
    method: 'PATCH', body: { status: 'applied', appliedNote: '已手工替换标题' },
  });
  assert.equal(marked.status, 200);
  assert.equal(marked.json.annotation.status, 'applied');
  assert.equal(marked.json.annotation.appliedBy, '我(本机)');
  assert.equal(marked.json.annotation.appliedNote, '已手工替换标题');
  assert.equal(marked.json.counts.open, undefined);

  const completed = await request(f.port, `/api/app/review/complete?r=${ref}`, { method: 'POST', body: {} });
  assert.equal(completed.status, 200);
  assert.equal(completed.json.review.status, 'complete');
  assert.equal(completed.json.review.finalHash, secondSave.json.hash);
});

test('源文档 PUT 拒绝 agent 改稿，终态编辑被新活动审阅阻断', async (t) => {
  const f = await fixture(t);
  const agentFile = writeMd(f.docRoot, 'agent.md', '# Agent\n');
  const agentOpened = await store.openReview(agentFile, { dataDir: f.dataDir });
  await store.mutateAnnotations(agentFile, (data) => {
    data.annotations.push({ id: 'agent-note', comment: '待改', status: 'open' });
  });
  await store.submitReview(agentOpened.review.id, { dataDir: f.dataDir });
  const agentReview = await store.beginApply(agentFile, { dataDir: f.dataDir });
  assert.equal(agentReview.applyMode, 'agent', 'CLI/默认调用必须使用 agent');
  assert.equal(agentReview.applyActor, 'agent');

  const agentWrite = await request(f.port, `/api/app/source?r=${agentReview.id}`, {
    method: 'PUT',
    body: { content: '# 不能手改\n', expectedHash: store.sha256File(agentFile), clientRequestId: 'agent-write' },
  });
  assert.equal(agentWrite.status, 423);
  assert.equal(fs.readFileSync(agentFile, 'utf8'), '# Agent\n');

  const terminalFile = writeMd(f.docRoot, '终态.md', '# 初始\n');
  const terminal = await store.openReview(terminalFile, { dataDir: f.dataDir });
  await store.submitReview(terminal.review.id, { dataDir: f.dataDir });
  assert.equal((await store.getReviewById(terminal.review.id, { dataDir: f.dataDir })).status, 'complete');
  const terminalHash = store.sha256File(terminalFile);
  const terminalWrite = await request(f.port, `/api/app/source?r=${terminal.review.id}`, {
    method: 'PUT',
    body: { content: '# 终态编辑\n', expectedHash: terminalHash, clientRequestId: 'terminal-1' },
  });
  assert.equal(terminalWrite.status, 200);
  assert.equal(terminalWrite.json.revision, 1);

  const newActive = await store.openReview(terminalFile, { dataDir: f.dataDir });
  assert.equal(newActive.review.status, 'reviewing');
  await store.mutateAnnotations(terminalFile, (data) => {
    data.annotations.push({ id: 'new-round-note', comment: '新一轮', status: 'open' });
  });
  await store.submitReview(newActive.review.id, { dataDir: f.dataDir });
  const staleBegin = await request(f.port, `/api/app/review/begin-apply?r=${terminal.review.id}`, {
    method: 'POST', body: { mode: 'manual' },
  });
  assert.equal(staleBegin.status, 409);
  assert.equal(staleBegin.json.error, 'review_session_mismatch');
  assert.equal((await store.getReviewById(newActive.review.id, { dataDir: f.dataDir })).status, 'ready_to_apply');
  const currentBegin = await request(f.port, `/api/app/review/begin-apply?r=${newActive.review.id}`, {
    method: 'POST', body: { mode: 'manual' },
  });
  assert.equal(currentBegin.status, 200);
  await request(f.port, `/api/app/annotation?r=${newActive.review.id}&id=new-round-note`, {
    method: 'PATCH', body: { status: 'applied' },
  });
  const staleComplete = await request(f.port, `/api/app/review/complete?r=${terminal.review.id}`, {
    method: 'POST', body: {},
  });
  assert.equal(staleComplete.status, 409);
  assert.equal(staleComplete.json.error, 'review_session_mismatch');
  assert.equal((await store.getReviewById(newActive.review.id, { dataDir: f.dataDir })).status, 'applying');
  const blocked = await request(f.port, `/api/app/source?r=${terminal.review.id}`, {
    method: 'PUT',
    body: {
      content: '# 应被阻断\n',
      expectedHash: store.sha256File(terminalFile),
      clientRequestId: 'terminal-2',
    },
  });
  assert.equal(blocked.status, 423);
  assert.equal(blocked.json.error, 'active_review_exists');
  assert.equal(fs.readFileSync(terminalFile, 'utf8'), '# 终态编辑\n');
});

test('并发源文档写入只有一个 expectedHash 能成功，文件与索引保持一致', async (t) => {
  const f = await fixture(t);
  const file = writeMd(f.docRoot, '并发.md', '# 初始\n');
  const opened = await store.openReview(file, { dataDir: f.dataDir });
  await store.mutateAnnotations(file, (data) => {
    data.annotations.push({ id: 'n1', comment: '待改', status: 'open' });
  });
  await store.submitReview(opened.review.id, { dataDir: f.dataDir });
  await store.beginApply(file, { dataDir: f.dataDir, applyMode: 'manual', applyActor: '测试者' });
  const initialHash = store.sha256File(file);

  const responses = await Promise.all([
    request(f.port, `/api/app/source?r=${opened.review.id}`, {
      method: 'PUT',
      body: { content: '# 版本 A\n', expectedHash: initialHash, clientRequestId: 'concurrent-a' },
    }),
    request(f.port, `/api/app/source?r=${opened.review.id}`, {
      method: 'PUT',
      body: { content: '# 版本 B\n', expectedHash: initialHash, clientRequestId: 'concurrent-b' },
    }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = responses.find((response) => response.status === 200);
  assert.equal(store.sha256File(file), winner.json.hash);
  assert.equal(winner.json.revision, 1);
  assert.equal(backupFiles(f.dataDir).length, 1);
  const review = await store.getReviewById(opened.review.id, { dataDir: f.dataDir });
  assert.equal(review.workingHash, winner.json.hash);
  assert.equal(review.sourceRevision, 1);
  assert.equal(Object.values(review.sourceWriteRequests).filter((entry) => entry.status === 'complete').length, 1);
});
