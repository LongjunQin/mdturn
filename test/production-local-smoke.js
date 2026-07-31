#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../lib/review-store');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-local-smoke-'));
const source = path.join(tempRoot, '本地部署烟测.md');
fs.writeFileSync(source, '# 本地部署烟测\n\n示例文档\n', 'utf8');
let reviewId = null;

async function cleanup() {
  if (reviewId) {
    const reviews = store.getPaths().reviews;
    await store.mutateJson(reviews, () => ({ version: 1, reviews: {} }), (data) => { delete data.reviews[reviewId]; }, { mode: 0o600 });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function main() {
  const opened = spawnSync('/usr/local/bin/mdreview', ['open', source, '--no-open'], { encoding: 'utf8', timeout: 10000 });
  if (opened.status !== 0) throw new Error(opened.stderr || 'mdreview open failed');
  const match = opened.stdout.match(/^会话:\s*(\S+)$/m);
  if (!match) throw new Error('mdreview open did not print review id');
  reviewId = match[1];
  const port = store.readPort();
  const origin = `http://127.0.0.1:${port}`;
  const removedDashboard = await fetch(`${origin}/`, { cache: 'no-store' });
  const page = await fetch(`${origin}/r/${reviewId}`, { cache: 'no-store' });
  const review = await fetch(`${origin}/api/review?r=${reviewId}`, { cache: 'no-store' });
  const cfBlocked = await fetch(`${origin}/api/review?r=${reviewId}`, {
    cache: 'no-store', headers: { 'cf-connecting-ip': '203.0.113.1' },
  });
  const saved = await fetch(`${origin}/api/annotations?r=${reviewId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: '本地部署烟测（自动删除）', quote: '示例文档', clientRequestId: '__local_smoke__' }),
  });
  const savedBody = await saved.json();
  const edited = await fetch(`${origin}/api/annotations?r=${reviewId}&id=${encodeURIComponent(savedBody.note.id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: '本地部署烟测修改（自动删除）' }),
  });
  const editedBody = await edited.json();
  const removed = await fetch(`${origin}/api/annotations?r=${reviewId}&id=${encodeURIComponent(savedBody.note.id)}`, { method: 'DELETE' });
  const submitted = await fetch(`${origin}/api/review/submit?r=${reviewId}`, { method: 'POST' });
  const submittedBody = await submitted.json();
  if (removedDashboard.status !== 404) throw new Error(`removed dashboard still responds: ${removedDashboard.status}`);
  if (![page, review, saved, edited, removed, submitted].every((response) => response.ok)) throw new Error('local HTTP smoke failed');
  if (editedBody.note?.comment !== '本地部署烟测修改（自动删除）' || editedBody.note?.editCount !== 1) throw new Error('local annotation edit failed');
  if (cfBlocked.status !== 404) throw new Error(`CF isolation failed: ${cfBlocked.status}`);
  if (submittedBody.review.status !== 'complete' || submittedBody.review.outcome !== 'approved') throw new Error('review approval transition failed');
  console.log(JSON.stringify({ root: removedDashboard.status, page: page.status, review: review.status, create: saved.status, edit: edited.status, remove: removed.status, submit: submitted.status, cfBlocked: cfBlocked.status }));
}

main().finally(cleanup).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
