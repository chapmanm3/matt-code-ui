import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { marked } from "marked";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";

// Custom renderer for marked to add syntax highlighting
const renderer = new marked.Renderer();
renderer.code = function({ text, lang }: { text: string, lang?: string }) {
  let highlighted: string;
  if (lang && hljs.getLanguage(lang)) {
    try {
      highlighted = hljs.highlight(text, { language: lang }).value;
    } catch {
      highlighted = hljs.highlightAuto(text).value;
    }
  } else {
    highlighted = hljs.highlightAuto(text).value;
  }
  const langClass = lang ? ` class="language-${lang}"` : '';
  return `<pre><code${langClass}>${highlighted}</code></pre>`;
};

marked.use({ renderer });

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const ICON_FOLDER = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1.5 4.5A1 1 0 012.5 3.5h3.086a1 1 0 01.707.293L7.5 5h6a1 1 0 011 1v6a1 1 0 01-1 1h-11a1 1 0 01-1-1V4.5z" fill="#e0e0e0" fill-opacity="0.7"/></svg>`;

const ICON_FILE = `<svg width="16" height="16" viewBox="0 1 14 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 1.5h7l3 3V14.5H2V1.5z" stroke="#e0e0e0" stroke-opacity="0.6" stroke-width="1.2" fill="none"/><path d="M9 1.5V4.5h3" stroke="#e0e0e0" stroke-opacity="0.6" stroke-width="1.2" fill="none"/></svg>`;
const ICON_CHAT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3h12a1 1 0 011 1v7a1 1 0 01-1 1H6l-3 3v-3H2a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="#e0e0e0" stroke-opacity="0.7" stroke-width="1.2" fill="none"/></svg>`;
const ICON_TERMINAL = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="#e0e0e0" stroke-opacity="0.5" stroke-width="1.2" fill="none"/><path d="M4 6l3 2.5L4 11" stroke="#e0e0e0" stroke-opacity="0.6" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.5 11h3" stroke="#e0e0e0" stroke-opacity="0.6" stroke-width="1.2" stroke-linecap="round"/></svg>`;

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_file: boolean;
}

interface NeovimSpawnResult {
  session_id: string;
  socket_path: string;
}

interface Keybinds {
  next_tab: string;
  prev_tab: string;
  new_terminal: string;
  new_chat: string;
  close_terminal: string;
}

interface Config {
  keybinds: Keybinds;
}

