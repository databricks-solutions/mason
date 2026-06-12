// Server-side turn engine (Phase 2, chat-only slice).
//
// Executes one conversation turn against the Databricks AI Gateway with the
// caller's own OAuth token (OBO): builds the request through the SAME
// chat-shared helpers as Mason desktop and the model sweep, streams the SSE
// response, fans deltas out to attached viewers, and persists the result.
//
// Bounded by TURN_DEADLINE_MS wall-clock (well inside token validity). The
// token is held in memory for the life of the turn, never persisted, never
// logged. No tools in this slice — cloud-safe MCP tools come next.

import type { Store } from "./store";
import type { Fanout } from "./fanout";
import type { StoredItem, TurnRow } from "../shared/protocol";
import { TURN_DEADLINE_MS } from "../shared/protocol";
import {
  applyAnthropicCaching,
  consolidateSystemMessages,
  flattenContent,
  maxTokensFor,
  supportsStreamOptions,
} from "../shared/chat-shared";
import { workspaceHost } from "./db";

const DELTA_THROTTLE_MS = 350;

// fetch is injectable for tests (fake gateway).
export type FetchLike = typeof fetch;

interface RunningTurn {
  abort: AbortController;
}
const runningTurns = new Map<string, RunningTurn>();

export function cancelTurn(turnId: string): boolean {
  const t = runningTurns.get(turnId);
  if (!t) return false;
  t.abort.abort();
  return true;
}

// Rebuild chat-completions messages from persisted items. Tool items mirror
// as previews in Phase 1 data, so we render them as compact context lines
// rather than fake tool_calls round-trips (the originals ran on the desktop).
export function itemsToMessages(items: StoredItem[]): any[] {
  const messages: any[] = [];
  for (const it of items) {
    const d: any = it.data;
    if (it.type === "message") {
      messages.push({ role: d.role, content: d.content });
    } else if (it.type === "tool_call") {
      const pre = d.preamble ? `${d.preamble}\n` : "";
      messages.push({
        role: "assistant",
        content: `${pre}[called tool ${d.name}(${(d.arguments || "").slice(0, 200)})]`,
      });
    } else if (it.type === "tool_result") {
      messages.push({
        role: "user",
        content: `[tool ${d.name} returned: ${d.preview || ""}]`,
      });
    }
  }
  // Collapse consecutive same-role messages (Anthropic rejects user-after-
  // user); join with newlines.
  const collapsed: any[] = [];
  for (const m of messages) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      collapsed.push({ ...m });
    }
  }
  return collapsed;
}

export interface RunTurnParams {
  store: Store;
  fanout: Fanout;
  user: string;
  token: string; // caller's OAuth token (OBO) — gateway calls run as them
  sessionId: string;
  turn: TurnRow;
  model: string;
  fetchImpl?: FetchLike;
  log: (msg: string) => void;
}

// Runs detached from the originating HTTP request (which already 202'd).
export async function runTurn(p: RunTurnParams): Promise<void> {
  const { store, fanout, user, sessionId, turn } = p;
  const fetchImpl = p.fetchImpl || fetch;
  const abort = new AbortController();
  runningTurns.set(turn.id, { abort });
  const deadline = setTimeout(() => abort.abort(), TURN_DEADLINE_MS);

  const finish = async (status: "done" | "failed" | "cancelled", error?: string): Promise<void> => {
    clearTimeout(deadline);
    runningTurns.delete(turn.id);
    const ended = await store.endTurn(turn.id, status, error);
    if (ended) fanout.emitSession(user, sessionId, { kind: "turn", turn: ended });
    if (error) {
      // Persist a visible error item so every surface sees why the turn died.
      const [item] = await store.appendItems(
        user,
        sessionId,
        [
          {
            id: `${turn.id}.err`,
            type: "message",
            data: { role: "assistant", content: `⚠️ ${error}` },
          },
        ],
        false,
        "web"
      );
      if (item) fanout.emitSession(user, sessionId, { kind: "item", item });
    }
  };

  let fullContent = "";
  try {
    // Context: last 200 persisted items (the session snapshot window).
    const all = await store.listItems(user, sessionId, -1, Number.MAX_SAFE_INTEGER);
    const messages = itemsToMessages(all.slice(-200));

    const body: any = {
      model: p.model,
      max_tokens: maxTokensFor(p.model),
      messages: consolidateSystemMessages(messages),
      stream: true,
    };
    if (supportsStreamOptions(p.model)) {
      body.stream_options = { include_usage: true };
    }
    applyAnthropicCaching(body, p.model);

    const gateway = `${workspaceHost()}/ai-gateway/mlflow/v1/chat/completions`;
    const res = await fetchImpl(gateway, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${p.token}`,
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      p.log(`[TURN] ${turn.id} gateway HTTP ${res.status}`);
      await finish("failed", `Gateway error (HTTP ${res.status}): ${text.slice(0, 300)}`);
      return;
    }

    // SSE accumulation — same shape handling as main.ts (array-shaped
    // delta.content flattened, [DONE] terminator).
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let seq = 0;
    let lastDeltaAt = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            const piece =
              typeof delta.content === "string" ? delta.content : flattenContent(delta.content);
            if (piece) {
              fullContent += piece;
              const now = Date.now();
              if (now - lastDeltaAt >= DELTA_THROTTLE_MS) {
                lastDeltaAt = now;
                fanout.emitSession(user, sessionId, {
                  kind: "delta",
                  turn_id: turn.id,
                  seq: seq++,
                  text: fullContent,
                });
              }
            }
          }
        } catch (_) {}
      }
    }

    if (!fullContent.trim()) {
      await finish("failed", "Model returned an empty response. Try again or switch models.");
      return;
    }

    // Persist-before-fanout: the assistant item supersedes the delta bubble.
    const [item] = await store.appendItems(
      user,
      sessionId,
      [
        {
          id: `${turn.id}.a`,
          type: "message",
          data: { role: "assistant", content: fullContent },
        },
      ],
      false,
      "web"
    );
    if (item) fanout.emitSession(user, sessionId, { kind: "item", item });
    const session = await store.getSession(user, sessionId);
    if (session) fanout.emitList(user, { kind: "session", session });
    await finish("done");
    p.log(`[TURN] ${turn.id} done (${fullContent.length} chars)`);
  } catch (e) {
    if (abort.signal.aborted) {
      // Cancelled by user or deadline — persist whatever streamed so the
      // transcript isn't silently truncated.
      if (fullContent.trim()) {
        const [item] = await store.appendItems(
          user,
          sessionId,
          [
            {
              id: `${turn.id}.a`,
              type: "message",
              data: { role: "assistant", content: fullContent },
            },
          ],
          false,
          "web"
        );
        if (item) fanout.emitSession(user, sessionId, { kind: "item", item });
      }
      await finish("cancelled", undefined);
      p.log(`[TURN] ${turn.id} cancelled`);
    } else {
      p.log(`[TURN] ${turn.id} failed: ${(e as Error).message}`);
      await finish("failed", `Turn failed: ${(e as Error).message}`);
    }
  }
}
