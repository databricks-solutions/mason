// Phase 2 tests: turn-lock semantics and the send-message flow against a
// fake gateway (SSE stream served by an injected fetch).

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRoutes } from "../src/routes";
import { MemStore } from "../src/store";
import { Fanout } from "../src/fanout";
import { runTurn, itemsToMessages } from "../src/turn-engine";

process.env.MASON_SYNC_INSECURE_DEV = "";

const ALICE = { "x-forwarded-email": "alice@example.com", authorization: "Bearer tok-alice" };
const BOB = { "x-forwarded-email": "bob@example.com", authorization: "Bearer tok-bob" };

function makeApp() {
  const app = Fastify();
  const store = new MemStore();
  const fanout = new Fanout();
  registerRoutes(app, store, fanout);
  return { app, store, fanout };
}

async function seedSession(app: any, headers: any, id = "c") {
  await app.inject({ method: "PUT", url: `/api/v1/sessions/${id}`, headers, payload: { title: "t" } });
}

// Fake gateway: an SSE body streaming "Hello" in two chunks.
function fakeGatewayFetch(opts: { status?: number; chunks?: string[]; failBody?: string } = {}) {
  const chunks = opts.chunks ?? [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
  ];
  const calls: any[] = [];
  const impl = async (_url: any, init: any) => {
    calls.push({ url: String(_url), body: JSON.parse(init.body) });
    if (opts.status && opts.status !== 200) {
      return {
        ok: false,
        status: opts.status,
        text: async () => opts.failBody || "boom",
      } as any;
    }
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (i < chunks.length) {
              return { done: false, value: new TextEncoder().encode(chunks[i++]) };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    } as any;
  };
  return { impl, calls };
}

test("turn lock: second acquire conflicts, releases after end", async () => {
  const store = new MemStore();
  await store.upsertSession("alice", "c", { title: "t" });
  const t1 = await store.acquireTurn("alice", "c", "t1", "web");
  assert.ok(t1);
  const t2 = await store.acquireTurn("alice", "c", "t2", "desktop");
  assert.equal(t2, null);
  await store.endTurn("t1", "done");
  const t3 = await store.acquireTurn("alice", "c", "t3", "desktop");
  assert.ok(t3);
});

test("stale sweep fails old running turns", async () => {
  const store = new MemStore();
  await store.upsertSession("alice", "c", { title: "t" });
  const t = await store.acquireTurn("alice", "c", "t1", "web");
  assert.ok(t);
  // Backdate the started_at past the sweep window.
  (store as any).turns.get("t1").started_at = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  const swept = await store.sweepStaleTurns();
  assert.equal(swept.length, 1);
  assert.equal((await store.getTurn("t1"))!.status, "failed");
  // Lock is free again.
  assert.ok(await store.acquireTurn("alice", "c", "t2", "web"));
});

test("runTurn streams, persists assistant item, releases lock", async () => {
  const store = new MemStore();
  const fanout = new Fanout();
  await store.upsertSession("alice", "c", { title: "t" });
  await store.appendItems(
    "alice",
    "c",
    [{ id: "u1", type: "message", data: { role: "user", content: "hi" } }],
    false,
    "web"
  );
  const turn = (await store.acquireTurn("alice", "c", "t1", "web"))!;
  const gw = fakeGatewayFetch();
  await runTurn({
    store,
    fanout,
    user: "alice",
    token: "tok",
    sessionId: "c",
    turn,
    model: "databricks-claude-haiku-4-5",
    fetchImpl: gw.impl as any,
    log: () => {},
  });
  const items = await store.listItems("alice", "c", -1, 100);
  assert.equal(items.length, 2);
  assert.deepEqual(items[1].data, { role: "assistant", content: "Hello" });
  assert.equal((await store.getTurn("t1"))!.status, "done");
  // Request body went through chat-shared (max_tokens for claude = 16384).
  assert.equal(gw.calls[0].body.max_tokens, 16384);
  assert.equal(gw.calls[0].body.stream, true);
});

