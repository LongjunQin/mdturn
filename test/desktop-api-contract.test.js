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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('server port timeout');
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-desktop-contract-'));
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
  fs.writeFileSync(absPath, content, 'utf8');
  return absPath;
}

test('/desktop 页面只在 loopback 上提供且拒绝写方法', async (t) => {
  const f = await fixture(t);

  for (const pathname of ['/desktop', '/desktop/']) {
    const local = await request(f.port, pathname);
    assert.equal(local.status, 200, `${pathname} 应允许 loopback`);
    assert.match(local.headers['content-type'] || '', /^text\/html/);
    assert.match(local.text, /MDTurn/);
  }

  const wrongMethod = await request(f.port, '/desktop', { method: 'POST', body: {} });
  assert.equal(wrongMethod.status, 405);
});

test('桌面资源接口支持文档上级目录和绝对本机路径，且跨站请求不可见', async (t) => {
  const f = await fixture(t);
  const reportDir = path.join(f.docRoot, 'reports');
  const assetDir = path.join(f.root, 'assets');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.mkdirSync(assetDir, { recursive: true });
  const file = writeMd(reportDir, '资源路径.md', '# 资源路径\n');
  const asset = path.join(assetDir, '证据图.svg');
  fs.writeFileSync(asset, '<svg xmlns="http://www.w3.org/2000/svg"><text>MDTurn asset</text></svg>', 'utf8');

  const opened = await request(f.port, '/api/app/open', {
    method: 'POST', body: { path: file },
  });
  assert.equal(opened.status, 200, f.stderr());
  const reviewId = opened.json.review.id;

  const relative = await request(
    f.port,
    `/api/app/file?r=${encodeURIComponent(reviewId)}&path=${encodeURIComponent('../../assets/证据图.svg')}`,
  );
  assert.equal(relative.status, 200, relative.text);
  assert.match(relative.text, /MDTurn asset/);
  assert.equal(relative.headers['content-type'], 'image/svg+xml');

  const absolute = await request(
    f.port,
    `/api/app/file?r=${encodeURIComponent(reviewId)}&path=${encodeURIComponent(asset)}`,
  );
  assert.equal(absolute.status, 200, absolute.text);
  assert.equal(absolute.text, relative.text);

  const blocked = await request(
    f.port,
    `/api/app/file?r=${encodeURIComponent(reviewId)}&path=${encodeURIComponent(asset)}`,
    { headers: { Origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site' } },
  );
  assert.equal(blocked.status, 404);
});

test('读取冻结文档时发现外部改动会立即标记 conflict', async (t) => {
  const f = await fixture(t);
  const file = writeMd(f.docRoot, '外部冲突.md', '# 原始版本\n');
  const opened = await request(f.port, '/api/app/open', {
    method: 'POST', body: { path: file },
  });
  assert.equal(opened.status, 200, f.stderr());
  fs.appendFileSync(file, '\n外部程序写入。\n', 'utf8');

  const bundle = await request(
    f.port,
    `/api/app/bundle?r=${encodeURIComponent(opened.json.review.id)}`,
  );
  assert.equal(bundle.status, 200, bundle.text);
  assert.equal(bundle.json.review.status, 'conflict');
  assert.equal(bundle.json.source.changedFromReview, true);

  const persisted = await store.getReviewById(opened.json.review.id, { dataDir: f.dataDir });
  assert.equal(persisted.status, 'conflict');
  assert.match(persisted.conflictReason, /读取时检测到/);
});

test('v3 精确锚点与长 quote 持久化，并可完成 app source 手工改稿闭环', async (t) => {
  const f = await fixture(t);
  const file = writeMd(f.docRoot, 'v3-锚点.md', '# 标题\n\n第一段。\n\n第二段。\n');

  const opened = await request(f.port, '/api/app/open', {
    method: 'POST',
    body: { path: file },
  });
  assert.equal(opened.status, 200, f.stderr());
  const reviewId = opened.json.review.id;
  const sourceHash = opened.json.review.sourceHash;
  const longQuote = `跨段起点-${'锚点内容'.repeat(1250)}-跨段终点`;
  assert.ok(longQuote.length > 5000, '测试 quote 必须明显超过旧版 1000 字符上限');

  const created = await request(f.port, `/api/annotations?r=${reviewId}`, {
    method: 'POST',
    body: {
      comment: '验证跨自然段精确批注',
      quote: longQuote,
      prefix: '前文',
      suffix: '后文',
      headingPath: ['标题', '子节'],
      lineStart: 3,
      lineEnd: 5,
      startTextOffset: 2,
      endTextOffset: 5027,
      anchorVersion: 3,
      clientRequestId: 'v3-anchor-once',
    },
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(created.json.note.anchorVersion, 3);
  assert.equal(created.json.note.startTextOffset, 2);
  assert.equal(created.json.note.endTextOffset, 5027);
  assert.equal(created.json.note.quote, longQuote);
  assert.deepEqual(created.json.note.headingPath, ['标题', '子节']);
  assert.equal(created.json.note.reviewSessionId, reviewId);
  assert.equal(created.json.note.sourceHash, sourceHash);

  const replay = await request(f.port, `/api/annotations?r=${reviewId}`, {
    method: 'POST',
    body: {
      comment: '此内容不应覆盖首次请求',
      quote: '短文本',
      startTextOffset: 0,
      endTextOffset: 1,
      anchorVersion: 3,
      clientRequestId: 'v3-anchor-once',
    },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.reused, true);
  assert.equal(replay.json.note.id, created.json.note.id);
  assert.equal(replay.json.note.quote, longQuote);

  const sidecar = JSON.parse(fs.readFileSync(store.sidecarFor(file), 'utf8'));
  assert.equal(sidecar.annotations.length, 1);
  assert.equal(sidecar.annotations[0].startTextOffset, 2);
  assert.equal(sidecar.annotations[0].endTextOffset, 5027);
  assert.equal(sidecar.annotations[0].quote, longQuote);

  const bundle = await request(f.port, `/api/app/bundle?r=${reviewId}`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.json.annotations[0].anchorVersion, 3);
  assert.equal(bundle.json.annotations[0].startTextOffset, 2);
  assert.equal(bundle.json.annotations[0].endTextOffset, 5027);
  assert.equal(bundle.json.annotations[0].quote, longQuote);

  const edited = await request(f.port, `/api/annotations?r=${reviewId}&id=${created.json.note.id}`, {
    method: 'PATCH',
    body: { comment: '修改后的批注意见' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.note.comment, '修改后的批注意见');
  assert.equal(edited.json.note.quote, longQuote, '修改批注文本不能损坏精确锚点');
  assert.equal(edited.json.note.startTextOffset, 2);
  assert.equal(edited.json.note.endTextOffset, 5027);

  const submitted = await request(f.port, `/api/review/submit?r=${reviewId}`, {
    method: 'POST', body: {},
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.review.status, 'ready_to_apply');

  const begun = await request(f.port, `/api/app/review/begin-apply?r=${reviewId}`, {
    method: 'POST', body: { mode: 'manual' },
  });
  assert.equal(begun.status, 200);
  assert.equal(begun.json.review.status, 'applying');
  assert.equal(begun.json.review.applyMode, 'manual');

  const saved = await request(f.port, `/api/app/source?r=${reviewId}`, {
    method: 'PUT',
    body: {
      content: '# 新标题\n\n第一段已调整。\n\n第二段。\n',
      expectedHash: bundle.json.source.hash,
      clientRequestId: 'v3-source-save',
    },
  });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.reused, false);
  assert.equal(saved.json.revision, 1);

  const applied = await request(
    f.port,
    `/api/app/annotation?r=${reviewId}&id=${created.json.note.id}`,
    {
      method: 'PATCH',
      body: {
        status: 'applied',
        appliedNote: '已手工完成',
        expectedSourceHash: saved.json.hash,
        expectedRevision: saved.json.revision,
      },
    },
  );
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.json.annotation.status, 'applied');

  const completed = await request(f.port, `/api/app/review/complete?r=${reviewId}`, {
    method: 'POST', body: {},
  });
  assert.equal(completed.status, 200, completed.text);
  assert.equal(completed.json.review.status, 'complete');
});
