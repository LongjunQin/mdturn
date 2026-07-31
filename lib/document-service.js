#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./review-store');

const SOURCE_WRITE_STATES = new Set(['complete', 'cancelled']);
const SOURCE_STATUSES = new Set(['open', 'applied', 'wontfix']);

function fail(code, message, httpStatus = 400, details) {
  throw new store.ReviewStoreError(code, message, { httpStatus, details });
}

async function requireReview(ref, options = {}) {
  const review = ref ? await store.getReviewById(ref, options) : null;
  if (!review) fail('REVIEW_NOT_FOUND', `找不到审阅会话: ${ref || ''}`, 404, { ref });
  return review;
}

function sourceBuffer(content) {
  return Buffer.from(content, 'utf8');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readSource(absPath) {
  try {
    const buffer = fs.readFileSync(absPath);
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) fail('INVALID_DOCUMENT', `路径不是文件: ${absPath}`, 400);
    return {
      buffer,
      content: buffer.toString('utf8'),
      hash: sha256Buffer(buffer),
      mode: stat.mode & 0o777,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch (error) {
    if (error instanceof store.ReviewStoreError) throw error;
    fail('SOURCE_READ_FAILED', `无法读取源文档: ${absPath}`, error.code === 'ENOENT' ? 404 : 500, {
      absPath,
    });
  }
}

function annotationCounts(annotations) {
  return annotations.reduce((counts, annotation) => {
    const status = store.annotationStatus(annotation);
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function validateWritePayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_SOURCE_WRITE', '保存源文档的请求体必须是 JSON 对象。');
  }
  if (typeof input.content !== 'string') fail('INVALID_SOURCE_CONTENT', 'content 必须是文本。');
  const expectedHash = String(input.expectedHash || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
    fail('INVALID_EXPECTED_HASH', 'expectedHash 必须是 64 位 SHA-256。');
  }
  if (typeof input.clientRequestId !== 'string') {
    fail('CLIENT_REQUEST_ID_REQUIRED', '保存源文档必须提供 clientRequestId。');
  }
  const clientRequestId = input.clientRequestId.trim();
  if (!clientRequestId || clientRequestId.length > 120) {
    fail('INVALID_CLIENT_REQUEST_ID', 'clientRequestId 必须是 1-120 字符的非空文本。');
  }
  const buffer = sourceBuffer(input.content);
  return {
    content: input.content,
    buffer,
    expectedHash,
    clientRequestId,
    contentHash: sha256Buffer(buffer),
  };
}

function validateSourceWriteLog(review) {
  if (review.sourceWriteRequests === undefined) return {};
  if (!review.sourceWriteRequests || typeof review.sourceWriteRequests !== 'object' ||
      Array.isArray(review.sourceWriteRequests)) {
    fail('INVALID_SOURCE_WRITE_LOG', '源文档幂等写入记录已损坏，已停止写入。', 500, { reviewId: review.id });
  }
  for (const [requestId, entry] of Object.entries(review.sourceWriteRequests)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('INVALID_SOURCE_WRITE_LOG', '源文档幂等写入记录已损坏，已停止写入。', 500, {
        reviewId: review.id, requestId,
      });
    }
  }
  return review.sourceWriteRequests;
}

function ownRequest(requests, requestId) {
  return Object.prototype.hasOwnProperty.call(requests, requestId) ? requests[requestId] : null;
}

function setRequest(requests, requestId, entry) {
  // defineProperty 使 __proto__ 等合法字符串也只成为普通数据键，不能改变对象原型。
  Object.defineProperty(requests, requestId, {
    value: entry, enumerable: true, configurable: true, writable: true,
  });
}

function assertWriteState(review, data) {
  const samePathActive = Object.values(data.reviews).filter((candidate) =>
    candidate && candidate.absPath === review.absPath && store.ACTIVE_REVIEW_STATES.has(candidate.status));
  if (review.status === 'applying' && review.applyMode === 'manual') {
    if (samePathActive.some((candidate) => candidate.id !== review.id)) {
      fail('MULTIPLE_ACTIVE_REVIEWS', '同一文档存在其他活动审阅，已停止写入。', 409, {
        reviewId: review.id,
      });
    }
    return;
  }
  if (SOURCE_WRITE_STATES.has(review.status)) {
    if (samePathActive.length > 0) {
      fail('ACTIVE_REVIEW_EXISTS', '文档已有活动审阅，终态会话不能写入源文档。', 423, {
        reviewId: review.id, activeReviewIds: samePathActive.map((candidate) => candidate.id),
      });
    }
    return;
  }
  fail('SOURCE_WRITE_NOT_ALLOWED',
    `当前状态不允许写入源文档: ${review.status}${review.status === 'applying' ? `/${review.applyMode || 'unknown'}` : ''}。`,
    423, { review: { ...review } });
}

function assertManualApplying(review) {
  if (review.status !== 'applying' || review.applyMode !== 'manual') {
    fail('MANUAL_APPLY_REQUIRED',
      `只有 applying/manual 状态可以执行此操作，当前为 ${review.status}/${review.applyMode || 'unknown'}。`,
      423, { review: { ...review } });
  }
}

function backupsDir(options = {}) {
  const dir = path.join(store.getDataDir(options), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function resolveStoredBackup(file, options = {}) {
  const base = backupsDir(options);
  if (typeof file !== 'string' || !file) fail('INVALID_BACKUP_RECORD', '备份索引无效，已停止写入。', 500);
  const absPath = path.resolve(base, file);
  const relative = path.relative(base, absPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('INVALID_BACKUP_RECORD', '备份索引越界，已停止写入。', 500);
  }
  return absPath;
}

async function ensureFirstBackup(review, current, options = {}) {
  const base = backupsDir(options);
  if (review.sourceBackup !== undefined) {
    if (!review.sourceBackup || typeof review.sourceBackup !== 'object' || Array.isArray(review.sourceBackup) ||
        !/^[a-f0-9]{64}$/.test(String(review.sourceBackup.hash || ''))) {
      fail('INVALID_BACKUP_RECORD', '备份索引无效，已停止写入。', 500, { reviewId: review.id });
    }
    const absBackup = resolveStoredBackup(review.sourceBackup.file, options);
    const backupHash = store.sha256File(absBackup);
    if (backupHash !== review.sourceBackup.hash) {
      fail('BACKUP_HASH_MISMATCH', '首次备份校验失败，已停止写入。', 500, { reviewId: review.id });
    }
    return { record: review.sourceBackup, created: false };
  }

  const reviewDir = path.join(base, review.id);
  fs.mkdirSync(reviewDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(reviewDir, 0o700);
  const backupPath = path.join(reviewDir, `original-${current.hash}.md`);
  let created = false;
  if (fs.existsSync(backupPath)) {
    if (store.sha256File(backupPath) !== current.hash) {
      fail('BACKUP_HASH_MISMATCH', '已存在的首次备份与源文档不一致，已停止写入。', 500, {
        reviewId: review.id,
      });
    }
  } else {
    await store.atomicWriteFile(backupPath, current.buffer, { mode: 0o600, encoding: undefined });
    created = true;
  }
  const record = {
    file: path.relative(base, backupPath),
    hash: current.hash,
    createdAt: new Date().toISOString(),
  };
  return { record, created };
}

function conflict(expectedHash, currentHash, review) {
  fail('SOURCE_CONFLICT', '源文档已变化，expectedHash 与当前内容不一致，已停止写入。', 409, {
    expectedHash, currentHash, reviewId: review.id,
  });
}

function writeResult(review, entry, reused, extra = {}) {
  return {
    review: { ...review },
    hash: entry.resultHash,
    revision: entry.revision,
    clientRequestId: entry.clientRequestId,
    reused,
    unchanged: !!entry.unchanged,
    ...extra,
  };
}

async function finalizeWrite(ref, requestId, currentHash, options = {}) {
  return store.mutateReviewById(ref, (review, data) => {
    assertWriteState(review, data);
    const requests = validateSourceWriteLog(review);
    const entry = ownRequest(requests, requestId);
    if (!entry || entry.status !== 'pending' || entry.contentHash !== currentHash) {
      fail('SOURCE_WRITE_RECOVERY_FAILED', '源文档已写入，但幂等记录无法完成，已停止后续操作。', 500, {
        reviewId: review.id, requestId,
      });
    }
    entry.status = 'complete';
    entry.resultHash = currentHash;
    entry.completedAt = new Date().toISOString();
    review.workingHash = currentHash;
    review.sourceRevision = entry.revision;
    review.sourceEditCount = Math.max(Number(review.sourceEditCount) || 0, entry.revision);
    review.lastEditedAt = entry.completedAt;
    if (SOURCE_WRITE_STATES.has(review.status)) review.finalHash = currentHash;
    return { review: { ...review }, entry: { ...entry } };
  }, options);
}

async function markWriteConflict(ref, requestId, currentHash, options = {}) {
  return store.mutateReviewById(ref, (review, data) => {
    assertWriteState(review, data);
    const requests = validateSourceWriteLog(review);
    const entry = ownRequest(requests, requestId);
    if (entry && entry.status === 'pending') {
      entry.status = 'conflict';
      entry.conflictHash = currentHash;
      entry.failedAt = new Date().toISOString();
    }
    return { review: { ...review }, entry: entry ? { ...entry } : null };
  }, options);
}

async function writeSource(ref, input, options = {}) {
  const payload = validateWritePayload(input);
  const initial = await requireReview(ref, options);

  return store.withReviewTransaction(initial.absPath, async () => {
    let review = await requireReview(ref, options);
    const allReviews = await store.listReviews(options);
    assertWriteState(review, {
      reviews: Object.fromEntries(allReviews.map((candidate) => [candidate.id, candidate])),
    });
    validateSourceWriteLog(review);

    let current = readSource(review.absPath);
    const requests = validateSourceWriteLog(review);
    const existing = ownRequest(requests, payload.clientRequestId);
    if (existing) {
      if (existing.expectedHash !== payload.expectedHash || existing.contentHash !== payload.contentHash) {
        fail('IDEMPOTENCY_KEY_REUSED', '同一 clientRequestId 已用于不同的保存内容。', 409, {
          reviewId: review.id, clientRequestId: payload.clientRequestId,
        });
      }
      if (existing.status === 'complete') {
        if (current.hash === existing.resultHash) return writeResult(review, existing, true);
        // 旧请求可能在后续保存已经完成后才重试。只有当当前文件仍与本会话
        // 最后一次受控写入一致时，才能安全返回原幂等结果。
        if (review.workingHash === current.hash && Number(review.sourceRevision) >= Number(existing.revision)) {
          return writeResult(review, existing, true, {
            superseded: true,
            currentHash: current.hash,
            currentRevision: Number(review.sourceRevision) || 0,
          });
        }
        conflict(existing.resultHash, current.hash, review);
      }
      if (existing.status === 'conflict') conflict(existing.expectedHash, current.hash, review);
      if (existing.status !== 'pending') {
        fail('INVALID_SOURCE_WRITE_LOG', '源文档幂等写入记录状态无效，已停止写入。', 500);
      }
      if (current.hash === payload.contentHash) {
        const finalized = await finalizeWrite(ref, payload.clientRequestId, current.hash, options);
        return writeResult(finalized.review, finalized.entry, true, { recovered: true });
      }
      if (current.hash !== payload.expectedHash) conflict(payload.expectedHash, current.hash, review);
    } else {
      const pending = Object.values(requests).find((entry) => entry.status === 'pending');
      if (pending) {
        fail('SOURCE_WRITE_PENDING', '上一次源文档保存尚未完成，请使用原 clientRequestId 重试。', 409, {
          reviewId: review.id, clientRequestId: pending.clientRequestId,
        });
      }
      if (current.hash !== payload.expectedHash) conflict(payload.expectedHash, current.hash, review);
    }

    const currentRevision = Number.isInteger(review.sourceRevision) && review.sourceRevision >= 0
      ? review.sourceRevision : 0;

    if (!existing && payload.contentHash === current.hash) {
      const result = await store.mutateReviewById(ref, (currentReview, data) => {
        assertWriteState(currentReview, data);
        const currentRequests = validateSourceWriteLog(currentReview);
        const now = new Date().toISOString();
        const entry = {
          clientRequestId: payload.clientRequestId,
          expectedHash: payload.expectedHash,
          contentHash: payload.contentHash,
          resultHash: current.hash,
          revision: currentRevision,
          status: 'complete',
          unchanged: true,
          createdAt: now,
          completedAt: now,
        };
        setRequest(currentRequests, payload.clientRequestId, entry);
        currentReview.sourceWriteRequests = currentRequests;
        currentReview.workingHash = current.hash;
        return { review: { ...currentReview }, entry: { ...entry } };
      }, options);
      return writeResult(result.review, result.entry, false);
    }

    let backup = { record: review.sourceBackup, created: false };
    if (!review.sourceBackup) backup = await ensureFirstBackup(review, current, options);
    else await ensureFirstBackup(review, current, options);

    const prepared = await store.mutateReviewById(ref, (currentReview, data) => {
      assertWriteState(currentReview, data);
      const currentRequests = validateSourceWriteLog(currentReview);
      const prior = ownRequest(currentRequests, payload.clientRequestId);
      if (prior) return { review: { ...currentReview }, entry: { ...prior } };
      const revision = currentRevision + 1;
      const entry = {
        clientRequestId: payload.clientRequestId,
        expectedHash: payload.expectedHash,
        contentHash: payload.contentHash,
        revision,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      setRequest(currentRequests, payload.clientRequestId, entry);
      currentReview.sourceWriteRequests = currentRequests;
      if (!currentReview.sourceBackup) currentReview.sourceBackup = backup.record;
      return { review: { ...currentReview }, entry: { ...entry } };
    }, options);

    current = readSource(review.absPath);
    if (current.hash === payload.contentHash) {
      const finalized = await finalizeWrite(ref, payload.clientRequestId, current.hash, options);
      return writeResult(finalized.review, finalized.entry, !!existing, { recovered: true });
    }
    if (current.hash !== payload.expectedHash) {
      await markWriteConflict(ref, payload.clientRequestId, current.hash, options);
      conflict(payload.expectedHash, current.hash, prepared.review);
    }

    await store.atomicWriteFile(review.absPath, payload.buffer, { mode: current.mode, encoding: undefined });
    const writtenHash = store.sha256File(review.absPath);
    if (writtenHash !== payload.contentHash) {
      fail('SOURCE_WRITE_VERIFY_FAILED', '源文档写入后 SHA-256 校验失败。', 500, {
        reviewId: review.id, expectedHash: payload.contentHash, currentHash: writtenHash,
      });
    }
    const finalized = await finalizeWrite(ref, payload.clientRequestId, writtenHash, options);
    return writeResult(finalized.review, finalized.entry, false, { backupCreated: backup.created });
  }, options);
}

async function readBundle(ref, options = {}) {
  let review = await requireReview(ref, options);
  const source = readSource(review.absPath);
  const expectedHash = review.status === 'reviewing' || review.status === 'ready_to_apply'
    ? review.sourceHash
    : (review.status === 'applying' && review.applyMode === 'manual'
      ? (review.workingHash || review.sourceHash)
      : null);
  if (expectedHash && source.hash !== expectedHash) {
    review = await store.markConflict(review.id, 'MDTurn 读取时检测到源文档发生未受控变化', options);
  }
  const sidecar = store.readAnnotations(review.absPath);
  return {
    review: { ...review },
    source: {
      path: review.absPath,
      name: path.basename(review.absPath),
      content: source.content,
      hash: source.hash,
      revision: Number.isInteger(review.sourceRevision) ? review.sourceRevision : 0,
      mode: source.mode,
      size: source.size,
      mtimeMs: source.mtimeMs,
      changedFromReview: source.hash !== review.sourceHash,
    },
    annotations: sidecar.annotations,
    counts: annotationCounts(sidecar.annotations),
    sidecar: { version: sidecar.version || 1, file: sidecar.file },
  };
}

async function patchAnnotation(ref, id, input, options = {}) {
  if (!id) fail('ANNOTATION_ID_REQUIRED', '缺少批注 id。');
  if (!input || typeof input !== 'object' || Array.isArray(input) || !SOURCE_STATUSES.has(input.status)) {
    fail('INVALID_ANNOTATION_STATUS', 'status 必须是 applied、wontfix 或 open。');
  }
  if (input.appliedNote !== undefined && typeof input.appliedNote !== 'string') {
    fail('INVALID_APPLIED_NOTE', 'appliedNote 必须是文本。');
  }
  if (input.expectedSourceHash !== undefined && !/^[a-f0-9]{64}$/.test(String(input.expectedSourceHash))) {
    fail('INVALID_EXPECTED_HASH', 'expectedSourceHash 必须是 64 位 SHA-256。');
  }
  if (input.expectedRevision !== undefined &&
      (!Number.isInteger(Number(input.expectedRevision)) || Number(input.expectedRevision) < 0)) {
    fail('INVALID_EXPECTED_REVISION', 'expectedRevision 必须是非负整数。');
  }
  const initial = await requireReview(ref, options);
  try {
    return await store.withReviewTransaction(initial.absPath, async () => {
      const review = await requireReview(ref, options);
      assertManualApplying(review);
      const source = readSource(review.absPath);
      const controlledHash = review.workingHash || review.sourceHash;
      const requestedHash = input.expectedSourceHash === undefined
        ? controlledHash
        : String(input.expectedSourceHash);
      if (source.hash !== controlledHash || source.hash !== requestedHash) {
        conflict(requestedHash, source.hash, review);
      }
      if (input.expectedRevision !== undefined &&
          Number(input.expectedRevision) !== (Number(review.sourceRevision) || 0)) {
        fail('SOURCE_REVISION_CONFLICT', '源文档修订号已变化，已停止更新批注状态。', 409, {
          expectedRevision: Number(input.expectedRevision),
          currentRevision: Number(review.sourceRevision) || 0,
          reviewId: review.id,
        });
      }
      let updated = null;
      const result = await store.mutateAnnotations(review.absPath, (data) => {
        const annotation = data.annotations.find((item) => item && item.id === id);
        if (!annotation) fail('ANNOTATION_NOT_FOUND', '找不到批注。', 404, { id });
        annotation.status = input.status;
        if (input.status === 'open') {
          delete annotation.appliedAt;
          delete annotation.appliedBy;
          delete annotation.appliedNote;
        } else {
          annotation.appliedAt = new Date().toISOString();
          annotation.appliedBy = review.applyActor || 'user';
          const fallback = input.status === 'wontfix' ? '手工标记为不改。' : '手工标记为已处理。';
          annotation.appliedNote = String(input.appliedNote || fallback).slice(0, 20000);
        }
        updated = { ...annotation };
        return {
          annotation: updated,
          counts: annotationCounts(data.annotations),
        };
      });
      return { ...result, review: { ...review } };
    }, options);
  } catch (error) {
    if (error && error.code === 'SOURCE_CONFLICT') {
      await store.markConflict(initial.id, '更新批注状态时检测到源文档发生未受控变化', options).catch(() => {});
    }
    throw error;
  }
}

module.exports = {
  readBundle,
  writeSource,
  patchAnnotation,
  annotationCounts,
  requireReview,
};
