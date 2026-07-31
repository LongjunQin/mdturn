#!/usr/bin/env node
'use strict';

// 零 npm 依赖的真实 Chrome DOM Selection 回归。
// 启动隔离 md-read 服务和 headless Chrome，验证选区、批注弹窗、落盘行号及高亮范围。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const store = require('../lib/review-store');

const PROJECT = path.resolve(__dirname, '..');
const STEP_TIMEOUT = 10_000;
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
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FAIL: CDP WebSocket 连接超时')), STEP_TIMEOUT);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('FAIL: CDP WebSocket 连接失败')); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => { this.onMessage(event).catch(() => {}); });
    this.socket.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer); reject(new Error('FAIL: CDP WebSocket 提前关闭'));
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
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`FAIL: CDP ${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params && message.params.exceptionDetails;
      this.exceptions.push((detail && (detail.text || (detail.exception && detail.exception.description))) || 'unknown exception');
    }
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`FAIL: CDP 未连接，无法执行 ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`FAIL: CDP 命令超时: ${method}`));
      }, STEP_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (response.exceptionDetails) {
      const detail = response.exceptionDetails;
      throw new Error(`FAIL: 页面脚本异常: ${detail.text || (detail.exception && detail.exception.description) || 'unknown'}`);
    }
    return response.result && response.result.value;
  }

  async click(selector) {
    const rect = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('missing element: ' + ${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      if (el.hidden || r.width <= 0 || r.height <= 0) throw new Error('element not clickable: ' + ${JSON.stringify(selector)});
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function startServer(root, dataDir, docRoot) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT,
    env: { ...process.env, MDREAD_DATA_DIR: dataDir, MDREAD_PORT: '0' },
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
    } catch (_) { return null; }
  });
  return { child, port, stderr: () => stderr, root };
}

