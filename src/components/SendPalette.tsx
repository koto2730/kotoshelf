import { useEffect, useState } from "react";
import type { ApiPreset } from "../lib/apiPresets";

/** Ctrl+; preset picker, ported from kotomemo's SendPaletteDialog:
 * numbered rows (1-9, 0 = 10th) fire on digit press, arrow keys move a
 * highlight for anything beyond the first ten, Enter fires the
 * highlighted row, Esc cancels. */
export function SendPalette({
  presets,
  onPick,
  onClose,
}: {
  presets: ApiPreset[];
  onPick: (preset: ApiPreset) => void;
  onClose: () => void;
}) {
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Enter") {
        if (presets[highlight]) onPick(presets[highlight]);
        return;
      }
      if (e.key === "ArrowDown") {
        setHighlight((h) => Math.min(h + 1, presets.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        setHighlight((h) => Math.max(h - 1, 0));
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        const idx = e.key === "0" ? 9 : Number(e.key) - 1;
        if (presets[idx]) onPick(presets[idx]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [presets, highlight, onPick, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-32 bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-h-[60vh] overflow-y-auto rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl py-1"
        onClick={(e) => e.stopPropagation()}
      >
        {presets.length === 0 ? (
          <div className="p-4 text-sm text-slate-400 italic">
            No presets configured. Open Settings to add one.
          </div>
        ) : (
          presets.map((p, i) => (
            <button
              key={i}
              type="button"
              className={
                "w-full text-left px-3 py-2 flex items-center gap-3 " +
                (i === highlight
                  ? "bg-blue-100 dark:bg-blue-900"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800")
              }
              onMouseEnter={() => setHighlight(i)}
              onClick={() => onPick(p)}
            >
              <span className="w-4 text-xs text-slate-400 tabular-nums">
                {i < 9 ? i + 1 : i === 9 ? 0 : ""}
              </span>
              <span className="flex-1 min-w-0">
                <div className="text-sm truncate">{p.name}</div>
                <div className="text-xs text-slate-400 truncate">{p.url}</div>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
