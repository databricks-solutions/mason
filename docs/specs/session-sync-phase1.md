# Engineering Specification — Session Sync, Phase 1
## Databricks App session server + desktop mirror mode + mobile web viewer

**Status:** Draft for review
**Branch:** `feat/session-sync`
**Target:** Mason v1.6.x
**Last updated:** 2026-06-11

---

## 1. Summary

Give Mason sessions a **cloud presence**: a small session server running as a
Databricks App (Lakebase-persisted) that the desktop app **mirrors** chats
into, and a mobile-first web viewer served by that same app so users can watch
their conversations live from a phone (Databricks One app or any browser).

Phase 1 is deliberately a **mirror, not a migration**:

- The desktop keeps running exactly today's chat loop. `~/.mason/chat_history/`
  remains the desktop's source of truth. The mirror is an async, fire-and-forget
  publisher that degrades silently when the server is unreachable.
- The web surface is **read-only** (live viewer). Sending from the phone is
  Phase 2 (server-side turn execution with on-behalf-of-user auth). The runner
  tier (laptop daemon / lakebox) is Phase 3.
- Everything is **opt-in per workspace** (`sessionServer` in
  `workspaces.json`), default off. A user who never configures it runs
  byte-identical behavior to v1.5.x.

### Why this slice first

1. It forces the protocol design (event schema, snapshot+stream contract) that
   Phases 2–3 hang off, while touching almost none of the existing code.
2. It ships standalone user value: your chats, streaming live, on your phone.
3. If we hate the weight after using it, we delete a publisher module and an
   app folder; Mason proper is untouched.

### Explicit non-goals (Phase 1)

- Sending messages from the web/phone (Phase 2).
- Running turns server-side; OBO model calls (Phase 2).
- Laptop daemon, lakebox runners, remote file access (Phase 3).
- Multi-user sharing of sessions. The store is per-user-scoped from day one,
  but no sharing UI/permissions exist.
- Workflow-designer run mirroring (chat sessions only; designer events are a
  natural Phase 2+ extension of the same event table).

---

## 2. Architecture

```
┌────────────────────────────┐                ┌──────────────────────────────────────┐
│ Mason desktop (Electron)   │                │ Databricks App: "mason-sync"          │
│                            │   HTTPS        │  Node 20 + Fastify (TypeScript)       │
│  chat loop (unchanged) ─┐  │   Bearer       │                                       │
│                         ▼  │   (user OAuth) │  REST: sessions / events / deltas     │
│  src/sync.ts publisher ────┼───────────────►│  SSE:  per-session live stream        │
│  (async queue, retry,      │                │        + session-list stream          │
│   silent degrade)          │                │                                       │
└────────────────────────────┘                │  Lakebase (Postgres) ── sessions,     │
                                              │                         session_items │
┌────────────────────────────┐   HTTPS (OBO   │                                       │
│ Phone / browser            │   via app      │  Static: mobile web viewer (read-only)│
│ (Databricks One / Safari)  │◄──────────────►│                                       │
└────────────────────────────┘   ingress)     └──────────────────────────────────────┘
```

Three sync rules (adopted from the agent-framework architecture, scaled down):

1. **Persist-before-fanout.** `POST /v1/sessions/{id}/items` writes to Lakebase
   before the event is fanned out to SSE subscribers.
2. **Snapshot + live-tail + dedupe-by-id.** A viewer opens the SSE stream
   *first*, then fetches the snapshot, and drops any streamed item whose id is
   already in the snapshot. No server-side replay buffer needed.
3. **Single writer.** In Phase 1 the desktop is the only writer for a session,
   so there is no concurrency protocol yet. The schema carries
   `origin: "desktop"` on items so Phase 2 can introduce other writers without
   migration.

---

## 3. Data model (Lakebase)

Two tables, owned by the app's schema (`mason_sync`). All user scoping is by
the Databricks user email resolved from auth (never client-supplied).

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,        -- Mason chat id (genId), client-supplied
  user_email    TEXT NOT NULL,           -- resolved server-side from auth
  title         TEXT NOT NULL DEFAULT 'New chat',
  model_label   TEXT,                    -- display only
  workspace_host TEXT,                   -- which profile this chat belongs to
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ              -- soft delete (mirror of local delete)
);
CREATE INDEX sessions_user_updated ON sessions (user_email, updated_at DESC);

