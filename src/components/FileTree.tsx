import { useState } from "react";
import type { TreeNode } from "../lib/fs";

/**
 * Recursive workspace tree. Expansion state lives in a Set of paths at
 * the tree root (passed down), so a tree refresh (new node objects)
 * keeps folders expanded.
 */
export function FileTree({
  nodes,
  onOpenFile,
  activePath,
  onNodeMenu,
}: {
  nodes: TreeNode[];
  onOpenFile: (path: string) => void;
  activePath: string | null;
  /** Right-click on a tree row. Coordinates are viewport-relative. */
  onNodeMenu?: (node: TreeNode, x: number, y: number) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="text-sm select-none">
      <TreeLevel
        nodes={nodes}
        depth={0}
        expanded={expanded}
        onToggle={toggle}
        onOpenFile={onOpenFile}
        activePath={activePath}
        onNodeMenu={onNodeMenu}
      />
    </div>
  );
}

function TreeLevel({
  nodes,
  depth,
  expanded,
  onToggle,
  onOpenFile,
  activePath,
  onNodeMenu,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  activePath: string | null;
  onNodeMenu?: (node: TreeNode, x: number, y: number) => void;
}) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <button
            type="button"
            className={
              "w-full text-left truncate rounded px-1 py-0.5 hover:bg-slate-200 dark:hover:bg-slate-800 " +
              (node.path === activePath
                ? "bg-slate-200 dark:bg-slate-800 font-medium"
                : "")
            }
            style={{ paddingLeft: `${depth * 14 + 4}px` }}
            onClick={() =>
              node.isDir ? onToggle(node.path) : onOpenFile(node.path)
            }
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onNodeMenu?.(node, e.clientX, e.clientY);
            }}
            title={node.path}
          >
            <span className="mr-1 inline-block w-3 text-slate-400">
              {node.isDir ? (expanded.has(node.path) ? "▾" : "▸") : ""}
            </span>
            <span
              className={
                node.isDir
                  ? "text-slate-700 dark:text-slate-300"
                  : node.name.endsWith(".md")
                    ? "text-slate-900 dark:text-slate-100"
                    : "text-slate-500 dark:text-slate-400"
              }
            >
              {node.name}
            </span>
          </button>
          {node.isDir && expanded.has(node.path) && node.children && (
            <TreeLevel
              nodes={node.children}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              activePath={activePath}
              onNodeMenu={onNodeMenu}
            />
          )}
        </div>
      ))}
    </>
  );
}
