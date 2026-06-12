// Mason mobile viewer — read-only live session viewer (Phase 1).
//
// Attach sequence (the dedupe contract from the spec):
//   1. open the SSE stream, buffering frames
//   2. fetch the snapshot
//   3. render snapshot, drain buffer dropping ids already rendered
//   4. live: items append; deltas drive the in-progress bubble (replaced by
//      the persisted assistant item, matched on content arrival)
//
// Script-mode TS (no modules) — compiled to public/viewer.js.

declare const marked: { parse(src: string): string };
declare const DOMPurify: { sanitize(html: string): string };
declare const hljs: { highlightElement(el: HTMLElement): void };

interface VSession {
  id: string;
  title: string;
  model_label: string | null;
  updated_at: string;
}
interface VItem {
  id: string;
  type: string;
  position: number;
  data: any;
}

const API = "/api/v1";

// --- DOM ---
const $list = document.getElementById("sessionList") as HTMLElement;
const $transcript = document.getElementById("transcript") as HTMLElement;
const $title = document.getElementById("topTitle") as HTMLElement;
const $back = document.getElementById("backBtn") as HTMLButtonElement;
const $dot = document.getElementById("liveDot") as HTMLElement;
const $footer = document.getElementById("watchFooter") as HTMLElement;

// --- state ---
let sessions: VSession[] = [];
let currentSession: string | null = null;
let renderedIds = new Set<string>();
let liveBubble: HTMLElement | null = null;
let liveTurnId: string | null = null;
let liveSeq = -1;
let es: EventSource | null = null;
let listEs: EventSource | null = null;

function md(text: string): string {
  return DOMPurify.sanitize(marked.parse(text || ""));
}

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function setDot(state: "off" | "connected" | "streaming"): void {
  $dot.className = `live-dot${state === "off" ? "" : " " + state}`;
}

// --- session list ---

async function loadSessions(): Promise<void> {
  const res = await fetch(`${API}/sessions`);
  if (!res.ok) {
    $list.innerHTML = `<div class="list-empty">Could not load sessions (HTTP ${res.status}).</div>`;
    return;
  }
  sessions = (await res.json()).sessions;
  renderSessionList();
}

function renderSessionList(): void {
  if (sessions.length === 0) {
    $list.innerHTML =
      '<div class="list-empty">No synced chats yet.<br/>Enable session sync in Mason desktop Settings.</div>';
    return;
  }
  $list.innerHTML = "";
  for (const s of sessions) {
    const div = document.createElement("div");
    div.className = "session-item";
    div.innerHTML = `
      <div class="session-title"></div>
      <div class="session-meta">
        ${s.model_label ? '<span class="session-model"></span>' : ""}
        <span class="session-time"></span>
      </div>`;
    (div.querySelector(".session-title") as HTMLElement).textContent = s.title;
    const model = div.querySelector(".session-model") as HTMLElement | null;
    if (model) model.textContent = s.model_label || "";
    (div.querySelector(".session-time") as HTMLElement).textContent = relTime(s.updated_at);
    div.addEventListener("click", () => openSession(s));
    $list.appendChild(div);
  }
}

function subscribeList(): void {
  listEs?.close();
  listEs = new EventSource(`${API}/sessions/stream`);
  listEs.onopen = () => { if (!currentSession) setDot("connected"); };
  listEs.onerror = () => { if (!currentSession) setDot("off"); };
  listEs.addEventListener("session", (ev) => {
    const { session } = JSON.parse((ev as MessageEvent).data);
    sessions = [session, ...sessions.filter((s) => s.id !== session.id)];
    if (!currentSession) renderSessionList();
  });
  listEs.addEventListener("removed", (ev) => {
    const { id } = JSON.parse((ev as MessageEvent).data);
    sessions = sessions.filter((s) => s.id !== id);
    if (!currentSession) renderSessionList();
    if (currentSession === id) showList();
  });
}

// --- transcript ---

