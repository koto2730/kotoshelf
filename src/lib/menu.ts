import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";

/**
 * Command surface the native menu drives. App keeps a ref with the
 * latest implementations so menu closures never go stale.
 */
export interface AppCommands {
  newFile: () => void;
  openFolder: () => void;
  openRemoteWorkspace: () => void;
  openSshTerminal: () => void;
  save: () => void;
  saveAs: () => void;
  saveAll: () => void;
  closeActiveTab: () => void;
  closeAllTabs: () => void;
  exit: () => void;
  undo: () => void;
  redo: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
  openFind: () => void;
  openReplace: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  togglePreview: () => void;
  openSendPalette: () => void;
  openSettings: () => void;
  openThemeDialog: () => void;
}

/**
 * Guard against a command firing twice for one keypress. Menu
 * accelerators are processed by the native menu system AND the same
 * chord may reach the webview where our fallback keydown handlers live.
 * Whichever path fires first wins; the duplicate inside the window is
 * dropped.
 */
const lastRun = new Map<string, number>();
export function dedup(name: string, fn: () => void): void {
  const now = Date.now();
  const prev = lastRun.get(name) ?? 0;
  if (now - prev < 200) return;
  lastRun.set(name, now);
  fn();
}

/**
 * Build and install the native application menu (Windows: window menu
 * bar, macOS: global menu bar). Mirrors kotomemo's menu structure.
 */
export async function installAppMenu(commands: {
  readonly current: AppCommands | null;
}): Promise<void> {
  const run = (name: keyof AppCommands) => () =>
    dedup(name, () => commands.current?.[name]());

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await MenuItem.new({ text: "New File", accelerator: "CmdOrCtrl+N", action: run("newFile") }),
      await MenuItem.new({ text: "Open Folder…", accelerator: "CmdOrCtrl+Shift+O", action: run("openFolder") }),
      await MenuItem.new({ text: "Open Remote Folder (SSH)…", action: run("openRemoteWorkspace") }),
      await MenuItem.new({ text: "Open SSH Terminal", action: run("openSshTerminal") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Save", accelerator: "CmdOrCtrl+S", action: run("save") }),
      await MenuItem.new({ text: "Save As…", accelerator: "CmdOrCtrl+Shift+S", action: run("saveAs") }),
      // VS Code-style two-key chord (Ctrl+K then a second key) - the
      // native menu accelerator field can only express a single
      // simultaneous modifier+key combo, not a two-stage sequence, so
      // these are handled entirely by the webview keydown fallback
      // (see App.tsx) and just documented in the label here.
      await MenuItem.new({ text: "Save All (Ctrl+K S)", action: run("saveAll") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Close Tab", accelerator: "CmdOrCtrl+W", action: run("closeActiveTab") }),
      await MenuItem.new({ text: "Close All Tabs (Ctrl+K Ctrl+W)", action: run("closeAllTabs") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Exit", accelerator: "CmdOrCtrl+Q", action: run("exit") }),
    ],
  });

  // Undo/Redo/clipboard go through explicit CodeMirror commands rather
  // than PredefinedMenuItem so they hit the editor's history, not the
  // webview's native (and separate) undo stack.
  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await MenuItem.new({ text: "Undo", accelerator: "CmdOrCtrl+Z", action: run("undo") }),
      await MenuItem.new({ text: "Redo", accelerator: "CmdOrCtrl+Y", action: run("redo") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Cut", action: run("cut") }),
      await MenuItem.new({ text: "Copy", action: run("copy") }),
      await MenuItem.new({ text: "Paste", action: run("paste") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Select All", accelerator: "CmdOrCtrl+A", action: run("selectAll") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Find…", accelerator: "CmdOrCtrl+F", action: run("openFind") }),
      await MenuItem.new({ text: "Replace…", accelerator: "CmdOrCtrl+H", action: run("openReplace") }),
    ],
  });

  const viewMenu = await Submenu.new({
    text: "View",
    items: [
      await MenuItem.new({ text: "Zoom In", accelerator: "CmdOrCtrl+=", action: run("zoomIn") }),
      await MenuItem.new({ text: "Zoom Out", accelerator: "CmdOrCtrl+-", action: run("zoomOut") }),
      await MenuItem.new({ text: "Reset Zoom (100%)", accelerator: "CmdOrCtrl+0", action: run("zoomReset") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Toggle Preview", accelerator: "CmdOrCtrl+Shift+V", action: run("togglePreview") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Theme…", action: run("openThemeDialog") }),
    ],
  });

  const sendMenu = await Submenu.new({
    text: "Send",
    items: [
      await MenuItem.new({ text: "Send Palette…", accelerator: "CmdOrCtrl+;", action: run("openSendPalette") }),
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({ text: "Settings…", action: run("openSettings") }),
    ],
  });

  const menu = await Menu.new({ items: [fileMenu, editMenu, viewMenu, sendMenu] });
  await menu.setAsAppMenu();
}