interface TerminalTab {
  id: string;
  sessionId: string | null;
  name: string;
  isNeovim: boolean;
  nvimSocketPath: string | null;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  unlistenData: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  rowCount: number;
  colCount: number;
  isActive: boolean;
  isInitialized: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface SessionInfo {
  id: string;
  title: string;
  slug: string;
  time: {
    created: number;
    updated: number;
  };
}

interface Provider {
  id: string;
  name: string;
  models: { [key: string]: Model };
}

interface Model {
  id: string;
  name: string;
  providerID?: string;
}

interface ProviderConfig {
  providers: Provider[];
  default: { [key: string]: string };
}

interface ChatTab {
  id: string;
  type: 'chat';
  name: string;
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  unlistenEvent: UnlistenFn | null;
  isInitialized: boolean;
}

interface WorktreeEntry {
  path: string;
  branch: string;
  is_main: boolean;
}

interface WorktreeSession {
  id: string;
  path: string;
  branch: string;
  isMain: boolean;
  tabs: Tab[];
  activeTabId: string;
  nextTabIndex: number;
  nextChatIndex: number;
  isInitialized: boolean;
}

type Tab = TerminalTab | ChatTab;

let opencodeServerPort: number = 4096;
let opencodeReadyPromise: Promise<void> | null = null;
let opencodeReadyResolver: (() => void) | null = null;
let providers: Provider[] = [];
let defaultModels: { [key: string]: string } = {};
let currentModel: { providerID: string; modelID: string } | null = null;

let worktreeSessions: WorktreeSession[] = [];
let activeWorktreeSessionId: string | null = null;
let isGitRepo: boolean = true;

function getActiveWorktreeSession(): WorktreeSession {
  const session = worktreeSessions.find(s => s.id === activeWorktreeSessionId);
  if (!session) throw new Error("No active worktree session");
  return session;
}

async function initOpenCodeClient() {
  if (opencodeReadyPromise) {
    console.log("OpenCode client init already in progress, waiting...");
    return opencodeReadyPromise;
  }

  console.log("Initializing OpenCode client...");
  opencodeReadyPromise = new Promise<void>((resolve) => {
    opencodeReadyResolver = resolve;
  });

  try {
    const status = await invoke<{ running: boolean; port: number; ready: boolean }>("get_opencode_server_status");
    console.log("OpenCode server status:", status);
    opencodeServerPort = status.port;

    if (status.ready) {
      console.log("OpenCode server already ready");
      opencodeReadyResolver?.();
      return opencodeReadyPromise;
    }

    listen("opencode-ready", (event) => {
      console.log("OpenCode server ready event received, port:", event.payload);
      opencodeServerPort = event.payload as number;
      opencodeReadyResolver?.();
    });

    listen("opencode-failed", (event) => {
      console.error("OpenCode server failed to start:", event.payload);
      opencodeReadyResolver?.();
    });

    if (!status.running) {
      console.log("Starting OpenCode server...");
      await invoke("start_opencode_server");
      console.log("OpenCode server start command issued");
    } else {
      console.log("OpenCode server already running, waiting for ready...");
    }
  } catch (error) {
    console.error("Failed to initialize OpenCode client:", error);
    opencodeReadyResolver?.();
  }

  return opencodeReadyPromise;
}

async function fetchSessions(): Promise<SessionInfo[]> {
  try {
    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/session`);
    if (!resp.ok) {
      console.error("Failed to fetch sessions:", resp.status);
      return [];
    }
    const sessions: SessionInfo[] = await resp.json();
    console.log("Fetched sessions:", sessions.length);
    return sessions;
  } catch (error) {
    console.error("Error fetching sessions:", error);
    return [];
  }
}

function loadSessions() {
  fetchSessions().then(sessions => {
    const sessionList = document.getElementById("session-list");
    if (!sessionList) return;

    sessionList.innerHTML = '';
    sessions.forEach(session => {
      const sessionEl = document.createElement("div");
      sessionEl.className = "session-item";

      // Check if this session's chat tab exists in the active worktree session
      const activeSession = getActiveWorktreeSession();
      const activeTab = activeSession.tabs.find(t => isChatTab(t) && t.sessionId === session.id);

      if (activeTab) {
        sessionEl.classList.add("active");
      }

      const date = new Date(session.time.updated);
      const timeStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      sessionEl.innerHTML = `
        <div class="session-item-title">${session.title || 'Untitled'}</div>
        <div class="session-item-time">${timeStr}</div>
        <span class="session-item-delete" data-session-id="${session.id}">×</span>
      `;

      sessionEl.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("session-item-delete")) return;
        switchToSession(session);
      });

      const deleteBtn = sessionEl.querySelector(".session-item-delete") as HTMLElement | null;
      let confirmTimeout: number | null = null;
      deleteBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (deleteBtn.classList.contains("confirming")) {
          if (confirmTimeout) clearTimeout(confirmTimeout);
          deleteSession(session.id);
        } else {
          deleteBtn.classList.add("confirming");
          deleteBtn.textContent = "sure?";
          confirmTimeout = window.setTimeout(() => {
            deleteBtn.classList.remove("confirming");
            deleteBtn.textContent = "×";
          }, 3000);
        }
      });

      sessionList.appendChild(sessionEl);
    });
  });
}

async function switchToSession(session: SessionInfo) {
  console.log("Switching to session:", session.id, session.title);
  const activeSession = getActiveWorktreeSession();

  const existingTab = activeSession.tabs.find(t => isChatTab(t) && t.sessionId === session.id) as ChatTab | undefined;
  if (existingTab) {
    await switchTab(existingTab.id);
    return;
  }

  const tabId = `chat-${crypto.randomUUID()}`;
  const newTab: ChatTab = {
    id: tabId,
    type: 'chat',
    name: session.title || 'Untitled',
    sessionId: session.id,
    messages: [],
    isStreaming: false,
    unlistenEvent: null,
    isInitialized: true,
  };

  activeSession.tabs.push(newTab);
  activeSession.activeTabId = tabId;
  renderTabBar();
  renderActiveContent();
  updateStatusBar();

  // Reset to default model when switching sessions
  if (providers.length >0) {
    const firstProvider = providers[0];
    const defaultModelId = defaultModels[firstProvider.id];
    if (defaultModelId) {
      currentModel = { providerID: firstProvider.id, modelID: defaultModelId };
    }
  }
  updateModelSelector();

  loadSessionMessages(session.id);
}

async function loadSessionMessages(sessionId: string) {
  try {
    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/session/${sessionId}/message`);
    if (!resp.ok) return;
    const data = await resp.json();
    console.log("Loaded messages:", data.length);

    const session = getActiveWorktreeSession();
    const tab = session.tabs.find(t => isChatTab(t) && t.sessionId === sessionId) as ChatTab | undefined;
    if (!tab) return;

    tab.messages = [];
    data.forEach((msg: any) => {
      const role = msg.info.role === 'user' ? 'user' : 'assistant';
      let content = '';
      if (msg.parts && Array.isArray(msg.parts)) {
        for (const part of msg.parts) {
          if (part.type === 'text' && part.text) {
            content += part.text;
          }
        }
      }
      tab.messages.push({ role, content, timestamp: msg.info.time?.created || Date.now() });
    });

    renderChatMessages(tab);
  } catch (error) {
    console.error("Error loading session messages:", error);
  }
}

async function deleteSession(sessionId: string) {
  try {
    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/session/${sessionId}`, {
      method: 'DELETE',
    });
      if (resp.ok) {
        console.log("Deleted session:", sessionId);
        loadSessions();

        const session = getActiveWorktreeSession();
        const tab = session.tabs.find(t => isChatTab(t) && t.sessionId === sessionId);
        if (tab) {
          await closeTab(tab.id);
        }
      }
  } catch (error) {
    console.error("Error deleting session:", error);
  }
}

async function fetchProviders(): Promise<ProviderConfig | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/config/providers`);
    if (!resp.ok) {
      console.error("Failed to fetch providers:", resp.status);
      return null;
    }
    const config: ProviderConfig = await resp.json();
    providers = config.providers;
    defaultModels = config.default;
    console.log("Fetched providers:", providers.length);
    return config;
  } catch (error) {
    console.error("Error fetching providers:", error);
    return null;
  }
}

