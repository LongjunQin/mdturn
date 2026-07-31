'use strict';
/* md-read 前端：分享链接 /d/<id>?k=、本地冻结审阅 /r/<sessionId>、兼容浏览 /browse。 */

(function () {
  const $ = (selector) => document.querySelector(selector);
  const content = $('#content'), fileListEl = $('#fileList'), docTitle = $('#docTitle');
  const noteCount = $('#noteCount'), annotBtn = $('#annotBtn');
  const sheet = $('#sheet'), sheetQuote = $('#sheetQuote'), sheetText = $('#sheetText');
  const sheetSave = $('#sheetSave'), sheetCancel = $('#sheetCancel');
  const notesPanel = $('#notesPanel'), notesList = $('#notesList');
  const reviewBanner = $('#reviewBanner'), reviewState = $('#reviewState'), reviewHint = $('#reviewHint');
  const submitReview = $('#submitReview');

  const linkMatch = location.pathname.match(/^\/d\/([A-Za-z0-9_-]+)/);
  const reviewMatch = location.pathname.match(/^\/r\/([^/]+)/);
  const MODE = linkMatch ? 'link' : reviewMatch ? 'review' : 'browse';
  const LINK_ID = linkMatch ? linkMatch[1] : null;
  const REVIEW_ID = reviewMatch ? decodeURIComponent(reviewMatch[1]) : null;
  const KEY = new URLSearchParams(location.search).get('k') || '';

  let currentPath = null;
  let viewerName = MODE === 'review' ? '我(本机)' : '';
  let annotations = [], pendingAnchor = null, editingNoteId = null, filterOpenOnly = false;
  let cachedSelectionAnchor = null, selectionFrame = null;
  let review = null, readOnly = MODE === 'review', savePending = false, submitPending = false;
  let browseLoadId = 0, reviewRefreshPending = false;

  const esc = (value) => String(value == null ? '' : value).replace(/[&<>\"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;',
  }[c]));
  const posixDir = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  function posixJoin(base, rel) {
    const stack = base ? base.split('/') : [];
    for (const part of rel.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') stack.pop(); else stack.push(part);
    }
    return stack.join('/');
  }
  function docQS(extra, browsePath) {
    const params = new URLSearchParams();
    if (MODE === 'link') { params.set('d', LINK_ID); params.set('k', KEY); }
    else if (MODE === 'review') params.set('r', REVIEW_ID);
    else params.set('path', browsePath === undefined ? (currentPath || '') : browsePath);
    if (extra) Object.keys(extra).forEach((key) => params.set(key, extra[key]));
    return params.toString();
  }
  function requestId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  function toast(message, long) {
    const el = document.createElement('div'); el.className = 'toast'; el.textContent = message;
    el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el); setTimeout(() => el.remove(), long ? 4200 : 1900);
  }

  class ApiError extends Error {
    constructor(message, status, code, kind) {
      super(message); this.status = status || 0; this.code = code || ''; this.kind = kind || '';
    }
  }
  async function fetchResponse(url, options) {
    try {
      return await fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options));
    } catch (_) {
      throw new ApiError('md-read 服务不可达。', 0, 'unreachable', 'network');
    }
  }
  async function requestJson(url, options) {
    const response = await fetchResponse(url, options);
    const type = response.headers.get('content-type') || '';
    let body = null;
    if (type.includes('application/json')) {
      try { body = await response.json(); }
      catch (_) { throw new ApiError('服务返回了损坏的 JSON。', response.status, 'bad_json', 'response'); }
    }
    if (!response.ok) {
      throw new ApiError(
        (body && (body.message || body.error)) || ('请求失败（HTTP ' + response.status + '）'),
        response.status, body && body.error, type.includes('text/html') ? 'html' : 'response'
      );
    }
    if (!type.includes('application/json')) {
      throw new ApiError('服务返回了非 JSON 响应。', response.status, 'unexpected_response', type.includes('text/html') ? 'html' : 'response');
    }
    return body;
  }
  async function requestText(url, options) {
    const response = await fetchResponse(url, options);
    const type = response.headers.get('content-type') || '';
    if (!response.ok) {
      let detail = '';
      if (type.includes('application/json')) {
        try { const body = await response.json(); detail = body.message || body.error || ''; } catch (_) {}
      }
      throw new ApiError(detail || ('读取失败（HTTP ' + response.status + '）'), response.status, '', type.includes('text/html') ? 'html' : 'response');
    }
    if (type.includes('text/html')) throw new ApiError('收到网页错误页，而不是 Markdown。', response.status, 'unexpected_html', 'html');
    if (!(type.includes('text/') || type.includes('application/octet-stream'))) {
      throw new ApiError('服务返回了无法识别的文档格式。', response.status, 'unexpected_type', 'response');
    }
    return response.text();
  }
  function friendlyError(error, action) {
    if (MODE === 'link' && (error.status === 0 || error.kind === 'html')) {
      return '公网入口可能已变化，请重新生成分享链接。';
    }
    if (MODE === 'link' && error.status >= 500) return '服务器处理失败，请联系分享者检查 md-read 日志。';
    if (error.code === 'source_changed') return '源文档已变化：当前批注对应旧版本，已停止写入。';
    if (error.code === 'review_read_only' || error.status === 423) return '本轮审阅已提交，现在不能再修改批注。';
    if (error.status === 401) return '分享链接无效或已经过期，请重新生成链接。';
    if (error.status === 0) return '本地 md-read 服务不可达。';
    return (action || '操作') + '失败：' + (error.message || '未知错误');
  }
  function handleMutationError(error, action) {
    if (MODE === 'review' && error.code === 'source_changed') {
      review = Object.assign({}, review, { status: 'conflict' });
      updateReviewUI();
    }
    if (MODE === 'review' && (error.code === 'review_read_only' || error.status === 423)) {
      setTimeout(() => refreshReviewState({ reloadAnnotations: true, silent: true }).catch(() => {}), 0);
    }
    toast(friendlyError(error, action), true);
  }

  const texmath = window.texmath || window.markdownitTexmath || window['markdown-it-texmath'];
  const md = window.markdownit({
    html: true, linkify: true, breaks: false,
    highlight: (source, lang) => {
      if (lang === 'mermaid') return '';
      if (lang && window.hljs && window.hljs.getLanguage(lang)) {
        try { return '<pre class="hljs"><code class="language-' + lang + '">' + window.hljs.highlight(source, { language: lang, ignoreIllegals: true }).value + '</code></pre>'; }
        catch (_) {}
      }
      return '';
    },
  });
  if (texmath && window.katex) {
    try { md.use(texmath, { engine: window.katex, delimiters: 'dollars', katexOptions: { throwOnError: false, strict: false } }); }
    catch (error) { console.warn('texmath:', error); }
  }
  (function addLineMap() {
    const htmlBlockRule = md.renderer.rules.html_block;
    md.renderer.rules.html_block = function (tokens, index, options, env, self) {
      const token = tokens[index];
      const html = htmlBlockRule
        ? htmlBlockRule.call(this, tokens, index, options, env, self)
        : token.content;
      if (!token.map || /^\s*<[A-Za-z][^>]*\bdata-line-start\s*=/i.test(html)) return html;
      const start = token.map[0] + 1, end = token.map[1];
      // html_block 是 nesting=0，attrSet 不会进入原始 HTML；把行号加到实际根元素。
      // 当前报告大量使用单行 <p style=...>，必须映射后才能选中批注。
      return html.replace(/^(\s*<[A-Za-z][\w:-]*)(?=[\s>])/, 
        '$1 data-line-start="' + start + '" data-line-end="' + end + '"');
    };
    const fenceRule = md.renderer.rules.fence;
    md.renderer.rules.fence = function (tokens, index, options, env, self) {
      const token = tokens[index];
      const html = fenceRule.call(this, tokens, index, options, env, self);
      // highlight() may return a complete <pre> block, in which case
      // markdown-it skips token attributes.  Put the source-line map back on
      // the rendered fence so code selections can still become annotations.
      if (!token.map || /\bdata-line-start\s*=/.test(html)) return html;
      const start = token.map[0] + 1, end = token.map[1];
      return html.replace(/^(\s*<pre)(?=[\s>])/i,
        '$1 data-line-start="' + start + '" data-line-end="' + end + '"');
    };
    const original = md.renderer.render.bind(md.renderer);
    md.renderer.render = function (tokens, options, env) {
      for (const token of tokens) {
        if (token.map && (token.nesting === 1 || token.type === 'fence' || token.type === 'code_block')) {
          token.attrSet('data-line-start', String(token.map[0] + 1));
          token.attrSet('data-line-end', String(token.map[1]));
        }
      }
      return original(tokens, options, env);
    };
  })();
  if (window.mermaid) {
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: dark ? 'dark' : 'default' });
  }

  async function renderDoc(source, base, options = {}) {
    const target = document.createElement('div');
    target.innerHTML = md.render(source);
    target.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (/^(https?:|data:|\/)/i.test(src)) return;
      img.setAttribute('src', '/api/file?' + docQS({ path: posixJoin(base, src) }, options.browsePath));
      img.setAttribute('loading', 'lazy');
    });
    target.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href');
      if (/^(https?:|mailto:|tel:|#)/i.test(href)) {
        if (/^https?:/i.test(href)) { anchor.target = '_blank'; anchor.rel = 'noopener'; }
        return;
      }
      if (MODE === 'browse' && /\.md(\?|#|$)/i.test(href)) {
        const target = posixJoin(base, href.replace(/[?#].*$/, ''));
        anchor.addEventListener('click', (event) => { event.preventDefault(); openDoc(target); });
      } else {
        anchor.setAttribute('href', '/api/file?' + docQS({ path: posixJoin(base, href) }, options.browsePath));
        anchor.target = '_blank';
      }
    });
    await renderMermaid(target);
    if (options.isStale && options.isStale()) return false;
    const nextAnnotations = await fetchAnnotations(options.browsePath);
    if (options.isStale && options.isStale()) return false;
    cachedSelectionAnchor = null;
    annotBtn.hidden = true;
    content.replaceChildren(...target.childNodes);
    annotations = nextAnnotations;
    applyMarkers();
    window.scrollTo(0, 0);
    return true;
  }
  async function renderMermaid(root = content) {
    const nodes = [];
    root.querySelectorAll('code.language-mermaid').forEach((code) => {
      const target = code.closest('pre') || code;
      const div = document.createElement('div'); div.className = 'mermaid'; div.textContent = code.textContent;
      target.replaceWith(div); nodes.push(div);
    });
    if (nodes.length && window.mermaid) {
      try { await window.mermaid.run({ nodes }); } catch (error) { console.warn(error); }
    }
  }

  function headingPath(block) {
    if (!block) return [];
    let stack = [];
    content.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
      if (block.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) {
        const level = +heading.tagName[1];
        stack = stack.filter((item) => item.level < level);
        const copy = heading.cloneNode(true);
        copy.querySelectorAll('.note-flag').forEach((flag) => flag.remove());
        stack.push({ level, text: copy.textContent.trim() });
      }
    });
    return stack.map((item) => item.text);
  }
  function figureRefOf(block, quote) {
    for (const text of [quote || '', block ? block.textContent : '']) {
      const match = text.match(/(图|表|Figure|Fig\.?|Table)\s*[\d０-９][\d０-９.\-—－]*/i);
      if (match) return match[0].replace(/\s+/g, ' ').trim();
    }
    return null;
  }
  function cleanFigureRef(value) {
    if (value == null) return '';
    const text = String(value).trim();
    return /^(null|undefined)$/i.test(text) ? '' : text;
  }
  function textBeforeRangePoint(block, container, offset) {
    if (!block || !container) return '';
    try {
      const range = document.createRange();
      range.selectNodeContents(block);
      range.setEnd(container, offset);
      return range.toString();
    } catch (_) { return ''; }
  }
  function textAfterRangePoint(block, container, offset) {
    if (!block || !container) return '';
    try {
      const range = document.createRange();
      range.selectNodeContents(block);
      range.setStart(container, offset);
      return range.toString();
    } catch (_) { return ''; }
  }
  function intersectRangeWithBlock(range, block) {
    try {
      if (!range.intersectsNode(block)) return null;
      const blockRange = document.createRange();
      blockRange.selectNodeContents(block);
      const intersection = document.createRange();
      if (range.compareBoundaryPoints(Range.START_TO_START, blockRange) >= 0) {
        intersection.setStart(range.startContainer, range.startOffset);
      } else {
        intersection.setStart(blockRange.startContainer, blockRange.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, blockRange) <= 0) {
        intersection.setEnd(range.endContainer, range.endOffset);
      } else {
        intersection.setEnd(blockRange.endContainer, blockRange.endOffset);
      }
      return !intersection.collapsed && intersection.toString().trim() ? intersection : null;
    } catch (_) { return null; }
  }
  function selectedMappedBlocks(range) {
    const selected = [];
    for (const block of mappedLeafBlocks()) {
      const intersection = intersectRangeWithBlock(range, block);
      if (intersection) selected.push({ block, intersection });
    }
    return selected;
  }
  function captureAnchor() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || readOnly) return null;
    const quote = selection.toString().trim();
    if (!quote || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;
    // 浏览器在“选完整段/标题”时，Range 终点常落到下一块 offset=0 或外层容器。
    // 只认真正贡献了非空选中文字的叶级块，避免把下一自然段误记进 lineEnd。
    const selected = selectedMappedBlocks(range);
    if (!selected.length) return null;
    const first = selected[0], last = selected[selected.length - 1];
    const startBlock = first.block, endBlock = last.block;
    const prefix = textBeforeRangePoint(startBlock,
      first.intersection.startContainer, first.intersection.startOffset).slice(-30);
    const suffix = textAfterRangePoint(endBlock,
      last.intersection.endContainer, last.intersection.endOffset).slice(0, 30);
    return {
      quote: quote.slice(0, 600), prefix, suffix,
      lineStart: +startBlock.dataset.lineStart,
      lineEnd: +endBlock.dataset.lineEnd,
      anchorVersion: 2,
      headingPath: headingPath(startBlock), figureRef: figureRefOf(startBlock, quote),
    };
  }
  document.addEventListener('selectionchange', () => {
    annotBtn.hidden = true;
    if (selectionFrame) cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = null;
      if (readOnly || !sheet.hidden) return;
      const nextAnchor = captureAnchor();
      if (nextAnchor) {
        cachedSelectionAnchor = nextAnchor;
        annotBtn.hidden = false;
      }
    });
  });
  function activateAnnotation() {
    const anchor = captureAnchor() || cachedSelectionAnchor;
    if (!anchor) {
      annotBtn.hidden = true;
      toast('没有识别到有效文字选区，请重新选中文字；不要只选空白或图片。', true);
      return;
    }
    cachedSelectionAnchor = null;
    openSheet(anchor);
  }
  annotBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    activateAnnotation();
  });
  annotBtn.addEventListener('click', (event) => {
    // pointerdown 已打开时 click 只做去重；某些触控/选区手势只会交付 click。
    if (!sheet.hidden) return;
    event.preventDefault();
    activateAnnotation();
  });
  function openSheet(anchor, annotation) {
    if (readOnly) return;
    pendingAnchor = annotation ? null : anchor;
    editingNoteId = annotation ? annotation.id : null;
    cachedSelectionAnchor = null;
    annotBtn.hidden = true;
    const figureRef = cleanFigureRef((annotation || anchor).figureRef);
    sheetQuote.textContent = '“' + ((annotation || anchor).quote || '') + '”' + (figureRef ? '  〔' + figureRef + '〕' : '');
    $('#sheetTitle').textContent = annotation ? '编辑批注' : '添加批注';
    sheetText.value = annotation ? (annotation.comment || '') : '';
    sheetSave.textContent = annotation ? '保存修改' : '保存批注';
    sheet.hidden = false; sheet.inert = false; sheet.setAttribute('aria-hidden', 'false');
    setTimeout(() => sheetText.focus(), 50);
  }
  function closeSheet() {
    sheet.inert = true; sheet.setAttribute('aria-hidden', 'true'); sheet.hidden = true;
    pendingAnchor = null; editingNoteId = null;
    $('#sheetTitle').textContent = '添加批注';
    sheetText.value = ''; sheetSave.textContent = '保存批注';
  }
  sheetCancel.addEventListener('click', () => {
    const focusId = editingNoteId;
    closeSheet();
    if (focusId) openNotes(focusId);
  });
  sheetSave.addEventListener('click', saveNote);

  async function saveNote() {
    const comment = sheetText.value.trim();
    if (!comment) return toast('批注内容不能为空');
    const editId = editingNoteId;
    const isEditing = Boolean(editId);
    if ((!pendingAnchor && !isEditing) || savePending || readOnly) return;
    const clientRequestId = requestId();
    savePending = true; sheetSave.disabled = true; sheetCancel.disabled = true; sheetSave.textContent = '保存中…';
    try {
      if (isEditing) {
        const result = await requestJson('/api/annotations?' + docQS({ id: editId }), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment }),
        });
        if (!result.ok) throw new ApiError(result.message || '批注修改失败。', 200, result.error, 'response');
        const annotation = annotations.find((item) => item.id === editId);
        if (annotation) Object.assign(annotation, result.note || {}, { comment });
        closeSheet(); applyMarkers(); openNotes(editId); toast('已保存修改 ✅');
      } else {
        const payload = Object.assign({ comment, author: viewerName, clientRequestId }, pendingAnchor);
        if (MODE === 'review') {
          payload.reviewSessionId = REVIEW_ID;
          payload.sourceHash = review && review.sourceHash;
        }
        const result = await requestJson('/api/annotations?' + docQS(), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (!result.ok || !result.note) throw new ApiError(result.message || '服务未返回已保存的批注。', 200, result.error, 'response');
        if (!annotations.some((note) => note.id === result.note.id)) annotations.push(result.note);
        closeSheet(); window.getSelection().removeAllRanges(); applyMarkers(); toast('已保存批注 ✅');
      }
    } catch (error) { handleMutationError(error, '保存'); }
    finally {
      savePending = false; sheetSave.disabled = false; sheetCancel.disabled = false;
      sheetSave.textContent = sheet.hidden ? '保存批注' : (editingNoteId ? '保存修改' : '保存批注');
    }
  }

  async function fetchAnnotations(browsePath) {
    try {
      const result = await requestJson('/api/annotations?' + docQS(null, browsePath));
      return Array.isArray(result.annotations) ? result.annotations : [];
    } catch (error) {
      toast(friendlyError(error, '读取批注'), true);
      return [];
    }
  }
  function mappedLeafBlocks() {
    return Array.from(content.querySelectorAll('[data-line-start]')).filter((element) =>
      !element.querySelector('[data-line-start]'));
  }
  function lineRangeOf(element) {
    if (!element) return null;
    const start = Number(element.dataset.lineStart);
    const end = Number(element.dataset.lineEnd);
    if (!Number.isFinite(start)) return null;
    return { start, end: Number.isFinite(end) && end >= start ? end : start };
  }
  function annotationRange(annotation) {
    if (annotation.lineStart == null || annotation.lineStart === '') return null;
    const start = Number(annotation.lineStart);
    const storedEnd = annotation.lineEnd == null || annotation.lineEnd === '' ? NaN : Number(annotation.lineEnd);
    if (!Number.isFinite(start)) return null;
    return { start, end: Number.isFinite(storedEnd) && storedEnd >= start ? storedEnd : start };
  }
  function blocksOverlapping(range, leaves) {
    if (!range) return [];
    return leaves.filter((element) => {
      const blockRange = lineRangeOf(element);
      return blockRange && blockRange.start <= range.end && blockRange.end >= range.start;
    });
  }
  function blockForLine(line, leaves = mappedLeafBlocks()) {
    const target = Number(line);
    if (!Number.isFinite(target)) return null;
    return leaves.find((element) => {
      const range = lineRangeOf(element);
      return range && range.start <= target && range.end >= target;
    }) || null;
  }
  function normalizedText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }
  // v1 早期页面把跨段选区的 lineEnd 误存为首段末行。仅在 quote 以足够长的
  // 连续文本证明选区确实进入后续叶级 block 时，为显示推断 effectiveEnd；不回写 sidecar。
  function inferLegacyDisplayEnd(annotation, range, leaves) {
    const startIndex = leaves.findIndex((element) => {
      const blockRange = lineRangeOf(element);
      return blockRange && blockRange.start <= range.start && blockRange.end >= range.start;
    });
    if (startIndex < 0) return range.end;
    const startRange = lineRangeOf(leaves[startIndex]);
    const quote = normalizedText(annotation.quote);
    const startText = normalizedText(leaves[startIndex].textContent);
    if (!startRange) return range.end;
    // v1 也曾把“下一块 offset=0”误当成选区终点。短 quote 完全位于首块时，
    // 再用 suffix 确认它正好是下一块的开头；仅收窄显示，不回写 sidecar。
    const suffix = normalizedText(annotation.suffix);
    const nextText = leaves[startIndex + 1] ? normalizedText(leaves[startIndex + 1].textContent) : '';
    const suffixProbe = suffix.slice(0, Math.min(24, suffix.length));
    if (Number(annotation.anchorVersion || 0) < 2 && range.end > startRange.end &&
        quote && quote.length <= 240 && startText.includes(quote) &&
        suffixProbe.length >= 8 && nextText.startsWith(suffixProbe)) {
      return startRange.end;
    }
    if (range.end > startRange.end) return range.end;

    const leadLength = Math.min(24, quote.length);
    if (leadLength < 24 || !startText.includes(quote.slice(0, leadLength))) return range.end;

    let effectiveEnd = range.end;
    let cursor = leadLength;
    let matchedPreviousFullBlock = false;
    const limit = Math.min(leaves.length, startIndex + 9);
    for (let index = startIndex + 1; index < limit; index += 1) {
      const blockText = normalizedText(leaves[index].textContent);
      if (blockText.length < 24) break;
      const probe = blockText.slice(0, Math.min(48, blockText.length));
      const position = quote.indexOf(probe, cursor);
      if (position < 0) break;
      // 首个后续段之前可以还有首段的剩余文本；再往后必须在已匹配段后连续出现。
      if (matchedPreviousFullBlock && position - cursor > 2) break;
      const blockRange = lineRangeOf(leaves[index]);
      if (!blockRange) break;
      effectiveEnd = Math.max(effectiveEnd, blockRange.end);
      const fullMatch = quote.slice(position, position + blockText.length) === blockText;
      if (!fullMatch) break;
      cursor = position + blockText.length;
      matchedPreviousFullBlock = true;
    }
    return effectiveEnd;
  }
  function applyMarkers() {
    content.querySelectorAll('.note-flag').forEach((node) => node.remove());
    content.querySelectorAll('.note-block').forEach((node) => node.classList.remove('note-block'));
    const leaves = mappedLeafBlocks();
    const groups = new Map();
    annotations.forEach((annotation) => {
      const storedRange = annotationRange(annotation); if (!storedRange) return;
      const range = Object.assign({}, storedRange, {
        end: inferLegacyDisplayEnd(annotation, storedRange, leaves),
      });
      const covered = blocksOverlapping(range, leaves);
      const block = blockForLine(range.start, leaves) || covered[0];
      if (!block) return;
      if (annotation.status === 'open') covered.forEach((element) => element.classList.add('note-block'));
      const key = String(range.start);
      if (!groups.has(key)) groups.set(key, { block, list: [] });
      groups.get(key).list.push(annotation);
    });
    groups.forEach(({ block, list }) => {
      const hasOpen = list.some((annotation) => annotation.status === 'open');
      // 同一段既有历史批注又有新批注时，点段落标记应直接定位未处理项。
      const focusAnnotation = list.find((annotation) => annotation.status === 'open') || list[0];
      const flag = document.createElement('span');
      flag.className = 'note-flag' + (hasOpen ? '' : ' done');
      flag.textContent = (hasOpen ? '💬' : '✓') + (list.length > 1 ? list.length : '');
      flag.tabIndex = 0; flag.setAttribute('role', 'button');
      flag.setAttribute('aria-label', '打开这一段的 ' + list.length + ' 条批注');
      flag.addEventListener('click', () => openNotes(focusAnnotation.id));
      flag.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); openNotes(focusAnnotation.id);
      });
      block.appendChild(flag);
    });
    const open = annotations.filter((annotation) => annotation.status === 'open').length;
    noteCount.textContent = open + (annotations.length > open ? '/' + annotations.length : '');
    $('#btnNotes').setAttribute('aria-label', '批注列表，' + open + '条未处理，共' + annotations.length + '条');
    if (review) {
      review.openCount = open;
      review.counts = Object.assign({}, review.counts, { open });
    }
  }

  const NOTE_STATUS = {
    open: { text: '未处理', className: 'st-open' },
    applied: { text: '已处理', className: 'st-done' },
    wontfix: { text: '不改', className: 'st-skip' },
  };
  function openNotes(focusId) {
    notesList.innerHTML = '';
    // 新一轮的未处理批注必须在历史已处理记录之前；同状态保留原始顺序。
    const list = annotations
      .filter((annotation) => !filterOpenOnly || annotation.status === 'open')
      .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1));
    if (!list.length) {
      notesList.innerHTML = '<div class="empty-notes">' + (filterOpenOnly ? '没有未处理的批注。' : '本篇还没有批注。<br>选中正文一段文字 →「＋ 批注」。') + '</div>';
    }
    list.forEach((annotation) => {
      const state = NOTE_STATUS[annotation.status] || NOTE_STATUS.open;
      const figureRef = cleanFigureRef(annotation.figureRef);
      const hasLineRange = Number.isFinite(Number(annotation.lineStart)) && Number.isFinite(Number(annotation.lineEnd)) &&
        Number(annotation.lineEnd) > Number(annotation.lineStart);
      const locationText = (annotation.headingPath && annotation.headingPath.length ? annotation.headingPath.join(' › ') : '正文') +
        (annotation.lineStart ? ' · 第' + annotation.lineStart + (hasLineRange ? '–' + annotation.lineEnd : '') + '行' : '') +
        (figureRef ? ' · ' + figureRef : '');
      let actions = '';
      if (MODE === 'review') {
        if (!readOnly && annotation.status === 'open') actions = '<button data-act="edit">编辑</button><button data-act="del" class="ndel">删除</button>';
      } else {
        actions = (annotation.status === 'open' ? '<button data-act="edit">编辑</button><button data-act="done">标记已处理</button>' : '<button data-act="reopen">改回未处理</button>') +
          '<button data-act="del" class="ndel">删除</button>';
      }
      const card = document.createElement('div'); card.className = 'note-card'; card.id = 'card-' + annotation.id;
      card.innerHTML = '<div class="nhead"><span class="nauthor">' + esc(annotation.author || '匿名') + '</span>' +
        '<span class="nbadge ' + state.className + '">' + state.text + '</span></div>' +
        '<div class="nq">' + esc((annotation.quote || '').slice(0, 140)) + '</div>' +
        '<div class="nc">' + esc(annotation.comment || '') + '</div>' +
        (annotation.appliedNote ? '<div class="napplied">↳ ' + esc(annotation.appliedBy || '') + '：' + esc(annotation.appliedNote) + '</div>' : '') +
        '<div class="nm"><span class="nloc">' + esc(locationText) + '</span><span class="nact">' + actions + '</span></div>';
      const del = card.querySelector('[data-act="del"]'); if (del) del.addEventListener('click', () => delNote(annotation.id));
      const edit = card.querySelector('[data-act="edit"]'); if (edit) edit.addEventListener('click', () => editNote(annotation.id));
      const done = card.querySelector('[data-act="done"]'); if (done) done.addEventListener('click', () => setStatus(annotation.id, 'applied'));
      const reopen = card.querySelector('[data-act="reopen"]'); if (reopen) reopen.addEventListener('click', () => setStatus(annotation.id, 'open'));
      notesList.appendChild(card);
    });
    openNotesPanel();
    if (focusId) { const card = $('#card-' + focusId); if (card) card.scrollIntoView({ block: 'center' }); }
  }
  function editNote(id) {
    const annotation = annotations.find((item) => item.id === id);
    if (!annotation || annotation.status !== 'open') return toast('只能编辑未处理的批注。');
    if (readOnly) return toast('本轮审阅已提交，不能修改批注。');
    closeNotesPanel();
    openSheet(annotation, annotation);
  }
  async function setStatus(id, status) {
    if (MODE === 'review' || readOnly) return;
    try {
      const result = await requestJson('/api/annotations?' + docQS({ id }), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      });
      if (!result.ok) throw new ApiError(result.message || '状态更新失败。', 200, result.error, 'response');
      const annotation = annotations.find((item) => item.id === id); if (annotation) annotation.status = status;
      applyMarkers(); openNotes(id);
    } catch (error) { handleMutationError(error, '更新状态'); }
  }
  async function delNote(id) {
    if (readOnly) return toast('本轮审阅已提交，不能删除批注。');
    if (!window.confirm('确定删除这条批注吗？删除后无法撤销。')) return;
    try {
      const result = await requestJson('/api/annotations?' + docQS({ id }), { method: 'DELETE' });
      if (!result.ok) throw new ApiError(result.message || '删除失败。', 200, result.error, 'response');
      annotations = annotations.filter((annotation) => annotation.id !== id);
      applyMarkers(); openNotes();
    } catch (error) { handleMutationError(error, '删除'); }
  }

  const drawer = $('#drawer'), drawerMask = $('#drawerMask'), notesMask = $('#notesMask');
  const btnMenu = $('#btnMenu'), btnNotes = $('#btnNotes'), notesClose = $('#notesClose');
  function setPanelOpen(panel, mask, trigger, open) {
    panel.classList.toggle('open', open);
    panel.inert = !open;
    panel.setAttribute('aria-hidden', String(!open));
    mask.classList.toggle('open', open);
    mask.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }
  const openDrawer = () => {
    if (drawer.classList.contains('open')) return;
    setPanelOpen(drawer, drawerMask, btnMenu, true);
    setTimeout(() => { const first = fileListEl.querySelector('.file-item'); if (first) first.focus(); }, 0);
  };
  const closeDrawer = () => { setPanelOpen(drawer, drawerMask, btnMenu, false); btnMenu.focus(); };
  const openNotesPanel = () => {
    if (notesPanel.classList.contains('open')) return;
    setPanelOpen(notesPanel, notesMask, btnNotes, true);
    setTimeout(() => notesClose.focus(), 0);
  };
  const closeNotesPanel = () => { setPanelOpen(notesPanel, notesMask, btnNotes, false); btnNotes.focus(); };
  btnMenu.addEventListener('click', openDrawer);
  btnNotes.addEventListener('click', () => openNotes());
  $('#notesClose').addEventListener('click', closeNotesPanel);
  drawerMask.addEventListener('click', closeDrawer);
  notesMask.addEventListener('click', closeNotesPanel);
  const openFilter = $('#filterOpen');
  if (openFilter) openFilter.addEventListener('change', () => { filterOpenOnly = openFilter.checked; openNotes(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!sheet.hidden) {
      const focusId = editingNoteId;
      closeSheet();
      if (focusId) openNotes(focusId);
      else if (!annotBtn.hidden) annotBtn.focus();
      return;
    }
    if (notesPanel.classList.contains('open')) { closeNotesPanel(); return; }
    if (drawer.classList.contains('open')) closeDrawer();
  });

  const REVIEW_STATUS = {
    reviewing: ['🔒 审阅中', '文档已冻结；完成批注后请点“完成本轮审阅”。'],
    ready_to_apply: ['✓ 已提交', '等待 Codex 应用未处理批注，页面已转为只读。'],
    applying: ['⚙ 修改中', 'Codex 正在应用批注，页面已转为只读。'],
    complete: ['✓ 本轮已完成', '审阅冻结已经解除。'],
    conflict: ['⚠ 版本冲突', '源文档在审阅期间发生变化，已停止批注，请先处理冲突。'],
    cancelled: ['已取消', '本轮审阅已经人工解锁。'],
  };
  function updateReviewUI() {
    if (MODE !== 'review' || !review) return;
    const state = REVIEW_STATUS[review.status] || ['审阅状态未知', '请返回最近审阅页面检查。'];
    readOnly = review.status !== 'reviewing';
    reviewBanner.hidden = false;
    reviewBanner.dataset.status = review.status || 'unknown';
    reviewState.textContent = state[0]; reviewHint.textContent = state[1];
    submitReview.hidden = readOnly; submitReview.disabled = submitPending;
    document.body.classList.toggle('review-readonly', readOnly);
    if (readOnly) { annotBtn.hidden = true; closeSheet(); }
    if (notesPanel.classList.contains('open')) openNotes();
  }
  async function refreshReviewState(options = {}) {
    if (MODE !== 'review' || reviewRefreshPending || savePending || submitPending) return;
    reviewRefreshPending = true;
    try {
      const result = await requestJson('/api/review?' + docQS());
      if (!result.review) throw new ApiError('找不到该审阅会话。', 404, 'review_not_found', 'response');
      review = result.review;
      updateReviewUI();
      if (options.reloadAnnotations) {
        annotations = await fetchAnnotations();
        applyMarkers();
        if (notesPanel.classList.contains('open')) openNotes();
      }
    } catch (error) {
      if (!options.silent) toast(friendlyError(error, '刷新审阅状态'), true);
    } finally { reviewRefreshPending = false; }
  }
  async function submitCurrentReview() {
    if (!review || review.status !== 'reviewing' || submitPending) return;
    if (savePending || !sheet.hidden) return toast('请先保存或取消当前批注。');
    const openCount = annotations.filter((annotation) => annotation.status === 'open').length;
    const promptText = openCount
      ? '本轮有 ' + openCount + ' 条未处理批注。提交后页面将只读，并交给 Codex 修改。确定提交吗？'
      : '本轮没有批注。提交后将记录为“审核通过”并解除冻结。确定提交吗？';
    if (!window.confirm(promptText)) return;
    submitPending = true; submitReview.disabled = true; submitReview.textContent = '提交中…';
    try {
      const result = await requestJson('/api/review/submit?' + docQS(), { method: 'POST' });
      if (!result.ok || !result.review) throw new ApiError(result.message || '服务未返回审阅状态。', 200, result.error, 'response');
      review = result.review; updateReviewUI();
      toast(review.status === 'complete' ? '本轮审核通过，已解除冻结。' : '本轮审阅已提交，等待 Codex 修改。', true);
    } catch (error) { handleMutationError(error, '提交审阅'); }
    finally {
      submitPending = false; submitReview.disabled = false; submitReview.textContent = '完成本轮审阅';
      updateReviewUI();
    }
  }
  submitReview.addEventListener('click', submitCurrentReview);

  async function loadTree() {
    try {
      const data = await requestJson('/api/tree');
      const files = Array.isArray(data.files) ? data.files : [];
      if (!files.length) { fileListEl.innerHTML = '<div class="drawer-h">这个文件夹没有 .md。</div>'; return; }
      fileListEl.innerHTML = '';
      files.forEach((file) => {
        const div = document.createElement('button'); div.type = 'button'; div.className = 'file-item'; div.dataset.path = file;
        const dir = posixDir(file);
        div.innerHTML = (dir ? '<span class="file-dir">' + esc(dir) + '/</span> ' : '') + esc(file.slice(dir ? dir.length + 1 : 0));
        div.addEventListener('click', () => { openDoc(file); closeDrawer(); });
        fileListEl.appendChild(div);
      });
      markActive();
    } catch (error) { fileListEl.innerHTML = '<div class="drawer-h">' + esc(friendlyError(error, '读取文件列表')) + '</div>'; }
  }
  function markActive() {
    fileListEl.querySelectorAll('.file-item').forEach((element) => element.classList.toggle('active', element.dataset.path === currentPath));
  }
  async function openDoc(relativePath) {
    if (savePending) return toast('批注正在保存，请稍候再切换文档。');
    const loadId = ++browseLoadId;
    if (!sheet.hidden) closeSheet();
    annotBtn.hidden = true;
    pendingAnchor = null;
    annotations = [];
    noteCount.textContent = '0';
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    currentPath = relativePath; location.hash = '#' + encodeURIComponent(relativePath);
    docTitle.textContent = relativePath.split('/').pop(); content.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const source = await requestText('/api/raw?' + docQS(null, relativePath));
      if (loadId !== browseLoadId) return;
      const committed = await renderDoc(source, posixDir(relativePath), {
        browsePath: relativePath,
        isStale: () => loadId !== browseLoadId,
      });
      if (committed) markActive();
    } catch (error) {
      if (loadId !== browseLoadId) return;
      content.innerHTML = '<div class="empty error-state">' + esc(friendlyError(error, '加载')) + '</div>';
    }
  }

  async function initLink() {
    $('#btnMenu').style.display = 'none';
    try {
      const meta = await requestJson('/api/meta?' + docQS());
      docTitle.textContent = meta.title || '文档'; viewerName = meta.viewer || '';
    } catch (error) {
      content.innerHTML = '<div class="empty error-state">' + esc(friendlyError(error, '打开')) + '</div>'; return;
    }
    if (!viewerName) {
      viewerName = localStorage.getItem('mdread_name') || '';
      if (!viewerName) {
        viewerName = (window.prompt('你是谁？（用于标注批注作者）') || '访客').slice(0, 40);
        localStorage.setItem('mdread_name', viewerName);
      }
    }
    content.innerHTML = '<div class="empty">加载中…</div>';
    try { const source = await requestText('/api/raw?' + docQS()); await renderDoc(source, ''); }
    catch (error) { content.innerHTML = '<div class="empty error-state">' + esc(friendlyError(error, '加载')) + '</div>'; }
  }
  async function initReview() {
    $('#btnMenu').style.display = 'none';
    content.innerHTML = '<div class="empty">加载审阅会话…</div>';
    try {
      const result = await requestJson('/api/review?' + docQS());
      if (!result.review) throw new ApiError('找不到该审阅会话。', 404, 'review_not_found', 'response');
      review = result.review;
      docTitle.textContent = review.title || ((review.sourceFile || '').split('/').pop()) || '本地审阅';
      updateReviewUI();
      const source = await requestText('/api/raw?' + docQS());
      await renderDoc(source, '');
    } catch (error) {
      content.innerHTML = '<div class="empty error-state">' + esc(friendlyError(error, '打开审阅')) + '</div>';
    }
  }

  (async function init() {
    if (MODE === 'link') return initLink();
    if (MODE === 'review') return initReview();
    await loadTree();
    const hash = location.hash.replace(/^#/, '');
    if (hash) openDoc(decodeURIComponent(hash));
  })();
  window.addEventListener('focus', () => {
    if (MODE === 'review') refreshReviewState({ reloadAnnotations: true, silent: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (MODE === 'review' && !document.hidden) refreshReviewState({ reloadAnnotations: true, silent: true });
  });
})();
