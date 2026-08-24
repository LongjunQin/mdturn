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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-deep-'));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  fs.mkdirSync(docRoot, { recursive: true });
  store.ensureDataDir({ dataDir });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, docRoot };
}

function writeMd(root, name, body = '# 测试\n正文\n') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function rawRequest(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    let body = null;
    if (options.rawBody !== undefined) body = Buffer.from(options.rawBody);
    else if (options.body !== undefined) body = Buffer.from(JSON.stringify(options.body));
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
        resolve({ status: res.statusCode, text, json, headers: res.headers });
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
    await delay(20);
  }
  throw new Error('server port timeout');
}

async function startServer(t, f, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT,
    env: {
      ...process.env,
      MDREAD_DATA_DIR: f.dataDir,
      MDREAD_PORT: '0',
      ...extraEnv,
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
  });
  const port = await waitForPort(store.getPaths({ dataDir: f.dataDir }).port, child);
  return { child, port, stderr: () => stderr };
}

async function waitForInodeChange(file, originalInode, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.statSync(file).ino !== originalInode) return;
    } catch {}
    await delay(10);
  }
  throw new Error(`inode did not change: ${file}`);
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: PROJECT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('高并发批注 POST 不丢失，同 clientRequestId 只写一条', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.docRoot, '并发.md');
  const { review } = await store.openReview(file, { dataDir: f.dataDir });
  const { port } = await startServer(t, f);

  const unique = Array.from({ length: 80 }, (_, index) => rawRequest(
    port,
    `/api/annotations?r=${review.id}`,
    { method: 'POST', body: { comment: `批注 ${index}`, clientRequestId: `unique-${index}` } },
  ));
  const duplicates = Array.from({ length: 30 }, () => rawRequest(
    port,
    `/api/annotations?r=${review.id}`,
    { method: 'POST', body: { comment: '重试批注', clientRequestId: 'same-request' } },
  ));
  const responses = await Promise.all([...unique, ...duplicates]);
  const statusCounts = responses.reduce((counts, response) => {
    counts[response.status] = (counts[response.status] || 0) + 1;
    return counts;
  }, {});
  const failures = responses.filter((response) => response.status !== 200).map((response) => response.text).slice(0, 3);
  assert.ok(responses.every((response) => response.status === 200),
    `响应状态统计: ${JSON.stringify(statusCounts)}; 失败响应: ${JSON.stringify(failures)}`);
  const notes = store.readAnnotations(file).annotations;
  assert.equal(notes.length, 81);
  assert.equal(new Set(notes.map((note) => note.id)).size, 81);
  assert.equal(notes.filter((note) => note.clientRequestId === 'same-request').length, 1);
});

test('总体意见:无锚点 + scope=document 可保存,非法 scope 被丢弃,且计入待处理', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.docRoot, '总体意见.md');
  const { review } = await store.openReview(file, { dataDir: f.dataDir });
  const { port } = await startServer(t, f);

  const docNote = await rawRequest(port, `/api/annotations?r=${review.id}`, {
    method: 'POST', body: { comment: '整体架构不对，先讨论再改', scope: 'document', clientRequestId: 'doc-note' },
  });
  assert.equal(docNote.status, 200);
  const bogusScope = await rawRequest(port, `/api/annotations?r=${review.id}`, {
    method: 'POST', body: { comment: '带非法 scope 的普通批注', quote: '正文', scope: 'paragraph', clientRequestId: 'bogus-scope' },
  });
  assert.equal(bogusScope.status, 200);

  const notes = store.readAnnotations(file).annotations;
  const saved = notes.find((note) => note.clientRequestId === 'doc-note');
  assert.equal(saved.scope, 'document');
  assert.equal(saved.status, 'open');
  assert.ok(!('quote' in saved) && !('lineStart' in saved), '总体意见不应带文字锚点');
  assert.ok(!('scope' in notes.find((note) => note.clientRequestId === 'bogus-scope')), '非法 scope 应被丢弃');

  // 只有一条总体意见时,提交本轮必须进入 ready_to_apply(交给智能体),而不是直接通过。
  const submitted = await store.submitReview(review.id, { dataDir: f.dataDir });
  assert.equal(submitted.review.status, 'ready_to_apply');
});

