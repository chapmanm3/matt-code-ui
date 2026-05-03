use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[cfg(unix)]
use async_trait::async_trait;
#[cfg(unix)]
use nvim_rs::{create::tokio as nvim_create, Handler, Neovim, Value};
#[cfg(unix)]
use tokio_util::compat::Compat;

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
}

#[derive(Debug, Serialize)]
pub struct NeovimSpawnResult {
    pub session_id: String,
    pub socket_path: String,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    socket_path: Option<String>,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: HashMap<String, TerminalSession>,
    next_id: usize,
}

pub type TerminalStateHandle = Arc<Mutex<TerminalState>>;

#[cfg(unix)]
#[derive(Clone)]
struct NvimHandler;

#[cfg(unix)]
#[async_trait]
impl Handler for NvimHandler {
    type Writer = Compat<tokio::net::unix::OwnedWriteHalf>;

    async fn handle_request(
        &self,
        _name: String,
        _args: Vec<Value>,
        _neovim: Neovim<Self::Writer>,
    ) -> Result<Value, Value> {
        Err(Value::from("not implemented"))
    }

    async fn handle_notify(
        &self,
        _name: String,
        _args: Vec<Value>,
        _neovim: Neovim<Self::Writer>,
    ) {
    }
}

fn reader_thread(
    reader: Box<dyn Read + Send>,
    app: AppHandle,
    session_id: String,
    child: Box<dyn portable_pty::Child + Send + Sync>,
) {
    let mut reader = reader;
    let mut buf = [0u8; 4096];
    let mut accumulator = String::new();
    let mut last_emit = Instant::now();

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                accumulator.push_str(&String::from_utf8_lossy(&buf[..n]));
                if accumulator.len() >= 4096 || last_emit.elapsed() >= Duration::from_millis(8) {
                    let _ = app.emit(
                        &format!("terminal-data-{}", session_id),
                        std::mem::take(&mut accumulator),
                    );
                    last_emit = Instant::now();
                }
            }
            Err(_) => break,
        }
    }

    if !accumulator.is_empty() {
        let _ = app.emit(&format!("terminal-data-{}", session_id), accumulator);
    }
    drop(child);
    let _ = app.emit(&format!("terminal-exited-{}", session_id), ());
}

#[tauri::command]
fn get_current_dir() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;

    let mut files: Vec<FileEntry> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy().to_string();
            let is_dir = path.is_dir();
            let is_file = path.is_file();

            Some(FileEntry {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir,
                is_file,
            })
        })
        .collect();

    files.sort_by(|a, b| {
        if a.is_dir == b.is_dir {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        } else if a.is_dir {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        }
    });

    Ok(files)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn spawn_terminal(
    app: AppHandle,
    state: State<'_, TerminalStateHandle>,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<String, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new_default_prog();
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session_id = {
        let mut state = state.lock();
        let id = state.next_id;
        state.next_id += 1;
        let session_id = format!("term-{}", id);
        state.sessions.insert(
            session_id.clone(),
            TerminalSession {
                master: pair.master,
                writer: Arc::new(Mutex::new(Some(writer))),
                socket_path: None,
            },
        );
        session_id
    };

    let session_id_clone = session_id.clone();
    thread::spawn(move || reader_thread(reader, app, session_id_clone, child));

    Ok(session_id)
}

#[cfg(unix)]
#[tauri::command]
fn spawn_neovim(
    app: AppHandle,
    state: State<'_, TerminalStateHandle>,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    file_path: Option<String>,
) -> Result<NeovimSpawnResult, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let (session_id, socket_path) = {
        let mut state = state.lock();
        let id = state.next_id;
        state.next_id += 1;
        (
            format!("term-{}", id),
            format!("/tmp/nvim-term-{}.sock", id),
        )
    };

    let mut cmd = CommandBuilder::new("nvim");
    cmd.arg("--listen");
    cmd.arg(&socket_path);
    if let Some(ref fp) = file_path {
        cmd.arg(fp);
    }
    if let Some(ref dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    {
        let mut state = state.lock();
        state.sessions.insert(
            session_id.clone(),
            TerminalSession {
                master: pair.master,
                writer: Arc::new(Mutex::new(Some(writer))),
                socket_path: Some(socket_path.clone()),
            },
        );
    }

    let session_id_clone = session_id.clone();
    let socket_path_clone = socket_path.clone();
    thread::spawn(move || {
        reader_thread(reader, app, session_id_clone, child);
        let _ = std::fs::remove_file(&socket_path_clone);
    });

    Ok(NeovimSpawnResult {
        session_id,
        socket_path,
    })
}

#[cfg(not(unix))]
#[tauri::command]
fn spawn_neovim(
    _app: AppHandle,
    _state: State<'_, TerminalStateHandle>,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
    file_path: Option<String>,
) -> Result<NeovimSpawnResult, String> {
    let _ = (cwd, rows, cols, file_path);
    Err("Neovim RPC is not supported on this platform".to_string())
}

#[cfg(unix)]
#[tauri::command]
async fn nvim_open_file(socket_path: String, file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&socket_path);
    let mut last_err = String::new();

    for attempt in 0..10u32 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        match nvim_create::new_unix_socket(path, NvimHandler).await {
            Ok((nvim, _io_handle)) => {
                let escaped = nvim
                    .call_function("fnameescape", vec![Value::from(file_path.as_str())])
                    .await
                    .map_err(|e| e.to_string())?;
                let escaped_str = escaped
                    .as_str()
                    .ok_or("fnameescape returned non-string value")?;
                return nvim
                    .command(&format!("tabe {}", escaped_str))
                    .await
                    .map_err(|e| e.to_string());
            }
            Err(e) => {
                last_err = e.to_string();
            }
        }
    }

    Err(format!(
        "Failed to connect to Neovim socket after 10 attempts: {}",
        last_err
    ))
}

#[cfg(not(unix))]
#[tauri::command]
async fn nvim_open_file(socket_path: String, file_path: String) -> Result<(), String> {
    let _ = (socket_path, file_path);
    Err("Neovim RPC is not supported on this platform".to_string())
}

#[tauri::command]
fn write_to_terminal(
    state: State<'_, TerminalStateHandle>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let writer_arc = {
        let state = state.lock();
        let session = state
            .sessions
            .get(&session_id)
            .ok_or("Session not found")?;
        Arc::clone(&session.writer)
    };

    let mut guard = writer_arc.lock();
    let writer = guard.as_mut().ok_or("Writer not available")?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_terminal(
    state: State<'_, TerminalStateHandle>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let state = state.lock();
    let session = state.sessions.get(&session_id).ok_or("Session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_terminal(state: State<'_, TerminalStateHandle>, session_id: String) -> Result<(), String> {
    let socket_path = {
        let mut state = state.lock();
        state.sessions.remove(&session_id).and_then(|s| s.socket_path)
    };
    if let Some(path) = socket_path {
        let _ = std::fs::remove_file(&path);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let terminal_state: TerminalStateHandle = Arc::new(Mutex::new(TerminalState::default()));

    tauri::Builder::default()
        .manage(terminal_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_current_dir,
            read_directory,
            read_file,
            spawn_terminal,
            spawn_neovim,
            nvim_open_file,
            write_to_terminal,
            resize_terminal,
            close_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
