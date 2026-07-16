# KotoShelf 仕様書

Markdown ワークスペース型エディタ。kotomemo と同じ作者による**別プロジェクト**。

初回作成: 2026-08 頃 (kotomemo v1.0.4 リリース後、Markdown 対応の議論から派生)

## 位置づけ

| プロジェクト | 位置づけ | 対象ユーザ |
|---|---|---|
| **kotomemo** | 軽量メモ帳・設定編集用テキストエディタ (JVM + Compose Desktop) | 起動速度重視、Notepad の代替 |
| **kotoshelf** (本プロジェクト) | ワークスペース型 Markdown エディタ (Tauri v2 + CodeMirror 6) | ノート集約、Obsidian ライトな用途 |

両者は明確に別物として運用する。kotomemo は「軽量メモ帳」ポジションを維持、kotoshelf は Markdown・画像・ワークスペースを扱うヘビー機能を担う。

## 命名

- **`KotoShelf`** ("Koto" は kotomemo 系譜、"Shelf" は本棚のメタファー = ノート群を集約する場所)
- 当初「MdShelf」も検討したが、**Markdown のごく一部しかサポートしない**ため誤解を招くと判断し不採用。"Kt" (Kotlin 誤解の可能性) より "Koto" のフル形を採用。
- 実装言語は Rust + TypeScript だが、名前は kotomemo 家族継承を優先。

---

## 1. 技術スタック

### 選定結果

| レイヤー | 採用 | 理由 |
|---|---|---|
| Bundler / Runtime | **Tauri v2** | OS 内蔵 WebView 使用、バンドル小 (2-10 MB)、Rust バックエンド。Electron の重量を避けつつウェブエコシステム利用可 |
| Backend | **Rust** | Tauri 標準、FS/シェル/ダイアログ等 Tauri API 経由で最小限の Rust コードで済む |
| Frontend framework | **React + TypeScript** | 情報量、CodeMirror 6 の React ラッパー (@uiw/react-codemirror) の存在、Tauri テンプレの充実 |
| Package manager | **npm** (pnpm 未インストールのため一旦 npm、後で切替可) | |
| Bundler | **Vite** | Tauri v2 の標準セットアップ |
| Styling | **Tailwind CSS v3** | 雛形の早さ、dark mode サポート、JSON テーマ対応の下地 |
| Editor engine | **CodeMirror 6** | Live Preview に必要な decoration/widget API を持つ唯一の現実解 (Compose Desktop 標準では不可能) |
| Markdown language | **@codemirror/lang-markdown** | GFM ベース、Wiki link は自前拡張予定 |

### 却下した代替

- **Electron + CodeMirror 6**: バンドル 150 MB+、重すぎる
- **Compose Desktop 継続** (kotomemo のフォーク): `BasicTextField` に decoration/widget primitive がなく Live Preview 不可能。フォークしても同じ制約に当たるだけ
- **JavaFX WebView 埋め込み**: JavaFX バンドルコスト (~30 MB)、JavaFX 縮小トレンド
- **JCEF (Chromium 埋め込み)**: 150-200 MB のバンドル増、"軽量" ポジションに反する
- **AsciiDoc / RST / Org-mode**: メモ用途にオーバースペック、エコシステム狭い
- **Solid / Svelte**: 悪くないが React エコシステム (CodeMirror ラッパー) が濃い

### アーキテクチャ

```
┌─────────────────────────────────┐
│ ネイティブウィンドウ (Rust)          │
│  ┌─────────────────────────────┐│
│  │ OS 内蔵 WebView              ││
│  │  ┌───────────────────────┐  ││
│  │  │ HTML/CSS/JS         │  ││
│  │  │ (React + CM6)       │  ││
│  │  └───────────────────────┘  ││
│  └─────────────────────────────┘│
│  IPC (invoke/emit)              │
│    ↕                            │
│  Rust バックエンド                 │
└─────────────────────────────────┘
```

- Windows: WebView2 (Edge/Chromium ベース、Win10+ 標準)
- macOS: WKWebView (Safari/WebKit ベース、標準)
- Linux: WebKitGTK (システムに別途、`libwebkit2gtk-4.1` を要求)

「ブラウザで動くアプリ」ではなく、通常のデスクトップアプリとして OS に見える。ただしウィジェットは HTML なので純ネイティブ (Cocoa/Win32/GTK ウィジェット) ではない。**CJK IME は OS WebView が扱うので kotomemo の Compose Desktop で苦労したような問題は出ない見込み**。

---

## 2. 機能スコープ

### 2.1 エディタ本体 (kotomemo から継承)