function populateModelSelector() {
  const selector = document.getElementById("model-selector") as HTMLSelectElement;
  if (!selector) return;

  selector.innerHTML = '';

  if (providers.length === 0) {
    selector.innerHTML = '<option value="">No models available</option>';
    return;
  }

  providers.forEach(provider => {
    const optgroup = document.createElement("optgroup");
    optgroup.label = provider.name;

    // models is an object (key-value map), not an array
    const modelsObj = provider.models;
    Object.keys(modelsObj).forEach(modelKey => {
      const model = modelsObj[modelKey];
      const option = document.createElement("option");
      option.value = JSON.stringify({ providerID: provider.id, modelID: model.id });
      option.textContent = model.name || model.id;
      optgroup.appendChild(option);
    });

    selector.appendChild(optgroup);
  });

  if (currentModel) {
    const value = JSON.stringify(currentModel);
    selector.value = value;
  }
}

function updateModelSelector() {
  populateModelSelector();

  const selector = document.getElementById("model-selector") as HTMLSelectElement;
  if (!selector) return;

  selector.onchange = (e) => {
    const target = e.target as HTMLSelectElement;
    if (target.value) {
      try {
        currentModel = JSON.parse(target.value);
        console.log("Model changed:", currentModel);
      } catch (err) {
        console.error("Failed to parse model selection:", err);
      }
    } else {
      currentModel = null;
    }
  };
}

function getActiveTab(): Tab | undefined {
  const session = getActiveWorktreeSession();
  return session.tabs.find(t => t.id === session.activeTabId);
}

function isChatTab(tab: Tab): tab is ChatTab {
  return 'type' in tab && tab.type === 'chat';
}

function isTerminalTab(tab: Tab): tab is TerminalTab {
  return !isChatTab(tab);
}

async function loadConfig() {
  try {
    const result = await invoke<Config>("read_config");
    console.log("Config loaded:", result);
  } catch (error) {
    console.error("Error loading config:", error);
  }
}

function wireAppKeydownHandler() {
  document.addEventListener("keydown", async (e) => {
    const session = getActiveWorktreeSession();
    const currentIndex = session.tabs.findIndex(t => t.id === session.activeTabId);

    // Ctrl+Alt+Left: Switch to previous worktree session
    if (e.key === 'ArrowLeft' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!isGitRepo) return;
      const sessionIndex = worktreeSessions.findIndex(s => s.id === activeWorktreeSessionId);
      const prevIndex = sessionIndex > 0 ? sessionIndex - 1 : worktreeSessions.length - 1;
      await switchWorktreeSession(worktreeSessions[prevIndex].id);
      return;
    }

    // Ctrl+Alt+Right: Switch to next worktree session
    if (e.key === 'ArrowRight' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!isGitRepo) return;
      const sessionIndex = worktreeSessions.findIndex(s => s.id === activeWorktreeSessionId);
      const nextIndex = sessionIndex < worktreeSessions.length - 1 ? sessionIndex + 1 : 0;
      await switchWorktreeSession(worktreeSessions[nextIndex].id);
      return;
    }

    // Ctrl+Shift+N: New worktree
    if (e.key === 'n' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!isGitRepo) return;
      const modal = document.getElementById("worktree-modal");
      if (modal) modal.style.display = "flex";
      return;
    }

    if (e.key === 'C' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await createChatTab();
      return;
    }

    if (e.key === 'Tab' && e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const nextIndex = currentIndex < session.tabs.length - 1 ? currentIndex + 1 : 0;
      await switchTab(session.tabs[nextIndex].id);
      return;
    }

    if (e.key === 'Tab' && e.altKey && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : session.tabs.length - 1;
      await switchTab(session.tabs[prevIndex].id);
      return;
    }

    if (e.key === 't' && e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await createTab(false);
      return;
    }

    if (e.key === 'w' && e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await closeTab(session.activeTabId);
      return;
    }
  }, { capture: true });
}

async function loadDirectory(path: string) {
  try {
    currentPath = path;
    const files: FileEntry[] = await invoke("read_directory", { path });
    renderFileList(files);
    updatePathDisplay(path);
  } catch (error) {
    console.error("Error loading directory:", error);
  }
}

let currentPath: string = "";

function renderFileList(files: FileEntry[]) {
  const fileList = document.getElementById("file-list");
  if (!fileList) return;

  fileList.innerHTML = "";

  if (currentPath !== "/") {
    const parentDir = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
    const parentEntry = document.createElement("div");
    parentEntry.className = "file-entry folder";
    parentEntry.title = parentDir;
    parentEntry.innerHTML = `<span class="icon">${ICON_FOLDER}</span><span class="name">..</span>`;
    parentEntry.addEventListener("click", () => loadDirectory(parentDir));
    fileList.appendChild(parentEntry);
  }

  for (const file of files) {
    const entry = document.createElement("div");
    if (file.is_dir) {
      entry.className = "file-entry folder";
      entry.title = file.path;
      entry.innerHTML = `<span class="icon">${ICON_FOLDER}</span><span class="name">${escapeHtml(file.name)}</span>`;
      entry.addEventListener("click", () => loadDirectory(file.path));
    } else {
      entry.className = "file-entry file";
      entry.title = file.path;
      entry.innerHTML = `<span class="icon">${ICON_FILE}</span><span class="name">${escapeHtml(file.name)}</span>`;
      entry.addEventListener("click", () => openInNeovim(file.path));
    }
    fileList.appendChild(entry);
  }
}

