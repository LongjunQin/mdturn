# MDTurn · AI 写文档，你来批，AI 再改好

[⬇️ 下载](https://github.com/LongjunQin/mdturn/releases/latest) ·
[English](README.en.md) ·
[进阶手册](docs/advanced.md) ·
[贡献指南](CONTRIBUTING.md)

AI 一分钟能写出几千字的文档，但定稿前总得有人把关。**MDTurn 让你像老师批改作文
一样，在 AI 写的 Markdown 文档上划词批注**；批注完点一下"完成"，AI 就按你的批注
逐条改好，改完自动刷新给你看新版。批注期间原文自动锁定——怎么批都不怕改乱。

![MDTurn 桌面界面](docs/images/mdturn-desktop.png)

## MDTurn 是什么

![MDTurn 是什么](docs/images/what-is-mdturn.svg)

人与 AI 协作写文档时，**人负责判断，MDTurn 负责让判断精确落地**。你不用在聊天窗口
里费劲描述"第三段第二句帮我改一下"——直接在原文上划出那句话、写下意见，AI 收到的
就是精确到字的修改指令。

## 为什么 AI 时代少不了它

![为什么需要 MDTurn](docs/images/why-mdturn.svg)

- **批注精确到字**：真实鼠标选区，标题、表格、代码块、跨段落都能精确高亮，AI 不会找错位置；
- **原文冻结，改不乱**：批注期间文档锁定并做指纹校验，批注单独存放，永远不碰你的原文；
- **闭环有记录**：每条批注都有"已处理 / 不处理"的去向，一轮批完再来一轮，意见不会石沉大海。

## 上手四步

![四步上手](docs/images/how-to-use.svg)

1. **下载安装**：到 [Releases 页面](https://github.com/LongjunQin/mdturn/releases/latest)
   下载 macOS 版 dmg。首次打开请在"访达"中**右键 → 打开**（Beta 版尚未做 Apple 公证）。
   Windows 11 x64 Beta（由 [@ArnaudJiang](https://github.com/ArnaudJiang) 贡献）安装包
   即将挂出，也可先[从源码构建](docs/advanced.md#开发验证与打包)。
2. **打开文档**：双击 `.md` 文件，或在 MDTurn 里 `Cmd+O`；配合 AI 使用时，
   让 Agent 执行 `mdreview open "/路径/文档.md"` 直接送到你面前。
3. **阅读与批注**：划词就能写批注；触摸板双指捏合（或 `Cmd` + `=` / `-` / `0`）缩放正文；
   批完点右上角**完成本轮审阅**。
4. **AI 改稿**：告诉你的 Agent（Codex、Claude Code 等）"按批注改稿"，它会读取批注
   逐条修改；改完 MDTurn 自动刷新，你审下一轮，或者定稿收工。

## 主要功能

- 同一窗口多文档标签页，左栏大纲导航，右栏批注列表，均可收合；
- 正文缩放：双指捏合或 `Cmd/Ctrl` + `=` / `-` / `0`，比例重启后保留；
- 批注可新增、修改、删除、拖动；未处理批注置顶，历史批注默认折叠隐藏；
- 冻结审阅、版本冲突拦截和 SHA-256 校验，批注全程不碰原文；
- 独立编辑模式（CodeMirror）：实时预览、草稿恢复、逐条处理批注；
- 公式（KaTeX）、Mermaid 图、代码高亮、表格与本地图片完整渲染；
- Agent 改稿完成自动刷新对应标签，App 在后台时发系统通知；
- 附赠 `mdshare` 手机远程批注通道（Cloudflare 链接，发给手机或他人）。

## 配合 AI Agent 使用

MDTurn 为"人批注 + AI 改稿"闭环而生：Agent 用 `mdreview` 命令打开审阅、读取批注、
标记处理结果，全程有状态机与版本指纹保护。完整的命令与协议约定见
[进阶手册](docs/advanced.md)。

## 参与贡献

欢迎 Issue 与 PR，流程与代码约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
Windows 11 x64 支持由 [@ArnaudJiang](https://github.com/ArnaudJiang) 贡献
（[PR #1](https://github.com/LongjunQin/mdturn/pull/1)），在此致谢。
当前最想要的贡献是 **Linux 版**（同一套 Electron 壳，工作量与 Windows 移植类似），
以及 Windows 侧的代码签名、自动更新与干净环境验证。

## 开源许可

MDTurn 使用 [MIT License](LICENSE)。界面图标来自
[Phosphor Icons](https://phosphoricons.com/)（MIT）；编辑器使用
[CodeMirror](https://codemirror.net/)（MIT）；渲染依赖
[markdown-it](https://github.com/markdown-it/markdown-it)（MIT）、
[KaTeX](https://katex.org/)（MIT）、[Mermaid](https://mermaid.js.org/)（MIT）、
[highlight.js](https://highlightjs.org/)（BSD-3-Clause）、
[markdown-it-texmath](https://github.com/goessner/markdown-it-texmath)（MIT）。以上第三方库的许可证文本
随各自发行版分发，向仓库引入新依赖时请保持许可证兼容（MIT/BSD/Apache 类）。
