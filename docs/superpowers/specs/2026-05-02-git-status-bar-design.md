# Git Status Bar Design

**Date:** 2026-05-02

## Overview

Add a git status bar pinned to the very bottom of the application window, spanning the full width (outside the sidebar and main area). It displays branch name, staged/unstaged/untracked change counts, and ahead/behind remote tracking info for the current working directory. It updates automatically via background polling. If the directory is not a git repo, the bar is hidden.

## Layout

The git bar is a new element at the bottom of `#app` in `index.html`, as a sibling to `#sidebar` and `#main-area` (which means `#app` becomes a grid or wrapping flex container). The bar spans the full window width regardless of terminal collapse state. The existing status bar inside the terminal container is unchanged.

Display format when in a git repo:

```
 main  +2 ~1 ?3  ↑1 ↓0
```

Symbols:
- `+` — staged changes
- `~` — unstaged modifications  
- `?` — untracked files
- `↑` — commits ahead of remote
- `↓` — commits behind remote

Zero-value counts are omitted (e.g. if ahead=0 and behind=0, the `↑↓` section is hidden). If there are no changes at all, only the branch name is shown.

## Backend (Rust)

A new `GitStatus` struct:

```rust
struct GitStatus {
    branch: String,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    ahead: u32,
    behind: u32,
}
```

At app startup (in `run()`), a background thread is spawned that:
1. Runs `git status --porcelain=v2 --branch` in the app's working directory every 3 seconds
2. Parses output to populate `GitStatus`
3. Serializes to JSON and compares to last emitted value (string comparison)
4. Emits a `git-status-changed` Tauri event only when the value has changed

If the directory is not a git repo (git exits non-zero), the thread emits a `git-status-changed` event with `null` (or an empty sentinel) so the frontend can hide the bar.

Parsing `git status --porcelain=v2 --branch` output:
- Lines starting `# branch.head` → branch name
- Lines starting `# branch.ab` → ahead/behind counts
- Lines starting `1` or `2` → staged (`XY` where X != `.`) and unstaged (`XY` where Y != `.`)
- Lines starting `?` → untracked

No new Cargo dependencies needed.

## Frontend (TypeScript)

At `DOMContentLoaded`, register a `listen("git-status-changed", handler)` listener. The handler:
- If payload is null/empty: hide the git bar (`display: none`)
- Otherwise: parse the JSON, build the display string, set the element's text, show the bar

No new state variables. The handler updates the DOM directly.

## Styling

```
background: #0f1117
border-top: 1px solid #ffffff18
font-size: 11px
padding: 4px 12px
height: 22px
```

Branch name: `#e0e0e0` (slightly brighter). Counts and symbols: `#ffffff66`. The bar blends with the existing terminal status bar style.

## Layout change to `#app`

Currently `#app` is `display: flex; flex-direction: row`. To pin the git bar at the bottom spanning full width, `#app` becomes a 2-column, 2-row grid:

```css
#app {
  display: grid;
  grid-template-columns: 200px 1fr;
  grid-template-rows: 1fr auto;
  height: 100vh;
}
#sidebar { grid-row: 1; grid-column: 1; }
#main-area { grid-row: 1; grid-column: 2; }
#git-bar { grid-row: 2; grid-column: 1 / -1; }
```

## Polling behavior

- Poll interval: 3 seconds
- Only emit event when value changes (string diff of serialized JSON)
- Thread runs for the lifetime of the app (no teardown needed)
- If git is not on PATH, the bar stays hidden silently
