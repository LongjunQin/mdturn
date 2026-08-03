'use strict';

const fs = require('fs');
const path = require('path');

function normalizeMarkdownPath(candidate, workingDirectory = process.cwd()) {
  if (typeof candidate !== 'string' || candidate.includes('\0')) return null;
  const absolutePath = path.resolve(workingDirectory, candidate);
  if (path.extname(absolutePath).toLowerCase() !== '.md') return null;
  try {
    const realPath = fs.realpathSync(absolutePath);
    return fs.statSync(realPath).isFile() ? realPath : null;
  } catch {
    return null;
  }
}

function markdownPathsFromArguments(args, workingDirectory) {
  const seen = new Set();
  return (args || [])
    .map((candidate) => normalizeMarkdownPath(candidate, workingDirectory))
    .filter((candidate) => {
      if (!candidate) return false;
      const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

module.exports = { markdownPathsFromArguments, normalizeMarkdownPath };
