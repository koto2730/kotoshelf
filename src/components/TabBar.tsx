import { isDirty, type Tab } from "../lib/tabs";

export function TabBar({
  tabs,
  activeIndex,
  onSelect,
  onClose,
}: {
  tabs: Tab[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
}) {
  if (tabs.length === 0) {
    return (
      <div className="h-9 border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 flex items-center px-3 text-sm text-slate-400 italic">
        No file open
      </div>
    );
  }
  return (
    <div className="h-9 border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 flex items-stretch overflow-x-auto">
      {tabs.map((tab, i) => (
        <div
          key={tab.id}
          className={
            "flex items-center gap-1.5 px-3 text-sm cursor-pointer border-r border-slate-200 dark:border-slate-800 whitespace-nowrap " +
            (i === activeIndex
              ? "bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100"
              : "text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800")
          }
          onClick={() => onSelect(i)}
          onAuxClick={(e) => {
            // Middle-click closes, the muscle memory from every browser
            // and editor with tabs.
            if (e.button === 1) onClose(i);
          }}
          title={tab.path ?? tab.name}
        >
          <span>{tab.name}</span>
          {isDirty(tab) && <span className="text-amber-500 leading-none">●</span>}
          <button
            type="button"
            className="ml-1 rounded px-1 text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-300 dark:hover:bg-slate-700"
            onClick={(e) => {
              e.stopPropagation();
              onClose(i);
            }}
            aria-label={`Close ${tab.name}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
