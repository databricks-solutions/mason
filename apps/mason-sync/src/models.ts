// Server-side model discovery for the web composer (Phase 2).
//
// Same filtering as Mason desktop's src/models.ts: FOUNDATION_MODEL_API,
// chat task, READY, and — because the turn engine speaks chat-completions
// only — the model must support mlflow/v1/chat/completions. Cached per user
// for 10 minutes.

import type { ModelInfo } from "../shared/protocol";
import { workspaceHost } from "./db";

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { models: ModelInfo[]; expiresAt: number }>();

export async function discoverModels(user: string, token: string): Promise<ModelInfo[]> {
  const cached = cache.get(user);
  if (cached && cached.expiresAt > Date.now()) return cached.models;

  const res = await fetch(`${workspaceHost()}/api/2.0/serving-endpoints`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Model discovery failed: HTTP ${res.status}`);
  const data: any = await res.json();
  const models: ModelInfo[] = (data.endpoints || [])
    .filter(
      (e: any) =>
        e.endpoint_type === "FOUNDATION_MODEL_API" &&
        e.task &&
        e.task.includes("chat") &&
        e.state?.ready === "READY"
    )
    .map((e: any) => {
      const fm = e.config?.served_entities?.[0]?.foundation_model || {};
      const apiTypes: string[] = fm.api_types || [];
      if (!apiTypes.includes("mlflow/v1/chat/completions")) return null;
      return { value: e.name, label: fm.display_name || e.name };
    })
    .filter(Boolean) as ModelInfo[];

  models.sort((a, b) => a.label.localeCompare(b.label));
  cache.set(user, { models, expiresAt: Date.now() + CACHE_TTL_MS });
  return models;
}
