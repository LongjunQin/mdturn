#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const MDREVIEW = path.join(PROJECT, 'mdreview.js');

// mdreview open 自动唤起 MDTurn 依赖 /usr/bin/open,仅 macOS 支持
const DARWIN_ONLY = { skip: process.platform !== 'darwin' ? 'mdreview open 自动唤起仅支持 macOS' : false };

function fixture(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(base, '数据 目录');
  const docs = path.join(base, '中文 文档');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  return { base, dataDir, docs };
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

function writeOpenInterceptor(base) {
  const preload = path.join(base, 'preload.js');
  fs.writeFileSync(preload, [
    "const cp = require('child_process');",
    "const fs = require('fs');",
    'const original = cp.spawnSync;',
    'cp.spawnSync = function(command, args) {',
    "  if (command === '/usr/bin/open') { fs.writeFileSync(process.env.OPEN_CAPTURE, JSON.stringify(args)); return { status: 0, stdout: '', stderr: '' }; }",
    '  return original.apply(this, arguments);',
    '};',
  ].join('\n'));
  return preload;
}

function readReviews(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'reviews.json'), 'utf8'));
}

test('mdreview open 创建会话并把文档交给 MDTurn', DARWIN_ONLY, async () => {
  const f = fixture('mdturn-open-');
  const source = path.join(f.docs, 'MDTurn 优先.md');
  fs.writeFileSync(source, '# MDTurn\n');
  const appBundle = path.join(f.base, 'MDTurn.app');
  fs.mkdirSync(appBundle);
  const opened = path.join(f.base, 'opened.json');

  const result = await runNodeAsync(MDREVIEW, ['open', source], {
    MDREAD_DATA_DIR: f.dataDir,
    MDTURN_APP_PATH: appBundle,
    NODE_OPTIONS: `--require=${writeOpenInterceptor(f.base)}`,
    OPEN_CAPTURE: opened,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(opened, 'utf8')), ['-a', fs.realpathSync(appBundle), fs.realpathSync(source)]);
  assert.match(result.stdout, /mdreview wait/);
  const reviews = Object.values(readReviews(f.dataDir).reviews);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'reviewing');
});

test('mdreview open 唤起 MDTurn 失败时报错但保留已创建的会话', DARWIN_ONLY, async () => {
  const f = fixture('mdturn-noapp-');
  const source = path.join(f.docs, '无 App.md');
  fs.writeFileSync(source, '# 无 App\n');
  const appBundle = path.join(f.base, 'MDTurn.app');
  fs.mkdirSync(appBundle);
  const preload = path.join(f.base, 'preload.js');
  fs.writeFileSync(preload, [
    "const cp = require('child_process');",
    'const original = cp.spawnSync;',
    'cp.spawnSync = function(command) {',
    "  if (command === '/usr/bin/open') return { status: 1, stdout: '', stderr: 'MDTurn 打不开' };",
    '  return original.apply(this, arguments);',
    '};',
  ].join('\n'));

  const result = await runNodeAsync(MDREVIEW, ['open', source], {
    MDREAD_DATA_DIR: f.dataDir,
    MDTURN_APP_PATH: appBundle,
    NODE_OPTIONS: `--require=${preload}`,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /APP_OPEN_FAILED/);
  const reviews = Object.values(readReviews(f.dataDir).reviews);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].status, 'reviewing');
});

