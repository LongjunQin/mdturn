'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const anchor = require('../static/desktop-anchor');
const MODULE_PATH = path.resolve(__dirname, '../static/desktop-anchor.js');

test('UMD 模块同时支持 CommonJS 和浏览器 window 全局', () => {
  assert.equal(anchor.ANCHOR_VERSION, 3);
  assert.equal(typeof anchor.resolveAnchor, 'function');

  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(MODULE_PATH, 'utf8'), sandbox, { filename: MODULE_PATH });
  assert.equal(sandbox.MDTurnAnchor.ANCHOR_VERSION, 3);
  assert.equal(typeof sandbox.MDTurnAnchor.organizeAnnotations, 'function');
});

test('anchorVersion 3 协议固定 UTF-16、end exclusive 和解析退化顺序', () => {
  assert.deepEqual(anchor.ANCHOR_V3_PROTOCOL.required, [
    'anchorVersion', 'lineStart', 'lineEnd',
    'startTextOffset', 'endTextOffset', 'quote', 'prefix', 'suffix',
  ]);
  assert.match(anchor.ANCHOR_V3_PROTOCOL.offsetUnit, /UTF-16/);
  assert.equal(anchor.ANCHOR_V3_PROTOCOL.endOffset, 'exclusive');
  assert.equal(anchor.ANCHOR_V3_PROTOCOL.resolutionOrder.length, 3);
});

test('文本 map 在 block 和全局 offset 之间可往返，分隔符按 bias 处理', () => {
  const map = anchor.buildTextMap([
    { key: 'a', lineStart: 1, lineEnd: 1, text: 'abc' },
    { key: 'b', lineStart: 3, lineEnd: 3, text: '世界' },
  ]);
  assert.equal(map.text, 'abc\n世界');
  assert.equal(anchor.blockPointToGlobal(map, 1, 1), 5);
  assert.deepEqual(anchor.globalOffsetToBlockPoint(map, 3, 'backward'), {
    blockIndex: 0, key: 'a', offset: 3,
  });
  assert.deepEqual(anchor.globalOffsetToBlockPoint(map, 3, 'forward'), {
    blockIndex: 1, key: 'b', offset: 0,
  });
  assert.deepEqual(anchor.rangeToSegments(map, 1, 5), [
    { blockIndex: 0, key: 'a', startTextOffset: 1, endTextOffset: 3 },
    { blockIndex: 1, key: 'b', startTextOffset: 0, endTextOffset: 1 },
  ]);
});

test('createAnchorFromBlocks 生成跨段 v3 锚点，resolve 精确还原两段局部范围', () => {
  const blocks = [
    { key: 'first', lineStart: 10, lineEnd: 10, text: '开头：第一段选中' },
    { key: 'second', lineStart: 12, lineEnd: 12, text: '第二段结束。尾巴' },
    { key: 'third', lineStart: 14, lineEnd: 14, text: '不应高亮' },
  ];
  const startOffset = '开头：'.length;
  const endOffset = '第二段结束。'.length;
  const created = anchor.createAnchorFromBlocks(
    blocks,
    { blockIndex: 0, offset: startOffset },
    { blockIndex: 1, offset: endOffset },
    { headingPath: ['结论'], reviewSessionId: 'round-2' },
  );
  assert.deepEqual(created, {
    anchorVersion: 3,
    lineStart: 10,
    lineEnd: 12,
    startTextOffset: startOffset,
    endTextOffset: endOffset,
    quote: '第一段选中\n第二段结束。',
    prefix: '开头：',
    suffix: '尾巴\n不应高亮',
    headingPath: ['结论'],
    reviewSessionId: 'round-2',
  });

  const resolved = anchor.resolveAnchor(created, blocks);
  assert.equal(resolved.matched, true);
  assert.equal(resolved.method, 'v3-offsets');
  assert.equal(resolved.confidence, 'exact');
  assert.deepEqual(resolved.blockIndexes, [0, 1]);
  assert.deepEqual(resolved.segments, [
    { blockIndex: 0, key: 'first', startTextOffset: startOffset, endTextOffset: blocks[0].text.length },
    { blockIndex: 1, key: 'second', startTextOffset: 0, endTextOffset: endOffset },
  ]);
  assert.equal(resolved.blockIndexes.includes(2), false);
});

test('重复文字中，prefix/suffix 能超过已过期的 v3 offset', () => {
  const text = '甲 目标 乙 目标 丙';
  const blocks = [{ key: 'only', lineStart: 7, lineEnd: 7, text }];
  const first = text.indexOf('目标');
  const second = text.lastIndexOf('目标');
  const stale = anchor.createAnchorV3({
    lineStart: 7,
    lineEnd: 7,
    startTextOffset: first,
    endTextOffset: first + '目标'.length,
    quote: '目标',
    prefix: text.slice(0, second),
    suffix: text.slice(second + '目标'.length),
  });
  const resolved = anchor.resolveAnchor(stale, blocks);
  assert.equal(resolved.method, 'quote-context');
  assert.equal(resolved.start.offset, second);
  assert.equal(resolved.end.offset, second + '目标'.length);
});

