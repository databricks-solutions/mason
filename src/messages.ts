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

interface AskUserQuestion {
  question: string;
  options: string[];
  multiSelect?: boolean;
}

// Renders an inline question card that walks the user through one or more
// questions in sequence (single chat bubble — no round-trip to the model
// between questions). Resolves with a JSON-stringified record of
// { question: answer } pairs, or the literal "user_cancelled" if the user
// cancels at any step.
function renderQuestionCard(questions: AskUserQuestion[]): Promise<string> {
  return new Promise((resolve) => {
    removeThinking();
    clearWelcome();
    const messagesEl = mason.el.messages as HTMLElement | null;
    const list = (questions || []).slice(0, 4);
    if (!messagesEl || list.length === 0) {
      resolve("user_cancelled");
      return;
    }

    const card = document.createElement("div");
    card.className = "msg question-card";
    card.innerHTML = `
      <div class="question-card-progress"></div>
      <div class="question-card-prompt"></div>
      <div class="question-options"></div>
      <div class="question-other-row" style="display:none;">
        <input class="question-other-input" type="text" placeholder="Type your answer…" />
      </div>
      <div class="question-answers-summary" style="display:none;"></div>
      <div class="question-actions">
        <button class="modal-btn secondary question-cancel">Cancel</button>
        <button class="modal-btn primary question-submit" disabled>Submit</button>
      </div>
    `;
    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    const progressEl = card.querySelector(".question-card-progress") as HTMLElement;
    const promptEl = card.querySelector(".question-card-prompt") as HTMLElement;
    const optionsEl = card.querySelector(".question-options") as HTMLElement;
    const otherRow = card.querySelector(".question-other-row") as HTMLElement;
    const otherInput = card.querySelector(".question-other-input") as HTMLInputElement;
    const summaryEl = card.querySelector(".question-answers-summary") as HTMLElement;
    const submitBtn = card.querySelector(".question-submit") as HTMLButtonElement;
    const cancelBtn = card.querySelector(".question-cancel") as HTMLButtonElement;

    const answers: Record<string, string> = {};
    let idx = 0;

    const renderQuestion = (): void => {
      const q = list[idx];
      const safeOptions = (q.options || []).slice(0, 4);
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const name = `q_${Date.now()}_${idx}`;

      progressEl.textContent = list.length > 1 ? `Question ${idx + 1} of ${list.length}` : "";
      promptEl.innerHTML = renderMarkdown(q.question);

      optionsEl.innerHTML =
        safeOptions
          .map(
            (opt, i) => `
              <label class="question-option">
                <input type="${inputType}" name="${name}" value="${i}" />
                <span>${renderMarkdown(opt).replace(/<\/?p>/g, "")}</span>
              </label>`
          )
          .join("") +
        `<label class="question-option question-option-other">
           <input type="${inputType}" name="${name}" value="other" />
           <span>Other</span>
         </label>`;

      otherInput.value = "";
      otherRow.style.display = "none";
      submitBtn.disabled = true;
      submitBtn.textContent = idx < list.length - 1 ? "Next" : "Submit";

      const inputs = Array.from(card.querySelectorAll(`input[name="${name}"]`)) as HTMLInputElement[];
      const updateState = (): void => {
        const checked = inputs.filter((i) => i.checked);
        const showOther = checked.some((i) => i.value === "other");
        otherRow.style.display = showOther ? "" : "none";
        const hasAnswer = checked.length > 0 && (!showOther || otherInput.value.trim().length > 0);
        submitBtn.disabled = !hasAnswer;
      };
      inputs.forEach((input) => input.addEventListener("change", updateState));
      otherInput.oninput = updateState;

      submitBtn.onclick = (): void => {
        const chosen = inputs.filter((i) => i.checked);
        const parts: string[] = [];
        for (const input of chosen) {
          if (input.value === "other") {
            const txt = otherInput.value.trim();
            if (txt) parts.push(txt);
          } else {
            const i = parseInt(input.value, 10);
            if (!Number.isNaN(i) && safeOptions[i] !== undefined) parts.push(safeOptions[i]);
          }
        }
        if (parts.length === 0) return;
        answers[q.question] = parts.join("; ");

        // Append a small "answered" line above the current question so the
        // user can see what they've picked so far.
        summaryEl.style.display = "";
        const row = document.createElement("div");
        row.className = "question-answers-summary-row";
        row.innerHTML = `<span class="qa-q">${renderMarkdown(q.question).replace(/<\/?p>/g, "")}</span><span class="qa-a">${parts.join("; ")}</span>`;
        summaryEl.appendChild(row);

        idx += 1;
        if (idx < list.length) {
          renderQuestion();
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } else {
          finish(JSON.stringify(answers));
        }
      };
    };

    const finish = (result: string): void => {
      card.classList.add("question-card-answered");
      promptEl.style.display = "none";
      optionsEl.style.display = "none";
      otherRow.style.display = "none";
      progressEl.style.display = "none";
      submitBtn.style.display = "none";
      cancelBtn.style.display = "none";
      if (result === "user_cancelled") {
        const note = document.createElement("div");
        note.className = "question-answer-summary";
        note.textContent = "Cancelled.";
        card.appendChild(note);
      }
      resolve(result);
    };

    cancelBtn.addEventListener("click", () => finish("user_cancelled"));
    renderQuestion();
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
