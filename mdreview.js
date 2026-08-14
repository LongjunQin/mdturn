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
    '  mdreview wait <绝对路径.md> [--timeout-minutes <n>]  # 阻塞等待用户点击「完成本轮审阅」',
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
  const result = { command: argv[0], file: null, json: false, noOpen: false, reason: null, timeoutMinutes: null };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') result.json = true;
    else if (value === '--no-open') result.noOpen = true;
    else if (value === '--reason') result.reason = argv[++index];
    else if (value === '--timeout-minutes') {
      const minutes = Number(argv[++index]);
      if (!Number.isFinite(minutes) || minutes <= 0) throw new ReviewStoreError('BAD_ARGUMENT', '--timeout-minutes 需要一个正数', { httpStatus: 400 });
      result.timeoutMinutes = minutes;
    }
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
  const { review, reused, recovered } = await openReview(args.file);
  printReview(review);
  if (recovered) console.log('检测到旧会话冲突且批注已全部处理,已自动结束旧会话。');
  console.log(reused ? '已复用现有审阅会话。' : '已冻结文档并创建审阅会话。');
  console.log(`提示: 智能体可后台运行 mdreview wait "${review.absPath}" 挂起等待,用户点击「完成本轮审阅」后命令自动退出,无需用户回对话通报。`);
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

// 阻塞等待用户在 MDTurn 里点击「完成本轮审阅」。设计给智能体后台挂起使用:
// 命令退出即代表审阅有了结果,智能体被唤醒后按退出码分流,无需用户回到对话里通报。
// 退出码: 0=批注已提交(或全文通过) 2=会话被取消/冲突/丢失 3=等待超时
async function commandWait(args) {
  if (!args.file) throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
  const absPath = path.resolve(args.file);
  const pollMs = Math.max(300, Number(process.env.MDREAD_WAIT_POLL_MS) || 2000);
  const deadline = Date.now() + (args.timeoutMinutes || 480) * 60000;
  const initial = await getReviewByPath(absPath);
  if (!initial) {
    throw new ReviewStoreError('NO_ACTIVE_REVIEW', `该文档没有活动审阅会话,请先 mdreview open: ${absPath}`, { httpStatus: 404 });
  }
  console.log(`等待用户完成审阅: ${absPath}`);
  console.log(`会话: ${initial.id}(当前状态 ${initial.status})`);
  for (;;) {
    const review = await getReviewByPath(absPath);
    const status = review ? review.status : 'untracked';
    if (status === 'ready_to_apply') {
      printReview(review);
      console.log('用户已点击「完成本轮审阅」,批注已提交。下一步: 运行 mdreview begin-apply,读取 sidecar 中 status=open 的批注;有歧义先向用户提问,再逐条改稿。');
      return;
    }
    if (status === 'complete') {
      printReview(review);
      console.log(review.outcome === 'approved'
        ? '用户已完成本轮审阅: 全文通过,没有批注,无需改稿。'
        : '本轮审阅已在别处走完闭环,无需再处理。');
      return;
    }
    if (status === 'applying') {
      printReview(review);
      console.log('本轮已进入改稿阶段(begin-apply 已在别处运行),直接处理 sidecar 中 status=open 的批注即可。');
      return;
    }
    if (status !== 'reviewing') {
      const label = { conflict: '版本冲突', cancelled: '审阅被取消', untracked: '审阅会话丢失' }[status] || `状态异常(${status})`;
      if (review) printReview(review);
      fail(`等待结束: ${label}。请运行 mdreview status 查看详情后再决定下一步。`, 2);
      return;
    }
    if (Date.now() >= deadline) {
      fail(`等待超时(${args.timeoutMinutes || 480} 分钟),用户尚未完成审阅。可再次运行 mdreview wait 继续等待。`, 3);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
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
    if (args.command === 'wait') return await commandWait(args);
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
