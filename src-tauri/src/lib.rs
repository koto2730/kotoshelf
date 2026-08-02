use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};

// ---------------------------------------------------------------------
// API presets & HTTP send (Phase 6)
// ---------------------------------------------------------------------

/// One saved HTTP preset (kotomemo's ApiPreset, ported). Templates
/// ({{selection}}, {{tokens.NAME}}, ...) are expanded on the frontend
/// before the request is sent - the Rust side never parses the template
/// syntax, it only fires the already-resolved request.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiPreset {
    name: String,
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body_template: String,
    #[serde(default)]
    response_json_path: Option<String>,
    #[serde(default)]
    response_target: String, // "newTab" | "afterSelection" | "statusOnly"
}

fn default_method() -> String {
    "POST".into()
}

/// One saved SSH remote-workspace target (Phase 8). `port`/`user`/
/// `identity_file` are optional so a bare profile can lean entirely on
/// the user's `~/.ssh/config` (Host alias, default user, IdentityFile)
/// - we only add `-p`/-`i`/user@ to the ssh invocation when they're set.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshProfile {
    name: String,
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    identity_file: Option<String>,
    remote_path: String,
}

/// App-wide config (NOT per-workspace): presets and secrets live in
/// ~/.kotoshelf/config.json rather than inside a workspace, so a token
/// never ends up accidentally committed if the workspace happens to be a
/// git repo.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppConfig {
    #[serde(default)]
    presets: Vec<ApiPreset>,
    #[serde(default)]
    tokens: HashMap<String, String>,
    #[serde(default)]
    ssh_profiles: Vec<SshProfile>,
    /// Path/name of the ssh executable to invoke. Empty means "ssh"
    /// resolved from PATH - overridable because a system can have more
    /// than one ssh.exe (Windows' bundled OpenSSH vs. Git for Windows'
    /// own build, say) and Tauri's process PATH may not resolve the one
    /// the user actually wants.
    #[serde(default)]
    ssh_command_path: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            presets: Vec::new(),
            tokens: HashMap::new(),
            ssh_profiles: Vec::new(),
            ssh_command_path: String::new(),
        }
    }
}

fn app_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".kotoshelf").join("config.json"))
}

/// Shared by the `get_app_config` command and `resolve_initial_target`
/// (which runs before the Tauri app - and therefore its command/IPC
/// system - exists, so it needs a plain function to call directly).
fn load_app_config() -> AppConfig {
    app_config_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_app_config() -> AppConfig {
    load_app_config()
}

#[tauri::command]
fn set_app_config(config: AppConfig) -> Result<(), String> {
    let path = app_config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write {path:?}: {e}"))
}

#[derive(serde::Deserialize)]
struct SendRequestInput {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    /// None for methods where a body doesn't apply (GET/DELETE with an
    /// empty template) - kept optional so we don't send an empty-string
    /// body where the server expects none at all.
    body: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SendRequestOutput {
    status: u16,
    body: String,
}

/// Fires an already-template-resolved HTTP request. Runs in Rust (not
/// the webview's fetch) so kotoshelf isn't subject to CSP/CORS - the
/// same reasoning kotomemo's JVM HttpClient had.
#[tauri::command]
fn send_request(input: SendRequestInput) -> Result<SendRequestOutput, String> {
    let client = reqwest::blocking::Client::new();
    let method = reqwest::Method::from_bytes(input.method.as_bytes())
        .map_err(|_| format!("Invalid HTTP method: {}", input.method))?;
    let mut builder = client.request(method, &input.url);
    for (name, value) in &input.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = input.body {
        builder = builder.body(body);
    }
    let response = builder
        .send()
        .map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read response body: {e}"))?;
    Ok(SendRequestOutput { status, body })
}

// ---------------------------------------------------------------------
// Custom themes (Phase 7)
// ---------------------------------------------------------------------

/// Where a theme's editor/syntax colors are read from disk. Rust only
/// reads and returns raw JSON here - it never validates or interprets
/// color values, that's the frontend's job (it knows what a CodeMirror
/// theme spec needs). Kept as serde_json::Value rather than a typed
/// struct so a hand-edited theme file with a missing/extra field never
/// fails to load; the frontend's theme resolver fills gaps from the
/// built-in light theme.
#[tauri::command]
fn list_custom_themes() -> Vec<String> {
    let Some(dir) = themes_dir() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                names.push(stem.to_string());
            }
        }
    }
    names.sort();
    names
}

#[tauri::command]
fn read_custom_theme(name: String) -> Result<serde_json::Value, String> {
    let dir = themes_dir().ok_or("Could not determine home directory")?;
    let path = dir.join(format!("{name}.json"));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path:?}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Invalid theme JSON: {e}"))
}

fn themes_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".kotoshelf").join("themes"))
}

fn theme_selection_path() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".kotoshelf").join("theme.json"))
}

/// "light" | "dark" | "system" | a custom theme's name. Stored
/// separately from Phase 6's app config.json (rather than folded into
/// it) so Phase 6/7 can land independently without one PR's schema
/// change breaking the other's file format.
#[tauri::command]
fn get_selected_theme() -> String {
    theme_selection_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("selected").and_then(|s| s.as_str()).map(String::from))
        .unwrap_or_else(|| "system".to_string())
}

#[tauri::command]
fn set_selected_theme(name: String) -> Result<(), String> {
    let path = theme_selection_path().ok_or("Could not determine home directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::json!({ "selected": name });
    std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap())
        .map_err(|e| format!("Failed to write {path:?}: {e}"))
}

/// One node of the workspace file tree. `children` is `Some` for
/// directories (possibly empty) and `None` for files, so the frontend can
/// distinguish "empty dir" from "file" without consulting `is_dir` twice.
/// `size` is 0 for directories - carried alongside the listing (rather
/// than fetched separately per file) so the frontend can flag large
/// files without a extra round trip per open, which matters most for
/// SSH workspaces where "a round trip" means a network hop.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<TreeNode>>,
    size: u64,
}

