import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getAppConfig, setAppConfig } from "../lib/apiPresets";
import { newSshProfile, sshTestConnection, type SshProfile } from "../lib/ssh";

/**
 * Remote (SSH) workspace management (Phase 8). Saved profiles live in
 * the same ~/.kotoshelf/config.json as API presets - a name, host,
 * optional port/user/identity file (all leanable on ~/.ssh/config when
 * left blank), and the remote folder to open as the workspace.
 *
 * "Connect" round-trips `cd <remotePath> && pwd` before handing off to
 * onConnect, so a typo'd path or an unreachable host fails right here
 * with a clear message instead of silently producing an empty tree.
 */
export function RemoteWorkspaceDialog({
  onConnect,
  onClose,
}: {
  onConnect: (profile: SshProfile) => void;
  onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<SshProfile[]>([]);
  const [sshCommandPath, setSshCommandPath] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [loaded, setLoaded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getAppConfig().then((config) => {
      setProfiles(config.sshProfiles);
      setSshCommandPath(config.sshCommandPath);
      setSelectedIndex(config.sshProfiles.length > 0 ? 0 : -1);
      setLoaded(true);
    });
  }, []);

  const selected = selectedIndex >= 0 ? profiles[selectedIndex] : undefined;

  const updateSelected = (patch: Partial<SshProfile>) => {
    if (selectedIndex < 0) return;
    setProfiles((prev) => prev.map((p, i) => (i === selectedIndex ? { ...p, ...patch } : p)));
  };

  const addProfile = () => {
    setProfiles((prev) => [...prev, newSshProfile(`remote-${prev.length + 1}`)]);
    setSelectedIndex(profiles.length);
  };

  const removeProfile = () => {
    if (selectedIndex < 0) return;
    setProfiles((prev) => prev.filter((_, i) => i !== selectedIndex));
    setSelectedIndex((prev) => Math.min(prev, profiles.length - 2));
  };

  const persist = async (next: SshProfile[]) => {
    await setAppConfig({
      ...(await getAppConfig()),
      sshProfiles: next,
      sshCommandPath,
    });
  };

  const save = async () => {
    await persist(profiles);
    onClose();
  };

  const connect = async () => {
    if (!selected) return;
    setError(null);
    setConnecting(true);
    try {
      await persist(profiles);
      await sshTestConnection(selected, sshCommandPath);
      onConnect(selected);
    } catch (e) {
      setError(`${e}`);
    } finally {
      setConnecting(false);
    }
  };

  const pickIdentityFile = async () => {
    const picked = await open({ multiple: false, title: "Select private key file" });
    if (typeof picked === "string") updateSelected({ identityFile: picked });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[720px] h-[520px] flex flex-col rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-4 text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-medium mb-3">Open Remote Folder (SSH)</div>
        {!loaded ? (
          <div className="flex-1 flex items-center justify-center text-slate-400">Loading…</div>
        ) : (
          <div className="flex flex-1 min-h-0 gap-3">
            <div className="w-48 shrink-0 flex flex-col">
              <div className="flex-1 overflow-y-auto rounded border border-slate-200 dark:border-slate-800">
                {profiles.length === 0 && (
                  <div className="p-2 text-slate-400 italic">(no saved profiles)</div>
                )}
                {profiles.map((p, i) => (
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
                  onClick={addProfile}
                >
                  Add
                </button>
                <button
                  type="button"
                  className="flex-1 rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 py-1 disabled:opacity-40"
                  onClick={removeProfile}
                  disabled={selectedIndex < 0}
                >
                  Remove
                </button>
              </div>
            </div>

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
                  <div className="flex gap-2">
                    <Field label="Host (or ~/.ssh/config alias)" className="flex-1">
                      <input
                        className="input"
                        value={selected.host}
                        onChange={(e) => updateSelected({ host: e.target.value })}
                        placeholder="watcher-pi.tail6ca2de.ts.net"
                      />
                    </Field>
                    <Field label="Port" className="w-24">
                      <input
                        className="input"
                        type="number"
                        value={selected.port ?? ""}
                        onChange={(e) =>
                          updateSelected({
                            port: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                        placeholder="22"
                      />
                    </Field>
                  </div>
                  <Field label="User (blank = rely on ~/.ssh/config)">
                    <input
                      className="input"
                      value={selected.user ?? ""}
                      onChange={(e) => updateSelected({ user: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Identity file (blank = rely on ~/.ssh/config / agent)">
                    <div className="flex gap-1">
                      <input
                        className="input flex-1"
                        value={selected.identityFile ?? ""}
                        onChange={(e) => updateSelected({ identityFile: e.target.value || null })}
                        placeholder="~/.ssh/id_ed25519"
                      />
                      <button
                        type="button"
                        className="rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-2"
                        onClick={() => void pickIdentityFile()}
                      >
                        Browse…
                      </button>
                    </div>
                  </Field>
                  <Field label="Remote folder">
                    <input
                      className="input"
                      value={selected.remotePath}
                      onChange={(e) => updateSelected({ remotePath: e.target.value })}
                      placeholder="/home/pi/notes"
                    />
                  </Field>
                  {error && (
                    <div className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">
                      {error}
                    </div>
                  )}
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-400">
                  Add a profile to get started
                </div>
              )}
            </div>
          </div>
        )}

        <div className="pt-3">
          <Field label={'SSH command path (blank = "ssh" resolved from PATH)'}>
            <input
              className="input"
              value={sshCommandPath}
              onChange={(e) => setSshCommandPath(e.target.value)}
              placeholder="ssh"
            />
          </Field>
        </div>

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
            className="rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-3 py-1"
            onClick={() => void save()}
          >
            Save
          </button>
          <button
            type="button"
            className="rounded bg-blue-600 text-white hover:bg-blue-500 px-3 py-1 disabled:opacity-40"
            onClick={() => void connect()}
            disabled={!selected || connecting}
          >
            {connecting ? "Connecting…" : "Connect"}
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