- 複数タブ
- Find/Replace (単ファイル内、Ctrl+F / Ctrl+H)
- Encoding (UTF-8 / UTF-16 + BOM トグル)
- Line ending (LF / CRLF)
- Zoom (Ctrl+= / Ctrl+-)
- Undo/Redo
- Copy/Paste (画像貼付含む)
- Bulk indent (Tab / Shift+Tab)
- Font 変更可 (default: システム等幅)
- Save / Save As / Open / New

### 2.2 Markdown 対応

サポートする Markdown 要素 (GFM 相当 + Obsidian 風 Wiki link):

| 要素 | 記法 | Live Preview 挙動 |
|---|---|---|
| 見出し | `#` `##` `###` | 大きく太く、`#` はカーソル位置で表示切替 |
| ボールド | `**text**` | 太字、マーカーはカーソル離れると隠す |
| イタリック | `*text*` | 斜体、同上 |
| 箇条書き UL | `- item` `* item` | マーカー装飾 |
| 箇条書き OL | `1. item` `2. item` | 数字装飾 |
| ToDo | `- [ ]` `- [x]` | クリックでトグル可、`[x]` は打消線 |
| 区切り線 | `---` | 全行に background 適用 |
| コード (inline) | `` `code` `` | 等幅 + 背景色 |
| コード (block) | ` ```lang ` | 等幅 + 背景色 + syntax highlight |
| Blockquote | `> quote` | 淡背景 |
| Link (URL) | `[text](url)` `https://...` | 色付、Ctrl+クリックでブラウザ open |
| **Wiki link** | `[[note]]` | 色付、Ctrl+クリックで該当ノート open (同名複数マッチはメニュー選択) |
| 注釈 | `[^1]` `[^1]: 説明` | マーカー色付 |
| 画像 | `![alt](path)` | **右ペインで**インライン表示 (エディタ内は文字列のみ) |

「マーカー隠す」動作は CM6 の decoration API で実現。Compose Desktop では原理的に不可能だった機能。

### 2.3 ワークスペース

- **Folder as workspace** (VS Code スタイル)
- **3 ペインレイアウト**:

```
┌────────┬───────────────────┬────────────┐
│ File   │                   │            │
│ tree   │   Editor          │  Preview   │
│ (folder│   (CodeMirror 6)  │  (rendered │
│  tree) │   Live Preview    │   markdown)│
│        │                   │            │
└────────┴───────────────────┴────────────┘
```

- ペインは resizable、preview は隠せる
- 左: ワークスペースフォルダのツリー、`.md` ファイル一覧、attachments 展開可
- 中: CodeMirror 6 エディタ、Live Preview 有効、複数タブ
- 右: レンダリング済 Markdown プレビュー (画像インライン表示)

### 2.4 全検索・全置換

- **ワークスペース全体で検索・置換** (VS Code の `Ctrl+Shift+F` 相当)
- Regex 対応、大文字小文字トグル

### 2.5 テンプレ変数

編集中カーソル位置に展開:

| 変数 | 展開結果 (例) |
|---|---|
| `{{today}}` | `2026-08-15` |
| `{{yyyy-mm-dd:-1}}` | `2026-08-14` (day offset) |
| `{{now}}` | `2026-08-15 15:30` |
| `{{time}}` | `15:30` |
| `{{title}}` | フロントマター → 先頭 heading → filename の優先順 |
| `{{filename}}` | 現在のファイル名 |
| `{{workspace}}` | ワークスペースフォルダ名 |

`{{title}}` は各 `.md` ファイルの YAML frontmatter (`--- title: xxx ---`) を最優先で参照。

### 2.6 API リクエスト機能

kotomemo の **Send palette** をそのまま移植:
- プリセット (URL, method, headers, body template)
- `{{selection}}` `{{tokens.NAME}}` 等のテンプレ展開
- レスポンスを新規タブ / 選択後に挿入 / ステータスのみ、から選択
- Ctrl+; で palette 起動

### 2.7 添付ファイル (attachments)

kotomemo v1.0.3 の設計を継承:

- **共有 attachments フォルダ** (ワークスペース側で設定可、デフォルト `attachments`)
- Ctrl+V のクリップボード画像 → PNG で attachments フォルダに保存 → `![alt](attachments/img-YYYYMMDD-HHmmss.png)` 挿入
- 右ペイン (rendered preview) で画像インライン表示 (loadImageBitmap)
- 動画 / PDF / その他バイナリはクリック → OS 既定アプリで open
- IMAGES/ATTACHMENTS view (kotomemo にあった) は左ペインの file tree に統合予定

---

## 3. 設計判断 (履歴)

