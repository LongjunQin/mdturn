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
