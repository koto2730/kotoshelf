//! Deployed to a remote host and run persistently over one `ssh`
//! subprocess's stdin/stdout by `src-tauri` (see `ssh_agent_connect` in
//! `src-tauri/src/lib.rs`). Reads one framed `Request` at a time, runs it
//! against this host's own filesystem (it *is* "local" from here), and
//! writes back a framed `Response` - a thin dispatch loop over the
//! platform-agnostic logic in `agent-protocol`, deliberately not a
//! reimplementation of it.

use agent_protocol::{
    read_frame, read_tree, read_tree_shallow, relativize, write_frame, Request, RequestBody,
    Response, ResponseBody,
};
use std::io::{self, BufReader};
use std::path::Path;

fn main() {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let stdout = io::stdout();
    let mut writer = stdout.lock();

    loop {
        let req: Request = match read_frame(&mut reader) {
            Ok(Some(r)) => r,
            Ok(None) => break, // client closed its side cleanly
            Err(_) => break,   // malformed frame - nothing sensible to recover to
        };

        let id = req.id;
        let mut done = false;
        let body = match req.body {
            RequestBody::Ping => ResponseBody::Pong,
            RequestBody::Shutdown => {
                done = true;
                ResponseBody::Ok
            }
            RequestBody::ReadTree { root } => match read_tree(&root) {
                Ok(nodes) => ResponseBody::Tree(relativize(nodes, Path::new(&root))),
                Err(e) => ResponseBody::Error { message: e },
            },
            RequestBody::ReadTreeShallow { root, rel_path } => {
                let dir = join_remote(&root, &rel_path);
                match read_tree_shallow(&dir) {
                    Ok(nodes) => ResponseBody::Tree(relativize(nodes, Path::new(&root))),
                    Err(e) => ResponseBody::Error { message: e },
                }
            }
        };

        if write_frame(&mut writer, &Response { id, body }).is_err() || done {
            break;
        }
    }
}

/// `Path::join` rather than string concatenation so a trailing slash on
/// `root` (which the client doesn't guarantee it trims) doesn't produce
/// a doubled separator.
fn join_remote(root: &str, rel_path: &str) -> String {
    if rel_path.is_empty() {
        root.to_string()
    } else {
        Path::new(root).join(rel_path).to_string_lossy().into_owned()
    }
}
