# MDTurn desktop shell

This directory contains the macOS Electron shell. It deliberately does not start its own copy of
the md-read Node service: it discovers a valid `127.0.0.1` `/api/health` endpoint and, only when
needed, runs `launchctl kickstart -k gui/<uid>/com.mdread.serve`.

## Renderer bridge

`preload.js` exposes only `window.mdturnDesktop`:

- `pickMarkdown()` returns existing absolute `.md` paths selected by the user;
- `revealPath(path)` reveals an existing absolute local path in Finder;
- `openExternal(url)` opens only `http` or `https` URLs;
- `notifyReviewComplete(payload)` asks the trusted local renderer to show a macOS completion notification;
- `onActivateReview(callback)` activates the matching review when that notification is clicked;
- `onOpenFiles(callback)` receives Finder `open-file`, second-instance and `Cmd+O` paths.

`npm run build:vendor` creates:

- `static/vendor/mdturn-editor.js`, exposing `window.MDTurnEditor`;
- `static/vendor/phosphor.css` plus its locally copied font/style assets.

## Build targets

All declared package versions are exact pins. After dependencies have been installed, use:

```bash
npm test
npm run build:vendor
npm run dist:app
npm run dist:dmg
npm run dist:zip
npm run dist:beta
```

The beta is Apple Silicon (`arm64`) and ad-hoc signed (`identity: "-"`); it is not notarized.
