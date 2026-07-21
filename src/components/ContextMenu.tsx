export interface MenuAction {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/** Minimal custom context menu (native menus are app-global in Tauri, so
 * per-node tree menus are easier as plain HTML). */
export function ContextMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: MenuAction[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        className="absolute min-w-[160px] rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg py-1"
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
      >
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={
              "block w-full text-left text-sm px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 " +
              (action.danger ? "text-red-600 dark:text-red-400" : "")
            }
            onClick={() => {
              onClose();
              action.onClick();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