/// Directories that never belong in a notes workspace listing. Keeping
/// this list in the backend means every caller gets the same filtering.
const SKIP_DIRS: &[&str] = &[".git", ".kotoshelf", "node_modules", "target"];

/// Hard recursion limit as a guard against pathological or cyclic
/// (junction/symlink) directory structures.
const MAX_DEPTH: usize = 24;

fn build_tree(dir: &Path, depth: usize) -> Vec<TreeNode> {
    if depth >= MAX_DEPTH {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut nodes: Vec<TreeNode> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = path.is_dir();
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let children = if is_dir {
            Some(build_tree(&path, depth + 1))
        } else {
            None
        };
        let size = if is_dir {
            0
        } else {
            std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
        };
        nodes.push(TreeNode {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir,
            children,
            size,
        });
    }

    // Directories first, then files; alphabetical (case-insensitive)
    // within each group - the ordering users expect from VS Code.
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    nodes
}

#[tauri::command]
fn read_tree(root: String) -> Result<Vec<TreeNode>, String> {
    let path = Path::new(&root);
    if !path.is_dir() {
        return Err(format!("Not a directory: {root}"));
    }
    Ok(build_tree(path, 0))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Write binary content delivered as base64 (used for clipboard images -
/// pasting a screenshot sends the PNG bytes over IPC as a base64 string,
/// which stays comfortably within IPC limits for screenshot-sized data).
/// Parent directories are created as needed.
#[tauri::command]
fn write_base64_file(path: String, contents_base64: String) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64)
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Copy an existing file (e.g. an image dragged in from Explorer) into
/// `dest_dir/dest_name`, creating the directory as needed. Returns the
/// destination path.
#[tauri::command]
fn copy_into(src: String, dest_dir: String, dest_name: String) -> Result<String, String> {
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = Path::new(&dest_dir).join(&dest_name);
    std::fs::copy(&src, &dest).map_err(|e| format!("Failed to copy {src}: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create {path}: {e}"))
}

#[tauri::command]
fn rename_path(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("Already exists: {to}"));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("Rename failed: {e}"))
}

/// Move a file or directory to the OS trash / recycle bin. Deliberately
/// NOT a permanent delete - tree operations should always be recoverable.
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("Delete failed: {e}"))
}

// ---------------------------------------------------------------------
// Workspace-wide search & replace (Phase 4)
// ---------------------------------------------------------------------

/// User-editable search scope, persisted at `.kotoshelf/search.json`
/// inside the workspace. VS Code-style glob patterns (matched relative
/// to the workspace root), exclude-only - keeping this to one list
/// instead of separate include/exclude is enough for "don't search
/// *.txt" style requests without users needing to maintain an include
/// list that re-covers every extension they DO want.
#[derive(serde::Serialize, serde::Deserialize)]
struct SearchConfig {
    exclude: Vec<String>,
}

impl Default for SearchConfig {
    fn default() -> Self {
        SearchConfig {
            // Matches the previous hardcoded allow-list's *complement*:
            // by default we search everything except common binary /
            // build-artifact shapes, so unfamiliar text extensions (.rs,
            // .py, .log, ...) are searchable out of the box instead of
            // silently invisible the way an allow-list would make them.
            exclude: vec![
                "**/*.png".into(),
                "**/*.jpg".into(),
                "**/*.jpeg".into(),
                "**/*.gif".into(),
                "**/*.webp".into(),
                "**/*.svg".into(),
                "**/*.bmp".into(),
                "**/*.pdf".into(),
                "**/*.zip".into(),
                "**/*.exe".into(),
                "**/*.dll".into(),
            ],
        }
    }
}

fn search_config_path(root: &Path) -> PathBuf {
    root.join(".kotoshelf").join("search.json")
}

