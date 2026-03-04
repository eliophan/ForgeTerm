use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    integration_dir: Option<PathBuf>,
}

struct PtyState {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

#[derive(Serialize, Clone)]
struct PtyOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExitPayload {
    session_id: String,
    code: Option<i32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DirEntryPayload {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GitFileStatus {
    path: String,
    status: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GitStatusPayload {
    root: String,
    branch: String,
    ahead: usize,
    behind: usize,
    files: Vec<GitFileStatus>,
}

#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let (master, writer, mut reader, child, killer, integration_dir) =
        tauri::async_runtime::spawn_blocking(move || {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(shell.clone());
        // Force interactive login shell so prompts render immediately.
        cmd.arg("-l");
        cmd.arg("-i");
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let mut integration_dir_path: Option<PathBuf> = None;
        if shell.ends_with("zsh") {
            let temp_root = std::env::temp_dir();
            let integration_dir = temp_root.join(format!("vibecode-zsh-{}", uuid::Uuid::new_v4()));
            if fs::create_dir_all(&integration_dir).is_ok() {
                // Forward original zsh configs so tools like Homebrew (.zprofile) still work
                let forwarders = [".zshenv", ".zprofile", ".zlogin"];
                for file_name in forwarders.iter() {
                    let content = format!(
                        "if [ -f \"$HOME/{0}\" ] && [ \"$HOME/{0}\" != \"$ZDOTDIR/{0}\" ]; then\n  source \"$HOME/{0}\"\nfi\n",
                        file_name
                    );
                    let _ = fs::write(integration_dir.join(file_name), content);
                }

                // Inject our custom integration script alongside user's .zshrc
                let zshrc = r#"
export VIBECODE_ZSH_INTEGRATION=1
if [ -f "$HOME/.zshrc" ] && [ "$HOME/.zshrc" != "$ZDOTDIR/.zshrc" ]; then
  source "$HOME/.zshrc"
fi
autoload -U add-zsh-hook
_vibecode_busy() { print -n -- $'\e]999;busy\a'; }
_vibecode_idle() { print -n -- $'\e]999;idle\a'; }
_vibecode_cwd() { print -n -- $'\e]999;cwd='"${PWD}"$'\a'; }
add-zsh-hook preexec _vibecode_busy
add-zsh-hook precmd _vibecode_idle
add-zsh-hook precmd _vibecode_cwd
print -n -- $'\e]999;ready\a'
"#;
                let _ = fs::write(integration_dir.join(".zshrc"), zshrc);
                cmd.env("ZDOTDIR", &integration_dir);
                integration_dir_path = Some(integration_dir);
            }
        }
        if let Some(path) = cwd {
            cmd.cwd(path);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;
        let killer = child.clone_killer();

        let master = pair.master;
        let writer = master.take_writer().map_err(|e| e.to_string())?;
        let reader = master
            .try_clone_reader()
            .map_err(|e| e.to_string())?;

        Ok::<_, String>((
            master,
            writer,
            reader,
            child,
            killer,
            integration_dir_path,
        ))
    })
    .await
    .map_err(|e| e.to_string())??;

    let session_id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(PtySession {
        master: Mutex::new(master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
        killer: Mutex::new(killer),
        integration_dir,
    });

    state
        .sessions
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?
        .insert(session_id.clone(), session.clone());

    let app_handle = app.clone();
    let session_id_clone = session_id.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_handle.emit(
                        "pty-output",
                        PtyOutputPayload {
                            session_id: session_id_clone.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    });

    let app_handle = app.clone();
    let session_id_clone = session_id.clone();
    let session_for_wait = session.clone();
    std::thread::spawn(move || {
        let exit_code = session_for_wait
            .child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code() as i32);

        // Remove completed sessions from shared state and clean integration files.
        let state = app_handle.state::<PtyState>();
        if let Ok(mut sessions) = state.sessions.lock() {
            if let Some(session) = sessions.remove(&session_id_clone) {
                if let Some(dir) = session.integration_dir.as_ref() {
                    let _ = fs::remove_dir_all(dir);
                }
            }
        }

        let _ = app_handle.emit(
            "pty-exit",
            PtyExitPayload {
                session_id: session_id_clone,
                code: exit_code,
            },
        );
    });

    Ok(session_id)
}

#[tauri::command]
fn pty_write(state: State<'_, PtyState>, session_id: String, data: String) -> Result<(), String> {
    let session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "session not found".to_string())?
    };
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "writer lock poisoned".to_string())?;
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(
    state: State<'_, PtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "session not found".to_string())?
    };
    let master = session
        .master
        .lock()
        .map_err(|_| "master lock poisoned".to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(state: State<'_, PtyState>, session_id: String) -> Result<(), String> {
    let session = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "state lock poisoned".to_string())?;
        sessions.remove(&session_id)
    };