test('旧批注也可用 line + quote + prefix/suffix 解除同行歧义', () => {
  const text = '前文 相同引用 中间 相同引用 尾文';
  const second = text.lastIndexOf('相同引用');
  const resolved = anchor.resolveAnchor({
    anchorVersion: 1,
    lineStart: 21,
    lineEnd: 21,
    quote: '相同引用',
    prefix: text.slice(0, second),
    suffix: text.slice(second + '相同引用'.length),
  }, [{ key: 'p', lineStart: 21, lineEnd: 21, text }]);
  assert.equal(resolved.method, 'quote-context');
  assert.equal(resolved.start.offset, second);
  assert.equal(resolved.confidence, 'exact');
});

test('行号过期时可在全文以 quote/context 恢复锚点', () => {
  const blocks = [
    { key: 'old-line', lineStart: 40, lineEnd: 40, text: '新内容' },
    { key: 'moved', lineStart: 80, lineEnd: 80, text: '前缀 需要找到的内容 后缀' },
  ];
  const resolved = anchor.resolveAnchor({
    lineStart: 10,
    lineEnd: 10,
    quote: '需要找到的内容',
    prefix: '前缀 ',
    suffix: ' 后缀',
  }, blocks);
  assert.equal(resolved.matched, true);
  assert.equal(resolved.method, 'quote-context');
  assert.equal(resolved.startBlockIndex, 1);
  assert.equal(resolved.confidence, 'high');
});

test('无 quote 的旧数据保守回退到 line range', () => {
  const blocks = [
    { key: 'a', lineStart: 2, lineEnd: 2, text: '第一段' },
    { key: 'b', lineStart: 4, lineEnd: 4, text: '第二段' },
  ];
  const resolved = anchor.resolveAnchor({ lineStart: 2, lineEnd: 4 }, blocks);
  assert.equal(resolved.method, 'line-range');
  assert.equal(resolved.confidence, 'medium');
  assert.deepEqual(resolved.blockIndexes, [0, 1]);
});

test('effectiveStatus 兼容无 status 旧批注并对未知值 fail-open', () => {
  assert.equal(anchor.effectiveStatus({}), 'open');
  assert.equal(anchor.effectiveStatus({ appliedAt: '2026-07-01T00:00:00Z' }), 'applied');
  assert.equal(anchor.effectiveStatus({ wontfixReason: '不在范围' }), 'wontfix');
  assert.equal(anchor.effectiveStatus({ status: 'resolved' }), 'applied');
  assert.equal(anchor.effectiveStatus({ status: 'dismissed' }), 'wontfix');
  assert.equal(anchor.effectiveStatus({ status: 'future-status', appliedAt: '2026-07-01T00:00:00Z' }), 'open');
});

test('批注视图 open 新到旧、历史默认折叠且按审阅轮次分组', () => {
  const notes = [
    { id: 'history-old', status: 'applied', reviewSessionId: 'round-1', createdAt: '2026-07-01T08:00:00Z', appliedAt: '2026-07-01T09:00:00Z' },
    { id: 'open-old', status: 'open', reviewSessionId: 'round-2', createdAt: '2026-07-02T08:00:00Z' },
    { id: 'open-legacy', createdAt: '2026-07-03T08:00:00Z' },
    { id: 'open-new', status: 'open', reviewSessionId: 'round-2', createdAt: '2026-07-04T08:00:00Z' },
    { id: 'history-new', status: 'resolved', reviewSessionId: 'round-2', createdAt: '2026-07-02T08:00:00Z', appliedAt: '2026-07-05T09:00:00Z' },
    { id: 'history-legacy', appliedAt: '2026-07-04T09:00:00Z' },
  ];
  const originalOrder = notes.map((note) => note.id);
  const grouped = anchor.organizeAnnotations(notes);

  assert.deepEqual(grouped.open.items.map((note) => note.id), ['open-new', 'open-legacy', 'open-old']);
  assert.equal(grouped.open.collapsed, false);
  assert.equal(grouped.history.collapsed, true);
  assert.deepEqual(grouped.history.items.map((note) => note.id), ['history-new', 'history-legacy', 'history-old']);
  assert.deepEqual(grouped.visible.map((note) => note.id), ['open-new', 'open-legacy', 'open-old']);
  assert.deepEqual(grouped.history.rounds.map((round) => round.id), ['round-2', 'legacy', 'round-1']);
  assert.deepEqual(notes.map((note) => note.id), originalOrder, '不得改写 sidecar 原始顺序');

  const expanded = anchor.organizeAnnotations(notes, { historyExpanded: true });
  assert.equal(expanded.history.collapsed, false);
  assert.equal(expanded.visible.length, notes.length);
});

test('createAnchorV3 校验必填坐标并可明确禁用 context', () => {
  assert.throws(() => anchor.createAnchorV3({ lineStart: 0, lineEnd: 1 }), /lineStart\/lineEnd/);
  const created = anchor.createAnchorV3({
    lineStart: 1, lineEnd: 1, startTextOffset: 1, endTextOffset: 2,
    quote: 'b', prefix: 'abcdef', suffix: 'ghijkl',
  }, { contextLength: 0 });
  assert.equal(created.prefix, '');
  assert.equal(created.suffix, '');
});