fn load_search_config(root: &Path) -> SearchConfig {
    let path = search_config_path(root);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_search_config(root: String) -> SearchConfig {
    load_search_config(Path::new(&root))
}

#[tauri::command]
fn set_search_config(root: String, config: SearchConfig) -> Result<(), String> {
    let path = search_config_path(Path::new(&root));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Failed to write {path:?}: {e}"))
}

fn build_exclude_matcher(patterns: &[String]) -> globset::GlobSet {
    let mut builder = globset::GlobSetBuilder::new();
    for p in patterns {
        if let Ok(glob) = globset::GlobBuilder::new(p).literal_separator(false).build() {
            builder.add(glob);
        }
        // Invalid pattern from a hand-edited config: skip it rather than
        // fail the whole search over one typo'd glob.
    }
    builder.build().unwrap_or_else(|_| globset::GlobSet::empty())
}

fn walk_searchable_files(
    dir: &Path,
    root: &Path,
    depth: usize,
    exclude: &globset::GlobSet,
    out: &mut Vec<PathBuf>,
) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel = path.strip_prefix(root).unwrap_or(&path);
        if exclude.is_match(rel) {
            continue;
        }
        if path.is_dir() {
            if !SKIP_DIRS.contains(&name.as_str()) {
                walk_searchable_files(&path, root, depth + 1, exclude, out);
            }
        } else {
            out.push(path);
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    line: usize,   // 1-based, matches editor line numbers
    col: usize,    // 0-based char offset into the line
    len: usize,    // match length in chars
    preview: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSearchResult {
    path: String,
    matches: Vec<SearchMatch>,
}

fn build_regex(query: &str, is_regex: bool, case_sensitive: bool) -> Result<regex::Regex, String> {
    let pattern = if is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid pattern: {e}"))
}

/// Hard cap on matches returned so a query like "e" over a large
/// workspace can't produce an unbounded response.
const MAX_TOTAL_MATCHES: usize = 2000;

#[tauri::command]
fn search_workspace(
    root: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<Vec<FileSearchResult>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let re = build_regex(&query, is_regex, case_sensitive)?;

    let root_path = Path::new(&root);
    let config = load_search_config(root_path);
    let exclude = build_exclude_matcher(&config.exclude);
    let mut files = Vec::new();
    walk_searchable_files(root_path, root_path, 0, &exclude, &mut files);

    let mut results = Vec::new();
    let mut total = 0usize;
    'files: for path in files {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue; // binary or unreadable - skip rather than fail the whole search
        };
        let mut matches = Vec::new();
        for (line_no, line) in content.lines().enumerate() {
            for m in re.find_iter(line) {
                let col = line[..m.start()].chars().count();
                let len = line[m.start()..m.end()].chars().count();
                matches.push(SearchMatch {
                    line: line_no + 1,
                    col,
                    len,
                    preview: line.trim().chars().take(200).collect(),
                });
                total += 1;
                if total >= MAX_TOTAL_MATCHES {
                    if !matches.is_empty() {
                        results.push(FileSearchResult {
                            path: path.to_string_lossy().into_owned(),
                            matches,
                        });
                    }
                    break 'files;
                }
            }
        }
        if !matches.is_empty() {
            results.push(FileSearchResult {
                path: path.to_string_lossy().into_owned(),
                matches,
            });
        }
    }
    Ok(results)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceResult {
    path: String,
    count: usize,
}

/// Replace every match of `query` with `replacement` in each of `paths`.
/// Files with zero matches are left untouched (and omitted from the
/// result) so the caller can tell which files actually changed.
#[tauri::command]
fn replace_in_files(
    paths: Vec<String>,
    query: String,
    replacement: String,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<Vec<ReplaceResult>, String> {
    let re = build_regex(&query, is_regex, case_sensitive)?;
    let mut results = Vec::new();
    for path in paths {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let count = re.find_iter(&content).count();
        if count == 0 {
            continue;
        }
        let replaced = re.replace_all(&content, replacement.as_str());
        std::fs::write(&path, replaced.as_bytes())
            .map_err(|e| format!("Failed to write {path}: {e}"))?;
        results.push(ReplaceResult { path, count });
    }
    Ok(results)
}

// ---------------------------------------------------------------------
// Remote workspaces over SSH (Phase 8)
// ---------------------------------------------------------------------
//
// Deliberately shells out to the system `ssh` binary rather than
// embedding an SSH library: it reuses whatever the user already has
// configured in ~/.ssh/config (Host aliases, keys, ProxyJump, agent
// forwarding) instead of reimplementing auth/host-key handling. The
// tradeoff is one process spawn per file op, which is fine for an
// editor (occasional reads/writes) but would be too slow for e.g. a
// live file-watcher.

/// Directories skipped when walking a remote workspace, mirroring the
/// local SKIP_DIRS list (kept separate so the two lists can diverge if a
/// remote-only exclusion is ever needed).
const SSH_SKIP_DIRS: &[&str] = &[".git", ".kotoshelf", "node_modules", "target"];

/// Wraps `s` in single quotes for a POSIX remote shell, escaping any
/// embedded single quotes via the standard `'\''` trick (close the
/// quoted string, emit an escaped quote, reopen).
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Guards every remote path that's supposed to be workspace-relative.
///
/// Without this, a caller that mistakenly passes an absolute path still
/// "works": it gets concatenated onto the remote root, and `mkdir -p`
/// silently materialises the entire bogus chain (this actually happened -
/// a New Folder with an absolute target created a
/// `Volumes/SSD/workspace/...` tree *inside* the workspace, which then
/// showed up as real entries on the next listing). Failing loudly here
/// turns that class of bug into an immediate, obvious error instead of
/// silent filesystem damage, and also stops `..` from escaping the
/// workspace root.
fn validate_rel_path(rel: &str) -> Result<(), String> {
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err(format!(
            "Expected a path relative to the remote workspace, got an absolute path: {rel}"
        ));
    }
    // A Windows-style "C:\..." local path reaching a remote command is
    // the same category of mistake, and doesn't start with a slash.
    let first = rel.split(['/', '\\']).next().unwrap_or("");
    if first.len() == 2 && first.ends_with(':') {
        return Err(format!(
            "Expected a path relative to the remote workspace, got a local path: {rel}"
        ));
    }
    if rel.split('/').any(|seg| seg == "..") {
        return Err(format!("Path escapes the remote workspace: {rel}"));
    }
    Ok(())
}

fn ssh_target(profile: &SshProfile) -> String {
    match &profile.user {
        Some(u) if !u.is_empty() => format!("{u}@{}", profile.host),
        _ => profile.host.clone(),
    }
}

/// A stable path (per host/port/user) for this connection's ControlMaster
/// socket, computed ourselves rather than left to ssh's `%C` token - a
/// token we can't reverse, so we couldn't delete a stale/corrupted socket
/// file if we don't know its name. Repeated ssh invocations to the same
/// host reuse one already-authenticated connection instead of paying a
/// fresh handshake every time; without this, every tree refresh / file
/// open / save is a brand-new TCP+auth round trip - the dominant cost
/// that makes the editor feel a beat behind something like VS Code
/// Remote-SSH, which keeps one connection open throughout.
/// `None` (home dir unavailable) just means we skip multiplexing for
/// this call - a slower connection, not a broken one.
fn ssh_control_path(profile: &SshProfile) -> Option<PathBuf> {
    use std::hash::{Hash, Hasher};
    let dir = dirs::home_dir()?.join(".kotoshelf").join("ssh-sockets");
    std::fs::create_dir_all(&dir).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    profile.host.hash(&mut hasher);
    profile.port.hash(&mut hasher);
    profile.user.hash(&mut hasher);
    Some(dir.join(format!("{:x}", hasher.finish())))
}

/// The `-o ...`/`-p`/`-i` flags shared by every ssh invocation - shaped
/// as a flat arg list (rather than a `Command`) so both a spawned
/// `Command` (`ssh_base_command`) and an argument list embedded inside a
/// *different* spawned program (`ssh_open_terminal`, which hands these
/// off to wt.exe/Terminal.app/etc.) can reuse the exact same options.
/// `multiplex = false` builds a plain, single-use connection - used as
/// the fallback when a multiplexed attempt fails, in case the failure
/// was a stale ControlMaster socket (e.g. left behind after the remote
/// host was rebooted mid-session) rather than a real connection problem.
fn ssh_common_args(profile: &SshProfile, multiplex: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ConnectTimeout=10".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
    ];
    if multiplex {
        if let Some(control_path) = ssh_control_path(profile) {
            args.push("-o".into());
            args.push("ControlMaster=auto".into());
            args.push("-o".into());
            args.push(format!("ControlPath={}", control_path.to_string_lossy()));
            args.push("-o".into());
            args.push("ControlPersist=600".into());
        }
    }
    if let Some(port) = profile.port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    if let Some(idf) = &profile.identity_file {
        if !idf.is_empty() {
            args.push("-i".into());
            args.push(idf.clone());
        }
    }
    args
}

