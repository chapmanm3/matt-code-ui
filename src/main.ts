import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const ICON_FOLDER = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M1.5 4.5A1 1 0 012.5 3.5h3.086a1 1 0 01.707.293L7.5 5h6a1 1 0 011 1v6a1 1 0 01-1 1h-11a1 1 0 01-1-1V4.5z" fill="#e0e0e0" fill-opacity="0.7"/></svg>`;

const ICON_FILE = `<svg width="16" height="16" viewBox="0 1 14 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 1.5h7l3 3V14.5H2V1.5z" stroke="#e0e0e0" stroke-opacity="0.6" stroke-width="1.2" fill="none"/><path d="M9 1.5V4.5h3" stroke="#e0e0e0" stroke-opacity="0.6" stroke-width="1.2" fill="none"/></svg>`;
const ICON_CHEVRON_DOWN = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_CHEVRON_RIGHT = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_file: boolean;
}

interface TerminalTab {
  id: string;
  sessionId: string | null;
  name: string;
  isNeovim: boolean;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  unlistenData: UnlistenFn | null;
  unlistenExit: UnlistenFn | null;
  rowCount: number;
  colCount: number;
  isActive: boolean;
  isInitialized: boolean;
}

let currentPath: string = "";
let tabs: TerminalTab[] = [];
let activeTabId: string = "";
let nextTabIndex: number = 1;

function getActiveTab(): TerminalTab | undefined {
  return tabs.find(t => t.id === activeTabId);
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
    tabEl.innerHTML = `
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

  if (!newTab.isInitialized) {
    await initializeTab(newTab);
  }

  activeTabId = tabId;
  renderTabBar();
  renderActiveTerminal();
  updateStatusBar();
}

async function initializeTab(tab: TerminalTab) {
  const terminalEl = document.getElementById("terminal");
  if (!terminalEl || !tab.id) return;

  terminalEl.innerHTML = "";

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

  } catch (error) {
    terminal.writeln(`\x1b[31mError starting terminal: ${error}\x1b[0m`);
  }
}

async function closeTab(tabId: string) {
  if (tabs.length <= 1) return;

  const tabIndex = tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return;

  const tab = tabs[tabIndex];

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

  tab.sessionId = null;
  tab.terminal = null;

  tabs.splice(tabIndex, 1);

  if (activeTabId === tabId) {
    const newIndex = Math.min(tabIndex, tabs.length - 1);
    activeTabId = tabs[newIndex].id;
  }

  renderTabBar();

  const newActiveTab = tabs.find(t => t.id === activeTabId);
  if (newActiveTab && !newActiveTab.isInitialized) {
    await initializeTab(newActiveTab);
  }

  renderActiveTerminal();
}

function renderActiveTerminal() {
  const tab = getActiveTab();
  const terminalEl = document.getElementById("terminal");
  if (!terminalEl) return;

  if (tab?.terminal) {
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

  if (tab?.isNeovim) {
    statusInfo.textContent = "nvim - :tabe for new file, :tabn/:tabp navigate, :q close";
  } else {
    statusInfo.textContent = "Terminal - Ctrl+C interrupt, Ctrl+D exit";
  }
}

async function createTab(isNeovim: boolean = false, filePath?: string) {
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

  if (isNeovim && filePath && newTab.sessionId) {
    const normalizedPath = filePath.replace(/\\/g, "/");
    await invoke("write_to_terminal", {
      sessionId: newTab.sessionId,
      data: `nvim ${normalizedPath}\r`,
    });
  }

  renderActiveTerminal();
  updateStatusBar();
}

async function openInNeovim(filePath: string) {
  const activeTab = getActiveTab();
  
  const normalizedPath = filePath.replace(/\\/g, "/");
  
  if (activeTab?.isNeovim && activeTab.sessionId) {
    await invoke("write_to_terminal", {
      sessionId: activeTab.sessionId,
      data: `:tabe ${normalizedPath}\r`,
    });
  } else {
    const existingNeovimTab = tabs.find(t => t.isNeovim && t.sessionId && t.id !== activeTabId);
    if (existingNeovimTab && existingNeovimTab.sessionId) {
      await switchTab(existingNeovimTab.id);
      await invoke("write_to_terminal", {
        sessionId: existingNeovimTab.sessionId,
        data: `:tabe ${normalizedPath}\r`,
      });
    } else {
      await createTab(true, filePath);
    }
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
    container.addEventListener("transitionend", () => getActiveTab()?.fitAddon?.fit(), { once: true });
  } else if (container.classList.contains("full-height")) {
    container.classList.remove("full-height");
    if (mainContent) mainContent.style.display = "";
    toggleBtn.innerHTML = ICON_CHEVRON_DOWN;
    container.addEventListener("transitionend", () => getActiveTab()?.fitAddon?.fit(), { once: true });
  } else {
    container.classList.add("collapsed");
    container.classList.remove("full-height");
    toggleBtn.innerHTML = ICON_CHEVRON_RIGHT;
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  try {
    const cwd: string = await invoke("get_current_dir");
    currentPath = cwd;
    loadDirectory(cwd);
    await initFirstTab();

    document.getElementById("toggle-terminal")?.addEventListener("click", toggleTerminal);
    document.querySelector(".new-tab")?.addEventListener("click", () => createTab(false));

    const terminalEl = document.getElementById("terminal");
    if (terminalEl) {
      const ro = new ResizeObserver(() => {
        getActiveTab()?.fitAddon?.fit();
      });
      ro.observe(terminalEl);
    }

    window.addEventListener("keydown", async (e) => {
      if (e.altKey || e.metaKey) {
        const currentIndex = tabs.findIndex(t => t.id === activeTabId);
        
        switch (e.key) {
          case "Tab":
            e.preventDefault();
            if (e.shiftKey) {
              const prevIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
              await switchTab(tabs[prevIndex].id);
            } else {
              const nextIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
              await switchTab(tabs[nextIndex].id);
            }
            break;
          case "t":
            e.preventDefault();
            await createTab(false);
            break;
          case "w":
            e.preventDefault();
            await closeTab(activeTabId);
            break;
        }
      }
    });
  } catch (error) {
    console.error("Error initializing:", error);
  }
});