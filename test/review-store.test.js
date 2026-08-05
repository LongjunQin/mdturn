'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const store = require('../lib/review-store');
const PROJECT = path.resolve(__dirname, '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-store-'));
  const dataDir = path.join(root, '.mdread');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, options: { dataDir } };
}

function writeMd(root, name, body = '# 测试\n') {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: PROJECT, env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('多文档会话独立，同一文档复用活动会话', async (t) => {
  const f = fixture(t);
  const a = writeMd(f.root, '项目 A/方案.md');
  const b = writeMd(f.root, '项目 B/方案.md');
  const first = await store.openReview(a, f.options);
  const second = await store.openReview(b, f.options);
  const reused = await store.openReview(a, f.options);
  assert.notEqual(first.review.id, second.review.id);
  assert.equal(reused.review.id, first.review.id);
  assert.equal(reused.reused, true);
  assert.equal((await store.listReviews(f.options)).length, 2);
});

test('源文档变化后会话进入 conflict，sidecar 不被写入', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '冲突.md');
  const { review } = await store.openReview(file, f.options);
  await store.mutateAnnotations(file, (data) => data.annotations.push({ id: 'existing', comment: '原批注', status: 'open' }));
  const sidecarBefore = fs.readFileSync(store.sidecarFor(file));
  fs.appendFileSync(file, '\n外部修改\n');
  await assert.rejects(store.assertReviewUnchanged(review.id, f.options), (error) => error.code === 'SOURCE_CONFLICT');
  const current = await store.getReviewById(review.id, f.options);
  assert.equal(current.status, 'conflict');
  assert.deepEqual(fs.readFileSync(store.sidecarFor(file)), sidecarBefore);
});

test('冲突会话在批注全部处理后自愈：重新打开自动开启新一轮', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '自愈.md');
  const first = await store.openReview(file, f.options);
  await store.mutateAnnotations(file, (data) => data.annotations.push({ id: 'n1', comment: '改一下', status: 'open' }));
  await store.submitReview(first.review.id, f.options);
  // Agent 漏跑 begin-apply 直接改稿 → 冲突
  fs.appendFileSync(file, '\n已按批注修改\n');
  await assert.rejects(store.assertReviewUnchanged(first.review.id, f.options), (error) => error.code === 'SOURCE_CONFLICT');
  // 仍有 open 批注时,重新打开必须维持冲突保护
  await assert.rejects(store.openReview(file, f.options), (error) => error.code === 'SOURCE_CONFLICT');
  // 批注全部标记 applied 后,重新打开自动结束旧会话并开启新一轮
  await store.mutateAnnotations(file, (data) => { data.annotations[0].status = 'applied'; });
  const reopened = await store.openReview(file, f.options);
  assert.equal(reopened.reused, false);
  assert.equal(reopened.recovered, true);
  assert.notEqual(reopened.review.id, first.review.id);
  assert.equal(reopened.review.status, 'reviewing');
  const old = await store.getReviewById(first.review.id, f.options);
  assert.equal(old.status, 'complete');
  assert.match(old.autoClosedReason, /自动结束旧会话/);
});

test('状态机覆盖 approved 与 ready/applying/complete', async (t) => {
  const f = fixture(t);
  const approvedFile = writeMd(f.root, '直接通过.md');
  const approved = await store.openReview(approvedFile, f.options);
  const approvedResult = await store.submitReview(approved.review.id, f.options);
  assert.equal(approvedResult.review.status, 'complete');
  assert.equal(approvedResult.review.outcome, 'approved');
  assert.match(approvedResult.review.finalHash, /^[a-f0-9]{64}$/);

  const file = writeMd(f.root, '需要修改.md');
  const opened = await store.openReview(file, f.options);
  await assert.rejects(store.beginApply(file, f.options), (error) => error.code === 'INVALID_STATE');
  await store.mutateAnnotations(file, (data) => data.annotations.push({ id: 'n1', comment: '修改', status: 'open' }));
  const submitted = await store.submitReview(opened.review.id, f.options);
  assert.equal(submitted.review.status, 'ready_to_apply');
  assert.equal((await store.beginApply(file, f.options)).status, 'applying');
  await assert.rejects(store.completeReview(file, f.options), (error) => error.code === 'OPEN_ANNOTATIONS');
  await store.mutateAnnotations(file, (data) => { data.annotations[0].status = 'applied'; });
  const completed = await store.completeReview(file, f.options);
  assert.equal(completed.status, 'complete');
  assert.match(completed.finalHash, /^[a-f0-9]{64}$/);
});

test('损坏 sidecar 与 registry 都会拒绝覆盖', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '损坏保护.md');
  const sidecar = store.sidecarFor(file);
  fs.writeFileSync(sidecar, '{broken', 'utf8');
  const before = fs.readFileSync(sidecar);
  await assert.rejects(store.mutateAnnotations(file, () => {}), (error) => error.code === 'MALFORMED_JSON');
  assert.deepEqual(fs.readFileSync(sidecar), before);

  store.ensureDataDir(f.options);
  const registry = store.getPaths(f.options).registry;
  fs.writeFileSync(registry, '{broken', 'utf8');
  const registryBefore = fs.readFileSync(registry);
  const result = await runNode(['mdshare.js', file], { MDREAD_DATA_DIR: f.dataDir });
  assert.notEqual(result.code, 0);
  assert.deepEqual(fs.readFileSync(registry), registryBefore);
});

test('多进程 mdreview open 与 mdshare 不丢记录', async (t) => {
  const f = fixture(t);
  const files = Array.from({ length: 8 }, (_, index) => writeMd(f.root, `并发/文档 ${index}.md`));
  const reviewRuns = await Promise.all(files.map((file) => runNode(['mdreview.js', 'open', file, '--no-open'], {
    MDREAD_DATA_DIR: f.dataDir,
  })));
  assert.ok(reviewRuns.every((result) => result.code === 0), reviewRuns.map((result) => result.stderr).join('\n'));
  assert.equal((await store.listReviews(f.options)).length, files.length);

  const shareRuns = await Promise.all(files.map((file, index) => runNode(['mdshare.js', file, '--for', `用户${index}`], {
    MDREAD_DATA_DIR: f.dataDir,
  })));
  assert.ok(shareRuns.every((result) => result.code === 0), shareRuns.map((result) => result.stderr).join('\n'));
  const registry = store.readJsonStrict(store.getPaths(f.options).registry);
  assert.equal(Object.keys(registry.links).length, files.length);
});

test('人工解锁在源文件被删除后仍可恢复，私有权限会迁移', async (t) => {
  const f = fixture(t);
  const file = writeMd(f.root, '待恢复.md');
  await store.openReview(file, f.options);
  fs.unlinkSync(file);
  const cancelled = await store.unlockReview(file, '源文件已删除', f.options);
  assert.equal(cancelled.status, 'cancelled');

  const paths = store.getPaths(f.options);
  fs.writeFileSync(paths.owner, '我');
  fs.chmodSync(paths.dataDir, 0o755);
  fs.chmodSync(paths.owner, 0o644);
  store.ensureDataDir(f.options);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(paths.dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.owner).mode & 0o777, 0o600);
  }
});
