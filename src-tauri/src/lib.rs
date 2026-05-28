use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(unix)]
use async_trait::async_trait;
#[cfg(unix)]
use nvim_rs::{create::tokio as nvim_create, Handler, Neovim, Value};
#[cfg(unix)]
use tokio_util::compat::Compat;

#[derive(Debug, Serialize, Deserialize, Clone)]
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

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Keybinds {
    #[serde(default = "default_next_tab")]
    pub next_tab: String,
    #[serde(default = "default_prev_tab")]
    pub prev_tab: String,
    #[serde(default = "default_new_terminal")]
    pub new_terminal: String,
    #[serde(default = "default_close_terminal")]
    pub close_terminal: String,
}

fn default_next_tab() -> String { "Alt+Tab".to_string() }
fn default_prev_tab() -> String { "Alt+Shift+Tab".to_string() }
fn default_new_terminal() -> String { "Alt+T".to_string() }
fn default_close_terminal() -> String { "Alt+W".to_string() }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PersistedProject {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Config {
    #[serde(default)]
    pub keybinds: Keybinds,
    #[serde(default)]
    pub projects: Vec<PersistedProject>,
    #[serde(default)]
    pub active_project_id: Option<String>,
}

struct OpenCodeServerState {
    child: Mutex<Option<std::process::Child>>,
    port: Mutex<u16>,
    ready: Mutex<bool>,
}

impl Default for OpenCodeServerState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            port: Mutex::new(4096),
            ready: Mutex::new(false),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpenCodeServerStatus {
    pub running: bool,
    pub port: u16,
    pub ready: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
}

#[tauri::command]
async fn start_opencode_server(
    app: AppHandle,
    state: State<'_, Arc<OpenCodeServerState>>,
) -> Result<OpenCodeServerStatus, String> {
    let port = {
        let port_guard = state.port.lock();
        *port_guard
    };

    println!("[OpenCode] Starting server on port {}...", port);

    let child = std::process::Command::new("opencode")
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();

    let child = match child {
        Ok(c) => c,
        Err(e) => {
            println!("[OpenCode] Failed to start: {}", e);
            let _ = app.emit("opencode-not-found", {
                "OpenCode not found. Please install it: https://github.com/anomalyco/opencode/releases"
            });
            return Err(format!("Failed to start opencode: {}", e));
        }
    };

    println!("[OpenCode] Server process started, waiting for ready...");

    {
        let mut child_guard = state.child.lock();
        *child_guard = Some(child);
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/global/health", port);

        for i in 0..150 {
            tokio::time::sleep(Duration::from_millis(200)).await;
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => {
                    println!("[OpenCode] Server ready on port {} after {}ms", port, i * 200);
                    let _ = app_handle.emit("opencode-ready", port);
                    if let Some(state) = app_handle.try_state::<Arc<OpenCodeServerState>>() {
                        let mut ready = state.ready.lock();
                        *ready = true;
                    }
                    return;
                }
                Ok(resp) => {
                    if i % 10 == 0 {
                        println!("[OpenCode] Waiting for server... status: {}", resp.status());
                    }
                }
                Err(e) => {
                    if i % 10 == 0 {
                        println!("[OpenCode] Waiting for server... error: {}", e);
                    }
                }
            }
        }
        println!("[OpenCode] Server failed to start within 30 seconds");
        let _ = app_handle.emit("opencode-failed", "Server failed to start within 30 seconds");
    });

    Ok(OpenCodeServerStatus {
        running: true,
        port,
        ready: false,
    })
}

#[tauri::command]
fn stop_opencode_server(state: State<'_, Arc<OpenCodeServerState>>) -> Result<bool, String> {
    let mut child_guard = state.child.lock();
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        let mut ready_guard = state.ready.lock();
        *ready_guard = false;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
fn get_opencode_server_status(state: State<'_, Arc<OpenCodeServerState>>) -> OpenCodeServerStatus {
    let child_guard = state.child.lock();
    let port_guard = state.port.lock();
    let ready_guard = state.ready.lock();
    OpenCodeServerStatus {
        running: child_guard.is_some(),
        port: *port_guard,
        ready: *ready_guard,
    }
}

fn get_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    Ok(app_dir.join("config.json"))
}

#[tauri::command]
fn read_config(app: AppHandle) -> Result<Config, String> {
    let config_path = get_config_path(&app)?;

    if !config_path.exists() {
        let default_config = Config::default();
        let config_str = serde_json::to_string_pretty(&default_config)
            .map_err(|e| e.to_string())?;
        fs::create_dir_all(config_path.parent().unwrap())
            .map_err(|e| e.to_string())?;
        fs::write(&config_path, config_str)
            .map_err(|e| e.to_string())?;
        return Ok(default_config);
    }

    let contents = fs::read_to_string(&config_path)
        .map_err(|e| e.to_string())?;
    let config: Config = serde_json::from_str(&contents)
        .unwrap_or_default();
    Ok(config)
}

