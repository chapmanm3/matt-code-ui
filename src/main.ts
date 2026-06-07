import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { marked } from "marked";
import DOMPurify from "dompurify";
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

const ICON_FOLDER = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 4.5A1 1 0 012.5 3.5h3.086a1 1 0 01.707.293L7.5 5h6a1 1 0 011 1v6a1 1 0 01-1 1h-11a1 1 0 01-1-1V4.5z" fill="currentColor" fill-opacity="0.65"/></svg>`;
const ICON_FILE = `<svg width="11" height="13" viewBox="0 0 14 16" fill="none" aria-hidden="true"><path d="M2 1.5h7l3 3V14.5H2V1.5z" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2"/><path d="M9 1.5V4.5h3" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.2"/></svg>`;
const ICON_CHAT = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1.5 3a1.5 1.5 0 011.5-1.5h6A1.5 1.5 0 0110.5 3v4A1.5 1.5 0 019 8.5H5l-2.5 2V8.5H3A1.5 1.5 0 011.5 7V3z" stroke="currentColor" stroke-width="1.1"/></svg>`;
const ICON_TERMINAL = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 3.5l2 2-2 2M5.5 8H9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_BRANCH = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="3" cy="2.5" r="1.3" stroke="currentColor" stroke-width="1.1"/><circle cx="3" cy="9.5" r="1.3" stroke="currentColor" stroke-width="1.1"/><circle cx="9" cy="5.5" r="1.3" stroke="currentColor" stroke-width="1.1"/><path d="M3 4v4M3 7c0-2 2-3 4-3" stroke="currentColor" stroke-width="1.1"/></svg>`;

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

interface Project {
  id: string;
  name: string;
  path: string;
}

interface Config {
  keybinds: Keybinds;
  projects: Array<{ id: string; name: string; path: string }>;
  active_project_id: string | null;
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
  projectId: string;
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

let projects: Project[] = [];
let activeProjectId: string | null = null;

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
      const ageMs = Date.now() - date.getTime();
      const ageMin = Math.floor(ageMs / 60000);
      const timeStr = ageMin < 60
        ? `${ageMin}m`
        : ageMin < 1440
        ? `${Math.floor(ageMin / 60)}h`
        : ageMin < 2880
        ? 'yesterday'
        : `${Math.floor(ageMin / 1440)}d`;

      const pulse = activeTab ? '<span class="session-pulse"></span>' : '';

      sessionEl.innerHTML = `
        <span class="session-item-delete" data-session-id="${session.id}" tabindex="0" role="button" aria-label="Delete session">×</span>
        <div class="session-item-title">${pulse}${escapeHtml(session.title || 'Untitled')}</div>
        <div class="session-item-time">${timeStr}</div>
      `;

      sessionEl.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).classList.contains("session-item-delete")) return;
        switchToSession(session);
      });

      const deleteBtn = sessionEl.querySelector(".session-item-delete") as HTMLElement | null;
      if (deleteBtn) {
        let confirmTimeout: number | null = null;
        const activateDelete = (e: Event) => {
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
        };
        deleteBtn.addEventListener("click", activateDelete);
        deleteBtn.addEventListener("keydown", (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activateDelete(e);
          }
        });
      }

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

let loadedConfig: Config | null = null;

async function loadConfig() {
  try {
    const result = await invoke<Config>("read_config");
    loadedConfig = result;
    console.log("Config loaded:", result);
  } catch (error) {
    console.error("Error loading config:", error);
  }
}

async function saveProjectsToConfig() {
  const config = {
    keybinds: loadedConfig?.keybinds ?? {},
    projects: projects.map(p => ({ id: p.id, name: p.name, path: p.path })),
    active_project_id: activeProjectId,
  };
  try {
    await invoke("write_config", { config: JSON.stringify(config) });
  } catch (error) {
    console.error("Error saving config:", error);
  }
}

async function initProjects() {
  const config = loadedConfig;

  if (config?.projects && config.projects.length > 0) {
    projects = config.projects.map(p => ({ id: p.id, name: p.name, path: p.path }));
    activeProjectId = config.active_project_id ?? projects[0].id;
    if (!projects.find(p => p.id === activeProjectId)) {
      activeProjectId = projects[0].id;
    }
  } else {
    // First launch: auto-create a project from cwd
    let projectPath = currentPath;
    let projectName = currentPath.split("/").pop() || "project";
    try {
      projectPath = await invoke<string>("git_find_repo_root", { startPath: currentPath });
      projectName = projectPath.split("/").pop() || projectName;
    } catch { /* not a git repo, use cwd */ }

    const firstProject: Project = { id: crypto.randomUUID(), name: projectName, path: projectPath };
    projects = [firstProject];
    activeProjectId = firstProject.id;
    await saveProjectsToConfig();
  }

  const active = projects.find(p => p.id === activeProjectId)!;
  currentPath = active.path;
}

function renderProjectList() {
  const projectList = document.getElementById("project-list");
  if (!projectList) return;

  projectList.innerHTML = "";
  projects.forEach(project => {
    const isActive = project.id === activeProjectId;
    const item = document.createElement("div");
    item.className = `project-item${isActive ? " active" : ""}`;
    const deleteBtn = projects.length > 1
      ? `<button class="project-delete-btn" data-project-id="${project.id}" title="Remove project" aria-label="Remove project">` +
        `<svg width="9" height="9" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>` +
        `</button>`
      : '';
    item.innerHTML = `
      <span class="project-item-dot">${isActive ? '●' : '○'}</span>
      <span class="project-item-name">${escapeHtml(project.name)}</span>
      ${deleteBtn}
    `;
    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".project-delete-btn")) return;
      switchProject(project.id);
    });
    projectList.appendChild(item);
  });
}

async function switchProject(id: string) {
  if (id === activeProjectId) return;

  activeProjectId = id;
  const project = projects.find(p => p.id === id)!;
  currentPath = project.path;

  await saveProjectsToConfig();
  await loadDirectory(currentPath);
  await loadWorktrees(id);

  renderProjectList();
  renderWorktreeList();
  renderTabBar();
  renderActiveContent();
  updateStatusBar();

  // Ensure the active worktree has at least one tab
  try {
    const session = getActiveWorktreeSession();
    if (session.tabs.length === 0) {
      await createTab(false);
    }
  } catch { /* no active session */ }
}

async function createProject(name: string, path: string) {
  const trimmedName = name.trim();
  const trimmedPath = path.trim();
  if (!trimmedName || !trimmedPath) return;

  const newProject: Project = { id: crypto.randomUUID(), name: trimmedName, path: trimmedPath };
  projects.push(newProject);
  await saveProjectsToConfig();
  await switchProject(newProject.id);
}

async function deleteProject(id: string) {
  const index = projects.findIndex(p => p.id === id);
  if (index === -1) return;

  projects.splice(index, 1);

  // Clean up worktree sessions for this project
  worktreeSessions = worktreeSessions.filter(s => s.projectId !== id);

  if (id === activeProjectId) {
    activeProjectId = projects.length > 0 ? projects[0].id : null;
    if (activeProjectId) {
      const project = projects.find(p => p.id === activeProjectId)!;
      currentPath = project.path;
      await loadDirectory(currentPath);
      await loadWorktrees(activeProjectId);
    }
  }

  await saveProjectsToConfig();
  renderProjectList();
  renderWorktreeList();

  if (!activeProjectId) {
    // Deleted the last project — show empty state
    const tabsEl = document.getElementById("tabs");
    const terminalEl = document.getElementById("terminal");
    const mainContent = document.getElementById("main-content");
    if (tabsEl) tabsEl.innerHTML = "";
    if (terminalEl) terminalEl.innerHTML = "";
    if (mainContent) mainContent.style.display = "block";
    renderActiveContent();
    updateStatusBar();
  }
}

function wireAppKeydownHandler() {
  document.addEventListener("keydown", async (e) => {
    const session = getActiveWorktreeSession();
    const currentIndex = session.tabs.findIndex(t => t.id === session.activeTabId);

    // Ctrl+Alt+Left: Switch to previous worktree session (within current project)
    if (e.key === 'ArrowLeft' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!isGitRepo) return;
      const projectSessions = worktreeSessions.filter(s => s.projectId === activeProjectId);
      const sessionIndex = projectSessions.findIndex(s => s.id === activeWorktreeSessionId);
      const prevIndex = sessionIndex > 0 ? sessionIndex - 1 : projectSessions.length - 1;
      await switchWorktreeSession(projectSessions[prevIndex].id);
      return;
    }

    // Ctrl+Alt+Right: Switch to next worktree session (within current project)
    if (e.key === 'ArrowRight' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!isGitRepo) return;
      const projectSessions = worktreeSessions.filter(s => s.projectId === activeProjectId);
      const sessionIndex = projectSessions.findIndex(s => s.id === activeWorktreeSessionId);
      const nextIndex = sessionIndex < projectSessions.length - 1 ? sessionIndex + 1 : 0;
      await switchWorktreeSession(projectSessions[nextIndex].id);
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

    if (e.key === 'K' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await createClaudeTab();
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
    parentEntry.style.opacity = "0.5";
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
      entry.addEventListener("click", () => {
        fileList.querySelectorAll(".file-entry.active").forEach(el => el.classList.remove("active"));
        entry.classList.add("active");
        openInNeovim(file.path);
      });
    }
    fileList.appendChild(entry);
  }
}

function updatePathDisplay(path: string) {
  const pathDisplay = document.getElementById("current-path");
  if (pathDisplay) {
    // Show just the short path (tilde-contracted)
    const home = path.startsWith("/home/") ? path.replace(/^\/home\/[^/]+/, "~") : path;
    pathDisplay.textContent = home;
    pathDisplay.title = path;
  }
}

function renderTabBar() {
  const tabBar = document.getElementById("tab-bar");
  if (!tabBar) return;

  const existingTabs = tabBar.querySelectorAll(".tab");
  existingTabs.forEach(t => t.remove());

  const session = getActiveWorktreeSession();
  const newTabBtn = tabBar.querySelector(".new-tab");

  session.tabs.forEach(tab => {
    const isActive = tab.id === session.activeTabId;
    const isChat = isChatTab(tab);
    const tabEl = document.createElement("div");
    tabEl.className = `tab${isActive ? " active" : ""}${isChat ? " chat-tab" : ""}`;
    tabEl.dataset.tabId = tab.id;
    tabEl.setAttribute("role", "tab");
    tabEl.setAttribute("aria-selected", String(isActive));

    const icon = isChat ? ICON_CHAT : ICON_TERMINAL;
    const closeBtn = session.tabs.length > 1
      ? `<span class="tab-close" aria-label="Close tab">
           <svg width="9" height="9" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
         </span>`
      : '';

    tabEl.innerHTML = `
      <span class="tab-icon">${icon}</span>
      <span class="tab-name">${escapeHtml(tab.name)}</span>
      ${closeBtn}
    `;

    tabEl.addEventListener("click", (e) => {
      if ((e.target as Element).closest(".tab-close")) {
        closeTab(tab.id);
      } else {
        switchTab(tab.id);
      }
    });

    tabBar.insertBefore(tabEl, newTabBtn);
  });

  // per-tab meta in the right slot
  const meta = document.getElementById("tab-bar-meta");
  if (meta) {
    const activeTab = session.tabs.find(t => t.id === session.activeTabId);
    if (activeTab && isChatTab(activeTab) && activeTab.sessionId) {
      meta.textContent = "chat session";
    } else if (activeTab && isTerminalTab(activeTab) && activeTab.sessionId) {
      meta.textContent = `zsh · pid ${activeTab.sessionId}`;
    } else {
      meta.textContent = "";
    }
  }
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
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
    theme: {
      background: "#090b10",
      foreground: "#e0e0e0",
      cursor: "#e0e0e0",
      selectionBackground: "#ffffff22",
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
  const statusBranchName = document.getElementById("status-branch-name");
  const statusGit = document.getElementById("status-git");
  const session = worktreeSessions.find(s => s.id === activeWorktreeSessionId);

  // Branch
  if (statusBranchName && session) {
    statusBranchName.textContent = session.branch || "—";
  }

  // Git status placeholder (real data would come from backend)
  if (statusGit) {
    statusGit.className = "";
    statusGit.innerHTML = isGitRepo
      ? `<span class="status-clean">● clean</span>`
      : '';
  }

  if (!statusInfo) return;

  if (tab && isChatTab(tab)) {
    const sessionCount = session?.tabs.filter(t => isChatTab(t)).length ?? 0;
    const termCount = session?.tabs.filter(t => isTerminalTab(t)).length ?? 0;
    statusInfo.textContent = `${termCount} terminal${termCount !== 1 ? 's' : ''} · ${sessionCount} chat`;
  } else if (tab && isTerminalTab(tab) && tab.isNeovim) {
    statusInfo.textContent = "nvim";
  } else {
    const termCount = session?.tabs.filter(t => isTerminalTab(t)).length ?? 0;
    statusInfo.textContent = `${termCount} terminal${termCount !== 1 ? 's' : ''}`;
  }
}

// Worktree Functions

async function loadWorktrees(projectId?: string) {
  const pid = projectId ?? activeProjectId ?? "";
  const project = projects.find(p => p.id === pid);
  const startPath = project?.path ?? (currentPath || ".");
  const otherSessions = worktreeSessions.filter(s => s.projectId !== pid);

  try {
    const repoRoot = await invoke<string>("git_find_repo_root", { startPath });
    const worktrees = await invoke<WorktreeEntry[]>("git_worktree_list", { repoPath: repoRoot });

    const projectSessions: WorktreeSession[] = worktrees.map(w => ({
      id: `worktree-${crypto.randomUUID()}`,
      projectId: pid,
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

    // If no worktrees found, create default from project path
    if (projectSessions.length === 0) {
      projectSessions.push({
        id: `worktree-${crypto.randomUUID()}`,
        projectId: pid,
        path: startPath,
        branch: await invoke<string>("git_get_current_branch", { worktreePath: startPath }),
        isMain: true,
        tabs: [],
        activeTabId: "",
        nextTabIndex: 1,
        nextChatIndex: 1,
        isInitialized: false,
      });
    }

    worktreeSessions = [...otherSessions, ...projectSessions];

    // Set first worktree of this project as active if none is set for this project
    const currentActive = worktreeSessions.find(s => s.id === activeWorktreeSessionId);
    if (!currentActive || currentActive.projectId !== pid) {
      activeWorktreeSessionId = projectSessions[0].id;
    }

    renderWorktreeList();
  } catch (error) {
    console.log("Not a git repository:", error);
    isGitRepo = false;

    // Create default session for non-git repos
    const fallback: WorktreeSession = {
      id: `worktree-${crypto.randomUUID()}`,
      projectId: pid,
      path: startPath,
      branch: "",
      isMain: true,
      tabs: [],
      activeTabId: "",
      nextTabIndex: 1,
      nextChatIndex: 1,
      isInitialized: false,
    };
    worktreeSessions = [...otherSessions, fallback];
    activeWorktreeSessionId = fallback.id;

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

  const currentProjectSessions = worktreeSessions.filter(s => s.projectId === activeProjectId);
  currentProjectSessions.forEach(session => {
    const isActive = session.id === activeWorktreeSessionId;
    const item = document.createElement("div");
    item.className = `worktree-item${isActive ? " active" : ""}${session.branch === "detached HEAD" ? " worktree-item-detached" : ""}`;

    const branchDisplay = session.branch === "detached HEAD" ? "detached HEAD" : session.branch;
    const tabCount = session.tabs.length;

    const deleteBtn = !session.isMain
      ? `<button class="worktree-delete-btn" data-session-id="${session.id}" title="Remove worktree (git worktree remove)" aria-label="Remove worktree">` +
        `<svg width="9" height="9" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>` +
        `</button>`
      : '';

    item.innerHTML = `
      <span class="worktree-branch-icon">${ICON_BRANCH}</span>
      <span class="worktree-branch">${escapeHtml(branchDisplay)}</span>
      ${tabCount > 0 ? `<span class="worktree-tab-count">${tabCount}</span>` : ''}
      ${deleteBtn}
    `;

    item.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".worktree-delete-btn")) return;
      switchWorktreeSession(session.id);
    });
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
      projectId: activeProjectId ?? "",
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

async function deleteWorktreeSession(sessionId: string) {
  const session = worktreeSessions.find(s => s.id === sessionId);
  if (!session || session.isMain) return;

  const branchLabel = session.branch === "detached HEAD" ? "detached HEAD" : session.branch;
  if (!confirm(`Remove worktree "${branchLabel}" at ${session.path}?`)) return;

  try {
    const repoRoot = await invoke<string>("git_find_repo_root", { startPath: session.path });
    await invoke("git_worktree_remove", {
      repoPath: repoRoot,
      worktreePath: session.path,
      force: false,
    });

    const index = worktreeSessions.findIndex(s => s.id === sessionId);
    if (index !== -1) worktreeSessions.splice(index, 1);

    if (activeWorktreeSessionId === sessionId) {
      // Switch to another session in the same project, or the first available
      const projectSessions = worktreeSessions.filter(s => s.projectId === activeProjectId);
      if (projectSessions.length > 0) {
        await switchWorktreeSession(projectSessions[0].id);
      }
    }

    renderWorktreeList();
  } catch (error) {
    console.error("Failed to remove worktree:", error);
    alert(`Failed to remove worktree: ${error}`);
  }
}

async function initWorktreeSessions() {
  await loadWorktrees(activeProjectId ?? undefined);

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

    const resp = await fetch(`http://127.0.0.1:${opencodeServerPort}/session?directory=${encodeURIComponent(currentPath)}`, {
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

