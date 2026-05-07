# Git Worktree Support Implementation Plan

## Overview

Add tmux-style worktree session management to Matt Code UI. Worktrees act as session containers that group terminal AND chat tabs. Switching sessions shows that session's tabs and file browser location. Terminals remain alive in background sessions (tmux-style).

## Architecture Changes

### Data Model

**New Interface:**
```typescript
interface WorktreeSession {
  id: string;                  // Generated UUID
  path: string;                 // Worktree directory path
  branch: string;               // Git branch name (or 'detached HEAD')
  isMain: boolean;              // Whether it's the main worktree
  tabs: Tab[];                  // Tabs belonging to this session (terminal + chat)
  activeTabId: string;          // Remembered active tab for this session
  nextTabIndex: number;         // Per-session tab counter (starts at 1)
  nextChatIndex: number;        // Per-session chat counter (starts at 1)
  isInitialized: boolean;       // Whether initial tab has been created
}

interface WorktreeEntry {
  path: string;
  branch: string;
  isMain: boolean;
}
```

**State Changes in `src/main.ts`:**
- Remove global `tabs: Tab[]` → move into `WorktreeSession`
- Remove global `activeTabId: string` → move into `WorktreeSession`
- Remove global `nextTabIndex: number` → move into `WorktreeSession`
- Remove global `nextChatIndex: number` → move into `WorktreeSession`
- Add `worktreeSessions: WorktreeSession[]`
- Add `activeWorktreeSessionId: string | null`
- Add `isGitRepo: boolean` - track if current directory is a git repo
- `currentPath: string` → derived from active session's worktree path
- `currentPath` becomes per-session (stored in session or derived from path)

### Rust Backend (`src-tauri/src/lib.rs`)

**New Commands:**

1. **`git_worktree_list(repo_path: String) -> Result<Vec<WorktreeEntry>, String>`**
   - Run `git worktree list --porcelain`
   - Parse output: each worktree block separated by blank line
   - Lines: `worktree <path>`, `HEAD <commit>`, `branch refs/heads/<branch>` (or missing = detached HEAD)
   - Detect main worktree: `.git` is a directory (not a file with `gitdir: <path>`)
   - For detached HEAD: set `branch = "detached HEAD"`, `isMain = false`
   - Return sorted list (main first, then alphabetically by branch)

2. **`git_worktree_add(repo_path: String, worktree_path: String, branch: Option<String>) -> Result<(), String>`**
   - If branch provided: `git worktree add <path> -b <branch>` (creates new branch)
   - If no branch: `git worktree add <path>` (uses HEAD)
   - Handle errors: branch exists, path exists, etc.

3. **`git_get_current_branch(repo_path: String) -> Result<String, String>`**
   - Run `git -C <path> branch --show-current`
   - If empty output (detached HEAD), return "detached HEAD"

4. **`git_find_repo_root(start_path: String) -> Result<String, String>`** (helper)
   - Walk up directories looking for `.git` directory or file
   - Return absolute path to repo root
   - Error if not found

**New Structs:**
```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
}
```

Register all commands in `invoke_handler`.

### Porcelain Output Format (for parsing reference)

```
worktree /home/user/repo
HEAD abc123def456...
branch refs/heads/main

worktree /home/user/repo-feature
HEAD abc123def456...
branch refs/heads/feature/test

worktree /home/user/repo-detached
HEAD abc123def456...
<no branch line = detached HEAD>
```

### Detecting Main vs Linked Worktree

- Main worktree: `.git` is a **directory**
- Linked worktree: `.git` is a **file** containing `gitdir: /path/to/.git/worktrees/<name>`

## UI Changes

### Non-Git Repository Handling

When `git_find_repo_root` fails or `git worktree list` fails:
- Set `isGitRepo = false`
- Create a single "default" `WorktreeSession` with `path = current_dir`, `branch = ""`, `isMain = true`
- Disable worktree sidebar features: hide + button, refresh button, show "Not a git repository" message
- Tab/chat creation still works in the default session

### HTML (`index.html`)