function updatePathDisplay(path: string) {
  const pathDisplay = document.getElementById("current-path");
  if (pathDisplay) {
    pathDisplay.textContent = path;
  }
}

function renderTabBar() {
  const tabBar = document.querySelector(".tab-bar");
  if (!tabBar) return;

  const existingTabs = tabBar.querySelectorAll(".tab");
  existingTabs.forEach(t => t.remove());

  const session = getActiveWorktreeSession();
  session.tabs.forEach(tab => {
    const tabEl = document.createElement("div");
    tabEl.className = `tab ${tab.id === session.activeTabId ? "active" : ""}`;
    tabEl.dataset.tabId = tab.id;
    const icon = isChatTab(tab) ? ICON_CHAT : ICON_TERMINAL;
    tabEl.innerHTML = `
      <span class="tab-icon">${icon}</span>
      <span class="tab-name">${escapeHtml(tab.name)}</span>
      ${session.tabs.length > 1 ? '<span class="tab-close">×</span>' : ''}
    `;
    tabEl.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).classList.contains("tab-close")) {
        closeTab(tab.id);
      } else {
        switchTab(tab.id);
      }
    });
    tabBar.insertBefore(tabEl, tabBar.querySelector(".new-tab"));
  });
}

async function switchTab(tabId: string) {
  const session = getActiveWorktreeSession();
  const newTab = session.tabs.find(t => t.id === tabId);
  if (!newTab) return;

  if (isTerminalTab(newTab) && !newTab.isInitialized) {
    await initializeTab(newTab);
  }

  session.activeTabId = tabId;
  renderTabBar();
  renderActiveContent();
  updateStatusBar();
}

function makeTerminal(): { terminal: Terminal; fitAddon: FitAddon } {
  const terminal = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: "Consolas, Monaco, 'Courier New', monospace",
    theme: {
      background: "#090b10",
      foreground: "#e0e0e0",
      cursor: "#e0e0e0",
    },
    convertEol: true,
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  return { terminal, fitAddon };
}

function wireTerminalInput(tab: TerminalTab, terminal: Terminal) {
  terminal.onData(async (data) => {
    if (tab.sessionId) {
      try {
        await invoke("write_to_terminal", { sessionId: tab.sessionId, data });
      } catch (error) {
        console.error("Write error:", error);
      }
    }
  });

  terminal.onResize(async ({ rows, cols }) => {
    if (tab.sessionId) {
      try {
        await invoke("resize_terminal", { sessionId: tab.sessionId, rows, cols });
      } catch (error) {
        console.error("Resize error:", error);
      }
    }
  });
}

async function initializeTab(tab: TerminalTab) {
  const terminalEl = document.getElementById("terminal");
  if (!terminalEl || !tab.id) return;

  const session = getActiveWorktreeSession();
  terminalEl.innerHTML = "";

  const { terminal, fitAddon } = makeTerminal();
  terminal.open(terminalEl);
  fitAddon.fit();

  const rowCount = terminal.rows;
  const colCount = terminal.cols;

  tab.terminal = terminal;
  tab.fitAddon = fitAddon;
  tab.rowCount = rowCount;
  tab.colCount = colCount;
  tab.isInitialized = true;

  if (tab.sessionId) {
    try {
      await invoke("close_terminal", { sessionId: tab.sessionId });
    } catch (e) {}
  }

  try {
    const sessionId = await invoke("spawn_terminal", {
      cwd: currentPath || null,
      rows: rowCount,
      cols: colCount,
    });

    tab.sessionId = sessionId as string;

    const unlistenData = await listen(`terminal-data-${sessionId}`, (event) => {
      terminal.write(event.payload as string);
    });

    const unlistenExit = await listen(`terminal-exited-${sessionId}`, () => {
      terminal.writeln("\r\n[Process exited]");
      const tabStillExists = session.tabs.some(t => t.id === tab.id);
      if (tabStillExists && session.tabs.length > 1) {
        setTimeout(() => {
          if (session.tabs.some(t => t.id === tab.id)) {
            closeTab(tab.id);
          }
        }, 500);
      }
    });

    tab.unlistenData = unlistenData;
    tab.unlistenExit = unlistenExit;

    wireTerminalInput(tab, terminal);

  } catch (error) {
    terminal.writeln(`\x1b[31mError starting terminal: ${error}\x1b[0m`);
  }
}

