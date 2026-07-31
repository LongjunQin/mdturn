'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
const commandListeners = new Set();
const activateReviewListeners = new Set();
let queuedOpenFiles = [];

function deliverOpenFiles(paths) {
  if (!Array.isArray(paths)) return;
  const markdownPaths = paths.filter((item) => typeof item === 'string');
  if (markdownPaths.length === 0) return;
  if (listeners.size === 0) {
    queuedOpenFiles = [...new Set([...queuedOpenFiles, ...markdownPaths])];
    return;
  }
  for (const listener of listeners) listener(markdownPaths.slice());
}

ipcRenderer.on('mdturn:open-files', (_event, paths) => deliverOpenFiles(paths));
ipcRenderer.on('mdturn:command', (_event, command) => {
  if (typeof command !== 'string') return;
  for (const listener of commandListeners) listener(command);
});
ipcRenderer.on('mdturn:activate-review', (_event, reviewId) => {
  if (typeof reviewId !== 'string') return;
  for (const listener of activateReviewListeners) listener(reviewId);
});

contextBridge.exposeInMainWorld('mdturnDesktop', Object.freeze({
  platform: process.platform,
  pickMarkdown: () => ipcRenderer.invoke('mdturn:pick-markdown'),
  revealPath: (targetPath) => ipcRenderer.invoke('mdturn:reveal-path', targetPath),
  openExternal: (url) => ipcRenderer.invoke('mdturn:open-external', url),
  notifyReviewComplete: (payload) => ipcRenderer.invoke('mdturn:notify-review-complete', payload),
  onOpenFiles(callback) {
    if (typeof callback !== 'function') throw new TypeError('onOpenFiles 需要函数参数。');
    listeners.add(callback);
    if (queuedOpenFiles.length > 0) {
      const pending = queuedOpenFiles.slice();
      queuedOpenFiles = [];
      queueMicrotask(() => {
        if (listeners.has(callback)) callback(pending);
      });
    }
    return () => listeners.delete(callback);
  },
  onCommand(callback) {
    if (typeof callback !== 'function') throw new TypeError('onCommand 需要函数参数。');
    commandListeners.add(callback);
    return () => commandListeners.delete(callback);
  },
  onActivateReview(callback) {
    if (typeof callback !== 'function') throw new TypeError('onActivateReview 需要函数参数。');
    activateReviewListeners.add(callback);
    return () => activateReviewListeners.delete(callback);
  },
}));