| 決定 | 選択肢 | 選んだ理由 |
|---|---|---|
| Wiki link 複数マッチ | メニュー選択 / 曖昧度スコア自動選択 | ユーザ意図が明確になるためメニュー |
| タブ機能 | 単一 / 複数 | kotomemo でも複数タブだったため踏襲 |
| outline / TOC ペイン | 有り / 無し | まずは無し、代わりに `{{title}}` で各ノートのメタ情報を管理 |
| テーマ | OS 追従 / 手動切替 | **OS 追従が default**。ただし custom テーマ JSON ファイル対応は最初から設計に入れる |
| 設定 UI | Dialog UI / JSON 直編集 / VS Code 風 | **JSON を Dialog 内 CodeMirror で表示・編集**。設定項目の増減に強い |
| フォント | 固定 / 変更可 | 変更可、default 等幅 |
| サンプル workspace | 空起動 / 初回サンプル提示 | 初回サンプル `.md` を提示 |
| Untitled タブでの画像ペースト | 拒否 / ステータス表示 / モーダルダイアログ | **モーダルダイアログ「Save Now / Cancel」** (kotomemo でも同じ結論に落ち着いた) |

### テーマシステム設計

- Built-in: `light`, `dark`, `system` (OS 追従、default)
- ユーザ定義: `~/.kotoshelf/themes/*.json`
- スキーマ: editor color, syntax color token を JSON で定義
- CodeMirror 6 の theme convention (Compartments API) に合わせる

### 設定ストレージ

- 実体: `~/.kotoshelf/settings.json`
- Dialog で CodeMirror JSON エディタ表示
- 保存時に Zod で validate

---

## 4. 実装フェーズ

### 完了

- **Phase 0** (2026-07-15): Tauri v2 + React + TS + CM6 + Tailwind scaffold、3 ペイン空レイアウト、GitHub CI (3 OS bundles pass)、リポ [koto2730/kotoshelf](https://github.com/koto2730/kotoshelf) 公開

### これから

| Phase | 内容 | 想定 |
|---|---|---|
| 1 | Workspace open (フォルダ選択) + file tree + editor タブ + save/reload | 2 日 |
| 2 | CodeMirror 6 Markdown Live Preview (decoration/widget、Tier B レベル) | 2-3 日 |
| 3 | 分離 Preview ペイン強化 (画像インライン = asset protocol) + Wiki link 解決 + 画像の取り込み (Ctrl+V ペースト / drag & drop → attachments 保存 → `![]()` 挿入。Tauri の dragDropEnabled 設定に注意) | 2-3 日 |
| 4 | Workspace 全検索置換 (regex 対応) | 2 日 |
| 5 | テンプレ変数展開 (`{{today}}` 等) + ショートカット挿入 | 2 日 |
| 6 | API request 機能 (kotomemo Send palette 移植) | 1-2 日 |
| 7 | カスタムテーマ JSON 対応 | 1-2 日 |

**合計 12-15 日、休憩含め 3-4 週間**

### リリース

- タグ `v0.1.0` 系で pre-release、Phase 1-3 完了後に予定
- CI (build.yml) は既に稼働、後で release.yml (tag-triggered) を追加

---

## 5. 将来の設計配慮 (Phase 8+ 想定)

### 5.1 ファイル履歴・復活

- 各 `.md` の save ごとに snapshot 保存 → `.kotoshelf/history/` 配下
- 保存方式: content-addressed store (git 風) or timestamped ファイル全文
- UI: 右クリック → "Show history" → タイムラインから復元
- 設定: on/off、retention policy (最新 N 件、N 日間 等)

### 5.2 Self-live-sync

- 複数デバイス間のリアルタイム同期
- 現実的方針:
  - **Tailscale + Syncthing** (既存ツール活用、最も軽い)
  - **Yjs / Automerge (CRDT)** で real-time collab (実装重い)
  - **git 経由** (シンプル、履歴と統合できる)
- 設計原則: ファイルをディスク上の真実として扱う (DB に依存しない)、`.kotoshelf/` を同期除外可能に

---

## 6. 制約と割り切り

### できないこと

- **`BasicTextField` レベルの Compose Desktop 制約**は Tauri で解消。**CodeMirror 6 は decoration/widget を full support** するので Live Preview 可能
- **純ネイティブウィジェット (Cocoa NSButton / Win32 Button 等) は使わない** — UI 中身は HTML
- Chromium バンドルはしない (バンドル増を避けたいので、Windows は Edge の WebView2 に依存する)

### 割り切っている挙動

- スクロールバー: OS ネイティブではなく Web 標準の見た目
- Linux バンドル: `libwebkit2gtk-4.1` が入っていない distro では動かない (ubuntu 22.04+ / Debian 12+ / Fedora 38+ など主要 distro には入っている)
- macOS 署名 / notarization: 初期リリースでは省略、必要になったら対応

---

## 7. リンク

- Repo: <https://github.com/koto2730/kotoshelf>
- 姉妹プロジェクト: <https://github.com/koto2730/kotomemo>
- Tauri v2 docs: <https://v2.tauri.app/>
- CodeMirror 6: <https://codemirror.net/>