async function initializeNeovimTab(tab: TerminalTab, filePath?: string) {
  const terminalEl = document.getElementById("terminal");
  if (!terminalEl) return;

  terminalEl.innerHTML = "";

  const { terminal, fitAddon } = makeTerminal();
  terminal.open(terminalEl);
  fitAddon.fit();

  tab.terminal = terminal;
  tab.fitAddon = fitAddon;
  tab.rowCount = terminal.rows;
  tab.colCount = terminal.cols;
  tab.isInitialized = true;

  try {
    const result = await invoke<NeovimSpawnResult>("spawn_neovim", {
      cwd: currentPath || null,
      rows: tab.rowCount,
      cols: tab.colCount,
      filePath: filePath ?? null,
    });

    tab.sessionId = result.session_id;
    tab.nvimSocketPath = result.socket_path;

    const unlistenData = await listen(`terminal-data-${result.session_id}`, (event) => {
      terminal.write(event.payload as string);
    });

    const unlistenExit = await listen(`terminal-exited-${result.session_id}`, () => {
      terminal.writeln("\r\n[Neovim exited]");
      const session = getActiveWorktreeSession();
      const tabStillExists = session.tabs.some(t => t.id === tab.id);
      if (tabStillExists && session.tabs.length > 1) {
        setTimeout(() => {
          if (session.tabs.some(t => t.id === tab.id)) closeTab(tab.id);
        }, 500);
      }
    });

    tab.unlistenData = unlistenData;
    tab.unlistenExit = unlistenExit;

    wireTerminalInput(tab, terminal);

  } catch (error) {
    terminal.writeln(`\x1b[31mError starting Neovim: ${error}\x1b[0m`);
  }
}

async function closeTab(tabId: string) {
  const session = getActiveWorktreeSession();
  if (session.tabs.length <= 1) return;

  const tabIndex = session.tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return;

  const tab = session.tabs[tabIndex];

  if (isChatTab(tab)) {
    if (tab.unlistenEvent) {
      try { tab.unlistenEvent(); } catch (e) {}
    }
    if (tab.sessionId) {
      try {
        await fetch(`http://127.0.0.1:${opencodeServerPort}/session/${tab.sessionId}`, {
          method: 'DELETE',
        });
      } catch (e) {}
    }
  } else {
    if (tab.sessionId) {
      try {
        await invoke("close_terminal", { sessionId: tab.sessionId });
      } catch (error) {
        console.error("Error closing terminal:", error);
      }
    }

    if (tab.unlistenData) {
      try { tab.unlistenData(); } catch (e) {}
    }
    if (tab.unlistenExit) {
      try { tab.unlistenExit(); } catch (e) {}
    }
    if (tab.terminal) {
      try { tab.terminal.dispose(); } catch (e) {}
    }
  }

  session.tabs.splice(tabIndex, 1);

  if (session.activeTabId === tabId) {
    const newIndex = Math.min(tabIndex, session.tabs.length - 1);
    session.activeTabId = session.tabs[newIndex].id;
  }

  renderTabBar();

  const newActiveTab = session.tabs.find(t => t.id === session.activeTabId);
  if (newActiveTab && isTerminalTab(newActiveTab) && !newActiveTab.isInitialized) {
    await initializeTab(newActiveTab);
  }

  renderActiveContent();
}

function renderActiveContent() {
  const tab = getActiveTab();
  const terminalEl = document.getElementById("terminal");
  const chatEl = document.getElementById("chat-container");
  if (!terminalEl || !chatEl) {
    console.error("Terminal or chat container not found");
    return;
  }

  if (tab && isChatTab(tab)) {
    terminalEl.style.display = "none";
    chatEl.style.display = "flex";
    renderChatMessages(tab);
    requestAnimationFrame(() => {
      const input = document.getElementById("chat-input") as HTMLInputElement;
      input?.focus();
    });
  } else if (tab && isTerminalTab(tab) && tab.terminal) {
    chatEl.style.display = "none";
    terminalEl.style.display = "";
    try {
      terminalEl.replaceChildren((tab.terminal as any).element);
      requestAnimationFrame(() => tab.fitAddon?.fit());
    } catch (e) {
      console.error("Error rendering terminal:", e);
    }
  }

  updateStatusBar();
}

function updateStatusBar() {
  const tab = getActiveTab();
  const statusInfo = document.getElementById("status-info");
  if (!statusInfo) return;

  if (tab && isChatTab(tab)) {
    let modelText = "";
    if (currentModel) {
      modelText = ` [${currentModel.providerID}/${currentModel.modelID}]`;
    }
    statusInfo.textContent = `AI Chat${modelText} - Type and press Enter to send`;
  } else if (tab && isTerminalTab(tab) && tab.isNeovim) {
    statusInfo.textContent = "nvim — click files to open | :tabn/:tabp navigate | :q close";
  } else {
    statusInfo.textContent = "Terminal - Ctrl+C interrupt, Ctrl+D exit";
  }
}

// Worktree Functions

async function loadWorktrees() {
  try {
    const repoRoot = await invoke<string>("git_find_repo_root", { startPath: currentPath || "." });
    const worktrees = await invoke<WorktreeEntry[]>("git_worktree_list", { repoPath: repoRoot });

    worktreeSessions = worktrees.map(w => ({
      id: `worktree-${crypto.randomUUID()}`,
      path: w.path,
      branch: w.branch,
      isMain: w.is_main,
      tabs: [],
      activeTabId: "",
      nextTabIndex: 1,
      nextChatIndex: 1,
      isInitialized: false,
    }));

    isGitRepo = true;

    // If no worktrees found, create default from current dir
    if (worktreeSessions.length === 0) {
      worktreeSessions.push({
        id: `worktree-${crypto.randomUUID()}`,
        path: currentPath,
        branch: await invoke<string>("git_get_current_branch", { worktreePath: currentPath }),
        isMain: true,
        tabs: [],
        activeTabId: "",
        nextTabIndex: 1,
        nextChatIndex: 1,
        isInitialized: false,
      });
    }

    // Set first worktree as active
    if (worktreeSessions.length > 0 && !activeWorktreeSessionId) {
      activeWorktreeSessionId = worktreeSessions[0].id;
    }

    renderWorktreeList();
  } catch (error) {
    console.log("Not a git repository:", error);
    isGitRepo = false;

    // Create default session for non-git repos
    worktreeSessions = [{
      id: `worktree-${crypto.randomUUID()}`,
      path: currentPath,
      branch: "",
      isMain: true,
      tabs: [],
      activeTabId: "",
      nextTabIndex: 1,
      nextChatIndex: 1,
      isInitialized: false,
    }];
    activeWorktreeSessionId = worktreeSessions[0].id;

    renderWorktreeList();
  }
}

