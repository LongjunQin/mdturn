#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const APPLY_HINT = '本文件是对 sourceFile 的评审批注(由 md-read 生成,与同目录同名 .md 一一对应)。' +
  '改稿协议——第一步:动手修改 sourceFile 之前,必须先运行 mdreview begin-apply "<sourceFile绝对路径>" 声明开始改稿' +
  '(跳过此步直接改文件,会被判为版本冲突);mdreview 不在 PATH 时用 MDTurn 仓库下的 node mdreview.js 等价调用。' +
  '第二步:只处理 status=open 的批注;用 quote+headingPath 定位(lineStart 仅辅助,改稿后可能偏移);' +
  '每处理完一条标 status=applied + appliedAt + appliedBy + appliedNote,不采纳的标 status=wontfix + 理由;绝不重做 status=applied 的。' +
  '第三步:全部 open 清零后运行 mdreview complete "<sourceFile绝对路径>",本轮才算结束。';
const ACTIVE_REVIEW_STATES = new Set(['reviewing', 'ready_to_apply', 'applying', 'conflict']);
const TERMINAL_REVIEW_STATES = new Set(['complete', 'cancelled']);

class ReviewStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ReviewStoreError';
    this.code = code;
    this.httpStatus = options.httpStatus || 500;
    this.details = options.details;
    if (options.cause) this.cause = options.cause;
  }
}

// CLI、App 内置服务与 Agent 共用同一份会话数据,因此默认目录必须与安装位置无关。
function getDataDir(options = {}) {
  return path.resolve(options.dataDir || process.env.MDREAD_DATA_DIR || path.join(os.homedir(), '.mdread'));
}

function getPaths(options = {}) {
  const dataDir = getDataDir(options);
  return {
    dataDir,
    reviews: path.join(dataDir, 'reviews.json'),
    port: path.join(dataDir, 'port'),
  };
}

