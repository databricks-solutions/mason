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

// Renders an inline question card with options. Returns a Promise that resolves
// with the selected answer(s) as a string, or "user_cancelled" if the user
// dismisses it. Used by the ask_user built-in tool.
function renderQuestionCard(
  question: string,
  options: string[],
  multiSelect: boolean
): Promise<string> {
  return new Promise((resolve) => {
    removeThinking();
    clearWelcome();
    const messagesEl = mason.el.messages as HTMLElement | null;
    if (!messagesEl) {
      resolve("user_cancelled");
      return;
    }

    const card = document.createElement("div");
    card.className = "msg question-card";

    const safeOptions = (options || []).slice(0, 4);
    const inputType = multiSelect ? "checkbox" : "radio";
    const name = `q_${Date.now()}`;
    const optionsHtml = safeOptions
      .map(
        (opt, i) => `
          <label class="question-option">
            <input type="${inputType}" name="${name}" value="${i}" />
            <span>${renderMarkdown(opt).replace(/<\/?p>/g, "")}</span>
          </label>`
      )
      .join("");

    card.innerHTML = `
      <div class="question-card-prompt">${renderMarkdown(question)}</div>
      <div class="question-options">${optionsHtml}
        <label class="question-option question-option-other">
          <input type="${inputType}" name="${name}" value="other" />
          <span>Other</span>
        </label>
      </div>
      <div class="question-other-row" style="display:none;">
        <input class="question-other-input" type="text" placeholder="Type your answer…" />
      </div>
      <div class="question-actions">
        <button class="modal-btn secondary question-cancel">Cancel</button>
        <button class="modal-btn primary question-submit" disabled>Submit</button>
      </div>
    `;
    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const submitBtn = card.querySelector(".question-submit") as HTMLButtonElement;
    const cancelBtn = card.querySelector(".question-cancel") as HTMLButtonElement;
    const otherRow = card.querySelector(".question-other-row") as HTMLElement;
    const otherInput = card.querySelector(".question-other-input") as HTMLInputElement;
    const inputs = Array.from(card.querySelectorAll(`input[name="${name}"]`)) as HTMLInputElement[];

    const updateState = (): void => {
      const checked = inputs.filter((i) => i.checked);
      const showOther = checked.some((i) => i.value === "other");
      otherRow.style.display = showOther ? "" : "none";
      const hasAnswer = checked.length > 0 && (!showOther || otherInput.value.trim().length > 0);
      submitBtn.disabled = !hasAnswer;
    };

    inputs.forEach((input) => input.addEventListener("change", updateState));
    otherInput.addEventListener("input", updateState);

    const finish = (answer: string): void => {
      // Lock the card so the user can't double-submit; show their selection.
      card.classList.add("question-card-answered");
      inputs.forEach((i) => (i.disabled = true));
      otherInput.disabled = true;
      submitBtn.style.display = "none";
      cancelBtn.style.display = "none";
      const summary = document.createElement("div");
      summary.className = "question-answer-summary";
      summary.textContent = `Answer: ${answer}`;
      card.appendChild(summary);
      resolve(answer);
    };

    submitBtn.addEventListener("click", () => {
      const chosen = inputs.filter((i) => i.checked);
      const parts: string[] = [];
      for (const input of chosen) {
        if (input.value === "other") {
          const txt = otherInput.value.trim();
          if (txt) parts.push(txt);
        } else {
          const idx = parseInt(input.value, 10);
          if (!Number.isNaN(idx) && safeOptions[idx] !== undefined) parts.push(safeOptions[idx]);
        }
      }
      if (parts.length === 0) return;
      finish(parts.join("; "));
    });

    cancelBtn.addEventListener("click", () => finish("user_cancelled"));
  });
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
