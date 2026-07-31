#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../lib/review-store');

const project = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-remote-smoke-'));
const source = path.join(tempRoot, '远程部署烟测.md');
fs.writeFileSync(source, '# 远程部署烟测\n\n示例文档\n', 'utf8');
let linkId = null;

async function cleanup() {
  if (linkId) {
    const registry = store.getPaths().registry;
    await store.mutateJson(registry, () => ({ links: {} }), (data) => { delete data.links[linkId]; }, { mode: 0o600 });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function main() {
  const shared = spawnSync(process.execPath, ['mdshare.js', source, '--for', '__mdread_smoke__', '--days', '1'], {
    cwd: project, encoding: 'utf8', timeout: 10000,
  });
  if (shared.status !== 0) throw new Error(shared.stderr || 'mdshare failed');
  const lines = shared.stdout.trim().split(/\r?\n/);
  const url = new URL(lines[lines.length - 1]);
  linkId = url.pathname.split('/').filter(Boolean).pop();
  const key = url.searchParams.get('k');
  const query = `d=${encodeURIComponent(linkId)}&k=${encodeURIComponent(key)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const page = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    const raw = await fetch(`${url.origin}/api/raw?${query}`, { signal: controller.signal, cache: 'no-store' });
    const saved = await fetch(`${url.origin}/api/annotations?${query}`, {
      signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: '部署烟测（自动删除）', quote: '示例文档' }),
    });
    const savedBody = await saved.json();
    if (!saved.ok || !savedBody.note || !savedBody.note.id) throw new Error(`remote POST failed: ${saved.status}`);
    const edited = await fetch(`${url.origin}/api/annotations?${query}&id=${encodeURIComponent(savedBody.note.id)}`, {
      signal: controller.signal, method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: '远程部署烟测修改（自动删除）' }),
    });
    const editedBody = await edited.json();
    if (!edited.ok || editedBody.note?.comment !== '远程部署烟测修改（自动删除）' || editedBody.note?.editCount !== 1) {
      throw new Error(`remote PATCH failed: ${edited.status}`);
    }
    const removed = await fetch(`${url.origin}/api/annotations?${query}&id=${encodeURIComponent(savedBody.note.id)}`, {
      signal: controller.signal, method: 'DELETE',
    });
    if (!removed.ok) throw new Error(`remote DELETE failed: ${removed.status}`);
    console.log(JSON.stringify({ page: page.status, raw: raw.status, create: saved.status, edit: edited.status, remove: removed.status }));
  } finally {
    clearTimeout(timeout);
  }
}

main().finally(cleanup).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
