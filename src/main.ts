import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { marked } from "marked";

const ICON_FOLDER = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1.5 4.5A1 1 0 012.5 3.5h3.086a1 1 0 01.707.293L7.5 5h6a1 1 0 011 1v6a1 1 0 01-1 1h-11a1 1 0 01-1-1V4.5z" fill="#e0e0e0" fill-opacity="0.7"/></svg>`;

const ICON_FILE = `<svg width="16" height="16" viewBox="0 1 14 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 1.5h7l3 3V14.5H2V1.5z" stroke="#e0e0e0" stroke-opacity="0.6" stroke-width="1.2" fill="none"/><path d="M9 1.5V4.5h3" stroke="#e0e0e0" stroke-opacity="0.6" stroke-width="1.2" fill="none"/></svg>`;
const ICON_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_CHAT = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 3h12a1 1 0 011 1v7a1 1 0 01-1 1H6l-3 3v-3H2a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="#e0e0e0" stroke-opacity="0.7" stroke-width="1.2" fill="none"/></svg>`;

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

type Tab = TerminalTab | ChatTab;

let currentPath: string = "";
let tabs: Tab[] = [];
let activeTabId: string = "";
let nextTabIndex: number = 1;
let nextChatIndex: number = 1;
let config: Config = {
  keybinds: {
    next_tab: "Ctrl+Tab",
    prev_tab: "Ctrl+Shift+Tab",
    new_terminal: "Ctrl+T",
    new_chat: "Ctrl+C",
    close_terminal: "Ctrl+W",
  }
};
let opencodeServerPort: number = 4096;
let opencodeReadyPromise: Promise<void> | null = null;
let opencodeReadyResolver: (() => void) | null = null;

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
      sessionEl.dataset.sessionId = session.id;

      // Check if this session is currently active
      const activeTab = tabs.find(t => isChatTab(t) && t.sessionId === session.id);
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

      const deleteBtn = sessionEl.querySelector(".session-item-delete");
      deleteBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`Delete session "${session.title}"?`)) {
          deleteSession(session.id);
        }
      });

      sessionList.appendChild(sessionEl);
    });
  });
}

async function switchToSession(session: SessionInfo) {
  console.log("Switching to session:", session.id, session.title);

  // Check if we already have a tab for this session
  const existingTab = tabs.find(t => isChatTab(t) && t.sessionId === session.id) as ChatTab | undefined;
  if (existingTab) {
    await switchTab(existingTab.id);
    return;
  }

  // Create a new tab for this session
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

  tabs.push(newTab);
  activeTabId = tabId;
  renderTabBar();
  renderActiveContent();
  updateStatusBar();

  // Load messages for this session
  loadSessionMessages(session.id);
}

async function loadSessionMessages(sessionId: string) {
  try {
    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/session/${sessionId}/message`);
    if (!resp.ok) return;
    const data = await resp.json();
    console.log("Loaded messages:", data.length);

    const tab = tabs.find(t => isChatTab(t) && t.sessionId === sessionId) as ChatTab | undefined;
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

      // Close tab if open
      const tab = tabs.find(t => isChatTab(t) && t.sessionId === sessionId);
      if (tab) {
        await closeTab(tab.id);
      }
    }
  } catch (error) {
    console.error("Error deleting session:", error);
  }
}

function getActiveTab(): Tab | undefined {
  return tabs.find(t => t.id === activeTabId);
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
    // Deep merge: preserve defaults, overlay loaded values, merge keybinds
    config = {
      ...config,
      ...result,
      keybinds: {
        ...config.keybinds,
        ...(result?.keybinds || {}),
      },
    };
  } catch (error) {
    console.error("Error loading config:", error);
  }
}

function matchesKeybind(e: KeyboardEvent, keybind: string): boolean {
  if (!keybind) return false;
  const parts = keybind.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const hasAlt = parts.includes("alt");
  const hasShift = parts.includes("shift");
  const hasCtrl = parts.includes("ctrl");

  return (
    e.key.toLowerCase() === key &&
    e.altKey === hasAlt &&
    e.shiftKey === hasShift &&
    e.ctrlKey === hasCtrl
  );
}

