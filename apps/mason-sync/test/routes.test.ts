// Protocol tests: positions, idempotency, user scoping, replace, snapshot,
// fanout-on-insert-only. Runs against the in-memory store via fastify.inject.

import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRoutes } from "../src/routes";
import { MemStore } from "../src/store";
import { Fanout } from "../src/fanout";
import type { SessionStreamFrame } from "../shared/protocol";

process.env.MASON_SYNC_INSECURE_DEV = ""; // tests control identity explicitly

function makeApp() {
  const app = Fastify();
  const store = new MemStore();
  const fanout = new Fanout();
  registerRoutes(app, store, fanout);
  return { app, store, fanout };
}

const ALICE = { "x-forwarded-email": "alice@example.com" };
const BOB = { "x-forwarded-email": "bob@example.com" };

function msg(id: string, role: "user" | "assistant", content: string) {
  return { id, type: "message", data: { role, content } };
}

test("upsert + snapshot roundtrip", async () => {
  const { app } = makeApp();
  const put = await app.inject({
    method: "PUT",
    url: "/api/v1/sessions/chat1",
    headers: ALICE,
    payload: { title: "My chat", model_label: "Claude Haiku 4.5" },
  });
  assert.equal(put.statusCode, 200);

  const snap = await app.inject({ method: "GET", url: "/api/v1/sessions/chat1", headers: ALICE });
  assert.equal(snap.statusCode, 200);
  const body = snap.json();
  assert.equal(body.session.title, "My chat");
  assert.deepEqual(body.items, []);
  assert.equal(body.live, false);
});

test("items get dense positions in POST order", async () => {
  const { app } = makeApp();
  await app.inject({ method: "PUT", url: "/api/v1/sessions/c", headers: ALICE, payload: { title: "t" } });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items",
    headers: ALICE,
    payload: { items: [msg("a", "user", "hi"), msg("b", "assistant", "hello")] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().positions, [0, 1]);

  const res2 = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items",
    headers: ALICE,
    payload: { items: [msg("c", "user", "more")] },
  });
  assert.deepEqual(res2.json().positions, [2]);
});

test("re-POST of same ids is acked but not re-inserted", async () => {
  const { app } = makeApp();
  await app.inject({ method: "PUT", url: "/api/v1/sessions/c", headers: ALICE, payload: { title: "t" } });
  await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items",
    headers: ALICE,
    payload: { items: [msg("a", "user", "hi")] },
  });
  const dup = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items",
    headers: ALICE,
    payload: { items: [msg("a", "user", "hi"), msg("b", "assistant", "new")] },
  });
  assert.equal(dup.statusCode, 200);
  assert.equal(dup.json().inserted, 1); // only "b"

  const snap = await app.inject({ method: "GET", url: "/api/v1/sessions/c", headers: ALICE });
  assert.equal(snap.json().items.length, 2);
});

test("replace=1 wipes and re-seeds (backfill idempotency)", async () => {
  const { app } = makeApp();
  await app.inject({ method: "PUT", url: "/api/v1/sessions/c", headers: ALICE, payload: { title: "t" } });
  await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items",
    headers: ALICE,
    payload: { items: [msg("old", "user", "old")] },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items?replace=1",
    headers: ALICE,
    payload: { items: [msg("n1", "user", "fresh"), msg("n2", "assistant", "fresh2")] },
  });
  assert.deepEqual(res.json().positions, [0, 1]);
  const snap = await app.inject({ method: "GET", url: "/api/v1/sessions/c", headers: ALICE });
  assert.deepEqual(
    snap.json().items.map((i: any) => i.id),
    ["n1", "n2"]
  );
});

test("cross-user access is a 404, never a leak", async () => {
  const { app } = makeApp();
  await app.inject({ method: "PUT", url: "/api/v1/sessions/c", headers: ALICE, payload: { title: "secret" } });

  const snap = await app.inject({ method: "GET", url: "/api/v1/sessions/c", headers: BOB });
  assert.equal(snap.statusCode, 404);

  const post = await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items",
    headers: BOB,
    payload: { items: [msg("x", "user", "intrusion")] },
  });
  assert.equal(post.statusCode, 404);

  // Bob can't hijack Alice's session id via upsert either.
  const hijack = await app.inject({
    method: "PUT",
    url: "/api/v1/sessions/c",
    headers: BOB,
    payload: { title: "mine now" },
  });
  assert.equal(hijack.statusCode, 404);

  const list = await app.inject({ method: "GET", url: "/api/v1/sessions", headers: BOB });
  assert.deepEqual(list.json().sessions, []);
});

test("unauthenticated requests are rejected", async () => {
  const { app } = makeApp();
  const res = await app.inject({ method: "GET", url: "/api/v1/sessions" });
  assert.equal(res.statusCode, 401);
});

test("delete soft-removes from list and snapshot", async () => {
  const { app } = makeApp();
  await app.inject({ method: "PUT", url: "/api/v1/sessions/c", headers: ALICE, payload: { title: "t" } });
  await app.inject({ method: "DELETE", url: "/api/v1/sessions/c", headers: ALICE });
  const list = await app.inject({ method: "GET", url: "/api/v1/sessions", headers: ALICE });
  assert.deepEqual(list.json().sessions, []);
  const snap = await app.inject({ method: "GET", url: "/api/v1/sessions/c", headers: ALICE });
  assert.equal(snap.statusCode, 404);
});

test("fanout emits only newly-inserted items (no echo on retry)", async () => {
  const { app, fanout } = makeApp();
  await app.inject({ method: "PUT", url: "/api/v1/sessions/c", headers: ALICE, payload: { title: "t" } });

  const frames: SessionStreamFrame[] = [];
  fanout.subscribeSession("alice@example.com", "c", {
    write: (chunk) => {
      const m = chunk.match(/^data: (.*)$/m);
      if (m) frames.push(JSON.parse(m[1]));
    },
    onClose: () => {},
  });

  await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items",
    headers: ALICE,
    payload: { items: [msg("a", "user", "hi")] },
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/sessions/c/items",
    headers: ALICE,
    payload: { items: [msg("a", "user", "hi")] }, // retry — no new insert
  });

  const itemFrames = frames.filter((f) => f.kind === "item");
  assert.equal(itemFrames.length, 1);
});

test("snapshot caps at the last 200 items, ascending", async () => {
  const { app } = makeApp();
  await app.inject({ method: "PUT", url: "/api/v1/sessions/c", headers: ALICE, payload: { title: "t" } });
  for (let batch = 0; batch < 2; batch++) {
    const items = [];
    for (let i = 0; i < 150; i++) {
      const n = batch * 150 + i;
      items.push(msg(`m${n}`, "user", `msg ${n}`));
    }
    await app.inject({
      method: "POST",
      url: "/api/v1/sessions/c/items",
      headers: ALICE,
      payload: { items },
    });
  }
  const snap = await app.inject({ method: "GET", url: "/api/v1/sessions/c", headers: ALICE });
  const items = snap.json().items;
  assert.equal(items.length, 200);
  assert.equal(items[0].position, 100);
  assert.equal(items[199].position, 299);
});

test("reserved id 'stream' is rejected", async () => {
  const { app } = makeApp();
  const res = await app.inject({
    method: "PUT",
    url: "/api/v1/sessions/stream",
    headers: ALICE,
    payload: { title: "t" },
  });
  assert.equal(res.statusCode, 400);
});
