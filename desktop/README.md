# MDTurn desktop shell

This directory contains the shared Electron shell for macOS and Windows. The renderer, review API,
and Markdown service are common to both platforms; only service startup, native menus, window chrome,
notifications, and packaging have platform-specific branches.

## Development

Node.js 20 or newer is required for development only:

```powershell
npm install --cache .npm-cache
npm run build:vendor
npm run dev
```

On both macOS and Windows, the desktop shell starts the bundled `server.js` with Electron's own Node
runtime. It binds only to `127.0.0.1`, chooses a free port, and shares service state with the
`mdreview` CLI below `~/.mdread`. End users do not need a separate Node.js installation.

## Build and test

```powershell
npm test
npm run dist:win
```

`dist:win` creates the unsigned Windows 11 x64 NSIS installer in `desktop/dist`. Windows SmartScreen
will therefore show an unknown-publisher warning for this beta. The installer supports a selectable
installation directory, Start menu and desktop shortcuts, uninstall, and `.md` file association.

macOS build commands remain available as `dist:app`, `dist:dmg`, `dist:zip`, and `dist:beta`.

## Renderer bridge

`preload.js` exposes only `window.mdturnDesktop`: Markdown file picking, reveal-in-file-manager,
safe external HTTP(S) links, review completion notifications, review activation, commands, and
single-instance file-open delivery. Context isolation and the renderer sandbox remain enabled.

## Windows beta boundary

The Windows beta supports the complete local review/edit workflow. Code signing, auto-update,
portable builds, and ARM64 are not part of this target.
