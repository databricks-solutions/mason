// Session-sync mirror publisher (Phase 1).
//
// Fire-and-forget: nothing on the chat hot path ever awaits this module.
// The desktop remains source of truth (~/.mason/chat_history); this mirrors
// completed history entries + live stream deltas to the mason-sync server so
// the mobile viewer can follow along.
//
// Item ids are deterministic (`<chatId>.<historyIndex>[.<sub>]`) so re-syncs
// after restart are idempotent — the server dedupes by id.
//
// See docs/specs/session-sync-phase1.md and apps/mason-sync/shared/protocol.ts.

declare function getAuthToken(): Promise<string>;
declare function getSelectedProfile(): { name: string; host?: string } | undefined;

interface SyncQueueOp {
  path: string; // relative API path
  method: "PUT" | "POST" | "DELETE";
  body?: unknown;
}

const SYNC_MAX_QUEUE = 500;
const SYNC_BATCH_MAX = 100;
const SYNC_TIMEOUT_MS = 5_000;
const SYNC_BACKOFF_MAX_MS = 60_000;
const SYNC_DELTA_THROTTLE_MS = 400;
const SYNC_PREVIEW_CHARS = 500;

const syncState = {
  queue: [] as SyncQueueOp[],
  draining: false,
  backoffMs: 1_000,
  failures: 0,
  loggedOutage: false,
  // chatId -> index into mason.history that has been mirrored (exclusive)
  syncedIndex: new Map<string, number>(),
  lastDeltaAt: 0,
};

function syncEnabled(): boolean {
  const cfg = mason.sessionSync;
  return !!(cfg && cfg.enabled && cfg.url);
}

function syncBaseUrl(): string {
  return (mason.sessionSync?.url || "").replace(/\/+$/, "");
}

// --- transport ---

async function syncFetch(op: SyncQueueOp): Promise<boolean> {
  const token = await getAuthToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(`${syncBaseUrl()}/api/v1${op.path}`, {
      method: op.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(op.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: op.body !== undefined ? JSON.stringify(op.body) : undefined,
      signal: ctrl.signal,
    });
    // 4xx = our payload is wrong; retrying won't help — drop, log once.
    if (!res.ok && res.status < 500) {
      console.warn(`[SYNC] ${op.method} ${op.path} → HTTP ${res.status}; dropping op`);
      return true;
    }
    return res.ok;
  } finally {
    clearTimeout(timer);
  }
}

function syncEnqueue(op: SyncQueueOp): void {
  if (!syncEnabled()) return;
  syncState.queue.push(op);
  if (syncState.queue.length > SYNC_MAX_QUEUE) {
    // Drop-oldest: local history can always re-seed the server via backfill.
    syncState.queue.splice(0, syncState.queue.length - SYNC_MAX_QUEUE);
  }
  void syncDrain();
}

async function syncDrain(): Promise<void> {
  if (syncState.draining) return;
  syncState.draining = true;
  try {
    while (syncState.queue.length > 0 && syncEnabled()) {
      const op = syncState.queue[0];
      let ok = false;
      try {
        ok = await syncFetch(op);
      } catch (_) {
        ok = false;
      }
      if (ok) {
        syncState.queue.shift();
        syncState.backoffMs = 1_000;
        if (syncState.failures >= 5) {
          console.log("[SYNC] Server reachable again; queue draining");
        }
        syncState.failures = 0;
        syncState.loggedOutage = false;
      } else {
        syncState.failures += 1;
        if (syncState.failures >= 5 && !syncState.loggedOutage) {
          syncState.loggedOutage = true;
          console.warn(
            `[SYNC] Sync server unreachable after ${syncState.failures} attempts; queueing (max ${SYNC_MAX_QUEUE} ops)`
          );
        }
        const wait = syncState.backoffMs;
        syncState.backoffMs = Math.min(syncState.backoffMs * 2, SYNC_BACKOFF_MAX_MS);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  } finally {
    syncState.draining = false;
  }
}

// --- history entry → wire item mapping ---

function syncFlatten(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (typeof p?.text === "string") return p.text;
        if (p?.type === "image_url") return "[image attached]";
        return "";
      })
      .join("");
  }
  return String(content);
}

interface WireItem {
  id: string;
  type: "message" | "tool_call" | "tool_result";
  data: Record<string, unknown>;
}

