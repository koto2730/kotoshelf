import { useEffect, useRef } from "react";
import type { FindReplaceState } from "../lib/findReplace";

/**
 * In-buffer Find/Replace for the currently open file. A transient
 * overlay drawn above the CodeMirror editor - per the app's established
 * rule for such overlays, it grabs keyboard focus explicitly
 * (autoFocus + its own onKeyDown) rather than relying on a global
 * listener, since CodeMirror otherwise keeps DOM focus underneath it
 * and the same keystroke gets processed as editor input too.
 */
export function FindReplaceBar({
  finder,
  onQueryChange,
  onReplacementChange,
  onRegexChange,
  onCaseSensitiveChange,
  onFindNext,
  onReplaceOne,
  onReplaceAll,
  onClose,
}: {
  finder: FindReplaceState;
  onQueryChange: (v: string) => void;
  onReplacementChange: (v: string) => void;
  onRegexChange: (v: boolean) => void;
  onCaseSensitiveChange: (v: boolean) => void;
  onFindNext: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}) {
  const queryRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queryRef.current?.focus();
    queryRef.current?.select();
  }, [finder.focusTick]);

  const message = (() => {
    const parts: string[] = [];
    if (finder.lastReplaceCount >= 0) {
      parts.push(`Replaced ${finder.lastReplaceCount}`);
      if (finder.wrapped) parts.push("— wrapped to top");
    } else if (finder.wrapped) {
      parts.push(`Wrapped to top — Matches: ${finder.lastMatchCount}`);
    } else if (finder.query) {
      parts.push(`Matches: ${finder.lastMatchCount}`);
    }
    if (finder.scope) parts.push("(in selection)");
    return parts.join(" ");
  })();

  return (
    <div
      className="flex flex-col gap-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-2 text-sm"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={queryRef}
          value={finder.query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onFindNext();
            }
          }}
          placeholder="Find"
          className="w-64 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 outline-none focus:border-blue-500"
        />
        <button
          type="button"
          className="rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-2 py-1"
          onClick={onFindNext}
        >
          Find Next
        </button>
        <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer">
          <input type="checkbox" checked={finder.regex} onChange={(e) => onRegexChange(e.target.checked)} />
          Regex
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer">
          <input
            type="checkbox"
            checked={finder.caseSensitive}
            onChange={(e) => onCaseSensitiveChange(e.target.checked)}
          />
          Aa
        </label>
        <button
          type="button"
          className="ml-auto text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          onClick={onClose}
        >
          Close (Esc)
        </button>
      </div>

      {finder.mode === "replace" && (
        <div className="flex items-center gap-1.5">
          <input
            value={finder.replacement}
            onChange={(e) => onReplacementChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onReplaceOne();
              }
            }}
            placeholder="Replace with"
            className="w-64 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 outline-none focus:border-blue-500"
          />
          <button
            type="button"
            className="rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-2 py-1"
            onClick={onReplaceOne}
          >
            Replace
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 text-white hover:bg-blue-500 px-2 py-1"
            onClick={onReplaceAll}
          >
            Replace All
          </button>
        </div>
      )}

      {message && <div className="text-xs text-slate-500">{message}</div>}
    </div>
  );
}
