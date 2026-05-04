# Chat Tab Improvements Plan

Based on OpenCode API documentation and current codebase analysis.

## 1. Session Management UI

### 1.1 List/Select Existing Sessions
- **API**: `GET /session` to list all sessions
- **UI**: Add session sidebar or dropdown showing all sessions
- **Data**: Use `Session[]` type (id, title, status, model)
- **Files**: `src/main.ts` - add `loadSessions()`, `switchSession()` functions

### 1.2 Session Titles
- **Current**: Generic "Chat 1", "Chat 2"
- **Improve**: Use `Session.title` from API response in `POST /session` and `GET /session/:id`
- **Fallback**: Generate title from first message if API doesn't provide one

### 1.3 Delete Sessions
- **API**: `DELETE /session/:id`
- **UI**: Add delete button to session list items
- **Confirm**: Show confirmation dialog before deleting

### 1.4 Fork Sessions
- **API**: `POST /session/:id/fork` with optional `messageID`
- **UI**: "Fork" button to create variant conversations from any point
- **Use case**: Try different approaches from the same context

---

## 2. Model & Provider Selection

### 2.1 List Available Providers/Models
- **API**: `GET /config/providers` returns `{ providers: Provider[], default: { [key: string]: string } }`
- **UI**: Dropdown/selector showing available providers and their models
- **State**: Store in config or fetch on demand

### 2.2 Display Current Model
- **Data**: `Session.modelID` and `Session.providerID`
- **UI**: Show in status bar or chat header
- **Format**: "anthropic/claude-3-5-sonnet-20241022"

### 2.3 Per-Message Model Override
- **API**: Pass `model: { providerID, modelID }` in `POST /session/:id/message` body
- **UI**: Quick model switcher per message (advanced feature)

---

## 3. Message Features

### 3.1 Message History
- **API**: `GET /session/:id/message?limit=` to list messages
- **Use case**: Load previous messages when switching sessions
- **State**: Cache messages per session to avoid refetching

### 3.2 Resend/Retry Messages
- **UI**: Edit and resend previous messages
- **API**: Resend with `POST /session/:id/message`
- **UX**: Click message → edit → resend

### 3.3 Undo/Redo Changes
- **API**: `POST /session/:id/revert` (with `messageID`, optional `partID`)
- **API**: `POST /session/:id/unrevert` to restore all reverted messages
- **UI**: "Undo" and "Redo" buttons in chat or terminal

### 3.4 Message Summarization
- **API**: `POST /session/:id/summarize` with `providerID` and `modelID`
- **Use case**: Summarize long conversations for context management
- **UI**: "Summarize" button for current session

---

## 4. File Integration

### 4.1 File Search in Chat
- **API**: `GET /find/files?query=&type=file&limit=20`
- **UI**: File picker/search modal to attach files to prompts
- **UX**: Type `@filename` to fuzzy-search and attach files (like OpenCode TUI)

### 4.2 Symbol Search
- **API**: `GET /find/symbols?query=`
- **Data**: Returns `Symbol[]` with file paths and line numbers
- **Use case**: Reference functions/classes in prompts

### 4.3 Show File Diffs
- **API**: `GET /session/:id/diff?messageID=`
- **UI**: Display diff view showing what changes the AI made
- **Format**: Use existing diff rendering or add a simple diff viewer

### 4.4 Open Files in Editor
- **Current**: Files open in neovim via `openInNeovim()`
- **Improve**: Click file paths in AI responses to open them in the neovim tab
- **Parse**: Extract file paths from message `parts` (look for `FilePart`)

---

## 5. Agent Selection

### 5.1 List Available Agents
- **API**: `GET /agent` returns `Agent[]`
- **UI**: Dropdown to select agent per session
- **Data**: Agent has `id`, `name`, `description`, `model`

### 5.2 Display Current Agent
- **Data**: `Session.agent` field
- **UI**: Show agent name/icon in chat header or status bar

### 5.3 Switch Agents
- **API**: Include `agent` in `POST /session/:id/message` body
- **UX**: Quick switcher or setting per session

---

## 6. UI Improvements

### 6.1 Markdown Rendering Enhancements
- **Current**: Using `marked` for basic markdown
- **Improve**: Add syntax highlighting for code blocks (use `highlight.js` or `shiki`)
- **CSS**: Style code blocks, tables, blockquotes

### 6.2 Message Actions
- **UI**: Add hover actions to each message:
  - Copy message content
  - Edit and resend
  - Delete message
  - Copy code blocks individually

### 6.3 Typing Indicators
- **API**: Use `GET /session/status` for real-time status
- **Events**: Listen to `session.status` events via SSE
- **UI**: Show "Thinking..." or spinner when `status` is `running`

