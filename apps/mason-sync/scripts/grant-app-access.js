#!/usr/bin/env node
// Postdeploy hook: grant the mason-sync app's service principal the schema
// rights it needs to create/manage its tables. Runs as the deployer (who
// owns the schema) via the bundle's experimental postdeploy script — the
// Node port of lakebase-fastapi-app's scripts/grant_app_access.py.
//
// Idempotent: GRANT is a no-op when the privilege already exists.
//
// Env overrides (defaults match databricks.yml):
//   APP_NAME            mason-sync
//   LAKEBASE_ENDPOINT   projects/mason-sync/branches/production/endpoints/primary
//   PG_DATABASE         databricks_postgres
//   DATABRICKS_CONFIG_PROFILE / --profile of the deploying CLI session

"use strict";

const { execFileSync } = require("child_process");
const { Client } = require("pg");

const APP_NAME = process.env.APP_NAME || "mason-sync";
const ENDPOINT = process.env.LAKEBASE_ENDPOINT || "projects/mason-sync/branches/production/endpoints/primary";
const DATABASE = process.env.PG_DATABASE || "databricks_postgres";

function cli(args) {
  const profile = process.env.DATABRICKS_CONFIG_PROFILE;
  const full = profile ? [...args, "-p", profile] : args;
  return JSON.parse(execFileSync("databricks", [...full, "-o", "json"], { encoding: "utf-8" }));
}

async function main() {
  const app = cli(["apps", "get", APP_NAME]);
  const sp = app.service_principal_client_id;
  if (!sp) throw new Error(`App ${APP_NAME} has no service principal yet`);

  const ep = cli(["postgres", "get-endpoint", ENDPOINT]);
  const host = ep.status && ep.status.hosts && ep.status.hosts.host;
  if (!host) throw new Error(`Endpoint ${ENDPOINT} has no host (state: ${ep.status && ep.status.current_state})`);

  const cred = cli(["postgres", "generate-database-credential", "--json", JSON.stringify({ endpoint: ENDPOINT })]);
  const me = cli(["current-user", "me"]);

  const client = new Client({
    host,
    port: 5432,
    user: me.userName,
    password: cred.token,
    database: DATABASE,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    // pg_roles check first so a missing role gives a clear message instead
    // of a SQL error.
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [sp]);
    if (role.rowCount === 0) {
      throw new Error(
        `Postgres role "${sp}" not found — has the app's database resource binding been deployed?`
      );
    }
    await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${sp}"`);
    console.log(`[grant-app-access] Granted USAGE, CREATE on schema public to ${sp} (${APP_NAME})`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`[grant-app-access] ${e.message}`);
  process.exit(1);
});
