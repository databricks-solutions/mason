# Engineering Specification — Session Sync, Phase 2
## Send from web: server-side turns, multi-writer sessions, full artifacts

**Status:** Draft for review (builds on [session-sync-phase1.md](session-sync-phase1.md))
**Branch:** `feat/session-sync`
**Target:** Mason v1.7.x — only after Phase 1 has been used in anger
**Last updated:** 2026-06-11

---

## 1. Summary

Phase 1 made the phone a live *viewer*. Phase 2 makes it a *participant*: a
composer in the web UI, with the **server executing chat turns on behalf of
the user** — laptop closed, no daemon. This is the "Genie, but any Gateway
model plus your MCP tools" milestone.

The enabling fact: a Databricks App receives the user's on-behalf-of-user
(OBO) token on every request. A turn initiated from the phone can run
server-side with the user's own identity — model calls hit the AI Gateway *as
the user*, UC MCP tools route through the workspace proxy *as the user* —
preserving Mason's attribution and governance story exactly.

What this phase deliberately does **not** do: local filesystem tools, stdio
MCP, skills, or long autonomous runs that outlive a token. Those need a
runner (Phase 3). Server-side turns are **chat + cloud tools only**, with a
hard turn deadline.

### Goals

1. Web composer: send a message from the phone into any of your sessions.
2. Server-side agent loop (chat-completions only) reusing `chat-shared`
   semantics: streaming, tool-call accumulation, Anthropic caching,
   multi-system collapse, per-family `max_tokens`, sanitization.
3. Server-side tool execution for **cloud-safe tools**: UC MCP (workspace
   proxy) and HTTP MCP (`*.databricksapps.com`).
4. Multi-writer safety: desktop and web can both send; one in-flight turn per
   session, enforced server-side.
5. Desktop becomes bidirectional: web-originated turns appear live in the
   desktop UI and merge into local history.
6. Full tool results + image attachments persisted (UC Volumes artifact
   store), replacing Phase 1's previews/placeholders.
7. Multi-process app scaling via Postgres `LISTEN/NOTIFY` fanout.

### Non-goals

- Filesystem/stdio tools, skills, `ask_user` from server turns (Phase 3 —
  `ask_user` needs the elicitation frames introduced there).
- Autonomous multi-hour runs (token lifetime bounds a turn; Phase 3 runners
  hold their own credentials).
- Sharing sessions across users.

---

## 2. Architecture deltas from Phase 1

```
Phone ──POST /messages──► mason-sync app ──┐
                                           │ server turn (OBO token):
Desktop ──POST /items (mirror)──►          │   Gateway chat-completions (SSE)
Desktop ◄──SSE items/deltas──── Lakebase ◄─┘   UC/HTTP MCP tool calls
   │                                        items persisted + fanned out
   └── pull/merge on reconnect (cursor by position)
```

New server responsibilities: **turn engine**, **turn lock**, **tool
registry (cloud subset)**, **artifact store**, **NOTIFY fanout**.
New desktop responsibilities: **subscribe + merge** (it already publishes).

---

## 3. Server-side turn engine

### 3.1 The second agent loop, contained

This phase creates the thing Phase 1 avoided: a second implementation of the
agent loop. Containment strategy — `chat-shared.ts` (already dependency-free)
moves into the shared protocol package and is consumed by three parties:
desktop main process, `scripts/test-models.js`, and the server turn engine.
The loop itself (`apps/mason-sync/src/turn-engine.ts`) mirrors
[src/chat.ts](../../src/chat.ts) `chatLoop` semantics:

- SSE streaming with per-index tool-call delta accumulation (port of the
  main.ts SSE loop — including `flattenContent` on array-shaped
  `delta.content`).
- `consolidateSystemMessages`, `maxTokensFor`, `supportsStreamOptions`,
  `applyAnthropicCaching`, `sanitizeToolCalls` — all from `chat-shared`.
- Iteration budget 40; tool-result cap 256 KB; empty-response detection.
- **Turn deadline:** 10 minutes hard wall-clock (well inside OBO token
  validity). On deadline: persist partial output + a `turn_error` note,
  release the lock.

