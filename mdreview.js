#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ReviewStoreError,
  getPaths,
  getReviewByPath,
  openReview,
  beginApply,
  completeReview,
  unlockReview,
} = require('./lib/review-store');

const LAUNCH_AGENT = 'com.mdread.serve';

function usage() {
  return [
    '用法:',
    '  mdreview open <绝对路径.md> [--no-open]',
    '  mdreview status <绝对路径.md> [--json]',
    '  mdreview begin-apply <绝对路径.md>',
    '  mdreview complete <绝对路径.md>',
    '  mdreview unlock <绝对路径.md> --reason "<原因>"',
  ].join('\n');
}

function fail(message, exitCode = 1) {
  console.error(`mdreview 错误: ${message}`);
  process.exitCode = exitCode;
}

function parseArgs(argv) {
  const result = { command: argv[0], file: null, json: false, noOpen: false, reason: null };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') result.json = true;
    else if (value === '--no-open') result.noOpen = true;
    else if (value === '--reason') result.reason = argv[++index];
    else if (value.startsWith('--')) throw new ReviewStoreError('BAD_ARGUMENT', `未知参数: ${value}`, { httpStatus: 400 });
    else if (!result.file) result.file = value;
    else throw new ReviewStoreError('BAD_ARGUMENT', `多余参数: ${value}`, { httpStatus: 400 });
  }
  return result;
}

function requestHealth(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs,
      headers: { Accept: 'application/json' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const data = JSON.parse(body);
          const valid = response.statusCode === 200 && data && data.ok === true &&
            data.service === 'md-read' && data.port === port;
          resolve(valid ? { port, data } : null);
        } catch { resolve(null); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

function parsePortStrict(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function readRecordedPortStrict() {
  try { return parsePortStrict(fs.readFileSync(getPaths().port, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function candidatePorts() {
  const ports = [];
  const recorded = readRecordedPortStrict();
  const configured = parsePortStrict(process.env.MDREAD_PORT || '8080');
  if (recorded) ports.push(recorded);
  if (Number.isInteger(configured)) {
    for (let port = configured; port <= Math.min(configured + 10, 65535); port += 1) ports.push(port);
  }
  return [...new Set(ports)];
}

async function findHealthyService() {
  const results = await Promise.all(candidatePorts().map((port) => requestHealth(port)));
  return results.find(Boolean) || null;
}

function postReviewNotification(port, reviewSessionId, reason, timeoutMs = 900) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ reviewSessionId, reason }));
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/app/review/notify',
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        try {
          const data = JSON.parse(responseBody);
          finish(response.statusCode === 200 && data && data.ok === true &&
            data.event && data.event.reviewSessionId === reviewSessionId);
        } catch { finish(false); }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => finish(false));
    request.end(body);
  });
}

async function notifyReviewChangedBestEffort(review, reason) {
  try {
    const service = await findHealthyService();
    if (!service) return false;
    return await postReviewNotification(service.port, review.id, reason);
  } catch (error) {
    if (process.env.MDREAD_DEBUG) {
      console.error(`主动通知未送达（状态已安全落盘）: ${error.message || error}`);
    }
    return false;
  }
}

function resolveMDTurnApp() {
  const candidates = [
    process.env.MDTURN_APP_PATH,
    '/Applications/MDTurn.app',
    process.env.HOME ? path.join(process.env.HOME, 'Applications', 'MDTurn.app') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const realPath = fs.realpathSync(candidate);
      if (path.extname(realPath).toLowerCase() === '.app' && fs.statSync(realPath).isDirectory()) return realPath;
    } catch (_) {}
  }
  return null;
}