/// Builds the `ssh` invocation shared by every remote command:
/// non-interactive (fails fast instead of hanging on a password/host-key
/// prompt we have no UI for), a short connect timeout, auto-trusting
/// *new* host keys while still refusing a *changed* one (so first
/// connection to a fresh host doesn't require a terminal prompt, but a
/// potential MITM against an already-known host still gets blocked), and
/// (when `multiplex`) connection reuse so only the first call per host
/// pays the full handshake cost.
fn ssh_base_command(ssh_command_path: &str, profile: &SshProfile, multiplex: bool) -> Command {
    let bin = if ssh_command_path.trim().is_empty() {
        "ssh"
    } else {
        ssh_command_path
    };
    let mut cmd = Command::new(bin);
    cmd.args(ssh_common_args(profile, multiplex));
    cmd.arg(ssh_target(profile));
    cmd
}

fn run_ssh_capture_attempt(
    ssh_command_path: &str,
    profile: &SshProfile,
    remote_script: &str,
    multiplex: bool,
) -> Result<String, String> {
    let output = ssh_base_command(ssh_command_path, profile, multiplex)
        .arg(remote_script)
        .output()
        .map_err(|e| format!("Failed to run ssh: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh failed ({}): {}", output.status, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// On failure, retries once over a fresh, non-multiplexed connection
/// after clearing this profile's ControlMaster socket - covers a stale
/// or corrupted socket file (e.g. the remote host rebooted mid-session)
/// so the app self-heals instead of failing every call until the user
/// manually deletes `~/.kotoshelf/ssh-sockets/`. If the retry also
/// fails, that failure (not the first one) is what's reported - it
/// reflects the actual connection, without multiplexing noise.
fn run_ssh_capture(
    ssh_command_path: &str,
    profile: &SshProfile,
    remote_script: &str,
) -> Result<String, String> {
    match run_ssh_capture_attempt(ssh_command_path, profile, remote_script, true) {
        Ok(out) => Ok(out),
        Err(_) => {
            if let Some(path) = ssh_control_path(profile) {
                let _ = std::fs::remove_file(&path);
            }
            run_ssh_capture_attempt(ssh_command_path, profile, remote_script, false)
        }
    }
}

/// Same as run_ssh_capture_attempt but keeps raw bytes rather than
/// lossily re-encoding through UTF-8 - `run_ssh_capture`'s
/// `String::from_utf8_lossy` would corrupt binary content (an image's
/// bytes), replacing anything not valid UTF-8 with U+FFFD.
fn run_ssh_capture_bytes_attempt(
    ssh_command_path: &str,
    profile: &SshProfile,
    remote_script: &str,
    multiplex: bool,
) -> Result<Vec<u8>, String> {
    let output = ssh_base_command(ssh_command_path, profile, multiplex)
        .arg(remote_script)
        .output()
        .map_err(|e| format!("Failed to run ssh: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh failed ({}): {}", output.status, stderr.trim()));
    }
    Ok(output.stdout)
}

/// Binary-safe counterpart to run_ssh_capture, with the same stale-socket
/// self-healing retry.
fn run_ssh_capture_bytes(
    ssh_command_path: &str,
    profile: &SshProfile,
    remote_script: &str,
) -> Result<Vec<u8>, String> {
    match run_ssh_capture_bytes_attempt(ssh_command_path, profile, remote_script, true) {
        Ok(out) => Ok(out),
        Err(_) => {
            if let Some(path) = ssh_control_path(profile) {
                let _ = std::fs::remove_file(&path);
            }
            run_ssh_capture_bytes_attempt(ssh_command_path, profile, remote_script, false)
        }
    }
}

fn run_ssh_with_stdin_attempt(
    ssh_command_path: &str,
    profile: &SshProfile,
    remote_script: &str,
    input: &[u8],
    multiplex: bool,
) -> Result<(), String> {
    use std::io::Write;
    let mut child = ssh_base_command(ssh_command_path, profile, multiplex)
        .arg(remote_script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run ssh: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("Failed to open ssh stdin")?
        .write_all(input)
        .map_err(|e| format!("Failed to write to ssh stdin: {e}"))?;
    let output = child
        .wait_with_output()
        .map_err(|e| format!("ssh failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh failed ({}): {}", output.status, stderr.trim()));
    }
    Ok(())
}

/// Same stale-socket self-healing as `run_ssh_capture` (see its doc
/// comment) applied to the stdin-piping path used by writes.
fn run_ssh_with_stdin(
    ssh_command_path: &str,
    profile: &SshProfile,
    remote_script: &str,
    input: &[u8],
) -> Result<(), String> {
    match run_ssh_with_stdin_attempt(ssh_command_path, profile, remote_script, input, true) {
        Ok(()) => Ok(()),
        Err(_) => {
            if let Some(path) = ssh_control_path(profile) {
                let _ = std::fs::remove_file(&path);
            }
            run_ssh_with_stdin_attempt(ssh_command_path, profile, remote_script, input, false)
        }
    }
}

/// One entry of the flat "D\t0\tpath" / "F\tsize\tpath" listing
/// `ssh_read_tree`'s remote script prints, folded into a directory tree.
#[derive(Default)]
struct SshDirBuilder {
    children: std::collections::BTreeMap<String, SshEntry>,
}

enum SshEntry {
    Dir(SshDirBuilder),
    File { size: u64 },
}

/// Inserts one flat entry into the tree being built, creating
/// intermediate directory nodes on demand - this doesn't depend on
/// parents being listed before children, since `find`'s traversal order
/// isn't guaranteed identical across GNU/BSD/busybox implementations.
fn ssh_insert_path(root: &mut SshDirBuilder, parts: &[&str], is_dir: bool, size: u64) {
    let Some((head, rest)) = parts.split_first() else {
        return;
    };
    if rest.is_empty() {
        if is_dir {
            root.children
                .entry((*head).to_string())
                .or_insert_with(|| SshEntry::Dir(SshDirBuilder::default()));
        } else {
            root.children
                .insert((*head).to_string(), SshEntry::File { size });
        }
        return;
    }
    let entry = root
        .children
        .entry((*head).to_string())
        .or_insert_with(|| SshEntry::Dir(SshDirBuilder::default()));
    if let SshEntry::Dir(sub) = entry {
        ssh_insert_path(sub, rest, is_dir, size);
    }
    // else: a file was listed as an ancestor of another path - malformed
    // remote output, ignore rather than panic.
}

fn ssh_tree_nodes(dir: &SshDirBuilder, prefix: &str) -> Vec<TreeNode> {
    let mut nodes: Vec<TreeNode> = dir
        .children
        .iter()
        .map(|(name, entry)| {
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            match entry {
                SshEntry::Dir(sub) => TreeNode {
                    name: name.clone(),
                    children: Some(ssh_tree_nodes(sub, &path)),
                    path,
                    is_dir: true,
                    size: 0,
                },
                SshEntry::File { size } => TreeNode {
                    name: name.clone(),
                    path,
                    is_dir: false,
                    children: None,
                    size: *size,
                },
            }
        })
        .collect();
    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    nodes
}

/// Parses tab-separated "D\t0\tpath" / "F\tsize\tpath" lines. Tab (not
/// space) delimited, and split with an explicit field count, so a
/// filename containing spaces is never mistaken for a field boundary.
fn parse_ssh_tree(raw: &str) -> Vec<TreeNode> {
    let mut root = SshDirBuilder::default();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        let mut fields = line.splitn(3, '\t');
        let (Some(marker), Some(size_str), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        if path.is_empty() {
            continue;
        }
        // BSD/macOS `wc -c` can pad its count with leading whitespace
        // (GNU coreutils doesn't) - trim before parsing so the field
        // isn't silently read as 0 on those hosts.
        let size = size_str.trim().parse::<u64>().unwrap_or(0);
        let parts: Vec<&str> = path.split('/').collect();
        ssh_insert_path(&mut root, &parts, marker == "D", size);
    }
    ssh_tree_nodes(&root, "")
}

/// Builds the `find`-based prune expression used to skip SSH_SKIP_DIRS
/// while walking the remote tree, e.g. `-name '.git' -o -name '.kotoshelf' -o ...`.
fn ssh_prune_expr() -> String {
    SSH_SKIP_DIRS
        .iter()
        .map(|d| format!("-name {}", shell_quote(d)))
        .collect::<Vec<_>>()
        .join(" -o ")
}

/// One `find` pass over the whole tree (dirs and files together, via the
/// standard `-prune -o -print` idiom), then a per-entry shell loop that
/// tags each as D(irectory) or F(ile) and - for files - sizes it from
/// filesystem metadata: `stat -c%s` (GNU) falling back to `stat -f%z`
/// (BSD/macOS), whichever the remote's `stat` understands. Deliberately
/// NOT `wc -c`: that counts bytes by actually reading the whole file,
/// so sizing a multi-GB video this way means downloading the entire
/// thing just to answer "how big is this?" - which hung real workspaces
/// containing large files, defeating the exact large-file check this
/// size is used for. `stat` reads size from the inode, so it's instant
/// regardless of file size.
///
/// Built via string pushes rather than `format!`, since the shell syntax
/// here (`${...}`, `$(...)`) is all brace-heavy and would otherwise have
/// to fight Rust's own `{}` escaping at every turn.
fn ssh_read_tree_script(remote_path: &str) -> String {
    let prune = ssh_prune_expr();
    let mut s = String::new();
    s.push_str("cd ");
    s.push_str(&shell_quote(remote_path));
    s.push_str(" && find . -mindepth 1 \\( ");
    s.push_str(&prune);
    s.push_str(" \\) -prune -o -print | while IFS= read -r p; do ");
    s.push_str("rel=${p#./}; ");
    s.push_str("if [ -d \"$p\" ]; then printf 'D\\t0\\t%s\\n' \"$rel\"; ");
    // If BOTH stat dialects fail, report u64::MAX rather than 0. This
    // is a safety threshold, not just a display number: failing toward
    // "treat as unknown/huge" means an unstat-able entry still gets
    // blocked from opening; failing toward "assume 0 bytes" (what this
    // used to do) silently cached a wrong tiny size and let a genuinely
    // huge file open uninterrupted - the exact freeze this size exists
    // to prevent.
    s.push_str(
        "else printf 'F\\t%s\\t%s\\n' \"$(stat -c%s \"$p\" 2>/dev/null || stat -f%z \"$p\" 2>/dev/null || echo 18446744073709551615)\" \"$rel\"; fi; ",
    );
    s.push_str("done");
    s
}

#[tauri::command]
fn ssh_read_tree(profile: SshProfile, ssh_command_path: String) -> Result<Vec<TreeNode>, String> {
    let script = ssh_read_tree_script(&profile.remote_path);
    let out = run_ssh_capture(&ssh_command_path, &profile, &script)?;
    Ok(parse_ssh_tree(&out))
}

#[tauri::command]
fn ssh_read_file(
    profile: SshProfile,
    ssh_command_path: String,
    rel_path: String,
) -> Result<String, String> {
    validate_rel_path(&rel_path)?;
    let full = format!("{}/{rel_path}", profile.remote_path.trim_end_matches('/'));
    let script = format!("cat -- {}", shell_quote(&full));
    run_ssh_capture(&ssh_command_path, &profile, &script)
}

/// Binary-safe read for preview images: `ssh_read_file` decodes stdout
/// as UTF-8 (lossy), which corrupts arbitrary image bytes. Returns
/// base64 rather than raw bytes since that's what crosses the Tauri IPC
/// boundary cleanly (mirrors ssh_write_base64_file's direction). The
/// caller is expected to size-check first (e.g. against the tree's
/// cached size) - this command doesn't refuse a large file itself.
#[tauri::command]
fn ssh_read_file_base64(
    profile: SshProfile,
    ssh_command_path: String,
    rel_path: String,
) -> Result<String, String> {
    validate_rel_path(&rel_path)?;
    let full = format!("{}/{rel_path}", profile.remote_path.trim_end_matches('/'));
    let script = format!("cat -- {}", shell_quote(&full));
    let bytes = run_ssh_capture_bytes(&ssh_command_path, &profile, &script)?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Byte size of a remote file, checked before `ssh_read_file` so the
/// frontend can warn/refuse before pulling a multi-GB video (say) over
/// the wire into a text editor buffer. Reads size from filesystem
/// metadata (`stat -c%s`, falling back to BSD/macOS's `stat -f%z`) -
/// NOT `wc -c`, which was tried here first and is wrong for this job:
/// it counts bytes by reading the whole file, so "how big is this
/// file" ends up reading the entire multi-GB file to find out, which
/// hung on exactly the large files this check exists to catch.
#[tauri::command]
fn ssh_stat_size(
    profile: SshProfile,
    ssh_command_path: String,
    rel_path: String,
) -> Result<u64, String> {
    validate_rel_path(&rel_path)?;
    let full = format!("{}/{rel_path}", profile.remote_path.trim_end_matches('/'));
    let full_q = shell_quote(&full);
    let script = format!("stat -c%s {full_q} 2>/dev/null || stat -f%z {full_q} 2>/dev/null");
    let out = run_ssh_capture(&ssh_command_path, &profile, &script)?;
    out.trim()
        .parse::<u64>()
        .map_err(|e| format!("Could not parse remote file size ({e}): {out:?}"))
}

#[tauri::command]
fn ssh_write_file(
    profile: SshProfile,
    ssh_command_path: String,
    rel_path: String,
    content: String,
) -> Result<(), String> {
    validate_rel_path(&rel_path)?;
    let full = format!("{}/{rel_path}", profile.remote_path.trim_end_matches('/'));
    let script = format!("cat > {}", shell_quote(&full));
    run_ssh_with_stdin(&ssh_command_path, &profile, &script, content.as_bytes())
}

/// Write binary content delivered as base64 (clipboard image paste /
/// dropped-file attach), mirroring the local write_base64_file. Decoded
/// locally, then piped over ssh's stdin as raw bytes rather than
/// base64-in-a-shell-string, which would need extra remote-side
/// decoding and its own escaping concerns.
#[tauri::command]
fn ssh_write_base64_file(
    profile: SshProfile,
    ssh_command_path: String,
    rel_path: String,
    contents_base64: String,
) -> Result<(), String> {
    validate_rel_path(&rel_path)?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64)
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    let full = format!("{}/{rel_path}", profile.remote_path.trim_end_matches('/'));
    let mut script = String::new();
    if let Some((parent, _)) = full.rsplit_once('/') {
        script.push_str("mkdir -p ");
        script.push_str(&shell_quote(parent));
        script.push_str(" && ");
    }
    script.push_str("cat > ");
    script.push_str(&shell_quote(&full));
    run_ssh_with_stdin(&ssh_command_path, &profile, &script, &bytes)
}

/// Uploads an existing *local* file (e.g. an image dragged in from
/// Explorer) to `rel_path` inside the remote workspace. The remote
/// counterpart of copy_into: same "attach a file that already exists on
/// disk" flow, except the destination is across the wire.
#[tauri::command]
fn ssh_upload_file(
    profile: SshProfile,
    ssh_command_path: String,
    local_path: String,
    rel_path: String,
) -> Result<(), String> {
    validate_rel_path(&rel_path)?;
    let bytes = std::fs::read(&local_path)
        .map_err(|e| format!("Failed to read {local_path}: {e}"))?;
    let full = format!("{}/{rel_path}", profile.remote_path.trim_end_matches('/'));
    let mut script = String::new();
    if let Some((parent, _)) = full.rsplit_once('/') {
        script.push_str("mkdir -p ");
        script.push_str(&shell_quote(parent));
        script.push_str(" && ");
    }
    script.push_str("cat > ");
    script.push_str(&shell_quote(&full));
    run_ssh_with_stdin(&ssh_command_path, &profile, &script, &bytes)
}

#[tauri::command]
fn ssh_create_dir(
    profile: SshProfile,
    ssh_command_path: String,
    rel_path: String,
) -> Result<(), String> {
    validate_rel_path(&rel_path)?;
    let full = format!("{}/{rel_path}", profile.remote_path.trim_end_matches('/'));
    let script = format!("mkdir -p -- {}", shell_quote(&full));
    run_ssh_capture(&ssh_command_path, &profile, &script).map(|_| ())
}

#[tauri::command]
fn ssh_rename_path(
    profile: SshProfile,
    ssh_command_path: String,
    from_rel: String,
    to_rel: String,
) -> Result<(), String> {
    validate_rel_path(&from_rel)?;
    validate_rel_path(&to_rel)?;
    let root = profile.remote_path.trim_end_matches('/');
    let from = format!("{root}/{from_rel}");
    let to = format!("{root}/{to_rel}");
    // Guard against clobbering an existing target, matching the local
    // rename_path's "Already exists" check.
    let script = format!(
        "if [ -e {} ]; then echo __EXISTS__; else mv -- {} {}; fi",
        shell_quote(&to),
        shell_quote(&from),
        shell_quote(&to),
    );
    let out = run_ssh_capture(&ssh_command_path, &profile, &script)?;
    if out.trim() == "__EXISTS__" {
        return Err(format!("Already exists: {to_rel}"));
    }
    Ok(())
}

/// Moves a file or directory into `.kotoshelf/.trash/` inside the remote
/// workspace, timestamped to avoid colliding with a previous delete of
/// the same name. Remote equivalent of the local trash_path: there's no
/// OS trash / recycle bin to move into on an arbitrary remote host, but
/// tree operations should still always be recoverable rather than a
/// silent permanent delete.
#[tauri::command]
fn ssh_trash_path(
    profile: SshProfile,
    ssh_command_path: String,
    rel_path: String,
) -> Result<(), String> {
    validate_rel_path(&rel_path)?;
    let root = profile.remote_path.trim_end_matches('/');
    let full = format!("{root}/{rel_path}");
    let trash_dir = format!("{root}/.kotoshelf/.trash");
    let name = rel_path.rsplit('/').next().unwrap_or(&rel_path);

    let mut script = String::new();
    script.push_str("mkdir -p ");
    script.push_str(&shell_quote(&trash_dir));
    script.push_str(" && ts=$(date +%s) && mv -- ");
    script.push_str(&shell_quote(&full));
    script.push(' ');
    script.push_str(&shell_quote(&trash_dir));
    script.push_str("/\"$ts-\"");
    script.push_str(&shell_quote(name));

    run_ssh_capture(&ssh_command_path, &profile, &script).map(|_| ())
}

/// Round-trips `cd <remote_path> && pwd` so "Connect" can surface an
/// auth/host/path failure immediately instead of only on first file op.
#[tauri::command]
fn ssh_test_connection(profile: SshProfile, ssh_command_path: String) -> Result<String, String> {
    let script = format!("cd {} && pwd", shell_quote(&profile.remote_path));
    run_ssh_capture(&ssh_command_path, &profile, &script).map(|s| s.trim().to_string())
}

/// Opens an interactive terminal already `cd`'d into the remote
/// workspace folder over SSH. Best-effort per platform: Windows Terminal
/// (falling back to a plain console) is exercised in development; the
/// macOS/Linux branches follow the same shape but are unverified here.
///
/// Deliberately NOT multiplexed (`ssh_common_args(&profile, false)`):
/// `-t` (pty allocation) combined with `ControlMaster=auto` (becoming
/// the connection's master) is a known-flaky combination on at least
/// some Windows ssh builds - it failed with "getsockname failed: Not a
/// socket" even with no stale socket involved, unlike the plain
/// output-capturing calls elsewhere, where multiplexing works fine. A
/// terminal is opened rarely enough that paying a full handshake each
/// time isn't worth that risk.
#[tauri::command]
fn ssh_open_terminal(profile: SshProfile, ssh_command_path: String) -> Result<(), String> {
    let bin = if ssh_command_path.trim().is_empty() {
        "ssh".to_string()
    } else {
        ssh_command_path.clone()
    };

    let mut ssh_args: Vec<String> = vec!["-t".into()];
    ssh_args.extend(ssh_common_args(&profile, false));
    ssh_args.push(ssh_target(&profile));
    // Setting $TERM on our own spawned wt.exe/cmd process (below) isn't
    // reliable: if a Windows Terminal window is already open, wt.exe
    // hands the new tab off to that *existing* window's process, whose
    // environment is whatever it was when that window first launched -
    // our env() never reaches the actual ssh child. Exporting TERM as
    // part of the remote command itself sidesteps that entirely: it's
    // set in the remote shell regardless of what the local ssh process's
    // own environment looked like. Without a real TERM, remote
    // capability-detecting tools (ls, git, a colored prompt) see
    // TERM unset/empty and silently skip color output.
    ssh_args.push(format!(
        "export TERM=xterm-256color; cd {} && exec \"${{SHELL:-/bin/sh}}\" -l",
        shell_quote(&profile.remote_path)
    ));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Windows API constant (winbase.h) - CreateProcess allocates a
        // new console window for the child instead of inheriting ours.
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

        // Not routed through wt.exe: `Command::new("wt.exe").spawn()`
        // reports success as soon as the (thin, COM-relaying) wt.exe
        // process itself starts, regardless of whether Windows Terminal
        // actually manages to launch the given command line in the new
        // tab - so a failure there (confirmed in testing: the same "file
        // not found" error persisted across multiple attempted fixes to
        // a fallback path that, per this, was never actually being
        // reached) is invisible to us and impossible to fall back from.
        // Spawning ssh directly - no wt.exe, no cmd.exe - removes that
        // whole layer of re-parsing/hand-off uncertainty: Rust's Command
        // passes args through standard Win32 argv escaping directly to
        // CreateProcess, nothing re-interprets them in between.
        Command::new(&bin)
            .args(&ssh_args)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|e| format!("Failed to open a terminal: {e}"))?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        let full_cmd = std::iter::once(bin.clone())
            .chain(ssh_args.iter().cloned())
            .map(|a| shell_quote(&a))
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            "tell application \"Terminal\" to do script \"{}\"",
            full_cmd.replace('\\', "\\\\").replace('"', "\\\"")
        );
        Command::new("osascript")
            .arg("-e")
            .arg(script)
            .spawn()
            .map_err(|e| format!("Failed to open Terminal.app: {e}"))?;
        Ok(())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Try common terminal emulators in order; first one that spawns
        // successfully wins. No single binary is guaranteed present
        // across distros the way Terminal.app/wt.exe are on their OSes.
        let candidates: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["-e"]),
            ("gnome-terminal", &["--"]),
            ("konsole", &["-e"]),
            ("xterm", &["-e"]),
        ];
        for (term, prefix_args) in candidates {
            let mut cmd = Command::new(term);
            cmd.args(*prefix_args).arg(&bin).args(&ssh_args);
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }
        Err("No supported terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)".into())
    }
}

