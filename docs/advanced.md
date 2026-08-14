# MDTurn 进阶手册

面向 Agent 编排者、高级用户与贡献者。日常使用看 [README](../README.md) 就够了。

## 架构与入口

`md-read` 是 MDTurn 复用的本地审阅服务与 CLI。两条入口共用同一个
`<文档.md>.annotations.json`：

```text
电脑本地：Codex 生成 MD → mdreview open → MDTurn（未安装时回退浏览器）→ 冻结审阅 → Codex 应用批注
手机远程：Codex 生成 MD → mdshare → Cloudflare 链接 → 手机批注 → Codex 应用批注
```

Codex 调用约定：明确说“电脑打开 / 本地审阅”时使用 `mdreview open`；明确说“发我手机 /
给别人看 / 生成分享链接”时使用 `mdshare`；只说“发我看 / 我要批注”而没有说明终端时，
必须先确认电脑本地还是手机远程。

## 电脑本地审阅

```bash
mdreview open "/绝对路径/方案.md"
```

`mdreview open` 会创建或复用该文件的审阅会话、记录 SHA-256 版本指纹，并优先把文档打开到已安装的 MDTurn。未安装 MDTurn 时会自动回退到原有本机浏览器审阅页；两种方式都不经过公网，其他项目可以继续工作。`--no-open` 仍只创建或复用会话，不打开 App 或浏览器。

MDTurn 内部仍使用 loopback HTTP 与现有服务通信；`/desktop`、审阅接口和本地文件接口都会
拒绝 Cloudflare 请求头，不能通过公网 Tunnel 进入。

页面始终在正文上方显示当前状态：

```text
审阅中 · 原文已锁定        可阅读和批注，不能改原文
等待修改 · 批注已提交      已停止批注，等待 Agent 或手工处理
Agent 修改中 · 文档暂时只读  Agent 正在改稿，完成后自动刷新
手工修改中 · 请逐条处理批注  你正在编辑，需将未处理批注清零
修改已完成 · 已加载最新版    本轮结束，可开始下一轮
版本冲突 · 已停止写入        源文件在冻结期间变化，需先处理冲突
```

底层审阅状态仍为 `reviewing → ready_to_apply → applying → complete`；
`applying` 会根据 `applyMode` 在界面上分成“Agent 修改中”和“手工修改中”。
`conflict` 是版本冲突停写，`cancelled` 是人工取消本轮。

源文档在 `reviewing` 期间发生变化时，会话立即进入 `conflict`，旧版本批注不再写入。关闭浏览器不会自动解锁。

冲突会话可以自愈：再次 `mdreview open` 时，若旧一轮批注已全部处理（没有 `open`），
会自动结束冲突会话并按当前内容开启新一轮——典型场景是 Agent 改完了稿但漏跑
`begin-apply`/`complete`。仍有未处理批注时维持冲突保护，需人工 `mdreview unlock` 决断。

审阅中的未处理批注可以在批注列表里继续“编辑”或“删除”；点击“完成本轮审阅”后页面只读。
跨段选择会记录完整起止行，并高亮覆盖的全部段落；旧版本已经保存成错误单行范围的长批注，
页面也会根据引用正文做兼容显示，但不会偷偷改写历史 sidecar。

Agent 执行 `mdreview complete` 后会主动通知正在运行的 MDTurn，不需要高频轮询。
前端仅保留 60 秒一次的轻量状态核对，用于 App 断网、睡眠或错过事件后的容错；
它不会定时重载整篇正文。未保存草稿存在时，远程更新会被挂起而不是覆盖草稿。

常用恢复/Agent 命令：

```bash
mdreview status "/绝对路径/方案.md" --json
mdreview wait "/绝对路径/方案.md" --timeout-minutes 480
mdreview begin-apply "/绝对路径/方案.md"
mdreview complete "/绝对路径/方案.md"
mdreview unlock "/绝对路径/方案.md" --reason "放弃本轮审阅"
```

## 按批注改稿（Agent 协议）

`mdreview` 每一步命令的输出末尾都会以 `→` 给出 Agent 下一步该做什么（open 提示挂
wait、wait 退出提示读批注并 begin-apply、begin-apply 提示标 applied/wontfix 后
complete）。从未读过本文档的 Agent 只要从 `mdreview open` 进入并照每步输出走，
即可完整走完 打开 → 等待 → 改稿 → 完成 全流程；下文是完整协议说明。