#[tauri::command]
fn write_config(app: AppHandle, config: String) -> Result<(), String> {
    let config_path = get_config_path(&app)?;
    fs::create_dir_all(config_path.parent().unwrap())
        .map_err(|e| e.to_string())?;
    fs::write(&config_path, config)
        .map_err(|e| e.to_string())?;
    Ok(())
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
    type Writer = Compat<tokio::io::WriteHalf<tokio::net::UnixStream>>;

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

#[tauri::command]
fn spawn_terminal_cmd(
    app: AppHandle,
    state: State<'_, TerminalStateHandle>,
    cmd: String,
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

    let mut builder = CommandBuilder::new(&cmd);
    if let Some(dir) = cwd {
        builder.cwd(dir);
    }

    let child = pair.slave.spawn_command(builder).map_err(|e| e.to_string())?;
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
        match nvim_create::new_path(path, NvimHandler).await {
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

#[tauri::command]
fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]).to_string_lossy().to_string();
        }
    } else if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    path.to_string()
}

#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[tauri::command]
fn git_find_repo_root(start_path: String) -> Result<String, String> {
    let start_path = expand_tilde(&start_path);
    let mut current = std::path::Path::new(&start_path).to_path_buf();
    loop {
        let git_path = current.join(".git");
        if git_path.exists() {
            return Ok(current.to_string_lossy().to_string());
        }
        if !current.pop() {
            break;
        }
    }
    Err("Not a git repository".to_string())
}

fn parse_worktree_list(output: &str) -> Vec<WorktreeEntry> {
    let mut entries = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_branch: Option<String> = None;

    for line in output.lines() {
        if line.starts_with("worktree ") {
            if let Some(path) = current_path.take() {
                let branch = current_branch.take().unwrap_or_else(|| "detached HEAD".to_string());
                let is_main = std::path::Path::new(&path).join(".git").is_dir();
                entries.push(WorktreeEntry { path, branch, is_main });
            }
            current_path = Some(line[9..].to_string());
        } else if line.starts_with("branch ") {
            let branch_ref = &line[7..];
            let branch_name = branch_ref.strip_prefix("refs/heads/").unwrap_or(branch_ref);
            current_branch = Some(branch_name.to_string());
        }
    }

    if let Some(path) = current_path {
        let branch = current_branch.unwrap_or_else(|| "detached HEAD".to_string());
        let is_main = std::path::Path::new(&path).join(".git").is_dir();
        entries.push(WorktreeEntry { path, branch, is_main });
    }

    // Sort: main first, then by branch name
    entries.sort_by(|a, b| {
        if a.is_main && !b.is_main {
            std::cmp::Ordering::Less
        } else if !a.is_main && b.is_main {
            std::cmp::Ordering::Greater
        } else {
            a.branch.cmp(&b.branch)
        }
    });

    entries
}

#[tauri::command]
fn git_worktree_list(repo_path: String) -> Result<Vec<WorktreeEntry>, String> {
    let output = std::process::Command::new("git")
        .arg("worktree")
        .arg("list")
        .arg("--porcelain")
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree list: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree list failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_worktree_list(&stdout))
}

#[tauri::command]
fn git_worktree_add(
    repo_path: String,
    worktree_path: String,
    branch: Option<String>,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("worktree").arg("add");

    if let Some(ref branch_name) = branch {
        cmd.arg("-b").arg(branch_name);
    }

    cmd.arg(&worktree_path);

    if branch.is_some() {
        cmd.arg("HEAD");
    }

    let output = cmd
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree add: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

#[tauri::command]
fn git_worktree_remove(repo_path: String, worktree_path: String, force: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("worktree").arg("remove");
    if force {
        cmd.arg("--force");
    }
    cmd.arg(&worktree_path);

    let output = cmd
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git worktree remove: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git worktree remove failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(())
}

#[tauri::command]
fn git_get_current_branch(worktree_path: String) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("branch")
        .arg("--show-current")
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run git branch: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "git branch --show-current failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        Ok("detached HEAD".to_string())
    } else {
        Ok(branch)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let terminal_state: TerminalStateHandle = Arc::new(Mutex::new(TerminalState::default()));
    let opencode_state: Arc<OpenCodeServerState> = Arc::new(OpenCodeServerState::default());

    tauri::Builder::default()
        .manage(terminal_state)
        .manage(opencode_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_current_dir,
            read_directory,
            read_file,
            spawn_terminal,
            spawn_terminal_cmd,
            spawn_neovim,
            nvim_open_file,
            write_to_terminal,
            resize_terminal,
            close_terminal,
            read_config,
            write_config,
            start_opencode_server,
            stop_opencode_server,
            get_opencode_server_status,
            get_home_dir,
            git_find_repo_root,
            git_worktree_list,
            git_worktree_add,
            git_worktree_remove,
            git_get_current_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
