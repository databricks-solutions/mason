// mason-sync — session-sync server for Mason (Phase 1).
// Runs as a Databricks App (Lakebase-backed) or locally
// (MASON_SYNC_STORE=memory, or PGHOST+PGPASSWORD for plain Postgres).

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import * as path from "node:path";
import { registerRoutes } from "./routes";
import { Fanout } from "./fanout";
import { MemStore, PgStore, Store } from "./store";
import { createPool } from "./db";

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" } });
  const fanout = new Fanout();

  let store: Store;
  if (process.env.MASON_SYNC_STORE === "memory") {
    app.log.warn("Using in-memory store (dev only — data lost on restart)");
    store = new MemStore();
  } else {
    const pg = new PgStore(await createPool());
    store = pg;
    // Bootstrap in the background so /healthz (and the 503-until-ready
    // behavior on /api) work while Lakebase wakes from scale-to-zero.
    // Retry until it succeeds — first-deploy permission grants (the
    // deployer's GRANT ... ON SCHEMA) may land after the app starts, and
    // the store should self-heal without a restart.
    void (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          await pg.bootstrap();
          app.log.info("Store ready");
          return;
        } catch (e) {
          app.log.error(`Store bootstrap failed (attempt ${attempt}): ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, Math.min(30_000, 5_000 * attempt)));
        }
      }
    })();
  }

  app.get("/healthz", async () => ({ ok: true, store: store.ready() }));

  registerRoutes(app, store, fanout);

  // Mobile web viewer (static, read-only). Compiled output runs from
  // build/src/, so the app root is two levels up.
  app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "..", "public"),
    prefix: "/",
  });

  const port = Number(process.env.PORT || process.env.DATABRICKS_APP_PORT || 8787);
  await app.listen({ port, host: "0.0.0.0" });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
