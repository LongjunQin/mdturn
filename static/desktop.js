(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const Anchor = window.MDTurnAnchor;
  const bridge = window.mdturnDesktop || null;

  const nodes = {
    shell: $('#appShell'), tabList: $('#tabList'), openTabButton: $('#openTabButton'), primaryAction: $('#primaryAction'), finalizeAction: $('#finalizeAction'),
    left: $('#leftSidebar'), right: $('#rightSidebar'), collapseLeft: $('#collapseLeft'), expandLeft: $('#expandLeft'),
    collapseRight: $('#collapseRight'), expandRight: $('#expandRight'), toggleLeftTop: $('#toggleLeftTop'),
    toggleRightTop: $('#toggleRightTop'), outlineMode: $('#outlineModeButton'), filesMode: $('#filesModeButton'),
    outlinePanel: $('#outlinePanel'), filesPanel: $('#filesPanel'), recentList: $('#recentList'), openFileButton: $('#openFileButton'),
    toolbar: $('#documentToolbar'), reviewState: $('#reviewStatePill'), reviewStateIcon: $('#reviewStateIcon'),
    reviewStateText: $('#reviewStateText'), reviewCount: $('#reviewCount'), readingMode: $('#readingModeButton'),
    editingMode: $('#editingModeButton'), readerPane: $('#readerPane'), welcome: $('#welcome'), welcomeOpen: $('#welcomeOpenButton'),
    welcomeRecent: $('#welcomeRecent'), readerScroll: $('#readerScroll'), content: $('#documentContent'), editorPane: $('#editorPane'),
    codeEditor: $('#codeEditor'), editorSaveState: $('#editorSaveState'), saveButton: $('#saveButton'),
    finishManual: $('#finishManualButton'), notesTotal: $('#notesTotal'), openNotesCount: $('#openNotesCount'),
    historyNotesCount: $('#historyNotesCount'), openNotesList: $('#openNotesList'), historyNotesList: $('#historyNotesList'),
    historySection: $('#historySection'), annotate: $('#annotateButton'), annotationOverlay: $('#annotationOverlay'),
    docNoteButton: $('#docNoteButton'),
    annotationDialog: $('#annotationDialog'), annotationDialogPanel: $('#annotationDialogPanel'),
    annotationDialogHandle: $('#annotationDialogDragHandle'),
    annotationTitle: $('#annotationDialogTitle'), annotationQuote: $('#annotationQuote'), annotationText: $('#annotationText'),
    annotationSave: $('#saveAnnotation'), annotationCancel: $('#cancelAnnotation'), annotationClose: $('#closeAnnotationDialog'),
    confirmDialog: $('#confirmDialog'), confirmTitle: $('#confirmTitle'), confirmMessage: $('#confirmMessage'),
    confirmAccept: $('#confirmAccept'), confirmCancel: $('#confirmCancel'), toastRegion: $('#toastRegion'),
  };

  const STATUS = {
    reviewing: { text: '审阅中 · 原文已锁定', detail: '可以阅读和批注，不能修改原文。', icon: 'ph-lock-key' },
    ready_to_apply: { text: '等待修改 · 批注已提交', detail: '可以等待 Agent，或开始手工修改。', icon: 'ph-hourglass-medium' },
    applyingAgent: { text: 'Agent 修改中 · 文档暂时只读', detail: '修改完成后会自动刷新。', icon: 'ph-robot' },
    applyingManual: { text: '手工修改中 · 请逐条处理批注', detail: '所有未处理批注清零后才能提交。', icon: 'ph-pencil-simple-line' },
    manualEdit: { text: '手工修改中 · 改完点「提交修改」', detail: '这轮没有批注，你直接改；提交后本轮结束。期间智能体不会碰这篇文档。', icon: 'ph-pencil-simple-line' },
    complete: { text: '修改已完成 · 已加载最新版', detail: '可以开始下一轮审阅，或点右上「定稿并关闭」结束。', icon: 'ph-check-circle' },
    conflict: { text: '版本冲突 · 已停止写入', detail: '需要先处理冲突。', icon: 'ph-warning-circle' },
    cancelled: { text: '审阅已取消', detail: '本轮已人工结束。', icon: 'ph-x-circle' },
  };

  const state = {
    tabs: [],
    activeId: null,
    recents: [],
    leftMode: localStorage.getItem('mdturn.leftMode') === 'files' ? 'files' : 'outline',
    leftCollapsed: localStorage.getItem('mdturn.leftCollapsed') === '1',
    rightCollapsed: localStorage.getItem('mdturn.rightCollapsed') === '1',
    readerZoom: Math.min(2.2, Math.max(0.6, parseFloat(localStorage.getItem('mdturn.readerZoom')) || 1)),
    selectionFrame: null,
    nextRoundHintAt: 0,
    cachedAnchor: null,
    dialog: null,
    editorView: null,
    editorTabId: null,
    draftTimers: new Map(),
    draftWarningShown: false,
    renderingHistory: false,
    refreshBusy: false,
    outlineFrame: null,
    markerFrame: null,
    markerEntries: [],
    dialogDrag: null,
    eventSource: null,
    reconcileTimer: null,
    reconciling: false,
    remoteChanges: new Map(),
    remoteRefreshes: new Map(),
    remoteRetryTimers: new Map(),
    announcedCompletions: null,
    layoutObserver: null,
  };

  class ApiError extends Error {
    constructor(message, status = 0, code = '', details = null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  async function requestJson(url, options = {}) {
    let response;
    try {
      response = await fetch(url, { cache: 'no-store', ...options });
    } catch (error) {
      throw new ApiError('本地 MDTurn 服务不可达。', 0, 'service_unavailable', { cause: error && error.message });
    }
    const type = response.headers.get('content-type') || '';
    let body = null;
    if (type.includes('application/json')) {
      try { body = await response.json(); }
      catch { throw new ApiError('服务返回了损坏的 JSON。', response.status, 'bad_json'); }
    } else {
      const text = await response.text();
      if (!response.ok || type.includes('text/html')) {
        throw new ApiError('服务返回了意外页面，请重启 MDTurn 后再试。', response.status, 'unexpected_response', { text: text.slice(0, 180) });
      }
    }
    if (!response.ok) {
      throw new ApiError((body && body.message) || `请求失败（HTTP ${response.status}）`, response.status,
        body && body.error, body && body.details);
    }
    if (!body || typeof body !== 'object') throw new ApiError('服务没有返回有效数据。', response.status, 'bad_response');
    return body;
  }

  function friendlyError(error, action = '操作') {
    if (!(error instanceof ApiError)) return `${action}失败：${error && error.message ? error.message : String(error)}`;
    if (error.code === 'source_conflict' || error.code === 'source_changed' || error.status === 409) {
      return `${action}未完成：文档版本已经变化。你的输入仍保留，请先处理版本冲突。`;
    }
    if (error.code === 'review_read_only' || error.code === 'source_write_not_allowed' || error.status === 423) {
      return `${action}未完成：文档已被重新冻结（通常是智能体开启了新一轮审阅）。你的修改仍保留在编辑器里，没有丢失；可复制留用，或等这一轮结束后再改。`;
    }
    if (error.status === 404) return `${action}未完成：文档或审阅会话已经失效。`;
    if (error.status === 0) return `${action}未完成：本地服务不可达。`;
    return error.message || `${action}失败。`;
  }

  function toast(message, kind = '') {
    const item = document.createElement('div');
    item.className = `toast${kind ? ` ${kind}` : ''}`;
    item.textContent = message;
    nodes.toastRegion.appendChild(item);
    setTimeout(() => item.remove(), kind === 'error' ? 5200 : 2800);
  }

  function requestId(prefix = 'req') {
    const id = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
  }

  function activeTab() { return state.tabs.find((tab) => tab.id === state.activeId) || null; }
  function tabByPath(sourceFile) { return state.tabs.find((tab) => tab.review && tab.review.sourceFile === sourceFile) || null; }
  function effectiveStatus(note) { return Anchor ? Anchor.effectiveStatus(note) : (note.status || 'open'); }
  function openAnnotations(tab) { return (tab && tab.annotations || []).filter((note) => effectiveStatus(note) === 'open'); }
  function isDocNote(note) { return !!note && note.scope === 'document'; }

  function normalizeBundle(bundle) {
    const review = bundle.review || {};
    const source = bundle.source && typeof bundle.source === 'object'
      ? bundle.source
      : { content: String(bundle.source || ''), hash: review.workingHash || review.sourceHash };
    const annotations = Array.isArray(bundle.annotations)
      ? bundle.annotations
      : (bundle.annotations && Array.isArray(bundle.annotations.annotations) ? bundle.annotations.annotations : []);
    review.sourceFile = review.sourceFile || review.absPath;
    review.title = review.title || review.file || (review.sourceFile || '').split('/').pop() || 'Markdown';
    return { review, source, annotations };
  }

  async function fetchBundle(reviewId) {
    return normalizeBundle(await requestJson(`/api/app/bundle?r=${encodeURIComponent(reviewId)}`));
  }

  function makeTab(bundle) {
    const { review, source, annotations } = normalizeBundle(bundle);
    const tab = {
      id: review.id,
      review,
      source: source.content || '',
      sourceHash: source.hash || review.workingHash || review.sourceHash,
      revision: Number(source.revision || review.sourceRevision || 0),
      annotations,
      mode: 'read',
      dirty: false,
      saveRequestId: null,
      scrollTop: 0,
      renderedHash: null,
      outline: [],
      focusedNoteId: null,
      historyOpen: false,
    };
    const draft = readDraft(tab.id, tab.sourceHash);
    if (draft && draft.content !== tab.source) {
      tab.editorDraft = draft.content;
      tab.dirty = true;
      tab.mode = 'edit';
    }
    return tab;
  }

  function draftKey(tabId) { return `mdturn.draft.${tabId}`; }

  function readDraft(tabId, sourceHash) {
    try {
      const draft = JSON.parse(localStorage.getItem(draftKey(tabId)) || 'null');
      if (draft && draft.sourceHash === sourceHash && typeof draft.content === 'string') return draft;
    } catch {}
    return null;
  }

  function persistDraft(tab) {
    if (!tab || !tab.dirty || typeof tab.editorDraft !== 'string') return;
    try {
      localStorage.setItem(draftKey(tab.id), JSON.stringify({
        sourceHash: tab.sourceHash,
        content: tab.editorDraft,
        savedAt: new Date().toISOString(),
      }));
    } catch {
      if (!state.draftWarningShown) {
        state.draftWarningShown = true;
        toast('这篇文档的草稿较大，自动恢复空间不足。请尽快点击“保存”。', 'error');
      }
    }
  }

  function scheduleDraft(tab) {
    const prior = state.draftTimers.get(tab.id);
    if (prior) clearTimeout(prior);
    state.draftTimers.set(tab.id, setTimeout(() => {
      state.draftTimers.delete(tab.id);
      persistDraft(tab);
    }, 220));
  }

  function clearDraft(tab) {
    if (!tab) return;
    const timer = state.draftTimers.get(tab.id);
    if (timer) clearTimeout(timer);
    state.draftTimers.delete(tab.id);
    try { localStorage.removeItem(draftKey(tab.id)); } catch {}
  }

  function persistTabs() {
    const payload = {
      activeId: state.activeId,
      tabs: state.tabs.map((tab) => ({ id: tab.id, path: tab.review.sourceFile })),
    };
    localStorage.setItem('mdturn.tabs', JSON.stringify(payload));
  }

  async function restoreTabs() {
    let saved;
    try { saved = JSON.parse(localStorage.getItem('mdturn.tabs') || '{}'); }
    catch { saved = {}; }
    const entries = Array.isArray(saved.tabs) ? saved.tabs.slice(0, 10) : [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') continue;
      try {
        const bundle = await fetchBundle(entry.id);
        state.tabs.push(makeTab(bundle));
      } catch (_) {}
    }
    state.activeId = state.tabs.some((tab) => tab.id === saved.activeId)
      ? saved.activeId
      : (state.tabs[0] && state.tabs[0].id) || null;
  }

  async function refreshRecents() {
    try {
      const result = await requestJson('/api/reviews');
      state.recents = Array.isArray(result.reviews) ? result.reviews : [];
      renderRecents();
      return state.recents;
    } catch (error) {
      nodes.recentList.replaceChildren(emptyBlock(friendlyError(error, '读取最近审阅'), 'recent-empty'));
      return [];
    }
  }

  function emptyBlock(text, className = 'notes-empty') {
    const item = document.createElement('div'); item.className = className; item.textContent = text; return item;
  }

  function formatDirectory(value) {
    const parts = String(value || '').split('/').filter(Boolean);
    if (parts.length <= 2) return `/${parts.join('/')}`;
    return `…/${parts.slice(-2).join('/')}`;
  }

  function formatRelativeTime(value) {
    const time = Date.parse(value || '');
    if (!Number.isFinite(time)) return '';
    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`;
    if (diff < 86_400_000) return `${Math.max(1, Math.round(diff / 3_600_000))} 小时前`;
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(time));
  }

  function renderRecents() {
    const containers = [nodes.recentList, nodes.welcomeRecent];
    containers.forEach((container) => {
      container.replaceChildren();
      if (!state.recents.length) {
        container.appendChild(emptyBlock('还没有最近审阅。打开一篇 Markdown 后会出现在这里。', 'recent-empty'));
        return;
      }
      const fragment = document.createDocumentFragment();
      state.recents.slice(0, container === nodes.welcomeRecent ? 5 : 18).forEach((review) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'recent-item';
        const title = document.createElement('strong'); title.textContent = review.title || review.file || 'Markdown';
        const meta = document.createElement('span');
        meta.textContent = `${formatDirectory(review.directory)} · ${statusLabel(review.status, review.applyMode)}${review.openCount ? ` · ${review.openCount} 条未处理` : ''}`;
        button.append(title, meta);
        button.addEventListener('click', () => openReviewId(review.id));
        fragment.appendChild(button);
      });
      container.appendChild(fragment);
    });
  }

  function statusDescriptor(review = {}) {
    if (review.status === 'applying') {
      if (review.applyMode !== 'manual') return STATUS.applyingAgent;
      return review.round === 'manual-edit' ? STATUS.manualEdit : STATUS.applyingManual;
    }
    return STATUS[review.status] || { text: `未知状态：${review.status || 'unknown'}`, detail: '无法识别当前状态。', icon: 'ph-question' };
  }

  function statusLabel(status, applyMode = '') {
    if (status === 'applying') return applyMode === 'manual' ? '手工修改中' : 'Agent 修改中';
    return ({ reviewing: '审阅中', ready_to_apply: '等待修改', complete: '修改已完成', conflict: '版本冲突', cancelled: '审阅已取消' })[status] || '未知状态';
  }

  async function chooseMarkdown() {
    let paths = [];
    if (bridge && typeof bridge.pickMarkdown === 'function') {
      try { paths = await bridge.pickMarkdown(); }
      catch (error) { toast(`打开文件失败：${error.message || error}`, 'error'); }
    } else {
      const candidate = window.prompt('请输入 Markdown 文件的绝对路径：');
      if (candidate) paths = [candidate];
    }
    await openPaths(paths);
  }

  async function openPaths(paths) {
    for (const filePath of Array.isArray(paths) ? paths : []) {
      if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.md')) continue;
      await openReviewPath(filePath);
    }
  }

  async function openReviewPath(filePath) {
    try {
      const result = await requestJson('/api/app/open', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }),
      });
      const bundle = await fetchBundle(result.review.id);
      upsertTab(bundle, { activate: true });
      await refreshRecents();
    } catch (error) { toast(friendlyError(error, '打开文档'), 'error'); }
  }

  async function openReviewId(reviewId) {
    const existing = state.tabs.find((tab) => tab.id === reviewId);
    if (existing) return activateTab(existing.id);
    try {
      const bundle = await fetchBundle(reviewId);
      upsertTab(bundle, { activate: true });
    } catch (error) { toast(friendlyError(error, '打开审阅'), 'error'); }
  }

  function upsertTab(bundle, options = {}) {
    const next = makeTab(bundle);
    const byPath = tabByPath(next.review.sourceFile);
    const byId = state.tabs.find((tab) => tab.id === next.id);
    const existing = byId || byPath;
    if (existing) {
      if (existing.dirty) {
        if (existing.id !== next.id) toast('这个文档还有未保存的编辑，暂未切换到新一轮。', 'error');
        state.activeId = existing.id;
        persistTabs();
        renderApp();
        return existing;
      }
      const index = state.tabs.indexOf(existing);
      // Reopening the same session may preserve its view.  A new review round
      // for the same file must always return to frozen read mode instead of
      // inheriting an old edit-mode tab.
      if (existing.id === next.id) {
        next.mode = existing.mode;
        next.scrollTop = existing.scrollTop;
      }
      state.tabs.splice(index, 1, next);
    } else {
      state.tabs.push(next);
    }
    if (options.activate !== false) state.activeId = next.id;
    persistTabs();
    renderApp();
    return next;
  }

  function applyBundleToTab(tab, bundle, options = {}) {
    const normalized = normalizeBundle(bundle);
    const changed = normalized.source.hash !== tab.sourceHash;
    tab.review = normalized.review;
    tab.annotations = normalized.annotations;
    tab.revision = Number(normalized.source.revision || normalized.review.sourceRevision || tab.revision || 0);
    if (changed || options.forceSource) {
      tab.source = normalized.source.content;
      tab.sourceHash = normalized.source.hash;
      tab.renderedHash = null;
    }
    tab.remotePending = null;
    if (tab.id === state.activeId) renderApp(); else renderTabs();
    return { tab, normalized, changed };
  }

  async function refreshTab(tab, options = {}) {
    if (!tab || tab.dirty) return tab;
    try {
      const bundle = await fetchBundle(tab.id);
      applyBundleToTab(tab, bundle, options);
      return tab;
    } catch (error) {
      if (!options.silent) toast(friendlyError(error, '刷新文档'), 'error');
      if (options.throwOnError) throw error;
      return tab;
    }
  }

  function reviewNeedsRefresh(tab, summary) {
    if (!tab || !summary || tab.dirty) return false;
    if (summary.status !== tab.review.status || (summary.applyMode || '') !== (tab.review.applyMode || '')) return true;
    if (Number.isInteger(summary.openCount) && summary.openCount !== openAnnotations(tab).length) return true;
    const remoteHash = summary.workingHash || summary.finalHash || summary.currentHash;
    if (remoteHash && remoteHash !== tab.sourceHash) return true;
    const remoteRevision = Number(summary.sourceRevision || 0);
    return remoteRevision > Number(tab.revision || 0);
  }

  function completionHistory() {
    if (state.announcedCompletions) return state.announcedCompletions;
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem('mdturn.announcedCompletions') || '[]'); } catch (_) {}
    state.announcedCompletions = new Set(Array.isArray(saved) ? saved.filter((item) => typeof item === 'string') : []);
    return state.announcedCompletions;
  }

  function completionKey(review) {
    if (!review || review.status !== 'complete' || !review.id) return null;
    const token = review.completedAt || review.finalHash || review.workingHash || review.sourceRevision || 'complete';
    return `${review.id}:${token}`;
  }

  function markCompletionAnnounced(review) {
    const key = completionKey(review);
    if (!key) return false;
    const history = completionHistory();
    if (history.has(key)) return false;
    history.add(key);
    const recent = [...history].slice(-80);
    state.announcedCompletions = new Set(recent);
    try { localStorage.setItem('mdturn.announcedCompletions', JSON.stringify(recent)); } catch (_) {}
    return true;
  }

  function isVerifiedAgentCompletion(review, options = {}, priorStatus = '', priorMode = '') {
    if (!review || review.status !== 'complete') return false;
    if (review.applyMode === 'manual') return false;
    if (review.applyMode === 'agent') return true;
    if (options.reason === 'agent-complete') return true;
    return priorStatus === 'applying' && priorMode !== 'manual';
  }

  async function announceAgentCompletion(review) {
    if (!review || !markCompletionAnnounced(review)) return;
    const title = review.title || review.file || '当前文档';
    const message = `《${title}》Agent 修改完成，已刷新到最新版。`;
    if (document.visibilityState === 'visible' && document.hasFocus()) {
      toast(message);
      return;
    }
    if (bridge && typeof bridge.notifyReviewComplete === 'function') {
      try {
        const shown = await bridge.notifyReviewComplete({ reviewId: review.id, title });
        if (shown) return;
      } catch (_) {}
    }
    toast(message);
  }

  function mergeRemoteChange(previous = {}, next = {}) {
    return {
      forceSource: previous.forceSource === true || next.forceSource === true,
      reason: next.reason || previous.reason || 'review-changed',
      attempt: Math.max(Number(previous.attempt || 0), Number(next.attempt || 0)),
    };
  }

  function markRemotePending(tab, reviewId, options = {}, error = null) {
    if (!tab) return;
    const first = !tab.remotePending;
    tab.remotePending = {
      reviewId,
      forceSource: options.forceSource === true,
      reason: options.reason || 'review-changed',
      failed: Boolean(error),
    };
    if (tab.id === state.activeId) renderStatus(tab); else renderTabs();
    if (first) {
      const title = tab.review.title || tab.review.file || '当前文档';
      toast(error
        ? `《${title}》有远程更新，暂时未能同步，MDTurn 会自动重试。`
        : `《${title}》有远程更新。未保存草稿已保护，保存后会立即同步。`);
    }
  }

  function clearRemoteRetry(reviewId) {
    const timer = state.remoteRetryTimers.get(reviewId);
    if (timer) clearTimeout(timer);
    state.remoteRetryTimers.delete(reviewId);
  }

  function scheduleRemoteRetry(reviewId, options = {}) {
    if (state.remoteRetryTimers.has(reviewId) || Number(options.attempt || 0) > 5) return;
    const delay = Math.min(16_000, 1000 * (2 ** Math.max(0, Number(options.attempt || 0) - 1)));
    const timer = setTimeout(() => {
      state.remoteRetryTimers.delete(reviewId);
      void queueRemoteReviewChange(reviewId, options);
    }, delay);
    state.remoteRetryTimers.set(reviewId, timer);
  }

  async function applyRemoteReviewChangeNow(reviewId, options = {}) {
    let bundle;
    try {
      bundle = await fetchBundle(reviewId);
    } catch (error) {
      const tab = state.tabs.find((candidate) => candidate.id === reviewId);
      markRemotePending(tab, reviewId, options, error);
      scheduleRemoteRetry(reviewId, { ...options, attempt: Number(options.attempt || 0) + 1 });
      return;
    }

    clearRemoteRetry(reviewId);
    const normalized = normalizeBundle(bundle);
    let tab = state.tabs.find((candidate) => candidate.id === reviewId);
    if (!tab) {
      const sameFile = tabByPath(normalized.review.sourceFile);
      if (sameFile && sameFile.dirty) {
        markRemotePending(sameFile, reviewId, options);
        return;
      }
      if (sameFile) {
        const wasActive = sameFile.id === state.activeId;
        tab = upsertTab(normalized, { activate: wasActive });
      } else {
        await refreshRecents();
        if (isVerifiedAgentCompletion(normalized.review, options)) {
          await announceAgentCompletion(normalized.review);
        }
        return;
      }
    }

    if (tab.dirty) {
      markRemotePending(tab, reviewId, options);
      return;
    }
    if (tab.id === state.activeId && tab.mode === 'read') tab.scrollTop = nodes.readerScroll.scrollTop;
    const priorStatus = tab.review.status;
    const priorMode = tab.review.applyMode;
    applyBundleToTab(tab, normalized, { forceSource: options.forceSource === true });
    await refreshRecents();
    if (isVerifiedAgentCompletion(tab.review, options, priorStatus, priorMode)) {
      await announceAgentCompletion(tab.review);
    }
  }

  function queueRemoteReviewChange(reviewId, options = {}) {
    if (typeof reviewId !== 'string' || !reviewId) return Promise.resolve();
    clearRemoteRetry(reviewId);
    state.remoteChanges.set(reviewId, mergeRemoteChange(state.remoteChanges.get(reviewId), options));
    if (state.remoteRefreshes.has(reviewId)) return state.remoteRefreshes.get(reviewId);
    const task = (async () => {
      while (state.remoteChanges.has(reviewId)) {
        const pending = state.remoteChanges.get(reviewId);
        state.remoteChanges.delete(reviewId);
        await applyRemoteReviewChangeNow(reviewId, pending);
      }
    })().finally(() => state.remoteRefreshes.delete(reviewId));
    state.remoteRefreshes.set(reviewId, task);
    return task;
  }

  async function reconcileOpenReviews() {
    if (state.reconciling) return;
    state.reconciling = true;
    try {
      const reviews = await refreshRecents();
      const summaries = new Map(reviews.map((review) => [review.id || review.sessionId, review]));
      const latestByPath = new Map(reviews.map((review) => [review.sourceFile || review.absPath, review]));
      const updates = [];
      for (const tab of state.tabs.slice()) {
        const summary = summaries.get(tab.id);
        const latest = latestByPath.get(tab.review.sourceFile);
        if (latest && (latest.id || latest.sessionId) !== tab.id) {
          updates.push(queueRemoteReviewChange(latest.id || latest.sessionId, {
            reason: 'reconcile-new-round', forceSource: true,
          }));
          continue;
        }
        if (!summary) {
          updates.push(queueRemoteReviewChange(tab.id, { reason: 'reconcile-probe' }));
          continue;
        }
        if (!reviewNeedsRefresh(tab, summary)) continue;
        updates.push(queueRemoteReviewChange(tab.id, {
          reason: 'reconcile',
          forceSource: summary.status === 'complete' ||
            Boolean((summary.workingHash || summary.finalHash) && (summary.workingHash || summary.finalHash) !== tab.sourceHash),
        }));
      }
      await Promise.allSettled(updates);
    } finally {
      state.reconciling = false;
    }
  }

  function handleReviewEvent(event) {
    let payload;
    try { payload = JSON.parse(event.data || '{}'); } catch { return; }
    const reviewId = payload.reviewSessionId || payload.reviewId || payload.sessionId;
    if (typeof reviewId !== 'string' || !reviewId) return;
    void queueRemoteReviewChange(reviewId, {
      reason: payload.reason || 'review-changed',
      forceSource: ['agent-complete', 'manual-complete', 'review-approved', 'review-completed', 'complete'].includes(payload.reason),
    });
  }

  function installReviewEvents() {
    if (typeof EventSource === 'function') {
      state.eventSource = new EventSource('/api/app/events');
      state.eventSource.addEventListener('review-changed', handleReviewEvent);
      state.eventSource.addEventListener('open', () => { void reconcileOpenReviews(); });
      state.eventSource.addEventListener('error', () => {
        // EventSource reconnects automatically; persisted review state remains authoritative.
      });
    }
    state.reconcileTimer = setInterval(() => { void reconcileOpenReviews(); }, 60_000);
  }

  function activateTab(id) {
    const current = activeTab();
    if (current) {
      current.scrollTop = nodes.readerScroll.scrollTop;
      captureEditorValue(current);
    }
    if (!state.tabs.some((tab) => tab.id === id)) return;
    state.activeId = id;
    state.cachedAnchor = null;
    nodes.annotate.hidden = true;
    persistTabs();
    renderApp();
    void refreshTab(activeTab(), { silent: true });
  }

  async function closeTab(id) {
    const tab = state.tabs.find((item) => item.id === id);
    if (!tab) return;
    if (!nodes.annotationDialog.hidden && state.dialog && state.dialog.tabId === id) {
      toast('请先保存或取消正在编辑的批注。', 'error');
      return;
    }
    captureEditorValue(tab);
    if (tab.dirty) {
      const discard = await confirmAction('舍弃未保存的修改？', '关闭标签页会丢失尚未保存的 Markdown 修改。', '舍弃并关闭');
      if (!discard) return;
      clearDraft(tab);
    }
    const index = state.tabs.indexOf(tab);
    state.tabs.splice(index, 1);
    if (state.editorTabId === id) destroyEditor();
    if (state.activeId === id) state.activeId = (state.tabs[index] || state.tabs[index - 1] || {}).id || null;
    persistTabs();
    renderApp();
  }

  function commandBlocked() {
    if (!nodes.annotationDialog.hidden) {
      toast('请先保存或取消正在编辑的批注。', 'error');
      return true;
    }
    if (!nodes.confirmDialog.hidden) {
      toast('请先完成当前确认操作。', 'error');
      return true;
    }
    return false;
  }

  function applyReaderZoom() {
    nodes.content.style.zoom = state.readerZoom === 1 ? '' : String(state.readerZoom);
    // 编辑态正文经 CSS 变量吃同一个缩放值(元素是异步创建的,变量天然免时序问题)
    document.documentElement.style.setProperty('--reader-zoom', String(state.readerZoom));
    scheduleMarkerPositions();
  }

  function setReaderZoom(next) {
    const zoom = Math.min(2.2, Math.max(0.6, next));
    if (zoom === state.readerZoom) return;
    state.readerZoom = zoom;
    localStorage.setItem('mdturn.readerZoom', String(zoom));
    applyReaderZoom();
  }

  function handleDesktopCommand(command) {
    if (['open', 'close-tab'].includes(command) && commandBlocked()) return;
    if (command === 'open') {
      void chooseMarkdown();
      return;
    }
    if (command === 'save') {
      if (!nodes.annotationDialog.hidden || !nodes.confirmDialog.hidden) return;
      void saveSource();
      return;
    }
    if (command === 'close-tab') {
      const tab = activeTab();
      if (tab) void closeTab(tab.id);
      return;
    }
    if (command === 'zoom-in') { setReaderZoom(state.readerZoom * 1.1); return; }
    if (command === 'zoom-out') { setReaderZoom(state.readerZoom / 1.1); return; }
    if (command === 'zoom-reset') setReaderZoom(1);
  }

  function renderTabs() {
    nodes.tabList.replaceChildren();
    state.tabs.forEach((tab) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `tab${tab.id === state.activeId ? ' active' : ''}`;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(tab.id === state.activeId));
      button.title = tab.review.sourceFile || tab.review.title;
      const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = tab.review.title || 'Markdown';
      const dot = document.createElement('span'); dot.className = `tab-state ${tab.review.status || ''}`;
      dot.title = tab.remotePending
        ? `${statusLabel(tab.review.status, tab.review.applyMode)}（有远程更新待同步）`
        : statusLabel(tab.review.status, tab.review.applyMode);
      const close = document.createElement('span'); close.className = 'tab-close'; close.setAttribute('role', 'button');
      close.setAttribute('aria-label', `关闭 ${tab.review.title || '文档'}`); close.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
      close.addEventListener('pointerdown', (event) => event.stopPropagation());
      close.addEventListener('click', (event) => { event.stopPropagation(); void closeTab(tab.id); });
      button.append(title, dot, close);
      button.addEventListener('click', () => activateTab(tab.id));
      nodes.tabList.appendChild(button);
      if (tab.id === state.activeId) {
        requestAnimationFrame(() => button.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      }
    });
  }

  function renderApp() {
    renderLayoutState();
    renderTabs();
    const tab = activeTab();
    if (!tab) {
      destroyEditor();
      clearMarkerOverlay();
      nodes.toolbar.hidden = true;
      nodes.readerPane.hidden = false;
      nodes.welcome.hidden = false;
      nodes.readerScroll.hidden = true;
      nodes.editorPane.hidden = true;
      nodes.primaryAction.hidden = true;
      nodes.finalizeAction.hidden = true;
      renderOutline([]);
      renderNotes(null);
      return;
    }

    nodes.toolbar.hidden = false;
    nodes.welcome.hidden = true;
    renderStatus(tab);
    renderNotes(tab);
    if (tab.mode === 'edit') renderEditor(tab);
    else renderReader(tab);
  }

  function renderLayoutState() {
    nodes.shell.classList.toggle('left-collapsed', state.leftCollapsed);
    nodes.shell.classList.toggle('right-collapsed', state.rightCollapsed);
    nodes.outlineMode.classList.toggle('active', state.leftMode === 'outline');
    nodes.filesMode.classList.toggle('active', state.leftMode === 'files');
    nodes.outlineMode.setAttribute('aria-selected', String(state.leftMode === 'outline'));
    nodes.filesMode.setAttribute('aria-selected', String(state.leftMode === 'files'));
    nodes.outlinePanel.hidden = state.leftMode !== 'outline';
    nodes.filesPanel.hidden = state.leftMode !== 'files';
  }

  function setLeftMode(mode) {
    state.leftMode = mode === 'files' ? 'files' : 'outline';
    state.leftCollapsed = false;
    localStorage.setItem('mdturn.leftMode', state.leftMode);
    localStorage.setItem('mdturn.leftCollapsed', '0');
    renderLayoutState();
  }

  function toggleLeft(force) {
    state.leftCollapsed = typeof force === 'boolean' ? force : !state.leftCollapsed;
    localStorage.setItem('mdturn.leftCollapsed', state.leftCollapsed ? '1' : '0');
    renderLayoutState();
    requestAnimationFrame(scheduleMarkerPositions);
  }

  function toggleRight(force) {
    state.rightCollapsed = typeof force === 'boolean' ? force : !state.rightCollapsed;
    localStorage.setItem('mdturn.rightCollapsed', state.rightCollapsed ? '1' : '0');
    renderLayoutState();
    requestAnimationFrame(scheduleMarkerPositions);
  }

  function renderStatus(tab) {
    const review = tab.review;
    const descriptor = statusDescriptor(review);
    nodes.reviewState.dataset.status = review.status || 'unknown';
    nodes.reviewStateText.textContent = tab.remotePending
      ? `${descriptor.text} · 远程更新待同步`
      : descriptor.text;
    nodes.reviewStateIcon.className = `ph ${descriptor.icon}`;
    nodes.reviewState.title = tab.remotePending
      ? `${descriptor.detail}当前草稿不会被覆盖，保存或退出编辑后将立即同步。`
      : descriptor.detail;
    const count = openAnnotations(tab).length;
    nodes.reviewCount.textContent = `本轮 ${count} 条未处理`;
    nodes.readingMode.classList.toggle('active', tab.mode !== 'edit');
    nodes.editingMode.classList.toggle('active', tab.mode === 'edit');
    nodes.editingMode.disabled = review.status === 'conflict' || (review.status === 'applying' && review.applyMode !== 'manual');
    nodes.primaryAction.hidden = false;
    nodes.primaryAction.disabled = false;
    if (review.status === 'reviewing') nodes.primaryAction.textContent = '完成本轮审阅';
    else if (review.status === 'ready_to_apply') nodes.primaryAction.textContent = '开始手工修改';
    else if (review.status === 'applying' && review.applyMode === 'manual') nodes.primaryAction.textContent = '提交修改';
    else if (review.status === 'complete' || review.status === 'cancelled') nodes.primaryAction.textContent = '开始新一轮审阅';
    else nodes.primaryAction.hidden = true;
    nodes.finalizeAction.hidden = !(review.status === 'complete' && review.outcome !== 'finalized' && tab.mode !== 'edit');
  }

  function renderReader(tab) {
    destroyEditor();
    tab.mode = 'read';
    nodes.readerPane.hidden = false;
    nodes.readerScroll.hidden = false;
    nodes.editorPane.hidden = true;
    if (tab.renderedHash !== tab.sourceHash || nodes.content.dataset.tabId !== tab.id) {
      void renderMarkdown(nodes.content, tab.source, tab, { interactive: true }).then((rendered) => {
        if (!rendered || activeTab()?.id !== tab.id || tab.mode !== 'read') return;
        tab.renderedHash = tab.sourceHash;
        nodes.content.dataset.tabId = tab.id;
        buildOutline(tab);
        renderMarkers(tab);
        requestAnimationFrame(() => {
          nodes.readerScroll.scrollTop = tab.scrollTop || 0;
          updateOutlineActive();
          scheduleMarkerPositions();
        });
      });
    } else {
      renderOutline(tab.outline);
      renderMarkers(tab);
      requestAnimationFrame(() => {
        nodes.readerScroll.scrollTop = tab.scrollTop || nodes.readerScroll.scrollTop;
        updateOutlineActive();
        scheduleMarkerPositions();
      });
    }
  }

  function statusCanAnnotate(tab) { return tab && tab.mode === 'read' && tab.review.status === 'reviewing'; }

  function markdownEngine() {
    const texmath = window.texmath || window.markdownitTexmath || window['markdown-it-texmath'];
    const engine = window.markdownit({
      html: true, linkify: true, breaks: false,
      highlight(source, language) {
        if (language === 'mermaid') return '';
        if (language && window.hljs && window.hljs.getLanguage(language)) {
          try { return `<pre class="hljs"><code class="language-${language}">${window.hljs.highlight(source, { language, ignoreIllegals: true }).value}</code></pre>`; }
          catch (_) {}
        }
        return '';
      },
    });
    if (texmath && window.katex) {
      try { engine.use(texmath, { engine: window.katex, delimiters: 'dollars', katexOptions: { throwOnError: false, strict: false } }); }
      catch (_) {}
    }
    const htmlBlockRule = engine.renderer.rules.html_block;
    engine.renderer.rules.html_block = function htmlBlock(tokens, index, options, env, self) {
      const token = tokens[index];
      const html = htmlBlockRule ? htmlBlockRule.call(this, tokens, index, options, env, self) : token.content;
      if (!token.map || /^\s*<[A-Za-z][^>]*\bdata-line-start\s*=/i.test(html)) return html;
      const start = token.map[0] + 1, end = token.map[1];
      return html.replace(/^(\s*<[A-Za-z][\w:-]*)(?=[\s>])/, `$1 data-line-start="${start}" data-line-end="${end}"`);
    };
    const fenceRule = engine.renderer.rules.fence;
    engine.renderer.rules.fence = function fence(tokens, index, options, env, self) {
      const token = tokens[index];
      const html = fenceRule.call(this, tokens, index, options, env, self);
      // markdown-it bypasses token attributes when highlight() returns a full
      // <pre> block.  Restore the source-line map so fenced code remains
      // selectable for annotations without changing the highlighted markup.
      if (!token.map || /\bdata-line-start\s*=/.test(html)) return html;
      const start = token.map[0] + 1, end = token.map[1];
      return html.replace(/^(\s*<pre)(?=[\s>])/i, `$1 data-line-start="${start}" data-line-end="${end}"`);
    };
    const originalRender = engine.renderer.render.bind(engine.renderer);
    engine.renderer.render = function render(tokens, options, env) {
      for (const token of tokens) {
        if (token.map && (token.nesting === 1 || token.type === 'fence' || token.type === 'code_block')) {
          token.attrSet('data-line-start', String(token.map[0] + 1));
          token.attrSet('data-line-end', String(token.map[1]));
        }
      }
      return originalRender(tokens, options, env);
    };
    return engine;
  }

  const md = markdownEngine();
  if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'default' });

  function posixDir(value) { const index = value.lastIndexOf('/'); return index < 0 ? '' : value.slice(0, index); }
  function posixJoin(base, relative) {
    const parts = `${base}/${String(relative || '').replace(/^\.\//, '')}`.split('/');
    const out = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
  }
  function absoluteJoin(baseFile, relative) {
    const leading = String(baseFile || '').startsWith('/');
    const joined = posixJoin(posixDir(baseFile), relative);
    return leading ? `/${joined}` : joined;
  }

  async function renderMarkdown(root, source, tab, options = {}) {
    const renderToken = Symbol('mdturn-render');
    root.__mdturnRenderToken = renderToken;
    const target = document.createElement('div');
    target.innerHTML = md.render(source || '');
    target.querySelectorAll('img[src]').forEach((image) => {
      const src = image.getAttribute('src') || '';
      if (/^(https?:|data:)/i.test(src)) return;
      const localPath = localAssetPath(src);
      image.src = `/api/app/file?r=${encodeURIComponent(tab.id)}&path=${encodeURIComponent(localPath)}`;
      image.loading = 'lazy';
    });
    target.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        link.addEventListener('click', (event) => {
          if (!bridge || typeof bridge.openExternal !== 'function') return;
          event.preventDefault(); void bridge.openExternal(href);
        });
      } else if (/^(mailto:|tel:|#)/i.test(href)) {
        // Keep local anchors native. Electron blocks mail/tel navigation by default.
      } else if (/\.md(?:[?#]|$)/i.test(href) && options.interactive) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          const clean = href.replace(/[?#].*$/, '');
          void openReviewPath(resolveDocumentPath(tab.review.sourceFile, clean));
        });
      } else {
        link.href = `/api/app/file?r=${encodeURIComponent(tab.id)}&path=${encodeURIComponent(localAssetPath(href))}`;
        link.target = '_blank'; link.rel = 'noopener';
      }
    });
    await renderMermaid(target);
    if (root.__mdturnRenderToken !== renderToken) return false;
    root.replaceChildren(...target.childNodes);
    if (root === nodes.content) {
      root.querySelectorAll('img').forEach((image) => {
        image.addEventListener('load', scheduleMarkerPositions, { once: true });
      });
    }
    return true;
  }

  function localAssetPath(value) {
    const raw = String(value || '').replace(/[?#].*$/, '');
    if (/^file:\/\//i.test(raw)) {
      try { return decodeURIComponent(new URL(raw).pathname); } catch { return raw.replace(/^file:\/\//i, ''); }
    }
    try { return decodeURIComponent(raw); } catch { return raw; }
  }

  function resolveDocumentPath(baseFile, value) {
    const local = localAssetPath(value);
    return local.startsWith('/') ? local : absoluteJoin(baseFile, local);
  }

  async function renderMermaid(root) {
    const diagrams = [];
    root.querySelectorAll('code.language-mermaid').forEach((code) => {
      const parent = code.closest('pre') || code;
      const element = document.createElement('div'); element.className = 'mermaid'; element.textContent = code.textContent;
      parent.replaceWith(element); diagrams.push(element);
    });
    if (diagrams.length && window.mermaid) {
      try { await window.mermaid.run({ nodes: diagrams }); }
      catch (error) { console.warn('Mermaid render failed:', error); }
    }
  }

  function cleanBlockText(block) {
    const copy = block.cloneNode(true);
    copy.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
    return copy.textContent || '';
  }

  function mappedLeafBlocks(root = nodes.content) {
    return $$('[data-line-start]', root).filter((element) => !element.querySelector('[data-line-start]'));
  }

  function blockDescriptors(leaves) {
    return leaves.map((element, index) => ({
      key: index,
      lineStart: Number(element.dataset.lineStart),
      lineEnd: Number(element.dataset.lineEnd),
      text: cleanBlockText(element),
    }));
  }

  function buildOutline(tab) {
    const headings = $$('h1,h2', nodes.content);
    tab.outline = headings.map((heading, index) => {
      const copy = heading.cloneNode(true); copy.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
      const text = copy.textContent.trim();
      const id = `mdturn-heading-${tab.id}-${index}`;
      heading.id = id;
      return {
        id,
        level: heading.tagName === 'H1' ? 1 : 2,
        text,
        lineStart: Number(heading.dataset.lineStart) || 1,
      };
    });
    renderOutline(tab.outline);
  }

  function setOutlineActive(id) {
    $$('.outline-link', nodes.outlinePanel).forEach((button) => {
      const active = button.dataset.headingId === id;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    });
  }

  function updateOutlineActive() {
    state.outlineFrame = null;
    const tab = activeTab();
    if (!tab || tab.mode === 'edit' || !tab.outline.length) return;
    const threshold = nodes.readerScroll.getBoundingClientRect().top + 112;
    let current = tab.outline[0];
    for (const item of tab.outline) {
      const heading = document.getElementById(item.id);
      if (heading && heading.getBoundingClientRect().top <= threshold) current = item;
      else if (heading) break;
    }
    setOutlineActive(current.id);
  }

  function scheduleOutlineUpdate() {
    if (state.outlineFrame !== null) return;
    state.outlineFrame = requestAnimationFrame(updateOutlineActive);
  }

  function renderOutline(outline) {
    nodes.outlinePanel.replaceChildren();
    if (!outline || !outline.length) {
      nodes.outlinePanel.appendChild(emptyBlock(activeTab() ? '这篇文档没有一级或二级标题。' : '打开文档后，这里会显示文章结构。', 'outline-empty'));
      return;
    }
    const fragment = document.createDocumentFragment();
    let h1Index = 0;
    outline.forEach((item) => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `outline-link h${item.level}`;
      button.dataset.headingId = item.id;
      if (item.level === 1) h1Index += 1;
      const number = document.createElement('span'); number.className = 'outline-number'; number.textContent = item.level === 1 ? String(h1Index) : '';
      const text = document.createElement('span'); text.className = 'outline-text'; text.textContent = item.text;
      button.append(number, text);
      button.addEventListener('click', () => {
        const tab = activeTab();
        setOutlineActive(item.id);
        if (tab?.mode === 'edit' && window.MDTurnEditor && state.editorView && typeof window.MDTurnEditor.revealLine === 'function') {
          window.MDTurnEditor.revealLine(state.editorView, item.lineStart);
          return;
        }
        const target = document.getElementById(item.id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      fragment.appendChild(button);
    });
    nodes.outlinePanel.appendChild(fragment);
  }

  function headingPathFor(block) {
    if (!block) return [];
    const stack = [];
    $$('h1,h2,h3,h4,h5,h6', nodes.content).forEach((heading) => {
      if (block.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) {
        const level = Number(heading.tagName.slice(1));
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        const copy = heading.cloneNode(true); copy.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
        stack.push({ level, text: copy.textContent.trim() });
      }
    });
    return stack.map((item) => item.text);
  }

  function figureRefOf(block, quote) {
    const candidates = [quote || '', block ? cleanBlockText(block) : ''];
    for (const text of candidates) {
      const match = text.match(/(图|表|Figure|Fig\.?|Table)\s*[\d０-９][\d０-９.\-—－]*/i);
      if (match) return match[0].replace(/\s+/g, ' ').trim();
    }
    return null;
  }

  function textOffset(block, container, offset) {
    try {
      const range = document.createRange();
      range.selectNodeContents(block);
      range.setEnd(container, offset);
      const fragment = range.cloneContents();
      fragment.querySelectorAll?.('.note-pin').forEach((pin) => pin.remove());
      return (fragment.textContent || '').length;
    } catch { return null; }
  }

  function intersectRangeWithBlock(range, block) {
    try {
      if (!range.intersectsNode(block)) return null;
      const blockRange = document.createRange(); blockRange.selectNodeContents(block);
      const intersection = document.createRange();
      if (range.compareBoundaryPoints(Range.START_TO_START, blockRange) >= 0) intersection.setStart(range.startContainer, range.startOffset);
      else intersection.setStart(blockRange.startContainer, blockRange.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, blockRange) <= 0) intersection.setEnd(range.endContainer, range.endOffset);
      else intersection.setEnd(blockRange.endContainer, blockRange.endOffset);
      return !intersection.collapsed && intersection.toString().trim() ? intersection : null;
    } catch { return null; }
  }

  function captureSelectionAnchor() {
    const tab = activeTab();
    const selection = window.getSelection();
    if (!statusCanAnnotate(tab) || !selection || selection.isCollapsed || !selection.rangeCount) return null;
    if (nodes.content.dataset.tabId !== tab.id) return null;
    const range = selection.getRangeAt(0);
    if (!nodes.content.contains(range.startContainer) || !nodes.content.contains(range.endContainer)) return null;
    const leaves = mappedLeafBlocks();
    const selected = [];
    leaves.forEach((block, index) => {
      const intersection = intersectRangeWithBlock(range, block);
      if (intersection) selected.push({ block, index, intersection });
    });
    if (!selected.length) return null;
    const first = selected[0], last = selected[selected.length - 1];
    const start = textOffset(first.block, first.intersection.startContainer, first.intersection.startOffset);
    const end = textOffset(last.block, last.intersection.endContainer, last.intersection.endOffset);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    try {
      return Anchor.createAnchorFromBlocks(
        blockDescriptors(leaves),
        { blockIndex: first.index, offset: start },
        { blockIndex: last.index, offset: end },
        {
          headingPath: headingPathFor(first.block),
          figureRef: figureRefOf(first.block, selection.toString()),
          reviewSessionId: tab.id,
        },
      );
    } catch (error) {
      console.warn('Anchor capture failed:', error);
      return null;
    }
  }

  function positionAnnotateButton(range) {
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;
    const left = Math.min(window.innerWidth - 92, Math.max(12, rect.right + 10));
    const top = Math.min(window.innerHeight - 52, Math.max(68, rect.bottom + 8));
    nodes.annotate.style.left = `${left}px`; nodes.annotate.style.top = `${top}px`;
  }

  function maybeHintNextRound(selection) {
    const tab = activeTab();
    if (!tab || tab.mode !== 'read') return;
    if (tab.review.status !== 'complete' && tab.review.status !== 'cancelled') return;
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    if (nodes.content.dataset.tabId !== tab.id) return;
    if (!nodes.content.contains(selection.getRangeAt(0).startContainer)) return;
    const now = Date.now();
    if (now - (state.nextRoundHintAt || 0) < 6000) return;
    state.nextRoundHintAt = now;
    toast('本轮审阅已结束，点右上角「开始新一轮审阅」即可继续批注。');
  }

  function handleSelectionChange() {
    if (state.selectionFrame) cancelAnimationFrame(state.selectionFrame);
    state.selectionFrame = requestAnimationFrame(() => {
      state.selectionFrame = null;
      if (!nodes.annotationDialog.hidden) return;
      const anchor = captureSelectionAnchor();
      const selection = window.getSelection();
      if (!anchor || !selection || !selection.rangeCount) {
        nodes.annotate.hidden = true;
        maybeHintNextRound(selection);
        return;
      }
      state.cachedAnchor = anchor;
      positionAnnotateButton(selection.getRangeAt(0));
      nodes.annotate.hidden = false;
    });
  }

  function textPoint(block, offset) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) { return node.parentElement && node.parentElement.closest('.note-pin') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    let remaining = Math.max(0, Number(offset) || 0), node = walker.nextNode(), last = null;
    while (node) {
      last = node;
      if (remaining <= node.data.length) return { node, offset: remaining };
      remaining -= node.data.length;
      node = walker.nextNode();
    }
    return last ? { node: last, offset: last.data.length } : { node: block, offset: 0 };
  }

  function rangeForSegment(block, segment) {
    const start = textPoint(block, segment.startTextOffset), end = textPoint(block, segment.endTextOffset);
    try {
      const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
      return range.collapsed ? null : range;
    } catch { return null; }
  }

  function clearMarkerOverlay() {
    if (state.markerFrame) cancelAnimationFrame(state.markerFrame);
    state.markerFrame = null;
    state.markerEntries = [];
    if (nodes.annotationOverlay) nodes.annotationOverlay.replaceChildren();
  }

  function markerClientRect(entry) {
    if (entry.range) {
      try {
        const start = entry.range.cloneRange();
        start.collapse(true);
        const collapsedRects = start.getClientRects();
        if (collapsedRects.length) return collapsedRects[0];
        const selectedRects = entry.range.getClientRects();
        if (selectedRects.length) return selectedRects[0];
      } catch (_) {}
    }
    return entry.block && entry.block.getBoundingClientRect ? entry.block.getBoundingClientRect() : null;
  }

  function renderPinContent(button, notes) {
    button.__mdturnNotes = notes;
    button.title = `打开 ${notes.length} 条批注`;
    button.innerHTML = '<i class="ph ph-chat-circle-dots" aria-hidden="true"></i>' +
      (notes.length > 1 ? `<span>${notes.length}</span>` : '');
  }

  function positionMarkerPins() {
    state.markerFrame = null;
    const tab = activeTab();
    if (!tab || tab.mode !== 'read' || !nodes.annotationOverlay || nodes.readerScroll.hidden) return;
    const overlayRect = nodes.annotationOverlay.getBoundingClientRect();
    const positions = [];
    state.markerEntries.forEach((entry) => {
      entry.button.hidden = false;
      renderPinContent(entry.button, entry.baseNotes);
      const rect = markerClientRect(entry);
      if (!rect || rect.bottom < overlayRect.top || rect.top > overlayRect.bottom) {
        entry.button.hidden = true;
        return;
      }
      let left = rect.left - overlayRect.left - 34;
      if (left < 4) left = rect.right - overlayRect.left + 6;
      left = Math.min(Math.max(4, left), Math.max(4, overlayRect.width - 34));
      const top = Math.min(Math.max(4, rect.top - overlayRect.top - 1), Math.max(4, overlayRect.height - 28));
      positions.push({ entry, left, top });
    });

    positions.sort((a, b) => a.top - b.top || a.left - b.left);
    const clusters = [];
    positions.forEach((position) => {
      const nearby = clusters.find((cluster) =>
        Math.abs(cluster.top - position.top) < 18 && Math.abs(cluster.left - position.left) < 34);
      if (nearby) {
        nearby.notes.push(...position.entry.baseNotes);
        position.entry.button.hidden = true;
        renderPinContent(nearby.entry.button, nearby.notes);
        return;
      }
      clusters.push({ ...position, notes: position.entry.baseNotes.slice() });
      position.entry.button.style.left = `${Math.round(position.left)}px`;
      position.entry.button.style.top = `${Math.round(position.top)}px`;
    });
  }

  function scheduleMarkerPositions() {
    if (state.markerFrame) cancelAnimationFrame(state.markerFrame);
    state.markerFrame = requestAnimationFrame(positionMarkerPins);
  }

  function renderMarkers(tab) {
    if (nodes.content.dataset.tabId && nodes.content.dataset.tabId !== tab.id) return;
    nodes.content.querySelectorAll('.note-pin').forEach((pin) => pin.remove());
    nodes.content.querySelectorAll('.legacy-note-block').forEach((block) => block.classList.remove('legacy-note-block'));
    clearMarkerOverlay();
    if (globalThis.CSS && CSS.highlights) CSS.highlights.delete('mdturn-open');
    const open = openAnnotations(tab);
    if (!open.length) return;
    const leaves = mappedLeafBlocks();
    const descriptors = blockDescriptors(leaves);
    const ranges = [];
    const groups = new Map();
    open.forEach((note) => {
      const resolved = Anchor.resolveAnchor(note, descriptors);
      if (!resolved.matched || !resolved.segments.length) return;
      let markerRange = null;
      resolved.segments.forEach((segment) => {
        const block = leaves[segment.blockIndex]; if (!block) return;
        const range = rangeForSegment(block, segment);
        if (range) {
          ranges.push(range);
          if (!markerRange) markerRange = range;
        }
      });
      // Prefer the exact quote/offset range for every annotation that can be
      // resolved precisely, including legacy annotations upgraded at read
      // time.  Whole-block tinting is only a last-resort fallback for browsers
      // without CSS Highlights or genuinely line-range-only legacy records.
      if (!globalThis.CSS || !CSS.highlights || resolved.method === 'line-range') {
        resolved.blockIndexes.forEach((index) => leaves[index] && leaves[index].classList.add('legacy-note-block'));
      }
      const key = `${resolved.startBlockIndex}:${resolved.start.offset}`;
      if (!groups.has(key)) groups.set(key, {
        block: leaves[resolved.startBlockIndex],
        range: markerRange,
        notes: [],
      });
      groups.get(key).notes.push(note);
    });
    if (ranges.length && globalThis.Highlight && CSS.highlights) CSS.highlights.set('mdturn-open', new Highlight(...ranges));
    groups.forEach(({ block, range, notes }) => {
      if (!block) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'note-pin';
      renderPinContent(button, notes);
      button.addEventListener('click', () => {
        const currentNotes = button.__mdturnNotes || notes;
        if (currentNotes[0]) focusNote(currentNotes[0].id);
      });
      nodes.annotationOverlay.appendChild(button);
      state.markerEntries.push({ button, block, range, baseNotes: notes.slice() });
    });
    scheduleMarkerPositions();
  }

  function renderNotes(tab) {
    nodes.openNotesList.replaceChildren(); nodes.historyNotesList.replaceChildren();
    nodes.docNoteButton.hidden = !tab || tab.review.status !== 'reviewing';
    if (!tab) {
      nodes.notesTotal.textContent = '0'; nodes.openNotesCount.textContent = '0'; nodes.historyNotesCount.textContent = '0';
      nodes.openNotesList.appendChild(emptyBlock('打开文档后，这里会显示当前轮次的批注。'));
      return;
    }
    state.renderingHistory = true;
    nodes.historySection.open = !!tab.historyOpen;
    state.renderingHistory = false;
    const organized = Anchor.organizeAnnotations(tab.annotations, { historyExpanded: nodes.historySection.open });
    nodes.notesTotal.textContent = String(organized.totalCount);
    nodes.openNotesCount.textContent = String(organized.open.count);
    nodes.historyNotesCount.textContent = String(organized.history.count);
    // 总体意见(scope=document)固定置顶,组内仍保持最新在前。
    const openItems = organized.open.items.slice()
      .sort((left, right) => (isDocNote(right) ? 1 : 0) - (isDocNote(left) ? 1 : 0));
    if (!openItems.length) nodes.openNotesList.appendChild(emptyBlock('本轮还没有批注。选中正文可划词批注；针对全篇的意见请点上方“写总体意见”。'));
    else openItems.forEach((note) => nodes.openNotesList.appendChild(noteCard(tab, note, false)));
    if (!organized.history.items.length) nodes.historyNotesList.appendChild(emptyBlock('还没有历史批注。'));
    else organized.history.items.forEach((note) => nodes.historyNotesList.appendChild(noteCard(tab, note, true)));
  }

  function noteCard(tab, note, historical) {
    const card = document.createElement('article');
    card.className = `note-card${tab.focusedNoteId === note.id ? ' focused' : ''}`; card.dataset.noteId = note.id;
    const meta = document.createElement('div'); meta.className = 'note-meta';
    const author = document.createElement('strong'); author.textContent = note.author || '我(本机)';
    const time = document.createElement('span'); time.className = 'note-time'; time.textContent = formatRelativeTime(note.createdAt || note.updatedAt);
    meta.append(author, time);
    const quote = document.createElement('p'); quote.className = 'note-quote';
    if (isDocNote(note)) { quote.classList.add('doc-scope'); quote.textContent = '全篇 · 总体意见'; }
    else quote.textContent = `引用：“${String(note.quote || '').slice(0, 150)}”`;
    const comment = document.createElement('p'); comment.className = 'note-comment'; comment.textContent = note.comment || '';
    const location = document.createElement('div'); location.className = 'note-location';
    location.textContent = isDocNote(note) ? '全篇'
      : Array.isArray(note.headingPath) && note.headingPath.length ? note.headingPath.join(' › ') : '正文';
    card.append(meta, quote, comment, location);
    if (historical) {
      const status = document.createElement('div'); const effective = effectiveStatus(note);
      status.className = `note-status-badge${effective === 'wontfix' ? ' wontfix' : ''}`;
      status.textContent = effective === 'wontfix' ? '本轮未修改' : '已处理';
      card.appendChild(status);
      if (note.appliedNote) { const applied = document.createElement('div'); applied.className = 'applied-note'; applied.textContent = note.appliedNote; card.appendChild(applied); }
    } else {
      const actions = document.createElement('div'); actions.className = 'note-actions';
      if (tab.review.status === 'reviewing') {
        actions.append(actionButton('编辑', () => openAnnotationDialog({ note })), actionButton('删除', () => deleteNote(note), 'danger'));
      } else if (tab.review.status === 'applying' && tab.review.applyMode === 'manual') {
        actions.append(actionButton('不改', () => resolveNote(note, 'wontfix'), 'skip'), actionButton('标记已处理', () => resolveNote(note, 'applied'), 'resolve'));
      }
      card.appendChild(actions);
    }
    card.addEventListener('click', (event) => { if (!event.target.closest('button')) focusNote(note.id, { scrollOnly: historical }); });
    return card;
  }

  function actionButton(text, handler, className = '') {
    const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = text;
    button.addEventListener('click', (event) => { event.stopPropagation(); void handler(); }); return button;
  }

  function focusNote(noteId, options = {}) {
    const tab = activeTab(); if (!tab) return;
    tab.focusedNoteId = noteId; toggleRight(false); renderNotes(tab);
    const note = tab.annotations.find((item) => item.id === noteId); if (!note) return;
    if (tab.mode === 'edit') {
      const line = Math.max(1, Number(note.lineStart) || 1);
      if (window.MDTurnEditor && state.editorView && typeof window.MDTurnEditor.revealLine === 'function') {
        window.MDTurnEditor.revealLine(state.editorView, line);
      } else if (state.editorView && state.editorView.__mdturnFallback === true) {
        const value = state.editorView.value || '';
        const position = value.split('\n').slice(0, line - 1).reduce((total, part) => total + part.length + 1, 0);
        state.editorView.focus(); state.editorView.setSelectionRange(position, position);
      }
    } else if (isDocNote(note)) {
      nodes.readerScroll.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      const leaves = mappedLeafBlocks(); const resolved = Anchor.resolveAnchor(note, blockDescriptors(leaves));
      if (resolved.matched && leaves[resolved.startBlockIndex]) {
        leaves[resolved.startBlockIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    requestAnimationFrame(() => {
      const card = nodes.right.querySelector(`[data-note-id="${CSS.escape(noteId)}"]`); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    if (!options.scrollOnly) setTimeout(() => { tab.focusedNoteId = null; renderNotes(tab); }, 2600);
  }

  function openAnnotationDialog({ anchor = null, note = null, scope = null }) {
    const tab = activeTab(); if (!tab || tab.review.status !== 'reviewing') return;
    const docScope = scope === 'document' || isDocNote(note);
    state.dialog = {
      tabId: tab.id,
      sourceHash: tab.sourceHash,
      anchor: note || docScope ? null : anchor,
      scope: docScope ? 'document' : null,
      noteId: note && note.id,
      requestId: note ? null : requestId('annotation'),
    };
    nodes.annotationTitle.textContent = docScope
      ? (note ? '编辑总体意见' : '写总体意见')
      : (note ? '编辑批注' : '添加批注');
    nodes.annotationQuote.hidden = docScope;
    nodes.annotationQuote.textContent = docScope ? '' : `“${((note || anchor || {}).quote) || ''}”`;
    nodes.annotationText.placeholder = docScope
      ? '对整篇文档的意见：整体结构、方向、要不要重写、想先讨论什么……'
      : '这段内容哪里需要修改？希望补充什么？';
    nodes.annotationText.value = note ? note.comment || '' : '';
    nodes.annotationSave.textContent = note ? '保存修改' : '保存批注';
    nodes.annotationDialog.hidden = false;
    requestAnimationFrame(() => {
      restoreAnnotationDialogPosition();
      setTimeout(() => nodes.annotationText.focus(), 30);
    });
  }

  function closeAnnotationDialog(options = {}) {
    endAnnotationDialogDrag();
    nodes.annotationDialog.hidden = true;
    nodes.annotationSave.disabled = false;
    nodes.annotationSave.textContent = '保存批注';
    if (!options.keepState) state.dialog = null;
  }

  function dialogPositionKey() { return 'mdturn.annotationDialogPosition'; }

  function clampAnnotationDialog(left, top) {
    const panel = nodes.annotationDialogPanel;
    const width = panel.offsetWidth || 560;
    const height = panel.offsetHeight || 420;
    const margin = 8;
    return {
      left: Math.min(Math.max(margin, Number(left) || margin), Math.max(margin, window.innerWidth - width - margin)),
      top: Math.min(Math.max(margin, Number(top) || margin), Math.max(margin, window.innerHeight - height - margin)),
    };
  }

  function setAnnotationDialogPosition(left, top, options = {}) {
    const position = clampAnnotationDialog(left, top);
    const panel = nodes.annotationDialogPanel;
    panel.style.setProperty('--annotation-dialog-left', `${Math.round(position.left)}px`);
    panel.style.setProperty('--annotation-dialog-top', `${Math.round(position.top)}px`);
    panel.style.setProperty('--annotation-dialog-translate-x', '0px');
    panel.style.setProperty('--annotation-dialog-translate-y', '0px');
    if (options.persist !== false) {
      try { localStorage.setItem(dialogPositionKey(), JSON.stringify(position)); } catch (_) {}
    }
    return position;
  }

  function resetAnnotationDialogPosition() {
    const panel = nodes.annotationDialogPanel;
    panel.style.removeProperty('--annotation-dialog-left');
    panel.style.removeProperty('--annotation-dialog-top');
    panel.style.removeProperty('--annotation-dialog-translate-x');
    panel.style.removeProperty('--annotation-dialog-translate-y');
    try { localStorage.removeItem(dialogPositionKey()); } catch (_) {}
  }

  function restoreAnnotationDialogPosition() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(dialogPositionKey()) || 'null'); } catch (_) {}
    if (stored && Number.isFinite(stored.left) && Number.isFinite(stored.top)) {
      setAnnotationDialogPosition(stored.left, stored.top, { persist: false });
    } else {
      resetAnnotationDialogPosition();
    }
  }

  function beginAnnotationDialogDrag(event) {
    if (event.button !== 0 || event.target.closest('.dialog-close')) return;
    const panel = nodes.annotationDialogPanel;
    const rect = panel.getBoundingClientRect();
    setAnnotationDialogPosition(rect.left, rect.top, { persist: false });
    state.dialogDrag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    panel.classList.add('is-dragging');
    try { nodes.annotationDialogHandle.setPointerCapture(event.pointerId); } catch (_) {}
    event.preventDefault();
  }

  function moveAnnotationDialog(event) {
    if (!state.dialogDrag || event.pointerId !== state.dialogDrag.pointerId) return;
    setAnnotationDialogPosition(
      event.clientX - state.dialogDrag.offsetX,
      event.clientY - state.dialogDrag.offsetY,
      { persist: false },
    );
    event.preventDefault();
  }

  function endAnnotationDialogDrag(event = null) {
    if (!state.dialogDrag || (event && event.pointerId !== state.dialogDrag.pointerId)) return;
    const pointerId = state.dialogDrag.pointerId;
    state.dialogDrag = null;
    nodes.annotationDialogPanel.classList.remove('is-dragging');
    try { nodes.annotationDialogHandle.releasePointerCapture(pointerId); } catch (_) {}
    if (!nodes.annotationDialog.hidden) {
      const rect = nodes.annotationDialogPanel.getBoundingClientRect();
      setAnnotationDialogPosition(rect.left, rect.top);
    }
  }

  function keepAnnotationDialogInView() {
    if (nodes.annotationDialog.hidden) return;
    const rect = nodes.annotationDialogPanel.getBoundingClientRect();
    setAnnotationDialogPosition(rect.left, rect.top, { persist: false });
  }

  async function saveAnnotation() {
    const dialog = state.dialog;
    const tab = dialog && state.tabs.find((candidate) => candidate.id === dialog.tabId);
    const comment = nodes.annotationText.value.trim();
    if (!tab || !dialog || !comment) return toast('批注内容不能为空。', 'error');
    if (tab.review.status !== 'reviewing' || tab.sourceHash !== dialog.sourceHash) {
      return toast('这条批注对应的文档状态已经变化，请关闭弹窗后重新选择。', 'error');
    }
    nodes.annotationSave.disabled = true; nodes.annotationSave.textContent = '保存中…';
    try {
      let result;
      if (dialog.noteId) {
        result = await requestJson(`/api/annotations?r=${encodeURIComponent(tab.id)}&id=${encodeURIComponent(dialog.noteId)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment }),
        });
        const current = tab.annotations.find((item) => item.id === dialog.noteId);
        if (current) Object.assign(current, result.note || {}, { comment });
      } else {
        const payload = {
          ...dialog.anchor,
          comment,
          author: '我(本机)',
          clientRequestId: dialog.requestId,
          reviewSessionId: tab.id,
          sourceHash: tab.review.sourceHash,
        };
        if (dialog.scope === 'document') payload.scope = 'document';
        result = await requestJson(`/api/annotations?r=${encodeURIComponent(tab.id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (result.note && !tab.annotations.some((item) => item.id === result.note.id)) tab.annotations.push(result.note);
      }
      closeAnnotationDialog();
      window.getSelection()?.removeAllRanges(); state.cachedAnchor = null; nodes.annotate.hidden = true;
      if (tab.id === state.activeId) {
        renderMarkers(tab); renderNotes(tab); renderStatus(tab);
      }
      renderTabs();
      toast(dialog.noteId ? '批注已更新。' : '批注已保存。');
    } catch (error) {
      nodes.annotationSave.disabled = false;
      nodes.annotationSave.textContent = dialog.noteId ? '保存修改' : '保存批注';
      toast(friendlyError(error, dialog.noteId ? '修改批注' : '保存批注'), 'error');
      void refreshTab(tab, { silent: true });
    }
  }

  async function deleteNote(note) {
    const tab = activeTab(); if (!tab) return;
    const accepted = await confirmAction('删除这条批注？', '删除后无法恢复，但不会改变源 Markdown。', '删除');
    if (!accepted) return;
    try {
      await requestJson(`/api/annotations?r=${encodeURIComponent(tab.id)}&id=${encodeURIComponent(note.id)}`, { method: 'DELETE' });
      tab.annotations = tab.annotations.filter((item) => item.id !== note.id);
      renderMarkers(tab); renderNotes(tab); renderStatus(tab); toast('批注已删除。');
    } catch (error) { toast(friendlyError(error, '删除批注'), 'error'); }
  }

  async function resolveNote(note, status) {
    const tab = activeTab(); if (!tab) return;
    captureEditorValue(tab);
    // A note is not considered handled until the corresponding source edits
    // are safely on disk.  This prevents a crash or failed save from leaving a
    // green "已处理" record while the Markdown still contains the old text.
    if (tab.dirty && !(await saveSource(tab))) return;
    try {
      const result = await requestJson(`/api/app/annotation?r=${encodeURIComponent(tab.id)}&id=${encodeURIComponent(note.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          appliedNote: status === 'applied' ? '由我在 MDTurn 中手工修改并确认。' : '由我在 MDTurn 中确认本轮不修改。',
          expectedSourceHash: tab.sourceHash,
          expectedRevision: tab.revision,
        }),
      });
      const current = tab.annotations.find((item) => item.id === note.id);
      if (current) Object.assign(current, result.annotation || {}, { status });
      renderNotes(tab); renderStatus(tab); renderMarkers(tab);
      toast(status === 'applied' ? '已标记为处理完成。' : '已记录为本轮不修改。');
    } catch (error) { toast(friendlyError(error, '更新批注状态'), 'error'); }
  }

  function captureEditorValue(tab) {
    if (!tab || state.editorTabId !== tab.id || !state.editorView) return;
    const value = getEditorValue();
    if (value !== tab.source) { tab.editorDraft = value; tab.dirty = true; }
  }

  function getEditorValue() {
    if (!state.editorView) return '';
    if (window.MDTurnEditor && state.editorView.__mdturnFallback !== true) return window.MDTurnEditor.getValue(state.editorView);
    return state.editorView.value || '';
  }

  function createEditor(tab) {
    destroyEditor();
    nodes.codeEditor.replaceChildren();
    const doc = tab.editorDraft != null ? tab.editorDraft : tab.source;
    if (window.MDTurnEditor) {
      state.editorView = window.MDTurnEditor.create(nodes.codeEditor, { doc, onChange: (value) => editorChanged(tab, value) });
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = doc; textarea.className = 'fallback-editor'; textarea.__mdturnFallback = true;
      textarea.addEventListener('input', () => editorChanged(tab, textarea.value));
      nodes.codeEditor.appendChild(textarea); state.editorView = textarea;
    }
    state.editorTabId = tab.id;
  }

  function destroyEditor() {
    if (state.editorView && window.MDTurnEditor && state.editorView.__mdturnFallback !== true) {
      try { window.MDTurnEditor.destroy(state.editorView); } catch (_) {}
    }
    state.editorView = null; state.editorTabId = null; nodes.codeEditor.replaceChildren();
  }

  function editorChanged(tab, value) {
    if (tab.id !== state.activeId) return;
    tab.editorDraft = value; tab.dirty = value !== tab.source;
    if (tab.dirty && !tab.saveRequestId) tab.saveRequestId = requestId('source');
    if (tab.dirty) scheduleDraft(tab); else clearDraft(tab);
    updateSaveState(tab);
    if (!tab.dirty && tab.remotePending) {
      const pending = tab.remotePending;
      void queueRemoteReviewChange(pending.reviewId || tab.id, pending);
    }
  }

  function renderEditor(tab) {
    clearMarkerOverlay();
    tab.mode = 'edit';
    nodes.readerPane.hidden = true; nodes.editorPane.hidden = false;
    if (state.editorTabId !== tab.id) createEditor(tab);
    updateSaveState(tab);
    nodes.finishManual.hidden = !(tab.review.status === 'applying' && tab.review.applyMode === 'manual');
    renderOutline(tab.outline);
  }

  function updateSaveState(tab, mode = '') {
    nodes.editorSaveState.className = `save-state${mode ? ` ${mode}` : (tab.dirty ? ' dirty' : '')}`;
    nodes.editorSaveState.textContent = mode === 'saving' ? '保存中…' : mode === 'error' ? '保存失败，修改仍在编辑器中' : tab.dirty ? '有未保存的修改' : '所有更改均已保存';
    nodes.saveButton.disabled = mode === 'saving' || !tab.dirty;
  }

  async function saveSource(tab = activeTab()) {
    if (!tab) return false;
    if (tab.mode === 'edit') captureEditorValue(tab);
    if (!tab.dirty) return true;
    if (tab.mode !== 'edit') {
      tab.mode = 'edit'; renderApp();
      toast('仍有未保存的修改，已返回编辑模式。', 'error');
      return false;
    }
    const content = tab.editorDraft != null ? tab.editorDraft : getEditorValue();
    const idempotencyKey = tab.saveRequestId || requestId('source'); tab.saveRequestId = idempotencyKey;
    updateSaveState(tab, 'saving');
    try {
      const result = await requestJson(`/api/app/source?r=${encodeURIComponent(tab.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, expectedHash: tab.sourceHash, clientRequestId: idempotencyKey }),
      });
      tab.source = content;
      tab.sourceHash = result.currentHash || result.hash || (result.review && result.review.workingHash) || tab.sourceHash;
      tab.revision = Number(result.currentRevision ?? result.revision ?? tab.revision);
      if (result.review) tab.review = { ...tab.review, ...result.review };
      tab.dirty = false; tab.editorDraft = null; tab.saveRequestId = null; tab.renderedHash = null;
      clearDraft(tab);
      updateSaveState(tab); renderTabs();
      toast('Markdown 已安全保存。');
      if (tab.remotePending) {
        const pending = tab.remotePending;
        void queueRemoteReviewChange(pending.reviewId || tab.id, pending);
      }
      return true;
    } catch (error) {
      updateSaveState(tab, 'error');
      toast(friendlyError(error, '保存 Markdown'), 'error');
      return false;
    }
  }

  async function enterEditMode() {
    let tab = activeTab(); if (!tab) return;
    const review = tab.review;
    if (review.status === 'conflict' || (review.status === 'applying' && review.applyMode !== 'manual')) return;
    if (review.status === 'reviewing') {
      const count = openAnnotations(tab).length;
      const accepted = await confirmAction(
        count ? '提交审阅并开始手工修改？' : '结束审阅并进入编辑？',
        count
          ? `本轮有 ${count} 条未处理批注。进入编辑后，你需要对照右栏逐条修改并确认。`
          : '本轮没有批注，将记录为审核通过，然后进入自由编辑模式。',
        count ? '提交并手工修改' : '结束审阅并编辑',
      );
      if (!accepted) return;
      // The edit-entry dialog above is already the user's confirmation.  Do
      // not immediately ask the same question a second time inside
      // submitReview().
      const submitted = await submitReview(tab, { silentSuccess: true, skipConfirm: true });
      if (!submitted) return;
      tab = activeTab();
    }
    if (tab.review.status === 'complete' || tab.review.status === 'cancelled') {
      // 终态之后进编辑 = 开一轮"手工修改轮"(applying/manual),把写者身份记进会话,
      // 智能体此时 mdreview open 会看到用户正在改,不会把文档重新冻结。
      try {
        const result = await requestJson(`/api/app/review/manual-edit?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
        const bundle = await fetchBundle(result.review.id);
        tab = upsertTab(bundle, { activate: true });
      } catch (error) { toast(friendlyError(error, '进入编辑'), 'error'); return; }
    }
    if (tab.review.status === 'ready_to_apply') {
      try {
        const result = await requestJson(`/api/app/review/begin-apply?r=${encodeURIComponent(tab.id)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manual' }),
        });
        tab.review = result.review; tab.sourceHash = tab.review.workingHash || tab.sourceHash;
      } catch (error) { toast(friendlyError(error, '开始手工修改'), 'error'); return; }
    }
    tab.mode = 'edit';
    if (tab.review.status === 'applying') { state.leftCollapsed = true; state.rightCollapsed = false; }
    persistTabs(); renderApp();
    setTimeout(() => { if (window.MDTurnEditor && state.editorView) window.MDTurnEditor.focus(state.editorView); }, 60);
  }

  async function enterReadMode() {
    const tab = activeTab(); if (!tab) return;
    captureEditorValue(tab);
    if (tab.dirty && !(await saveSource(tab))) return;
    tab.mode = 'read'; persistTabs(); renderApp();
  }

  async function submitReview(tab, options = {}) {
    const count = openAnnotations(tab).length;
    if (!options.skipConfirm) {
      const accepted = await confirmAction(
        count ? '完成本轮审阅？' : '审核通过，定稿？',
        count
          ? `提交后原文继续保持只读，等待 Agent 或你手工处理 ${count} 条批注。`
          : '全文没有任何批注，将记录为“审核通过”，本轮结束。若想让智能体重写或先讨论，请取消，在右栏写一条总体意见再提交。',
        count ? '完成本轮审阅' : '通过并定稿',
      );
      if (!accepted) return false;
    }
    nodes.primaryAction.disabled = true; nodes.primaryAction.textContent = '提交中…';
    try {
      const result = await requestJson(`/api/review/submit?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
      tab.review = result.review;
      if (!options.silentSuccess) toast(tab.review.status === 'complete' ? '本轮审核通过。' : '本轮审阅已提交，等待修改。');
      renderApp(); void refreshRecents(); return true;
    } catch (error) { toast(friendlyError(error, '提交审阅'), 'error'); void refreshTab(tab, { silent: true }); return false; }
    finally { nodes.primaryAction.disabled = false; }
  }

  async function finishManualApply() {
    const tab = activeTab(); if (!tab) return;
    if (openAnnotations(tab).length) return toast(`仍有 ${openAnnotations(tab).length} 条未处理批注，请逐条确认后再提交。`, 'error');
    if (!(await saveSource(tab))) return;
    const accepted = await confirmAction('提交本轮修改？', '源 Markdown 已保存，提交后本轮会进入完成状态，可以开始下一轮审阅。', '提交修改');
    if (!accepted) return;
    try {
      const result = await requestJson(`/api/app/review/complete?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
      tab.review = result.review; tab.mode = 'read'; tab.renderedHash = null; destroyEditor();
      renderApp(); void refreshRecents(); toast('本轮手工修改已完成。');
    } catch (error) { toast(friendlyError(error, '提交修改'), 'error'); }
  }

  async function finalizeAndClose() {
    const tab = activeTab(); if (!tab || tab.review.status !== 'complete') return;
    const accepted = await confirmAction('定稿并关闭？',
      '将把这一版记录为终稿：正在等待的智能体会收到"审阅结束"，标签页随即关闭。以后仍可从"最近审阅"重新打开、开始新一轮。',
      '定稿并关闭');
    if (!accepted) return;
    nodes.finalizeAction.disabled = true;
    try {
      const result = await requestJson(`/api/app/review/finalize?r=${encodeURIComponent(tab.id)}`, { method: 'POST' });
      tab.review = result.review;
      toast('已定稿，智能体已收到通知。');
      await closeTab(tab.id);
      void refreshRecents();
    } catch (error) { toast(friendlyError(error, '定稿'), 'error'); void refreshTab(tab, { silent: true }); }
    finally { nodes.finalizeAction.disabled = false; }
  }

  async function startNextRound() {
    const tab = activeTab(); if (!tab) return;
    if (tab.dirty && !(await saveSource(tab))) return;
    await openReviewPath(tab.review.sourceFile);
  }

  async function handlePrimaryAction() {
    const tab = activeTab(); if (!tab) return;
    if (tab.review.status === 'reviewing') return submitReview(tab);
    if (tab.review.status === 'ready_to_apply') return enterEditMode();
    if (tab.review.status === 'applying' && tab.review.applyMode === 'manual') return finishManualApply();
    if (tab.review.status === 'complete' || tab.review.status === 'cancelled') return startNextRound();
  }

  function confirmAction(title, message, acceptText = '确认') {
    nodes.confirmTitle.textContent = title; nodes.confirmMessage.textContent = message; nodes.confirmAccept.textContent = acceptText;
    nodes.confirmDialog.hidden = false;
    return new Promise((resolve) => {
      const finish = (value) => {
        nodes.confirmDialog.hidden = true;
        nodes.confirmAccept.removeEventListener('click', accept); nodes.confirmCancel.removeEventListener('click', cancel);
        resolve(value);
      };
      const accept = () => finish(true), cancel = () => finish(false);
      nodes.confirmAccept.addEventListener('click', accept); nodes.confirmCancel.addEventListener('click', cancel);
      setTimeout(() => nodes.confirmAccept.focus(), 20);
    });
  }

  function installEvents() {
    nodes.openTabButton.addEventListener('click', chooseMarkdown);
    nodes.openFileButton.addEventListener('click', chooseMarkdown);
    nodes.welcomeOpen.addEventListener('click', chooseMarkdown);
    nodes.outlineMode.addEventListener('click', () => setLeftMode('outline'));
    nodes.filesMode.addEventListener('click', () => setLeftMode('files'));
    nodes.collapseLeft.addEventListener('click', () => toggleLeft(true));
    nodes.expandLeft.addEventListener('click', () => toggleLeft(false));
    nodes.toggleLeftTop.addEventListener('click', () => toggleLeft());
    nodes.collapseRight.addEventListener('click', () => toggleRight(true));
    nodes.expandRight.addEventListener('click', () => toggleRight(false));
    nodes.toggleRightTop.addEventListener('click', () => toggleRight());
    nodes.readingMode.addEventListener('click', () => { void enterReadMode(); });
    nodes.editingMode.addEventListener('click', enterEditMode);
    nodes.primaryAction.addEventListener('click', handlePrimaryAction);
    nodes.finalizeAction.addEventListener('click', () => { void finalizeAndClose(); });
    nodes.finishManual.addEventListener('click', finishManualApply);
    nodes.saveButton.addEventListener('click', () => saveSource());
    nodes.annotationSave.addEventListener('click', saveAnnotation);
    nodes.docNoteButton.addEventListener('click', () => openAnnotationDialog({ scope: 'document' }));
    nodes.annotationCancel.addEventListener('click', () => closeAnnotationDialog());
    nodes.annotationClose.addEventListener('click', () => closeAnnotationDialog());
    nodes.annotationDialog.addEventListener('pointerdown', (event) => { if (event.target === nodes.annotationDialog) closeAnnotationDialog(); });
    nodes.annotationDialogHandle.addEventListener('pointerdown', beginAnnotationDialogDrag);
    nodes.annotationDialogHandle.addEventListener('pointermove', moveAnnotationDialog);
    nodes.annotationDialogHandle.addEventListener('pointerup', endAnnotationDialogDrag);
    nodes.annotationDialogHandle.addEventListener('pointercancel', endAnnotationDialogDrag);
    nodes.annotationDialogHandle.addEventListener('dblclick', (event) => {
      if (!event.target.closest('.dialog-close')) resetAnnotationDialogPosition();
    });
    document.addEventListener('selectionchange', handleSelectionChange);
    nodes.annotate.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const anchor = captureSelectionAnchor() || state.cachedAnchor;
      if (anchor) openAnnotationDialog({ anchor });
      else { nodes.annotate.hidden = true; toast('没有识别到有效文字选区，请重新选择。', 'error'); }
    });
    nodes.annotate.addEventListener('click', (event) => { if (!nodes.annotationDialog.hidden) return; event.preventDefault(); const anchor = state.cachedAnchor; if (anchor) openAnnotationDialog({ anchor }); });
    nodes.readerScroll.addEventListener('scroll', () => {
      nodes.annotate.hidden = true;
      const tab = activeTab();
      if (tab) tab.scrollTop = nodes.readerScroll.scrollTop;
      scheduleOutlineUpdate();
      scheduleMarkerPositions();
    }, { passive: true });
    nodes.readerPane.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setReaderZoom(state.readerZoom * Math.exp(-event.deltaY * 0.01));
    }, { passive: false });
    // 编辑模式同样支持触摸板双指缩放,与阅读模式共用同一缩放值
    nodes.editorPane.addEventListener('wheel', (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setReaderZoom(state.readerZoom * Math.exp(-event.deltaY * 0.01));
    }, { passive: false });
    nodes.historySection.addEventListener('toggle', () => {
      if (state.renderingHistory) return;
      const tab = activeTab();
      if (tab) { tab.historyOpen = nodes.historySection.open; renderNotes(tab); }
    });
    window.addEventListener('focus', () => { void reconcileOpenReviews(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void reconcileOpenReviews();
    });
    window.addEventListener('pageshow', () => { void reconcileOpenReviews(); });
    window.addEventListener('resize', () => {
      keepAnnotationDialogInView();
      scheduleMarkerPositions();
    });
    if (typeof ResizeObserver === 'function') {
      state.layoutObserver = new ResizeObserver(() => scheduleMarkerPositions());
      state.layoutObserver.observe(nodes.readerPane);
      state.layoutObserver.observe(nodes.content);
    }
    if (document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => scheduleMarkerPositions()).catch(() => {});
    }
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && ['o', 'w'].includes(event.key.toLowerCase()) && commandBlocked()) {
        event.preventDefault(); return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); handleDesktopCommand('open'); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); handleDesktopCommand('save'); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); handleDesktopCommand('close-tab'); }
      if (event.key === 'Escape') {
        if (!nodes.annotationDialog.hidden) closeAnnotationDialog();
        else { nodes.annotate.hidden = true; window.getSelection()?.removeAllRanges(); }
      }
    });
    window.addEventListener('beforeunload', (event) => {
      if (state.eventSource) state.eventSource.close();
      if (state.reconcileTimer) clearInterval(state.reconcileTimer);
      if (state.layoutObserver) state.layoutObserver.disconnect();
      state.remoteRetryTimers.forEach((timer) => clearTimeout(timer));
      state.remoteRetryTimers.clear();
      state.tabs.forEach((tab) => { if (tab.dirty) persistDraft(tab); });
      if (!state.tabs.some((tab) => tab.dirty)) return;
      event.preventDefault(); event.returnValue = '';
    });
    if (bridge && typeof bridge.onOpenFiles === 'function') bridge.onOpenFiles((paths) => void openPaths(paths));
    if (bridge && typeof bridge.onCommand === 'function') bridge.onCommand(handleDesktopCommand);
    if (bridge && typeof bridge.onActivateReview === 'function') {
      bridge.onActivateReview((reviewId) => {
        if (state.tabs.some((tab) => tab.id === reviewId)) activateTab(reviewId);
        else void openReviewId(reviewId);
      });
    }
  }

  async function init() {
    installEvents();
    renderLayoutState();
    applyReaderZoom();
    await refreshRecents();
    await restoreTabs();
    renderApp();
    installReviewEvents();
    await reconcileOpenReviews();
  }

  void init();
})();
