import { formatBytes, LARGE_FILE_WARN_BYTES, type TreeNode } from "../lib/fs";

/**
 * Recursive workspace tree. Expansion state is controlled by the parent
 * (App.tsx) rather than owned here, since expanding a folder whose
 * children haven't been loaded yet (the lazy tree pane) needs to trigger
 * a fetch - a decision that requires knowing both the node and the
 * current workspace, neither of which this component has.
 */
export function FileTree({
  nodes,
  expanded,
  onToggle,
  onOpenFile,
  activePath,
  onNodeMenu,
}: {
  nodes: TreeNode[];
  expanded: Set<string>;
  /** Called when a directory row is clicked, before `expanded` is
   * expected to change - the caller decides whether to fetch children. */
  onToggle: (node: TreeNode) => void;
  onOpenFile: (path: string) => void;
  activePath: string | null;
  /** Right-click on a tree row. Coordinates are viewport-relative. */
  onNodeMenu?: (node: TreeNode, x: number, y: number) => void;
}) {
  return (
    <div className="text-sm select-none">
      <TreeLevel
        nodes={nodes}
        depth={0}
        expanded={expanded}
        onToggle={onToggle}
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
  onToggle: (node: TreeNode) => void;
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
              node.isDir ? onToggle(node) : onOpenFile(node.path)
            }
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onNodeMenu?.(node, e.clientX, e.clientY);
            }}
            title={
              !node.isDir && node.size > LARGE_FILE_WARN_BYTES
                ? `${node.path} - too large to open (${formatBytes(node.size)})`
                : node.path
            }
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
            {!node.isDir && node.size > LARGE_FILE_WARN_BYTES && (
              <span
                className="ml-1 text-amber-500 dark:text-amber-400"
                title={`Too large to open (${formatBytes(node.size)})`}
              >
                ^
              </span>
            )}
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
          {node.isDir && expanded.has(node.path) && !node.children && (
            <div
              className="text-slate-400 italic"
              style={{ paddingLeft: `${(depth + 1) * 14 + 4}px` }}
            >
              Loading…
            </div>
          )}
        </div>
      ))}
    </>
  );
}