async function createClaudeTab() {
  const container = document.getElementById("terminal-container");
  const mainContent = document.getElementById("main-content");
  const session = getActiveWorktreeSession();

  container?.classList.remove("collapsed");
  container?.classList.add("full-height");
  if (mainContent) mainContent.style.display = "none";

  const tabId = `tab-${crypto.randomUUID()}`;
  const tabName = `Claude ${session.nextTabIndex++}`;

  const newTab: TerminalTab = {
    id: tabId,
    sessionId: null,
    name: tabName,
    isNeovim: false,
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

  const terminalEl = document.getElementById("terminal");
  if (!terminalEl) return;

  terminalEl.innerHTML = "";
  const { terminal, fitAddon } = makeTerminal();
  terminal.open(terminalEl);
  fitAddon.fit();

  newTab.terminal = terminal;
  newTab.fitAddon = fitAddon;
  newTab.rowCount = terminal.rows;
  newTab.colCount = terminal.cols;
  newTab.isInitialized = true;

  try {
    const sessionId = await invoke<string>("spawn_terminal_cmd", {
      cmd: "claude",
      cwd: currentPath || null,
      rows: newTab.rowCount,
      cols: newTab.colCount,
    });

    newTab.sessionId = sessionId;

    const unlistenData = await listen(`terminal-data-${sessionId}`, (event) => {
      terminal.write(event.payload as string);
    });

    const unlistenExit = await listen(`terminal-exited-${sessionId}`, () => {
      terminal.writeln("\r\n[Claude exited]");
      const tabStillExists = session.tabs.some(t => t.id === newTab.id);
      if (tabStillExists && session.tabs.length > 1) {
        setTimeout(() => {
          if (session.tabs.some(t => t.id === newTab.id)) {
            closeTab(newTab.id);
          }
        }, 500);
      }
    });

    newTab.unlistenData = unlistenData;
    newTab.unlistenExit = unlistenExit;

    wireTerminalInput(newTab, terminal);
  } catch (error) {
    terminal.writeln(`\x1b[31mError starting claude: ${error}\x1b[0m`);
  }

  renderActiveContent();
  updateStatusBar();
}

function renderChatMessages(tab: ChatTab) {
  const chatMessages = document.getElementById("chat-messages");
  if (!chatMessages) return;

  chatMessages.innerHTML = '';

  tab.messages.forEach((msg) => {
    const isUser = msg.role === 'user';
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const avatarClass = isUser ? 'user' : 'assistant';
    const avatarLabel = isUser ? 'M' : `<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1.5l1.2 3.3L10.5 6 7.2 7.2 6 10.5 4.8 7.2 1.5 6l3.3-1.2L6 1.5z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>`;
    const roleName = isUser ? 'matt' : 'claude';

    const content = msg.role === 'assistant'
      ? DOMPurify.sanitize(marked.parse(msg.content, { breaks: true }) as string)
      : `<p>${escapeHtml(msg.content)}</p>`;

    const turnEl = document.createElement("div");
    turnEl.className = "chat-turn";
    turnEl.innerHTML = `
      <div class="chat-turn-avatar ${avatarClass}">${avatarLabel}</div>
      <div class="chat-turn-body">
        <div class="chat-turn-meta">${roleName} · ${time}</div>
        <div class="chat-turn-content">${content}</div>
        <div class="chat-turn-actions">
          <button class="chat-action-btn" title="Copy">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="3" y="3" width="6.5" height="6.5" rx="1" stroke="currentColor" stroke-width="1.1"/><path d="M3 3V2a1 1 0 011-1h4a1 1 0 011 1v1" stroke="currentColor" stroke-width="1.1"/></svg>
            copy
          </button>
          ${!isUser ? `<button class="chat-action-btn" title="Retry">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.5 6a3.5 3.5 0 016-2.5M9.5 6a3.5 3.5 0 01-6 2.5M2.5 2v2.5h2.5M9.5 10V7.5H7" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
            retry
          </button>` : ''}
        </div>
      </div>
    `;
    chatMessages.appendChild(turnEl);
  });

  if (tab.isStreaming) {
    const streamEl = document.createElement("div");
    streamEl.className = "chat-turn";
    streamEl.innerHTML = `
      <div class="chat-turn-avatar assistant">
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M6 1.5l1.2 3.3L10.5 6 7.2 7.2 6 10.5 4.8 7.2 1.5 6l3.3-1.2L6 1.5z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>
      </div>
      <div class="chat-turn-body">
        <div class="chat-turn-meta">
          claude
          <span class="chat-streaming-badge">
            <span class="chat-streaming-dot"></span>
            streaming
          </span>
        </div>
        <div class="chat-turn-content">
          <span class="thinking-label">Thinking</span><span class="cursor-blink"></span>
        </div>
      </div>
    `;
    chatMessages.appendChild(streamEl);
  }

  // Update chat header title with session name
  const headerTitle = document.getElementById("chat-header-title");
  if (headerTitle && tab.name) headerTitle.textContent = tab.name;

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

    // Initialize projects (must come before worktree init)
    await initProjects();
    renderProjectList();

    // Initialize worktree sessions
    await initWorktreeSessions();

    // Worktree event listeners
    document.getElementById("new-worktree-btn")?.addEventListener("click", () => {
      if (!isGitRepo) return;
      const modal = document.getElementById("worktree-modal");
      if (modal) modal.style.display = "flex";
    });

    document.getElementById("refresh-worktrees-btn")?.addEventListener("click", () => {
      loadWorktrees();
    });

    document.getElementById("worktree-list")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".worktree-delete-btn") as HTMLElement | null;
      if (btn) {
        const sessionId = btn.dataset.sessionId;
        if (sessionId) deleteWorktreeSession(sessionId);
      }
    });

    const closeModal = () => {
      const modal = document.getElementById("worktree-modal");
      if (modal) modal.style.display = "none";
      const branchInput = document.getElementById("worktree-branch-input") as HTMLInputElement;
      const pathInput = document.getElementById("worktree-path-input") as HTMLInputElement;
      const errorEl = document.getElementById("worktree-modal-error");
      if (branchInput) branchInput.value = "";
      if (pathInput) pathInput.value = "";
      if (errorEl) errorEl.style.display = "none";
    };

    document.getElementById("worktree-modal-cancel")?.addEventListener("click", closeModal);
    document.getElementById("worktree-modal-close")?.addEventListener("click", closeModal);

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

    // Live-update modal footer command preview
    const branchInputEl = document.getElementById("worktree-branch-input") as HTMLInputElement | null;
    const footerCmd = document.getElementById("modal-footer-cmd");
    if (branchInputEl && footerCmd) {
      branchInputEl.addEventListener("input", () => {
        const val = branchInputEl.value.trim();
        footerCmd.textContent = val
          ? `git worktree add -b feat/${val} …`
          : 'git worktree add -b feat/…';
      });
    }

    // Project event listeners
    document.getElementById("new-project-btn")?.addEventListener("click", () => {
      const modal = document.getElementById("project-modal");
      if (modal) modal.style.display = "flex";
      const nameInput = document.getElementById("project-name-input") as HTMLInputElement;
      if (nameInput) nameInput.value = "";
      const pathInput = document.getElementById("project-path-input") as HTMLInputElement;
      if (pathInput) { pathInput.value = ""; pathInput.focus(); }
      const errorEl = document.getElementById("project-modal-error");
      if (errorEl) errorEl.style.display = "none";
    });

    const closeProjectModal = () => {
      const modal = document.getElementById("project-modal");
      if (modal) modal.style.display = "none";
    };

    document.getElementById("project-modal-cancel")?.addEventListener("click", closeProjectModal);
    document.getElementById("project-modal-close")?.addEventListener("click", closeProjectModal);

    // Auto-fill name + path autocomplete dropdown
    const projectPathInputEl = document.getElementById("project-path-input") as HTMLInputElement | null;
    const projectNameInputEl = document.getElementById("project-name-input") as HTMLInputElement | null;
    const pathSuggestionsEl = document.getElementById("path-suggestions") as HTMLDivElement | null;

    let suggestionDebounce: number | null = null;
    let activeSuggestionIndex = -1;
    let currentSuggestions: string[] = [];

    function hideSuggestions() {
      if (pathSuggestionsEl) pathSuggestionsEl.style.display = "none";
      activeSuggestionIndex = -1;
      currentSuggestions = [];
    }

    function renderSuggestions(suggestions: string[], prefix: string) {
      if (!pathSuggestionsEl) return;
      if (suggestions.length === 0) { hideSuggestions(); return; }

      currentSuggestions = suggestions;
      activeSuggestionIndex = -1;
      pathSuggestionsEl.innerHTML = "";

      suggestions.forEach((fullPath, i) => {
        const name = fullPath.split("/").pop() || fullPath;
        const item = document.createElement("div");
        item.className = "path-suggestion-item";
        item.dataset.index = String(i);

        // Highlight the matched prefix within the name
        const matchLen = prefix.length;
        const matchedPart = name.slice(0, matchLen);
        const restPart = name.slice(matchLen);
        item.innerHTML =
          `<span class="suggestion-icon">${ICON_FOLDER}</span>` +
          `<span class="suggestion-match">${escapeHtml(matchedPart)}</span>` +
          `<span class="suggestion-rest">${escapeHtml(restPart)}</span>`;

        item.addEventListener("mousedown", (e) => {
          e.preventDefault(); // don't blur the input
          selectSuggestion(fullPath);
        });
        pathSuggestionsEl.appendChild(item);
      });

      pathSuggestionsEl.style.display = "block";
    }

    function setActiveSuggestion(index: number) {
      if (!pathSuggestionsEl) return;
      const items = pathSuggestionsEl.querySelectorAll<HTMLElement>(".path-suggestion-item");
      items.forEach(el => el.classList.remove("active"));
      activeSuggestionIndex = index;
      if (index >= 0 && index < items.length) {
        items[index].classList.add("active");
        items[index].scrollIntoView({ block: "nearest" });
      }
    }

    async function selectSuggestion(fullPath: string) {
      if (!projectPathInputEl || !projectNameInputEl) return;
      // Append trailing slash so the user can keep drilling down
      projectPathInputEl.value = fullPath + "/";
      const segment = fullPath.split("/").filter(Boolean).pop() || "";
      if (segment) projectNameInputEl.value = segment;
      hideSuggestions();
      // Immediately trigger suggestions for the new value
      await fetchSuggestions(fullPath + "/");
    }

    async function fetchSuggestions(rawVal: string) {
      if (!projectPathInputEl || !pathSuggestionsEl) return;

      let val = rawVal;

      // Expand ~ on input
      if (val.startsWith("~/")) {
        const home = await invoke<string>("get_home_dir");
        val = home + val.slice(1);
        projectPathInputEl.value = val;
      } else if (val === "~") {
        const home = await invoke<string>("get_home_dir");
        val = home + "/";
        projectPathInputEl.value = val;
      }

      // Auto-fill name
      const nameSegment = val.replace(/\/$/, "").split("/").filter(Boolean).pop() || "";
      if (nameSegment && projectNameInputEl) projectNameInputEl.value = nameSegment;

      if (!val || val === "/") { hideSuggestions(); return; }

      // Determine the directory to list and the prefix to filter by
      let parentDir: string;
      let prefix: string;
      if (val.endsWith("/")) {
        parentDir = val;
        prefix = "";
      } else {
        const lastSlash = val.lastIndexOf("/");
        parentDir = lastSlash >= 0 ? val.slice(0, lastSlash + 1) : "/";
        prefix = lastSlash >= 0 ? val.slice(lastSlash + 1) : val;
      }

      try {
        const entries: FileEntry[] = await invoke("read_directory", { path: parentDir });
        const dirs = entries
          .filter(e => e.is_dir && e.name.toLowerCase().startsWith(prefix.toLowerCase()))
          .slice(0, 10)
          .map(e => e.path);
        renderSuggestions(dirs, prefix);
      } catch {
        hideSuggestions();
      }
    }

    if (projectPathInputEl && projectNameInputEl && pathSuggestionsEl) {
      projectPathInputEl.addEventListener("input", () => {
        if (suggestionDebounce) clearTimeout(suggestionDebounce);
        suggestionDebounce = window.setTimeout(() => {
          fetchSuggestions(projectPathInputEl.value);
        }, 150);
      });

      projectPathInputEl.addEventListener("keydown", (e) => {
        if (pathSuggestionsEl.style.display === "none") return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveSuggestion(Math.min(activeSuggestionIndex + 1, currentSuggestions.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveSuggestion(Math.max(activeSuggestionIndex - 1, 0));
        } else if (e.key === "Enter" || e.key === "Tab") {
          if (activeSuggestionIndex >= 0 && currentSuggestions[activeSuggestionIndex]) {
            e.preventDefault();
            selectSuggestion(currentSuggestions[activeSuggestionIndex]);
          } else {
            hideSuggestions();
          }
        } else if (e.key === "Escape") {
          hideSuggestions();
        }
      });

      projectPathInputEl.addEventListener("blur", () => {
        // Small delay so mousedown on suggestion fires first
        setTimeout(hideSuggestions, 150);
      });
    }

    document.getElementById("project-modal-create")?.addEventListener("click", async () => {
      const nameInput = document.getElementById("project-name-input") as HTMLInputElement;
      const pathInput = document.getElementById("project-path-input") as HTMLInputElement;
      const errorEl = document.getElementById("project-modal-error");
      const name = nameInput?.value.trim();
      let path = pathInput?.value.trim() ?? "";

      // Expand ~ as a safety net in case the input handler didn't fire
      if (path.startsWith("~/")) {
        const home = await invoke<string>("get_home_dir");
        path = home + path.slice(1);
      } else if (path === "~") {
        path = await invoke<string>("get_home_dir");
      }

      if (!name || !path) {
        if (errorEl) { errorEl.textContent = "Please enter a name and path."; errorEl.style.display = "block"; }
        return;
      }

      if (errorEl) errorEl.style.display = "none";
      await createProject(name, path);
      closeProjectModal();
    });

    document.getElementById("project-list")?.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest(".project-delete-btn") as HTMLElement | null;
      if (btn) {
        const projectId = btn.dataset.projectId;
        if (projectId) {
          const project = projects.find(p => p.id === projectId);
          if (project && !confirm(`Remove project "${project.name}"? This does not delete the directory.`)) return;
          deleteProject(projectId);
        }
      }
    });

    document.querySelector(".new-tab")?.addEventListener("click", () => createTab(false));
    document.querySelector(".new-chat")?.addEventListener("click", () => createChatTab());
    document.querySelector(".new-claude")?.addEventListener("click", () => createClaudeTab());

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
