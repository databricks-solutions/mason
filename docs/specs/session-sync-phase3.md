# Engineering Specification — Session Sync, Phase 3
## The runner tier: laptop daemon + lakebox for laptop-closed agentic work

**Status:** Draft for review (builds on [Phase 1](session-sync-phase1.md) and [Phase 2](session-sync-phase2.md))
**Branch:** `feat/session-sync`
**Target:** Mason v1.8.x — **build only if Phase 2 usage demonstrates demand**
**Last updated:** 2026-06-11

---

## 1. Summary

Phase 2's server turns cover chat + cloud tools, bounded by a token lifetime.
Phase 3 removes the two remaining limits by introducing **runners** —
execution hosts that connect *outbound* to the mason-sync app and execute
turns where the user's environment lives:

1. **Desktop runner** — Mason itself registers as a runner, so a turn sent
   from the phone can use local filesystem tools, stdio MCP servers, and
   skills *when the laptop is open*.
2. **Lakebox runner** — a headless `mason-runner` installed in a Databricks
   lakebox (`databricks lakebox`: SSH-accessible microVM, persistent storage,
   Node + Databricks CLI preinstalled). Sessions bound to a lakebox keep
   executing with full tooling and the user's own credentials **while the
   laptop is closed** — the headline of the whole program.

The architecture follows agent-framework's proven shape (server dispatches,
runner executes, server persists/relays), scaled down to single-user.

### Non-goals

- Multi-user/shared runners; runner marketplaces. A runner serves exactly its
  owning user.
- Harness plurality (agent-framework runs claude-code/codex *harnesses*;
  Mason's runner runs Mason's own loop only).
- Desktop-use / browser-automation environments.
- Mid-turn steering (carried as an open question from Phase 2).

---

## 2. Architecture

```
                         ┌────────────────────────────────────────┐
 Phone / web ──REST/SSE──►  mason-sync app (Databricks App)        │
 Desktop UI ──REST/SSE───►   • store + fanout (Phases 1–2)         │
                         │   • turn router (new)                   │
                         │   • runner registry (new)               │
                         └───────▲──────────────────▲─────────────┘
                                 │ outbound WS tunnel │ outbound WS tunnel
                                 │ (laptop)           │ (lakebox)
                    ┌────────────┴─────────┐  ┌───────┴───────────────┐
                    │ Desktop runner        │  │ Lakebox runner        │
                    │ (inside Mason main    │  │ (headless mason-runner│
                    │  process)             │  │  in microVM)          │
                    │ • local fs tools      │  │ • box fs tools        │
                    │ • stdio MCP           │  │ • stdio MCP           │
                    │ • skills              │  │ • skills (synced)     │
                    │ • turn engine         │  │ • turn engine         │
                    │ • user OAuth (CLI)    │  │ • user OAuth (CLI in  │
                    └──────────────────────┘  │   box, self-refreshing)│
                                              └───────────────────────┘
```

**Turn routing decision** (server, per send): bound runner online → dispatch
to it; else if turn's tool needs are cloud-safe → Phase 2 server engine; else
fail fast with a clear status ("runner offline").

---

## 3. Runner protocol

### 3.1 Identity and connection

- Stable `runner_id` (UUID) minted on first run, cached at
  `~/.mason/runner_id` (desktop) / `~/.mason-runner/runner_id` (lakebox).
- Connection is **always outbound** from the runner:
  `WS /api/v1/runners/{runner_id}/tunnel`, `Authorization: Bearer <user
  OAuth>`. The server resolves the user from the token; a runner can only
  ever serve sessions of that user. No inbound connectivity to laptop or box,
  ever.
- First frame (hello):

```jsonc
{ "kind": "hello", "runner_version": "0.1.0", "protocol_version": 1,
  "host_kind": "desktop" | "lakebox",
  "display_name": "Grant's MacBook" | "happy-panda-1234",
  "capabilities": {
    "tools": ["write_file", "read_file", "ask_user", "load_skill"],
    "stdio_mcp": ["ai-dev-kit"],          // from ~/.mason/config/mcp_servers.json
    "workspace_hosts": ["https://…"]       // profiles it can mint tokens for
  } }
```

- Heartbeat both directions every 25 s; registry entry expires at 60 s
  silence. Registry is in-memory + a `runners` table for *last-seen*
  metadata (so the UI can show "last online 2h ago" for offline runners).
- Reconnect: jittered backoff 1 s → 60 s, forever (matches the Phase 1
  publisher discipline).

### 3.2 Frames (all JSON text frames; protocol types in the shared package)

