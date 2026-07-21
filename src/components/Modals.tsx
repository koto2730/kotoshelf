import { useState, type ReactNode } from "react";

function ModalShell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="min-w-[320px] max-w-[560px] max-h-[70vh] overflow-y-auto rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/** Pick one item from a short list (wiki-link ambiguity, etc.). */
export function ListPickerModal({
  title,
  items,
  onPick,
  onClose,
}: {
  title: string;
  items: { label: string; detail?: string; value: string }[];
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose}>
      <div className="text-sm font-medium mb-3">{title}</div>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            className="text-left rounded px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={() => onPick(item.value)}
          >
            <div className="text-sm">{item.label}</div>
            {item.detail && (
              <div className="text-xs text-slate-500 truncate">{item.detail}</div>
            )}
          </button>
        ))}
      </div>
      <div className="mt-3 text-right">
        <button
          type="button"
          className="text-sm rounded px-3 py-1 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700"
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </ModalShell>
  );
}

/** Single-line text prompt (new file / new folder / rename). */
export function InputModal({
  title,
  initial = "",
  placeholder,
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
    onClose();
  };
  return (
    <ModalShell onClose={onClose}>
      <div className="text-sm font-medium mb-3">{title}</div>
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") onClose();
        }}
        className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm outline-none focus:border-blue-500"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className="text-sm rounded px-3 py-1 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="text-sm rounded px-3 py-1 bg-blue-600 text-white hover:bg-blue-500"
          onClick={commit}
        >
          OK
        </button>
      </div>
    </ModalShell>
  );
}

/** Shown when attaching an image to an Untitled tab: the file must be
 * saved first so the attachments folder has somewhere to live. */
export function SaveFirstModal({
  onSaveNow,
  onClose,
}: {
  onSaveNow: () => void;
  onClose: () => void;
}) {
  return (
    <ModalShell onClose={onClose}>
      <div className="text-sm font-medium mb-2">Save this file first</div>
      <p className="text-sm text-slate-600 dark:text-slate-400 mb-4">
        KotoShelf needs to know where to put the attached image. Save this
        untitled tab to a file, and the image will land in the shared
        &quot;attachments&quot; folder next to it.
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="text-sm rounded px-3 py-1 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="text-sm rounded px-3 py-1 bg-blue-600 text-white hover:bg-blue-500"
          onClick={onSaveNow}
        >
          Save Now…
        </button>
      </div>
    </ModalShell>
  );
}