    if let Some(session) = session {
        if let Ok(mut killer) = session.killer.lock() {
            let _ = killer.kill();
        }
        if let Some(dir) = session.integration_dir.as_ref() {
            let _ = fs::remove_dir_all(dir);
        }
    }

    Ok(())
}

#[tauri::command]
fn fs_read_dir(path: String) -> Result<Vec<DirEntryPayload>, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err("path is not a directory".to_string());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().to_string_lossy().to_string();
        entries.push(DirEntryPayload {
            name,
            path,
            is_dir: file_type.is_dir(),
        });
    }
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(entries)
}

fn run_git(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(if message.is_empty() {
            "git command failed".to_string()
        } else {
            message.to_string()
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

#[tauri::command]
async fn git_status(path: String) -> Result<GitStatusPayload, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = run_git(&path, &["rev-parse", "--show-toplevel"])?;
        let branch = run_git(&path, &["rev-parse", "--abbrev-ref", "HEAD"])
            .unwrap_or_else(|_| "HEAD".to_string());

        let upstream = run_git(
            &path,
            &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        )
        .ok();
        let (ahead, behind) = if upstream.is_some() {
            let counts = run_git(
                &path,
                &["rev-list", "--left-right", "--count", "@{u}...HEAD"],
            )?;
            let mut parts = counts.split_whitespace();
            let behind = parts
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let ahead = parts
                .next()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            (ahead, behind)
        } else {
            (0, 0)
        };

        let status_output = run_git(&path, &["status", "--porcelain=v1", "-u"])?;
        let mut files = Vec::new();
        for line in status_output.lines() {
            if line.len() < 3 {
                continue;
            }
            let status = line[..2].to_string();
            let file_path = line[3..].trim().to_string();
            files.push(GitFileStatus {
                path: file_path,
                status,
            });
        }

        Ok(GitStatusPayload {
            root,
            branch,
            ahead,
            behind,
            files,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_commit(path: String, message: String) -> Result<String, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("commit message is empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let add_output = Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["add", "-A"])
            .output()
            .map_err(|e| e.to_string())?;
        if !add_output.status.success() {
            let stderr = String::from_utf8_lossy(&add_output.stderr);
            let message = stderr.trim();
            return Err(if message.is_empty() {
                "git add failed".to_string()
            } else {
                message.to_string()
            });
        }

        let output = Command::new("git")
            .arg("-C")
            .arg(&path)
            .arg("commit")
            .arg("-m")
            .arg(&message)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = stderr.trim();
            return Err(if message.is_empty() {
                "git commit failed".to_string()
            } else {
                message.to_string()
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_push(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(&path)
            .arg("push")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = stderr.trim();
            return Err(if message.is_empty() {
                "git push failed".to_string()
            } else {
                message.to_string()
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_pull(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new("git")
            .arg("-C")
            .arg(&path)
            .arg("pull")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let message = stderr.trim();
            return Err(if message.is_empty() {
                "git pull failed".to_string()
            } else {
                message.to_string()
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_target(path: String, app: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("open");
            if let Some(app) = app {
                let app = app.trim();
                if !app.is_empty() {
                    command.arg("-a").arg(app);
                }
            }
            let status = command.arg(&path).status().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("open target failed".to_string());
            }
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            let _ = app;
            Err("open target is only supported on macOS".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState {
            sessions: Mutex::new(HashMap::new()),
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let app_handle = window.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app_handle.state::<PtyState>();
                    let sessions = {
                        let mut lock = match state.sessions.lock() {
                            Ok(lock) => lock,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        std::mem::take(&mut *lock)
                    };
                    for (_id, session) in sessions {
                        // Best-effort shutdown without blocking the UI thread.
                        if let Ok(mut killer) = session.killer.lock() {
                            let _ = killer.kill();
                        }
                        if let Some(dir) = session.integration_dir.as_ref() {
                            let _ = fs::remove_dir_all(dir);
                        }
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            fs_read_dir,
            git_status,
            git_commit,
            git_push,
            git_pull,
            open_target
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
