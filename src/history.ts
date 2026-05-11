// Chat history management.

declare function escapeHtml(s: string): string;
declare function selectModelByValue(value: string): void;
declare function renderMessages(): void;
declare function newChat(): void;
declare function genId(): string;

interface HistoryListItem {
  id: string;
  title: string;
}

async function refreshHistory(): Promise<void> {
  const items = (await window.api.historyList()) as HistoryListItem[];
  const listEl = mason.el.historyList as HTMLElement | null;
  if (!listEl) return;
  listEl.innerHTML = "";
  for (const item of items) {
    const div = document.createElement("div");
    div.className = `history-item${item.id === mason.currentChatId ? " active" : ""}`;
    div.innerHTML = `
      <span class="history-item-title">${escapeHtml(item.title)}</span>
      <button class="history-item-delete" title="Delete">&times;</button>
    `;
    div.querySelector(".history-item-title")!.addEventListener("click", () => loadChat(item.id));
    div.querySelector(".history-item-delete")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.api.historyDelete(item.id);
      if (mason.currentChatId === item.id) newChat();
      refreshHistory();
    });
    listEl.appendChild(div);
  }
}

async function loadChat(id: string): Promise<void> {
  const data = (await window.api.historyLoad(id)) as
    | { id: string; title?: string; model?: string; messages: unknown[] }
    | null;
  if (!data) return;
  mason.currentChatId = id;
  mason.history = data.messages;
  // Only restore the saved model if this workspace actually has it.
  if (data.model && isModelAvailable(data.model)) {
    selectModelByValue(data.model);
  }
  renderMessages();
  refreshHistory();
}

function isModelAvailable(modelValue: string | null | undefined): boolean {
  if (!modelValue) return false;
  if (modelValue.startsWith("custom:")) {
    const id = modelValue.replace("custom:", "");
    return mason.customEndpoints.some((e) => e.modelId === id);
  }
  for (const g of mason.discoveredModels) {
    if (g.models.some((m) => m.value === modelValue)) return true;
  }
  return false;
}

async function saveCurrentChat(): Promise<void> {
  if (mason.history.length === 0) return;
  if (!mason.currentChatId) mason.currentChatId = genId();
  const firstUserMsg = (mason.history as Array<{ role: string; content?: string }>).find(
    (m) => m.role === "user"
  );
  const title = firstUserMsg && firstUserMsg.content ? firstUserMsg.content.slice(0, 60) : "Chat";
  await window.api.historySave({
    id: mason.currentChatId,
    title,
    model: mason.selectedModelValue,
    messages: mason.history,
  });
  refreshHistory();
}
