#!/usr/bin/env node
'use strict';

// MDTurn desktop renderer real-browser smoke.
//
// This test deliberately has no npm dependency.  It launches an isolated
// md-read server plus a real headless Chrome instance, then drives /desktop
// through Chrome DevTools Protocol.  It covers the regressions that cannot be
// proven by the DOM-free anchor unit tests: Selection events, the floating
// annotation affordance, CSS Custom Highlight ranges, note editing and the
// visible ordering/collapsing rules in the right rail.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('../lib/review-store');

const PROJECT = path.resolve(__dirname, '..');
const STEP_TIMEOUT = 12_000;
const POLL_INTERVAL = 40;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('FAIL: 未找到 Google Chrome/Chromium，可用 CHROME_BIN 指定程序。');
  return found;
}

async function waitUntil(label, predicate, timeout = STEP_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`FAIL: 等待超时（${label}）${lastError ? `: ${lastError.message}` : ''}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2_000).then(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }),
  ]);
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
    this.exceptions = [];
    this.consoleErrors = [];
    this.dialogs = [];
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FAIL: CDP WebSocket 连接超时')), STEP_TIMEOUT);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer); reject(new Error('FAIL: CDP WebSocket 连接失败'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => { this.onMessage(event).catch(() => {}); });
    this.socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('FAIL: CDP WebSocket 提前关闭'));
      }
      this.pending.clear();
    });
  }

  async onMessage(event) {
    let text = event.data;
    if (typeof text !== 'string') {
      if (text instanceof ArrayBuffer) text = Buffer.from(text).toString('utf8');
      else if (ArrayBuffer.isView(text)) text = Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString('utf8');
      else if (text && typeof text.text === 'function') text = await text.text();
      else text = String(text);
    }
    const message = JSON.parse(text);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`FAIL: CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params && message.params.exceptionDetails;
      this.exceptions.push((detail && (detail.text || (detail.exception && detail.exception.description))) || 'unknown exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params && message.params.type === 'error') {
      this.consoleErrors.push((message.params.args || []).map((arg) => arg.value || arg.description || '').join(' '));
    }
    if (message.method === 'Page.javascriptDialogOpening') {
      this.dialogs.push({ type: message.params.type, message: message.params.message });
      await this.send('Page.handleJavaScriptDialog', { accept: true });
    }
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`FAIL: CDP 未连接，无法执行 ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`FAIL: CDP 命令超时: ${method}`));
      }, STEP_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails;
      throw new Error(`FAIL: 页面脚本异常: ${(detail.exception && detail.exception.description) || detail.text || 'unknown'}`);
    }
    return response.result && response.result.value;
  }

  async click(selector) {
    const point = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing element: ' + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (el.hidden || r.width <= 0 || r.height <= 0) throw new Error('element not clickable: ' + ${JSON.stringify(selector)});
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
  }

  async clickVisible(selector) {
    const point = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing element: ' + ${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      if (el.hidden || r.width <= 0 || r.height <= 0) throw new Error('element not clickable: ' + ${JSON.stringify(selector)});
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1,
    });
  }

  async clickText(selector, text) {
    const point = await this.evaluate(`(() => {
      const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const el = candidates.find((item) => item.textContent.includes(${JSON.stringify(text)}));
      if (!el) throw new Error('missing text element: ' + ${JSON.stringify(selector)} + ' / ' + ${JSON.stringify(text)});
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (el.hidden || r.width <= 0 || r.height <= 0) throw new Error('text element not clickable');
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function startServer(dataDir, docRoot) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT,
    env: {
      ...process.env,
      MDREAD_DATA_DIR: dataDir,
      MDREAD_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const portFile = store.getPaths({ dataDir }).port;
  const port = await waitUntil('md-read 隔离服务端口', async () => {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      const value = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (!Number.isInteger(value) || value <= 0) return null;
      const response = await fetch(`http://127.0.0.1:${value}/api/health`);
      return response.ok ? value : null;
    } catch (_) {
      return null;
    }
  });
  return { child, port, stderr: () => stderr };
}

async function startChrome(profileDir) {
  const requestedWidth = Number(process.env.MDTURN_SMOKE_WIDTH || 1440);
  const viewportWidth = Number.isFinite(requestedWidth) && requestedWidth >= 900
    ? Math.trunc(requestedWidth) : 1440;
  const child = spawn(chromeExecutable(), [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--disable-gpu',
    '--disable-features=MediaRouter,OptimizationHints,Translate',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const port = await waitUntil('Chrome DevTools 端口', () => {
    if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}: ${stderr}`);
    try {
      const value = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch (_) {
      return null;
    }
  });
  const target = await waitUntil('Chrome 页面 target', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null;
    } catch (_) {
      return null;
    }
  });
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewportWidth,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { child, cdp, viewportWidth, stderr: () => stderr };
}

async function notifyReview(port, reviewSessionId, reason) {
  const response = await fetch(`http://127.0.0.1:${port}/api/app/review/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ reviewSessionId, reason }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `审阅事件通知失败：${JSON.stringify(body)}`);
  assert.equal(body.event.reviewSessionId, reviewSessionId);
  assert.equal(body.event.reason, reason);
  return body;
}

async function selectText(cdp, startSelector, startOffset, endSelector, endOffset, buttonLabel = '浮动批注按钮显示') {
  // A DOM Range is used only as a geometry probe.  The actual Selection must
  // be produced by Chrome's native hit-testing through real CDP mouse input;
  // otherwise this regression would miss the exact pointerdown/click failure
  // that originally made the annotation button disappear.
  await cdp.evaluate(`(() => {
    const startRoot = document.querySelector(${JSON.stringify(startSelector)});
    if (!startRoot) throw new Error('selection start missing');
    startRoot.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    return document.querySelector('#readerScroll').scrollTop;
  })()`);
  // scroll events intentionally hide the floating action.  Let that event
  // finish before creating the physical selection so no stale scroll callback
  // races the subsequent real click.
  await sleep(80);

  const points = await cdp.evaluate(`(() => {
    const startRoot = document.querySelector(${JSON.stringify(startSelector)});
    const endRoot = document.querySelector(${JSON.stringify(endSelector)});
    if (!startRoot || !endRoot) throw new Error('selection endpoint missing');

    const textNodes = (root) => {
      const result = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.nodeValue && node.nodeValue.length && !node.parentElement.closest('.note-pin')
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let node;
      while ((node = walker.nextNode())) result.push(node);
      return result;
    };
    const locate = (root, requested, edge) => {
      const nodes = textNodes(root);
      const total = nodes.reduce((sum, node) => sum + node.nodeValue.length, 0);
      const offset = Math.max(0, Math.min(total, Number(requested)));
      let cursor = 0;
      let target = nodes[nodes.length - 1];
      let local = target ? target.nodeValue.length : 0;
      for (const node of nodes) {
        const next = cursor + node.nodeValue.length;
        if (offset <= next) { target = node; local = offset - cursor; break; }
        cursor = next;
      }
      if (!target || !target.nodeValue.length) throw new Error('selection text endpoint missing');
      const range = document.createRange();
      if (edge === 'start') {
        const index = Math.min(local, target.nodeValue.length - 1);
        range.setStart(target, index); range.setEnd(target, index + 1);
      } else {
        const index = Math.max(0, Math.min(local, target.nodeValue.length) - 1);
        range.setStart(target, index); range.setEnd(target, index + 1);
      }
      const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      const rect = edge === 'start' ? rects[0] : rects[rects.length - 1];
      if (!rect) throw new Error('selection endpoint has no client rect');
      const inset = Math.min(1.5, Math.max(.5, rect.width * .15));
      return {
        x: edge === 'start' ? rect.left + inset : rect.right - inset,
        y: rect.top + rect.height / 2,
        total,
      };
    };
    return {
      start: locate(startRoot, ${Number(startOffset)}, 'start'),
      end: locate(endRoot, ${Number(endOffset)}, 'end'),
    };
  })()`);

  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: points.start.x, y: points.start.y,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: points.start.x, y: points.start.y,
    button: 'left', buttons: 1, clickCount: 1,
  });
  for (let step = 1; step <= 14; step += 1) {
    const ratio = step / 14;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: points.start.x + ((points.end.x - points.start.x) * ratio),
      y: points.start.y + ((points.end.y - points.start.y) * ratio),
      button: 'left', buttons: 1,
    });
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: points.end.x, y: points.end.y,
    button: 'left', buttons: 0, clickCount: 1,
  });

  const selected = await cdp.evaluate(`(() => {
    const selection = window.getSelection();
    return { text: selection.toString(), collapsed: selection.isCollapsed };
  })()`);
  assert.equal(selected.collapsed, false, '真实 CDP 鼠标拖选不应折叠');
  await waitUntil(buttonLabel, () => cdp.evaluate('!document.querySelector("#annotateButton").hidden'));
  return selected.text;
}

