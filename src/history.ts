// Chat history management.

declare function escapeHtml(s: string): string;
declare function selectModelByValue(value: string): void;
declare function renderMessages(): void;
declare function newChat(): void;
declare function genId(): string;
declare function switchToChatsTab(): void;

interface HistoryListItem {
  id: string;
  title?: string;
}

async function refreshHistory(): Promise<void> {
  const items = (await window.api.historyList()) as HistoryListItem[];
  const listEl = mason.el.historyList as HTMLElement | null;
  if (!listEl) return;
  listEl.innerHTML = "";
  for (const item of items) {
    const title = item.title || "Chat";
    const div = document.createElement("div");
    div.className = `history-item${item.id === mason.currentChatId ? " active" : ""}`;
    div.innerHTML = `
      <span class="history-item-title">${escapeHtml(title)}</span>
      <span class="history-item-actions">
        <button class="history-item-rename" type="button" title="Rename" aria-label="Rename chat">&#9998;</button>
        <button class="history-item-delete" type="button" title="Delete" aria-label="Delete chat">&times;</button>
      </span>
    `;
    // The row is styled as the click target, so make the whole row behave like
    // one. Short titles otherwise leave most of the visible row inert.
    div.addEventListener("click", () => loadChat(item.id));
    div.querySelector(".history-item-rename")!.addEventListener("click", (e) => {
      e.stopPropagation();
      beginChatRename(div, item.id, title);
    });
    div.querySelector(".history-item-delete")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.api.historyDelete(item.id);
      syncSessionDelete(item.id);
      if (mason.currentChatId === item.id) newChat();
      refreshHistory();
    });
    listEl.appendChild(div);
  }
}

function beginChatRename(row: HTMLElement, id: string, currentTitle: string): void {
  if (row.classList.contains("renaming")) return;
  const titleEl = row.querySelector(".history-item-title");
  if (!titleEl) return;

  row.classList.add("renaming");
  const input = document.createElement("input");
  input.className = "history-item-rename-input";
  input.type = "text";
  input.maxLength = 120;
  input.value = currentTitle;
  input.setAttribute("aria-label", "Chat title");
  input.addEventListener("click", (e) => e.stopPropagation());
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let finishing = false;
  const finish = async (save: boolean): Promise<void> => {
    if (finishing) return;
    finishing = true;
    const nextTitle = input.value.trim();
    if (save && nextTitle && nextTitle !== currentTitle) {
      const result = await window.api.historyRename({ id, title: nextTitle });
      if (result.ok) syncSessionRename(id, result.title || nextTitle);
    }
    await refreshHistory();
  };

  input.addEventListener("keydown", async (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      await finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      await finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function loadChat(id: string): Promise<void> {
  const data = (await window.api.historyLoad(id)) as
    | { id: string; title?: string; model?: string; messages: unknown[] }
    | null;
  if (!data) return;
  // Loading a chat while the designer is open should land the user back in
  // the chat pane, like newChat() does.
  if (mason.currentView === "designer") switchToChatsTab();
  mason.currentChatId = id;
  mason.history = data.messages;
  // Only restore the saved model if this workspace actually has it.
  if (data.model && isModelAvailable(data.model)) {
    selectModelByValue(data.model);
  }
  renderMessages();
  refreshHistory();
  // Tail web-originated turns for this chat (and catch up any we missed).
  syncLiveAttach(id);
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
  const result = await window.api.historySave({
    id: mason.currentChatId,
    title,
    model: mason.selectedModelValue,
    messages: mason.history,
  });
  // Mirror to the session-sync server (fire-and-forget; no-op when disabled).
  syncCatchUp(mason.currentChatId, result.title || title, mason.selectedModelLabel);
  refreshHistory();
}
