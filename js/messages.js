// Message rendering and chat UI

function clearWelcome() {
  const w = mason.el.messages.querySelector(".welcome");
  if (w) w.remove();
}

function showWelcome() {
  mason.el.messages.innerHTML = `
    <div class="welcome">
      <img class="welcome-logo" src="icons/Databricks-Emblem.png" alt="" />
      <div class="welcome-title">What can I help with?</div>
      <div class="welcome-sub">Pick a model and start chatting.</div>
    </div>`;
}

function showThinking() {
  clearWelcome();
  removeThinking();
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
  mason.el.messages.appendChild(div);
  mason.el.messages.scrollTop = mason.el.messages.scrollHeight;
}

function removeThinking() {
  const el = document.getElementById("thinkingIndicator");
  if (el) el.remove();
}

function addMessageEl(role, text) {
  removeThinking();
  clearWelcome();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "assistant") {
    div.innerHTML = renderMarkdown(text);
  } else {
    div.textContent = text;
  }
  mason.el.messages.appendChild(div);
  mason.el.messages.scrollTop = mason.el.messages.scrollHeight;
}

function renderMessages() {
  mason.el.messages.innerHTML = "";
  if (mason.history.length === 0) {
    showWelcome();
    return;
  }
  for (const m of mason.history) {
    if (m.role === "tool") {
      addMessageEl("tool-call", `Tool result (${m.name}): ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`);
    } else {
      addMessageEl(m.role, m.content || "");
    }
  }
}

function newChat() {
  mason.history = [];
  mason.currentChatId = null;
  showWelcome();
  refreshHistory();
}