function renderWorktreeList() {
  const worktreeList = document.getElementById("worktree-list");
  const worktreeEmpty = document.getElementById("worktree-empty");
  const newBtn = document.getElementById("new-worktree-btn") as HTMLButtonElement;

  if (!worktreeList) return;

  if (!isGitRepo) {
    if (worktreeEmpty) worktreeEmpty.style.display = "block";
    worktreeList.style.display = "none";
    if (newBtn) newBtn.disabled = true;
    return;
  }

  if (worktreeEmpty) worktreeEmpty.style.display = "none";
  worktreeList.style.display = "block";
  if (newBtn) newBtn.disabled = false;

  worktreeList.innerHTML = "";

  worktreeSessions.forEach(session => {
    const item = document.createElement("div");
    item.className = `worktree-item${session.id === activeWorktreeSessionId ? " active" : ""}${session.branch === "detached HEAD" ? " worktree-item-detached" : ""}`;

    const branchDisplay = session.branch === "detached HEAD" ? "detached HEAD" : session.branch;
    const tabCount = session.tabs.length;

    item.innerHTML = `
      <span class="worktree-branch">${branchDisplay}</span>
      ${tabCount > 0 ? `<span class="worktree-tab-count">${tabCount}</span>` : ''}
    `;

    item.addEventListener("click", () => switchWorktreeSession(session.id));
    worktreeList.appendChild(item);
  });
}

async function switchWorktreeSession(sessionId: string) {
  // Save current session's active tab
  const currentSession = worktreeSessions.find(s => s.id === activeWorktreeSessionId);
  if (currentSession) {
    // activeTabId is saved in the session object
  }

  activeWorktreeSessionId = sessionId;
  const session = getActiveWorktreeSession();

  // Update currentPath to worktree path
  currentPath = session.path;

  // Update file browser
  loadDirectory(currentPath);

  // Render the tab bar and active content for this session
  renderTabBar();
  renderActiveContent();

  // Update worktree list highlighting
  renderWorktreeList();

  updateStatusBar();
}

async function createWorktreeSession(branch: string, customPath?: string) {
  try {
    const repoRoot = await invoke<string>("git_find_repo_root", { startPath: currentPath });

    let worktreePath = customPath;
    if (!worktreePath) {
      // Generate default path: <repo-parent>/<branch>
      const parentDir = repoRoot.substring(0, repoRoot.lastIndexOf("/"));
      worktreePath = `${parentDir}/${branch}`;
    }

    await invoke("git_worktree_add", {
      repoPath: repoRoot,
      worktreePath,
      branch: branch || null,
    });

    const newBranch = await invoke<string>("git_get_current_branch", { worktreePath });

    const newSession: WorktreeSession = {
      id: `worktree-${crypto.randomUUID()}`,
      path: worktreePath,
      branch: newBranch,
      isMain: false,
      tabs: [],
      activeTabId: "",
      nextTabIndex: 1,
      nextChatIndex: 1,
      isInitialized: false,
    };

    worktreeSessions.push(newSession);

    // Switch to new session
    await switchWorktreeSession(newSession.id);

    // Initialize first terminal tab
    await createTab(false);

  } catch (error) {
    console.error("Failed to create worktree:", error);
    const errorEl = document.getElementById("worktree-modal-error");
    if (errorEl) {
      errorEl.textContent = `Error: ${error}`;
      errorEl.style.display = "block";
    }
  }
}

async function initWorktreeSessions() {
  await loadWorktrees();

  // Initialize first tab for active session
  const session = getActiveWorktreeSession();
  if (session.tabs.length === 0) {
    await createTab(false);
  }
}

async function createTab(isNeovim: boolean = false) {
  const container = document.getElementById("terminal-container");
  const mainContent = document.getElementById("main-content");
  const session = getActiveWorktreeSession();

  container?.classList.remove("collapsed");
  container?.classList.add("full-height");
  if (mainContent) mainContent.style.display = "none";

  const tabId = `tab-${crypto.randomUUID()}`;
  const tabName = isNeovim ? `nvim ${session.nextTabIndex++}` : `Terminal ${session.nextTabIndex++}`;

  const newTab: TerminalTab = {
    id: tabId,
    sessionId: null,
    name: tabName,
    isNeovim,
    nvimSocketPath: null,
    terminal: null,
    fitAddon: null,
    unlistenData: null,
    unlistenExit: null,
    rowCount: 24,
    colCount: 80,
    isActive: false,
    isInitialized: false,
  };

  session.tabs.push(newTab);
  session.activeTabId = tabId;
  renderTabBar();

  await initializeTab(newTab);

  renderActiveContent();
  updateStatusBar();
}

