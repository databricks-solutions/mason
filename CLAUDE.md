# Mason

A desktop chat app built with Electron that connects to the Databricks AI Gateway, allowing users to interact with multiple LLMs through a unified interface with MCP tool calling (remote + local), local filesystem access, auto-discovered models, and streaming responses.

## Architecture

- **Electron** desktop app (main + renderer process with contextBridge IPC)
- **Databricks AI Gateway** — per-workspace, configured via Settings
  - MLflow chat completions (`/mlflow/v1/chat/completions`) for all chat models
  - OpenAI responses API (`/openai/v1/responses`) for codex models
- **Model auto-discovery** — queries `/api/2.0/serving-endpoints`, filters to `FOUNDATION_MODEL_API` chat models, groups by provider
- **Streaming responses** — SSE streaming with typewriter effect for smooth text rendering
- **Workspace-scoped config** — all settings per-profile in `config/workspaces.json`
- **MCP support** — remote (HTTP Streamable), local (stdio subprocess), and Unity Catalog external MCP servers
- **Tool filtering** — per-tool checkboxes to control which tools are sent with requests
- **Markdown rendering** — marked.js + highlight.js with syntax-highlighted code blocks
- **Built-in tools** — local filesystem read/write via Node.js

## Key Files

```
mason/
├── main.js                  # Main process: auth, API routing, MCP (HTTP + stdio), model discovery, streaming, built-in tools, file dialog, chat abort
├── preload.js               # IPC bridge + streaming chunk listener + abort + file dialog
├── index.html               # HTML structure only (195 lines) — no inline JS/CSS
├── package.json             # Electron config + electron-builder + postinstall
├── css/
│   └── app.css              # All styles (748 lines)
├── js/
│   ├── state.js             # Shared window.mason state object
│   ├── utils.js             # Helper functions (escapeHtml, genId, auth)
│   ├── markdown.js          # marked + highlight.js + DOMPurify config
│   ├── messages.js          # Message rendering, welcome, thinking animation
│   ├── history.js           # Chat history CRUD
│   ├── tools.js             # Built-in + MCP tool defs, filtering
│   ├── models.js            # Model discovery, picker, selection
│   ├── mcp.js               # MCP server management (HTTP + stdio + UC external)
│   ├── dashboards.js        # Dashboard nav, list, embed
│   ├── chat.js              # Send, chatLoop, streaming, tool execution, stop/abort generation
│   └── app.js               # DOM refs, event wiring, startup, error handlers
├── config/
│   ├── workspaces.json      # Per-profile: gatewayUrl, mcpServers[], stdioServers[], customEndpoints[], autoLoadTools
│   └── mcp_servers.json     # Global MCP servers (HTTP + stdio with enabledByDefault)
├── icons/
│   ├── Databricks-Emblem.png
│   └── moon.webp
├── build/
│   ├── icon.icns
│   └── icon_square.png
├── scripts/
│   └── patch-icon.js        # Postinstall: patches Electron.app icon, name, executable, bundle
├── chat_history/
└── prompt.txt
```

## Authentication

Unified auth flow for all requests: OAuth first, PAT fallback.

- **OAuth (primary)**: `databricks auth token --profile <name>` → short-lived JWT, auto-refreshed per request
- **PAT fallback**: `token` field from `~/.databrickscfg`
- **In-app re-auth**: Authenticate button in `+` menu runs `databricks auth login` via `spawn` (not `execSync` — packaged apps have no terminal). On success, auto-triggers model discovery and dashboard reload.
- **Profiles**: Read from `~/.databrickscfg`, any profile with `host` included, `DEFAULT` pre-selected
- **Shell PATH resolution**: Packaged macOS apps don't inherit shell PATH. `getShellEnv()` runs `$SHELL -l -c 'echo $PATH'` (login shell) to resolve the full PATH including `/opt/homebrew/bin` etc. Fallback adds common CLI locations. Applied to all `databricks` CLI calls via `shellEnv`.