function ensureDataDir(options = {}) {
  const dataDir = getDataDir(options);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const paths = getPaths(options);
  for (const filePath of [paths.reviews, paths.port]) {
    try { fs.chmodSync(filePath, 0o600); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return dataDir;
}

function cloneDefault(valueOrFactory) {
  const value = typeof valueOrFactory === 'function' ? valueOrFactory() : valueOrFactory;
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function readJsonStrict(filePath, defaultValue) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && defaultValue !== undefined) return cloneDefault(defaultValue);
    if (error.code === 'ENOENT') {
      throw new ReviewStoreError('JSON_NOT_FOUND', `JSON 文件不存在: ${filePath}`, {
        httpStatus: 404, details: { filePath }, cause: error,
      });
    }
    throw new ReviewStoreError('JSON_READ_FAILED', `无法读取 JSON: ${filePath}`, {
      details: { filePath }, cause: error,
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ReviewStoreError('MALFORMED_JSON', `已有 JSON 已损坏，已停止写入以保护原数据: ${filePath}`, {
      details: { filePath }, cause: error,
    });
  }
}

function modeForExisting(filePath, fallback = 0o600) {
  try { return fs.statSync(filePath).mode & 0o777; } catch { return fallback; }
}

async function atomicWriteFile(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const mode = options.mode === undefined ? modeForExisting(filePath) : options.mode;
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(temp, 'wx', mode);
    await handle.writeFile(content, options.encoding || 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.chmod(temp, mode);
    // Windows 上目标文件被并发读取/杀毒扫描短暂占用时 rename 会瞬时 EPERM,限次重试
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.promises.rename(temp, filePath);
        break;
      } catch (renameError) {
        if (!isWindowsTransient(renameError) || attempt >= 40) throw renameError;
        await delay(25);
      }
    }
    try {
      const dirHandle = await fs.promises.open(dir, 'r');
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch {}
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temp).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(filePath, data, options = {}) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  return atomicWriteFile(filePath, serialized, { ...options, encoding: 'utf8' });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Windows 上 rmdir 是异步的"删除挂起":此窗口内对同一目录的 mkdir/stat/rm
// 会瞬时报 EPERM/EBUSY 等,必须当作竞争重试而不是硬错误。
const WINDOWS_TRANSIENT_CODES = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'];
function isWindowsTransient(error) {
  return process.platform === 'win32' && WINDOWS_TRANSIENT_CODES.includes(error.code);
}

async function withFileLock(targetPath, operation, options = {}) {
  const lockPath = options.lockPath || `${targetPath}.lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const timeoutMs = options.timeoutMs || Number(process.env.MDREAD_LOCK_TIMEOUT_MS) || 8000;
  const staleMs = options.staleMs || 60000;
  const started = Date.now();
  const token = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.promises.mkdir(lockPath, { mode: 0o700 });
      try {
        await fs.promises.writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), {
          flag: 'wx', mode: 0o600,
        });
      } catch (error) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' && !isWindowsTransient(error)) throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          let owner = null;
          try { owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8')); } catch {}
          if (!owner || !processIsRunning(Number(owner.pid))) {
            const stalePath = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
            try {
              await fs.promises.rename(lockPath, stalePath);
              await fs.promises.rm(stalePath, { recursive: true, force: true });
              continue;
            } catch (staleError) {
              if (!['ENOENT', 'EEXIST'].includes(staleError.code)) throw staleError;
            }
          }
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        if (!isWindowsTransient(statError)) throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new ReviewStoreError('LOCK_TIMEOUT', `等待文件锁超时: ${targetPath}`, {
          httpStatus: 503, details: { targetPath, lockPath, timeoutMs },
        });
      }
      await delay(20 + Math.floor(Math.random() * 31));
    }
  }

  try {
    return await operation();
  } finally {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'));
        if (owner.token === token) await fs.promises.rm(lockPath, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code === 'ENOENT') break;
        if (isWindowsTransient(error) && attempt < 20) { await delay(25); continue; }
        throw error;
      }
    }
  }
}

function reviewTransactionLockPath(absPath, options = {}) {
  const digest = crypto.createHash('sha256').update(path.resolve(absPath)).digest('hex');
  return path.join(getDataDir(options), 'transactions', `${digest}.lock`);
}

async function withReviewTransaction(absPath, operation, options = {}) {
  ensureDataDir(options);
  return withFileLock(absPath, operation, {
    ...(options.lock || {}),
    lockPath: reviewTransactionLockPath(absPath, options),
  });
}

async function mutateJson(filePath, defaultValue, mutator, options = {}) {
  return withFileLock(filePath, async () => {
    const data = readJsonStrict(filePath, defaultValue);
    if (options.validate) options.validate(data, filePath);
    const result = await mutator(data);
    if (options.validate) options.validate(data, filePath);
    await atomicWriteJson(filePath, data, options);
    return result;
  }, options.lock);
}

function sha256File(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch (error) {
    throw new ReviewStoreError('SOURCE_READ_FAILED', `无法读取源文档: ${absPath}`, {
      httpStatus: error.code === 'ENOENT' ? 404 : 500,
      details: { absPath }, cause: error,
    });
  }
}

function normalizeMdPath(inputPath) {
  if (!inputPath) throw new ReviewStoreError('INVALID_DOCUMENT', '请给出 Markdown 文件路径。', { httpStatus: 400 });
  const resolved = path.resolve(inputPath);
  if (!/\.md$/i.test(resolved)) {
    throw new ReviewStoreError('INVALID_DOCUMENT', `只支持 .md 文件: ${resolved}`, {
      httpStatus: 400, details: { absPath: resolved },
    });
  }
  let absPath;
  try { absPath = fs.realpathSync(resolved); } catch (error) {
    throw new ReviewStoreError('SOURCE_NOT_FOUND', `Markdown 文件不存在: ${resolved}`, {
      httpStatus: 404, details: { absPath: resolved }, cause: error,
    });
  }
  if (!fs.statSync(absPath).isFile()) {
    throw new ReviewStoreError('INVALID_DOCUMENT', `路径不是文件: ${absPath}`, {
      httpStatus: 400, details: { absPath },
    });
  }
  return absPath;
}

function resolvePathBestEffort(inputPath) {
  const resolved = path.resolve(inputPath);
  try { return fs.realpathSync(resolved); } catch {}
  try { return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); } catch {}
  return resolved;
}

const sidecarFor = (absMd) => `${absMd}.annotations.json`;

// v1 sidecar 允许批注缺少 status。所有读取与状态判断都必须把它们当作 open，
// 避免旧批注在计数、完成审阅或新应用端中被静默遗漏。
function annotationStatus(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return 'open';
  return ['open', 'applied', 'wontfix'].includes(annotation.status) ? annotation.status : 'open';
}

function normalizeLegacyAnnotation(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return annotation;
  if (annotation.status === undefined || annotation.status === null || annotation.status === '') {
    return { ...annotation, status: 'open' };
  }
  return annotation;
}

function readAnnotations(absMd) {
  const sidecar = sidecarFor(absMd);
  const existing = readJsonStrict(sidecar, {});
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new ReviewStoreError('INVALID_SIDECAR', `批注 sidecar 顶层必须是对象: ${sidecar}`, {
      details: { sidecar },
    });
  }
  if (existing.annotations !== undefined && !Array.isArray(existing.annotations)) {
    throw new ReviewStoreError('INVALID_SIDECAR', `批注 sidecar 的 annotations 必须是数组: ${sidecar}`, {
      details: { sidecar },
    });
  }
  return {
    ...existing,
    version: existing.version || 1,
    sourceFile: absMd,
    file: path.basename(absMd),
    _apply: APPLY_HINT,
    annotations: (existing.annotations || []).map(normalizeLegacyAnnotation),
  };
}

async function mutateAnnotations(absMd, mutator, options = {}) {
  const sidecar = sidecarFor(absMd);
  return withFileLock(sidecar, async () => {
    const data = readAnnotations(absMd);
    const result = await mutator(data);
    if (!Array.isArray(data.annotations)) {
      throw new ReviewStoreError('INVALID_SIDECAR', 'mutator 不能把 annotations 改为非数组。', {
        details: { sidecar },
      });
    }
    await atomicWriteJson(sidecar, data, { mode: options.mode });
    return result;
  }, options.lock);
}

function countOpenAnnotations(absMd) {
  return readAnnotations(absMd).annotations.filter((annotation) => annotationStatus(annotation) === 'open').length;
}

function validateReviewData(data, filePath) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !data.reviews || typeof data.reviews !== 'object' || Array.isArray(data.reviews)) {
    throw new ReviewStoreError('INVALID_REVIEWS', `审阅索引结构无效: ${filePath}`, {
      details: { filePath },
    });
  }
}

const emptyReviews = () => ({ version: 1, reviews: {} });

function readReviewData(options = {}) {
  const reviewsFile = getPaths(options).reviews;
  const data = readJsonStrict(reviewsFile, emptyReviews);
  validateReviewData(data, reviewsFile);
  return data;
}

function sortNewestFirst(reviews) {
  return reviews.sort((a, b) => Date.parse(b.lastOpenedAt || b.createdAt || 0) - Date.parse(a.lastOpenedAt || a.createdAt || 0));
}

function findByPath(data, absPath, activeOnly = false) {
  const matches = Object.values(data.reviews).filter((review) =>
    review && review.absPath === absPath && (!activeOnly || ACTIVE_REVIEW_STATES.has(review.status)));
  return sortNewestFirst(matches)[0] || null;
}

function findByRef(data, ref, activeOnly = false) {
  if (data.reviews[ref] && (!activeOnly || ACTIVE_REVIEW_STATES.has(data.reviews[ref].status))) {
    return data.reviews[ref];
  }
  const absPath = resolvePathBestEffort(ref);
  return findByPath(data, absPath, activeOnly);
}

async function listReviews(options = {}) {
  const data = readReviewData(options);
  return sortNewestFirst(Object.values(data.reviews).filter(Boolean));
}

async function getReviewById(id, options = {}) {
  return readReviewData(options).reviews[id] || null;
}

async function getReviewByPath(inputPath, options = {}) {
  const absPath = resolvePathBestEffort(inputPath);
  return findByPath(readReviewData(options), absPath, !!options.activeOnly);
}

async function mutateReviews(mutator, options = {}) {
  ensureDataDir(options);
  const reviewsFile = getPaths(options).reviews;
  return mutateJson(reviewsFile, emptyReviews, mutator, {
    mode: 0o600,
    validate: validateReviewData,
    lock: options.lock,
  });
}

async function mutateReviewById(ref, mutator, options = {}) {
  if (!ref) throwNotFound(ref);
  return mutateReviews((data) => {
    const review = data.reviews[ref];
    if (!review) throwNotFound(ref);
    return mutator(review, data);
  }, options);
}

async function openReview(inputPath, options = {}) {
  const absPath = normalizeMdPath(inputPath);
  return withReviewTransaction(absPath, async () => {
    const sourceHash = sha256File(absPath);
    const now = new Date().toISOString();
    const result = await mutateReviews((data) => {
      const active = findByPath(data, absPath, true);
      let recovered = false;
      if (active) {
        const conflicted = active.status === 'conflict' || sourceHash !== active.sourceHash;
        if (!conflicted) {
          active.lastOpenedAt = now;
          return { review: { ...active }, reused: true };
        }
        // 旧一轮的批注仍有 open 时必须保护,维持冲突;全部处理完则没有可保护
        // 的内容,自动结束旧会话并按当前内容开启新一轮(典型场景:Agent 改完
        // 稿但漏跑 begin-apply/complete,重新打开时自愈,无需人工 unlock)。
        if (countOpenAnnotations(absPath) > 0) {
          return { conflict: sourceConflict(active, sourceHash) };
        }
        const previousStatus = active.status;
        active.status = 'complete';
        active.completedAt = now;
        active.finalHash = sourceHash;
        active.autoClosedReason = `批注已全部处理,重新打开时自动结束旧会话(原状态 ${previousStatus})`;
        recovered = true;
      }
      const id = `r${crypto.randomBytes(12).toString('hex')}`;
      const review = {
        id,
        absPath,
        file: path.basename(absPath),
        sourceHash,
        status: 'reviewing',
        createdAt: now,
        lastOpenedAt: now,
      };
      data.reviews[id] = review;
      return { review: { ...review }, reused: false, recovered };
    }, options);
    if (result.conflict) throwConflict(result.conflict);
    return result;
  }, options);
}

function sourceConflict(review, currentHash, reason) {
  const now = new Date().toISOString();
  review.status = 'conflict';
  review.conflictAt = now;
  review.conflictHash = currentHash || null;
  review.conflictReason = reason || '源文档内容已变化';
  return {
    code: 'SOURCE_CONFLICT',
    message: '源文档在审阅期间已发生变化，已停止保存并标记为 conflict。',
    review: { ...review },
  };
}

function currentHashOrNull(absPath) {
  try { return sha256File(absPath); } catch { return null; }
}

function throwStateError(message, review) {
  throw new ReviewStoreError('INVALID_STATE', message, {
    httpStatus: 409, details: { review },
  });
}

function throwNotFound(ref) {
  throw new ReviewStoreError('REVIEW_NOT_FOUND', `找不到审阅会话: ${ref}`, {
    httpStatus: 404, details: { ref },
  });
}

function throwConflict(conflict) {
  throw new ReviewStoreError(conflict.code, conflict.message, {
    httpStatus: 409, details: { review: conflict.review },
  });
}

async function assertReviewUnchanged(ref, options = {}) {
  const result = await mutateReviews((data) => {
    const review = findByRef(data, ref, true);
    if (!review) throwNotFound(ref);
    const currentHash = currentHashOrNull(review.absPath);
    if (!currentHash || currentHash !== review.sourceHash) {
      return { conflict: sourceConflict(review, currentHash) };
    }
    return { review: { ...review } };
  }, options);
  if (result.conflict) throwConflict(result.conflict);
  return result.review;
}

async function markConflict(ref, reason, options = {}) {
  const result = await mutateReviews((data) => {
    const review = findByRef(data, ref, true);
    if (!review) throwNotFound(ref);
    return sourceConflict(review, currentHashOrNull(review.absPath), reason);
  }, options);
  return result.review;
}

async function submitReview(ref, options = {}) {
  const initial = findByRef(readReviewData(options), ref, true);
  if (!initial) throwNotFound(ref);
  return withReviewTransaction(initial.absPath, async () => {
    const result = await mutateReviews((data) => {
      const review = findByRef(data, ref, true);
      if (!review) throwNotFound(ref);
      if (review.status !== 'reviewing') {
        throwStateError(`只有 reviewing 状态可以提交，当前为 ${review.status}。`, review);
      }
      const currentHash = currentHashOrNull(review.absPath);
      if (!currentHash || currentHash !== review.sourceHash) {
        return { conflict: sourceConflict(review, currentHash) };
      }
      const openCount = countOpenAnnotations(review.absPath);
      const now = new Date().toISOString();
      review.submittedAt = now;
      if (openCount === 0) {
        review.status = 'complete';
        review.approved = true;
        review.outcome = 'approved';
        review.approvedAt = now;
        review.completedAt = now;
        review.finalHash = currentHash;
      } else {
        review.status = 'ready_to_apply';
      }
      return { review: { ...review }, openCount };
    }, options);
    if (result.conflict) throwConflict(result.conflict);
    return result;
  }, options);
}

async function beginApply(inputPath, options = {}) {
  const absPath = normalizeMdPath(inputPath);
  const applyMode = options.applyMode === undefined ? 'agent' : String(options.applyMode);
  if (!['agent', 'manual'].includes(applyMode)) {
    throw new ReviewStoreError('INVALID_APPLY_MODE', `改稿模式无效: ${applyMode}`, {
      httpStatus: 400, details: { allowed: ['agent', 'manual'] },
    });
  }
  const defaultActor = applyMode === 'manual' ? 'user' : 'agent';
  const applyActor = options.applyActor === undefined ? defaultActor : String(options.applyActor).trim();
  if (!applyActor || applyActor.length > 80) {
    throw new ReviewStoreError('INVALID_APPLY_ACTOR', 'applyActor 必须是 1-80 字符的非空文本。', {
      httpStatus: 400,
    });
  }
  return withReviewTransaction(absPath, async () => {
    const result = await mutateReviews((data) => {
      const review = findByPath(data, absPath, true);
      if (!review) throwNotFound(absPath);
      if (options.expectedReviewId && review.id !== options.expectedReviewId) {
        throw new ReviewStoreError('REVIEW_SESSION_MISMATCH',
          `当前活动会话为 ${review.id}，不是请求的 ${options.expectedReviewId}。`, {
            httpStatus: 409, details: { expectedReviewId: options.expectedReviewId, review: { ...review } },
          });
      }
      if (review.status !== 'ready_to_apply') {
        throwStateError(`只有 ready_to_apply 状态可以开始改稿，当前为 ${review.status}。`, review);
      }
      const currentHash = currentHashOrNull(review.absPath);
      if (!currentHash || currentHash !== review.sourceHash) {
        return { conflict: sourceConflict(review, currentHash) };
      }
      review.status = 'applying';
      review.applyStartedAt = new Date().toISOString();
      review.applyMode = applyMode;
      review.applyActor = applyActor;
      return { review: { ...review } };
    }, options);
    if (result.conflict) throwConflict(result.conflict);
    return result.review;
  }, options);
}

async function completeReview(inputPath, options = {}) {
  const absPath = normalizeMdPath(inputPath);
  return withReviewTransaction(absPath, () => mutateReviews((data) => {
      const review = findByPath(data, absPath, true);
      if (!review) throwNotFound(absPath);
      if (options.expectedReviewId && review.id !== options.expectedReviewId) {
        throw new ReviewStoreError('REVIEW_SESSION_MISMATCH',
          `当前活动会话为 ${review.id}，不是请求的 ${options.expectedReviewId}。`, {
            httpStatus: 409, details: { expectedReviewId: options.expectedReviewId, review: { ...review } },
          });
      }
      if (review.status !== 'applying') {
        throwStateError(`只有 applying 状态可以完成改稿，当前为 ${review.status}。`, review);
      }
      if (options.expectedApplyMode && review.applyMode !== options.expectedApplyMode) {
        throwStateError(
          `只有 ${options.expectedApplyMode} 改稿模式可以从此入口完成，当前为 ${review.applyMode || 'unknown'}。`,
          review,
        );
      }
      const openCount = countOpenAnnotations(review.absPath);
      if (openCount > 0) {
        throw new ReviewStoreError('OPEN_ANNOTATIONS', `仍有 ${openCount} 条 open 批注，不能完成审阅。`, {
          httpStatus: 409, details: { review: { ...review }, openCount },
        });
      }
      review.status = 'complete';
      review.completedAt = new Date().toISOString();
      review.finalHash = sha256File(review.absPath);
      return { ...review };
    }, options), options);
}

async function unlockReview(inputPath, reason, options = {}) {
  if (!reason || !String(reason).trim()) {
    throw new ReviewStoreError('REASON_REQUIRED', '人工解锁必须提供 --reason。', { httpStatus: 400 });
  }
  const absPath = resolvePathBestEffort(inputPath);
  return withReviewTransaction(absPath, () => mutateReviews((data) => {
      const review = findByPath(data, absPath, true);
      if (!review) throwNotFound(absPath);
      review.status = 'cancelled';
      review.cancelledAt = new Date().toISOString();
      review.cancelReason = String(reason).trim();
      return { ...review };
    }, options), options);
}

function readPort(options = {}) {
  const portFile = getPaths(options).port;
  let raw;
  try { raw = fs.readFileSync(portFile, 'utf8').trim(); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

async function writePort(port, options = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ReviewStoreError('INVALID_PORT', `端口无效: ${port}`, { httpStatus: 400 });
  }
  ensureDataDir(options);
  const portFile = getPaths(options).port;
  return withFileLock(portFile, () => atomicWriteFile(portFile, `${port}\n`, { mode: 0o600 }));
}

module.exports = {
  APPLY_HINT,
  ACTIVE_REVIEW_STATES,
  TERMINAL_REVIEW_STATES,
  ReviewStoreError,
  getDataDir,
  getPaths,
  ensureDataDir,
  readJsonStrict,
  atomicWriteFile,
  atomicWriteJson,
  withFileLock,
  withReviewTransaction,
  mutateJson,
  sha256File,
  normalizeMdPath,
  resolvePathBestEffort,
  sidecarFor,
  annotationStatus,
  readAnnotations,
  mutateAnnotations,
  countOpenAnnotations,
  listReviews,
  getReviewById,
  getReviewByPath,
  mutateReviewById,
  openReview,
  submitReview,
  beginApply,
  completeReview,
  unlockReview,
  assertReviewUnchanged,
  markConflict,
  readPort,
  writePort,
};