/// What `kotoshelf <arg>` on the command line should do, resolved once at
/// startup from `std::env::args()`. Relative paths (including `.`) are
/// resolved against the shell's cwd, not the app's install directory -
/// otherwise `kotoshelf .` would mean something different depending on
/// where the binary happens to live.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum InitialTarget {
    /// Open this directory as the workspace.
    Workspace { path: String },
    /// Open this file as a tab, and its parent directory as the
    /// workspace (so the tree is populated - a bare "open one file"
    /// with no tree would be a degraded experience here since the tree
    /// is central to the app, unlike a single-file-focused editor).
    File { path: String, workspace: String },
    /// Open this saved SSH profile directly - the `kotoshelf --ssh
    /// <name>` CLI equivalent of picking it in "Open Remote Folder
    /// (SSH)..." and hitting Connect.
    SshProfile { profile: SshProfile },
}

fn resolve_initial_target() -> Option<InitialTarget> {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // `kotoshelf --ssh <profile-name>` - looked up in the same
    // ~/.kotoshelf/config.json saved profiles the "Open Remote Folder
    // (SSH)..." dialog manages, by name. Checked before the generic
    // positional-arg scan below so `--ssh` itself (which starts with
    // '-') doesn't fall through to being skipped as "looks like a flag".
    if let Some(idx) = args.iter().position(|a| a == "--ssh") {
        let name = args.get(idx + 1)?;
        let profile = load_app_config()
            .ssh_profiles
            .into_iter()
            .find(|p| &p.name == name)?;
        return Some(InitialTarget::SshProfile { profile });
    }

    // First positional argument after the executable, skipping anything
    // that looks like a flag - Tauri/webview may inject its own args in
    // dev mode (e.g. --no-sandbox on some platforms).
    let arg = args.into_iter().find(|a| !a.starts_with('-'))?;
    let cwd = std::env::current_dir().ok()?;
    let resolved = cwd.join(&arg);
    let canonical = resolved.canonicalize().unwrap_or(resolved);
    if canonical.is_dir() {
        Some(InitialTarget::Workspace {
            path: canonical.to_string_lossy().into_owned(),
        })
    } else if canonical.is_file() {
        let workspace = canonical.parent()?.to_string_lossy().into_owned();
        Some(InitialTarget::File {
            path: canonical.to_string_lossy().into_owned(),
            workspace,
        })
    } else {
        None // arg didn't resolve to anything on disk - ignore rather than error
    }
}

