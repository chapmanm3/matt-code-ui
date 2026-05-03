# UI Audit — High-Contrast Minimal Redesign

**Date:** 2026-05-02
**Approach:** Give the app a distinct visual identity (Approach B) using a high-contrast minimal aesthetic — near-black backgrounds, pure white active states, no color accents.

## Context

The app is a terminal-first Tauri desktop IDE: a file browser sidebar + multi-tab terminal area. The primary usage is terminal tabs (running shells, Claude Code sessions, etc.). The file browser is secondary. The felt problem was the app looking generic and unfinished, closely resembling a VS Code prototype.

---

## 1. Color Palette

| Role | Value | Usage |
|---|---|---|
| App background | `#090b10` | Terminal area, main background |
| Surface | `#0f1117` | Tab bar, sidebar, status footer |
| Border | `#ffffff18` | All dividers and outlines |
| Active / accent | `#ffffff` | Active tab indicator, cursor |
| Primary text | `#e0e0e0` | File names, tab names, terminal UI text |
| Muted text | `#ffffff44` | Inactive tabs, path display, keyboard hints |
| Hover wash | `#ffffff0f` | All hover states across the app |

**What goes away:**
- `#007acc` blue status bar — replaced with dark borderline footer
- `#e8ab6b` orange folder color — folders become `#e0e0e0`
- `#252526` sidebar surface — replaced with `#0f1117`

---

## 2. Layout Changes

**Terminal:** Starts full-height by default on launch (sidebar hidden, `main-content` hidden). The existing toggle button reveals the split-view (sidebar + terminal). This matches terminal-first usage — file browser is available on demand via one click.

**Sidebar:** Width reduced from 250px → 200px. The "FILES" label and path display merge into a single compact header row to reduce visual weight.

**Tab bar:** Replace rounded-corner browser-style tabs with flat underline tabs. Active tab: 2px white bottom border + full-brightness text. Inactive tabs: muted text (`#ffffff44`), no background. No background fill on the tab bar row itself — transparent over the surface color.

**Status bar:** Remove the blue fill entirely. Replace with a `#0f1117` footer with a `1px #ffffff18` top border. Font size stays 11px, color `#ffffff33` for hints. No color.

---

## 3. Icons

Replace emoji icons (📁 📄) with inline SVGs. Both icons use `#e0e0e0` at reduced opacity (0.7 for folders, stroke-based for files) so they're visible but don't compete with text.

**Folder icon:** Filled path, tab-shape top-left corner, `fill="#e0e0e0" opacity="0.7"`, 16×16.

**File icon:** Outlined rectangle with folded top-right corner, `stroke="#e0e0e0" stroke-opacity="0.4"`, 14×16.

Folder entries: color `#e0e0e0` (same as file entries — remove the orange distinction). Hierarchy is communicated by icon shape, not color.

---

## 4. Interaction Polish

**Tab close button:** Show the × only on hover of the individual tab (not always visible for all tabs). On hover: white background, black ×, 2px border-radius.

**Terminal toggle button:** Replace the `−` / `+` character with a chevron SVG (▾ when expanded, ▸ when collapsed). Same three states (split / collapsed / full-height) — clearer visual direction.

**Scrollbar (sidebar file list):** Custom scrollbar — 3px width, `#ffffff22` thumb, transparent track. Applied via `::-webkit-scrollbar` rules.

**Typography:** No changes to font stack. Remove `letter-spacing: 0.5px` from the `.sidebar-title` label — it reads cleaner without it at this size.

---

## 5. Out of Scope

- Terminal colors / xterm.js theme (the terminal interior is already dark and correct)
- Tauri window chrome / title bar (native, already minimal)
- Keyboard shortcut changes
- New features (resizable sidebar, new tab types, etc.)
