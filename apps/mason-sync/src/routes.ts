// REST + SSE routes. The three protocol rules live here:
//   1. persist-before-fanout (items hit the store before any SSE frame)
//   2. snapshot + live-tail (viewer dedupes by item id)
//   3. single writer (desktop) — no concurrency control needed yet
//
// All routes resolve the caller first and scope every store call by user.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "./store";
import { NotFoundError } from "./store";
import { Fanout, SseSink } from "./fanout";
import { resolveUser, AuthError } from "./auth";
import type {
  DeltaPostBody,
  ItemsPostBody,
  SessionUpsertBody,
  SnapshotResponse,
} from "../shared/protocol";
import { SNAPSHOT_ITEM_LIMIT } from "../shared/protocol";

const MAX_ITEMS_PER_POST = 200;
const MAX_ITEM_BYTES = 64 * 1024;
const LIVE_WINDOW_MS = 10_000;

// session id -> last delta wall-clock, for the snapshot `live` flag.
const lastDelta = new Map<string, number>();

function sseSink(reply: FastifyReply): SseSink {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(":ok\n\n");
  return {
    write: (chunk) => reply.raw.write(chunk),
    onClose: (cb) => reply.raw.on("close", cb),
  };
}

function validSessionId(id: string): boolean {
  // "stream" is reserved — it's a static route segment under /sessions/.
  return /^[a-zA-Z0-9._-]{1,64}$/.test(id) && id !== "stream";
}

export function registerRoutes(app: FastifyInstance, store: Store, fanout: Fanout): void {
  // Resolve + attach user; convert auth failures to clean HTTP errors.
  app.decorateRequest("user", "");
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;
    if (!store.ready()) {
      reply.code(503).send({ error: "Store not ready — database initializing" });
      return reply;
    }
    try {
      (req as any).user = await resolveUser(req.headers as Record<string, unknown>);
    } catch (e) {
      const status = e instanceof AuthError ? e.statusCode : 401;
      reply.code(status).send({ error: (e as Error).message });
      return reply;
    }
  });

  const user = (req: FastifyRequest): string => (req as any).user as string;

  app.put<{ Params: { id: string }; Body: SessionUpsertBody }>(
    "/api/v1/sessions/:id",
    async (req, reply) => {
      if (!validSessionId(req.params.id)) return reply.code(400).send({ error: "Invalid session id" });
      const session = await store.upsertSession(user(req), req.params.id, req.body || ({} as any));
      fanout.emitList(user(req), { kind: "session", session });
      fanout.emitSession(user(req), session.id, { kind: "session", session });
      return { ok: true, session };
    }
  );

  app.delete<{ Params: { id: string } }>("/api/v1/sessions/:id", async (req) => {
    const removed = await store.deleteSession(user(req), req.params.id);
    if (removed) fanout.emitList(user(req), { kind: "removed", id: req.params.id });
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/v1/sessions", async (req) => {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    return { sessions: await store.listSessions(user(req), limit) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id", async (req, reply) => {
    const session = await store.getSession(user(req), req.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    // Snapshot returns the LAST N items in ascending order.
    const all = await store.listItems(user(req), req.params.id, -1, Number.MAX_SAFE_INTEGER);
    const items = all.slice(-SNAPSHOT_ITEM_LIMIT);
    const live = Date.now() - (lastDelta.get(req.params.id) || 0) < LIVE_WINDOW_MS;
    const body: SnapshotResponse = { session, items, live };
    return body;
  });

  app.post<{ Params: { id: string }; Body: ItemsPostBody; Querystring: { replace?: string } }>(
    "/api/v1/sessions/:id/items",
    async (req, reply) => {
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0)
        return reply.code(400).send({ error: "items[] required" });
      if (items.length > MAX_ITEMS_PER_POST)
        return reply.code(400).send({ error: `Max ${MAX_ITEMS_PER_POST} items per request` });
      for (const it of items) {
        if (!it?.id || !validSessionId(it.id) || !it.type || typeof it.data !== "object")
          return reply.code(400).send({ error: "Each item needs id, type, data" });
        if (JSON.stringify(it.data).length > MAX_ITEM_BYTES)
          return reply.code(400).send({ error: `Item ${it.id} exceeds ${MAX_ITEM_BYTES} bytes` });
      }
      // 1. persist  2. fan out only the newly-inserted (idempotent retries
      // don't re-emit).
      const inserted = await store.appendItems(
        user(req),
        req.params.id,
        items,
        req.query.replace === "1"
      );
      for (const item of inserted) {
        fanout.emitSession(user(req), req.params.id, { kind: "item", item });
      }
      if (inserted.length > 0) {
        const session = await store.getSession(user(req), req.params.id);
        if (session) fanout.emitList(user(req), { kind: "session", session });
      }
      return { ok: true, inserted: inserted.length, positions: inserted.map((i) => i.position) };
    }
  );

  app.post<{ Params: { id: string }; Body: DeltaPostBody }>(
    "/api/v1/sessions/:id/deltas",
    async (req) => {
      // Ephemeral: never persisted, never 404s the publisher (best-effort by
      // design). Fan out only if the body is sane.
      const { turn_id, seq, text } = req.body || ({} as DeltaPostBody);
      if (turn_id && typeof text === "string") {
        lastDelta.set(req.params.id, Date.now());
        fanout.emitSession(user(req), req.params.id, {
          kind: "delta",
          turn_id,
          seq: Number(seq) || 0,
          text: text.slice(0, 256 * 1024),
        });
      }
      return { ok: true };
    }
  );

  app.get<{ Params: { id: string } }>("/api/v1/sessions/:id/stream", async (req, reply) => {
    const session = await store.getSession(user(req), req.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    fanout.subscribeSession(user(req), req.params.id, sseSink(reply));
    return reply; // handled — keep the connection open
  });

  app.get("/api/v1/sessions/stream", async (req, reply) => {
    fanout.subscribeList(user(req), sseSink(reply));
    return reply;
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof NotFoundError) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    console.error(`[ROUTES] ${(err as Error).message}`);
    reply.code(500).send({ error: "Internal error" });
  });
}