`npm run test:models` gains a `--engine server` mode that drives the sweep
through the turn engine against the live gateway — the same 81-scenario
matrix guards both loops.

### 3.2 What a server turn can call

| Tool class | Server-side? | How |
|---|---|---|
| UC MCP (`/api/2.0/mcp/external/…`) | ✅ | Workspace proxy with OBO token — identical JSON-RPC client as desktop `mcp.ts`, ported |
| HTTP MCP (`*.databricksapps.com`) | ✅ | Direct, OBO bearer |
| `write_file` / `read_file` | ❌ | Rejected with a structured tool error: *"requires the desktop or a runner (Phase 3)"* — the model sees it and adapts |
| stdio MCP | ❌ | Not in server tool registry at all |
| `ask_user` | ❌ | Excluded from server turns until Phase 3 elicitation |
| `load_skill` | ❌ | Skills live on the user's machine; excluded (revisit: mirror skills server-side) |

Tool *selection* for a web-initiated turn: the session's last-known enabled
tool set, mirrored by the desktop into the session row
(`sessions.enabled_tools JSONB`, new column) — filtered to the cloud-safe
subset. The web composer shows which tools are active and which are
desktop-only.

### 3.3 Model routing

The server runs model discovery (`/api/2.0/serving-endpoints`, OBO) with the
same READY/`api_types` filtering as [src/models.ts](../../src/models.ts),
cached 10 min per user. The composer offers the same grouped picker; the
session's last-used model is the default. `resolveModelRouting` logic ports
with `chat-shared`. Responses-only models are **excluded** from web sends in
this phase (the engine speaks chat-completions only) and shown disabled.

### 3.4 Token handling rules

- The OBO token is held in memory for the life of the turn, never persisted,
  never logged (reuse `sanitizeLog` patterns).
- Turn outlives the HTTP request: `POST /messages` returns `202 {turn_id}`
  immediately; the turn runs as a server task; output arrives on the
  session's existing SSE stream (same frames as Phase 1 deltas/items, so the
  Phase 1 viewer needs zero changes to *display* server turns).
- If the token expires mid-turn (long tool call), the turn fails cleanly with
  a visible `turn_error` item. No refresh attempts — refresh is a runner
  concept (Phase 3).

---

## 4. Multi-writer concurrency

### 4.1 Turn lock (the only new invariant)

```sql
CREATE TABLE turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  origin      TEXT NOT NULL,              -- 'desktop' | 'web'
  status      TEXT NOT NULL,              -- 'running' | 'done' | 'failed' | 'cancelled'
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_running_turn ON turns (session_id) WHERE status = 'running';
```

- **Acquire:** insert with `status='running'`; the partial unique index makes
  acquisition atomic. Conflict → `409 {active_turn: {origin, started_at}}`.
- **Web send during desktop turn:** composer disables with "Mason desktop is
  responding…" (it knows from the `turn` SSE frame, new in this phase).
- **Desktop send during web turn:** desktop checks/locks too — `send()` gains
  one pre-flight `POST /turns` acquire when sync is enabled (this is the
  first sync call allowed to block the chat path, by design: without it two
  writers corrupt a session). Sync disabled ⇒ no lock, today's behavior.
- **Desktop turns** acquire on send and release on completion; items flow
  through the existing Phase 1 mirror calls tagged with the `turn_id`.
- **Stale locks:** turns `running` past deadline+60 s are swept to `failed`
  by a periodic job (server restart mid-turn otherwise wedges the session).
- No mid-turn steering in this phase (agent-framework's `inbox_closed`
  handshake is noted as the Phase 3+ design if we want it).

### 4.2 Desktop merge (web turns → local history)

The desktop subscribes to `GET /sessions/stream` (it already has the client
code shape from the viewer) and, for sessions it has locally:

- Live: `item` frames with `origin='web'` append to `mason.history` and
  render via existing `addMessageEl`/markdown paths (dedupe by item id —
  the desktop tags its own mirrored items, so echoes are dropped).