function wireAppKeydownHandler() {
  document.addEventListener("keydown", async (e) => {
    const currentIndex = tabs.findIndex(t => t.id === activeTabId);
    const activeTab = getActiveTab();

    if (matchesKeybind(e, config.keybinds.new_chat)) {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (activeTab && isTerminalTab(activeTab) && document.activeElement?.closest('#terminal')) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      await createChatTab();
      return;
    }

    if (matchesKeybind(e, config.keybinds.next_tab)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
      await switchTab(tabs[nextIndex].id);
      return;
    }

    if (matchesKeybind(e, config.keybinds.prev_tab)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
      await switchTab(tabs[prevIndex].id);
      return;
    }

    if (matchesKeybind(e, config.keybinds.new_terminal)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await createTab(false);
      return;
    }

    if (matchesKeybind(e, config.keybinds.close_terminal)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await closeTab(activeTabId);
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

function renderFileList(files: FileEntry[]) {
  const fileList = document.getElementById("file-list");
  if (!fileList) return;

  fileList.innerHTML = "";

  if (currentPath !== "/") {
    const parentDir = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
    const parentEntry = document.createElement("div");
    parentEntry.className = "file-entry folder";
    parentEntry.innerHTML = `<span class="icon">${ICON_FOLDER}</span><span class="name">..</span>`;
    parentEntry.addEventListener("click", () => loadDirectory(parentDir));
    fileList.appendChild(parentEntry);
  }

  for (const file of files) {
    const entry = document.createElement("div");
    if (file.is_dir) {
      entry.className = "file-entry folder";
      entry.innerHTML = `<span class="icon">${ICON_FOLDER}</span><span class="name">${file.name}</span>`;
      entry.addEventListener("click", () => loadDirectory(file.path));
    } else {
      entry.className = "file-entry file";
      entry.innerHTML = `<span class="icon">${ICON_FILE}</span><span class="name">${file.name}</span>`;
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

  tabs.forEach(tab => {
    const tabEl = document.createElement("div");
    tabEl.className = `tab ${tab.id === activeTabId ? "active" : ""}`;
    tabEl.dataset.tabId = tab.id;
    const icon = isChatTab(tab) ? ICON_CHAT : '';
    tabEl.innerHTML = `
      <span class="tab-icon">${icon}</span>
      <span class="tab-name">${tab.name}</span>
      ${tabs.length > 1 ? '<span class="tab-close">×</span>' : ''}
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
  const newTab = tabs.find(t => t.id === tabId);
  if (!newTab) return;

  if (isTerminalTab(newTab) && !newTab.isInitialized) {
    await initializeTab(newTab);
  }

  activeTabId = tabId;
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
      const tabStillExists = tabs.some(t => t.id === tab.id);
      if (tabStillExists && tabs.length > 1) {
        setTimeout(() => {
          if (tabs.some(t => t.id === tab.id)) {
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
      const tabStillExists = tabs.some(t => t.id === tab.id);
      if (tabStillExists && tabs.length > 1) {
        setTimeout(() => {
          if (tabs.some(t => t.id === tab.id)) closeTab(tab.id);
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
  if (tabs.length <= 1) return;

  const tabIndex = tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return;

  const tab = tabs[tabIndex];

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

  tabs.splice(tabIndex, 1);

  if (activeTabId === tabId) {
    const newIndex = Math.min(tabIndex, tabs.length - 1);
    activeTabId = tabs[newIndex].id;
  }

  renderTabBar();

  const newActiveTab = tabs.find(t => t.id === activeTabId);
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

  console.log("renderActiveContent, tab:", tab?.id, "isChatTab:", tab ? isChatTab(tab) : 'no tab');

  if (tab && isChatTab(tab)) {
    console.log("Showing chat container");
    terminalEl.style.display = "none";
    chatEl.style.display = "flex";
    renderChatMessages(tab);
    requestAnimationFrame(() => {
      const input = document.getElementById("chat-input") as HTMLInputElement;
      input?.focus();
    });
  } else if (tab && isTerminalTab(tab) && tab.terminal) {
    console.log("Showing terminal");
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
    statusInfo.textContent = "AI Chat - Type and press Enter to send";
  } else if (tab && isTerminalTab(tab) && tab.isNeovim) {
    statusInfo.textContent = "nvim — click files to open | :tabn/:tabp navigate | :q close";
  } else {
    statusInfo.textContent = "Terminal - Ctrl+C interrupt, Ctrl+D exit";
  }
}

async function createTab(isNeovim: boolean = false) {
  const container = document.getElementById("terminal-container");
  const mainContent = document.getElementById("main-content");

  container?.classList.remove("collapsed");
  container?.classList.add("full-height");
  if (mainContent) mainContent.style.display = "none";
  const toggleBtn = document.getElementById("toggle-terminal");
  if (toggleBtn) toggleBtn.innerHTML = ICON_CHEVRON_DOWN;

  const tabId = `tab-${crypto.randomUUID()}`;
  const tabName = isNeovim ? `nvim ${nextTabIndex++}` : `Terminal ${nextTabIndex++}`;

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

  tabs.push(newTab);
  activeTabId = tabId;
  renderTabBar();

  await initializeTab(newTab);

  renderActiveContent();
  updateStatusBar();
}

async function createNeovimTab(filePath?: string): Promise<TerminalTab> {
  const container = document.getElementById("terminal-container");
  const mainContent = document.getElementById("main-content");

  container?.classList.remove("collapsed");
  container?.classList.add("full-height");
  if (mainContent) mainContent.style.display = "none";
  const toggleBtn = document.getElementById("toggle-terminal");
  if (toggleBtn) toggleBtn.innerHTML = ICON_CHEVRON_DOWN;

  const tabId = `tab-${crypto.randomUUID()}`;
  const tabName = `nvim ${nextTabIndex++}`;

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

  tabs.push(newTab);
  activeTabId = tabId;
  renderTabBar();

  await initializeNeovimTab(newTab, filePath);

  renderActiveContent();
  updateStatusBar();

  return newTab;
}

async function openInNeovim(filePath: string) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const activeTab = getActiveTab();

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

  const existingNeovimTab = tabs.find(
    t => isTerminalTab(t) && t.isNeovim && t.nvimSocketPath && t.id !== activeTabId
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
  const tabId = `chat-${crypto.randomUUID()}`;
  const tabName = `Chat ${nextChatIndex++}`;

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

  tabs.push(newTab);
  activeTabId = tabId;
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
    const session = await resp.json();
    console.log("Session created:", JSON.stringify(session));
    newTab.sessionId = session.id;
    if (session.title) {
      newTab.name = session.title;
      // Re-render tab bar with the new title
      renderTabBar();
    }
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
  tab.messages.forEach((msg, idx) => {
    console.log(`Rendering message ${idx}:`, msg.role, msg.content.substring(0, 50));
    const msgEl = document.createElement("div");
    msgEl.className = `chat-message ${msg.role}`;
    const content = msg.role === 'assistant'
      ? marked.parse(msg.content, { breaks: true })
      : msg.content;
    msgEl.innerHTML = `<div class="message-content">${content}</div>`;
    chatMessages.appendChild(msgEl);
  });

  if (tab.isStreaming) {
    const streamingEl = document.createElement("div");
    streamingEl.className = "chat-message assistant streaming";
    streamingEl.innerHTML = '<div class="message-content"><span class="cursor-blink">▋</span></div>';
    chatMessages.appendChild(streamingEl);
  }

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
    console.log("Sending POST to /session/{id}/message");
    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/session/${tab.sessionId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text }],
      }),
    });
    
    console.log("Message POST response status:", resp.status);
    const data = await resp.json();
    console.log("POST response data:", JSON.stringify(data));
    
    // Extract text from parts
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

async function initFirstTab() {
  await createTab(false);
}

function toggleTerminal() {
  const container = document.getElementById("terminal-container");
  const mainContent = document.getElementById("main-content");
  const toggleBtn = document.getElementById("toggle-terminal");
  if (!container || !toggleBtn) return;

  if (container.classList.contains("collapsed")) {
    container.classList.remove("collapsed");
    container.classList.remove("full-height");
    if (mainContent) mainContent.style.display = "";
    toggleBtn.innerHTML = ICON_CHEVRON_DOWN;
    container.addEventListener("transitionend", () => {
      const tab = getActiveTab();
      if (tab && isTerminalTab(tab) && tab.fitAddon) tab.fitAddon.fit();
    }, { once: true });
  } else if (container.classList.contains("full-height")) {
    container.classList.remove("full-height");
    if (mainContent) mainContent.style.display = "";
    toggleBtn.innerHTML = ICON_CHEVRON_DOWN;
    container.addEventListener("transitionend", () => {
      const tab = getActiveTab();
      if (tab && isTerminalTab(tab) && tab.fitAddon) tab.fitAddon.fit();
    }, { once: true });
  } else {
    container.classList.add("collapsed");
    container.classList.remove("full-height");
    toggleBtn.innerHTML = ICON_CHEVRON_RIGHT;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    await loadConfig();
    const cwd: string = await invoke("get_current_dir");
    currentPath = cwd;
    loadDirectory(cwd);
    await initFirstTab();

    document.getElementById("toggle-terminal")?.addEventListener("click", toggleTerminal);
    document.querySelector(".new-tab")?.addEventListener("click", () => createTab(false));
    document.querySelector(".new-chat")?.addEventListener("click", () => createChatTab());

    const terminalEl = document.getElementById("terminal");
    if (terminalEl) {
      const ro = new ResizeObserver(() => {
        const tab = getActiveTab();
        if (tab && isTerminalTab(tab) && tab.fitAddon) tab.fitAddon.fit();
      });
      ro.observe(terminalEl);
    }

    const chatInput = document.getElementById("chat-input") as HTMLInputElement;
    const chatSend = document.getElementById("chat-send");
    if (chatInput && chatSend) {
      chatSend.addEventListener("click", () => {
        const text = chatInput.value.trim();
        if (text) {
          sendChatMessage(text);
          chatInput.value = '';
        }
      });
      chatInput.addEventListener("keydown", (e) => {
        if (e.key === 'Enter') {
          const text = chatInput.value.trim();
          if (text) {
            sendChatMessage(text);
            chatInput.value = '';
          }
        }
      });
    }

    wireAppKeydownHandler();

    // Initialize session sidebar
    const newSessionBtn = document.getElementById("new-session-btn");
    newSessionBtn?.addEventListener("click", () => createChatTab());

    // Load sessions after OpenCode client is ready
    setTimeout(async () => {
      await initOpenCodeClient();
      loadSessions();
    }, 1000);
  } catch (error) {
    console.error("Error initializing:", error);
  }
});