test('A、B 两篇文档同时审阅时，API 与 sidecar 批注互不串写', async (t) => {
  const f = fixture(t);
  const fileA = writeMd(f.docRoot, '项目 A/方案.md', '# A\nA 正文\n');
  const fileB = writeMd(f.docRoot, '项目 B/方案.md', '# B\nB 正文\n');
  const openedA = await store.openReview(fileA, { dataDir: f.dataDir });
  const openedB = await store.openReview(fileB, { dataDir: f.dataDir });
  const { port } = await startServer(t, f);

  const [savedA, savedB] = await Promise.all([
    rawRequest(port, `/api/annotations?r=${openedA.review.id}`, {
      method: 'POST', body: { comment: '只属于 A', quote: 'A 正文', clientRequestId: 'doc-a' },
    }),
    rawRequest(port, `/api/annotations?r=${openedB.review.id}`, {
      method: 'POST', body: { comment: '只属于 B', quote: 'B 正文', clientRequestId: 'doc-b' },
    }),
  ]);
  assert.equal(savedA.status, 200);
  assert.equal(savedB.status, 200);
  assert.deepEqual(store.readAnnotations(fileA).annotations.map((note) => note.comment), ['只属于 A']);
  assert.deepEqual(store.readAnnotations(fileB).annotations.map((note) => note.comment), ['只属于 B']);
  assert.equal(store.readAnnotations(fileA).annotations[0].reviewSessionId, openedA.review.id);
  assert.equal(store.readAnnotations(fileB).annotations[0].reviewSessionId, openedB.review.id);
});

test('批注正文 PATCH 保留旧状态行为并执行冻结保护', async (t) => {
  const f = fixture(t);
  const localFile = writeMd(f.docRoot, '本地编辑.md');
  const local = await store.openReview(localFile, { dataDir: f.dataDir });
  await store.mutateAnnotations(localFile, (data) => {
    data.annotations.push({ id: 'local-note', comment: '本地原批注', status: 'open' });
  });
  const { port } = await startServer(t, f);

  const localEdit = await rawRequest(port, `/api/annotations?r=${local.review.id}&id=local-note`, {
    method: 'PATCH', body: { comment: '本地新批注' },
  });
  assert.equal(localEdit.status, 200);
  assert.equal(localEdit.json.note.comment, '本地新批注');
  assert.equal(localEdit.json.note.editCount, 1);

  await store.mutateAnnotations(localFile, (data) => { data.annotations[0].status = 'applied'; });
  const appliedEdit = await rawRequest(port, `/api/annotations?r=${local.review.id}&id=local-note`, {
    method: 'PATCH', body: { comment: '已处理后不应写入' },
  });
  assert.equal(appliedEdit.status, 409);
  assert.equal(appliedEdit.json.error, 'annotation_read_only');
  assert.equal(store.readAnnotations(localFile).annotations[0].comment, '本地新批注');

  const reopen = await rawRequest(port, `/api/annotations?r=${local.review.id}&id=local-note`, {
    method: 'PATCH', body: { status: 'open' },
  });
  assert.equal(reopen.status, 200, '原有状态 PATCH 应继续可用');
  const submitted = await rawRequest(port, `/api/review/submit?r=${local.review.id}`, { method: 'POST' });
  assert.equal(submitted.status, 200);
  const readyEdit = await rawRequest(port, `/api/annotations?r=${local.review.id}&id=local-note`, {
    method: 'PATCH', body: { comment: '提交后不应写入' },
  });
  assert.equal(readyEdit.status, 423);
  assert.equal(readyEdit.json.error, 'review_read_only');
});

test('同一文档多进程 mdreview open 只创建一个活动会话', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.docRoot, '同文档.md');
  const runs = await Promise.all(Array.from({ length: 24 }, () => runNode(
    ['mdreview.js', 'open', file, '--no-open'],
    { MDREAD_DATA_DIR: f.dataDir },
  )));
  assert.ok(runs.every((run) => run.code === 0), runs.map((run) => run.stderr).join('\n'));
  const ids = runs.map((run) => /\u4f1a\u8bdd:\s*(\S+)/.exec(run.stdout)?.[1]);
  assert.equal(new Set(ids).size, 1);
  assert.equal((await store.listReviews({ dataDir: f.dataDir })).length, 1);
});