## Workspace Configuration

Per-profile in `config/workspaces.json`:

```json
{
  "DEFAULT": {
    "gatewayUrl": "https://1234567890.ai-gateway.cloud.databricks.com",
    "mcpServers": ["https://my-app.databricksapps.com/mcp"],
    "stdioServers": [{ "name": "databricks", "config": { "command": "...", "args": [...], "env": {...} } }],
    "customEndpoints": [{ "name": "My Model", "modelId": "my-model", "gatewayUrl": null, "format": "chat" }]
  }
}
```

Switching profiles auto-reloads: gateway URL, models, MCP servers (HTTP + stdio), custom endpoints.

## Model Discovery

Auto-discovered from `GET {gatewayUrl}/api/2.0/serving-endpoints`:
- Filters: `endpoint_type === "FOUNDATION_MODEL_API"` and `task` containing `chat`
- Groups by provider: Anthropic, Google, Meta, OpenAI, Qwen, Other
- Custom endpoints appear in "Custom" group
- New models appear automatically — no code changes needed

## Streaming

- **SSE streaming** for MLflow chat completions (non-tool, non-Responses API calls)
- `stream: true` in request body → server returns `text/event-stream`
- Main process reads chunks, sends to renderer via `webContents.send("chat-chunk")`
- **"Building..." animation** shown from prompt send until first chunk arrives (deferred removal via `firstChunk` flag in `onChatChunk`)
- **Typewriter effect**: chunks buffered and rendered 3 characters per 12ms for smooth visual
- Timer auto-restarts when new chunks arrive after pausing
- On completion: raw text replaced with full markdown rendering
- Falls back to non-streaming when tools are active (tool call loop needs full response)
- **Stop generation**: Send button swaps to stop icon during generation. Clicking it aborts the in-flight fetch (`activeChatController.abort()` in main process via `abort-chat` IPC). Partial streamed content is finalized and markdown-rendered.

## UI Layout

- **Left sidebar** (collapsible): chat history, new chat, profile selector, theme toggle
- **Main content area** (full-width, resizable):
  - User messages: right-aligned, subtle gray
  - Assistant messages: full-width, streamed with typewriter then markdown rendered
  - Code blocks: syntax highlighted, language label, copy button (delegated click handler — DOMPurify strips inline onclick), GitHub Light/Dark themes
  - Tool call messages: blue-tinted, monospace
  - "Building..." animation: stacking Databricks-orange bricks
- **Input box** (auto-resizing, min 48px, max 180px):
  - `+` button popup: MCP Servers, Tools, Settings, Authenticate
  - Settings includes: gateway URL, custom endpoints, auto-load MCP tools toggle
  - MCP badges (green = remote HTTP, blue = local stdio)
  - Model picker (custom popup, grouped by provider)
  - Send/Stop button (swaps icon during generation)

## Tool System

### Built-in Tools

| Tool | Description |
|------|-------------|
| `write_file` | Write content to local file (creates dirs) |
| `read_file` | Read content from local file |

### MCP Tools

From connected servers (HTTP or stdio). Discovered via `tools/list`.

### Tool Filtering

The Tools modal provides per-tool control:
- **"X of Y tools enabled"** counter
- **Server-level checkbox** — toggle all tools for a server on/off
- **Individual tool checkboxes** — enable/disable each tool
- Disabled tools are visually dimmed and excluded from API requests
- Reduces token overhead from sending all tool schemas (e.g. 88 → only what you need)

**Auto-load MCP tools** toggle (in Settings):
- **On** (default): tools from newly connected servers are enabled automatically
- **Off**: tools start unchecked — connect servers but don't send tools until manually enabled
- Saved per-workspace in `config/workspaces.json`
- Per-server override: `enabledByDefault: false` in `config/mcp_servers.json` disables a server's tools regardless of the global toggle