async function inspectSelectionDialog(cdp, spec) {
  const selected = await selectText(
    cdp,
    spec.startSelector,
    spec.startOffset,
    spec.endSelector,
    spec.endOffset,
    `${spec.label}拖选后浮动批注按钮显示`,
  );
  assert.equal(selected, spec.expected, `${spec.label}鼠标拖选范围错误`);
  await cdp.clickVisible('#annotateButton');
  await waitUntil(`${spec.label}批注框弹出`, () => cdp.evaluate(
    '!document.querySelector("#annotationDialog").hidden',
  ));
  assert.equal(
    await cdp.evaluate('document.querySelector("#annotationQuote").textContent'),
    `“${spec.expected}”`,
    `${spec.label}批注框应保留完整选文`,
  );
  if (spec.dragDialog) {
    const before = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.annotation-dialog');
      const handle = dialog && dialog.querySelector('header');
      if (!dialog || !handle) throw new Error('annotation dialog drag handle missing');
      const box = dialog.getBoundingClientRect(), grip = handle.getBoundingClientRect();
      return {
        left: box.left, top: box.top,
        x: grip.left + Math.min(170, grip.width * .35),
        y: grip.top + grip.height / 2,
      };
    })()`);
    const target = { x: before.x + 180, y: before.y + 140 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: before.x, y: before.y });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: before.x, y: before.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: target.x, y: target.y, button: 'left', buttons: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1,
    });
    const after = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.annotation-dialog');
      const box = dialog.getBoundingClientRect();
      return {
        left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        hidden: document.querySelector('#annotationDialog').hidden,
        quote: document.querySelector('#annotationQuote').textContent,
      };
    })()`);
    assert.equal(after.hidden, false, '拖动批注框不得关闭弹窗');
    assert.ok(after.left - before.left > 100 && after.top - before.top > 80, '批注框应跟随标题栏鼠标拖动');
    assert.ok(after.left >= 0 && after.top >= 0 && after.right <= after.viewportWidth && after.bottom <= after.viewportHeight,
      '拖动后批注框必须留在可见视口内');
    assert.equal(after.quote, `“${spec.expected}”`, '拖动批注框不得丢失选文');
  }
  await cdp.click('#cancelAnnotation');
  await waitUntil(`${spec.label}取消批注`, () => cdp.evaluate(
    'document.querySelector("#annotationDialog").hidden',
  ));
  return selected;
}

