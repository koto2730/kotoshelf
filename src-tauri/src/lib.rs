use std::path::Path;

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
            trash_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
