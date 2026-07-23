import { useEffect, useState } from "react";
import { listCustomThemes } from "../lib/theme";

/**
 * Theme picker (Phase 7). A standalone dialog for now rather than a tab
 * inside a shared Settings dialog - kotoshelf doesn't have one yet on
 * this branch (Phase 6's API-preset Settings dialog is a sibling,
 * unmerged branch). Whichever phase merges second should fold this into
 * a Settings tab alongside API Presets, per the original plan.
 */
export function ThemeDialog({
  selection,
  onSelect,
  onClose,
}: {
  selection: string;
  onSelect: (name: string) => void;
  onClose: () => void;
}) {
  const [customThemes, setCustomThemes] = useState<string[]>([]);

  useEffect(() => {
    void listCustomThemes().then(setCustomThemes);
  }, []);

  const options: { value: string; label: string }[] = [
    { value: "system", label: "System (follow OS)" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    ...customThemes.map((name) => ({ value: name, label: name })),
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-96 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-4 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-medium mb-1">Theme</div>
        <p className="text-xs text-slate-500 mb-3">
          Custom themes are JSON files in{" "}
          <code className="font-mono">~/.kotoshelf/themes/</code>. Add a file
          there and reopen this dialog to see it listed.
        </p>
        <div className="flex flex-col gap-1">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={
                "text-left rounded px-2 py-1.5 " +
                (opt.value === selection
                  ? "bg-blue-100 dark:bg-blue-900"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800")
              }
              onClick={() => {
                onSelect(opt.value);
                onClose();
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="mt-3 text-right">
          <button
            type="button"
            className="rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-3 py-1"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
