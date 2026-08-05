# MDTurn · Local Markdown Reading, Annotation & Editing

[中文文档](README.md) · [Contributing](CONTRIBUTING.md) · [Windows porting guide](docs/windows-porting.md)

MDTurn is an open-source Markdown workbench built for human + AI-agent collaboration:
reading and annotating happen in a **frozen review mode** (the source file is locked and
fingerprinted with SHA-256), editing happens in a separate mode, and both humans and AI
agents close the loop through the same annotation state machine stored in a sidecar file
(`<doc>.md.annotations.json`) — the source `.md` is never touched by the reviewer.

![MDTurn desktop](docs/images/mdturn-desktop.png)

## Highlights

- Multi-tab desktop app (Electron) with outline sidebar and annotation rail,
  for macOS and Windows 11 x64 (Beta);
- Reader zoom: trackpad pinch gesture or Cmd/Ctrl + `=` / `-` / `0`, persisted
  across restarts;
- Real mouse selections across headings, paragraphs, lists, tables and code blocks;
- Frozen review sessions with version-conflict interception and SHA-256 verification;
- A CodeMirror editor mode with live preview, draft recovery and per-annotation triage;
- Agent workflow: `mdreview status / begin-apply / complete` CLI drives the
  `reviewing → ready_to_apply → applying → complete` state machine; the app refreshes
  itself when the agent finishes — no polling;
- Math (KaTeX), Mermaid diagrams, syntax highlighting, local images;
- Optional phone review channel: `mdshare` publishes a single document through a
  Cloudflare Quick Tunnel with per-link ID + token and optional expiry.

## Architecture

```text
server.js (Node, stdlib only)  ← loopback HTTP →  desktop/ (Electron shell)
        ↑                                              ↑
   mdreview / mdshare CLI                    static/ web UI (browser fallback)
```

The local service listens on `127.0.0.1` only. Review APIs and local-file APIs reject
requests carrying Cloudflare headers, so the public tunnel can only reach explicitly
shared documents.

## Quick start (macOS)

```bash
npm --prefix desktop install --cache desktop/.npm-cache
npm --prefix desktop run build:vendor
npm --prefix desktop run dist:app     # build the arm64 .app
mdreview open "/absolute/path/doc.md" # open a doc for frozen review
```

## Windows

Windows 11 x64 is supported as a Beta, contributed by
[@ArnaudJiang](https://github.com/ArnaudJiang)
([PR #1](https://github.com/LongjunQin/mdturn/pull/1)). Build the installer on
Windows:

```powershell
npm --prefix desktop run dist:win   # → desktop/dist/MDTurn-<version>-x64.exe
```

No pre-built installers are published yet — build from source. The Beta is
unsigned (SmartScreen shows an unknown-publisher warning) and covers the full
local review workflow; phone sharing, auto-update and ARM64 are out of scope.
Details: [docs/windows-porting.md](docs/windows-porting.md).

## Linux

The desktop shell is Electron, so a Linux build is a porting task, not a
rewrite — similar in scope to the Windows port. PRs welcome.

## License

[MIT](LICENSE). Bundled UI/rendering libraries: Phosphor Icons (MIT), CodeMirror (MIT),
markdown-it (MIT), KaTeX (MIT), Mermaid (MIT), highlight.js (BSD-3-Clause),
markdown-it-texmath (MIT).
