# Windows 11 x64 支持

MDTurn 使用同一个仓库和同一套 Electron、Node 服务及 Web UI 构建 macOS 与 Windows 版本。
Windows 支持是平台适配，不是独立 fork 或业务重写。

## 技术实现

- Electron 主进程在 Windows 上使用原生标题栏、平台菜单和 AppUserModelId 通知身份。
- 首次打开文件读取 `process.argv`，应用运行期间通过 `second-instance` 接收新的 `.md` 文件。
- 如果没有可复用的健康服务，Electron 使用自身可执行文件和 `ELECTRON_RUN_AS_NODE=1` 启动
  安装包内的 `resources/mdturn-server/server.js`，用户无需安装 Node.js。
- 内置服务只监听 `127.0.0.1`，使用动态端口，数据位于 Electron `userData/mdread`；应用退出时
  只终止本实例创建的服务。
- `server.js`、`lib/`、`static/` 由 electron-builder `extraResources` 放入安装包，桌面主进程和
  preload 仍封装在 ASAR 中。
- NSIS 安装器只构建 Windows 11 x64，提供可选安装路径、快捷方式、卸载和 `.md` 文件关联。

## 开发、测试和构建

需要 Node.js 20 或更高版本：

```powershell
npm --prefix desktop install --cache desktop/.npm-cache
npm --prefix desktop run build:vendor
npm --prefix desktop test
node --test test/*.test.js
npm --prefix desktop run dist:win
```

安装包输出为 `desktop/dist/MDTurn-<version>-x64.exe`。首个 Beta 不做代码签名，SmartScreen
显示“未知发布者”属于预期行为。

## 验收重点

在没有系统 Node.js 的干净 Windows 11 x64 环境验证安装、卸载、首次启动、中文及空格路径、
双击 `.md`、第二实例文件投递、多标签页、批注/提交/编辑/保存、通知点击激活、DPI 缩放、
深浅色模式和退出后的服务清理。

## 首版边界

Windows Beta 覆盖本地审阅闭环；不包含便携版、ARM64、自动更新、代码签名和发布 CI。