### Tool Call Loop

1. Model returns `tool_calls` → identify as built-in, HTTP MCP, or stdio MCP
2. Built-in: execute locally via Node.js `fs`
3. HTTP MCP: JSON-RPC POST with OAuth token
4. Stdio MCP: JSON-RPC over stdin/stdout to subprocess
5. Results → `role: "tool"` messages → back to model (max 10 iterations)
6. System prompt injected listing enabled tool names

## MCP Integration

### Remote (HTTP Streamable Transport)

- Protocol: JSON-RPC 2.0 over HTTP POST
- MCP version: 2025-03-26
- Flow: Initialize → Initialized notification → List tools → Ready
- Session: Tracks `MCP-Session-Id` per server
- Auth: Unified OAuth token
- SSE: Parses `text/event-stream` responses

### Unity Catalog External MCP

External MCP servers registered as Unity Catalog HTTP connections (e.g. Jira, GitHub, Slack managed by SaaS providers) are accessed via Databricks' MCP proxy:

- **Proxy URL**: `{workspace_host}/api/2.0/mcp/external/{connection_name}`
- **Discovery**: `GET /api/2.1/unity-catalog/connections` → filters for `connection_type === "HTTP"`
- **Transport**: Same Streamable HTTP protocol — reuses existing `connectMcpServer()` flow entirely
- **Auth**: Databricks OAuth token authenticates to the proxy; proxy injects external service credentials automatically
- **UI**: MCP Servers modal → "Unity Catalog" section auto-discovers on open, one-click Connect per connection
- **Persistence**: Connected UC MCP URLs saved as regular HTTP entries in workspace config → auto-reconnect on startup
- **Refresh**: "Refresh" button in UC section re-fetches available connections
- **Removal**: Connected UC servers appear in the main server list with × remove button; UC section updates to reflect status

### Local (stdio Transport)

- Spawns subprocess with configured `command`, `args`, `env`
- Communicates via newline-delimited JSON-RPC over stdin/stdout
- Supports `.mcp.json` config files (same format as Claude Code, VS Code, etc.)
- Load via MCP Servers modal → "Local (stdio)" → paste path or use Browse button (native `dialog.showOpenDialog`, filtered to `.json`)
- Processes managed per-key, auto-killed on disconnect
- 30s timeout per request
- Blue badge in UI (vs green for remote)

### Persistence

Two levels of MCP config:

1. **Per-workspace** (`config/workspaces.json`): HTTP URLs + stdio configs saved when added via UI
2. **Global** (`config/mcp_servers.json`): Shared across all workspaces, loaded on every startup

`config/mcp_servers.json` format:
```json
{
  "http": ["https://my-app.databricksapps.com/mcp"],
  "stdio": [{
    "name": "databricks",
    "command": "/path/to/python",
    "args": ["/path/to/run_server.py"],
    "env": {"DATABRICKS_CONFIG_PROFILE": "DEFAULT"},
    "enabledByDefault": false
  }]
}
```

- Auto-reconnect on app start and profile switch
- `enabledByDefault: false` connects the server but starts with all tools unchecked

## macOS App Customization

- Dock icon: Databricks emblem on white background (tight crop)
- App name: "Mason" (not "Electron")
- `scripts/patch-icon.js` (postinstall): patches icon, renames executable + bundle, updates Info.plist, creates symlink for compat, updates path.txt
- Window hidden until `ready-to-show`

## Logging

| Prefix | Location | Content |
|--------|----------|---------|
| `[AUTH]` | Terminal | OAuth/PAT operations |
| `[MCP]` | Terminal | HTTP MCP protocol |
| `[MCP-STDIO]` | Terminal | Stdio MCP spawn, requests, responses |
| `[CHAT]` | Terminal + DevTools | Chat API, tool counts, streaming |
| `[BUILTIN]` | Terminal | File read/write |
| `[MODELS]` | Terminal + DevTools | Model discovery |
| `[WORKSPACE]` | DevTools | Profile switching |
| `[MCP UI]` | DevTools | MCP connect/disconnect |