- Reconnect/offline catch-up: per-session cursor = highest `position` seen;
  `GET /sessions/{id}/items?after={cursor}` (new endpoint, simple range read)
  merges missed items in order, then `saveCurrentChat()` persists locally.
- Local JSON remains the desktop's source of truth for *desktop-originated*
  content; merged web items become part of it after merge (single linear
  history — positions give a total order, so there is no merge conflict by
  construction: the turn lock guarantees writers never interleave).

---

## 5. Full artifacts (replacing Phase 1 previews)

- **Tool results:** full payload persisted. ≤ 8 KB inline in
  `session_items.data`; larger → UC Volumes object
  (`dbfs:/Volumes/<catalog>/<schema>/mason_sync/{session}/{item}.txt`) with
  `data` holding `{preview, artifact_path, size}`. Viewer/desktop fetch on
  demand via `GET /items/{id}/artifact` (server streams from the volume, OBO).
- **Images:** same volume store; mirrored messages carry
  `{artifact_path, mime}` instead of Phase 1's placeholder. Desktop publisher
  uploads via a new `PUT /sessions/{id}/artifacts` before posting the item.
- Volume is bundle-provisioned (`databricks.yml` gains a `volumes` resource;
  app SP gets `READ_VOLUME`/`WRITE_VOLUME`).

---

## 6. Scaling the fanout

Phase 1 ran one process. Server turns are long-lived tasks, so Phase 2 moves
to N processes behind the app ingress:

- All persisted-item writes `NOTIFY mason_sync_events, '{session_id,
  item_id}'`; every process `LISTEN`s and forwards to its local SSE
  subscribers (re-reading the item by id — NOTIFY payload limit 8 KB).
- Ephemeral deltas also ride NOTIFY (they're small full-text snapshots and
  loss-tolerant by design; if one exceeds 7 KB, truncate the notify payload —
  the persisted item carries the full text).
- Turn tasks run in whichever process accepted the POST; the lock table makes
  placement irrelevant.

---

## 7. Web UI additions

- **Composer** (sticky bottom bar): textarea + model picker + send/stop. Stop
  issues `POST /turns/{id}/cancel` (engine aborts its in-flight fetch — same
  AbortController pattern as desktop `abort-chat`).
- **Turn presence:** "Desktop is responding…" / "Running on server…" states
  from `turn` frames.
- **Tool-call rendering** upgraded from preview lines to expandable cards
  (fetch full artifact on tap).
- Still no settings/MCP management on web — tool/server configuration remains
  a desktop concern; web consumes the mirrored configuration.

---

## 8. Testing

1. **Engine parity:** `test:models --engine server` — full sweep through the
   turn engine (this is the headline regression gate for the second loop).
2. **Lock semantics:** unit tests — concurrent acquire (one wins, one 409),
   stale-lock sweep, desktop pre-flight behavior with sync on/off.
3. **Merge:** desktop offline during a web turn → reconnect → cursor
   catch-up produces identical history to a live desktop (golden transcript
   compare); echo-dedupe of desktop's own items.
4. **Token-expiry turn:** forced short-lived token → clean `turn_error`,
   lock released.
5. **End-to-end:** phone sends → server turn with a UC MCP tool → desktop
   shows the turn live → desktop replies → phone shows it. Both directions
   through a real deployed app.

---

## 9. Open questions

1. **Mid-turn steering** — adopt the `inbox_closed` handshake now or keep
   strict turn-locking? Recommendation: strict locking; steering only if
   Phase 2 usage shows real demand.
2. **Skills server-side** — mirror `~/.mason/skills` into the store so server
   turns can `load_skill`? Cheap, but widens scope; default no.
3. **Responses-API models on web** — port the Responses translation layer to
   the engine, or keep them desktop-only? Default: defer.
4. **Web send to a session whose model is unavailable in the user's current
   workspace** — block with explanation (mirrors `loadChat` policy) or allow
   model switch? Default: block + offer picker.