async function createNeovimTab(filePath?: string): Promise<TerminalTab> {
  const container = document.getElementById("terminal-container");
  const mainContent = document.getElementById("main-content");
  const session = getActiveWorktreeSession();

  container?.classList.remove("collapsed");
  container?.classList.add("full-height");
  if (mainContent) mainContent.style.display = "none";

  const tabId = `tab-${crypto.randomUUID()}`;
  const tabName = `nvim ${session.nextTabIndex++}`;

  const newTab: TerminalTab = {
    id: tabId,
    sessionId: null,
    name: tabName,
    isNeovim: true,
    nvimSocketPath: null,
    terminal: null,
    fitAddon: null,
    unlistenData: null,
    unlistenExit: null,
    rowCount: 24,
    colCount: 80,
    isActive: false,
    isInitialized: false,
  };

  session.tabs.push(newTab);
  session.activeTabId = tabId;
  renderTabBar();

  await initializeNeovimTab(newTab, filePath);

  renderActiveContent();
  updateStatusBar();

  return newTab;
}

async function openInNeovim(filePath: string) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const activeTab = getActiveTab();
  const session = getActiveWorktreeSession();

  if (activeTab && isTerminalTab(activeTab) && activeTab.isNeovim && activeTab.nvimSocketPath) {
    try {
      await invoke("nvim_open_file", {
        socketPath: activeTab.nvimSocketPath,
        filePath: normalizedPath,
      });
      return;
    } catch (error) {
      console.error("nvim_open_file failed:", error);
      activeTab.nvimSocketPath = null;
    }
  }

  const existingNeovimTab = session.tabs.find(
    t => isTerminalTab(t) && t.isNeovim && t.nvimSocketPath && t.id !== session.activeTabId
  );
  if (existingNeovimTab && isTerminalTab(existingNeovimTab) && existingNeovimTab.nvimSocketPath) {
    await switchTab(existingNeovimTab.id);
    try {
      await invoke("nvim_open_file", {
        socketPath: existingNeovimTab.nvimSocketPath,
        filePath: normalizedPath,
      });
      return;
    } catch (error) {
      console.error("nvim_open_file failed:", error);
      existingNeovimTab.nvimSocketPath = null;
    }
  }

  await createNeovimTab(normalizedPath);
}

async function createChatTab() {
  console.log("Creating chat tab...");
  const session = getActiveWorktreeSession();
  const tabId = `chat-${crypto.randomUUID()}`;
  const tabName = `Chat ${session.nextChatIndex++}`;

  const newTab: ChatTab = {
    id: tabId,
    type: 'chat',
    name: tabName,
    sessionId: null,
    messages: [],
    isStreaming: false,
    unlistenEvent: null,
    isInitialized: true,
  };

  session.tabs.push(newTab);
  session.activeTabId = tabId;
  renderTabBar();

  try {
    console.log("Initializing OpenCode client, port:", opencodeServerPort);
    await initOpenCodeClient();
    console.log("OpenCode client initialized, creating session on port:", opencodeServerPort);

    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    console.log("Session creation response status:", resp.status);
    const session_data = await resp.json();
    console.log("Session created:", JSON.stringify(session_data));
    newTab.sessionId = session_data.id;
    if (session_data.title) {
      newTab.name = session_data.title;
      renderTabBar();
    }

    // Set default model
    if (providers.length >0) {
      const firstProvider = providers[0];
      const defaultModelId = defaultModels[firstProvider.id];
      if (defaultModelId) {
        currentModel = { providerID: firstProvider.id, modelID: defaultModelId };
      }
    }
    updateModelSelector();
  } catch (error) {
    console.error("Failed to create chat session:", error);
    newTab.messages.push({
      role: 'assistant',
      content: 'Failed to connect to OpenCode server. Please ensure the server is running.',
      timestamp: Date.now(),
    });
  }

  renderActiveContent();
  updateStatusBar();
}