## CI/CD

Three workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `pr.yml` | PR to `main` | Matrix build dry-run on macOS/Windows/Linux. Catches packaging regressions before merge. |
| `release-please.yml` | Push to `main` | `release-please` opens/updates a "Release PR" aggregating Conventional Commits. Merging it bumps `package.json`, writes `CHANGELOG.md`, tags `vX.Y.Z`, and creates a draft GitHub Release. |
| `build.yml` | `v*` tag push + manual | Builds signed/notarized macOS DMG, Windows NSIS, Linux AppImage. Uploads installers to the release tag. |

### Versioning — Conventional Commits

`release-please` reads commit messages and bumps version automatically:

| Commit prefix | Bump | Example |
|---------------|------|---------|
| `fix:` | patch (1.0.0 → 1.0.1) | `fix: handle 401 on UC reconnect` |
| `feat:` | minor (1.0.0 → 1.1.0) | `feat: add custom endpoints panel` |
| `feat!:` or `BREAKING CHANGE:` footer | major (1.0.0 → 2.0.0) | `feat!: remove deprecated PAT auth` |
| `chore:` / `docs:` / `refactor:` | none | `chore: bump electron` |

Other prefixes (`build`, `ci`, `perf`, `test`, `style`) appear in the changelog but don't bump.

### Release flow

1. Open PR with conventional-commit titles. `pr.yml` runs 3-OS dry-run; all must pass.
2. Merge PR. `release-please.yml` fires and opens (or updates) a release PR titled `chore(main): release X.Y.Z`.
3. When ready to ship, merge the release PR. release-please tags `vX.Y.Z` and creates a draft GitHub Release.
4. Tag push triggers `build.yml`. macOS job signs + notarizes via Apple's notary service. All three jobs upload installers to the release.
5. Edit the draft release on GitHub if needed, then publish. Users download from `/releases/latest`.

### Required GitHub repo secrets

Settings → Secrets and variables → Actions:

| Secret | Purpose |
|--------|---------|
| `MAC_CERT_P12_BASE64` | Base64-encoded Developer ID Application `.p12` cert + private key |
| `MAC_CERT_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from `account.apple.com` for the notary service |
| `APPLE_TEAM_ID` | 10-char Apple Team ID (matches the suffix in `package.json` mac.identity, e.g. `6669F65NH6`) |

Until these are set, `build:mac` will fail at the notarize step. Windows/Linux builds work without secrets (unsigned).

### Cutting a release in practice

There's no manual `npm version` step. Just merge the release PR that release-please opens. The rest is automated.

## npm Note

Databricks npm proxy (`npm-proxy.dev.databricks.com`) required. See go/npm-registry-access.

## Dev Workflow

- `npm start` — run the app
- `npm install` — auto-patches Electron icon + name
- `electron-reloader` for hot-reload (ignores `chat_history/` and `config/`)
- `index.html` / `preload.js` → instant refresh; `main.js` → auto restart

## Completed Tasks

- [x] Electron app scaffold
- [x] Databricks AI Gateway integration (MLflow + OpenAI Responses)
- [x] **Streaming responses** with SSE + typewriter effect (3 chars / 12ms)
- [x] **Auto-discovery of models** from gateway serving endpoints API
- [x] Custom model picker popup (grouped by provider, checkmarks)
- [x] Custom model endpoints via Settings (persisted per-workspace)
- [x] Gateway URL sanitization
- [x] **Per-workspace config** (workspaces.json): gateway, MCP, stdio, endpoints
- [x] Profile switching reloads everything automatically
- [x] Unified auth: OAuth primary + PAT fallback
- [x] In-app Authenticate button
- [x] Chat UI: user right-aligned, assistant full-width streamed
- [x] "Building..." animation (stacking bricks)
- [x] Dark/light mode with moon.webp toggle
- [x] **Syntax-highlighted code blocks** with language labels + copy button
- [x] Markdown rendering (marked.js + highlight.js, GitHub themes)
- [x] macOS dock icon + app name "Mason" (postinstall patch)
- [x] Window hidden until ready-to-show
- [x] Collapsible sidebar: chat history, new chat, profile, theme
- [x] Conversation history persistence (JSON)
- [x] Full-width responsive layout
- [x] Auto-resizing text input
- [x] Hot-reload (electron-reloader)
- [x] **Remote MCP servers** (HTTP Streamable Transport)
- [x] **Local MCP servers** (stdio transport, .mcp.json support)
- [x] MCP persistence per-workspace (HTTP + stdio), auto-reconnect
- [x] `+` popup: MCP Servers, Tools, Settings, Authenticate
- [x] MCP modal: remote (HTTP) + local (stdio) connection UI
- [x] **Tool filtering**: per-server and per-tool checkboxes
- [x] Tools modal: grouped by source, enable/disable, counter
- [x] Settings modal: gateway URL + custom endpoints + auto-load tools toggle
- [x] **Global MCP config** (`config/mcp_servers.json`): HTTP + stdio servers, `enabledByDefault` per-server
- [x] **Auto-load MCP tools** toggle in Settings (per-workspace, controls default tool state)
- [x] Green (remote) / blue (local) MCP badges
- [x] Tool call loop (max 10): built-in + HTTP MCP + stdio MCP
- [x] Built-in tools: write_file, read_file
- [x] System prompt injection for tool-aware models
- [x] Codex models: graceful degradation when tools connected
- [x] Comprehensive logging (AUTH, MCP, MCP-STDIO, CHAT, BUILTIN, MODELS, WORKSPACE)
- [x] **Dashboards tab**: sidebar nav (Chats/Dashboards), lists Lakeview dashboards, webview embed
- [x] Dashboard search + chat history search in sidebar
- [x] Dashboard list auto-refresh on profile switch
- [x] **Stop generation**: Send button swaps to stop icon, aborts in-flight request, preserves partial streamed content
- [x] **"Building..." animation** persists until first streaming chunk (not removed prematurely)
- [x] **Code copy button fix**: Delegated click handler (DOMPurify strips inline onclick handlers)
- [x] **Dark mode moon visibility**: `filter: invert(1)` on theme toggle image
- [x] **MCP stdio Browse button**: Native file dialog (`dialog.showOpenDialog`) for selecting `.mcp.json` files
- [x] **Unity Catalog external MCP**: Auto-discover UC HTTP connections from workspace, one-click connect via `{host}/api/2.0/mcp/external/{name}` proxy, reuses existing Streamable HTTP transport

## Production Readiness — MVP Roadmap

### Phase 1: Security (Critical — must fix before any external distribution)

- [x] **XSS mitigation**: DOMPurify added — all `marked.parse()` output sanitized before `innerHTML` assignment.
- [x] **Content Security Policy**: Tightened — explicit `script-src`, `style-src`, `connect-src`, `frame-src`, `img-src` directives. Scoped to Databricks domains.
- [ ] ~~**File path validation**~~: Deferred — future features will add smart file positioning and directory scoping. Unrestricted paths needed for now.
- [x] **Log sanitization**: `sanitizeLog()` helper scrubs Bearer tokens, PATs (`dapi****`), and access_tokens from all MCP/API log output.
- [x] **Request timeouts**: `fetchWithTimeout()` with AbortController on all fetch calls — 30s default, 120s for chat API.

### Phase 2: Electron Hardening & Distribution

- [x] **Electron-builder config**: `package.json` build config for macOS DMG/zip, Windows NSIS, Linux AppImage. App ID `com.databricks.mason`, hardened runtime, entitlements plist.
- [ ] **Auto-update**: Integrate `electron-updater` so customers receive patches automatically (GitHub Releases or S3-backed). (Deferred — requires publish infrastructure)
- [x] **Code signing + notarization**: Apple Developer ID signing + Apple notary service via `electron-builder` env vars (`CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Wired into `build.yml`. See **CI/CD** section.
- [x] **Crash reporting**: Global error handlers in both main process (`uncaughtException`, `unhandledRejection`) and renderer (`window.onerror`, `unhandledrejection`). Errors surfaced in chat UI.
- [x] **Window state persistence**: `electron-window-state` remembers window size/position across restarts.
- [x] **CI/CD pipeline**: Three workflows — `pr.yml` (PR validation across 3 OS), `release-please.yml` (Conventional Commits → release PRs → tags), `build.yml` (signed/notarized installers on tag). See **CI/CD** section.
- [x] **MCP process cleanup**: All stdio subprocesses killed on `app.before-quit`.