async function ensureService() {
  let healthy = await findHealthyService();
  if (healthy) return healthy;

  const domain = `gui/${process.getuid()}`;
  const kickstart = spawnSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${LAUNCH_AGENT}`], {
    encoding: 'utf8', timeout: 5000,
  });
  if (kickstart.error || kickstart.status !== 0) {
    const detail = (kickstart.stderr || kickstart.error?.message || '').trim();
    throw new ReviewStoreError('SERVICE_START_FAILED',
      `无法启动 ${LAUNCH_AGENT}${detail ? `: ${detail}` : ''}`, { httpStatus: 503 });
  }

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    healthy = await findHealthyService();
    if (healthy) return healthy;
  }
  throw new ReviewStoreError('SERVICE_UNAVAILABLE',
    `已启动 ${LAUNCH_AGENT}，但 12 秒内未检测到本地服务。请检查 /tmp/mdread-server.log。`, { httpStatus: 503 });
}

function printReview(review) {
  console.log(`文档: ${review.absPath}`);
  console.log(`会话: ${review.id}`);
  console.log(`状态: ${review.status}`);
}

async function commandOpen(args) {
  if (!args.file) throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
  const service = args.noOpen ? null : await ensureService();
  const { review, reused } = await openReview(args.file);
  printReview(review);
  console.log(reused ? '已复用现有审阅会话。' : '已冻结文档并创建审阅会话。');
  if (args.noOpen) return;

  const url = `http://127.0.0.1:${service.port}/r/${encodeURIComponent(review.id)}`;
  if (process.platform !== 'darwin') {
    throw new ReviewStoreError('OPEN_UNSUPPORTED', `当前系统不能自动打开浏览器，请手动访问: ${url}`, { httpStatus: 500 });
  }

  // Only target a real installed bundle, not an indexed development build.
  // This keeps the existing browser flow usable while a staged App has not
  // been activated in /Applications yet.
  const appPath = resolveMDTurnApp();
  const appOpened = appPath ? spawnSync('/usr/bin/open', ['-a', appPath, review.absPath], {
    encoding: 'utf8', timeout: 5000,
  }) : null;
  if (appOpened && !appOpened.error && appOpened.status === 0) {
    // Keep printing the localhost URL for scripts and for manual recovery.
    console.log(`本地审阅: ${url}`);
    return;
  }

  const opened = spawnSync('/usr/bin/open', [url], { encoding: 'utf8', timeout: 5000 });
  if (opened.error || opened.status !== 0) {
    const detail = (opened.stderr || opened.error?.message || '').trim();
    throw new ReviewStoreError('BROWSER_OPEN_FAILED', `无法打开浏览器${detail ? `: ${detail}` : ''}`, { httpStatus: 500 });
  }
  console.log(`本地审阅: ${url}`);
}

async function commandStatus(args) {
  if (!args.file) throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
  const absPath = path.resolve(args.file);
  const review = await getReviewByPath(absPath);
  if (args.json) {
    console.log(JSON.stringify(review ? { tracked: true, review } : { tracked: false, absPath, status: 'untracked' }, null, 2));
    return;
  }
  if (!review) {
    console.log(`文档: ${absPath}`);
    console.log('状态: untracked（没有活动审阅会话）');
    return;
  }
  printReview(review);
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) {
    fail(error.message);
    console.error(usage());
    return;
  }
  try {
    if (args.command === 'open') return await commandOpen(args);
    if (args.command === 'status') return await commandStatus(args);
    if (args.command === 'begin-apply') {
      if (!args.file) throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
      const review = await beginApply(args.file);
      printReview(review);
      await notifyReviewChangedBestEffort(review, 'agent-apply-started');
      return;
    }
    if (args.command === 'complete') {
      if (!args.file) throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
      // Completion is the source of truth.  Notify the long-running service
      // only after the atomic state transition succeeds, and never turn a
      // delivery failure into a failed completion command.
      const review = await completeReview(args.file);
      printReview(review);
      await notifyReviewChangedBestEffort(review, 'agent-complete');
      return;
    }
    if (args.command === 'unlock') {
      if (!args.file) throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
      const review = await unlockReview(args.file, args.reason);
      printReview(review);
      console.log(`解锁原因: ${review.cancelReason}`);
      await notifyReviewChangedBestEffort(review, 'review-cancelled');
      return;
    }
    throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
  } catch (error) {
    const suffix = error.code ? ` [${error.code}]` : '';
    fail(`${error.message}${suffix}`);
    if (error.details && process.env.MDREAD_DEBUG) console.error(JSON.stringify(error.details, null, 2));
  }
}

main();
