---
name: test-matt-code-ui
description: Use when verifying that matt-code-ui (the Tauri desktop app) works correctly after a change — launch the app, observe it open, and exercise the key UI flows
---

# Test Matt Code UI

## Overview

Matt Code UI is a Tauri 2 desktop app — a file browser sidebar + xterm.js terminal tabs. There are no automated tests. Verification means launching the real app and observing behavior.

## Required Tools

- `grim` — Wayland screenshot capture
- `slurp` — interactive region selector (used with grim)

Install: `sudo pacman -S grim slurp`

## Taking Screenshots

Capture the full screen and read the image to observe the app:

```bash
grim /tmp/matt-code-ui-screenshot.png
```

To capture interactively (select a region with the mouse):
```bash
grim -g "$(slurp)" /tmp/matt-code-ui-screenshot.png
```

Then use the Read tool on `/tmp/matt-code-ui-screenshot.png` to view it.

## Launch

```bash
npm run tauri dev
```

- Vite dev server on port 1420 (strict — fails if occupied; check with `lsof -i:1420`)
- App window opens automatically once Vite and Tauri both finish compiling
- Watch for Rust `cargo` compile errors and Vite TS errors in the terminal output
- If already running, skip relaunch and use the existing window

## Flows to Exercise

Work through these in order. Each maps to a distinct code path.

### 1. App opens cleanly
- Window appears with sidebar on the left and a terminal tab visible
- No console errors in the webview devtools (right-click → Inspect → Console)
- Sidebar shows files/folders for the current directory

### 2. Terminal tab works
- Type a command (`ls`, `echo hello`) and verify output appears
- PTY round-trip: frontend → `write_to_terminal` invoke → Rust PTY → `terminal-data-{id}` event → xterm.js write

### 3. New tab (`Alt+T`)
- A second tab appears in the tab bar
- Each tab is independent (type in one, other is unaffected)
- Tab title shows correct session ID

### 4. Tab cycling (`Alt+Tab` / `Alt+Shift+Tab`)
- Switches between tabs in order
- Active tab's terminal is focused and responsive

### 5. Close tab (`Alt+W`)
- Closes the active tab
- Switches focus to the adjacent tab
- Closing the last tab: verify app doesn't crash

### 6. Sidebar navigation
- Click a directory → sidebar updates to show its contents
- Click a `.ts`, `.rs`, or other file → opens in neovim (sends `:tabe <path>` or spawns `nvim <path>` in a new tab)
- If no neovim tab exists yet, a new terminal tab is created and `nvim <path>` is sent

### 7. Terminal resize
- Resize the app window → terminal reflows without garbled output (`resize_terminal` command fires)
- Toggle the `−` collapse button → terminal collapses/restores

## What to Report

After exercising the flows:
- Which flows passed / failed
- Any console errors or Rust panics (from the `npm run tauri dev` output)
- Any visual glitches or unresponsive UI

## Common Issues

| Symptom | Likely Cause |
|---|---|
| Port 1420 occupied | Previous dev server still running — `pkill -f "vite"` |
| Blank terminal after tab switch | `FitAddon.fit()` not called on reveal — check `showTab()` |
| Sidebar empty | `read_directory` error — check path in Rust logs |
| Neovim not found | `nvim` not in PATH inside the spawned shell |
| `grim` fails with no output | Wayland compositor must be running; check `echo $WAYLAND_DISPLAY` |