async function startChrome(profileDir) {
  const child = spawn(chromeExecutable(), [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--disable-translate', '--disable-gpu',
    '--disable-features=MediaRouter,OptimizationHints,Translate', '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const port = await waitUntil('Chrome DevTools 端口', () => {
    if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}: ${stderr}`);
    try {
      const value = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch (_) { return null; }
  });
  const target = await waitUntil('Chrome 页面 target', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) || null;
    } catch (_) { return null; }
  });
  const cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  return { child, cdp, stderr: () => stderr };
}

async function selectRange(cdp, startSelector, endSelector, endMode) {
  const selected = await cdp.evaluate(`(() => {
    const start = document.querySelector(${JSON.stringify(startSelector)});
    const end = document.querySelector(${JSON.stringify(endSelector)});
    if (!start || !end) throw new Error('selection endpoint missing');
    const textNode = (root, last) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.nodeValue && node.nodeValue.length
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      let found = null, next;
      while ((next = walker.nextNode())) { found = next; if (!last) break; }
      return found;
    };
    const startText = textNode(start, false);
    const endText = textNode(end, true);
    if (!startText || !endText) throw new Error('selection text endpoint missing');
    const range = document.createRange();
    range.setStart(startText, 0);
    range.setEnd(endText, ${JSON.stringify(endMode)} === 'offset0' ? 0 : endText.nodeValue.length);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    return { text: selection.toString(), collapsed: selection.isCollapsed };
  })()`);
  assert.equal(selected.collapsed, false, `选区不应折叠: ${startSelector} -> ${endSelector}`);
  await waitUntil('黄色批注按钮显示', () => cdp.evaluate('!document.querySelector("#annotBtn").hidden'));
  return selected.text;
}

async function openAnnotationSheet(cdp) {
  await cdp.click('#annotBtn');
  await waitUntil('批注输入框弹出', () => cdp.evaluate('!document.querySelector("#sheet").hidden'));
  return cdp.evaluate('document.querySelector("#sheetQuote").textContent');
}

async function cancelAnnotation(cdp) {
  await cdp.click('#sheetCancel');
  await waitUntil('批注输入框关闭', () => cdp.evaluate('document.querySelector("#sheet").hidden'));
}

async function saveAnnotation(cdp, source, comment, expectedCount) {
  await cdp.evaluate(`(() => {
    const input = document.querySelector('#sheetText');
    input.value = ${JSON.stringify(comment)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await cdp.click('#sheetSave');
  await waitUntil(`保存批注 ${comment}`, () => {
    try {
      const notes = store.readAnnotations(source).annotations;
      return notes.length === expectedCount && notes.some((note) => note.comment === comment) ? notes : null;
    } catch (_) { return null; }
  });
  await waitUntil('保存后批注框关闭', () => cdp.evaluate('document.querySelector("#sheet").hidden'));
  return store.readAnnotations(source).annotations.find((note) => note.comment === comment);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdread-selection-smoke-'));
  const dataDir = path.join(root, '.mdread');
  const docRoot = path.join(root, 'docs');
  const profileDir = path.join(root, 'chrome-profile');
  const source = path.join(docRoot, '真实选区回归.md');
  const fencedText = [
    '第一轮：第二章 + 第三章',
    '工程实证链与一号装置',
    '',
    '第二轮：第四章 + 第五章',
    '执行基础与产业化',
  ].join('\n');
  let server = null, chrome = null;

  try {
    fs.mkdirSync(docRoot, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(source, [
      '# <span id="heading-case">完整标题选区</span>',
      '',
      '<span id="next-case">标题之后的自然段不应被高亮。</span>',
      '',
      '<p id="raw-html-case">原始 HTML 段落可以正常打开批注框。</p>',
      '',
      '```text',
      fencedText,
      '```',
      '',
      '<span id="cross-one">跨段选区的第一段，应该高亮。</span>',
      '',
      '<span id="cross-two">跨段选区的第二段，也应该高亮。</span>',
      '',
      '<span id="cross-three">跨段选区之后的第三段，不应被高亮。</span>',
      '',
      '- <span id="list-case">列表项中的文字也可以打开批注框。</span>',
      '',
    ].join('\n'), 'utf8');
    store.ensureDataDir({ dataDir });
    // 模拟第一轮审阅已经全部处理：sidecar 中历史已处理记录在前。
    // 第二轮通过页面新增 open 后，列表应将 open 整组提到前面，
    // 同时两个状态组内都必须保留 sidecar 中的相对顺序。
    await store.mutateAnnotations(source, (data) => {
      data.annotations.push(
        {
          id: 'applied-first', author: '我(本机)', createdAt: '2026-07-13T08:00:00.000Z',
          comment: '第一轮已处理 1', quote: '完整标题选区', lineStart: 1, lineEnd: 1,
          status: 'applied', appliedAt: '2026-07-13T09:00:00.000Z', appliedBy: 'codex',
        },
        {
          id: 'applied-second', author: '我(本机)', createdAt: '2026-07-13T08:01:00.000Z',
          comment: '第一轮已处理 2', quote: '原始 HTML 段落', lineStart: 5, lineEnd: 5,
          status: 'applied', appliedAt: '2026-07-13T09:01:00.000Z', appliedBy: 'codex',
        },
      );
    });
    const opened = await store.openReview(source, { dataDir });
    server = await startServer(root, dataDir, docRoot);
    chrome = await startChrome(profileDir);
    const url = `http://127.0.0.1:${server.port}/r/${encodeURIComponent(opened.review.id)}`;
    await chrome.cdp.send('Page.navigate', { url });
    await waitUntil('审阅页正文渲染完成', () => chrome.cdp.evaluate(`(() => {
      const raw = document.querySelector('#raw-html-case');
      const state = document.querySelector('#reviewState');
      return document.readyState === 'complete' && raw && raw.dataset.lineStart &&
        state && state.textContent.includes('审阅中');
    })()`));

    const mapped = await chrome.cdp.evaluate(`(() => {
      const block = (selector) => document.querySelector(selector).closest('[data-line-start]');
      const result = {};
      for (const key of ['heading-case','next-case','raw-html-case','cross-one','cross-two','cross-three','list-case']) {
        const node = block('#' + key);
        if (!node) throw new Error('missing mapped block: ' + key);
        result[key] = { start: Number(node.dataset.lineStart), end: Number(node.dataset.lineEnd), tag: node.tagName };
      }
      return result;
    })()`);

    // 1. 原始 HTML <p> 曾没有 line map，长选区点黄色按钮会“消失”。
    await selectRange(chrome.cdp, '#raw-html-case', '#raw-html-case', 'end');
    const rawQuote = await openAnnotationSheet(chrome.cdp);
    assert.match(rawQuote, /原始 HTML 段落/, '原始 HTML <p> 应打开并显示批注选文');
    await cancelAnnotation(chrome.cdp);

    // 2. fenced code 在 DOM 中是同一个 <pre><code> 块：真实跨行选区后
    // 黄色批注按钮不得消失，批注框必须保留完整多行选文。
    const fencedCode = await chrome.cdp.evaluate(`(() => {
      const code = document.querySelector('#content pre code');
      if (!code) throw new Error('fenced code block missing');
      const mapped = code.closest('[data-line-start]');
      return {
        text: code.textContent,
        lineStart: mapped && mapped.dataset.lineStart,
        lineEnd: mapped && mapped.dataset.lineEnd,
      };
    })()`);
    assert.equal(fencedCode.text, `${fencedText}\n`, '围栏代码块的渲染文本前提失效');
    assert.ok(fencedCode.lineStart && fencedCode.lineEnd, '围栏代码块必须具有源文行号映射');
    const selectedFence = await selectRange(
      chrome.cdp,
      '#content pre code',
      '#content pre code',
      'end',
    );
    assert.equal(selectedFence.trim(), fencedText, '应完整选中 fenced code block 内的多行文字');
    assert.match(selectedFence, /\n/, '回归选区必须真实跨行');
    assert.equal(
      await chrome.cdp.evaluate(`(() => {
        const button = document.querySelector('#annotBtn');
        return Boolean(button && !button.hidden && button.getClientRects().length);
      })()`),
      true,
      'fenced code block 跨行选区后 #annotBtn 应显示',
    );
    const fencedQuote = await openAnnotationSheet(chrome.cdp);
    assert.equal(
      fencedQuote,
      `“${fencedText}”`,
      '批注框必须保留 fenced code block 的完整多行选文',
    );
    await cancelAnnotation(chrome.cdp);
    assert.equal(store.readAnnotations(source).annotations.length, 2, '取消 fenced code block 批注不应落盘');

    // 3. Chrome 选完整标题时，Range 终点可落在下一段 offset=0。
    const titleSelection = await selectRange(chrome.cdp, '#heading-case', '#next-case', 'offset0');
    assert.equal(titleSelection.trim(), '完整标题选区');
    await openAnnotationSheet(chrome.cdp);
    const titleNote = await saveAnnotation(chrome.cdp, source, '标题终点 offset0 回归', 3);
    assert.equal(titleNote.lineStart, mapped['heading-case'].start);
    assert.equal(titleNote.lineEnd, mapped['heading-case'].end, '标题批注不得把下一段纳入 lineEnd');
    assert.equal(titleNote.anchorVersion, 2, '新批注应标记精确选区协议版本');
    const titleHighlight = await chrome.cdp.evaluate(`(() => ({
      heading: document.querySelector('#heading-case').closest('[data-line-start]').classList.contains('note-block'),
      next: document.querySelector('#next-case').closest('[data-line-start]').classList.contains('note-block'),
    }))()`);
    assert.equal(titleHighlight.heading, true, '标题本身应高亮');
    assert.equal(titleHighlight.next, false, '标题后的自然段不应高亮');

    // 4. 真实跨两个自然段：保存两段，不得多高亮第三段。
    await selectRange(chrome.cdp, '#cross-one', '#cross-two', 'end');
    await openAnnotationSheet(chrome.cdp);
    const crossNote = await saveAnnotation(chrome.cdp, source, '跨两段选区回归', 4);
    assert.equal(crossNote.lineStart, mapped['cross-one'].start);
    assert.equal(crossNote.lineEnd, mapped['cross-two'].end);
    const crossHighlight = await chrome.cdp.evaluate(`(() => ({
      first: document.querySelector('#cross-one').closest('[data-line-start]').classList.contains('note-block'),
      second: document.querySelector('#cross-two').closest('[data-line-start]').classList.contains('note-block'),
      third: document.querySelector('#cross-three').closest('[data-line-start]').classList.contains('note-block'),
    }))()`);
    assert.deepEqual(crossHighlight, { first: true, second: true, third: false }, '跨段高亮边界错误');

    // 5. 列表是非普通 <p> 的常见场景，也必须能打开批注框。
    await selectRange(chrome.cdp, '#list-case', '#list-case', 'end');
    const listQuote = await openAnnotationSheet(chrome.cdp);
    assert.match(listQuote, /列表项中的文字/, '列表选区应打开批注框');
    await cancelAnnotation(chrome.cdp);

    // 6. 第二轮的未处理批注应排在第一轮历史批注之前；同状态组内顺序不变。
    // sidecar 实际顺序是 applied 1/2 -> open 1/2，用于确认页面确实做了稳定分组。
    assert.deepEqual(
      store.readAnnotations(source).annotations.map((note) => note.comment),
      ['第一轮已处理 1', '第一轮已处理 2', '标题终点 offset0 回归', '跨两段选区回归'],
      '回归前提失效：sidecar 原始顺序不符合测试设计',
    );
    await chrome.cdp.click('#btnNotes');
    await waitUntil('批注列表打开', () => chrome.cdp.evaluate('document.querySelector("#notesPanel").classList.contains("open")'));
    const renderedNotes = await chrome.cdp.evaluate(`Array.from(document.querySelectorAll('#notesList .note-card')).map((card) => ({
      id: card.id,
      comment: card.querySelector('.nc').textContent,
      status: card.querySelector('.nbadge').textContent,
    }))`);
    assert.deepEqual(
      renderedNotes.map((note) => note.comment),
      ['标题终点 offset0 回归', '跨两段选区回归', '第一轮已处理 1', '第一轮已处理 2'],
      '批注列表应先显示未处理，并保留同状态批注的相对顺序',
    );
    assert.deepEqual(
      renderedNotes.map((note) => note.status),
      ['未处理', '未处理', '已处理', '已处理'],
      '批注状态分组顺序错误',
    );

    const persisted = store.readAnnotations(source).annotations;
    assert.equal(persisted.length, 4, '取消的 HTML/列表批注不应落盘');
    assert.equal(chrome.cdp.exceptions.length, 0, `页面不应出现未捕获异常: ${chrome.cdp.exceptions.join(' | ')}`);

    console.log('PASS: 真实 Chrome DOM Selection 回归通过');
    console.log(JSON.stringify({
      rawHtmlDialog: 'PASS', fencedCodeSelection: 'PASS', titleOffset0Boundary: 'PASS', crossParagraphBoundary: 'PASS',
      listDialog: 'PASS', openNotesFirst: 'PASS', stableStatusOrder: 'PASS',
      persistedAnnotations: persisted.length,
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
