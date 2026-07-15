# KotoShelf

A markdown-focused workspace editor with wiki links, live preview, and image inlining — sibling project to [kotomemo](https://github.com/koto2730/kotomemo).

> ⚠️ **Very early development.** Nothing here works yet beyond a scaffold. Roadmap below.

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
- [ ] Phase 1 — Workspace open + file tree + editor tab + save.
- [ ] Phase 2 — CodeMirror 6 Markdown Live Preview (heading / bold / list / todo / hr / url / wiki link / footnote styling with decorations).
- [ ] Phase 3 — Right-side rendered preview pane with inline images (loaded from workspace attachments).
- [ ] Phase 4 — Workspace-wide search & replace.
- [ ] Phase 5 — Template variables (`{{today}}`, `{{yyyy-mm-dd:-1}}`, `{{title}}`, ...).
- [ ] Phase 6 — API request feature (ported from kotomemo Send palette).
- [ ] Phase 7 — Custom themes via JSON files.
- [ ] Later — File history / restore (`.kotoshelf/history/`), self-live-sync (Tailscale/Syncthing/CRDT).

## License

[MIT](LICENSE)