| Direction | Kind | Payload |
|---|---|---|
| server → runner | `dispatch_turn` | `{turn_id, session_id, model, messages, tools, budget}` — full prepared context; the runner is stateless across turns |
| server → runner | `cancel_turn` | `{turn_id}` |
| runner → server | `delta` | `{turn_id, seq, text}` (same shape as Phase 1 ephemeral deltas) |
| runner → server | `item` | `{turn_id, item}` — persisted by the server (persist-before-fanout still holds; the **server** owns positions) |
| runner → server | `elicitation` | `{turn_id, questions[]}` — `ask_user` escalation, §5 |
| server → runner | `elicitation_result` | `{turn_id, answer}` |
| runner → server | `turn_done` | `{turn_id, status: done\|failed\|cancelled, error?}` |

The runner runs the **same turn engine** as Phase 2 (shared package), with
its tool registry extended to local tools — so runner-vs-server execution
differs only in registry contents and where credentials come from.

### 3.3 Session ↔ runner binding

- `sessions.runner_id` (nullable). Set explicitly by the user (desktop:
  session menu → "Run on…: This laptop / happy-panda-1234 / Server"; web:
  same picker). Desktop-originated sessions default to the desktop runner.
- Binding is advisory routing, not ownership: if the bound runner is offline
  and the turn is cloud-safe, the user may retry "on server" with one tap.
- Session list (all surfaces) shows two independent indicators, exactly the
  distinction agent-framework draws: session state (`idle/running/failed`)
  and runner state (`online/offline/n-a`).

---

## 4. Desktop runner (Mason as a runner)

- Lives in the **main process** (`src/runner.ts`), enabled with sync; shares
  the existing token cache, MCP subprocess management, and `chat-shared`.
  When a `dispatch_turn` arrives, it executes headlessly and *also* emits the
  turn into the renderer via the Phase 2 merge path — the user watches it
  land in the desktop UI like any web-originated turn.
- Mutual exclusion folds into the Phase 2 turn lock unchanged (the server
  acquires before dispatching, regardless of executor).
- `ask_user` inside a desktop-runner turn renders the normal question card in
  the desktop UI **and** fans out as an elicitation frame (§5) — first answer
  wins, the other surface shows it resolved.

---

## 5. `ask_user` across surfaces (elicitation)