Add new sidebar panel between files sidebar and session sidebar:
```html
<aside id="worktree-sidebar" class="worktree-sidebar collapsible-sidebar">
  <div class="sidebar-header">
    <button class="collapse-btn" data-target="worktree-sidebar" title="Toggle Worktrees">‹</button>
    <span class="sidebar-title">Worktrees</span>
    <button id="new-worktree-btn" class="new-worktree-btn" title="New Worktree" disabled>?</button>
    <button id="refresh-worktrees-btn" class="refresh-worktrees-btn" title="Refresh">↻</button>
  </div>
  <div id="worktree-list" class="worktree-list"></div>
  <div id="worktree-empty" class="worktree-empty" style="display:none">
    Not a git repository
  </div>
</aside>
```

### CSS (`src/styles.css`)

Add styles following existing patterns:
- `.worktree-sidebar` - Same dimensions as other sidebars (200px width)
- `.worktree-list` - Scrollable container
- `.worktree-item` - Clickable worktree entry, padding 8px 16px
- `.worktree-item.active` - Highlight active session (border-left: 3px solid #e0e0e0 like session-item)
- `.worktree-branch` - Branch name display (font-size: 13px, white-space: nowrap)
- `.worktree-tab-count` - Small badge (background: #ffffff22, border-radius, font-size: 10px)
- `.new-worktree-btn`, `.refresh-worktrees-btn` - Header buttons (like `.new-session-btn`)
- `.worktree-empty` - Empty state message (padding: 16px, color: #ffffff66)
- `.worktree-item-detached` - Style for detached HEAD worktrees

Add to `.collapsed` rules to hide new elements when collapsed.

### Modal Dialog (HTML + CSS)

Add modal for creating worktrees (hidden by default):
```html
<div id="worktree-modal" class="modal-overlay" style="display:none">
  <div class="modal">
    <div class="modal-header">Create New Worktree</div>
    <div class="modal-body">
      <div class="form-group">
        <label>Branch name: <input id="worktree-branch-input" type="text" placeholder="feature/my-feature"></label>
      </div>
      <div class="form-group">
        <label>Path (optional): <input id="worktree-path-input" type="text" placeholder="Auto-generated if empty"></label>
      </div>
    </div>
    <div class="modal-footer">
      <button id="worktree-modal-cancel">Cancel</button>
      <button id="worktree-modal-create">Create</button>
    </div>
  </div>
</div>
```

Add modal CSS:
- `.modal-overlay` - position: fixed, top/left/right/bottom: 0, background: rgba(0,0,0,0.5), display: flex, justify/align: center
- `.modal` - background: #0f1117, border: 1px solid #ffffff18, border-radius: 8px, padding: 0, min-width: 300px
- `.modal-header` - padding: 12px 16px, border-bottom: 1px solid #ffffff18, font-weight: 600
- `.modal-body` - padding: 16px
- `.modal-footer` - padding: 12px 16px, border-top: 1px solid #ffffff18, display: flex, justify-content: flex-end, gap: 8px
- `.form-group` - margin-bottom: 12px
- `.form-group label` - display: block, margin-bottom: 4px, font-size: 12px, color: #ffffff88
- `.form-group input` - width: 100%, padding: 6px 8px, background: #090b10, border: 1px solid #ffffff18, border-radius: 4px, color: #e0e0e0

## Frontend Logic Changes (`src/main.ts`)

### New State Variables

```typescript
let worktreeSessions: WorktreeSession[] = [];
let activeWorktreeSessionId: string | null = null;
let isGitRepo: boolean = true;  // Track if we're in a git repo
```

### New Functions

1. **`loadWorktrees()`** - Fetch and render worktree list
   - If not `isGitRepo`: create default session, return early
   - Invoke `git_find_repo_root(currentPath)` to get repo root
   - If fails: set `isGitRepo = false`, create default session, disable + button
   - Invoke `git_worktree_list(repoRoot)` 
   - Parse results into `WorktreeSession[]` (init tabs as empty, nextTabIndex=1, nextChatIndex=1)
   - Store in `worktreeSessions`
   - If `worktreeSessions` is empty: create default session from current dir
   - Call `renderWorktreeList()`

2. **`renderWorktreeList()`** - Update sidebar UI
   - If not `isGitRepo`: show `#worktree-empty`, hide `#worktree-list`, return
   - Clear and repopulate `#worktree-list`
   - Show branch name + tab count badge for each
   - For detached HEAD: show "detached HEAD" with `.worktree-item-detached` class
   - Highlight active session with `.active` class
   - Click handler: `switchWorktreeSession(session.id)`
   - Enable/disable + button based on `isGitRepo`

3. **`switchWorktreeSession(sessionId: string)`** - Core session switch
   - Save current session's `activeTabId` if exists
   - Set `activeWorktreeSessionId = sessionId`
   - Get session = `getActiveWorktreeSession()`
   - Update `currentPath = session.path`
   - Call `loadDirectory(currentPath)` to update file browser
   - Restore session's `tabs` and `activeTabId`
   - Call `renderTabBar()` and `renderActiveContent()`
   - Update worktree list highlighting (remove/add `.active` class)

4. **`createWorktreeSession(branch: string, customPath?: string)`**
   - Invoke `git_find_repo_root(currentPath)` to get repo root
   - Generate worktree path: if customPath use it, else `<repo-parent>/<branch-name>`
   - If branch provided: invoke `git_worktree_add(repoRoot, worktreePath, Some(branch))`
   - If no branch: invoke `git_worktree_add(repoRoot, worktreePath, None)`
   - Get branch name via `git_get_current_branch(worktreePath)` (handles detached HEAD)
   - Create new `WorktreeSession` with empty tabs, nextTabIndex=1, nextChatIndex=1
   - Add to `worktreeSessions`
   - Switch to new session via `switchWorktreeSession()`
   - Initialize first terminal tab in new session

5. **`initWorktreeSessions()`** - App initialization
   - Call `loadWorktrees()`
   - If `worktreeSessions` is empty, create default session from current dir
   - Set first worktree as active (or find match for currentPath)
   - Initialize first tab for active session

### Modified Functions

1. **`createTab(isNeovim)`** - Use active session's tabs array
   - Get session = `getActiveWorktreeSession()`
   - Use `session.nextTabIndex++` for naming
   - Push new tab to `session.tabs`
   - Set `session.activeTabId = newTab.id`
   - Update tab rendering

2. **`createChatTab()`** - Use active session's tabs array
   - Get session = `getActiveWorktreeSession()`
   - Use `session.nextChatIndex++` for naming
   - Push new chat tab to `session.tabs`
   - Set `session.activeTabId = newTab.id`

3. **`switchTab(tabId)`** - Work within active session
   - Get session = `getActiveWorktreeSession()`
   - Update `session.activeTabId = tabId`
   - Tab lookup scoped to `session.tabs`

4. **`closeTab(tabId)`** - Remove from session's tabs array
   - Get session = `getActiveWorktreeSession()`
   - Remove tab from `session.tabs`
   - If `session.tabs.length === 0`: switch to another session (if available), keep empty session
   - If closing active tab: switch to another tab in same session

5. **`renderTabBar()`** - Render only active session's tabs
   - Get session = `getActiveWorktreeSession()`
   - Iterate `session.tabs`

6. **`getActiveTab()`** - Lookup in active session
   - Get session = `getActiveWorktreeSession()`
   - Return from `session.tabs.find(t => t.id === session.activeTabId)`

7. **`loadSessions()`** - Update chat session highlighting
   - Check against active session's tabs (not global tabs)

8. **`initFirstTab()`** → Rename/refactor to `initWorktreeSessions()`

### Helper Functions

- **`getActiveWorktreeSession(): WorktreeSession`** - Returns currently active session (throws if null)
- **`findRepoRoot(startPath: string): string`** - Now uses Rust command `git_find_repo_root`
- **`generateWorktreePath(repoRoot: string, branch: string): string`** - Generate default path: `<repo-parent>/<branch-name>`

### Chat Tab Handling (Now Per-Session)

- `switchToSession(session)` - Must now look in active session's tabs
- `loadSessions()` - Highlight chat tabs that belong to active session
- Chat tab creation pushes to session's tabs array

## Initialization Flow Changes

Update `DOMContentLoaded` handler:
1. `loadConfig()`
2. `invoke("get_current_dir")` → `basePath`
3. `initWorktreeSessions()` - sets up worktree sessions, handles non-git case
   - Sets `isGitRepo` flag
   - Creates default session if not a git repo
4. Set up event listeners:
   - New worktree button (only works if `isGitRepo`)
   - Refresh worktrees button
   - Modal cancel/create buttons
   - Collapse button for new sidebar
5. Initialize OpenCode client (unchanged)

## Keyboard Shortcuts

- `Ctrl+Alt+Left` - Switch to previous worktree session (if `isGitRepo`)
- `Ctrl+Alt+Right` - Switch to next worktree session (if `isGitRepo`)
- `Ctrl+Shift+N` - New worktree (opens modal, only if `isGitRepo`)
- Existing shortcuts remain unchanged (Ctrl+Tab, Ctrl+T, Ctrl+W, Ctrl+C)

## Edge Cases Handled

1. **Non-git directory**: Create default session, disable worktree features, show message
2. **Detached HEAD worktrees**: Show "detached HEAD" as branch name, style differently
3. **Last tab in session closed**: Switch to another session if available, keep empty session
4. **No worktrees found**: Create default session from current directory
5. **Close last session**: Don't allow closing the last worktree session
6. **Per-session state**: Each session has its own tab counter, active tab, chat tabs
7. **Terminal lifecycle**: Terminals stay alive when switching sessions (tmux-style)
8. **File browser sync**: Automatically switches to worktree path on session switch

## File Changes Summary

| File | Changes |
|------|---------|
| `src/main.ts` | Major: new interfaces (`WorktreeSession`, `WorktreeEntry`), refactor global `tabs`/`activeTabId`/`nextTabIndex`/`nextChatIndex` into per-session state, add worktree functions, update all tab/chat functions to use active session |
| `src-tauri/src/lib.rs` | Add 4 new Tauri commands: `git_worktree_list`, `git_worktree_add`, `git_get_current_branch`, `git_find_repo_root` |
| `index.html` | Add `#worktree-sidebar` panel between files and sessions sidebars, add `#worktree-modal` dialog, add `#worktree-empty` for non-git state |
| `src/styles.css` | Add styles for `.worktree-sidebar`, `.worktree-list`, `.worktree-item`, `.worktree-item.active`, `.worktree-item-detached`, `.worktree-branch`, `.worktree-tab-count`, `.new-worktree-btn`, `.refresh-worktrees-btn`, `.worktree-empty`, `.modal-overlay`, `.modal`, `.modal-header`, `.modal-body`, `.modal-footer`, `.form-group` |

## Implementation Tasks

### Phase 1: Foundation (Can be done in parallel)

#### Task 1.1: Add Rust Backend Commands
**File:** `src-tauri/src/lib.rs`  
**Dependencies:** None  
**Acceptance Criteria:**
- [ ] `git_find_repo_root(start_path: String)` returns `Result<String, String>` - walks up to find `.git` dir/file
- [ ] `git_worktree_list(repo_path: String)` returns `Result<Vec<WorktreeEntry>, String>` - parses `git worktree list --porcelain`
- [ ] `git_worktree_add(repo_path: String, worktree_path: String, branch: Option<String>)` returns `Result<(), String>`
- [ ] `git_get_current_branch(repo_path: String)` returns `Result<String, String>` - returns "detached HEAD" if empty
- [ ] All commands registered in `invoke_handler` in `run()` function
- [ ] `cargo check` passes in `src-tauri/`

#### Task 1.2: Add Frontend Types
**File:** `src/main.ts`  
**Dependencies:** None  
**Acceptance Criteria:**
- [ ] `WorktreeSession` interface defined with: `id`, `path`, `branch`, `isMain`, `tabs`, `activeTabId`, `nextTabIndex`, `nextChatIndex`, `isInitialized`
- [ ] `WorktreeEntry` interface defined with: `path`, `branch`, `isMain`
- [ ] New state variables: `worktreeSessions`, `activeWorktreeSessionId`, `isGitRepo`
- [ ] Global `tabs`, `activeTabId`, `nextTabIndex`, `nextChatIndex` still exist (will be removed in Task 2.1)

---

### Phase 2: State Refactoring (Serial - depends on Phase 1)

#### Task 2.1: Refactor State to Per-Session
**File:** `src/main.ts`  
**Dependencies:** Task 1.2 complete  
**Acceptance Criteria:**
- [ ] Remove global `tabs: Tab[]` - move into `WorktreeSession.tabs`
- [ ] Remove global `activeTabId: string` - move into `WorktreeSession.activeTabId`
- [ ] Remove global `nextTabIndex` - move into `WorktreeSession.nextTabIndex`
- [ ] Remove global `nextChatIndex` - move into `WorktreeSession.nextChatIndex`
- [ ] Add `getActiveWorktreeSession(): WorktreeSession` helper function
- [ ] All existing code referencing `tabs` updated to use `getActiveWorktreeSession().tabs`
- [ ] App still works: `npm run build` passes with no TS errors

#### Task 2.2: Add Worktree Sidebar HTML
**File:** `index.html`  
**Dependencies:** None (can run parallel with 2.1)  
**Acceptance Criteria:**
- [ ] `#worktree-sidebar` aside element added between `#sidebar` and `#session-sidebar`
- [ ] Sidebar has: collapse button, title "Worktrees", + button, refresh button
- [ ] `#worktree-list` div inside sidebar for worktree items
- [ ] `#worktree-empty` div with "Not a git repository" message (hidden by default)
- [ ] `#worktree-modal` modal overlay with: branch input, path input, cancel/create buttons
- [ ] HTML validates (no missing closing tags)

#### Task 2.3: Add Worktree CSS Styles
**File:** `src/styles.css`  
**Dependencies:** Task 2.2 complete (or can be done alongside)  
**Acceptance Criteria:**
- [ ] `.worktree-sidebar` - 200px width, same as other sidebars
- [ ] `.worktree-list` - scrollable container
- [ ] `.worktree-item` - clickable, padding 8px 16px, hover effect
- [ ] `.worktree-item.active` - highlighted with border-left
- [ ] `.worktree-item-detached` - style for detached HEAD
- [ ] `.worktree-branch` - branch name display
- [ ] `.worktree-tab-count` - badge showing tab count
- [ ] `.new-worktree-btn`, `.refresh-worktrees-btn` - header buttons
- [ ] `.worktree-empty` - empty state message
- [ ] Modal CSS: `.modal-overlay`, `.modal`, `.modal-header`, `.modal-body`, `.modal-footer`, `.form-group`
- [ ] Collapsed state hides worktree-specific elements

---

### Phase 3: Core Logic (Serial - depends on Phase 2)

#### Task 3.1: Implement Worktree Functions
**File:** `src/main.ts`  
**Dependencies:** Tasks 1.1, 2.1 complete  
**Acceptance Criteria:**
- [ ] `loadWorktrees()` - invokes `git_find_repo_root` and `git_worktree_list`, handles non-git case
- [ ] `renderWorktreeList()` - clears and repopulates `#worktree-list`, handles `isGitRepo` false case
- [ ] `switchWorktreeSession(sessionId)` - saves/restores session state, updates file browser
- [ ] `createWorktreeSession(branch, customPath?)` - invokes Rust commands, creates session
- [ ] `initWorktreeSessions()` - initializes sessions on app start
- [ ] `loadWorktrees()` shows "detached HEAD" for worktrees without branch
- [ ] Manual refresh button works (calls `loadWorktrees()`)

#### Task 3.2: Update Existing Functions for Per-Session
**File:** `src/main.ts`  
**Dependencies:** Task 3.1 complete  
**Acceptance Criteria:**
- [ ] `createTab()` - uses `session.nextTabIndex++`, pushes to `session.tabs`
- [ ] `createChatTab()` - uses `session.nextChatIndex++`, pushes to `session.tabs`
- [ ] `switchTab(tabId)` - updates `session.activeTabId`
- [ ] `closeTab(tabId)` - removes from `session.tabs`, switches session if empty
- [ ] `renderTabBar()` - iterates `session.tabs`
- [ ] `getActiveTab()` - looks up in `session.tabs`
- [ ] `loadSessions()` - checks active session's tabs for highlighting
- [ ] `switchToSession()` - looks in active session's tabs
- [ ] All functions use `getActiveWorktreeSession()` helper

#### Task 3.3: Update Initialization Flow
**File:** `src/main.ts`  
**Dependencies:** Task 3.2 complete  
**Acceptance Criteria:**
- [ ] `DOMContentLoaded` calls `initWorktreeSessions()` instead of `initFirstTab()`
- [ ] Event listeners set up for: new worktree btn, refresh btn, modal buttons, collapse btn
- [ ] Non-git repo handling: creates default session, disables + button
- [ ] `isGitRepo` flag properly set and respected by UI

---

### Phase 4: Polish (Can be done in parallel with Phase 3)

#### Task 4.1: Add Keyboard Shortcuts
**File:** `src/main.ts`  
**Dependencies:** Task 3.1 complete  
**Acceptance Criteria:**
- [ ] `Ctrl+Alt+Left` - switches to previous worktree session (if `isGitRepo`)
- [ ] `Ctrl+Alt+Right` - switches to next worktree session (if `isGitRepo`)
- [ ] `Ctrl+Shift+N` - opens worktree creation modal (if `isGitRepo`)
- [ ] Existing shortcuts unchanged (Ctrl+Tab, Ctrl+T, Ctrl+W, Ctrl+C)

---

### Phase 5: Integration Testing (Serial - all previous tasks complete)

#### Task 5.1: Manual Testing Checklist
**Acceptance Criteria:**
- [ ] **Git repo detection**: App opens in git repo → worktree list shows, + button enabled
- [ ] **Non-git repo**: App opens in non-git dir → default session created, "Not a git repository" shown, + button disabled
- [ ] **Worktree list**: `git worktree list` output parsed correctly, main worktree identified
- [ ] **Detached HEAD**: Detached HEAD worktree shows "detached HEAD" with special styling
- [ ] **Session switch**: Clicking worktree → file browser updates, tab bar shows session's tabs, terminals stay alive in background
- [ ] **Tab per-session**: Each session has own tabs, closing last tab switches to another session
- [ ] **Tab naming**: Per-session counters - "Terminal 1" starts fresh in each session
- [ ] **Chat tabs per-session**: Chat tabs belong to session, not global
- [ ] **Create worktree**: + button → modal → enter branch → worktree created, session added
- [ ] **Refresh**: Refresh button reloads worktree list
- [ ] **Terminal lifecycle**: Switch sessions → terminal in background session still running (tmux-style)
- [ ] **Collapse**: Worktree sidebar collapses/expands like other sidebars
- [ ] **TypeScript**: `npm run build` passes with no errors
- [ ] **Rust**: `cd src-tauri && cargo check` passes

---

### Parallel/Sequential Summary

```
Phase 1 (Parallel):
  ├── Task 1.1: Rust commands          (independent)
  └── Task 1.2: Frontend types         (independent)

Phase 2 (Mostly Parallel):
  ├── Task 2.1: State refactoring      (depends on 1.2)
  ├── Task 2.2: Sidebar HTML          (independent, can run parallel with 2.1)
  └── Task 2.3: CSS styles            (depends on 2.2)

Phase 3 (Serial):
  ├── Task 3.1: Worktree functions    (depends on 1.1, 2.1)
  ├── Task 3.2: Update existing fns   (depends on 3.1)
  └── Task 3.3: Init flow             (depends on 3.2)

Phase 4 (Parallel with 3):
  └── Task 4.1: Keyboard shortcuts    (depends on 3.1, can run parallel with 3.2)

Phase 5 (Serial):
  └── Task 5.1: Integration testing   (depends on all above)
```

### Estimated Task Sizes

| Task | Size | Files Changed |
|------|------|---------------|
| 1.1 Rust commands | Medium | `src-tauri/src/lib.rs` |
| 1.2 Frontend types | Small | `src/main.ts` |
| 2.1 State refactoring | Large | `src/main.ts` |
| 2.2 Sidebar HTML | Small | `index.html` |
| 2.3 CSS styles | Medium | `src/styles.css` |
| 3.1 Worktree functions | Large | `src/main.ts` |
| 3.2 Update existing fns | Large | `src/main.ts` |
| 3.3 Init flow | Small | `src/main.ts` |
| 4.1 Keyboard shortcuts | Small | `src/main.ts` |
| 5.1 Testing | N/A | Manual verification |