CREATE TABLE session_items (
  id          TEXT NOT NULL,             -- item id (genId on desktop)
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  position    INTEGER NOT NULL,          -- application-managed, dense per session
  type        TEXT NOT NULL,             -- 'message' | 'tool_call' | 'tool_result'
  origin      TEXT NOT NULL DEFAULT 'desktop',
  data        JSONB NOT NULL,            -- type-discriminated payload (below)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id)
);
CREATE UNIQUE INDEX session_items_pos ON session_items (session_id, position);
```

### Item payloads (`data`)

Shapes mirror Mason's existing chat-completions history entries
([src/chat.ts](../../src/chat.ts)) so the publisher is a thin mapping, not a
translation layer:

```jsonc
// type: "message"
{ "role": "user" | "assistant", "content": "markdown text" }
// images are mirrored as a placeholder text part in Phase 1 (see §9 Open questions)

// type: "tool_call"  (one item per call in an assistant turn)
{ "name": "read_file", "arguments": "{...json string...}", "call_id": "tc_…",
  "preamble": "assistant text preceding the calls, first item only" }

// type: "tool_result"
{ "call_id": "tc_…", "name": "read_file",
  "preview": "first 500 chars",          // viewer shows preview only
  "truncated": true }
```

**Deliberate choice:** tool results are mirrored as *previews* (500 chars),
not full payloads. Full results can be 256 KB each (MAX_TOOL_RESULT_CHARS),
exist locally anyway, and a phone viewer needs the gist. Phase 2 revisits
this when the server runs turns itself.

---

## 4. Wire protocol

All endpoints under `/api/v1`. Auth: §6.

### REST

| Endpoint | Semantics |
|---|---|
| `PUT /sessions/{id}` | Upsert session row (title, model_label, workspace_host). Idempotent; desktop calls on create/rename. |
| `DELETE /sessions/{id}` | Soft-delete (mirrors local delete). |
| `GET /sessions?limit=50` | Caller's sessions, `updated_at DESC`. |
| `POST /sessions/{id}/items` | Body: `{ items: [ {id, type, data}, … ] }` (batch). Server assigns `position` (next dense integers, in array order, single transaction), persists, then fans out. Idempotent on item id: duplicates are acked, not re-inserted (the desktop queue retries safely). Returns `{ ok, positions }`. |
| `GET /sessions/{id}` | Snapshot: session row + last 200 items ascending + `{ live: bool }` (a delta stream is currently active). |
| `POST /sessions/{id}/deltas` | **Ephemeral, not persisted.** Body: `{ turn_id, seq, text }` where `text` is the full streamed text so far (not an increment — idempotent, loss-tolerant). Fanned out to SSE subscribers. 404s never error the desktop. |

### SSE

| Stream | Frames |
|---|---|
| `GET /sessions/{id}/stream` | `item` (persisted item with position), `delta` (`{turn_id, seq, text}`), `session` (title/model changed), `heartbeat` every 25 s |
| `GET /sessions/stream` | session-list: `changed` (session row), `removed` (id), `heartbeat` |

Frames are `data: {json}\n\n` with `event:` set to the frame kind. 25 s
heartbeats keep the Databricks Apps ingress from idling out the connection;
the viewer reconnects with jittered backoff (250 ms → 5 s) and a 60 s
no-frame watchdog, then re-runs the snapshot+dedupe attach sequence.

### Viewer attach sequence (the dedupe contract)

```
1. open GET /sessions/{id}/stream          (buffer incoming frames)
2. GET /sessions/{id}                      (snapshot, last 200 items)
3. render snapshot; drain buffered frames, dropping item ids already rendered
4. live: items append; deltas render as the in-progress bubble (replaced by
   the persisted assistant item when it arrives — matched by turn_id)
