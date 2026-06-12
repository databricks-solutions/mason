// Lakebase (Postgres) connectivity with OAuth credential rotation.
//
// Patterns ported from databricks_solutions/lakebase-fastapi-app:
//  • Lakebase DB credentials live ~60 min. A background loop refreshes at
//    45 min with bounded backoff; a connect-time staleness guard refreshes
//    synchronously if the background loop ever dies.
//  • The app resource binding injects PGHOST/PGDATABASE/PGUSER etc.; locally
//    you can point PGHOST at any plain Postgres (PGPASSWORD set => rotation
//    disabled — dev mode).

import { Pool } from "pg";

const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const REFRESH_AT_MS = 45 * 60 * 1000;
const RETRY_BACKOFF_S = [5, 15, 30, 60, 120];

let password = process.env.PGPASSWORD || "";
let lastRefresh = password ? Date.now() : 0;
const staticPassword = !!process.env.PGPASSWORD;

async function generateToken(): Promise<void> {
  const host = (process.env.DATABRICKS_HOST || "").replace(/\/+$/, "");
  const endpoint = process.env.ENDPOINT_NAME || "";
  if (!host || !endpoint) throw new Error("DATABRICKS_HOST / ENDPOINT_NAME not set");
  // App service principal credentials are injected by the Apps runtime; the
  // SDK-less path is a single REST call.
  const auth = await appOauthToken(host);
  const res = await fetch(`${host}/api/2.0/postgres/credentials`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok) throw new Error(`generate_database_credential: HTTP ${res.status}`);
  const data: any = await res.json();
  password = data.token;
  lastRefresh = Date.now();
}

// Client-credentials flow with the app's injected SP credentials.
let appTokenCache: { token: string; expiresAt: number } | null = null;
async function appOauthToken(host: string): Promise<string> {
  if (appTokenCache && appTokenCache.expiresAt > Date.now()) return appTokenCache.token;
  const id = process.env.DATABRICKS_CLIENT_ID || "";
  const secret = process.env.DATABRICKS_CLIENT_SECRET || "";
  const res = await fetch(`${host}/oidc/v1/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials&scope=all-apis",
  });
  if (!res.ok) throw new Error(`oidc token: HTTP ${res.status}`);
  const data: any = await res.json();
  appTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return appTokenCache.token;
}

async function refreshLoop(): Promise<void> {
  for (;;) {
    const sleepFor = Math.max(0, lastRefresh + REFRESH_AT_MS - Date.now());
    await new Promise((r) => setTimeout(r, sleepFor));
    let ok = false;
    for (const backoff of [0, ...RETRY_BACKOFF_S]) {
      if (backoff) await new Promise((r) => setTimeout(r, backoff * 1000));
      try {
        await generateToken();
        ok = true;
        break;
      } catch (e) {
        console.error(`[DB] token refresh failed: ${(e as Error).message}`);
      }
    }
    if (!ok) console.error("[DB] token refresh exhausted retries; connections will fail at expiry");
  }
}

export async function createPool(): Promise<Pool> {
  if (!staticPassword) {
    await generateToken();
    void refreshLoop();
  }
  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "databricks_postgres",
    user: process.env.PGUSER || process.env.DATABRICKS_CLIENT_ID,
    ssl: process.env.PGSSLMODE === "disable" ? undefined : { rejectUnauthorized: false },
    max: Number(process.env.DB_POOL_SIZE || 5),
    idleTimeoutMillis: 60_000,
    // node-pg evaluates a function password per connection — our rotation hook.
    password: async () => {
      if (!staticPassword && Date.now() - lastRefresh > TOKEN_LIFETIME_MS - 60_000) {
        try {
          await generateToken();
          console.warn("[DB] token was stale at connect; refreshed synchronously");
        } catch (e) {
          console.error(`[DB] synchronous refresh failed: ${(e as Error).message}`);
        }
      }
      return password;
    },
  });
  pool.on("error", (e) => console.error(`[DB] idle client error: ${e.message}`));
  return pool;
}
