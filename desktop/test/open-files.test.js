'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { markdownPathsFromArguments, normalizeMarkdownPath } = require('../open-files');

test('Markdown arguments support spaces, Chinese names, uppercase extensions and deduplication', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mdturn-open-files-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const markdown = path.join(directory, '审阅 文档.MD');
  const ignored = path.join(directory, 'notes.txt');
  fs.writeFileSync(markdown, '# 文档\n');
  fs.writeFileSync(ignored, 'not markdown\n');

  assert.equal(normalizeMarkdownPath('审阅 文档.MD', directory), fs.realpathSync(markdown));
  assert.deepEqual(
    markdownPathsFromArguments([markdown, ignored, markdown, '--squirrel-firstrun'], directory),
    [fs.realpathSync(markdown)],
  );
});

test('invalid and missing paths fail closed', () => {
  assert.equal(normalizeMarkdownPath('missing.md'), null);
  assert.equal(normalizeMarkdownPath('bad\0.md'), null);
  assert.deepEqual(markdownPathsFromArguments(null), []);
});