```

---

## 5. Desktop changes (the only part that touches Mason)

One new module + four call sites. **No changes to chatLoop's control flow.**

### `src/sync.ts` — the mirror publisher (~250 lines)

- **State:** in-memory FIFO queue of pending ops `{kind, sessionId, payload}`;
  `syncEnabled` derived from workspace config; consecutive-failure counter.
- **API (called from existing code):**
  - `syncSessionUpsert(id, title, modelLabel)` — from `saveCurrentChat()` and rename.
  - `syncItems(id, items[])` — called with the *new* history entries after each
    turn completes (user message at send; assistant/tool items when the turn
    resolves). Item ids are generated at enqueue time and embedded so retries
    are idempotent.
  - `syncDelta(id, turnId, seq, fullText)` — hooked to the existing
    `onChatChunk` accumulation in chatLoop, throttled to ≥400 ms between posts.
    Best-effort: failures are dropped, never queued.
  - `syncSessionDelete(id)` — from history delete.
- **Behavior:** drain loop posts batches with 5 s timeout; on failure, backoff
  1 s → 2 s → … → 60 s; after 5 consecutive failures, log `[SYNC]` once and
  keep queueing up to 500 ops (then drop-oldest — the server can always be
  re-seeded from local history later). Queue drains on reconnect. Nothing in
  the chat path ever awaits the publisher.
- **Re-seed:** `syncBackfill(id)` pushes an entire local chat (used when
  enabling sync on a workspace with existing history, and as the recovery
  path after drop-oldest).

### Call-site touches

| File | Change |
|---|---|
| [src/chat.ts](../../src/chat.ts) | After user-message push: `syncItems`. After turn completion (text branch + tool_calls branch): `syncItems` with the turn's new entries. Inside the chunk listener: `syncDelta` (throttled). ~10 lines total, all fire-and-forget. |
| [src/history.ts](../../src/history.ts) | `syncSessionDelete` on delete; `syncSessionUpsert` on save/rename. |
| [src/app.ts](../../src/app.ts) | Load `sessionServer` from workspace config on startup/profile switch. |
| Settings UI | One field: "Session sync server URL" + an Enable toggle + "Backfill existing chats" button, in the existing Settings view. Persisted per-profile in `workspaces.json` (`sessionServer: { url, enabled }`). |

Auth: the publisher reuses `getAuthToken()` (existing OAuth path) as a Bearer
token on every request — Databricks Apps accept workspace user OAuth tokens
for programmatic access.

---

## 6. The app: `apps/mason-sync/`

Lives in the Mason repo under `apps/mason-sync/` (own `package.json`; not part
of the Electron build). **Node 20 + Fastify + TypeScript + pg** — same
language as Mason so event types are shared, not duplicated: the wire types
live in `apps/mason-sync/shared/protocol.ts` and are consumed by both the
server and `src/sync.ts` (copied via a build step, not a workspace dep, to
keep the Electron build untouched).

### Auth

- **Browser (viewer):** Databricks Apps ingress injects
  `X-Forwarded-Email` / `X-Forwarded-Access-Token`. The server trusts only
  these headers for browser requests.
- **Desktop (publisher):** `Authorization: Bearer <user OAuth token>`; the
  server resolves the user via `GET /api/2.0/preview/scim/v2/Me` against the
  workspace host (cached 5 min per token hash).
- Every query is scoped `WHERE user_email = $resolvedUser`. Session ids are
  never trusted as authorization.

### Lakebase connectivity (patterns from `lakebase-fastapi-app`, ported to Node)

- App resource binding (`databricks.yml`) injects `PGHOST`/`PGDATABASE` etc.;
  `ENDPOINT_NAME` via app env.
- OAuth DB credentials (~60 min): background refresh at 45 min with
  bounded-backoff retries `[5,15,30,60,120]s`, plus a connect-time staleness
  guard; `pg.Pool` with `max 5`, keep-alive, connection `statement_timeout`,
  pool recycle under the token lifetime.
- Schema migration: a single idempotent `CREATE TABLE IF NOT EXISTS` bootstrap
  on startup (two tables; no migration framework until Phase 2 needs one).
- All data routes 503 until the pool is initialized (`require_db` pattern);
  `/healthz` is DB-independent.

### SSE fanout

In-memory `Map<sessionId, Set<reply>>` per process. **Run a single app
process** (`--workers 1` equivalent) in Phase 1 so fanout needs no cross-
process bus; the publisher load (one user's chats) makes this a non-issue.
Scaling beyond that is a Phase 2 concern (Postgres `LISTEN/NOTIFY` is the
designated path and works on Lakebase).

### Provisioning (DABs)

`databricks.yml` at `apps/mason-sync/`, following the lakebase-fastapi-app
shape: `postgres_projects` (autoscaling 0.5–4 CU, suspend 300 s) →
`postgres_branches` → `postgres_endpoints` → `apps.mason_sync` with a
`postgres` resource binding (`CAN_CONNECT_AND_CREATE`) and `ENDPOINT_NAME`
env. One `databricks bundle deploy -t dev` provisions everything.
`app.yaml`: `node server.js` + pool-tuning env only.

---

## 7. Web viewer

Mobile-first, read-only, deliberately small (~600 lines, no framework):
vanilla TS + the same marked/highlight.js/DOMPurify pipeline as the desktop
(`src/markdown.ts` is reused nearly verbatim — it has no Electron
dependencies).

- **Session list:** newest-first, title + model chip + relative time; live via
  the session-list SSE stream.
- **Transcript:** desktop-equivalent rendering — user bubbles right-aligned,
  assistant markdown full-width, tool calls as the familiar blue monospace
  lines (preview text), in-progress turn rendered from `delta` frames with the
  same `safeMarkdownPos` holdback (function moves to the shared protocol
  package — it's pure).
- **Read-only affordance:** a pinned footer — "Watching live · send from Mason
  desktop" — so the missing composer reads as intentional, not broken.
- Served statically by the same Fastify app at `/`.

---

## 8. Testing & verification

1. **Protocol unit tests** (`apps/mason-sync/test/`): position assignment,
   idempotent re-POST of the same item ids, user scoping (cross-user 404s),
   snapshot+dedupe attach (simulated interleaving), delta ordering by `seq`.
2. **Publisher unit tests:** queue drain ordering, backoff, drop-oldest,
   idempotent retry after partial failure, "nothing awaits sync" (chat
   latency unchanged with server down — assert no await on the hot path).
3. **Local end-to-end:** run the app with plain local Postgres in Docker
   (`PGHOST` overrides, no Databricks needed); desktop in sync mode against
   `http://localhost:8000`; phone-sized browser window attached: send a
   streamed, tool-bearing chat and verify live mirroring + reconnect/dedupe
   (kill and restart the server mid-turn).
