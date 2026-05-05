# Mason — Agent Instructions

## Quick Start

```
npm install    # postinstall runs scripts/patch-icon.js (macOS only, patches Electron.app icon/name)
npm start      # launches Electron with electron-reloader for hot-reload
```

- No test suite, no linter, no typecheck, no bundler
- `npm run build:mac` / `build:win` / `build:linux` — production builds via electron-builder
- CI: push `v*` tag → `.github/workflows/build.yml` builds all 3 platforms + creates GitHub Release

## Prerequisites

- **Databricks CLI** must be installed (`databricks auth token`, `databricks auth login`)
- **Databricks npm proxy** (`npm-proxy.dev.databricks.com`) required for `npm install` — see go/npm-registry-access
- `~/.databrickscfg` must exist with at least one profile containing `host`

## Architecture Gotchas

- **No build step** — JS files loaded directly by Electron. Edit `js/*.js` or `css/app.css` → instant reload. Edit `main.js` → Electron restarts automatically.
- **All state** lives in `window.mason` (renderer process). See `js/state.js`.
- **IPC**: main ↔ renderer via `contextBridge` in `preload.js`. Never call main-process APIs directly from renderer.
- **`main.js`** is the single main-process file (~1500+ lines): auth, API routing, MCP (HTTP + stdio), model discovery, streaming, file operations, chat abort.
- **Auth**: OAuth first (`databricks auth token --profile <name>`), PAT fallback from `~/.databrickscfg`. Token cached with 4-min TTL in main process — cleared on profile switch + app quit.
- **Shell PATH quirk**: Packaged macOS apps don't inherit shell PATH. `getShellEnv()` in `main.js` resolves via `$SHELL -l -c 'echo $PATH'`. All `databricks` CLI calls use this env.
- **Streaming**: SSE for MLflow chat completions. Falls back to non-streaming when tools are active (tool call loop needs full response).
- **Tool call loop**: max 10 iterations. Built-in → HTTP MCP → stdio MCP → results → back to model.
- **MCP stdio**: subprocesses with 30s timeout. All killed on `app.before-quit` (SIGTERM).

## Config Files

| File | Scope | Purpose |
|------|-------|---------|
| `config/workspaces.json` | Per-profile | gatewayUrl, MCP servers, stdio servers, custom endpoints, autoLoadTools |
| `config/mcp_servers.json` | Global | Shared MCP servers (HTTP + stdio), `enabledByDefault` per-server |
| `chat_history/*.json` | Local | Conversation persistence |

- Profile switching auto-reloads: gateway URL, models, MCP servers (HTTP + stdio), custom endpoints
- Profile validation on select: tests auth token, clears token cache on switch

## Keyboard Shortcuts

`Cmd+N` new chat · `Cmd+L` focus input · `Cmd+,` settings · `Cmd+B` toggle sidebar · `Escape` close modals

## Logging Prefixes

`[AUTH]` `[MCP]` `[MCP-STDIO]` `[CHAT]` `[BUILTIN]` `[MODELS]` — terminal output
`[CHAT]` `[MODELS]` `[WORKSPACE]` `[MCP UI]` — DevTools console

## Security

- DOMPurify sanitizes all `marked.parse()` output before `innerHTML`
- CSP scoped to Databricks domains
- `sanitizeLog()` scrubs Bearer tokens, PATs (`dapi****`), access_tokens from all log output
- `fetchWithTimeout()` on all fetches — 30s default, 120s for chat API
- Built-in file tools have unrestricted paths (by design for MVP)

## For more detail

Read `CLAUDE.md` — comprehensive architecture reference with full module breakdown, MCP integration details, tool system, streaming behavior, production roadmap, and completed feature inventory.
