import { useEffect, useState } from "react";
import { getAppConfig, setAppConfig, newPreset, type ApiPreset } from "../lib/apiPresets";

/**
 * API preset management (Phase 6), ported from kotomemo's
 * ApiPresetDialog. A single tab for now - kotoshelf has no editor-level
 * settings yet to warrant kotomemo's tabbed Settings/API-Presets split
 * (spec's exclude-pattern config already lives inline in SearchPanel).
 * Add tabs here if/when a second settings category shows up.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [presets, setPresets] = useState<ApiPreset[]>([]);
  const [tokensText, setTokensText] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [headerDrafts, setHeaderDrafts] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void getAppConfig().then((config) => {
      setPresets(config.presets);
      setHeaderDrafts(config.presets.map(headersToText));
      setTokensText(
        Object.entries(config.tokens)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      );
      setSelectedIndex(config.presets.length > 0 ? 0 : -1);
      setLoaded(true);
    });
  }, []);

  const selected = selectedIndex >= 0 ? presets[selectedIndex] : undefined;

  const updateSelected = (patch: Partial<ApiPreset>) => {
    if (selectedIndex < 0) return;
    setPresets((prev) =>
      prev.map((p, i) => (i === selectedIndex ? { ...p, ...patch } : p)),
    );
  };

  const addPreset = () => {
    setPresets((prev) => [...prev, newPreset(`new-${prev.length + 1}`)]);
    setHeaderDrafts((prev) => [...prev, ""]);
    setSelectedIndex(presets.length);
  };

  const removePreset = () => {
    if (selectedIndex < 0) return;
    setPresets((prev) => prev.filter((_, i) => i !== selectedIndex));
    setHeaderDrafts((prev) => prev.filter((_, i) => i !== selectedIndex));
    setSelectedIndex((prev) => Math.min(prev, presets.length - 2));
  };

  const save = async () => {
    const tokens = parseTokens(tokensText);
    const finalPresets = presets.map((p, i) => ({
      ...p,
      headers: textToHeaders(headerDrafts[i] ?? ""),
    }));
    await setAppConfig({ presets: finalPresets, tokens });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[820px] h-[600px] flex flex-col rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-4 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-medium mb-3">Settings — API Presets</div>
        {!loaded ? (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            Loading…
          </div>
        ) : (
          <>
            <div className="flex flex-1 min-h-0 gap-3">
              {/* Preset list */}
              <div className="w-48 shrink-0 flex flex-col">
                <div className="flex-1 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
                  {presets.length === 0 && (
                    <div className="p-2 text-slate-400 italic">(empty)</div>
                  )}
                  {presets.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      className={
                        "block w-full text-left truncate px-2 py-1.5 " +
                        (i === selectedIndex
                          ? "bg-blue-100 dark:bg-blue-900"
                          : "hover:bg-slate-100 dark:hover:bg-slate-800")
                      }
                      onClick={() => setSelectedIndex(i)}
                    >
                      {p.name || "(unnamed)"}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1 pt-1.5">
                  <button
                    type="button"
                    className="flex-1 rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 py-1"
                    onClick={addPreset}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className="flex-1 rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 py-1 disabled:opacity-40"
                    onClick={removePreset}
                    disabled={selectedIndex < 0}
                  >
                    Remove
                  </button>
                </div>
              </div>

              {/* Preset form */}
              <div className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-2">
                {selected ? (
                  <>
                    <Field label="Name">
                      <input
                        className="input"
                        value={selected.name}
                        onChange={(e) => updateSelected({ name: e.target.value })}
                      />
                    </Field>
                    <Field label="URL — supports {{selection}}, {{tokens.NAME}}, etc.">
                      <input
                        className="input"
                        value={selected.url}
                        onChange={(e) => updateSelected({ url: e.target.value })}
                      />
                    </Field>
                    <div className="flex gap-2">
                      <Field label="Method" className="w-32">
                        <select
                          className="input"
                          value={selected.method}
                          onChange={(e) => updateSelected({ method: e.target.value })}
                        >
                          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Response target" className="flex-1">
                        <select
                          className="input"
                          value={selected.responseTarget}
                          onChange={(e) =>
                            updateSelected({
                              responseTarget: e.target.value as ApiPreset["responseTarget"],
                            })
                          }
                        >
                          <option value="newTab">New tab</option>
                          <option value="afterSelection">Insert after selection</option>
                          <option value="statusOnly">Status only</option>
                        </select>
                      </Field>
                    </div>
                    <Field label="Headers (one per line, key: value) — values support {{selection}}, {{tokens.NAME}}, etc.">
                      <textarea
                        className="input h-20 font-mono"
                        spellCheck={false}
                        value={headerDrafts[selectedIndex] ?? ""}
                        onChange={(e) =>
                          setHeaderDrafts((prev) =>
                            prev.map((h, i) => (i === selectedIndex ? e.target.value : h)),
                          )
                        }
                        placeholder={"Authorization: Bearer {{tokens.openai}}\nContent-Type: application/json"}
                      />
                    </Field>
                    <Field label="Body template — use {{selection}}, {{selectionJson}}, {{tokens.NAME}}">
                      <textarea
                        className="input h-28 font-mono"
                        spellCheck={false}
                        value={selected.bodyTemplate}
                        onChange={(e) => updateSelected({ bodyTemplate: e.target.value })}
                      />
                    </Field>
                    <Field label="Response JSON path (optional, e.g. choices.0.message.content)">
                      <input
                        className="input"
                        value={selected.responseJsonPath ?? ""}
                        onChange={(e) =>
                          updateSelected({ responseJsonPath: e.target.value || null })
                        }
                      />
                    </Field>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-slate-400">
                    Select or add a preset
                  </div>
                )}
              </div>
            </div>

            <div className="pt-3">
              <div className="text-xs text-slate-500 mb-1">Tokens (one per line, key=value)</div>
              <textarea
                className="input h-16 font-mono w-full"
                spellCheck={false}
                value={tokensText}
                onChange={(e) => setTokensText(e.target.value)}
                placeholder={"openai=sk-...\nmyapi=abc123"}
              />
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-3">
          <button
            type="button"
            className="rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-3 py-1"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 text-white hover:bg-blue-500 px-3 py-1"
            onClick={() => void save()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-0.5 ${className}`}>
      <span className="text-xs text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function headersToText(preset: ApiPreset): string {
  return preset.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
}

/** Half-typed lines (no ":" yet) are dropped here, same footgun kotomemo
 * hit and fixed: this function must only run at Save time, never on
 * every keystroke, or a half-typed header name gets wiped as the user
 * types it (draft state in headerDrafts is what keystrokes actually
 * bind to). */
function textToHeaders(text: string): [string, string][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes(":"))
    .map((line) => {
      const idx = line.indexOf(":");
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] as [string, string];
    });
}

function parseTokens(text: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    tokens[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1);
  }
  return tokens;
}
