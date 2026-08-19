// 用 CrepeBuilder 按需装配功能(而非整包 Crepe):跳过 Latex,避免把 KaTeX
// 字体一并打进 vendor;其余功能与 Crepe 默认集一致。
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { toolbar } from '@milkdown/crepe/feature/toolbar';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { table } from '@milkdown/crepe/feature/table';
import { editorViewCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { replaceAll } from '@milkdown/kit/utils';
// 样式同样按功能逐个引入(不用聚合的 common/style.css,它会连带 KaTeX 字体)
import '@milkdown/crepe/theme/common/prosemirror.css';
import '@milkdown/crepe/theme/common/reset.css';
import '@milkdown/crepe/theme/common/block-edit.css';
import '@milkdown/crepe/theme/common/code-mirror.css';
import '@milkdown/crepe/theme/common/cursor.css';
import '@milkdown/crepe/theme/common/image-block.css';
import '@milkdown/crepe/theme/common/link-tooltip.css';
import '@milkdown/crepe/theme/common/list-item.css';
import '@milkdown/crepe/theme/common/placeholder.css';
import '@milkdown/crepe/theme/common/toolbar.css';
import '@milkdown/crepe/theme/common/table.css';
import '@milkdown/crepe/theme/frame.css';

// 所见即所得编辑器(Milkdown Crepe):用户直接在渲染后的文档上修改,
// 保存时由编辑器把排版反推回 Markdown。对外接口与旧版 CodeMirror 入口一致,
// 但 create 返回的是句柄对象而非视图:Crepe 初始化是异步的,句柄先行占位。
function assertHandle(handle) {
  if (!handle || handle.__mdturnCrepe !== true) throw new TypeError('需要有效的 MDTurn 编辑器句柄。');
}

function create(container, options = {}) {
  if (!(container instanceof Element)) throw new TypeError('create 需要一个 DOM Element 容器。');
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  const handle = {
    __mdturnCrepe: true,
    crepe: null,
    doc: String(options.doc ?? ''),
    pendingDoc: null,
    ready: false,
    destroyed: false,
  };
  const crepe = new CrepeBuilder({ root: container, defaultValue: handle.doc })
    .addFeature(cursor)
    .addFeature(listItem)
    .addFeature(linkTooltip)
    .addFeature(imageBlock)
    .addFeature(blockEdit)
    .addFeature(placeholder, { text: '在这里书写正文……', mode: 'block' })
    .addFeature(toolbar)
    .addFeature(codeMirror)
    .addFeature(table);
  crepe.editor.config((ctx) => {
    // 反推 Markdown 时尽量贴近中文文档的常见写法,减少保存后的格式噪音
    ctx.update(remarkStringifyOptionsCtx, (current) => ({
      ...current, bullet: '-', rule: '-', fence: '`', listItemIndent: 'one',
    }));
  });
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown, prevMarkdown) => {
      // ready 之前的事件是初始化期的规范化噪音(如补尾段落),不能算作用户修改
      if (handle.destroyed || !handle.ready || markdown === prevMarkdown) return;
      handle.doc = markdown;
      if (onChange) onChange(markdown);
    });
  });
  handle.crepe = crepe;
  handle.creation = crepe.create().then(() => {
    if (handle.destroyed) return crepe.destroy();
    handle.ready = true;
    if (handle.pendingDoc != null) {
      const value = handle.pendingDoc;
      handle.pendingDoc = null;
      applyValue(handle, value);
    }
    return undefined;
  }).catch((error) => {
    console.error('MDTurn 编辑器初始化失败', error);
  });
  return handle;
}

function applyValue(handle, value) {
  handle.doc = value;
  handle.crepe.editor.action(replaceAll(value, true));
}

function setValue(handle, value) {
  assertHandle(handle);
  const nextValue = String(value ?? '');
  if (nextValue === handle.doc) return;
  if (!handle.ready) { handle.doc = nextValue; handle.pendingDoc = nextValue; return; }
  applyValue(handle, nextValue);
}

function getValue(handle) {
  assertHandle(handle);
  return handle.doc;
}

function destroy(handle) {
  assertHandle(handle);
  handle.destroyed = true;
  if (handle.ready) { try { handle.crepe.destroy(); } catch (_) {} }
}

function focus(handle) {
  assertHandle(handle);
  if (!handle.ready) return;
  handle.crepe.editor.action((ctx) => { ctx.get(editorViewCtx).focus(); });
}

// 把一行 Markdown 源码剥成可检索的纯文本(标题井号、列表符、强调符、链接壳等)
function stripMarkdownLine(line) {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|(?:[-*+]|\d{1,3}[.)])\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();
}

// 按"源文档第 N 行"定位:取该行(或其后首个非空行)的纯文本,在渲染文档里
// 搜到含它的段落块并滚动过去。所见即所得下没有稳定的行号映射,文本检索是
// 最稳的近似——批注和大纲都带原文引文,首行文本几乎总能命中。
function revealLine(handle, lineNumber) {
  assertHandle(handle);
  if (!handle.ready) return;
  const lines = handle.doc.split('\n');
  const bounded = Math.max(1, Math.min(lines.length, Number(lineNumber) || 1));
  let needle = '';
  for (let index = bounded - 1; index < lines.length && !needle; index += 1) {
    needle = stripMarkdownLine(lines[index]);
  }
  handle.crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    let position = null;
    if (needle) {
      view.state.doc.descendants((node, nodePosition) => {
        if (position != null) return false;
        if (node.isTextblock && node.textContent.includes(needle)) { position = nodePosition; return false; }
        return true;
      });
    }
    if (position != null) {
      const dom = view.nodeDOM(position);
      const element = dom instanceof Element ? dom : dom && dom.parentElement;
      if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    view.focus();
  });
}

Object.defineProperty(window, 'MDTurnEditor', {
  value: Object.freeze({ create, setValue, getValue, destroy, focus, revealLine }),
  configurable: false,
  enumerable: true,
  writable: false,
});