function renderChatMessages(tab: ChatTab) {
  console.log("renderChatMessages called, messages count:", tab.messages.length);
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) {
    console.error("chat-messages element not found");
    return;
  }

  chatMessages.innerHTML = '';
  tab.messages.forEach((msg) => {
    const msgEl = document.createElement("div");
    msgEl.className = `chat-message ${msg.role}`;
    const content = msg.role === 'assistant'
      ? marked.parse(msg.content, { breaks: true })
      : escapeHtml(msg.content);
    msgEl.innerHTML = `<div class="message-content">${content}</div>`;
    chatMessages.appendChild(msgEl);
  });

  if (tab.isStreaming) {
    const streamingEl = document.createElement("div");
    streamingEl.className = "chat-message assistant streaming";
    streamingEl.innerHTML = '<div class="message-content"><span class="thinking-label">Thinking</span><span class="cursor-blink">▋</span></div>';
    chatMessages.appendChild(streamingEl);
  }

  const sendBtn = document.getElementById("chat-send") as HTMLButtonElement | null;
  if (sendBtn) sendBtn.disabled = tab.isStreaming;

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChatMessage(text: string) {
  const tab = getActiveTab();
  if (!tab || !isChatTab(tab) || tab.isStreaming || !tab.sessionId) return;

  console.log("Sending message to session:", tab.sessionId, "text:", text);

  tab.messages.push({ role: 'user', content: text, timestamp: Date.now() });
  tab.isStreaming = true;
  renderChatMessages(tab);

  try {
    const body: any = {
      parts: [{ type: 'text', text }],
    };

    if (currentModel) {
      body.model = currentModel;
    }

    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/session/${tab.sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    console.log("Message POST response status:", resp.status);
    const data = await resp.json();
    console.log("POST response data:", JSON.stringify(data));

    let assistantText = '';
    if (data.parts && Array.isArray(data.parts)) {
      for (const part of data.parts) {
        if (part.type === 'text' && part.text) {
          assistantText += part.text;
        }
      }
    }

    console.log("Extracted assistant text:", assistantText.substring(0, 100));
    tab.messages.push({ role: 'assistant', content: assistantText, timestamp: Date.now() });
    tab.isStreaming = false;
    renderChatMessages(tab);

  } catch (error) {
    console.error("Failed to send message:", error);
    tab.isStreaming = false;
    renderChatMessages(tab);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadConfig();
    const cwd: string = await invoke("get_current_dir");
    currentPath = cwd;

    // Initialize worktree sessions
    await initWorktreeSessions();

    // Worktree event listeners
    document.querySelector(".new-worktree-btn")?.addEventListener("click", () => {
      if (!isGitRepo) return;
      const modal = document.getElementById("worktree-modal");
      if (modal) modal.style.display = "flex";
    });

    document.getElementById("refresh-worktrees-btn")?.addEventListener("click", () => {
      loadWorktrees();
    });

    document.getElementById("worktree-modal-cancel")?.addEventListener("click", () => {
      const modal = document.getElementById("worktree-modal");
      if (modal) modal.style.display = "none";
      const branchInput = document.getElementById("worktree-branch-input") as HTMLInputElement;
      const pathInput = document.getElementById("worktree-path-input") as HTMLInputElement;
      const errorEl = document.getElementById("worktree-modal-error");
      if (branchInput) branchInput.value = "";
      if (pathInput) pathInput.value = "";
      if (errorEl) errorEl.style.display = "none";
    });

    document.getElementById("worktree-modal-create")?.addEventListener("click", async () => {
      const branchInput = document.getElementById("worktree-branch-input") as HTMLInputElement;
      const pathInput = document.getElementById("worktree-path-input") as HTMLInputElement;
      const errorEl = document.getElementById("worktree-modal-error");
      const branch = branchInput?.value.trim();
      const path = pathInput?.value.trim();

      if (!branch) {
        if (errorEl) { errorEl.textContent = "Please enter a branch name."; errorEl.style.display = "block"; }
        return;
      }

      if (errorEl) errorEl.style.display = "none";
      await createWorktreeSession(branch, path || undefined);

      // Only hide modal if no error was shown
      if (!errorEl || errorEl.style.display === "none") {
        const modal = document.getElementById("worktree-modal");
        if (modal) modal.style.display = "none";
        if (branchInput) branchInput.value = "";
        if (pathInput) pathInput.value = "";
      }
    });

    document.querySelector(".new-tab")?.addEventListener("click", () => createTab(false));
    document.querySelector(".new-chat")?.addEventListener("click", () => createChatTab());

    const terminalEl = document.getElementById("terminal");
    if (terminalEl) {
      let resizeTimeout: number | null = null;
      const ro = new ResizeObserver(() => {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = window.setTimeout(() => {
          const tab = getActiveTab();
          if (tab && isTerminalTab(tab) && tab.fitAddon) tab.fitAddon.fit();
        }, 100);
      });
      ro.observe(terminalEl);
    }

    const chatInput = document.getElementById("chat-input") as HTMLTextAreaElement;
    const chatSend = document.getElementById("chat-send");
    if (chatInput && chatSend) {
      const autoResize = () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
      };

      chatInput.addEventListener("input", autoResize);

      chatSend.addEventListener("click", () => {
        const text = chatInput.value.trim();
        if (text) {
          sendChatMessage(text);
          chatInput.value = '';
          chatInput.style.height = 'auto';
        }
      });
      chatInput.addEventListener("keydown", (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const text = chatInput.value.trim();
          if (text) {
            sendChatMessage(text);
            chatInput.value = '';
            chatInput.style.height = 'auto';
          }
        }
      });
    }

    wireAppKeydownHandler();

    const newSessionBtn = document.getElementById("new-session-btn");
    newSessionBtn?.addEventListener("click", () => createChatTab());

    setTimeout(async () => {
      await initOpenCodeClient();
      loadSessions();
      await fetchProviders();
      updateModelSelector();
    }, 1000);

    document.querySelectorAll(".collapse-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const btnEl = btn as HTMLElement;
        const targetId = btnEl.dataset.target;
        if (!targetId) return;
        const sidebar = document.getElementById(targetId);
        if (sidebar) {
          sidebar.classList.toggle("collapsed");
          const isCollapsed = sidebar.classList.contains("collapsed");
          btnEl.setAttribute("aria-expanded", String(!isCollapsed));
          setTimeout(() => {
            const tab = getActiveTab();
            if (tab && isTerminalTab(tab) && tab.fitAddon) {
              tab.fitAddon.fit();
            }
          }, 300);
        }
      });
    });
  } catch (error) {
    console.error("Error initializing:", error);
  }
});