### 6.4 Token Usage Display
- **Data**: Check if `Message` or `Part` metadata includes token counts
- **UI**: Show token usage per message or session total
- **Optional**: Display cost estimates if available

### 6.5 Error Display
- **Types**: Handle `ProviderAuthError`, `MessageAbortedError`, `MessageOutputLengthError`, `APIError`
- **UI**: Pretty error messages with retry options
- **Actions**: "Reconnect" for auth errors, "Retry" for output length errors

---

## 7. Command Support

### 7.1 Slash Commands
- **API**: `POST /session/:id/command` with `{ command, arguments, agent?, model? }`
- **Commands**: `/init`, `/undo`, `/redo`, `/summarize`, etc.
- **UI**: Autocomplete dropdown when typing `/` in chat input

### 7.2 List Available Commands
- **API**: `GET /command` returns `Command[]`
- **Data**: Each command has `name`, `description`, `arguments`

---

## 8. Session Sharing

### 8.1 Share Sessions
- **API**: `POST /session/:id/share` returns updated `Session` with share URL
- **UI**: "Share" button that copies link to clipboard
- **Display**: Show share URL after sharing

### 8.2 Unshare Sessions
- **API**: `DELETE /session/:id/share`
- **UI**: Toggle share state

---

## 9. Project Context

### 9.1 Show Current Project
- **API**: `GET /project/current` returns `Project`
- **Data**: Project has `path`, `name`, `vcs` info
- **UI**: Display in sidebar header or status bar

### 9.2 Switch Projects
- **API**: May need to restart server with different `--cwd` or use `POST /instance/dispose` and restart
- **Advanced**: Support multiple project contexts

---

## 10. Advanced Features

### 10.1 Structured Output
- **API**: Pass `format: { type: 'json_schema', schema: { ... } }` in message body
- **Use case**: Extract structured data from prompts (e.g., JSON, forms)
- **UI**: Toggle for structured output mode, schema editor

### 10.2 Tool Usage Display
- **Data**: Look for `ToolPart` in message `parts`
- **UI**: Expandable sections showing which tools the agent used
- **Info**: Display tool name, input, output

### 10.3 Permission Handling
- **API**: `POST /session/:id/permissions/:permissionID` with `{ response, remember? }`
- **Events**: Listen for permission request events
- **UI**: Modal to approve/deny agent permissions (file access, shell commands, etc.)

### 10.4 LSP Integration Display
- **API**: `GET /lsp` for LSP server status
- **UI**: Show LSP status in status bar, display diagnostics from `lsp.client.diagnostics` events

---

## Implementation Priority

### High Priority (Biggest UX Impact)
1. **Session listing/selection** (Section 1.1)
2. **Session titles** (Section 1.2)
3. **Model selection dropdown** (Section 2.1, 2.2)
4. **Markdown syntax highlighting** (Section 6.1)
5. **File search integration** (Section 4.1)

### Medium Priority (Nice to Have)
6. **Message history loading** (Section 3.1)
7. **Undo/redo buttons** (Section 3.3)
8. **Slash commands** (Section 7.1)
9. **Typing indicators** (Section 6.3)
10. **Agent selection** (Section 5.1)

### Low Priority (Advanced)
11. Structured output (Section 10.1)
12. Tool usage display (Section 10.2)
13. Session sharing (Section 8)
14. Permission handling (Section 10.3)
15. Project switching (Section 9)

---

## Technical Notes

### API Client Options
- Option A: Use raw `fetch()` calls (current approach)
- Option B: Install `@opencode-ai/sdk` npm package for type-safe client
- Recommendation: Start with raw fetch, consider SDK for advanced features

### State Management
- Consider adding session cache: `Map<sessionId, Message[]>`
- Store current model/agent preferences per session
- Persist chat history to localStorage for offline viewing

### Event Streaming (Optional)
- Current implementation uses POST response (polling approach)
- For real-time updates, consider SSE via `GET /event` or `GET /session/:id/message` with long-polling
- Use `session.status` events to show running state

### Error Handling
- Wrap all API calls in try-catch
- Show user-friendly error messages
- Implement retry logic for network errors
- Handle 401/403 with auth flow redirect

---

## Files to Modify

- `src/main.ts` - Main chat logic, API calls, state management
- `src/styles.css` - UI improvements, markdown styling, code highlighting
- `index.html` - Additional UI elements (modals, dropdowns, etc.)
- `src-tauri/src/lib.rs` - Possibly add backend commands for complex operations

---

Generated: 2026-05-04
Based on: OpenCode Server API docs (https://opencode.ai/docs/server)
          OpenCode SDK docs (https://opencode.ai/docs/sdk)
          Current codebase analysis
