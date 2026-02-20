use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
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

#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<String, String> {
    let (master, writer, mut reader, child) = tauri::async_runtime::spawn_blocking(move || {
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
        if shell.ends_with("zsh") {
            let temp_root = std::env::temp_dir();
            let integration_dir = temp_root.join(format!("vibecode-zsh-{}", uuid::Uuid::new_v4()));
            let zshrc_path = integration_dir.join(".zshrc");
            if fs::create_dir_all(&integration_dir).is_ok() {
                let zshrc = r#"
export VIBECODE_ZSH_INTEGRATION=1
if [ -f "$HOME/.zshrc" ] && [ "$HOME/.zshrc" != "$ZDOTDIR/.zshrc" ]; then
  source "$HOME/.zshrc"
fi
autoload -U add-zsh-hook
_vibecode_busy() { print -n -- $'\e]999;busy\a'; }
_vibecode_idle() { print -n -- $'\e]999;idle\a'; }
print -n -- $'\e]999;ready\a'
add-zsh-hook preexec _vibecode_busy
add-zsh-hook precmd _vibecode_idle
"#;
                let _ = fs::write(&zshrc_path, zshrc);
                cmd.env("ZDOTDIR", integration_dir);
            }
        }
        if let Some(path) = cwd {
            cmd.cwd(path);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;

        let master = pair.master;
        let writer = master.take_writer().map_err(|e| e.to_string())?;
        let reader = master
            .try_clone_reader()
            .map_err(|e| e.to_string())?;

        Ok::<_, String>((master, writer, reader, child))
    })
    .await
    .map_err(|e| e.to_string())??;

    let session_id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(PtySession {
        master: Mutex::new(master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
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
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;
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
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "state lock poisoned".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;
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
        let mut child = session
            .child
            .lock()
            .map_err(|_| "child lock poisoned".to_string())?;
        let _ = child.kill();
    }

    Ok(())
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
                let app_handle = window.app_handle();
                let state = app_handle.state::<PtyState>();
                let sessions = {
                    let mut lock = match state.sessions.lock() {
                        Ok(lock) => lock,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    std::mem::take(&mut *lock)
                };
                for (_id, session) in sessions {
                    if let Ok(mut child) = session.child.lock() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
