# KotoShelf

A markdown-focused workspace editor with wiki links, live preview, and image inlining — sibling project to [kotomemo](https://github.com/koto2730/kotomemo).

> ⚠️ **Early development.** [v0.0.1](https://github.com/koto2730/kotoshelf/releases/tag/v0.0.1) is out with Phases 0–7 below; expect rough edges. Roadmap below.

## Positioning

- **kotomemo** — lightweight text editor for configs and quick memos. Native-JVM, minimal, fast.
- **kotoshelf** *(this)* — workspace-centric Markdown editor with rendered preview, wiki links, image inlining, per-file variables, workspace-wide search. Tauri + CodeMirror 6.

The two are intentionally separate projects because a "lightweight notepad" and a "workspace-based Markdown editor" pull in opposite architectural directions.

## Tech stack

- **Frontend**: React + TypeScript, Vite, Tailwind CSS, CodeMirror 6 (Markdown language)
- **Backend**: Rust (Tauri v2)
- **Distribution**: `tauri build` → `.msi` / `.dmg` / `.AppImage` / `.deb`

## Roadmap

- [x] Phase 0 — Scaffold: Tauri v2 + React + CM6, three-pane skeleton.
- [x] Phase 1 — Workspace open + file tree + editor tab + save.
- [x] Phase 2 — CodeMirror 6 Markdown Live Preview (heading / bold / list / todo / hr / url / wiki link / footnote styling with decorations).
- [x] Phase 3 — Right-side rendered preview pane with inline images (loaded from workspace attachments).
- [x] Phase 4 — Workspace-wide search & replace.
- [x] Phase 5 — Template variables (`{{today}}`, `{{yyyy-mm-dd:-1}}`, `{{title}}`, ...).
- [x] Phase 6 — API request feature (ported from kotomemo Send palette).
- [x] Phase 7 — Custom themes via JSON files.
- [x] Phase 8 — Remote workspaces over SSH (VS Code Remote-SSH-like): connect to a saved profile, browse/open/edit/save files, full file-tree CRUD (new file/folder, rename, delete-to-`.kotoshelf/.trash/`), clipboard image paste and OS file drops, an integrated terminal, and an image viewer (files opened as a read-only view, not loaded into the text editor). Connection reuse (ControlMaster) and cached file sizes keep it fast; a large-file guard blocks opening anything over a threshold rather than risking a hang pulling it over the wire.

### Under consideration (Phase 9+)

Not committed yet — rough ideas being weighed, roughly in this order:

- **Phase 9 — Streaming playback for large media over SSH** — today, opening any file (image or otherwise) over SSH means pulling the whole thing into memory first, guarded by a size limit so a multi-GB video can't hang the app. True streaming (play a video immediately, browser-style, without downloading it first) needs a custom Tauri protocol handler that serves HTTP Range requests by doing partial reads (`dd`/`tail`/`head`) over SSH per requested byte range - a real chunk of work, not a quick follow-on.
- **Phase 10 — Git integration** — status / diff / commit from the sidebar.
- File history / restore (`.kotoshelf/history/`).
- Self-live-sync (Tailscale/Syncthing/CRDT).

## License

[MIT](LICENSE)
