// Message rendering and chat UI.

interface ChatHistoryMessage {
  role: string;
  content?: string | unknown[];
  name?: string;
}

declare function renderMarkdown(text: string): string;
declare function refreshHistory(): void;
declare function switchToChatsTab(): void;

function clearWelcome(): void {
  const messagesEl = mason.el.messages as HTMLElement | null;
  if (!messagesEl) return;
  const w = messagesEl.querySelector(".welcome");
  if (w) w.remove();
}

function showWelcome(): void {
  const messagesEl = mason.el.messages as HTMLElement | null;
  if (!messagesEl) return;
  messagesEl.innerHTML = `
    <div class="welcome">
      <img class="welcome-logo" src="icons/Databricks-Emblem.png" alt="" />
      <div class="welcome-title">What can I help with?</div>
      <div class="welcome-sub">Pick a model and start chatting.</div>
    </div>`;
}

function showThinking(): void {
  clearWelcome();
  removeThinking();
  const messagesEl = mason.el.messages as HTMLElement | null;
  if (!messagesEl) return;
  const div = document.createElement("div");
  div.className = "thinking";
  div.id = "thinkingIndicator";
  div.innerHTML = `
    <div class="thinking-bricks">
      <div class="thinking-brick"></div>
      <div class="thinking-brick"></div>
      <div class="thinking-brick"></div>
    </div>
    <span class="thinking-label">Building...</span>
  `;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function removeThinking(): void {
  const el = document.getElementById("thinkingIndicator");
  if (el) el.remove();
}

function addMessageEl(role: string, text: string): void {
  removeThinking();
  clearWelcome();
  const messagesEl = mason.el.messages as HTMLElement | null;
  if (!messagesEl) return;
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "assistant") {
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMessages(): void {
  const messagesEl = mason.el.messages as HTMLElement | null;
  if (!messagesEl) return;
  messagesEl.innerHTML = "";
  const history = mason.history as ChatHistoryMessage[];
  if (history.length === 0) {
    showWelcome();
    return;
  }
  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      addMessageEl("tool-call", `Tool result (${m.name}): ${content}`);
    } else {
      addMessageEl(m.role, (m.content as string) || "");
    }
  }
}

function newChat(): void {
  mason.history = [];
  mason.currentChatId = null;
  if (mason.currentView !== "chat" && typeof switchToChatsTab === "function") {
    switchToChatsTab();
  }
  showWelcome();
  refreshHistory();
}
