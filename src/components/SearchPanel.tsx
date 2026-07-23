import { useEffect, useState } from "react";
import type { FileSearchResult } from "../lib/fs";
import {
  searchWorkspace,
  replaceInFiles,
  getSearchConfig,
  setSearchConfig,
} from "../lib/fs";
import { basename } from "../lib/tabs";

export interface SearchOpenTarget {
  path: string;
  line: number;
  col: number;
  len: number;
}

/**
 * Workspace-wide find/replace. Search runs in Rust (search_workspace) so
 * a few thousand notes don't need to round-trip full file contents
 * through IPC just to grep them. Replace All operates only on files the
 * current result set touched - re-running search after a replace keeps
 * the list honest instead of trusting stale matches.
 */
export function SearchPanel({
  workspace,
  onOpenMatch,
  onStatus,
}: {
  workspace: string;
  onOpenMatch: (target: SearchOpenTarget) => void;
  onStatus: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showExcludeEditor, setShowExcludeEditor] = useState(false);
  const [excludeText, setExcludeText] = useState("");

  // Load the workspace's exclude list once when the panel mounts /
  // workspace changes, so the editor has something to show without an
  // extra click.
  useEffect(() => {
    void getSearchConfig(workspace).then((c) => setExcludeText(c.exclude.join("\n")));
  }, [workspace]);

  const saveExcludes = async () => {
    const patterns = excludeText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await setSearchConfig(workspace, { exclude: patterns });
      onStatus(`Search exclude patterns saved (${patterns.length})`);
      setShowExcludeEditor(false);
    } catch (e) {
      onStatus(`${e}`);
    }
  };

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);

  const runSearch = async () => {
    if (!query) {
      setResults([]);
      return;
    }
    setSearching(true);
    try {
      const r = await searchWorkspace(workspace, query, isRegex, caseSensitive);
      setResults(r);
      onStatus(
        `${r.reduce((s, f) => s + f.matches.length, 0)} matches in ${r.length} files`,
      );
    } catch (e) {
      onStatus(`${e}`);
    } finally {
      setSearching(false);
    }
  };

  const runReplaceAll = async () => {
    if (!query || results.length === 0) return;
    const ok = window.confirm(
      `Replace ${totalMatches} match(es) across ${results.length} file(s)? This cannot be undone by Ctrl+Z (files are written directly).`,
    );
    if (!ok) return;
    try {
      const changed = await replaceInFiles(
        results.map((r) => r.path),
        query,
        replacement,
        isRegex,
        caseSensitive,
      );
      const total = changed.reduce((s, r) => s + r.count, 0);
      onStatus(`Replaced ${total} match(es) in ${changed.length} file(s)`);
      await runSearch(); // refresh so the list reflects what's left (should be empty for a plain replace)
    } catch (e) {
      onStatus(`${e}`);
    }
  };

  const toggleCollapsed = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full text-sm">
      <div className="p-2 flex flex-col gap-1.5 border-b border-slate-200 dark:border-slate-800">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void runSearch()}
          placeholder="Search across workspace"
          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 outline-none focus:border-blue-500"
        />
        <input
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          placeholder="Replace with"
          className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 outline-none focus:border-blue-500"
        />
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={isRegex}
              onChange={(e) => setIsRegex(e.target.checked)}
            />
            Regex
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(e) => setCaseSensitive(e.target.checked)}
            />
            Aa
          </label>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            className="flex-1 rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-2 py-1"
            onClick={() => void runSearch()}
            disabled={searching}
          >
            {searching ? "Searching…" : "Search"}
          </button>
          <button
            type="button"
            className="flex-1 rounded bg-blue-600 text-white hover:bg-blue-500 px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => void runReplaceAll()}
            disabled={results.length === 0}
          >
            Replace All
          </button>
        </div>
        <button
          type="button"
          className="text-left text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          onClick={() => setShowExcludeEditor((v) => !v)}
        >
          {showExcludeEditor ? "▾" : "▸"} Exclude patterns…
        </button>
        {showExcludeEditor && (
          <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-200 dark:border-slate-800">
            <div className="text-xs text-slate-500">
              One glob per line (e.g. <code>**/*.txt</code>), matched against
              paths relative to the workspace root.
            </div>
            <textarea
              value={excludeText}
              onChange={(e) => setExcludeText(e.target.value)}
              rows={6}
              spellCheck={false}
              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 font-mono text-xs outline-none focus:border-blue-500"
            />
            <button
              type="button"
              className="self-end rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-2 py-1 text-xs"
              onClick={() => void saveExcludes()}
            >
              Save
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {results.length === 0 && query && !searching && (
          <div className="p-3 text-slate-400 italic">No matches.</div>
        )}
        {results.map((file) => (
          <div key={file.path}>
            <button
              type="button"
              className="w-full text-left px-2 py-1 flex items-center gap-1 hover:bg-slate-100 dark:hover:bg-slate-800 font-medium"
              onClick={() => toggleCollapsed(file.path)}
            >
              <span className="text-slate-400 w-3">
                {collapsed.has(file.path) ? "▸" : "▾"}
              </span>
              <span className="truncate">{basename(file.path)}</span>
              <span className="text-xs text-slate-400 ml-auto shrink-0">
                {file.matches.length}
              </span>
            </button>
            {!collapsed.has(file.path) &&
              file.matches.map((m, i) => (
                <button
                  key={i}
                  type="button"
                  className="w-full text-left pl-7 pr-2 py-0.5 truncate hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400"
                  onClick={() =>
                    onOpenMatch({
                      path: file.path,
                      line: m.line,
                      col: m.col,
                      len: m.len,
                    })
                  }
                  title={m.preview}
                >
                  <span className="text-slate-400">{m.line}:</span> {m.preview}
                </button>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