test('mdreview open --no-open 只创建会话,不唤起 App', async () => {
  const f = fixture('mdturn-noopen-');
  const source = path.join(f.docs, '静默.md');
  fs.writeFileSync(source, '# 静默\n');
  const opened = path.join(f.base, 'opened.json');

  const result = await runNodeAsync(MDREVIEW, ['open', source, '--no-open'], {
    MDREAD_DATA_DIR: f.dataDir,
    NODE_OPTIONS: `--require=${writeOpenInterceptor(f.base)}`,
    OPEN_CAPTURE: opened,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(opened), false);
  assert.equal(Object.values(readReviews(f.dataDir).reviews).length, 1);
});

test('mdreview wait 在用户提交批注后以 0 退出并给出改稿指引', async () => {
  const f = fixture('mdturn-wait-');
  const source = path.join(f.docs, '等待.md');
  fs.writeFileSync(source, '# 等待\n');
  const env = { MDREAD_DATA_DIR: f.dataDir, MDREAD_WAIT_POLL_MS: '300' };

  const openResult = await runNodeAsync(MDREVIEW, ['open', source, '--no-open'], env);
  assert.equal(openResult.status, 0, openResult.stderr);
  const reviewId = Object.keys(readReviews(f.dataDir).reviews)[0];
  fs.writeFileSync(`${source}.annotations.json`, JSON.stringify({
    version: 1,
    file: path.basename(source),
    annotations: [{ id: 'n1', comment: '改一下', status: 'open' }],
  }));

  const waiting = runNodeAsync(MDREVIEW, ['wait', source], env);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const submit = await runNodeAsync('-e', [
    `require(${JSON.stringify(path.join(PROJECT, 'lib', 'review-store.js'))}).submitReview(${JSON.stringify(reviewId)}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });`,
  ], env);
  assert.equal(submit.status, 0, submit.stderr);

  const result = await waiting;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /begin-apply/);
});

const STORE_PATH = path.join(PROJECT, 'lib', 'review-store.js');
function storeCall(env, code) {
  return runNodeAsync('-e', [
    `const s=require(${JSON.stringify(STORE_PATH)});(async()=>{${code}})().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});`,
  ], env);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test('mdreview wait 跨轮:complete 后继续等待,用户开新一轮并提交后才返回', async () => {
  const f = fixture('mdturn-wait-round-');
  const source = path.join(f.docs, '跨轮.md');
  fs.writeFileSync(source, '# 跨轮\n');
  const env = { MDREAD_DATA_DIR: f.dataDir, MDREAD_WAIT_POLL_MS: '300' };
  fs.writeFileSync(`${source}.annotations.json`, JSON.stringify({ version: 1, file: '跨轮.md', annotations: [] }));

  // 第一轮走完: open -> submit(有批注) -> begin-apply -> complete
  assert.equal((await runNodeAsync(MDREVIEW, ['open', source, '--no-open'], env)).status, 0);
  fs.writeFileSync(`${source}.annotations.json`, JSON.stringify({ version: 1, file: '跨轮.md', annotations: [{ id: 'n1', comment: '改', status: 'open' }] }));
  assert.equal((await storeCall(env, `await s.submitReview(${JSON.stringify(source)});`)).status, 0);
  assert.equal((await runNodeAsync(MDREVIEW, ['begin-apply', source], env)).status, 0);
  fs.writeFileSync(`${source}.annotations.json`, JSON.stringify({ version: 1, file: '跨轮.md', annotations: [{ id: 'n1', comment: '改', status: 'applied' }] }));
  const complete = await runNodeAsync(MDREVIEW, ['complete', source], env);
  assert.equal(complete.status, 0, complete.stderr);
  assert.match(complete.stdout, /再以后台任务挂起 mdreview wait/);

  // complete 之后挂 wait:不应立刻退出
  const waiting = runNodeAsync(MDREVIEW, ['wait', source, '--timeout-minutes', '1'], env);
  let settled = false; waiting.then(() => { settled = true; });
  await sleep(900);
  assert.equal(settled, false, 'wait 在 complete 状态下不应立即退出');

  // 用户开始第二轮并提交批注
  assert.equal((await runNodeAsync(MDREVIEW, ['open', source, '--no-open'], env)).status, 0);
  await sleep(500);
  assert.equal(settled, false, '新一轮 reviewing 时仍应继续等待');
  fs.writeFileSync(`${source}.annotations.json`, JSON.stringify({ version: 1, file: '跨轮.md', annotations: [{ id: 'n1', comment: '改', status: 'applied' }, { id: 'n2', comment: '再改', status: 'open' }] }));
  assert.equal((await storeCall(env, `await s.submitReview(${JSON.stringify(source)});`)).status, 0);
  const result = await waiting;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /用户已开始新一轮审阅/);
  assert.match(result.stdout, /begin-apply/);
});

