# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Matt Code UI is a Tauri 2 desktop application — a lightweight IDE-like shell with a file browser sidebar and embedded terminal tabs powered by xterm.js. The frontend is vanilla TypeScript (no framework); the backend is Rust. There are no tests.

## Commands

**Run in development** (starts both the Vite dev server and the Tauri window):
```
npm run tauri dev
```

**Build for production:**
```
npm run tauri build
```

**Type-check the frontend only:**
```
npm run build
```
(`tsc && vite build` — the `tsc` step will catch TypeScript errors without needing to launch Tauri)

**Lint/check Rust:**
```
cd src-tauri && cargo check
cargo clippy
```

Vite dev server runs on port 1420 (strict — will fail if occupied).

## Architecture

### Frontend (`src/main.ts`, `src/styles.css`, `index.html`)

Single TypeScript file with no framework. Key state:
- `tabs: TerminalTab[]` — array of open terminal tabs, each holding an xterm.js `Terminal`, a `FitAddon`, and event unlisten callbacks
- `activeTabId: string` — ID of the currently displayed tab
- `currentPath: string` — directory shown in the file sidebar

Each tab maps to a backend PTY session identified by a `sessionId` (e.g. `"term-0"`). The frontend communicates with Rust exclusively via:
- `invoke(command, args)` — synchronous Tauri command calls
- `listen(event, handler)` — subscribes to Tauri events emitted by the backend

Terminal data flows: PTY output → Rust thread → `tauri::Emitter::emit("terminal-data-{sessionId}", data)` → frontend `listen` handler → `terminal.write(data)`.

### Backend (`src-tauri/src/lib.rs`)

All logic lives in `lib.rs`; `main.rs` is just an entry point. Shared state is `TerminalStateHandle = Arc<Mutex<TerminalState>>`, managed by Tauri. Each PTY session is a `TerminalSession` holding a `portable_pty` master and writer.

Tauri commands exposed to the frontend:
| Command | Purpose |
|---|---|
| `get_current_dir` | Returns `std::env::current_dir()` |
| `read_directory` | Lists directory entries sorted dirs-first |
| `read_file` | Reads a file as a string (registered but unused in UI) |
| `spawn_terminal` | Opens a PTY, spawns the default shell, starts a reader thread emitting `terminal-data-{id}` events; emits `terminal-exited-{id}` on exit |
| `write_to_terminal` | Writes bytes to a PTY master writer |
| `resize_terminal` | Sends SIGWINCH equivalent via `portable_pty` resize |
| `close_terminal` | Drops the writer and removes the session |

### Key behaviors

- Clicking a file in the sidebar calls `openInNeovim(path)`, which either sends `:tabe <path>\r` to an existing neovim tab or creates a new terminal tab and sends `nvim <path>\r`.
- Terminal tabs lazily initialize their PTY on first display (`isInitialized` flag).
- Keyboard shortcuts: `Alt+Tab` / `Alt+Shift+Tab` cycle tabs, `Alt+T` opens a new terminal, `Alt+W` closes the active tab.
- The terminal container can be toggled collapsed/full-height/split via the `−` button.

### Build config

- Vite is configured in `vite.config.ts` to ignore `src-tauri/**` from file watching.
- TypeScript is strict (`strict`, `noUnusedLocals`, `noUnusedParameters`).
- Tauri `withGlobalTauri: true` makes `window.__TAURI__` available globally (though `invoke`/`listen` are imported from the npm package in this codebase).