test('真正遗留的过期锁可恢复，未过期锁会超时而不被抢占', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.docRoot, '锁.md');
  const reviews = store.getPaths({ dataDir: f.dataDir }).reviews;
  const lockPath = `${reviews}.lock`;
  fs.mkdirSync(lockPath, { recursive: true });
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lockPath, old, old);
  const opened = await store.openReview(file, {
    dataDir: f.dataDir,
    lock: { staleMs: 50, timeoutMs: 500 },
  });
  assert.equal(opened.review.status, 'reviewing');
  assert.equal(fs.existsSync(lockPath), false);

  fs.mkdirSync(lockPath, { recursive: true });
  await assert.rejects(
    store.openReview(file, {
      dataDir: f.dataDir,
      lock: { staleMs: 5000, timeoutMs: 80 },
    }),
    (error) => error.code === 'LOCK_TIMEOUT',
  );
  fs.rmSync(lockPath, { recursive: true, force: true });
});

test('活进程持锁超过 staleMs 也不被抢占，释放后下一持有者才进入', async (t) => {
  const f = fixture(t);
  const target = path.join(f.dataDir, 'ownership.json');
  let releaseA;
  let enterA;
  const enteredA = new Promise((resolve) => { enterA = resolve; });

  const a = store.withFileLock(target, async () => {
    enterA();
    await new Promise((resolve) => { releaseA = resolve; });
  }, { staleMs: 40, timeoutMs: 1000 });
  await enteredA;
  await delay(70);

  let bEntered = false;
  const b = store.withFileLock(target, async () => {
    bEntered = true;
  }, { staleMs: 40, timeoutMs: 1000 });
  await delay(120);
  assert.equal(bEntered, false, '活进程持有的过龄锁被错误接管');

  releaseA();
  await Promise.all([a, b]);
  assert.equal(bEntered, true);
});

test('批注与提交竞态不得产生 complete + open 批注', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.docRoot, '状态竞态.md');
  const { review } = await store.openReview(file, { dataDir: f.dataDir });
  const reviewsFile = store.getPaths({ dataDir: f.dataDir }).reviews;
  const initialInode = fs.statSync(reviewsFile).ino;
  const sidecar = store.sidecarFor(file);
  const { port } = await startServer(t, f);

  let releaseSidecar;
  let sidecarLocked;
  const sidecarAcquired = new Promise((resolve) => { sidecarLocked = resolve; });
  const holder = store.withFileLock(sidecar, async () => {
    sidecarLocked();
    await new Promise((resolve) => { releaseSidecar = resolve; });
  }, { staleMs: 5000, timeoutMs: 2000 });
  await sidecarAcquired;

  const pendingSave = rawRequest(port, `/api/annotations?r=${review.id}`, {
    method: 'POST', body: { comment: '不能越过提交', clientRequestId: 'racing-save' },
  });
  await waitForInodeChange(reviewsFile, initialInode);

  const pendingSubmit = rawRequest(port, `/api/review/submit?r=${review.id}`, { method: 'POST' });
  await delay(50);
  releaseSidecar();
  await holder;
  const [saved, submitted] = await Promise.all([pendingSave, pendingSubmit]);
  const finalReview = await store.getReviewById(review.id, { dataDir: f.dataDir });
  const openCount = store.countOpenAnnotations(file);

  assert.equal(saved.status, 200);
  assert.equal(submitted.status, 200);
  assert.equal(
    finalReview.status === 'complete' && openCount > 0,
    false,
    `竞态后不变式破坏: submit=${submitted.status}, save=${saved.status}, status=${finalReview.status}, open=${openCount}`,
  );
});

test('静态资源路由不得通过 symlink 越出 static 目录', async (t) => {
  const f = fixture(t);
  writeMd(f.docRoot, '路径.md');
  const { port } = await startServer(t, f);
  assert.equal((await rawRequest(port, '/static/..%2Fserver.js')).status, 403);
  // 未编码的 ../ 在 URL 解析阶段即被折叠出 /static/ 前缀,落到 404。
  assert.equal((await rawRequest(port, '/static/../server.js')).status, 404);
});

test('GET 接口拒绝写方法，空 PATCH body 返回 400 而非 500', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.docRoot, '方法.md');
  const { review } = await store.openReview(file, { dataDir: f.dataDir });
  const { port } = await startServer(t, f);

  assert.equal((await rawRequest(port, '/api/reviews', { method: 'POST', body: {} })).status, 405);
  assert.equal((await rawRequest(port, '/api/health', { method: 'DELETE' })).status, 405);
  const nullPatch = await rawRequest(port, `/api/annotations?r=${review.id}&id=missing`, {
    method: 'PATCH', rawBody: 'null',
  });
  assert.equal(nullPatch.status, 400);
});