function renderItem(item: VItem): void {
  if (renderedIds.has(item.id)) return;
  renderedIds.add(item.id);
  const d = item.data || {};
  let el: HTMLElement | null = null;

  if (item.type === "message") {
    el = document.createElement("div");
    el.className = `msg ${d.role === "user" ? "user" : "assistant"}`;
    if (d.role === "user") el.textContent = d.content || "";
    else el.innerHTML = md(d.content || "");
    // The persisted assistant message supersedes any in-progress bubble.
    if (d.role === "assistant" && liveBubble) {
      liveBubble.remove();
      liveBubble = null;
      liveTurnId = null;
      setDot("connected");
    }
  } else if (item.type === "tool_call") {
    if (d.preamble) {
      const pre = document.createElement("div");
      pre.className = "msg assistant";
      pre.innerHTML = md(d.preamble);
      $transcript.appendChild(pre);
    }
    el = document.createElement("div");
    el.className = "msg tool";
    el.textContent = `→ ${d.name}(${(d.arguments || "").slice(0, 160)})`;
  } else if (item.type === "tool_result") {
    el = document.createElement("div");
    el.className = "msg tool";
    el.textContent = `✓ ${d.name}: ${d.preview || ""}${d.truncated ? " …" : ""}`;
  }

  if (el) {
    $transcript.appendChild(el);
    el.querySelectorAll("pre code").forEach((c) => hljs.highlightElement(c as HTMLElement));
  }
}

function renderDelta(turnId: string, seq: number, text: string): void {
  if (liveTurnId === turnId && seq <= liveSeq) return; // stale frame
  liveTurnId = turnId;
  liveSeq = seq;
  if (!liveBubble) {
    liveBubble = document.createElement("div");
    liveBubble.className = "msg assistant streaming-cursor";
    $transcript.appendChild(liveBubble);
    setDot("streaming");
  }
  liveBubble.innerHTML = md(text);
  scrollToEnd();
}

function scrollToEnd(): void {
  $transcript.scrollTop = $transcript.scrollHeight;
}

async function openSession(s: VSession): Promise<void> {
  currentSession = s.id;
  renderedIds = new Set();
  liveBubble = null;
  liveTurnId = null;
  liveSeq = -1;
  $list.style.display = "none";
  $transcript.style.display = "";
  $transcript.innerHTML = "";
  $footer.style.display = "";
  $back.style.display = "";
  $title.textContent = s.title;

  // 1. stream first, buffering until the snapshot lands
  const buffered: Array<{ kind: string; payload: any }> = [];
  let snapshotDone = false;
  es?.close();
  es = new EventSource(`${API}/sessions/${encodeURIComponent(s.id)}/stream`);
  es.onopen = () => setDot("connected");
  es.onerror = () => setDot("off"); // EventSource auto-reconnects
  const handle = (kind: string, payload: any): void => {
    if (!snapshotDone) {
      buffered.push({ kind, payload });
      return;
    }
    if (currentSession !== s.id) return;
    if (kind === "item") {
      renderItem(payload.item);
      scrollToEnd();
    } else if (kind === "delta") {
      renderDelta(payload.turn_id, payload.seq, payload.text);
    } else if (kind === "session") {
      $title.textContent = payload.session.title;
    }
  };
  for (const kind of ["item", "delta", "session"]) {
    es.addEventListener(kind, (ev) => handle(kind, JSON.parse((ev as MessageEvent).data)));
  }

  // 2. snapshot
  const res = await fetch(`${API}/sessions/${encodeURIComponent(s.id)}`);
  if (!res.ok) {
    $transcript.innerHTML = `<div class="list-empty">Could not load session (HTTP ${res.status}).</div>`;
    return;
  }
  const snap = await res.json();

  // 3. render snapshot, then drain the buffer (renderItem dedupes by id)
  for (const item of snap.items as VItem[]) renderItem(item);
  snapshotDone = true;
  for (const b of buffered) handle(b.kind, b.payload);
  scrollToEnd();
}

function showList(): void {
  currentSession = null;
  es?.close();
  es = null;
  $transcript.style.display = "none";
  $footer.style.display = "none";
  $back.style.display = "none";
  $list.style.display = "";
  $title.textContent = "Mason";
  setDot(listEs && listEs.readyState === EventSource.OPEN ? "connected" : "off");
  loadSessions();
}

$back.addEventListener("click", showList);

// --- boot ---
loadSessions();
subscribeList();