async function saveNewAnnotation(cdp, source, comment, expectedCount) {
  await cdp.clickVisible('#annotateButton');
  await waitUntil('添加批注框弹出', () => cdp.evaluate('!document.querySelector("#annotationDialog").hidden'));
  await cdp.evaluate(`(() => {
    const textarea = document.querySelector('#annotationText');
    textarea.value = ${JSON.stringify(comment)};
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await cdp.click('#saveAnnotation');
  const annotations = await waitUntil(`批注落盘：${comment}`, () => {
    try {
      const values = store.readAnnotations(source).annotations;
      return values.length === expectedCount && values.some((note) => note.comment === comment) ? values : null;
    } catch (_) {
      return null;
    }
  });
  await waitUntil('保存后批注框关闭', () => cdp.evaluate('document.querySelector("#annotationDialog").hidden'));
  return annotations.find((note) => note.comment === comment);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-desktop-smoke-'));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  const profileDir = path.join(root, 'chrome-profile');
  const source = path.join(docRoot, 'reports', 'round', 'MDTurn桌面真实回归.md');
  const secondSource = path.join(docRoot, 'MDTurn第二文档.md');
  const asset = path.join(docRoot, 'assets', 'smoke.svg');
  const headingText = 'MDTurn 桌面端真实回归';
  const paragraphText = '普通段落中的文字应该能稳定拖选并打开批注。';
  const firstText = '甲段开头：只高亮这一段从中间开始的文字。';
  const secondText = '乙段内容：第二段只到指定位置，然后停止。';
  const thirdText = '丙段内容：它紧跟选区，但绝对不应该被高亮。';
  const fencedText = [
    '第一轮：第二章 + 第三章',
    '工程实证链与一号装置',
    '',
    '第二轮：第四章 + 第五章',
    '执行基础与产业化',
  ].join('\n');
  const newestText = '最新批注会放到当前批注列表的最前面。';
  const listText = '列表项中的内容也能通过鼠标拖选批注。';
  const tableText = '表格单元格中的内容也能批注。';
  const historyText = '第一轮已经处理的历史批注不应在正文留下高亮。';
  const HISTORY_COUNT = 36;
  const crossStart = 5;
  const crossEnd = secondText.length - 3;
  let server = null;
  let chrome = null;

  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(asset), { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(asset, [
      '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="36" viewBox="0 0 96 36">',
      '<rect width="96" height="36" rx="8" fill="#ff9700"/>',
      '<text x="48" y="23" text-anchor="middle" font-size="14" fill="white">MDTurn</text>',
      '</svg>',
    ].join(''), 'utf8');
    fs.writeFileSync(source, [
      `# <span id="heading-target">${headingText}</span>`,
      '',
      '![跨目录资源](../../assets/smoke.svg)',
      '',
      `<p id="history-target">${historyText}</p>`,
      '',
      '## 跨段精确批注',
      '',
      '```text',
      fencedText,
      '```',
      '',
      `<p id="cross-one">${firstText}</p>`,
      '',
      `<p id="cross-two">${secondText}</p>`,
      '',
      `<p id="cross-three">${thirdText}</p>`,
      '',
      `<p id="newest-target">${newestText}</p>`,
      '',
      '## 常见结构选区',
      '',
      `<p id="paragraph-target">${paragraphText}</p>`,
      '',
      `- <span id="list-target">${listText}</span>`,
      '',
      '| 场景 | 可批注内容 |',
      '| --- | --- |',
      `| 表格 | <span id="table-target">${tableText}</span> |`,
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(secondSource, [
      '# MDTurn 第二文档',
      '',
      '这篇文档用于验证批注弹窗始终绑定打开它的原标签页。',
      '',
    ].join('\n'), 'utf8');

    store.ensureDataDir({ dataDir });
    await store.mutateAnnotations(source, (data) => {
      const sourceHash = store.sha256File(source);
      data.annotations.push({
        id: 'history-applied',
        author: '我(本机)',
        createdAt: '2026-07-01T08:00:00.000Z',
        appliedAt: '2026-07-01T09:00:00.000Z',
        appliedBy: 'codex',
        appliedNote: '第一轮已经处理。',
        reviewSessionId: 'previous-round',
        sourceHash,
        anchorVersion: 3,
        comment: '这是历史批注',
        quote: historyText,
        prefix: '',
        suffix: '',
        headingPath: ['MDTurn 桌面端真实回归'],
        lineStart: 5,
        lineEnd: 5,
        startTextOffset: 0,
        endTextOffset: historyText.length,
        status: 'applied',
      });
      for (let index = 1; index < HISTORY_COUNT; index += 1) {
        data.annotations.push({
          id: `history-applied-${index}`,
          author: '我(本机)',
          createdAt: `2026-07-01T08:${String(index).padStart(2, '0')}:00.000Z`,
          appliedAt: `2026-07-01T09:${String(index).padStart(2, '0')}:00.000Z`,
          appliedBy: 'codex',
          appliedNote: '第一轮已处理。',
          reviewSessionId: 'previous-round',
          sourceHash,
          comment: `历史批注 ${index + 1}`,
          quote: `历史引用 ${index + 1}`,
          headingPath: [headingText],
          status: 'applied',
        });
      }
    });
    const secondOpened = await store.openReview(secondSource, { dataDir });
    const secondQuote = '这篇文档用于验证批注弹窗始终绑定打开它的原标签页。';
    await store.mutateAnnotations(secondSource, (data) => {
      data.annotations.push({
        id: 'second-agent-note',
        author: '我(本机)',
        createdAt: '2026-07-20T01:00:00.000Z',
        reviewSessionId: secondOpened.review.id,
        sourceHash: secondOpened.review.sourceHash,
        anchorVersion: 3,
        comment: '请由 Agent 修改第二篇文档并主动通知 App。',
        quote: secondQuote,
        prefix: '',
        suffix: '',
        headingPath: ['MDTurn 第二文档'],
        lineStart: 3,
        lineEnd: 3,
        startTextOffset: 0,
        endTextOffset: secondQuote.length,
        status: 'open',
      });
    });
    await sleep(25);
    const opened = await store.openReview(source, { dataDir });

    server = await startServer(dataDir, docRoot);
    chrome = await startChrome(profileDir);
    await chrome.cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.port}/desktop` });

    // 1. The desktop home must discover the already-open review and open it
    // from the recent list, rather than depending on a folder scan.
    await waitUntil('桌面首页最近审阅出现', () => chrome.cdp.evaluate(`(() => {
      const item = document.querySelector('#welcomeRecent .recent-item');
      return document.readyState === 'complete' && item && item.textContent.includes('MDTurn桌面真实回归.md');
    })()`));
    const titlebarSafeArea = await chrome.cdp.evaluate(`(() => {
      const titlebar = document.querySelector('.titlebar');
      const brand = document.querySelector('.brand');
      const mark = document.querySelector('.brand-mark');
      const name = document.querySelector('.brand-name');
      const brandBox = brand.getBoundingClientRect();
      const markBox = mark.getBoundingClientRect();
      return {
        brandLeft: brandBox.left,
        markLeft: markBox.left,
        safeWidth: parseFloat(getComputedStyle(document.documentElement)
          .getPropertyValue('--traffic-controls-safe-width')),
        nameVisible: name.getClientRects().length > 0,
        titlebarDraggable: titlebar.classList.contains('drag-region'),
        interactiveControls: titlebar.querySelectorAll('button, .tab').length,
      };
    })()`);
    assert.equal(titlebarSafeArea.brandLeft, 0, '品牌区应从窗口左缘开始');
    assert.equal(titlebarSafeArea.safeWidth, 96, 'macOS 窗口按钮安全区宽度被意外改动');
    assert.ok(titlebarSafeArea.markLeft >= titlebarSafeArea.safeWidth,
      'MDTurn Logo 必须位于 macOS 三个窗口按钮的安全区之外');
    assert.equal(titlebarSafeArea.nameVisible, true, '常规窗口宽度下应显示 MDTurn 名称');
    assert.equal(titlebarSafeArea.titlebarDraggable, true,
      '整条标题栏背景必须是 Electron 可拖动区');
    assert.ok(titlebarSafeArea.interactiveControls >= 4,
      '标题栏的按钮应继续由 no-drag 规则排除');
    await chrome.cdp.click('#welcomeRecent .recent-item');
    await waitUntil('最近审阅打开并渲染正文', () => chrome.cdp.evaluate(`(() => {
      const title = document.querySelector('#tabList .tab-title');
      const paragraph = document.querySelector('#cross-one');
      return title && title.textContent.includes('MDTurn桌面真实回归.md') && paragraph &&
        document.querySelector('#reviewStateText').textContent.includes('审阅中');
    })()`));
    const outlineState = await waitUntil('文章大纲与当前章节高亮', () => chrome.cdp.evaluate(`(() => {
      const links = Array.from(document.querySelectorAll('#outlinePanel .outline-link'));
      const active = document.querySelector('#outlinePanel .outline-link.active');
      return links.length === 3 && active
        ? { labels: links.map((item) => item.textContent.trim()), active: active.textContent.trim() }
        : null;
    })()`));
    assert.ok(outlineState.labels[0].includes('MDTurn 桌面端真实回归'));
    assert.ok(outlineState.labels[1].includes('跨段精确批注'));
    assert.ok(outlineState.labels[2].includes('常见结构选区'));
    assert.ok(outlineState.active.includes('MDTurn 桌面端真实回归'), '打开文档时大纲应高亮当前章节');
    await chrome.cdp.clickText('#outlinePanel .outline-link', '跨段精确批注');
    await waitUntil('点击大纲切换当前章节', () => chrome.cdp.evaluate(
      `document.querySelector('#outlinePanel .outline-link.active')?.textContent.includes('跨段精确批注')`,
    ));
    let previousScrollTop = null;
    let stableScrollSamples = 0;
    await waitUntil('大纲平滑滚动结束', async () => {
      const scrollTop = await chrome.cdp.evaluate('document.querySelector("#readerScroll").scrollTop');
      stableScrollSamples = previousScrollTop !== null && Math.abs(scrollTop - previousScrollTop) < 1
        ? stableScrollSamples + 1 : 0;
      previousScrollTop = scrollTop;
      await sleep(50);
      return stableScrollSamples >= 3;
    });
    const loadedAsset = await waitUntil('跨目录 SVG 真实加载', () => chrome.cdp.evaluate(`(() => {
      const image = document.querySelector('#documentContent img[alt="跨目录资源"]');
      return image && image.complete && image.naturalWidth > 0
        ? { width: image.naturalWidth, height: image.naturalHeight, src: image.src } : null;
    })()`));
    assert.ok(loadedAsset.width > 0 && loadedAsset.height > 0, '跨目录 SVG 应成功解码');
    assert.ok(loadedAsset.src.includes('/api/app/file?'), '本地资源必须走 app 专用文件接口');

    // Exercise the common selection shapes through native CDP pointer input.
    // Each case must preserve the browser selection while the floating button
    // itself is clicked; merely injecting a DOM Range would not prove that.
    await inspectSelectionDialog(chrome.cdp, {
      label: '标题',
      startSelector: '#heading-target', startOffset: 0,
      endSelector: '#heading-target', endOffset: headingText.length,
      expected: headingText,
      dragDialog: true,
    });
    await inspectSelectionDialog(chrome.cdp, {
      label: '普通段落',
      startSelector: '#paragraph-target', startOffset: 0,
      endSelector: '#paragraph-target', endOffset: paragraphText.length,
      expected: paragraphText,
    });
    await inspectSelectionDialog(chrome.cdp, {
      label: '列表项',
      startSelector: '#list-target', startOffset: 0,
      endSelector: '#list-target', endOffset: listText.length,
      expected: listText,
    });
    await inspectSelectionDialog(chrome.cdp, {
      label: '表格单元格',
      startSelector: '#table-target', startOffset: 0,
      endSelector: '#table-target', endOffset: tableText.length,
      expected: tableText,
    });
    assert.equal(
      store.readAnnotations(source).annotations.length,
      HISTORY_COUNT,
      '取消常见结构批注不应落盘',
    );

    // Fenced Markdown renders as <pre><code>.  This is a common report layout
    // (and the exact shape of the user-reported failure): selecting multiple
    // visual lines inside that one rendered code block must still expose the
    // floating annotation action and open its dialog.
    const fencedCode = await chrome.cdp.evaluate(`(() => {
      const code = document.querySelector('#documentContent pre code');
      if (!code) throw new Error('fenced code block missing');
      const mapped = code.closest('[data-line-start]');
      return {
        text: code.textContent,
        mappedTag: mapped && mapped.tagName,
        lineStart: mapped && mapped.dataset.lineStart,
        lineEnd: mapped && mapped.dataset.lineEnd,
      };
    })()`);
    assert.equal(fencedCode.text, `${fencedText}\n`, '围栏代码块的渲染文本前提失效');
    const selectedFence = await inspectSelectionDialog(chrome.cdp, {
      label: 'fenced code block 跨行选区',
      startSelector: '#documentContent pre code', startOffset: 0,
      endSelector: '#documentContent pre code', endOffset: fencedText.length,
      expected: fencedText,
    });
    assert.match(selectedFence, /\n/, '回归选区必须真实跨行');

    // 2. History starts collapsed, is present in the rail, and has no body
    // marker/highlight even though it has a valid v3 anchor.
    const initialHistory = await chrome.cdp.evaluate(`(() => ({
      open: document.querySelector('#historySection').open,
      count: document.querySelector('#historyNotesCount').textContent,
      cardCount: document.querySelectorAll('#historyNotesList .note-card').length,
      cardVisible: Array.from(document.querySelectorAll('#historyNotesList .note-card'))
        .some((card) => card.getClientRects().length > 0),
      legacyTint: document.querySelector('#history-target').classList.contains('legacy-note-block'),
      highlightRanges: CSS.highlights && CSS.highlights.get('mdturn-open')
        ? Array.from(CSS.highlights.get('mdturn-open')).map((range) => range.toString()) : [],
    }))()`);
    assert.deepEqual(initialHistory, {
      open: false,
      count: String(HISTORY_COUNT),
      cardCount: HISTORY_COUNT,
      cardVisible: false,
      legacyTint: false,
      highlightRanges: [],
    }, '大量历史批注应默认折叠，并且不得在正文中高亮');

    // 3. Select a partial range spanning exactly two paragraphs.  The floating
    // annotation button must remain actionable and the persisted anchor is v3.
    const selectedText = await selectText(chrome.cdp, '#cross-one', crossStart, '#cross-two', crossEnd);
    assert.ok(selectedText.includes(firstText.slice(crossStart)), '跨段选区应包含第一段选中部分');
    assert.ok(selectedText.includes(secondText.slice(0, crossEnd)), '跨段选区应包含第二段选中部分');
    assert.ok(!selectedText.includes(thirdText), '跨段选区不得包含第三段');
    const crossNote = await saveNewAnnotation(chrome.cdp, source, '较早的跨两段批注', HISTORY_COUNT + 1);
    assert.equal(crossNote.anchorVersion, 3, '桌面端新批注必须使用 v3 锚点');
    assert.equal(crossNote.startTextOffset, crossStart, 'v3 第一段 UTF-16 起点错误');
    assert.equal(crossNote.endTextOffset, crossEnd, 'v3 第二段 UTF-16 终点错误');
    assert.equal(crossNote.reviewSessionId, opened.review.id, '新批注必须绑定当前审阅会话');
    assert.equal(crossNote.sourceHash, opened.review.sourceHash, '新批注必须绑定冻结源哈希');
    assert.equal(crossNote.quote, `${firstText.slice(crossStart)}\n${secondText.slice(0, crossEnd)}`);

    // 4. CSS Custom Highlight must contain two exact DOM ranges and no range in
    // the immediately-following third paragraph.
    const exactHighlight = await waitUntil('CSS.highlights 精确跨两段', () => chrome.cdp.evaluate(`(() => {
      if (!globalThis.CSS || !CSS.highlights) throw new Error('CSS Custom Highlight API unavailable');
      const highlight = CSS.highlights.get('mdturn-open');
      if (!highlight || Array.from(highlight).length !== 2) return null;
      return Array.from(highlight).map((range) => {
        const parent = range.startContainer.nodeType === Node.TEXT_NODE
          ? range.startContainer.parentElement : range.startContainer;
        const block = parent && parent.closest('[data-line-start]');
        return { id: block && block.id, text: range.toString() };
      });
    })()`));
    assert.deepEqual(exactHighlight, [
      { id: 'cross-one', text: firstText.slice(crossStart) },
      { id: 'cross-two', text: secondText.slice(0, crossEnd) },
    ], 'CSS.highlights 必须只精确覆盖用户选中的两段文字');
    assert.equal(
      await chrome.cdp.evaluate(`document.querySelector('#cross-three').classList.contains('legacy-note-block')`),
      false,
      '第三段不得被整段回退高亮',
    );
    const markerGeometry = await waitUntil('批注图标贴近选区起点', () => chrome.cdp.evaluate(`(() => {
      const pin = document.querySelector('#annotationOverlay .note-pin:not([hidden])');
      const highlight = CSS.highlights && CSS.highlights.get('mdturn-open');
      const range = highlight && Array.from(highlight)[0];
      if (!pin || !range) return null;
      const pinBox = pin.getBoundingClientRect();
      const start = range.cloneRange(); start.collapse(true);
      const startBox = start.getClientRects()[0] || range.getClientRects()[0];
      return {
        pinInBody: Boolean(document.querySelector('#documentContent .note-pin')),
        horizontalDistance: Math.abs((pinBox.left + pinBox.width / 2) - startBox.left),
        verticalDistance: Math.abs((pinBox.top + pinBox.height / 2) - (startBox.top + startBox.height / 2)),
      };
    })()`));
    assert.equal(markerGeometry.pinInBody, false, '批注图标不得插入段尾改变正文排版');
    assert.ok(markerGeometry.horizontalDistance < 58 && markerGeometry.verticalDistance < 22,
      '批注图标应显示在精确选区起点附近');

    await chrome.cdp.click('#collapseLeft');
    const collapsedBrand = await waitUntil('左栏收起后批注图标与标题栏自动重定位', () => chrome.cdp.evaluate(`(() => {
      if (!document.querySelector('#appShell').classList.contains('left-collapsed')) return null;
      const pin = document.querySelector('#annotationOverlay .note-pin:not([hidden])');
      const highlight = CSS.highlights && CSS.highlights.get('mdturn-open');
      const range = highlight && Array.from(highlight)[0];
      if (!pin || !range) return null;
      const pinBox = pin.getBoundingClientRect();
      const start = range.cloneRange(); start.collapse(true);
      const startBox = start.getClientRects()[0] || range.getClientRects()[0];
      const horizontal = Math.abs((pinBox.left + pinBox.width / 2) - startBox.left);
      const vertical = Math.abs((pinBox.top + pinBox.height / 2) - (startBox.top + startBox.height / 2));
      const mark = document.querySelector('.brand-mark');
      const name = document.querySelector('.brand-name');
      const safeWidth = parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue('--traffic-controls-safe-width'));
      return horizontal < 58 && vertical < 22
        ? { markLeft: mark.getBoundingClientRect().left, safeWidth,
          nameVisible: name.getClientRects().length > 0 }
        : null;
    })()`));
    assert.ok(collapsedBrand.markLeft >= collapsedBrand.safeWidth,
      '收起左栏后 Logo 仍必须避开 macOS 窗口按钮');
    assert.equal(collapsedBrand.nameVisible, false, '收起左栏后应隐藏名称以腾出标签页空间');
    await chrome.cdp.click('#expandLeft');
    await waitUntil('左栏重新展开', () => chrome.cdp.evaluate(
      `!document.querySelector('#appShell').classList.contains('left-collapsed')`,
    ));

    // 5. Create a later note, then prove open notes are newest-first even though
    // the sidecar remains append-only after the historical record.
    await sleep(25);
    await selectText(chrome.cdp, '#newest-target', 0, '#newest-target', newestText.length);
    const newestNote = await saveNewAnnotation(chrome.cdp, source, '最新批注应该置顶', HISTORY_COUNT + 2);
    const sidecarState = store.readAnnotations(source).annotations;
    assert.equal(sidecarState.filter((note) => note.status === 'applied').length, HISTORY_COUNT);
    assert.deepEqual(
      sidecarState.filter((note) => (note.status || 'open') === 'open').map((note) => note.comment),
      ['较早的跨两段批注', '最新批注应该置顶'],
      '第二轮 open 批注应保持 sidecar 追加顺序',
    );
    const openOrder = await chrome.cdp.evaluate(
      `Array.from(document.querySelectorAll('#openNotesList .note-comment')).map((item) => item.textContent)`,
    );
    assert.deepEqual(openOrder, ['最新批注应该置顶', '较早的跨两段批注'], '未处理批注必须最新置顶');
    const railLayout = await chrome.cdp.evaluate(`(() => {
      const rail = document.querySelector('#notesContent');
      const cards = Array.from(document.querySelectorAll('#openNotesList .note-card'));
      const railBox = rail.getBoundingClientRect();
      return {
        clientWidth: rail.clientWidth,
        scrollWidth: rail.scrollWidth,
        cardsInside: cards.every((card) => {
          const box = card.getBoundingClientRect();
          return box.left >= railBox.left - 1 && box.right <= railBox.right + 1;
        }),
        actionsVisible: cards.every((card) => {
          const actions = card.querySelector('.note-actions');
          return actions && actions.getClientRects().length > 0 &&
            actions.getBoundingClientRect().right <= railBox.right + 1;
        }),
      };
    })()`);
    assert.ok(railLayout.scrollWidth <= railLayout.clientWidth + 1, '右侧批注栏不得产生横向滚动');
    assert.equal(railLayout.cardsInside, true, '批注卡片宽度必须跟随右栏');
    assert.equal(railLayout.actionsVisible, true, '批注卡片的编辑/删除操作必须在可见范围');

    // 6. Edit the earlier note from the right rail and verify the server keeps
    // the anchor while auditing the comment edit.
    const crossSelector = `[data-note-id="${crossNote.id}"]`;
    await chrome.cdp.click(`${crossSelector} .note-actions button:first-child`);
    await waitUntil('编辑批注框弹出', () => chrome.cdp.evaluate(`(() => {
      const dialog = document.querySelector('#annotationDialog');
      return !dialog.hidden && document.querySelector('#annotationDialogTitle').textContent === '编辑批注';
    })()`));
    assert.equal(
      await chrome.cdp.evaluate('document.querySelector("#annotationText").value'),
      '较早的跨两段批注',
      '编辑框应回填原批注',
    );
    await chrome.cdp.evaluate(`(() => {
      const textarea = document.querySelector('#annotationText');
      textarea.value = '跨两段批注（已修改）';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await chrome.cdp.click('#saveAnnotation');
    const edited = await waitUntil('批注修改落盘', () => {
      const note = store.readAnnotations(source).annotations.find((item) => item.id === crossNote.id);
      return note && note.comment === '跨两段批注（已修改）' && note.editCount === 1 ? note : null;
    });
    assert.equal(edited.anchorVersion, 3, '编辑批注不得破坏 v3 锚点');
    assert.equal(edited.quote, crossNote.quote, '编辑批注不得改变原选区引用');
    assert.equal(edited.updatedBy, '我(本机)');
    await waitUntil('右栏显示修改后的批注', () => chrome.cdp.evaluate(
      `Array.from(document.querySelectorAll('#openNotesList .note-comment')).some((item) => item.textContent === '跨两段批注（已修改）')`,
    ));

    // Re-check that adding/editing current notes never wakes the historical
    // marker and never accidentally expands the history section.
    const finalUi = await chrome.cdp.evaluate(`(() => {
      const highlight = CSS.highlights && CSS.highlights.get('mdturn-open');
      const ranges = highlight ? Array.from(highlight).map((range) => range.toString()) : [];
      return {
        historyOpen: document.querySelector('#historySection').open,
        historyVisible: Array.from(document.querySelectorAll('#historyNotesList .note-card'))
          .some((card) => card.getClientRects().length > 0),
        historyTint: document.querySelector('#history-target').classList.contains('legacy-note-block'),
        historyInHighlight: ranges.some((text) => text.includes(${JSON.stringify(historyText)})),
        thirdInHighlight: ranges.some((text) => text.includes(${JSON.stringify(thirdText)})),
        openOrder: Array.from(document.querySelectorAll('#openNotesList .note-comment')).map((item) => item.textContent),
      };
    })()`);
    assert.deepEqual(finalUi, {
      historyOpen: false,
      historyVisible: false,
      historyTint: false,
      historyInHighlight: false,
      thirdInHighlight: false,
      openOrder: ['最新批注应该置顶', '跨两段批注（已修改）'],
    });

    // 7. A note dialog belongs to the tab/session that created it.  Cmd+O/W
    // must be consumed while it is open, and even an out-of-band tab activation
    // must not redirect the eventual PATCH to the newly-active document.
    await chrome.cdp.click('#filesModeButton');
    await chrome.cdp.clickText('#recentList .recent-item', 'MDTurn第二文档.md');
    await waitUntil('第二篇最近文档打开', () => chrome.cdp.evaluate(`(() => {
      const tabs = Array.from(document.querySelectorAll('#tabList .tab'));
      const active = document.querySelector('#tabList .tab.active .tab-title');
      return tabs.length === 2 && active && active.textContent.includes('MDTurn第二文档.md');
    })()`));
    await chrome.cdp.clickText('#tabList .tab', 'MDTurn桌面真实回归.md');
    await waitUntil('切回第一篇文档', () => chrome.cdp.evaluate(
      `document.querySelector('#tabList .tab.active .tab-title').textContent.includes('MDTurn桌面真实回归.md')`,
    ));
    await chrome.cdp.click(`${crossSelector} .note-actions button:first-child`);
    await waitUntil('跨标签绑定测试弹窗打开', () => chrome.cdp.evaluate(
      `!document.querySelector('#annotationDialog').hidden && document.querySelector('#annotationText').value === '跨两段批注（已修改）'`,
    ));
    const shortcutGuards = await chrome.cdp.evaluate(`(() => ['o', 'w'].map((key) => {
      const event = new KeyboardEvent('keydown', {
        key, code: 'Key' + key.toUpperCase(), metaKey: true, bubbles: true, cancelable: true,
      });
      const dispatched = document.dispatchEvent(event);
      return { key, defaultPrevented: event.defaultPrevented, dispatched };
    }))()`);
    assert.deepEqual(shortcutGuards, [
      { key: 'o', defaultPrevented: true, dispatched: false },
      { key: 'w', defaultPrevented: true, dispatched: false },
    ], '批注弹窗打开时必须拦截 Cmd+O/W');
    assert.equal(await chrome.cdp.evaluate('document.querySelectorAll("#tabList .tab").length'), 2);
    assert.equal(await chrome.cdp.evaluate('document.querySelector("#annotationDialog").hidden'), false);

    // The modal backdrop prevents a normal tab click.  Programmatic activation
    // simulates an Electron open-file event arriving while the dialog is open.
    await chrome.cdp.evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('#tabList .tab'))
        .find((item) => item.textContent.includes('MDTurn第二文档.md'));
      if (!tab) throw new Error('second tab missing');
      tab.click();
      return true;
    })()`);
    await waitUntil('弹窗期间外部激活第二标签', () => chrome.cdp.evaluate(`(() => {
      const active = document.querySelector('#tabList .tab.active .tab-title');
      return active && active.textContent.includes('MDTurn第二文档.md') &&
        !document.querySelector('#annotationDialog').hidden;
    })()`));
    await chrome.cdp.evaluate(`(() => {
      const textarea = document.querySelector('#annotationText');
      textarea.value = '跨两段批注（固定原标签保存）';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await chrome.cdp.click('#saveAnnotation');
    const reboundEdit = await waitUntil('弹窗保存仍写入原 session', () => {
      const note = store.readAnnotations(source).annotations.find((item) => item.id === crossNote.id);
      return note && note.comment === '跨两段批注（固定原标签保存）' && note.editCount === 2 ? note : null;
    });
    assert.equal(reboundEdit.reviewSessionId, opened.review.id);
    const secondBeforePush = store.readAnnotations(secondSource).annotations;
    assert.equal(secondBeforePush.length, 1, '第二标签应只保留自己的 Agent 批注');
    assert.equal(secondBeforePush[0].id, 'second-agent-note');
    assert.equal(secondBeforePush[0].status, 'open');
    assert.equal(await chrome.cdp.evaluate('document.querySelector("#annotationDialog").hidden'), true);
    await waitUntil('跨标签保存不串写右栏和状态', () => chrome.cdp.evaluate(`(() => {
      const active = document.querySelector('#tabList .tab.active .tab-title');
      const status = document.querySelector('#reviewStateText').textContent;
      const comments = Array.from(document.querySelectorAll('#openNotesList .note-comment'))
        .map((item) => item.textContent);
      return active && active.textContent.includes('MDTurn第二文档.md') &&
        status.includes('审阅中') && comments.length === 1 &&
        comments[0] === '请由 Agent 修改第二篇文档并主动通知 App。';
    })()`));

    // 8. Keep the real desktop page open while an external Agent advances the
    // second review.  Each persisted transition is followed by the same
    // loopback notification used by mdreview.  The EventSource must refresh
    // only that tab, including the final source bytes, without waiting for the
    // 60-second reconciliation fallback or disturbing the first review.
    // Re-activating an already-selected tab must be harmless.
    await chrome.cdp.clickText('#tabList .tab', 'MDTurn第二文档.md');
    const initialPushUi = await waitUntil('第二标签准备 Agent 主动推送闭环', () => chrome.cdp.evaluate(`(() => {
      const active = document.querySelector('#tabList .tab.active .tab-title');
      const status = document.querySelector('#reviewStateText').textContent;
      const content = document.querySelector('#documentContent').textContent;
      const count = document.querySelector('#openNotesCount').textContent;
      if (!active || !active.textContent.includes('MDTurn第二文档.md') ||
          !status.includes('审阅中') || !content.includes(${JSON.stringify(secondQuote)}) || count !== '1') return null;
      const first = Array.from(document.querySelectorAll('#tabList .tab'))
        .find((tab) => tab.textContent.includes('MDTurn桌面真实回归.md'));
      const firstState = first && first.querySelector('.tab-state');
      return firstState ? { firstStateClass: firstState.className, firstStateTitle: firstState.title } : null;
    })()`));
    assert.match(initialPushUi.firstStateClass, /reviewing/, '主动推送前第一标签应保持 reviewing');

    const readySecond = await store.submitReview(secondOpened.review.id, { dataDir });
    assert.equal(readySecond.review.status, 'ready_to_apply');
    const readyNotification = await notifyReview(server.port, secondOpened.review.id, 'review-submitted');
    assert.ok(readyNotification.delivered >= 1, '打开的 MDTurn 页面应已订阅主动通知');
    await waitUntil('主动推送 ready_to_apply 状态', () => chrome.cdp.evaluate(
      `document.querySelector('#reviewStateText').textContent.includes('等待修改')`,
    ), 5_000);

    const applyingSecond = await store.beginApply(secondSource, {
      dataDir,
      applyMode: 'agent',
      applyActor: 'codex',
      expectedReviewId: secondOpened.review.id,
    });
    assert.equal(applyingSecond.status, 'applying');
    assert.equal(applyingSecond.applyMode, 'agent');
    const applyingNotification = await notifyReview(server.port, secondOpened.review.id, 'agent-apply-started');
    assert.ok(applyingNotification.delivered >= 1, 'Agent 开始改稿事件应送达打开的 MDTurn 页面');
    await waitUntil('主动推送 Agent applying 状态', () => chrome.cdp.evaluate(`(() => {
      const status = document.querySelector('#reviewStateText').textContent;
      return status.includes('Agent 修改中') && status.includes('文档暂时只读');
    })()`), 5_000);

    const pushedPhrase = 'Agent 主动推送后的最新版正文已加载。';
    const updatedSecondSource = [
      '# MDTurn 第二文档',
      '',
      '这篇文档已由 Agent 完成修改，并验证主动推送。',
      '',
      '## 主动推送结果',
      '',
      pushedPhrase,
      '',
    ].join('\n');
    fs.writeFileSync(secondSource, updatedSecondSource, 'utf8');
    await store.mutateAnnotations(secondSource, (data) => {
      const note = data.annotations.find((item) => item.id === 'second-agent-note');
      assert.ok(note, '第二文档 Agent 批注必须存在');
      note.status = 'applied';
      note.appliedAt = new Date().toISOString();
      note.appliedBy = 'codex';
      note.appliedNote = '已完成主动推送闭环修改。';
    });
    const completedSecond = await store.completeReview(secondSource, {
      dataDir,
      expectedReviewId: secondOpened.review.id,
      expectedApplyMode: 'agent',
    });
    assert.equal(completedSecond.status, 'complete');

    const pushStartedAt = Date.now();
    const completionNotification = await notifyReview(server.port, secondOpened.review.id, 'agent-complete');
    assert.ok(completionNotification.delivered >= 1, 'Agent 完成事件应送达打开的 MDTurn 页面');
    const pushedUi = await waitUntil('主动推送刷新完成状态和最新正文', () => chrome.cdp.evaluate(`(() => {
      const active = document.querySelector('#tabList .tab.active .tab-title');
      const status = document.querySelector('#reviewStateText').textContent;
      const content = document.querySelector('#documentContent').textContent;
      const count = document.querySelector('#openNotesCount').textContent;
      const toasts = Array.from(document.querySelectorAll('#toastRegion .toast')).map((item) => item.textContent);
      const first = Array.from(document.querySelectorAll('#tabList .tab'))
        .find((tab) => tab.textContent.includes('MDTurn桌面真实回归.md'));
      const firstState = first && first.querySelector('.tab-state');
      if (!active || !active.textContent.includes('MDTurn第二文档.md') ||
          !status.includes('修改已完成') || !content.includes(${JSON.stringify(pushedPhrase)}) || count !== '0' ||
          !toasts.some((text) => text.includes('Agent 修改完成'))) return null;
      return {
        status,
        toasts,
        firstStateClass: firstState && firstState.className,
        firstStateTitle: firstState && firstState.title,
      };
    })()`), 5_000);
    const activePushElapsedMs = Date.now() - pushStartedAt;
    assert.ok(activePushElapsedMs < 5_000,
      `Agent 主动推送应在 5 秒内更新，而不是等待 60 秒轮询；实际 ${activePushElapsedMs}ms`);
    assert.match(pushedUi.firstStateClass, /reviewing/, '第二标签主动刷新不得污染第一标签状态');

    const completionToastCount = pushedUi.toasts.filter((text) => text.includes('Agent 修改完成')).length;
    await Promise.all([
      notifyReview(server.port, secondOpened.review.id, 'agent-complete'),
      notifyReview(server.port, secondOpened.review.id, 'agent-complete'),
    ]);
    await chrome.cdp.evaluate('window.dispatchEvent(new Event("focus"))');
    await sleep(250);
    const duplicateToastCount = await chrome.cdp.evaluate(`Array.from(document.querySelectorAll(
      '#toastRegion .toast')).filter((item) => item.textContent.includes('Agent 修改完成')).length`);
    assert.equal(duplicateToastCount, completionToastCount,
      '重复 complete 事件与focus 补偿并发时，同一轮只能通知一次');

    const detachedSource = path.join(docRoot, 'MDTurn已关闭标签通知.md');
    fs.writeFileSync(detachedSource, '# 已关闭标签\n\nAgent 完成后仍应主动通知。\n', 'utf8');
    const detachedOpened = await store.openReview(detachedSource, { dataDir });
    await store.mutateAnnotations(detachedSource, (data) => {
      data.annotations.push({
        id: 'detached-agent-note',
        author: '我(本机)',
        createdAt: new Date().toISOString(),
        reviewSessionId: detachedOpened.review.id,
        sourceHash: detachedOpened.review.sourceHash,
        comment: '请 Agent 修改后通知。',
        quote: 'Agent 完成后仍应主动通知。',
        headingPath: ['已关闭标签'],
        lineStart: 3,
        lineEnd: 3,
        status: 'open',
      });
    });
    await store.submitReview(detachedOpened.review.id, { dataDir });
    await store.beginApply(detachedSource, {
      dataDir,
      applyMode: 'agent',
      applyActor: 'codex',
      expectedReviewId: detachedOpened.review.id,
    });
    fs.writeFileSync(detachedSource, '# 已关闭标签\n\nAgent 已完成修改。\n', 'utf8');
    await store.mutateAnnotations(detachedSource, (data) => {
      const note = data.annotations.find((item) => item.id === 'detached-agent-note');
      note.status = 'applied';
      note.appliedAt = new Date().toISOString();
      note.appliedBy = 'codex';
      note.appliedNote = '已修改。';
    });
    await store.completeReview(detachedSource, {
      dataDir,
      expectedReviewId: detachedOpened.review.id,
      expectedApplyMode: 'agent',
    });
    const tabCountBeforeDetachedNotice = await chrome.cdp.evaluate(
      `document.querySelectorAll('#tabList .tab').length`,
    );
    await notifyReview(server.port, detachedOpened.review.id, 'agent-complete');
    await waitUntil('未打开标签的 Agent 完成通知', () => chrome.cdp.evaluate(`(() => {
      const toasts = Array.from(document.querySelectorAll('#toastRegion .toast')).map((item) => item.textContent);
      return toasts.some((text) => text.includes('MDTurn已关闭标签通知.md') && text.includes('Agent 修改完成'));
    })()`), 5_000);
    assert.equal(await chrome.cdp.evaluate(`document.querySelectorAll('#tabList .tab').length`),
      tabCountBeforeDetachedNotice, '已关闭/未打开标签收到完成事件时不得自动重开');

    await chrome.cdp.clickText('#tabList .tab', 'MDTurn桌面真实回归.md');
    await waitUntil('主动推送后第一标签仍保持原文和原状态', () => chrome.cdp.evaluate(`(() => {
      const active = document.querySelector('#tabList .tab.active .tab-title');
      const status = document.querySelector('#reviewStateText').textContent;
      const content = document.querySelector('#documentContent').textContent;
      const count = document.querySelector('#openNotesCount').textContent;
      return active && active.textContent.includes('MDTurn桌面真实回归.md') &&
        status.includes('审阅中') && content.includes(${JSON.stringify(headingText)}) &&
        !content.includes(${JSON.stringify(pushedPhrase)}) && count === '2';
    })()`), 5_000);
    const secondTabAfterPush = await chrome.cdp.evaluate(`(() => {
      const tab = Array.from(document.querySelectorAll('#tabList .tab'))
        .find((item) => item.textContent.includes('MDTurn第二文档.md'));
      const state = tab && tab.querySelector('.tab-state');
      return state && { className: state.className, title: state.title };
    })()`);
    assert.match(secondTabAfterPush.className, /complete/, '非活动第二标签应保留 complete 状态');

    // 9. Enter the real manual-apply editor, create a dirty draft, reload the
    // whole desktop page, and prove the exact draft comes back before saving.
    await chrome.cdp.clickText('#tabList .tab', 'MDTurn桌面真实回归.md');
    await waitUntil('重新激活第一篇文档', () => chrome.cdp.evaluate(
      `document.querySelector('#tabList .tab.active .tab-title').textContent.includes('MDTurn桌面真实回归.md')`,
    ));
    await chrome.cdp.click('#editingModeButton');
    await waitUntil('手工修改确认框', () => chrome.cdp.evaluate(`(() => {
      const dialog = document.querySelector('#confirmDialog');
      return !dialog.hidden && document.querySelector('#confirmTitle').textContent.includes('手工修改');
    })()`));
    await chrome.cdp.click('#confirmAccept');
    await waitUntil('进入 manual applying 编辑器', async () => {
      const review = await store.getReviewById(opened.review.id, { dataDir });
      if (!review || review.status !== 'applying' || review.applyMode !== 'manual') return null;
      return chrome.cdp.evaluate(`(() => {
        const pane = document.querySelector('#editorPane');
        const status = document.querySelector('#reviewStateText').textContent;
        return !pane.hidden && status.includes('手工修改中') && !status.includes('原文已解冻') &&
          !!(document.querySelector('.cm-content') || document.querySelector('.fallback-editor'));
      })()`);
    });
    await chrome.cdp.evaluate('document.querySelector("#outlineModeButton").click()');
    await waitUntil('编辑模式显示大纲面板', () => chrome.cdp.evaluate(
      `!document.querySelector('#outlinePanel').hidden`,
    ));
    await chrome.cdp.clickText('#outlinePanel .outline-link', '跨段精确批注');
    await waitUntil('编辑模式大纲定位 CodeMirror 行', () => chrome.cdp.evaluate(`(() => {
      const activeLine = document.querySelector('.cm-activeLine');
      return activeLine && activeLine.textContent.includes('## 跨段精确批注');
    })()`));

    const originalSource = fs.readFileSync(source, 'utf8');
    const draftContent = `${originalSource.trimEnd()}\n\n## 手工草稿恢复验证\n\n这段内容必须在刷新后原样恢复，然后才能安全保存。\n`;
    const editorSelector = await chrome.cdp.evaluate(
      `document.querySelector('.cm-content') ? '.cm-content' : '.fallback-editor'`,
    );
    await chrome.cdp.click(editorSelector);
    await chrome.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 4, nativeVirtualKeyCode: 65,
    });
    await chrome.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, nativeVirtualKeyCode: 65,
    });
    await chrome.cdp.send('Input.insertText', { text: draftContent });
    await waitUntil('dirty 草稿进入 localStorage', () => chrome.cdp.evaluate(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(`mdturn.draft.${opened.review.id}`)});
      if (!raw) return null;
      const draft = JSON.parse(raw);
      return draft.content === ${JSON.stringify(draftContent)} &&
        document.querySelector('#editorSaveState').textContent.includes('未保存');
    })()`));

    await chrome.cdp.evaluate('window.__mdturnSmokePreReload = true');
    await chrome.cdp.send('Page.reload', { ignoreCache: true });
    // CodeMirror virtualizes off-screen lines, so .cm-content.textContent is
    // not a valid full-document oracle once this fixture grows.  Here we prove
    // the exact draft was restored into the active dirty tab; the immediately
    // following Cmd+S assertion then proves the editor value byte-for-byte by
    // requiring the source file to equal draftContent.
    await waitUntil('刷新后 dirty 草稿自动恢复', () => chrome.cdp.evaluate(`(() => {
      if (window.__mdturnSmokePreReload || document.readyState !== 'complete') return null;
      const pane = document.querySelector('#editorPane');
      const saveState = document.querySelector('#editorSaveState');
      if (!pane || pane.hidden || !saveState || !saveState.textContent.includes('未保存')) return null;
      const active = document.querySelector('#tabList .tab.active .tab-title');
      if (!active || !active.textContent.includes('MDTurn桌面真实回归.md')) return null;
      const raw = localStorage.getItem(${JSON.stringify(`mdturn.draft.${opened.review.id}`)});
      return raw && JSON.parse(raw).content === ${JSON.stringify(draftContent)};
    })()`));
    assert.ok(chrome.cdp.dialogs.some((dialog) => dialog.type === 'beforeunload'),
      'dirty reload 应触发 beforeunload 防误关保护');

    const saveShortcut = await chrome.cdp.evaluate(`(() => {
      const event = new KeyboardEvent('keydown', {
        key: 's', code: 'KeyS', metaKey: true, bubbles: true, cancelable: true,
      });
      const dispatched = document.dispatchEvent(event);
      return { defaultPrevented: event.defaultPrevented, dispatched };
    })()`);
    assert.deepEqual(saveShortcut, { defaultPrevented: true, dispatched: false }, 'Cmd+S 应触发恢复草稿保存');
    await waitUntil('恢复草稿安全保存到源文件', () => {
      try { return fs.readFileSync(source, 'utf8') === draftContent; }
      catch (_) { return false; }
    });
    await waitUntil('保存后清除 dirty 草稿', () => chrome.cdp.evaluate(`(() =>
      document.querySelector('#editorSaveState').textContent.includes('所有更改均已保存') &&
      !localStorage.getItem(${JSON.stringify(`mdturn.draft.${opened.review.id}`)})
    )()`));

    // Resolve both open notes only after the source save, then complete the
    // applying session through the desktop controls.
    for (const expectedOpen of [1, 0]) {
      await chrome.cdp.click('#openNotesList .note-actions button.resolve');
      await waitUntil(`手工处理批注，剩余 ${expectedOpen}`, () => {
        const count = store.readAnnotations(source).annotations.filter((note) => (note.status || 'open') === 'open').length;
        return count === expectedOpen;
      });
    }
    await chrome.cdp.click('#finishManualButton');
    await waitUntil('完成手工修改确认框', () => chrome.cdp.evaluate(
      `!document.querySelector('#confirmDialog').hidden && document.querySelector('#confirmTitle').textContent.includes('提交本轮修改')`,
    ));
    await chrome.cdp.click('#confirmAccept');
    await waitUntil('手工编辑闭环完成', async () => {
      const review = await store.getReviewById(opened.review.id, { dataDir });
      return review && review.status === 'complete' &&
        chrome.cdp.evaluate(`document.querySelector('#reviewStateText').textContent.includes('修改已完成')`);
    });

    assert.equal(newestNote.anchorVersion, 3);
    assert.equal(chrome.cdp.exceptions.length, 0, `页面不应有未捕获异常：${chrome.cdp.exceptions.join(' | ')}`);
    assert.equal(chrome.cdp.consoleErrors.length, 0, `页面不应打印 console.error：${chrome.cdp.consoleErrors.join(' | ')}`);

    console.log('PASS: MDTurn /desktop 真实 Chrome UI smoke 通过');
    console.log(JSON.stringify({
      viewportWidth: chrome.viewportWidth,
      titlebarDragRegion: 'PASS',
      recentOpen: 'PASS',
      outlineNavigation: 'PASS',
      editorOutlineNavigation: 'PASS',
      nativeCdpMouseSelection: 'PASS',
      headingSelection: 'PASS',
      paragraphSelection: 'PASS',
      listSelection: 'PASS',
      tableCellSelection: 'PASS',
      fencedCodeSelection: 'PASS',
      v3CrossParagraphSelection: 'PASS',
      exactCssHighlight: 'PASS',
      thirdParagraphExcluded: 'PASS',
      markerAtSelectionStart: 'PASS',
      markerAfterRailResize: 'PASS',
      draggableAnnotationDialog: 'PASS',
      annotationEdit: 'PASS',
      openNewestFirst: 'PASS',
      responsiveAnnotationRail: 'PASS',
      historyCollapsedAndBodyHidden: 'PASS',
      historicalAnnotations: HISTORY_COUNT,
      crossDirectoryAsset: 'PASS',
      dialogSessionBinding: 'PASS',
      crossTabUiIsolation: 'PASS',
      dialogShortcutGuards: 'PASS',
      activePushAgentState: 'PASS',
      activePushCompletion: 'PASS',
      activePushElapsedMs,
      activePushIdempotentNotification: 'PASS',
      activePushTargetIsolation: 'PASS',
      closedTabCompletionNotification: 'PASS',
      dirtyDraftReload: 'PASS',
      manualApplyClosedLoop: 'PASS',
      persistedAnnotations: store.readAnnotations(source).annotations.length,
    }));
  } finally {
    if (chrome) chrome.cdp.close();
    await stopChild(chrome && chrome.child);
    await stopChild(server && server.child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