### Phase 3: Architecture & Code Quality

- [x] **Split monolithic index.html** (was ~2200 lines → 195 lines HTML). Split into 11 JS modules (`js/`) + 1 CSS file (`css/app.css`):
  - `state.js` — shared `window.mason` state object
  - `utils.js` — escapeHtml, genId, profile helpers, getAuthToken
  - `markdown.js` — marked + highlight.js + DOMPurify setup
  - `messages.js` — message rendering, welcome, thinking animation
  - `history.js` — chat history CRUD
  - `tools.js` — built-in + MCP tool definitions, filtering
  - `models.js` — model discovery, picker, selection
  - `mcp.js` — MCP server connect/disconnect, badges, auto-connect
  - `dashboards.js` — dashboard nav, list, embed
  - `chat.js` — send, chatLoop, streaming, tool execution
  - `app.js` — DOM refs, event wiring, startup sequence, error handlers
- [x] **State management**: All state consolidated into `window.mason` object (profiles, history, mcpServers, discoveredModels, etc.). Clear ownership.
- [ ] **Event listener cleanup**: Deferred — current architecture works, can optimize later with event delegation.
- [x] **Error boundaries**: Global `window.onerror` + `unhandledrejection` in renderer, `uncaughtException` + `unhandledRejection` in main process.

### Phase 4: Performance & Reliability

- [x] **OAuth token caching**: 4-minute TTL cache in main process. Avoids spawning `databricks auth token` CLI on every request. Cache cleared on profile switch + app quit.
- [x] **Context window management**: `trimHistory()` limits to last 50 messages + all system messages. Prevents token bloat on long conversations.
- [x] **Dashboard pagination**: `next_page_token` loop fetches all dashboards across pages (100 per page).
- [x] **MCP process cleanup on quit**: `app.before-quit` kills all stdio subprocesses (SIGTERM) + clears token cache.
- [x] **Periodic chat auto-save**: `setInterval` saves current conversation every 10 seconds for crash recovery.

### Phase 5: User Experience

- [x] **Keyboard shortcuts**: Cmd+N new chat, Cmd+L focus input, Cmd+, settings, Cmd+B toggle sidebar, Escape close all modals/popups.
- [x] **Loading states**: Model picker shows "Loading..." during discovery with error recovery.
- [x] **Offline detection**: `navigator.onLine` check before sending — surfaces "You appear to be offline" error.
- [x] **Accessibility (ARIA)**: `role="dialog"` + `aria-modal` on all modals, `aria-label` on buttons/inputs, `role="menu"` + `role="menuitem"` on popup, `role="listbox"` on model picker.
- [x] **Profile validation on select**: Tests auth token on profile switch, surfaces error with "Click Authenticate" guidance. Clears token cache on switch.
- [x] **Workspace URL validation**: `isValidDatabricksUrl()` validates `https://*.databricks.com` / `*.azuredatabricks.net` / `*.databricksapps.com` before saving gateway URL.
