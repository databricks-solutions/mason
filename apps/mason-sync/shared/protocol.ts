// Wire types for the Mason session-sync protocol (Phase 1).
//
// Consumed by the server (direct import) and mirrored as ambient types for
// the desktop renderer in mason's src/types/sync.d.ts (the renderer is
// script-mode TS and cannot import modules). If you change a shape here,
// update sync.d.ts — the server's route tests are the compatibility gate.

export type SyncItemType = "message" | "tool_call" | "tool_result";

export interface SyncMessageData {
  role: "user" | "assistant";
  content: string;
}

export interface SyncToolCallData {
  name: string;
  arguments: string; // JSON string, as the model emitted it
  call_id: string;
  preamble?: string; // assistant text preceding the calls (first item only)
}

export interface SyncToolResultData {
  call_id: string;
  name: string;
  preview: string; // first 500 chars
  truncated: boolean;
}

export interface SyncItem {
  id: string;
  type: SyncItemType;
  data: SyncMessageData | SyncToolCallData | SyncToolResultData;
}

export interface StoredItem extends SyncItem {
  session_id: string;
  position: number;
  origin: string;
  created_at: string; // ISO
}

export interface SessionRow {
  id: string;
  title: string;
  model_label: string | null;
  workspace_host: string | null;
  created_at: string;
  updated_at: string;
}

// --- REST bodies ---

export interface SessionUpsertBody {
  title: string;
  model_label?: string | null;
  workspace_host?: string | null;
}

export interface ItemsPostBody {
  items: SyncItem[];
}

export interface DeltaPostBody {
  turn_id: string;
  seq: number;
  text: string; // FULL streamed text so far — idempotent, loss-tolerant
}

export interface SnapshotResponse {
  session: SessionRow;
  items: StoredItem[];
  live: boolean;
}

// --- SSE frames ---
// Sent as `event: <kind>\ndata: <json>\n\n`.

export interface ItemFrame {
  kind: "item";
  item: StoredItem;
}

export interface DeltaFrame {
  kind: "delta";
  turn_id: string;
  seq: number;
  text: string;
}

export interface SessionFrame {
  kind: "session";
  session: SessionRow;
}

export interface RemovedFrame {
  kind: "removed";
  id: string;
}

export interface HeartbeatFrame {
  kind: "heartbeat";
}

export type SessionStreamFrame = ItemFrame | DeltaFrame | SessionFrame | HeartbeatFrame;
export type ListStreamFrame = SessionFrame | RemovedFrame | HeartbeatFrame;

export const PROTOCOL_VERSION = 1;
export const TOOL_RESULT_PREVIEW_CHARS = 500;
export const SNAPSHOT_ITEM_LIMIT = 200;
export const HEARTBEAT_INTERVAL_MS = 25_000;