test("runTurn gateway failure ends turn failed with visible error item", async () => {
  const store = new MemStore();
  const fanout = new Fanout();
  await store.upsertSession("alice", "c", { title: "t" });
  await store.appendItems(
    "alice",
    "c",
    [{ id: "u1", type: "message", data: { role: "user", content: "hi" } }],
    false,
    "web"
  );
  const turn = (await store.acquireTurn("alice", "c", "t1", "web"))!;
  const gw = fakeGatewayFetch({ status: 400, failBody: "bad model" });
  await runTurn({
    store, fanout, user: "alice", token: "tok", sessionId: "c", turn,
    model: "nope", fetchImpl: gw.impl as any, log: () => {},
  });
  assert.equal((await store.getTurn("t1"))!.status, "failed");
  const items = await store.listItems("alice", "c", -1, 100);
  const err = items[items.length - 1];
  assert.match((err.data as any).content, /Gateway error/);
});

test("POST /messages acquires lock, persists user item, 202s; concurrent send 409s", async () => {
  const { app, store, fanout } = makeApp();
  await seedSession(app, ALICE);
  // Park a running turn to force the conflict path.
  await store.acquireTurn("alice@example.com", "c", "parked", "desktop");
  const conflict = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/messages",
    headers: ALICE,
    payload: { text: "hi", model: "m" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().active_turn.origin, "desktop");
  await store.endTurn("parked", "done");

  // Now a real send: it will 202 and kick a turn that fails at the gateway
  // (no fake fetch injected through the route) — that's fine for this test;
  // we assert the synchronous contract.
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/messages",
    headers: ALICE,
    payload: { text: "hello there", model: "databricks-claude-haiku-4-5" },
  });
  assert.equal(res.statusCode, 202);
  assert.ok(res.json().turn_id);
  const items = await store.listItems("alice@example.com", "c", -1, 100);
  assert.equal(items[0].type, "message");
  assert.equal((items[0].data as any).content, "hello there");
  assert.equal(items[0].origin, "web");
});

test("cross-user cannot cancel another user's turn", async () => {
  const { app, store } = makeApp();
  await seedSession(app, ALICE);
  await store.acquireTurn("alice@example.com", "c", "t1", "web");
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/turns/t1/cancel",
    headers: BOB,
  });
  assert.equal(res.statusCode, 404);
  assert.equal((await store.getTurn("t1"))!.status, "running");
});

test("desktop pre-flight acquire + end roundtrip", async () => {
  const { app, store } = makeApp();
  await seedSession(app, ALICE);
  const acq = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/turns",
    headers: ALICE,
    payload: {},
  });
  assert.equal(acq.statusCode, 200);
  const turnId = acq.json().turn_id;
  // Web send during the desktop turn → 409.
  const conflict = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/messages",
    headers: ALICE,
    payload: { text: "x", model: "m" },
  });
  assert.equal(conflict.statusCode, 409);
  const end = await app.inject({
    method: "POST",
    url: `/api/v1/turns/${turnId}/end`,
    headers: ALICE,
    payload: { status: "done" },
  });
  assert.equal(end.statusCode, 200);
  assert.equal((await store.getRunningTurn("alice@example.com", "c")), null);
});

test("itemsToMessages collapses consecutive roles and renders tool previews", () => {
  const items: any[] = [
    { type: "message", data: { role: "user", content: "a" } },
    { type: "tool_call", data: { name: "read_file", arguments: "{}", call_id: "1", preamble: "checking" } },
    { type: "tool_result", data: { name: "read_file", preview: "data", call_id: "1", truncated: false } },
    { type: "message", data: { role: "user", content: "b" } },
    { type: "message", data: { role: "assistant", content: "c" } },
  ];
  const msgs = itemsToMessages(items);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].role, "assistant"); // tool_call rendering
  assert.match(msgs[1].content, /read_file/);
  assert.equal(msgs[2].role, "user"); // tool_result + "b" collapsed
  assert.match(msgs[2].content, /data/);
  assert.match(msgs[2].content, /b/);
  assert.equal(msgs[3].role, "assistant");
});
