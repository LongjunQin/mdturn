import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';

const programmaticUpdates = new WeakSet();

function assertView(view) {
  if (!(view instanceof EditorView)) throw new TypeError('需要有效的 CodeMirror EditorView。');
}

function create(container, options = {}) {
  if (!(container instanceof Element)) throw new TypeError('create 需要一个 DOM Element 容器。');
  const onChange = typeof options.onChange === 'function' ? options.onChange : null;
  return new EditorView({
    parent: container,
    doc: String(options.doc ?? ''),
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && onChange && !programmaticUpdates.has(update.view)) {
          onChange(update.state.doc.toString(), update);
        }
      }),
    ],
  });
}

function setValue(view, value) {
  assertView(view);
  const nextValue = String(value ?? '');
  const currentValue = view.state.doc.toString();
  if (nextValue === currentValue) return;
  programmaticUpdates.add(view);
  try {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: nextValue } });
  } finally {
    programmaticUpdates.delete(view);
  }
}

function getValue(view) {
  assertView(view);
  return view.state.doc.toString();
}

function destroy(view) {
  assertView(view);
  view.destroy();
}

function focus(view) {
  assertView(view);
  view.focus();
}

function revealLine(view, lineNumber) {
  assertView(view);
  const bounded = Math.max(1, Math.min(view.state.doc.lines, Number(lineNumber) || 1));
  const line = view.state.doc.line(bounded);
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
  });
  view.focus();
}

Object.defineProperty(window, 'MDTurnEditor', {
  value: Object.freeze({ create, setValue, getValue, destroy, focus, revealLine }),
  configurable: false,
  enumerable: true,
  writable: false,
});