function syncMapEntry(chatId: string, index: number, entry: any): WireItem[] {
  const base = `${chatId}.${index}`;
  if (entry.role === "user") {
    return [
      { id: base, type: "message", data: { role: "user", content: syncFlatten(entry.content) } },
    ];
  }
  if (entry.role === "assistant") {
    if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
      return entry.tool_calls.map((tc: any, i: number) => ({
        id: `${base}.${i}`,
        type: "tool_call" as const,
        data: {
          name: tc.function?.name || "",
          arguments: (tc.function?.arguments || "").slice(0, 2000),
          call_id: tc.id || `${base}.${i}`,
          ...(i === 0 && entry.content ? { preamble: syncFlatten(entry.content) } : {}),
        },
      }));
    }
    const text = syncFlatten(entry.content);
    if (!text) return [];
    return [{ id: base, type: "message", data: { role: "assistant", content: text } }];
  }
  if (entry.role === "tool") {
    const full = syncFlatten(entry.content);
    return [
      {
        id: base,
        type: "tool_result",
        data: {
          call_id: entry.tool_call_id || "",
          name: entry.name || "",
          preview: full.slice(0, SYNC_PREVIEW_CHARS),
          truncated: full.length > SYNC_PREVIEW_CHARS,
        },
      },
    ];
  }
  return []; // system messages are request-time assembly, not history
}

// --- public hooks (call sites in history.ts / chat.ts / app.ts) ---

// Mirrors the session row + any history entries not yet synced. Called from
// saveCurrentChat() — i.e. after every completed turn, on autosave, and on
// rename. Safe to call repeatedly.
function syncCatchUp(chatId: string, title: string, modelLabel: string): void {
  if (!syncEnabled() || !chatId) return;
  syncEnqueue({
    path: `/sessions/${chatId}`,
    method: "PUT",
    body: {
      title,
      model_label: modelLabel || null,
      workspace_host: getSelectedProfile()?.host || null,
    },
  });

  const history = mason.history as any[];
  const from = syncState.syncedIndex.get(chatId) || 0;
  if (from >= history.length) return;
  const items: WireItem[] = [];
  for (let i = from; i < history.length; i++) {
    items.push(...syncMapEntry(chatId, i, history[i]));
  }
  syncState.syncedIndex.set(chatId, history.length);
  for (let i = 0; i < items.length; i += SYNC_BATCH_MAX) {
    syncEnqueue({
      path: `/sessions/${chatId}/items`,
      method: "POST",
      body: { items: items.slice(i, i + SYNC_BATCH_MAX) },
    });
  }
}

function syncSessionDelete(chatId: string): void {
  if (!syncEnabled()) return;
  syncState.syncedIndex.delete(chatId);
  syncEnqueue({ path: `/sessions/${chatId}`, method: "DELETE" });
}

// Live stream deltas — best-effort, throttled, never queued (a stale delta
// is worthless; the persisted item supersedes it).
function syncDelta(chatId: string, turnId: string, seq: number, fullText: string): void {
  if (!syncEnabled() || !chatId) return;
  const now = Date.now();
  if (now - syncState.lastDeltaAt < SYNC_DELTA_THROTTLE_MS) return;
  syncState.lastDeltaAt = now;
  void (async () => {
    try {
      await syncFetch({
        path: `/sessions/${chatId}/deltas`,
        method: "POST",
        body: { turn_id: turnId, seq, text: fullText },
      });
    } catch (_) {
      /* best-effort by design */
    }
  })();
}

// Push one whole local chat to the server, replacing whatever it has —
// used by Settings → "Backfill existing chats".
async function syncBackfillAll(
  onProgress: (done: number, total: number) => void
): Promise<{ pushed: number; failed: number }> {
  const list = (await window.api.historyList()) as Array<{ id: string; title?: string }>;
  let pushed = 0;
  let failed = 0;
  for (let n = 0; n < list.length; n++) {
    const meta = list[n];
    try {
      const data = (await window.api.historyLoad(meta.id)) as {
        title?: string;
        model?: string;
        messages: any[];
      } | null;
      if (!data) continue;
      const ok1 = await syncFetch({
        path: `/sessions/${meta.id}`,
        method: "PUT",
        body: { title: data.title || meta.title || "Chat", model_label: data.model || null },
      });
      if (!ok1) throw new Error("upsert failed");
      const items: WireItem[] = [];
      (data.messages || []).forEach((entry, i) => items.push(...syncMapEntry(meta.id, i, entry)));
      for (let i = 0; i < items.length; i += SYNC_BATCH_MAX) {
        const ok = await syncFetch({
          path: `/sessions/${meta.id}/items${i === 0 ? "?replace=1" : ""}`,
          method: "POST",
          body: { items: items.slice(i, i + SYNC_BATCH_MAX) },
        });
        if (!ok) throw new Error("items post failed");
      }
      if (mason.currentChatId === meta.id) {
        syncState.syncedIndex.set(meta.id, (data.messages || []).length);
      }
      pushed += 1;
    } catch (e) {
      console.warn(`[SYNC] Backfill failed for ${meta.id}: ${(e as Error).message}`);
      failed += 1;
    }
    onProgress(n + 1, list.length);
  }
  return { pushed, failed };
}
