# Windows 移植指引

MDTurn 桌面壳基于 Electron，代码本身绝大部分是跨平台的。做 Windows 版**不需要重写**，
工作量集中在下面几处 macOS 特有逻辑的替换和打包配置。按顺序做即可。

## 0. 先把开发环境跑起来（Windows 上就能跑）

```powershell
# 需要 Node.js ≥ 20
npm --prefix desktop install --cache desktop/.npm-cache
npm --prefix desktop run build:vendor
node server.js          # 先手工起本地审阅服务（见第 1 条）
npm --prefix desktop run dev
```

后端 `server.js` 只用 Node 内置模块，Windows 上可以直接运行。跑通这一步你就有一个
能用的开发版了，剩下的是体验与打包问题。

## 1. 服务启动方式（最主要的一处，`desktop/service.js`）

macOS 上桌面壳自己不启动 Node 服务，而是探测 `127.0.0.1` 的 `/api/health`，
探测不到时调用 `launchctl kickstart -k gui/<uid>/com.mdread.serve` 唤醒 launchd
常驻服务（见 `kickstartService()`，函数内已显式抛错拒绝非 darwin 平台）。

Windows 没有 launchd，建议的移植方案（二选一）：

- **方案一（推荐，改动小）**：探测失败时由桌面壳直接 `spawn('node', ['server.js'])`
  托管一个子进程，随 App 退出而结束。把这个分支按 `process.platform === 'win32'`
  写进 `ensureService()` 的 kickstart 位置即可，探测与就绪轮询逻辑全部复用。
  注意打包后没有系统 node 时，可用 Electron 自带的
  `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 来运行 `service.js`/`server.js`。
- **方案二**：注册 Windows 计划任务或服务（如 `sc create` / NSSM）常驻运行
  `node server.js`，桌面壳只探测不启动，行为与 macOS 一致。首版不必做。

## 2. 文件关联与"打开方式"（`desktop/main.js`）

- `app.on('open-file')` 是 macOS 专有事件。Windows 上双击 `.md` 文件时路径通过
  **命令行参数**传入：首次启动读 `process.argv`，已在运行时走 `second-instance`
  事件的 `argv`。`second-instance` 处理已存在，需要把 argv 里的 `.md` 路径解析
  合并进现有的 `OPEN_FILES_CHANNEL` 分发即可。
- `window-all-closed` 已按 `process.platform !== 'darwin'` 处理退出，无需改。

## 3. 系统通知

Electron 的 `Notification` 在 Windows 上可用，但需要在 `app.whenReady()` 前调用
`app.setAppUserModelId('org.mdturn.desktop')`（与 electron-builder 的 appId 一致），
否则通知不显示。点击通知激活对应标签的逻辑可复用。

## 4. 打包配置（`desktop/package.json` 的 `build` 段）

- 现有 `mac` 段保持不动；`afterPack`（`scripts/after-pack.mjs`）已经带
  `electronPlatformName !== 'darwin'` 守卫，Windows 构建会自动跳过。
- 新增 `win` 段与脚本，例如：

```jsonc
"win": { "target": "nsis", "icon": "build/icon.ico" },
"nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
```

```jsonc
"dist:win": "npm run build:vendor && electron-builder --win nsis --x64"
```

- 需要一枚 `build/icon.ico`（可由现有 `build/icon.icns` 的源图导出）。
- `fileAssociations` 段 electron-builder 在 Windows 上同样生效，不用改。
- 首版不做代码签名即可（安装时 SmartScreen 会提示"未知发布者"，属预期）。

## 5. CLI 与脚本

- `mdreview` 是 bash 包装器；Windows 上直接用 `node mdreview.js <命令>`，
  或补一个 `mdreview.cmd`（两行：`@echo off` + `node "%~dp0mdreview.js" %*`）。
- `serve.command` / `serve-daemon.sh`（手机远程审阅的 Cloudflare Tunnel 常驻服务）
  是 macOS/bash + launchd 专用。**首版 Windows 可以不移植**——本地审阅闭环
  （MDTurn + `mdreview`）不依赖它们；需要手机远程时再用 `cloudflared.exe`
  写一个等价的 PowerShell 脚本。

## 6. 已知的平台差异注意点

- `.mdread/` 数据目录在 macOS 上用 `0700/0600` 权限收紧；`fs.chmod` 在 Windows
  上基本是空操作，属已知差异，不影响功能（该目录本来就在用户自己的资料区）。
- 路径处理全部走 `path` 模块，代码里没有硬编码 `/` 分隔符的已知问题；移植时
  如遇路径比较失败，优先检查大小写与盘符规范化（`fs.realpathSync` 的返回值）。
- 验证清单:`node --test test/*.test.js`、`npm --prefix desktop test` 应全绿;
  `test/desktop-production-smoke.js` 里如有依赖 macOS 的步骤,按平台跳过并在 PR 里说明。

## 提交方式

请直接向主仓库提 PR（不要另起独立的 Windows fork），按上面条目拆小提交最好。
有疑问开 Issue 讨论。
