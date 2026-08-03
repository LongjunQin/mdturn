#!/usr/bin/env node
'use strict';
/*
 * md-read —— 本机冻结审阅 + 公网单文档分享服务。
 *
 * 本机审阅: /r/<reviewId>（只允许 loopback 且拒绝 Cloudflare 请求）
 * 公网分享: /d/<linkId>?k=<token>
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/review-store');
const documents = require('./lib/document-service');
const { createReviewEventHub } = require('./lib/review-events');

function parsePort(value, fallback = null, options = {}) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d{1,5}$/.test(text)) return fallback;
  const port = Number(text);
  const minimum = options.allowZero ? 0 : 1;
  return Number.isInteger(port) && port >= minimum && port <= 65535 ? port : fallback;
}
const PORT_BASE = parsePort(process.env.MDREAD_PORT === undefined ? '8080' : process.env.MDREAD_PORT, null, { allowZero: true });
if (PORT_BASE === null) {
  console.error(`启动失败: MDREAD_PORT 无效: ${process.env.MDREAD_PORT}`);
  process.exit(1);
}
const HOST = process.env.MDREAD_HOST || '127.0.0.1';
const STATIC_DIR = path.join(__dirname, 'static');
const PATHS = store.getPaths();
const REG_FILE = PATHS.registry;
const EVENT_HEARTBEAT_MS = (() => {
  const value = Number(process.env.MDREAD_EVENT_HEARTBEAT_MS);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
})();
const reviewEvents = createReviewEventHub({ heartbeatMs: EVENT_HEARTBEAT_MS });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function safeJoin(base, rel) {
  try { rel = decodeURIComponent(rel || ''); } catch { return null; }
  rel = rel.replace(/^[\\/]+/, '');
  const target = path.resolve(base, rel);
  const r = path.relative(base, target);
  if (r !== '' && (r.startsWith('..') || path.isAbsolute(r))) return null;
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    const realRelative = path.relative(realBase, realTarget);
    if (realRelative !== '' && (realRelative.startsWith('..') || path.isAbsolute(realRelative))) return null;
    return realTarget;
  } catch {
    // 不存在的目标交给 sendFile 返回 404；已存在的 symlink 一定会在上面的 realpath 检查中被拦截。
    return target;
  }
}

function loadReg() {
  const data = store.readJsonStrict(REG_FILE, { links: {} });
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !data.links || typeof data.links !== 'object' || Array.isArray(data.links)) {
    throw new store.ReviewStoreError('INVALID_REGISTRY', `分享注册表结构无效: ${REG_FILE}`, {
      details: { filePath: REG_FILE },
    });
  }
  return data;
}
function resolveLinkById(id, k) {
  if (!id) return { error: 'noid' };
  const link = loadReg().links[id];
  if (!link || typeof link !== 'object' || typeof link.absPath !== 'string' || typeof link.token !== 'string') {
    return { error: 'notfound' };
  }
  if (link.token !== k) return { error: 'badkey' };
  if (link.expiresAt) {
    const expiry = Date.parse(link.expiresAt);
    if (!Number.isFinite(expiry) || expiry < Date.now()) return { error: 'expired' };
  }
  return { link, id };
}
const resolveLink = (q) => resolveLinkById(q.get('d'), q.get('k'));

function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
const sendJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
function sendFile(res, abs, cacheControl = 'no-store') {
  fs.readFile(abs, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': mimeOf(abs), 'Cache-Control': cacheControl });
    res.end(buf);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; reject(error); } };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) { tooLarge = true; return; }
      body += chunk;
    });
    req.on('error', fail);
    req.on('end', () => {
      if (settled) return;
      if (tooLarge) {
        return fail(new store.ReviewStoreError('BODY_TOO_LARGE', '请求体不能超过 2 MB。', { httpStatus: 413 }));
      }
      try {
        const parsed = JSON.parse(body || '{}');
        settled = true;
        resolve(parsed);
      } catch {
        fail(new store.ReviewStoreError('MALFORMED_BODY', '请求体不是有效 JSON。', { httpStatus: 400 }));
      }
    });
  });
}
const PAGE = (msg) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>md-read</title>
<body style="font-family:-apple-system,system-ui,sans-serif;display:flex;min-height:100vh;margin:0;
align-items:center;justify-content:center;color:#444;text-align:center;padding:24px"><div>${msg}</div></body>`;

function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
function hasCloudflareHeaders(req) {
  return !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['cf-visitor']);
}
function isLocalOnlyRequest(req) {
  return isLoopback(req) && !hasCloudflareHeaders(req);
}
function localOnly(req, res) {
  if (isLocalOnlyRequest(req)) return true;
  sendJson(res, 404, { error: 'not_found', message: 'Not found' });
  return false;
}
function localAppOriginOnly(req, res) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    sendJson(res, 404, { error: 'not_found', message: 'Not found' });
    return false;
  }
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') {
      return true;
    }
  } catch {}
  sendJson(res, 404, { error: 'not_found', message: 'Not found' });
  return false;
}
function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
  return false;
}

function errorName(error) {
  if (error && error.code === 'SOURCE_CONFLICT') return 'source_changed';
  if (error && error.code === 'REVIEW_READ_ONLY') return 'review_read_only';
  return String((error && error.code) || 'internal_error').toLowerCase();
}
function sendError(res, error, options = {}) {
  const status = Number.isInteger(error && error.httpStatus) ? error.httpStatus : 500;
  let publicMessage = '请求处理失败，请联系分享者。';
  if (error && error.code === 'SOURCE_CONFLICT') publicMessage = '源文档已变化，当前批注对应旧版本，已停止写入。';
  else if (error && error.code === 'REVIEW_READ_ONLY') publicMessage = '本轮审阅已提交，现在不能再修改批注。';
  else if (status === 400 || status === 413) publicMessage = '请求内容无效或过大。';
  else if (status === 404) publicMessage = '分享文档不存在或已移动，请重新生成链接。';
  else if (status >= 500) publicMessage = '服务器暂时无法处理该请求，请联系分享者检查 md-read。';
  const payload = {
    error: errorName(error),
    message: options.publicResponse ? publicMessage : ((error && error.message) || '服务器内部错误。'),
  };
  if (!options.publicResponse && error && error.details !== undefined) payload.details = error.details;
  return sendJson(res, status, payload);
}
function reviewReadOnly(review) {
  return new store.ReviewStoreError('REVIEW_READ_ONLY',
    `审阅会话当前为 ${review ? review.status : 'unknown'}，只有 reviewing 状态可以修改批注。`, {
      httpStatus: 423, details: review ? { review } : undefined,
    });
}
function annotationCounts(data) {
  return data.annotations.reduce((counts, annotation) => {
    const status = annotation.status || 'open';
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}
async function reviewSummary(review) {
  const data = store.readAnnotations(review.absPath);
  return {
    ...review,
    sessionId: review.id,
    sourceFile: review.absPath,
    title: path.basename(review.absPath),
    directory: path.dirname(review.absPath),
    counts: annotationCounts(data),
    openCount: data.annotations.filter((annotation) => store.annotationStatus(annotation) === 'open').length,
  };
}

function normalizedEventReason(value, fallback = 'review-changed') {
  const reason = typeof value === 'string' ? value.trim() : '';
  return (reason || fallback).slice(0, 120);
}

function reviewEventPayload(review, reason) {
  return {
    reviewSessionId: review.id,
    reason: normalizedEventReason(reason),
    at: new Date().toISOString(),
    status: review.status,
    sourceFile: review.absPath,
    applyMode: review.applyMode || null,
    sourceRevision: Number(review.sourceRevision || 0),
    workingHash: review.workingHash || review.sourceHash || null,
    finalHash: review.finalHash || null,
    completedAt: review.completedAt || null,
  };
}

async function publishReviewChanged(reviewSessionId, reason) {
  // External notifiers are hints only.  Never trust their claimed status or
  // hashes: reread the persisted review before constructing the event.
  const review = await store.getReviewById(reviewSessionId);
  if (!review) {
    throw new store.ReviewStoreError('REVIEW_NOT_FOUND', `找不到审阅会话: ${reviewSessionId || ''}`, {
      httpStatus: 404, details: { ref: reviewSessionId || null },
    });
  }
  const event = reviewEventPayload(review, reason);
  const delivered = reviewEvents.broadcast('review-changed', event);
  return { review, event, delivered };
}

async function publishReviewChangedSafe(reviewSessionId, reason) {
  try {
    return await publishReviewChanged(reviewSessionId, reason);
  } catch (error) {
    console.error(`审阅状态已更新，但主动通知失败: ${error.message || error}`);
    return null;
  }
}
function publicAnnotations(data) {
  return {
    version: data.version || 1,
    file: data.file,
    annotations: data.annotations,
  };
}
async function requireReview(ref) {
  const review = ref ? await store.getReviewById(ref) : null;
  if (!review) {
    throw new store.ReviewStoreError('REVIEW_NOT_FOUND', `找不到审阅会话: ${ref || ''}`, { httpStatus: 404 });
  }
  return review;
}
async function requireWritableReview(ref) {
  let review = await requireReview(ref);
  if (review.status !== 'reviewing') throw reviewReadOnly(review);
  review = await store.assertReviewUnchanged(review.id);
  if (review.status !== 'reviewing') throw reviewReadOnly(review);
  return review;
}
async function mutateReviewAnnotations(review, mutator) {
  try {
    return await store.mutateAnnotations(review.absPath, (data) => {
      if (store.sha256File(review.absPath) !== review.sourceHash) {
        throw new store.ReviewStoreError('SOURCE_CONFLICT',
          '源文档在审阅期间已发生变化，已停止保存。', { httpStatus: 409 });
      }
      return mutator(data);
    });
  } catch (error) {
    if (error && error.code === 'SOURCE_CONFLICT') {
      await store.markConflict(review.id, '保存批注时检测到源文档变化').catch(() => {});
      await publishReviewChangedSafe(review.id, 'review-conflict');
    }
    throw error;
  }
}
function newNoteId() { return 'n' + crypto.randomBytes(6).toString('hex'); }
const NOTE_FIELDS = [
  'comment', 'quote', 'prefix', 'suffix', 'headingPath', 'lineStart', 'lineEnd',
  'startTextOffset', 'endTextOffset', 'figureRef', 'clientRequestId', 'anchorVersion',
];
function buildNote(input, author, extra = {}) {
  const note = {};
  for (const field of NOTE_FIELDS) {
    if (input[field] === undefined || (field !== 'comment' && input[field] === null)) continue;
    if (field === 'headingPath') {
      if (Array.isArray(input.headingPath)) {
        note.headingPath = input.headingPath
          .filter((item) => item !== null && item !== undefined)
          .slice(0, 12)
          .map((item) => String(item).slice(0, 200));
      }
    } else if (field === 'lineStart' || field === 'lineEnd' || field === 'startTextOffset' ||
        field === 'endTextOffset' || field === 'anchorVersion') {
      const value = Number(input[field]);
      note[field] = Number.isFinite(value) ? value : null;
    } else {
      const limits = { comment: 20000, quote: 20000, prefix: 500, suffix: 500, figureRef: 200, clientRequestId: 120 };
      note[field] = String(input[field]).slice(0, limits[field] || 1000);
    }
  }
  return {
    ...note,
    id: newNoteId(),
    createdAt: new Date().toISOString(),
    author: String(author || '匿名').slice(0, 40),
    status: 'open',
    ...extra,
  };
}
function hasOwn(object, key) {
  return !!object && typeof object === 'object' && !Array.isArray(object) &&
    Object.prototype.hasOwnProperty.call(object, key);
}
function editedComment(body) {
  if (!hasOwn(body, 'comment') || typeof body.comment !== 'string' || !body.comment.trim()) return null;
  return body.comment.trim().slice(0, 20000);
}
function applyCommentEdit(annotation, comment, actor) {
  annotation.comment = comment;
  annotation.updatedAt = new Date().toISOString();
  annotation.updatedBy = String(actor || '审阅者').slice(0, 80);
  const previousCount = Number(annotation.editCount);
  annotation.editCount = Number.isInteger(previousCount) && previousCount >= 0 ? previousCount + 1 : 1;
  return annotation;
}
function applyManualStatus(annotation, status, actor) {
  annotation.status = status;
  if (status === 'open') {
    delete annotation.appliedAt; delete annotation.appliedBy; delete annotation.appliedNote;
    return;
  }
  annotation.appliedAt = new Date().toISOString();
  annotation.appliedBy = String(actor || '审阅者').slice(0, 80);
  annotation.appliedNote = status === 'wontfix' ? '由审阅者在网页手动标记为不改。' : '由审阅者在网页手动标记为已处理。';
}
async function sharedWriteContext(absMd) {
  const active = await store.getReviewByPath(absMd, { activeOnly: true });
  if (!active) return { review: null, mutate: (mutator) => store.mutateAnnotations(absMd, mutator) };
  const writable = await requireWritableReview(active.id);
  return { review: writable, mutate: (mutator) => mutateReviewAnnotations(writable, mutator) };
}
async function handleReviewAnnotations(req, res, q, review) {
  const absMd = review.absPath;
  if (req.method === 'GET') return sendJson(res, 200, store.readAnnotations(absMd));

  if (req.method === 'POST') {
    const note = await readBody(req);
    if (!note || typeof note !== 'object' || !String(note.comment || '').trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '批注内容不能为空。' });
    }
    const requestId = note.clientRequestId ? String(note.clientRequestId).slice(0, 120) : null;
    const result = await store.withReviewTransaction(absMd, async () => {
      const writable = await requireWritableReview(review.id);
      return mutateReviewAnnotations(writable, (data) => {
        if (requestId) {
          const existing = data.annotations.find((item) =>
            item.reviewSessionId === writable.id && item.clientRequestId === requestId);
          if (existing) return { note: existing, reused: true };
        }
        const created = buildNote(note, note.author || '我(本机)', {
          reviewSessionId: writable.id,
          sourceHash: writable.sourceHash,
        });
        if (!requestId) delete created.clientRequestId;
        data.annotations.push(created);
        return { note: created, reused: false };
      });
    });
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (req.method === 'PATCH') {
    const id = q.get('id');
    const body = await readBody(req);
    const isCommentEdit = hasOwn(body, 'comment');
    const comment = isCommentEdit ? editedComment(body) : null;
    // 审阅人只能把自己误操作改回 open；applied/wontfix 由 Agent 写 sidecar。
    if (!id || !body || typeof body !== 'object' || Array.isArray(body) ||
        (isCommentEdit ? !comment || hasOwn(body, 'status') : body.status !== 'open')) {
      const message = isCommentEdit ? '批注内容不能为空，且不能同时修改状态。' : '本地审阅页不能把批注标为已处理。';
      return sendJson(res, 400, { error: 'bad_request', message });
    }
    let found = false;
    let immutable = false;
    let updatedNote = null;
    await store.withReviewTransaction(absMd, async () => {
      const writable = await requireWritableReview(review.id);
      await mutateReviewAnnotations(writable, (data) => {
        const annotation = data.annotations.find((item) => item.id === id);
        if (annotation) {
          found = true;
          if (isCommentEdit) {
            if (annotation.status !== 'open') { immutable = true; return; }
            updatedNote = applyCommentEdit(annotation, comment, '我(本机)');
          } else {
            annotation.status = 'open';
            delete annotation.appliedAt;
            delete annotation.appliedBy;
            delete annotation.appliedNote;
          }
        }
      });
    });
    if (immutable) return sendJson(res, 409, { error: 'annotation_read_only', message: '已处理批注不能编辑。' });
    if (!found) return sendJson(res, 404, { error: 'annotation_not_found', message: '找不到批注。' });
    return sendJson(res, 200, isCommentEdit ? { ok: true, note: updatedNote } : { ok: true });
  }
  if (req.method === 'DELETE') {
    const id = q.get('id');
    if (!id) return sendJson(res, 400, { error: 'bad_request', message: '缺少批注 id。' });
    let found = false;
    let immutable = false;
    await store.withReviewTransaction(absMd, async () => {
      const writable = await requireWritableReview(review.id);
      await mutateReviewAnnotations(writable, (data) => {
        const annotation = data.annotations.find((item) => item.id === id);
        if (!annotation) return;
        if (annotation.status !== 'open') { immutable = true; return; }
        data.annotations = data.annotations.filter((item) => item.id !== id);
        found = true;
      });
    });
    if (immutable) return sendJson(res, 409, { error: 'annotation_read_only', message: '已处理批注不能由审阅页删除。' });
    if (!found) return sendJson(res, 404, { error: 'annotation_not_found', message: '找不到批注。' });
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
}

async function handleLocalReviewApi(req, res, pathname, q) {
  if (pathname === '/api/health') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, { ok: true, service: 'md-read', port: activePort });
  }
  if (pathname === '/api/reviews') {
    if (!allowMethods(req, res, ['GET'])) return;
    const reviews = await store.listReviews();
    const summaries = [];
    const seenPaths = new Set();
    for (const review of reviews) {
      if (seenPaths.has(review.absPath)) continue;
      seenPaths.add(review.absPath);
      try {
        summaries.push(await reviewSummary(review));
      } catch (error) {
        summaries.push({
          ...review,
          sessionId: review.id,
          sourceFile: review.absPath,
          title: path.basename(review.absPath),
          directory: path.dirname(review.absPath),
          counts: {},
          openCount: null,
          summaryError: {
            code: String(error.code || 'ANNOTATIONS_READ_FAILED').toLowerCase(),
            message: error.message || '批注数据读取失败。',
          },
        });
      }
    }
    return sendJson(res, 200, { reviews: summaries });
  }

  const ref = q.get('r');
  const review = await requireReview(ref);
  if (pathname === '/api/review') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, { review: await reviewSummary(review) });
  }
  if (pathname === '/api/review/submit') {
    if (!allowMethods(req, res, ['POST'])) return;
    let result;
    try {
      result = await store.submitReview(review.id);
    } catch (error) {
      if (error && error.code === 'SOURCE_CONFLICT') await publishReviewChangedSafe(review.id, 'review-conflict');
      throw error;
    }
    await publishReviewChangedSafe(result.review.id,
      result.review.status === 'complete' ? 'review-approved' : 'review-submitted');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(result.review) });
  }
  if (pathname === '/api/meta') {
    if (!allowMethods(req, res, ['GET'])) return;
    const summary = await reviewSummary(review);
    return sendJson(res, 200, { title: summary.title, viewer: '我(本机)', counts: summary.counts, review: summary });
  }
  if (pathname === '/api/raw') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendFile(res, review.absPath, 'private, no-store');
  }
  if (pathname === '/api/file') {
    if (!allowMethods(req, res, ['GET'])) return;
    const abs = safeJoin(path.dirname(review.absPath), q.get('path'));
    return abs ? sendFile(res, abs, 'private, no-store') : send(res, 403, 'Forbidden');
  }
  if (pathname === '/api/annotations') return handleReviewAnnotations(req, res, q, review);
  return sendJson(res, 404, { error: 'not_found', message: 'Not found' });
}

async function handleAppApi(req, res, pathname, q) {
  if (pathname === '/api/app/events') {
    if (!allowMethods(req, res, ['GET'])) return;
    reviewEvents.subscribe(req, res);
    return;
  }
  if (pathname === '/api/app/review/notify') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        typeof body.reviewSessionId !== 'string' || !body.reviewSessionId.trim() ||
        typeof body.reason !== 'string' || !body.reason.trim()) {
      return sendJson(res, 400, {
        error: 'bad_request', message: 'reviewSessionId 和 reason 必须是非空字符串。',
      });
    }
    const published = await publishReviewChanged(
      body.reviewSessionId.trim().slice(0, 200),
      body.reason,
    );
    return sendJson(res, 200, {
      ok: true,
      delivered: published.delivered,
      event: published.event,
    });
  }
  if (pathname === '/api/app/open') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.path !== 'string' || !body.path.trim()) {
      return sendJson(res, 400, { error: 'bad_request', message: '请提供 Markdown 文档路径。' });
    }
    const opened = await store.openReview(body.path);
    await publishReviewChangedSafe(opened.review.id, opened.reused ? 'review-reopened' : 'review-opened');
    return sendJson(res, 200, {
      ok: true,
      reused: opened.reused,
      review: await reviewSummary(opened.review),
    });
  }

  const ref = q.get('r');
  if (!ref) return sendJson(res, 400, { error: 'bad_request', message: '缺少审阅会话 r。' });

  if (pathname === '/api/app/bundle') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendJson(res, 200, await documents.readBundle(ref));
  }
  if (pathname === '/api/app/file') {
    if (!allowMethods(req, res, ['GET'])) return;
    const review = await documents.requireReview(ref);
    let candidate = String(q.get('path') || '');
    try { candidate = decodeURIComponent(candidate); } catch {}
    const abs = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(path.dirname(review.absPath), candidate);
    return sendFile(res, abs, 'private, no-store');
  }
  if (pathname === '/api/app/review/begin-apply') {
    if (!allowMethods(req, res, ['POST'])) return;
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.mode !== 'manual') {
      return sendJson(res, 400, { error: 'bad_request', message: 'mode 必须是 manual。' });
    }
    const existing = await documents.requireReview(ref);
    let review;
    try {
      review = await store.beginApply(existing.absPath, {
        applyMode: 'manual',
        applyActor: '我(本机)',
        expectedReviewId: ref,
      });
    } catch (error) {
      if (error && error.code === 'SOURCE_CONFLICT') await publishReviewChangedSafe(ref, 'review-conflict');
      throw error;
    }
    await publishReviewChangedSafe(review.id, 'manual-apply-started');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(review) });
  }
  if (pathname === '/api/app/source') {
    if (!allowMethods(req, res, ['PUT'])) return;
    const body = await readBody(req);
    const result = await documents.writeSource(ref, body);
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (pathname === '/api/app/annotation') {
    if (!allowMethods(req, res, ['PATCH'])) return;
    const body = await readBody(req);
    const result = await documents.patchAnnotation(ref, q.get('id'), body);
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (pathname === '/api/app/review/complete') {
    if (!allowMethods(req, res, ['POST'])) return;
    const existing = await documents.requireReview(ref);
    const review = await store.completeReview(existing.absPath, {
      expectedApplyMode: 'manual',
      expectedReviewId: ref,
    });
    await publishReviewChangedSafe(review.id, 'manual-complete');
    return sendJson(res, 200, { ok: true, review: await reviewSummary(review) });
  }
  return sendJson(res, 404, { error: 'not_found', message: 'Not found' });
}

async function handleSharedApi(req, res, pathname, q) {
  const resolved = resolveLink(q);
  if (resolved.error) return sendJson(res, 401, { error: resolved.error, message: '分享链接无效或已过期。' });
  const absMd = store.normalizeMdPath(resolved.link.absPath);
  const baseDir = path.dirname(absMd);

  if (pathname === '/api/meta') {
    if (!allowMethods(req, res, ['GET'])) return;
    const data = store.readAnnotations(absMd);
    return sendJson(res, 200, { title: path.basename(absMd), viewer: resolved.link.name || '', counts: annotationCounts(data) });
  }
  if (pathname === '/api/raw') {
    if (!allowMethods(req, res, ['GET'])) return;
    return sendFile(res, absMd, 'private, no-store');
  }
  if (pathname === '/api/file') {
    if (!allowMethods(req, res, ['GET'])) return;
    const abs = safeJoin(baseDir, q.get('path'));
    return abs ? sendFile(res, abs, 'private, no-store') : send(res, 403, 'Forbidden');
  }
  if (pathname === '/api/annotations') {
    if (req.method === 'GET') return sendJson(res, 200, publicAnnotations(store.readAnnotations(absMd)));
    if (req.method === 'POST') {
      const note = await readBody(req);
      if (!note || typeof note !== 'object' || !String(note.comment || '').trim()) return sendJson(res, 400, { error: 'bad_request', message: '批注内容不能为空。' });
      const requestId = note.clientRequestId ? String(note.clientRequestId).slice(0, 120) : null;
      const result = await store.withReviewTransaction(absMd, async () => {
        const context = await sharedWriteContext(absMd);
        return context.mutate((data) => {
          if (requestId) {
            const existing = data.annotations.find((item) => item.clientRequestId === requestId);
            if (existing) return { note: existing, reused: true };
          }
          const created = buildNote(note, resolved.link.name || note.author || '匿名', context.review ? {
            reviewSessionId: context.review.id,
            sourceHash: context.review.sourceHash,
          } : {});
          if (!requestId) delete created.clientRequestId;
          data.annotations.push(created);
          return { note: created, reused: false };
        });
      });
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'PATCH') {
      const id = q.get('id');
      const body = await readBody(req);
      const isCommentEdit = hasOwn(body, 'comment');
      const comment = isCommentEdit ? editedComment(body) : null;
      const allowed = ['open', 'applied', 'wontfix'];
      if (!id || !body || typeof body !== 'object' || Array.isArray(body) ||
          (isCommentEdit ? !comment || hasOwn(body, 'status') : !allowed.includes(body.status))) {
        const message = isCommentEdit ? '批注内容不能为空，且不能同时修改状态。' : '缺少批注 id 或状态无效。';
        return sendJson(res, 400, { error: 'bad_request', message });
      }
      let found = false;
      let immutable = false;
      let updatedNote = null;
      await store.withReviewTransaction(absMd, async () => {
        const context = await sharedWriteContext(absMd);
        await context.mutate((data) => {
          const annotation = data.annotations.find((item) => item.id === id);
          if (annotation) {
            found = true;
            if (isCommentEdit) {
              if (annotation.status !== 'open') { immutable = true; return; }
              updatedNote = applyCommentEdit(annotation, comment, resolved.link.name || '远程审阅者');
            } else {
              applyManualStatus(annotation, body.status, resolved.link.name || '远程审阅者');
            }
          }
        });
      });
      if (immutable) return sendJson(res, 409, { error: 'annotation_read_only', message: '已处理批注不能编辑。' });
      if (!found) return sendJson(res, 404, { error: 'annotation_not_found', message: '找不到批注。' });
      return sendJson(res, 200, isCommentEdit ? { ok: true, note: updatedNote } : { ok: true });
    }
    if (req.method === 'DELETE') {
      const id = q.get('id');
      if (!id) return sendJson(res, 400, { error: 'bad_request', message: '缺少批注 id。' });
      let found = false;
      await store.withReviewTransaction(absMd, async () => {
        const context = await sharedWriteContext(absMd);
        await context.mutate((data) => {
          const before = data.annotations.length;
          data.annotations = data.annotations.filter((annotation) => annotation.id !== id);
          found = data.annotations.length !== before;
        });
      });
      if (!found) return sendJson(res, 404, { error: 'annotation_not_found', message: '找不到批注。' });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' });
  }
  return sendJson(res, 404, { error: 'not_found', message: 'Not found' });
}

async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch {
    throw new store.ReviewStoreError('MALFORMED_URL', '请求 URL 编码无效。', { httpStatus: 400 });
  }
  const q = u.searchParams;

  if (pathname.startsWith('/static/')) {
    if (!allowMethods(req, res, ['GET'])) return;
    const abs = safeJoin(STATIC_DIR, pathname.slice('/static/'.length));
    const cache = abs && abs.includes(`${path.sep}vendor${path.sep}`)
      ? 'public, max-age=86400, immutable'
      : 'no-store';
    return abs ? sendFile(res, abs, cache) : send(res, 403, 'Forbidden');
  }

  if (pathname.startsWith('/d/')) {
    if (!allowMethods(req, res, ['GET'])) return;
    const resolved = resolveLinkById(pathname.slice(3).split('/')[0], q.get('k'));
    if (resolved.error) return send(res, 401, PAGE(
      resolved.error === 'expired' ? '⌛ 这条链接已过期，请向分享者重新索取。' : '🔒 链接无效或缺少密钥。'),
    { 'Content-Type': 'text/html; charset=utf-8' });
    return sendFile(res, path.join(STATIC_DIR, 'app.html'), 'no-store');
  }
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/app/') && q.get('d')) {
    return handleSharedApi(req, res, pathname, q);
  }

  const reviewPage = pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
  const localPage = pathname === '/desktop' || pathname === '/desktop/' || reviewPage;
  const reviewApi = pathname === '/api/health' || pathname === '/api/reviews' ||
    pathname === '/api/review' || pathname === '/api/review/submit' ||
    pathname.startsWith('/api/app/') || !!q.get('r');
  if (localPage || reviewApi) {
    if (!localOnly(req, res)) return;
    if (localPage && !allowMethods(req, res, ['GET'])) return;
    if (pathname === '/desktop' || pathname === '/desktop/') return sendFile(res, path.join(STATIC_DIR, 'desktop.html'), 'no-store');
    if (reviewPage) {
      await requireReview(reviewPage[1]);
      return sendFile(res, path.join(STATIC_DIR, 'app.html'), 'no-store');
    }
    if (pathname.startsWith('/api/app/')) {
      if (!localAppOriginOnly(req, res)) return;
      return handleAppApi(req, res, pathname, q);
    }
    return handleLocalReviewApi(req, res, pathname, q);
  }

  return send(res, 404, 'Not found');
}

let activePort = null;
let ownedPortInode = null;
function banner(port) {
  const line = '─'.repeat(54);
  console.log(`\n${line}\n  📖  md-read 已启动  ${HOST}:${port}\n${line}`);
  console.log(`  MDTurn: http://localhost:${port}/desktop`);
  console.log('  对外分享: 由 mdshare 生成 /d/<id>?k=<token> 链接');
  console.log('  停止: Ctrl + C\n');
}
async function publishPort(port) {
  activePort = port;
  try {
    await store.writePort(port);
    try { ownedPortInode = fs.statSync(PATHS.port).ino; } catch { ownedPortInode = null; }
  } catch (error) {
    activePort = null;
    ownedPortInode = null;
    throw error;
  }
}
function cleanupOwnedPort() {
  if (activePort === null || ownedPortInode === null) return;
  try {
    const stat = fs.statSync(PATHS.port);
    const contents = fs.readFileSync(PATHS.port, 'utf8').trim();
    if (stat.ino === ownedPortInode && contents === String(activePort)) fs.unlinkSync(PATHS.port);
  } catch {}
  activePort = null;
  ownedPortInode = null;
}
function cleanupProcessState() {
  reviewEvents.close();
  cleanupOwnedPort();
}
process.once('exit', cleanupProcessState);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { cleanupProcessState(); process.exit(0); });
}

(function start(port, tries) {
  store.ensureDataDir();
  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!Number.isInteger(error && error.httpStatus) || error.httpStatus >= 500) console.error(error);
      let publicResponse = false;
      try { publicResponse = new URL(req.url, 'http://localhost').searchParams.has('d'); } catch {}
      if (!res.headersSent) sendError(res, error, { publicResponse });
      else res.destroy();
    });
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && tries > 0) return start(port + 1, tries - 1);
    console.error('启动失败:', error.message);
    process.exit(1);
  });
  server.listen(port, HOST, async () => {
    try {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      await publishPort(actualPort);
      banner(actualPort);
    } catch (error) {
      console.error('写入端口文件失败:', error.message);
      server.close(() => process.exit(1));
    }
  });
})(PORT_BASE, 10);
