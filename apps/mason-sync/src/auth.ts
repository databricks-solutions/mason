// Request identity resolution.
//
// Two trusted paths:
//  • Browser via Databricks Apps ingress: X-Forwarded-Email (header injected
//    by the platform; cannot be spoofed through the app URL).
//  • Programmatic (Mason desktop): Authorization: Bearer <user OAuth token>,
//    resolved against the workspace SCIM Me endpoint and cached by token
//    hash for 5 minutes.
//
// Dev mode (MASON_SYNC_INSECURE_DEV=1): any request resolves to
// MASON_SYNC_DEV_USER (default dev@localhost). Never set in production.

import { createHash } from "node:crypto";
import { workspaceHost } from "./db";

const SCIM_CACHE_TTL_MS = 5 * 60 * 1000;
const scimCache = new Map<string, { email: string; expiresAt: number }>();

export class AuthError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export async function resolveUser(headers: Record<string, unknown>): Promise<string> {
  if (process.env.MASON_SYNC_INSECURE_DEV === "1") {
    return process.env.MASON_SYNC_DEV_USER || "dev@localhost";
  }

  const forwarded = headers["x-forwarded-email"];
  if (typeof forwarded === "string" && forwarded.includes("@")) {
    return forwarded.toLowerCase();
  }

  const authz = headers["authorization"];
  if (typeof authz === "string" && authz.startsWith("Bearer ")) {
    const token = authz.slice(7);
    const key = createHash("sha256").update(token).digest("hex");
    const cached = scimCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.email;

    const host = workspaceHost();
    if (!host) throw new AuthError(500, "Server missing DATABRICKS_HOST");
    const res = await fetch(`${host}/api/2.0/preview/scim/v2/Me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new AuthError(401, "Invalid or expired token");
    const me: any = await res.json();
    const email = String(me.userName || "").toLowerCase();
    if (!email.includes("@")) throw new AuthError(401, "Could not resolve user identity");
    scimCache.set(key, { email, expiresAt: Date.now() + SCIM_CACHE_TTL_MS });
    // Opportunistic sweep so the cache can't grow unbounded.
    if (scimCache.size > 500) {
      const now = Date.now();
      for (const [k, v] of scimCache) if (v.expiresAt < now) scimCache.delete(k);
    }
    return email;
  }

  throw new AuthError(401, "Unauthenticated");
}
