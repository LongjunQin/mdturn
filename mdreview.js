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

function usage() {
  return [
    '用法:',
    '  mdreview open <绝对路径.md> [--no-open]',
    '  mdreview status <绝对路径.md> [--json]',
    '  mdreview wait <绝对路径.md> [--timeout-minutes <n>]  # 阻塞等待用户下一个动作(提交批注/定稿/手工改完),可跨轮',
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

function printReview(review) {
  console.log(`文档: ${review.absPath}`);
  console.log(`会话: ${review.id}`);
  console.log(`状态: ${review.status}`);
}

async function commandOpen(args) {
  if (!args.file) throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
  const { review, reused, recovered } = await openReview(args.file);
  printReview(review);
  if (recovered) console.log('检测到旧会话冲突且批注已全部处理,已自动结束旧会话。');
  if (review.status === 'applying' && review.applyMode === 'manual') {
    console.log('用户正在 MDTurn 里手工修改这篇文档,未创建新一轮。');
    console.log(`→ Agent 下一步: 不要改这个文件。以后台任务挂起 mdreview wait "${review.absPath}",它会在用户提交修改后返回;届时若还需要用户审阅,再重新 mdreview open。`);
    return;
  }
  // 兜底通道:通过本地服务事件流让运行中的 App 直接打开该标签(与下面的 open -a 并行,任一条通即可)
  const notified = await notifyReviewChangedBestEffort(review, 'cli-open');
  console.log(reused ? '已复用现有审阅会话(用户尚未提交)。' : '已冻结文档并创建审阅会话。');
  console.log(`→ Agent 下一步: 立即以后台任务挂起 mdreview wait "${review.absPath}",阻塞至用户点击「完成本轮审阅」;用户不会回到对话里通报。审阅期间禁止绕过 mdreview 直接修改该文档。`);
  if (args.noOpen) return;

  if (process.platform !== 'darwin') {
    throw new ReviewStoreError('OPEN_UNSUPPORTED',
      '当前系统不支持自动唤起 MDTurn,请手动在 MDTurn 应用中打开该文档(会话已创建,亦可用 --no-open 静默此提示)。', { httpStatus: 500 });
  }
  const appPath = resolveMDTurnApp();
  if (!appPath) {
    throw new ReviewStoreError('APP_NOT_FOUND',
      '未找到 MDTurn.app。请把 MDTurn 安装到 /Applications(下载: https://github.com/LongjunQin/mdturn/releases)后重试;审阅会话已创建,安装后重新运行本命令即可。', { httpStatus: 500 });
  }
  const appOpened = spawnSync('/usr/bin/open', ['-a', appPath, review.absPath], {
    encoding: 'utf8', timeout: 5000,
  });
  if (appOpened.error || appOpened.status !== 0) {
    const detail = (appOpened.stderr || appOpened.error?.message || '').trim();
    throw new ReviewStoreError('APP_OPEN_FAILED', `无法打开 MDTurn${detail ? `: ${detail}` : ''}`, { httpStatus: 500 });
  }
  console.log(notified ? '已在 MDTurn 中打开(App 已收到打开通知),等待用户审阅。' : '已在 MDTurn 中打开,等待用户审阅。');
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

// 阻塞等待用户在 MDTurn 里的下一个动作。设计给智能体后台挂起使用:命令退出即代表
// 用户有了新动作,智能体被唤醒后按输出分流,无需用户回到对话里通报。
// 跨轮语义:wait 不会因为"启动时已处于的状态"而退出——上一轮 complete 后继续挂着,
// 直到用户开始新一轮并提交批注、定稿、或手工改完;这样 open/complete 之后各挂一次
// wait 就不会漏掉任何一轮。
// 退出码: 0=用户有了新动作(批注已提交/全文通过/已定稿/手工改完/别处已开始改稿)
//         2=会话被取消/冲突/丢失 3=等待超时
function sameState(a, b) {
  return !!a && !!b && a.id === b.id && a.status === b.status &&
    (a.outcome || '') === (b.outcome || '') && (a.applyMode || '') === (b.applyMode || '');
}

async function commandWait(args) {
  if (!args.file) throw new ReviewStoreError('BAD_ARGUMENT', usage(), { httpStatus: 400 });
  const absPath = path.resolve(args.file);
  const pollMs = Math.max(300, Number(process.env.MDREAD_WAIT_POLL_MS) || 2000);
  const deadline = Date.now() + (args.timeoutMinutes || 480) * 60000;
  const initial = await getReviewByPath(absPath);
  if (!initial) {
    throw new ReviewStoreError('NO_ACTIVE_REVIEW', `该文档没有活动审阅会话,请先 mdreview open: ${absPath}`, { httpStatus: 404 });
  }
  console.log(`等待用户的下一个动作: ${absPath}`);
  console.log(`会话: ${initial.id}(当前状态 ${initial.status}${initial.applyMode ? '/' + initial.applyMode : ''})`);
  if (initial.status === 'complete' && !['approved', 'finalized'].includes(initial.outcome || '')) {
    console.log('本轮已闭环,继续等待:用户可能在 MDTurn 里开始新一轮审阅,也可能定稿并关闭。');
  }
  let announced = initial.id;
  for (;;) {
    const review = await getReviewByPath(absPath);
    const status = review ? review.status : 'untracked';
    if (sameState(initial, review)) {
      if (Date.now() >= deadline) {
        fail(`等待超时(${args.timeoutMinutes || 480} 分钟),用户尚未有新动作。→ 可再次运行 mdreview wait "${absPath}" 继续等待,或 mdreview status 查看现状。`, 3);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (status === 'reviewing') {
      if (announced !== review.id) { announced = review.id; console.log(`用户已开始新一轮审阅(会话 ${review.id}),继续等待其提交。`); }
    } else if (status === 'applying' && review.applyMode === 'manual') {
      if (announced !== review.id) { announced = review.id; console.log(`用户正在 MDTurn 里手工修改(会话 ${review.id}),继续等待其提交;期间不要改这个文件。`); }
    } else if (status === 'ready_to_apply') {
      printReview(review);
      console.log(`→ 用户已完成批注。先读 ${absPath}.annotations.json 中 status=open 的批注(有歧义先向用户逐条确认,一次一个问题);修改源文件前必须先运行 mdreview begin-apply "${absPath}",否则触发版本冲突。`);
      return;
    } else if (status === 'applying') {
      printReview(review);
      console.log(`→ 本轮已进入改稿阶段(begin-apply 已在别处运行)。处理 ${absPath}.annotations.json 中 status=open 的批注,逐条标 applied/wontfix,全部清零后运行 mdreview complete "${absPath}"。`);
      return;
    } else if (status === 'complete') {
      if (review.outcome === 'finalized') {
        printReview(review);
        console.log('→ 用户已定稿并关闭文档,审阅结束。不要再挂 wait,也不要再改这个文件;向用户汇报即可。');
        return;
      }
      if (review.outcome === 'approved') {
        printReview(review);
        console.log('→ 用户已完成本轮审阅: 全文通过,没有批注,无需改稿。若用户后续还要修改,会在 MDTurn 里开始新一轮,可再挂一次 wait。');
        return;
      }
      if (review.applyMode === 'manual') {
        printReview(review);
        console.log(`→ 用户已手工改完并提交,文件内容已更新(改前请重新读取)。若还需要用户审阅,重新 mdreview open "${absPath}";否则不必再操作。`);
        return;
      }
      if (announced !== review.id) { announced = review.id; console.log('本轮已闭环,继续等待用户开始新一轮或定稿。'); }
    } else {
      const label = { conflict: '版本冲突', cancelled: '审阅被取消', untracked: '审阅会话丢失' }[status] || `状态异常(${status})`;
      if (review) printReview(review);
      fail(`等待异常结束: ${label}。→ 先运行 mdreview status "${absPath}" 查明情况,再决定下一步。`, 2);
      return;
    }
    if (Date.now() >= deadline) {
      fail(`等待超时(${args.timeoutMinutes || 480} 分钟),用户尚未有新动作。→ 可再次运行 mdreview wait "${absPath}" 继续等待,或 mdreview status 查看现状。`, 3);
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
      console.log(`→ 只处理 ${review.absPath}.annotations.json 中 status=open 的批注,用 quote+headingPath 定位改稿,逐条就地标 applied/wontfix(可附 appliedNote 说明改法);全部清零后运行 mdreview complete "${review.absPath}"。`);
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
      console.log(`→ 闭环完成(本轮): 批注已全部处理,MDTurn 会自动加载最新版并通知用户。用户接下来可能再审一轮或定稿——立即再以后台任务挂起 mdreview wait "${review.absPath}",它会在用户提交新批注或定稿时返回;不要主动去关 MDTurn 里的标签或移动 .annotations.json。`);
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
    if (error.code === 'OPEN_ANNOTATIONS' && args.file) {
      console.error(`→ 回到 ${path.resolve(args.file)}.annotations.json 把剩余 open 批注逐条标为 applied/wontfix,再运行 mdreview complete。`);
    }
    if (error.details && process.env.MDREAD_DEBUG) console.error(JSON.stringify(error.details, null, 2));
  }
}

main();
