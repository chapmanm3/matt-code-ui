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

#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: HashMap<String, TerminalSession>,
    next_id: usize,
}

pub type TerminalStateHandle = Arc<Mutex<TerminalState>>;

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
            },
        );
        session_id
    };

    let session_id_clone = session_id.clone();
    let app_clone = app.clone();

    thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];
        let mut accumulator = String::new();
        let mut last_emit = Instant::now();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    accumulator.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if accumulator.len() >= 4096
                        || last_emit.elapsed() >= Duration::from_millis(8)
                    {
                        let _ = app_clone.emit(
                            &format!("terminal-data-{}", session_id_clone),
                            std::mem::take(&mut accumulator),
                        );
                        last_emit = Instant::now();
                    }
                }
                Err(_) => break,
            }
        }

        if !accumulator.is_empty() {
            let _ = app_clone.emit(
                &format!("terminal-data-{}", session_id_clone),
                accumulator,
            );
        }
        drop(child);
        let _ = app_clone.emit(&format!("terminal-exited-{}", session_id_clone), ());
    });

    Ok(session_id)
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
    let mut state = state.lock();
    state.sessions.remove(&session_id);
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
            write_to_terminal,
            resize_terminal,
            close_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
