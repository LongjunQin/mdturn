# AGENTS.md —— md-read 工具的 Agent 操作说明

本目录是 **md-read**：MDTurn 桌面 App 的本地冻结审阅服务与 CLI。批注保存在原文件旁的
sidecar（`<文件>.md.annotations.json`）；阅读服务本身不修改源 `.md`。

工具路径(下文用 `$TOOL` 代指):本仓库在本机的克隆目录。

---

## 任务一：在电脑上用 MDTurn 审阅

当用户说“打开 / 审阅 / 发我批注”时：

```bash
mdreview open "<文档绝对路径.md>"
```

- `mdreview open` 会创建或复用审阅会话并冻结该文档，然后把 Markdown 打开到 MDTurn 的同一窗口多文档标签页；其他文档不受影响。
- 未安装 MDTurn 时命令会报错并给出安装指引（会话仍已创建，安装后重跑即可）；`--no-open` 只创建会话、不唤起 App。
- 阅读与批注处于同一个冻结模式；只有提交审阅后才能进入独立编辑模式。
- `open` 之后立即以后台任务挂起 `mdreview wait`，等用户点击「完成本轮审阅」自动唤醒。

### Agent 修改冻结文档的纪律

修改带审阅会话的文档前，先运行：

```bash
mdreview status "<文档绝对路径.md>" --json
```

- `reviewing` 或 `conflict`：禁止修改源文档。
- `ready_to_apply` 且用户要求按批注改稿：先运行 `mdreview begin-apply`，再只处理 `status=open` 的批注。
- 改完并更新 sidecar 后运行 `mdreview complete`；仍有 open 时该命令会拒绝完成。
- `mdreview complete` 会在终态原子落盘后主动通知 MDTurn 刷新对应标签；不要要求用户手工刷新，也不要为此频繁重复调用状态查询。
- `applying` 表示上一轮改稿可能中断，应继续核对剩余 open，而不是重新开始审阅。
- 异常放弃审阅只能运行 `mdreview unlock <文件> --reason <原因>`，不得直接删 `reviews.json`。
- 没有审阅会话的旧文档按下文原协议处理。

---

## 任务二：根据用户批注修改文档（关键：别重复做已完成的）

当用户说"按批注改一下这篇 / 根据批注修改"时,**严格按下面协议**:

1. 先运行 `mdreview status <文档> --json`；若存在活动会话，严格遵守上面的冻结状态机。
2. 读取该文档的 sidecar:`<文档.md>.annotations.json`(**与原文件同名同目录**;JSON 顶层 `sourceFile`=原文件绝对路径、`_apply`=自述说明——据此确认要改的就是 `sourceFile` 那个文件)。
3. **只处理 `status` 为 `open` 的批注。完全忽略 `applied` 和 `wontfix`。**
4. 定位:**以 `quote`(原文引用)+ `headingPath`(章节)为主**来找到位置;`lineStart` 只作辅助
   (因为之前的修改可能已让行号偏移)。`figureRef` 表示该批注针对某图/表。
5. 按 `comment` 修改源 `.md`。
6. 每改完一条,就**就地把那条批注更新为**:
   ```json
   "status": "applied",
   "appliedAt": "<当前ISO时间>",
   "appliedBy": "codex" 或 "claude",
   "appliedNote": "<一句话:你具体改了什么>"
   ```
   写回 sidecar 文件(保留其它批注与字段不动)。
7. 决定不改的,可标 `"status": "wontfix"` 并加一句 `appliedNote` 说明原因。
8. **绝不改动或重做任何 `status:applied` 的批注**——那是上一轮已完成的。
9. 活动会话处于 `applying` 时，全部 open 清零后运行 `mdreview complete <文档>`。

完成后向用户汇报:本轮处理了几条 `open`、跳过了几条已完成、分别改了什么。

---

## sidecar 数据结构(参考)

```json
{
  "version": 1,
  "file": "册2_装置解剖.md",
  "annotations": [
    {
      "id": "n…",
      "author": "我(本机)",
      "createdAt": "2026-…Z",
      "comment": "这张图的轴标注反了",
      "quote": "图3 失超传播…",       // 主锚点:原文引用
      "prefix": "…", "suffix": "…",
      "headingPath": ["3 失超保护"],  // 主锚点:所在章节
      "lineStart": 120, "lineEnd": 121,// 辅助:源行号(可能因改稿偏移)
      "figureRef": "图3",
      "status": "open"               // open=待处理 / applied=已改 / wontfix=不改
    }
  ]
}
```

> 不要把批注 sidecar 当正文;不要删用户的批注;状态流转只走 open→applied / open→wontfix。