test('2 MB 以上请求体应返回 413，不应直接 ECONNRESET', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.docRoot, '大请求.md');
  const { review } = await store.openReview(file, { dataDir: f.dataDir });
  const { port } = await startServer(t, f);
  let response = null;
  let requestError = null;
  try {
    response = await rawRequest(port, `/api/annotations?r=${review.id}`, {
      method: 'POST', rawBody: JSON.stringify({ comment: 'x'.repeat(2_100_000) }),
    });
  } catch (error) {
    requestError = error;
  }
  assert.equal(requestError, null, `连接被重置: ${requestError && requestError.code}`);
  assert.equal(response && response.status, 413);
});

test('端口 0 会发布实际端口，基础端口冲突时转到下一端口', async (t) => {
  const f = fixture(t);
  const first = await startServer(t, f);
  assert.ok(first.port > 0);
  assert.equal((await rawRequest(first.port, '/api/health')).json.port, first.port);

  const blocker = http.createServer((_req, res) => res.end('occupied'));
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const occupied = blocker.address().port;

  const f2 = fixture(t);
  const second = await startServer(t, f2, { MDREAD_PORT: String(occupied) });
  assert.equal(second.port, occupied + 1);
  assert.equal((await rawRequest(second.port, '/api/health')).status, 200);
});

test('/api/reviews 隔离损坏 sidecar，并按路径只返回最新历史会话', async (t) => {
  const f = fixture(t);
  const historyFile = writeMd(f.docRoot, '历史.md');
  const first = await store.openReview(historyFile, { dataDir: f.dataDir });
  await store.submitReview(first.review.id, { dataDir: f.dataDir });
  await delay(5);
  const latest = await store.openReview(historyFile, { dataDir: f.dataDir });

  const brokenFile = writeMd(f.docRoot, '损坏.md');
  const broken = await store.openReview(brokenFile, { dataDir: f.dataDir });
  fs.writeFileSync(store.sidecarFor(brokenFile), '{broken', 'utf8');

  const { port } = await startServer(t, f);
  const response = await rawRequest(port, '/api/reviews');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json.reviews));

  const historyRows = response.json.reviews.filter((item) => item.sourceFile === fs.realpathSync(historyFile));
  assert.equal(historyRows.length, 1);
  assert.equal(historyRows[0].id, latest.review.id);
  const brokenRow = response.json.reviews.find((item) => item.id === broken.review.id);
  assert.ok(brokenRow);
  assert.equal(brokenRow.openCount, null);
  assert.equal(brokenRow.summaryError.code, 'malformed_json');
});

test('API 和动态静态资源不共享缓存，仅 vendor 资源可长缓存', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.docRoot, '缓存.md');
  const { review } = await store.openReview(file, { dataDir: f.dataDir });
  const { port } = await startServer(t, f);

  const responses = await Promise.all([
    rawRequest(port, '/api/health'),
    rawRequest(port, `/api/annotations?r=${review.id}`),
    rawRequest(port, '/static/desktop.js'),
    rawRequest(port, '/desktop'),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  for (const response of responses) assert.match(response.headers['cache-control'], /no-store/);

  const vendor = await rawRequest(port, '/static/vendor/markdown-it.min.js');
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers['cache-control'], /public/);
  assert.match(vendor.headers['cache-control'], /immutable/);
});

test('端口文件与 MDREAD_PORT 严格解析，不接受尾随字符或越界值', async (t) => {
  const f = fixture(t);
  const portFile = store.getPaths({ dataDir: f.dataDir }).port;
  const valid = ['1', '8080\n', ' 65535 \n'];
  for (const value of valid) {
    fs.writeFileSync(portFile, value, 'utf8');
    assert.equal(store.readPort({ dataDir: f.dataDir }), Number(value.trim()));
  }
  const invalid = ['', '0', '65536', '8080junk', '1e3', '+8080', '-1', '123456'];
  for (const value of invalid) {
    fs.writeFileSync(portFile, value, 'utf8');
    assert.equal(store.readPort({ dataDir: f.dataDir }), null, `应拒绝端口文本: ${JSON.stringify(value)}`);
  }
  fs.rmSync(portFile, { force: true });

  const run = await runNode(['server.js'], {
    MDREAD_DATA_DIR: f.dataDir,
    MDREAD_PORT: '8080junk',
  });
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /MDREAD_PORT 无效/);
  assert.equal(fs.existsSync(portFile), false);
});
