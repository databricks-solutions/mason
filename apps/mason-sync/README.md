# mason-sync

Session-sync server for Mason (Phase 1): the desktop app mirrors chats here;
a mobile-first web viewer (served at `/`) follows them live. See
[docs/specs/session-sync-phase1.md](../../docs/specs/session-sync-phase1.md).

## Local dev (no Databricks, no Postgres)

```bash
npm install
npm run dev          # in-memory store + dev identity on http://localhost:8787
```

Then in Mason desktop: Settings → Session Sync → URL `http://localhost:8787`,
toggle Enable. Open `http://localhost:8787` in a browser for the viewer.

`npm test` runs the protocol test suite (in-memory store, no network).

## Local dev against plain Postgres

```bash
PGHOST=localhost PGPASSWORD=postgres PGUSER=postgres PGDATABASE=mason \
  node build/src/server.js
```

`PGPASSWORD` set ⇒ Lakebase credential rotation is disabled.

## Deploy as a Databricks App (Lakebase-backed)

```bash
npm run build
databricks bundle deploy -t dev
```

The bundle provisions the Lakebase project/branch/endpoint and the app, binds
them (`CAN_CONNECT_AND_CREATE`), and injects `ENDPOINT_NAME` + `PG*` env vars.
Auth: browser requests use ingress identity (`X-Forwarded-Email`); the Mason
desktop publisher sends the user's workspace OAuth token as a Bearer,
resolved via SCIM `Me` and cached.

## Surface

- `PUT/DELETE/GET /api/v1/sessions[/{id}]` — session rows (user-scoped)
- `POST /api/v1/sessions/{id}/items[?replace=1]` — append items (idempotent by id; positions assigned server-side)
- `GET  /api/v1/sessions/{id}` — snapshot (last 200 items + `live` flag)
- `POST /api/v1/sessions/{id}/deltas` — ephemeral in-progress turn text
- `GET  /api/v1/sessions/{id}/stream`, `GET /api/v1/sessions/stream` — SSE
- `GET  /healthz`