test('mdreview wait 在用户「定稿并关闭」后返回并明确审阅结束', async () => {
  const f = fixture('mdturn-wait-final-');
  const source = path.join(f.docs, '定稿.md');
  fs.writeFileSync(source, '# 定稿\n');
  const env = { MDREAD_DATA_DIR: f.dataDir, MDREAD_WAIT_POLL_MS: '300' };
  assert.equal((await runNodeAsync(MDREVIEW, ['open', source, '--no-open'], env)).status, 0);
  fs.writeFileSync(`${source}.annotations.json`, JSON.stringify({ version: 1, file: '定稿.md', annotations: [{ id: 'n1', comment: '改', status: 'open' }] }));
  assert.equal((await storeCall(env, `await s.submitReview(${JSON.stringify(source)});`)).status, 0);
  assert.equal((await runNodeAsync(MDREVIEW, ['begin-apply', source], env)).status, 0);
  fs.writeFileSync(`${source}.annotations.json`, JSON.stringify({ version: 1, file: '定稿.md', annotations: [{ id: 'n1', comment: '改', status: 'applied' }] }));
  assert.equal((await runNodeAsync(MDREVIEW, ['complete', source], env)).status, 0);

  const waiting = runNodeAsync(MDREVIEW, ['wait', source, '--timeout-minutes', '1'], env);
  await sleep(500);
  const reviewId = Object.keys(readReviews(f.dataDir).reviews)[0];
  const fin = await storeCall(env, `const r=await s.finalizeReview(${JSON.stringify(reviewId)}); if(r.outcome!=='finalized') throw new Error('outcome '+r.outcome);`);
  assert.equal(fin.status, 0, fin.stderr);
  const result = await waiting;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已定稿/);
  assert.match(result.stdout, /不要再挂 wait/);
  // 定稿只允许 complete 状态
  const again = await storeCall(env, `await s.finalizeReview(${JSON.stringify(reviewId)});`);
  assert.equal(again.status, 0, '重复定稿应幂等成功');
});

test('手工修改轮:complete 后 beginManualEdit 开 applying/manual;open 不冻结;wait 等到提交后返回', async () => {
  const f = fixture('mdturn-manual-');
  const source = path.join(f.docs, '手工.md');
  fs.writeFileSync(source, '# 手工\n');
  const env = { MDREAD_DATA_DIR: f.dataDir, MDREAD_WAIT_POLL_MS: '300' };
  // 零批注提交 -> complete/approved
  assert.equal((await runNodeAsync(MDREVIEW, ['open', source, '--no-open'], env)).status, 0);
  assert.equal((await storeCall(env, `await s.submitReview(${JSON.stringify(source)});`)).status, 0);

  const manual = await storeCall(env, `const r=await s.beginManualEdit(${JSON.stringify(source)}); if(r.status!=='applying'||r.applyMode!=='manual') throw new Error(JSON.stringify(r));`);
  assert.equal(manual.status, 0, manual.stderr);

  const open = await runNodeAsync(MDREVIEW, ['open', source, '--no-open'], env);
  assert.equal(open.status, 0, open.stderr);
  assert.match(open.stdout, /用户正在 MDTurn 里手工修改/);
  assert.match(open.stdout, /不要改这个文件/);
  const reviews = Object.values(readReviews(f.dataDir).reviews);
  assert.equal(reviews.filter((r) => r.status === 'applying').length, 1, 'open 不应再创建新会话');

  const waiting = runNodeAsync(MDREVIEW, ['wait', source, '--timeout-minutes', '1'], env);
  let settled = false; waiting.then(() => { settled = true; });
  await sleep(800);
  assert.equal(settled, false, '用户手工修改中 wait 不应退出');
  fs.writeFileSync(source, '# 手工\n用户改了。\n');
  assert.equal((await storeCall(env, `await s.completeReview(${JSON.stringify(source)}, { expectedApplyMode: 'manual' });`)).status, 0);
  const result = await waiting;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /用户已手工改完/);
});