Runner emits `elicitation`; server persists an `elicitation` item (new item
type) and fans out. Any attached client may answer
(`POST /turns/{id}/elicitation`); the server enforces first-write-wins
(atomic update of the item's `status`), relays `elicitation_result` to the
runner, and the turn resumes. Timeout 10 min → tool result
`"user_unavailable"` so the model can proceed sensibly. This finally makes
`ask_user` phone-friendly: the agent works in a lakebox, pings your phone
with a question card, and continues on your answer.

---

## 6. Lakebox runner

### 6.1 Package and install

- `mason-runner`: a headless npm package (own folder `apps/mason-runner/`,
  reusing the shared protocol + engine; no Electron). CLI surface:
  `mason-runner start --server <app-url>`, `status`, `register`.
- **One-command setup from Mason desktop** (Settings → Runners → "Create
  lakebox runner"), which shells out to the Databricks CLI it already
  manages:

```
databricks lakebox create --name mason-runner        # idempotent if exists
databricks lakebox config <id> --idle-timeout 24h    # see lifecycle §6.3
databricks lakebox ssh <id> -- 'curl -fsSL <install-url> | bash'   # installs node pkg + systemd-style unit
databricks lakebox ssh <id> -- 'mason-runner register --server <app-url>'
```

- Install script drops the runner under `~/.mason-runner/` in the box and
  wires it to restart on box start.

### 6.2 Credential bootstrap (the hard part, solved explicitly)

The box must mint **the user's** OAuth tokens indefinitely without the
laptop. The box has the Databricks CLI preinstalled; its token cache
self-refreshes once seeded.

- Setup flow: during "Create lakebox runner", Mason runs
  `databricks lakebox ssh <id> -- 'databricks auth login --host <ws> --no-browser'`-style
  flow: the CLI prints the device/manual auth URL through the SSH channel;
  Mason surfaces it in the desktop UI as a one-click "Authorize runner" step
  (user completes consent in their browser); the resulting refresh token
  lands in the **box's** `~/.databrickscfg` cache and renews itself from then
  on. (Exact CLI flag surface for headless login must be verified during
  build — this is the single most likely point of CLI-version friction; the
  fallback is paste-the-code through the Mason UI.)
- Runner mints per-request tokens exactly like Mason main does
  (`databricks auth token`, 4-min cache). Tokens never leave the box; the
  laptop never ships its tokens to the box.
- Revocation = normal workspace OAuth revocation + `lakebox delete`.

### 6.3 Lifecycle

- Lakebox default idle-timeout (~10 m) would reap a runner that's merely
  waiting. Policy: runner boxes run with `--idle-timeout 24h`; the runner
  process itself reports `idle_since` to the server, and **Mason desktop**
  (next time it's online) offers "your lakebox runner has been idle 3 days —
  stop it?" rather than auto-`--no-autostop` (cost-respectful default; user
  can opt into `--no-autostop` for always-on).
- Turn dispatched to a *stopped* box: server marks it `waking`, the next
  desktop or web client online issues `databricks lakebox start` (desktop
  can; web can't — surfaced as "start your runner from Mason desktop or
  `databricks lakebox start`"). Auto-wake from the app is an open question
  (§9.2) — the app's SP cannot start a *user's* personal box today.
- Files: the box's persistent storage is the workspace for its sessions; git
  is the bridge to/from the laptop (documented pattern, not tooling, in this
  phase).

### 6.4 Skills and MCP in the box

- Skills: `mason-runner sync-skills` rsyncs `~/.mason/skills` over the SSH
  channel during setup and on demand from desktop Settings. ai-dev-kit MCP
  installs in the box via the same upstream installer (it's already
  CLI-driven; `DATABRICKS_SDK_UPSTREAM=mason-runner` for attribution).
- Stdio MCP config mirrors `~/.mason/config/mcp_servers.json` at sync time;
  per-box overrides live in the box.

---

## 7. Security model

- **Outbound-only** connectivity for both runner kinds; the SSH gateway and
  registered keys (`databricks lakebox register`) are the only path into a
  box, and Mason never opens listening ports on the laptop.
- A runner authenticates with the user's OAuth and is **scoped to that
  user's sessions** server-side on every frame (the tunnel carries no
  session authority — the server validates `turn_id → session → user` on
  each frame).
- Dispatch payloads carry conversation content but **never tokens**; each
  side mints its own credentials.
- Tool blast radius: lakebox runners get filesystem tools scoped to the box
  (a sandbox by construction — arguably *safer* than today's desktop
  `write_file`, which Phase 3 leaves unchanged).
- `sanitizeLog` discipline extends to runner logs (`~/.mason-runner/logs/`).

---

## 8. Testing

1. **Protocol:** frame-level unit tests (hello/heartbeat/expiry, dispatch →
   delta/item/done ordering, cancel mid-turn, elicitation first-write-wins,
   cross-user frame rejection).
2. **Engine parity on runner:** `test:models --engine runner` against a local
   runner process — same 81-scenario sweep, third execution surface.
3. **Chaos:** kill tunnel mid-turn (turn fails clean, lock released, session
   shows runner offline); kill server mid-turn (runner detects, aborts,
   reconnects, re-hellos).
4. **Lakebox end-to-end (manual, against a dev workspace):** full setup flow
   from desktop Settings; phone-initiated turn with `write_file` + stdio MCP
   executing in the box, laptop lid closed; `ask_user` answered from the
   phone; token refresh across the 1-h boundary; box stop/start/wake cycle.
5. **Desktop regression:** sweep + manual smoke with sync/runner disabled —
   zero behavior change remains the standing gate.

---

## 9. Open questions

1. **Headless `databricks auth login` flow** — exact flag surface for
   no-browser/device-code login must be validated against the shipping CLI
   (it's `v1.1.1-dev` territory). Fallback design (paste-code through Mason
   UI) is specified in §6.2 but adds a setup step.
2. **Auto-wake of a stopped lakebox** — can the app (or a phone client) start
   a user's box without the desktop? Today: no API path identified; turns
   queue as `waking` until something with the CLI starts it. Revisit when
   lakebox publishes a REST surface.
3. **Lakebox product maturity** — personal-sandbox semantics, quotas, and the
   SSH gateway are all early. Every lakebox touchpoint is isolated in
   `boxHost.ts` + the install script so a product shift stays contained.
4. **Workflow designer on runners** — the designer's engine is renderer-bound
   today; once the shared turn engine exists, designer runs become
   dispatchable too (cells bound to runners). Deliberately out of scope, but
   the dispatch frame's `budget` field is sized with it in mind.
5. **Desktop runner + laptop sleep** — macOS app nap / sleep kills the
   tunnel; do we take a power assertion while a desktop-runner turn is
   active (matching what users expect from "it's running on my laptop")?
   Default: yes, scoped to active turns.