4. **Live smoke:** deploy to a dev workspace via DABs; verify OBO headers,
   Lakebase token rotation across the 60-min boundary (soak), SSE through the
   real ingress incl. heartbeat survival, viewer in the Databricks One app.
5. **Regression gate:** `npm run test:models` (chat request path untouched —
   should be trivially green) + manual desktop smoke with sync disabled to
   confirm zero behavior change.

---

## 9. Open questions (decide before build)

1. **Image attachments in mirrored messages** — Phase 1 mirrors a
   `[image attached]` placeholder (data URLs can be MBs and Lakebase rows
   shouldn't carry them). Acceptable? Alternative: UC Volumes artifact store,
   which is Phase 2 scope.
2. **System prompts / skills manifest** — not mirrored (they're request-time
   assembly, not history). Confirm the viewer doesn't need them.
3. **Retention** — mirrored sessions live until deleted from the desktop.
   Do we want a server-side TTL (e.g., 90 days) from day one?
4. **App naming/placement** — `apps/mason-sync/` in this repo vs. a separate
   repo. In-repo keeps the shared protocol types honest; separate keeps the
   public repo smaller. Spec assumes in-repo.

---

## 10. Phase boundaries (for orientation, not commitment)

| Phase | Adds | Hard parts deferred to it |
|---|---|---|
| **1 (this spec)** | Server-of-record store, mirror publisher, mobile viewer | — |
| **2** | Send from web; server-side chat-only turns (OBO token valid for the life of the streamed request); UC/HTTP MCP server-side; full tool results + artifacts; multi-writer concurrency (single-writer turn lock) | Second agent-loop implementation (contained by `chat-shared`), LISTEN/NOTIFY fanout |
| **3** | Runner tier: laptop daemon, then lakebox (`databricks lakebox`) for laptop-closed agentic work with filesystem/stdio tools | Outbound tunnel protocol, runner lifecycle, in-box credential bootstrap |

Phase 1 schema decisions made for forward-compat: `origin` on items, dense
`position` for cursoring, soft deletes, per-user scoping, `turn_id` linking
deltas to their eventual persisted item.
