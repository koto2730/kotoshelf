use std::path::Path;
use std::path::PathBuf;

/// One node of the workspace file tree. `children` is `Some` for
/// directories (possibly empty) and `None` for files, so the frontend can
/// distinguish "empty dir" from "file" without consulting `is_dir` twice.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<TreeNode>>,
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
        nodes.push(TreeNode {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir,
            children,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            set_search_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
