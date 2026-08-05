'use strict';

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification: ElectronNotification,
  shell,
} = require('electron');
const { ensureService } = require('./service');

const PROJECT_DIR = path.resolve(__dirname, '..');
const OPEN_FILES_CHANNEL = 'mdturn:open-files';
const COMMAND_CHANNEL = 'mdturn:command';
const ACTIVATE_REVIEW_CHANNEL = 'mdturn:activate-review';

let mainWindow = null;
let serviceOrigin = null;
let rendererReady = false;
let pendingOpenFiles = [];
let connecting = null;

app.setName('MDTurn');

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
  return [...new Set((args || [])
    .map((candidate) => normalizeMarkdownPath(candidate, workingDirectory))
    .filter(Boolean))];
}

function queueOpenFiles(paths) {
  const validPaths = paths
    .map((candidate) => normalizeMarkdownPath(candidate))
    .filter(Boolean);
  pendingOpenFiles = [...new Set([...pendingOpenFiles, ...validPaths])];
  flushOpenFiles();
}

function flushOpenFiles() {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady || pendingOpenFiles.length === 0) return;
  const paths = pendingOpenFiles.slice();
  pendingOpenFiles = [];
  mainWindow.webContents.send(OPEN_FILES_CHANNEL, paths);
}

function sendRendererCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) return false;
  mainWindow.webContents.send(COMMAND_CHANNEL, command);
  return true;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isSafeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isTrustedRenderer(event) {
  if (!serviceOrigin || !event.senderFrame) return false;
  try {
    return new URL(event.senderFrame.url).origin === serviceOrigin;
  } catch {
    return false;
  }
}

async function pickMarkdownFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开 Markdown 文档',
    buttonLabel: '打开',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: ['md'] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths
    .map((filePath) => normalizeMarkdownPath(filePath))
    .filter(Boolean);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function showServiceError(error) {
  rendererReady = false;
  serviceOrigin = null;
  const message = escapeHtml(error && error.message ? error.message : '本地审阅服务不可用。');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>MDTurn · 服务未就绪</title><style>
    :root{color-scheme:light dark}body{margin:0;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    background:#f5f5f7;color:#1d1d1f;display:grid;min-height:100vh;place-items:center}.card{width:min(560px,calc(100vw - 64px));
    padding:36px;border:1px solid #d2d2d7;border-radius:18px;background:#fff;box-shadow:0 18px 70px #0001}h1{font-size:24px;margin:0 0 12px}
    p{line-height:1.7;margin:8px 0;color:#515154}.detail{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;
    padding:12px;border-radius:9px;background:#f5f5f7;overflow-wrap:anywhere}.hint{margin-top:18px;color:#6e6e73}
    @media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}.card{background:#2c2c2e;border-color:#48484a}.detail{background:#1c1c1e}p,.hint{color:#aeaeb2}}
    </style></head><body><main class="card"><h1>本地服务没有就绪</h1><p>MDTurn 没有另起第二个服务，已尝试唤醒现有的 <strong>com.mdread.serve</strong>。</p>
    <p class="detail">${message}</p><p class="hint">修复服务后，从“窗口”菜单选择“重新连接本地服务”。</p></main></body></html>`;
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function connectAndLoad() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      const service = await ensureService({
        projectDir: PROJECT_DIR,
        userDataDir: app.getPath('userData'),
      });
      serviceOrigin = `http://127.0.0.1:${service.port}`;
      rendererReady = false;
      await mainWindow.loadURL(`${serviceOrigin}/desktop`);
    } catch (error) {
      await showServiceError(error);
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

function installNavigationGuards(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (serviceOrigin && targetUrl.startsWith(`${serviceOrigin}/`)) return;
    event.preventDefault();
    if (isSafeExternalUrl(targetUrl)) void shell.openExternal(targetUrl);
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    title: 'MDTurn',
    width: 1440,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#f5f5f7',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  installNavigationGuards(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.webContents.on('did-start-loading', () => { rendererReady = false; });
  mainWindow.webContents.on('did-finish-load', () => {
    if (!serviceOrigin) return;
    rendererReady = true;
    flushOpenFiles();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
    serviceOrigin = null;
  });
  void connectAndLoad();
  return mainWindow;
}

function installIpc() {
  ipcMain.handle('mdturn:pick-markdown', async (event) => {
    if (!isTrustedRenderer(event)) throw new Error('拒绝非 MDTurn 页面调用文件选择器。');
    return pickMarkdownFiles();
  });
  ipcMain.handle('mdturn:reveal-path', async (event, targetPath) => {
    if (!isTrustedRenderer(event) || typeof targetPath !== 'string' || targetPath.includes('\0') || !path.isAbsolute(targetPath)) {
      throw new Error('无效的本地路径。');
    }
    let realPath;
    try { realPath = fs.realpathSync(targetPath); } catch { throw new Error('路径不存在。'); }
    shell.showItemInFolder(realPath);
    return true;
  });
  ipcMain.handle('mdturn:open-external', async (event, url) => {
    if (!isTrustedRenderer(event) || !isSafeExternalUrl(url)) throw new Error('只允许打开 http/https 外部链接。');
    await shell.openExternal(url);
    return true;
  });
  ipcMain.handle('mdturn:notify-review-complete', async (event, payload) => {
    if (!isTrustedRenderer(event) || !payload || typeof payload !== 'object') {
      throw new Error('拒绝无效的通知请求。');
    }
    const reviewId = typeof payload.reviewId === 'string' ? payload.reviewId.slice(0, 200) : '';
    const title = typeof payload.title === 'string' ? payload.title.slice(0, 180) : '';
    if (!reviewId || !title || !ElectronNotification.isSupported()) return false;
    const notification = new ElectronNotification({
      title: 'MDTurn · 修改已完成',
      body: `《${title}》已更新到最新版本。`,
      silent: false,
    });
    notification.on('click', () => {
      focusMainWindow();
      if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
        mainWindow.webContents.send(ACTIVATE_REVIEW_CHANNEL, reviewId);
      }
    });
    notification.show();
    return true;
  });
}

function installMenu() {
  const template = [
    {
      label: 'MDTurn',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: '文件',
      submenu: [
        {
          label: '打开 Markdown…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (sendRendererCommand('open')) return;
            const paths = await pickMarkdownFiles();
            queueOpenFiles(paths);
          },
        },
        {
          label: '关闭当前标签页',
          accelerator: 'CmdOrCtrl+W',
          click: () => { sendRendererCommand('close-tab'); },
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          click: () => { sendRendererCommand('save'); },
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '放大正文', accelerator: 'CmdOrCtrl+=', click: () => { sendRendererCommand('zoom-in'); } },
        { label: '缩小正文', accelerator: 'CmdOrCtrl+-', click: () => { sendRendererCommand('zoom-out'); } },
        { label: '重置正文缩放', accelerator: 'CmdOrCtrl+0', click: () => { sendRendererCommand('zoom-reset'); } },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        {
          label: '重新连接本地服务',
          click: () => { void connectAndLoad(); },
        },
        { type: 'separator' },
        { role: 'minimize' }, { role: 'zoom' }, { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  const markdownPath = normalizeMarkdownPath(filePath);
  if (markdownPath) queueOpenFiles([markdownPath]);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  pendingOpenFiles = markdownPathsFromArguments(process.argv.slice(1), process.cwd());
  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    queueOpenFiles(markdownPathsFromArguments(commandLine.slice(1), workingDirectory));
    focusMainWindow();
  });
  app.whenReady().then(() => {
    installIpc();
    installMenu();
    createWindow();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusMainWindow();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