/// Frontend calls this once on mount to pick up `kotoshelf <path>` /
/// `kotoshelf .` from the command line.
#[tauri::command]
fn get_initial_target(state: tauri::State<InitialTargetState>) -> Option<InitialTarget> {
    state.0.clone()
}

struct InitialTargetState(Option<InitialTarget>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_target = resolve_initial_target();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(InitialTargetState(initial_target))
        .invoke_handler(tauri::generate_handler![
            read_tree,
            read_file,
            write_file,
            write_base64_file,
            copy_into,
            create_dir,
            rename_path,
            trash_path,
            search_workspace,
            replace_in_files,
            get_search_config,
            set_search_config,
            get_initial_target,
            get_app_config,
            set_app_config,
            send_request,
            list_custom_themes,
            read_custom_theme,
            get_selected_theme,
            set_selected_theme,
            ssh_read_tree,
            ssh_read_file,
            ssh_read_file_base64,
            ssh_write_file,
            ssh_write_base64_file,
            ssh_upload_file,
            ssh_create_dir,
            ssh_rename_path,
            ssh_trash_path,
            ssh_stat_size,
            ssh_test_connection,
            ssh_open_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_accepts_ordinary_workspace_paths() {
        assert!(validate_rel_path("notes.md").is_ok());
        assert!(validate_rel_path("sub/dir/notes.md").is_ok());
        assert!(validate_rel_path("attachments/img-20260101-000000.png").is_ok());
        // "" is the workspace root itself - a valid target for e.g. a
        // new file created from the tree's background context menu.
        assert!(validate_rel_path("").is_ok());
        // ".." only as a *segment* is an escape; as a substring of a
        // name it's a legitimate filename.
        assert!(validate_rel_path("my..notes.md").is_ok());
    }

    #[test]
    fn rel_path_rejects_absolute_and_escaping_paths() {
        // The regression this guard exists for: an absolute path reached
        // ssh_create_dir, got concatenated onto the remote root, and
        // `mkdir -p` silently built the whole bogus chain inside the
        // workspace instead of failing.
        assert!(validate_rel_path("/Volumes/SSD/workspace/Base/notes").is_err());
        assert!(validate_rel_path("C:\\Users\\me\\notes.md").is_err());
        assert!(validate_rel_path("..").is_err());
        assert!(validate_rel_path("../outside.md").is_err());
        assert!(validate_rel_path("sub/../../outside.md").is_err());
    }

    #[test]
    fn ssh_tree_parses_sizes_and_nests_by_path() {
        let raw = "F\t12\troot.md\nD\t0\tsub\nF\t34\tsub/nested.md\n";
        let nodes = parse_ssh_tree(raw);
        // Directories sort before files.
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].name, "sub");
        assert!(nodes[0].is_dir);
        assert_eq!(nodes[1].name, "root.md");
        assert_eq!(nodes[1].size, 12);

        let children = nodes[0].children.as_ref().expect("dir has children");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].path, "sub/nested.md");
        assert_eq!(children[0].size, 34);
    }

    #[test]
    fn ssh_tree_tolerates_spaces_and_bsd_padded_sizes() {
        // Tab-delimited with a bounded split, so spaces in a filename
        // are never read as a field boundary; BSD/macOS `wc -c` pads its
        // count with leading spaces, which must still parse.
        let raw = "F\t  56\tmy notes with spaces.md\n";
        let nodes = parse_ssh_tree(raw);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "my notes with spaces.md");
        assert_eq!(nodes[0].size, 56);
    }

    #[test]
    fn ssh_tree_treats_unstatable_files_as_huge_not_tiny() {
        // The remote script's fallback when both `stat` dialects fail is
        // u64::MAX, not 0 - this regression let an unreadable/unusual
        // file get cached as size 0, which skipped the large-file guard
        // entirely and opened (attempted to, at least) a multi-GB file
        // with no warning.
        let raw = format!("F\t{}\tweird-file\n", u64::MAX);
        let nodes = parse_ssh_tree(&raw);
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].size, u64::MAX);
    }
}
