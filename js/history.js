// Chat history management

async function refreshHistory() {
  const items = await window.api.historyList();
  mason.el.historyList.innerHTML = "";
  for (const item of items) {
    const div = document.createElement("div");
    div.className = `history-item${item.id === mason.currentChatId ? " active" : ""}`;
    div.innerHTML = `
      <span class="history-item-title">${escapeHtml(item.title)}</span>
      <button class="history-item-delete" title="Delete">&times;</button>
    `;
    div.querySelector(".history-item-title").addEventListener("click", () => loadChat(item.id));
    div.querySelector(".history-item-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.api.historyDelete(item.id);
      if (mason.currentChatId === item.id) newChat();
      refreshHistory();
    });
    mason.el.historyList.appendChild(div);
  }
}

async function loadChat(id) {
  const data = await window.api.historyLoad(id);
  if (!data) return;
  mason.currentChatId = id;
  mason.history = data.messages;
  selectModelByValue(data.model);
  renderMessages();
  refreshHistory();
}

async function saveCurrentChat() {
  if (mason.history.length === 0) return;
  if (!mason.currentChatId) mason.currentChatId = genId();
  const firstUserMsg = mason.history.find((m) => m.role === "user");
  const title = firstUserMsg ? firstUserMsg.content.slice(0, 60) : "Chat";
  await window.api.historySave({
    id: mason.currentChatId,
    title,
    model: mason.selectedModelValue,
    messages: mason.history,
  });
  refreshHistory();
}
