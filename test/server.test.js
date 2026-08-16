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
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET',
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...(options.headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if ((res.headers['content-type'] || '').includes('application/json')) {
          try { json = JSON.parse(text); } catch {}
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
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
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('server port timeout');
}

test('本地审阅:幂等保存、状态冻结、冲突停写与公网路由关闭', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-server-'));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  fs.mkdirSync(docRoot, { recursive: true });
  const localDoc = path.join(docRoot, '本地方案.md');
  const conflictDoc = path.join(docRoot, '冲突方案.md');
  const brokenDoc = path.join(docRoot, '损坏批注.md');
  fs.writeFileSync(localDoc, '# 本地\n正文\n');
  fs.writeFileSync(conflictDoc, '# 冲突\n');
  fs.writeFileSync(brokenDoc, '# 损坏\n');
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
  const portFile = store.getPaths({ dataDir }).port;
  const port = await waitForPort(portFile, child);

  assert.equal((await request(port, '/api/health')).status, 200);
  assert.equal((await request(port, '/')).status, 404);

  const opened = await store.openReview(localDoc, { dataDir });
  const reviewId = opened.review.id;
  const removedPathApi = await request(port, '/api/annotations?path=%E6%9C%AC%E5%9C%B0%E6%96%B9%E6%A1%88.md', {
    method: 'POST', body: { comment: '绕过冻结' },
  });
  assert.equal(removedPathApi.status, 404);

  const noteBody = {
    comment: '请修改', quote: '正文', figureRef: null, clientRequestId: 'same-request',
    appliedBy: '伪造者', customField: 'drop-me',
  };
  const saved = await request(port, `/api/annotations?r=${reviewId}`, { method: 'POST', body: noteBody });
  const repeated = await request(port, `/api/annotations?r=${reviewId}`, { method: 'POST', body: noteBody });
  assert.equal(saved.status, 200);
  assert.equal(repeated.json.note.id, saved.json.note.id);
  assert.equal(saved.json.note.appliedBy, undefined);
  assert.equal(saved.json.note.customField, undefined);
  assert.equal(saved.json.note.figureRef, undefined);
  assert.equal(store.readAnnotations(localDoc).annotations.length, 1);

  const edited = await request(port, `/api/annotations?r=${reviewId}&id=${saved.json.note.id}`, {
    method: 'PATCH', body: { comment: '  修改后的批注  ' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.note.comment, '修改后的批注');
  assert.equal(edited.json.note.updatedBy, '我(本机)');
  assert.equal(edited.json.note.editCount, 1);
  assert.match(edited.json.note.updatedAt, /^\d{4}-/);
  const localEditedNote = store.readAnnotations(localDoc).annotations[0];
  assert.equal(localEditedNote.comment, '修改后的批注');
  assert.equal(localEditedNote.figureRef, undefined);
  const emptyEdit = await request(port, `/api/annotations?r=${reviewId}&id=${saved.json.note.id}`, {
    method: 'PATCH', body: { comment: '   ' },
  });
  assert.equal(emptyEdit.status, 400);

  const submitted = await request(port, `/api/review/submit?r=${reviewId}`, { method: 'POST' });
  assert.equal(submitted.json.review.status, 'ready_to_apply');
  const locked = await request(port, `/api/annotations?r=${reviewId}`, { method: 'POST', body: { comment: '迟到批注' } });
  assert.equal(locked.status, 423);
  assert.equal(locked.json.error, 'review_read_only');
  const editLocked = await request(port, `/api/annotations?r=${reviewId}&id=${saved.json.note.id}`, {
    method: 'PATCH', body: { comment: '提交后不应成功' },
  });
  assert.equal(editLocked.status, 423);
  assert.equal(editLocked.json.error, 'review_read_only');

  const conflict = await store.openReview(conflictDoc, { dataDir });
  await store.mutateAnnotations(conflictDoc, (data) => data.annotations.push({ id: 'kept', comment: '保留', status: 'open' }));
  const conflictSidecarBefore = fs.readFileSync(store.sidecarFor(conflictDoc));
  fs.appendFileSync(conflictDoc, '外部修改\n');
  const conflictSave = await request(port, `/api/annotations?r=${conflict.review.id}&id=kept`, {
    method: 'PATCH', body: { comment: '旧版修改' },
  });
  assert.equal(conflictSave.status, 409);
  assert.equal(conflictSave.json.error, 'source_changed');
  assert.equal((await store.getReviewById(conflict.review.id, { dataDir })).status, 'conflict');
  assert.deepEqual(fs.readFileSync(store.sidecarFor(conflictDoc)), conflictSidecarBefore);

  // 手机/浏览器分享通道已移除:这些路由必须保持关闭。
  assert.equal((await request(port, '/d/abc12345?k=secret-token')).status, 404);
  assert.equal((await request(port, `/r/${reviewId}`)).status, 404);
  assert.equal((await request(port, '/api/raw?d=abc12345&k=secret-token')).status, 404);
  assert.equal((await request(port, '/browse')).status, 404);
  assert.equal((await request(port, '/api/tree')).status, 404);

  const broken = await store.openReview(brokenDoc, { dataDir });
  const malformed = store.sidecarFor(brokenDoc);
  fs.writeFileSync(malformed, '{broken', 'utf8');
  const malformedBefore = fs.readFileSync(malformed);
  const malformedResponse = await request(port, `/api/annotations?r=${broken.review.id}`, {
    method: 'POST', body: { comment: '不能覆盖' },
  });
  assert.equal(malformedResponse.status, 500);
  assert.deepEqual(fs.readFileSync(malformed), malformedBefore);
  assert.match(stderr, /JSON|sidecar|批注/);

  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(fs.existsSync(portFile), false);
});
