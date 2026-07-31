#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../lib/review-store');

const project = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-perf-'));
const source = path.join(tempRoot, '性能 测试.md');
fs.writeFileSync(source, '# 性能测试\n\n用于隔离测试保存响应。\n', 'utf8');
let reviewId = null;
let linkId = null;

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function timedFetch(url, options) {
  const started = process.hrtime.bigint();
  const response = await fetch(url, options);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { response, elapsed };
}

async function cleanup() {
  if (reviewId) {
    const reviews = store.getPaths().reviews;
    await store.mutateJson(reviews, () => ({ version: 1, reviews: {} }), (data) => { delete data.reviews[reviewId]; }, { mode: 0o600 });
  }
  if (linkId) {
    const registry = store.getPaths().registry;
    await store.mutateJson(registry, () => ({ links: {} }), (data) => { delete data.links[linkId]; }, { mode: 0o600 });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function main() {
  const port = store.readPort();
  if (!port) throw new Error('本地服务端口不存在');
  const origin = `http://127.0.0.1:${port}`;
  const opened = await store.openReview(source);
  reviewId = opened.review.id;
  const localTimes = [];
  const localIds = [];
  for (let index = 0; index < 30; index += 1) {
    const { response, elapsed } = await timedFetch(`${origin}/api/annotations?r=${reviewId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: `本地性能批注 ${index}`, quote: '性能测试', clientRequestId: `local-perf-${index}` }),
    });
    const body = await response.json();
    if (!response.ok || !body.note) throw new Error(`本地保存失败: ${response.status}`);
    localTimes.push(elapsed); localIds.push(body.note.id);
  }
  await Promise.all(localIds.map((id) => fetch(`${origin}/api/annotations?r=${reviewId}&id=${encodeURIComponent(id)}`, { method: 'DELETE' })));
  const submitted = await fetch(`${origin}/api/review/submit?r=${reviewId}`, { method: 'POST' });
  if (!submitted.ok) throw new Error(`本地提交失败: ${submitted.status}`);

  const shared = spawnSync(process.execPath, ['mdshare.js', source, '--for', '__mdread_perf__', '--days', '1'], {
    cwd: project, encoding: 'utf8', timeout: 10000,
  });
  if (shared.status !== 0) throw new Error(shared.stderr || 'mdshare failed');
  const remoteUrl = new URL(shared.stdout.trim().split(/\r?\n/).pop());
  linkId = remoteUrl.pathname.split('/').filter(Boolean).pop();
  const key = remoteUrl.searchParams.get('k');
  const query = `d=${encodeURIComponent(linkId)}&k=${encodeURIComponent(key)}`;
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { const response = await fetch(remoteUrl, { cache: 'no-store' }); if (response.ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('远程 Tunnel 未就绪');

  const remoteTimes = [];
  for (let index = 0; index < 10; index += 1) {
    const { response, elapsed } = await timedFetch(`${remoteUrl.origin}/api/annotations?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: `远程性能批注 ${index}`, quote: '性能测试', clientRequestId: `remote-perf-${index}` }),
    });
    const body = await response.json();
    if (!response.ok || !body.note) throw new Error(`远程保存失败: ${response.status}`);
    remoteTimes.push(elapsed);
    const removed = await fetch(`${remoteUrl.origin}/api/annotations?${query}&id=${encodeURIComponent(body.note.id)}`, { method: 'DELETE' });
    if (!removed.ok) throw new Error(`远程清理失败: ${removed.status}`);
  }

  const metrics = {
    localMs: { p50: percentile(localTimes, 0.5), p95: percentile(localTimes, 0.95), max: Math.max(...localTimes) },
    remoteMs: { p50: percentile(remoteTimes, 0.5), p95: percentile(remoteTimes, 0.95), max: Math.max(...remoteTimes) },
  };
  if (metrics.localMs.p95 > 100) throw new Error(`本地保存 p95 过慢: ${metrics.localMs.p95.toFixed(1)}ms`);
  if (metrics.remoteMs.p95 > 3000) throw new Error(`远程保存 p95 过慢: ${metrics.remoteMs.p95.toFixed(1)}ms`);
  console.log(JSON.stringify(metrics, null, 2));
}

main().finally(cleanup).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