本地冻结审阅必须先由用户点击“完成本轮审阅”。推荐 Agent 在 `mdreview open` 之后立即
后台运行 `mdreview wait`：命令会一直阻塞到用户点击“完成本轮审阅”才退出（退出码
0=批注已提交或全文通过；2=冲突/取消/会话丢失；3=超时，默认 480 分钟，可
`--timeout-minutes` 调整）。命令退出即等于用户通报“批注完了”，用户不需要回到对话里
再说一遍。Agent 随后：

1. 运行 `mdreview status`，确认状态（用了 wait 且退出码为 0 可跳过）；
2. 读取 sidecar 中 `status=open` 的批注，对有歧义的先向用户提问确认；
3. `ready_to_apply` 时运行 `mdreview begin-apply`；
4. 逐条改稿，以 `quote + headingPath` 定位，标记 `applied/wontfix`，保留审计字段；
5. 全部 open 清零后运行 `mdreview complete`。

没有审阅会话的旧 sidecar 继续遵守原有 `open → applied/wontfix` 协议。

## 手机远程审阅

```bash
mdshare "/绝对路径/方案.md"
mdshare "/绝对路径/方案.md" --for 小王 --days 3
```

命令最后一行是可直接发送的链接。每条记录有独立 ID/token，可设置有效期；批注仍写回源文件旁的 sidecar。

远程入口目前使用 Cloudflare Quick Tunnel。Tunnel 重连会更换域名，因此完整旧链接可能失效；页面会提示重新生成链接。固定公网域名不属于本版本。

## 常驻服务

本机通过 launchd 的 `com.mdread.serve` 自动运行 `serve-daemon.sh`，启动 Node 服务并维护 Cloudflare Tunnel。`serve.command` 是手工备用启动器。

服务默认只监听 `127.0.0.1`，不提供本地目录浏览；Cloudflare 只能访问带有效 `d/k` 的分享文档。实际端口写入 `.mdread/port`，CLI 不再写死 8080。

## 数据与可靠性

- `.mdread/registry.json`：远程分享记录。
- `.mdread/reviews.json`：本地审阅会话与冻结状态。
- `.mdread/port`：当前本地服务端口。
- `<文档.md>.annotations.json`：批注正文，兼容旧格式。
- 批注修改会保留原创建记录，并追加 `updatedAt / updatedBy / editCount` 审计字段。
- JSON 写入采用跨进程锁、锁内重读、临时文件和原子替换；已有 JSON 损坏时停止写入，不会按空数据覆盖。
- `.mdread` 权限为 `0700`，其中凭证和索引文件为 `0600`。
- 未保存的 MDTurn 编辑草稿按 `reviewSessionId + sourceHash` 保存在 App 本地存储中；刷新或异常重开时只恢复匹配版本的草稿。

## 开发、验证与打包

后端只使用 Node 内置模块。桌面壳依赖全部固定版本并记录在 `desktop/package-lock.json`：

```bash
npm --prefix desktop install --cache desktop/.npm-cache
npm --prefix desktop run build:vendor
```

完整测试：

```bash
node --test test/*.test.js
node test/desktop-production-smoke.js
MDTURN_SMOKE_WIDTH=980 node test/desktop-production-smoke.js
npm --prefix desktop test
node --check server.js
node --check mdshare.js
node --check mdreview.js
```

生成 macOS arm64 App：

```bash
npm --prefix desktop run dist:app
```

当前构建使用 ad-hoc 签名，适合本机安装和早期开源试用；正式公开下载前还需要 Apple Developer ID
签名与 notarization。

生成 Windows 11 x64 安装包（需在 Windows 上构建）：

```powershell
npm --prefix desktop run dist:win
```

产物为 `desktop/dist/MDTurn-<版本>-x64.exe`（NSIS 安装器，支持自选目录、快捷方式、
卸载和 `.md` 文件关联）。Windows Beta 未做代码签名，安装时 SmartScreen 显示“未知发布者”
属预期。Windows 版覆盖完整的本地审阅闭环，暂不含手机分享、自动更新与 ARM64，
边界详见 [windows-porting.md](windows-porting.md)。
