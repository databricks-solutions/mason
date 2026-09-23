const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.parent = null;
    this.className = "";
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => {
        if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim();
      },
    };
    this.textContent = "";
    this.type = "";
    this.value = "";
    this.scrollHeight = 500;
    this.scrollTop = 0;
    this.appendCount = 0;
    this._innerHTML = "";
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.children = [];
    if (value.includes("history-item-title")) {
      const title = new FakeElement("span");
      title.className = "history-item-title";
      const actions = new FakeElement("span");
      actions.className = "history-item-actions";
      const renameButton = new FakeElement("button");
      renameButton.className = "history-item-rename";
      const deleteButton = new FakeElement("button");
      deleteButton.className = "history-item-delete";
      this.appendChild(title);
      actions.appendChild(renameButton);
      actions.appendChild(deleteButton);
      this.appendChild(actions);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.appendCount += 1;
    child.parent = this;
    this.children.push(child);
    return child;
  }

  querySelector(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : selector;
    for (const child of this.children) {
      if (child.className.split(/\s+/).includes(className)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  replaceWith(replacement) {
    const index = this.parent.children.indexOf(this);
    replacement.parent = this.parent;
    this.parent.children[index] = replacement;
  }

  setAttribute() {}
  focus() {}
  select() {}

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  async click() {
    let stopped = false;
    const event = { stopPropagation: () => { stopped = true; } };
    for (const handler of this.listeners.get("click") || []) await handler(event);
    if (!stopped && this.parent) await this.parent.click();
  }

  async keydown(key) {
    const event = {
      key,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    for (const handler of this.listeners.get("keydown") || []) await handler(event);
  }
}

function runScript(file, context) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

async function testHistoryRowClick() {
  const list = new FakeElement("div");
  let loadedId = null;
  let deletedId = null;
  let renamed = null;
  const context = vm.createContext({
    console,
    mason: {
      currentChatId: null,
      currentView: "chat",
      history: [],
      customEndpoints: [],
      discoveredModels: [],
      el: { historyList: list },
    },
    window: {
      api: {
        historyList: async () => [{ id: "long-chat", title: "hello" }],
        historyLoad: async (id) => {
          loadedId = id;
          return { messages: [] };
        },
        historyRename: async (data) => {
          renamed = data;
          return { ok: true, title: data.title };
        },
        historyDelete: async (id) => { deletedId = id; },
      },
    },
    document: { createElement: (tag) => new FakeElement(tag) },
    escapeHtml: (value) => value,
    renderMessages: () => {},
    refreshHistory: undefined,
    selectModelByValue: () => {},
    switchToChatsTab: () => {},
    syncLiveAttach: () => {},
    syncSessionRename: () => {},
    syncSessionDelete: () => {},
    newChat: () => {},
    genId: () => "generated",
  });

  runScript(path.join(__dirname, "../build/ts/history.js"), context);
  await context.refreshHistory();
  const row = list.children[0];
  await row.click();
  assert.equal(loadedId, "long-chat", "clicking the row should load the chat");

  loadedId = null;
  await row.querySelector(".history-item-rename").click();
  const input = row.querySelector(".history-item-rename-input");
  input.value = "House planning";
  await input.keydown("Enter");
  assert.equal(renamed.id, "long-chat");
  assert.equal(renamed.title, "House planning");
  assert.equal(loadedId, null, "rename click must not also load the chat");

  await context.refreshHistory();
  const refreshedRow = list.children[0];
  loadedId = null;
  await refreshedRow.querySelector(".history-item-delete").click();
  assert.equal(deletedId, "long-chat", "delete should still remove the chat");
  assert.equal(loadedId, null, "delete click must not also load the chat");
}

function testHistoryRenderBatching() {
  const messages = new FakeElement("div");
  const document = {
    createElement: (tag) => new FakeElement(tag),
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: () => null,
  };
  const context = vm.createContext({
    console,
    document,
    mason: {
      history: Array.from({ length: 30 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index}`,
      })),
      el: { messages },
    },
    renderMarkdown: (value) => `<p>${value}</p>`,
    refreshHistory: () => {},
    switchToChatsTab: () => {},
    syncLiveDetach: () => {},
  });

  runScript(path.join(__dirname, "../build/ts/messages.js"), context);
  context.renderMessages();
  assert.equal(messages.appendCount, 1, "restored messages should be inserted in one batch");
  assert.equal(messages.scrollTop, messages.scrollHeight, "restored chat should scroll to the end");
}

(async () => {
  await testHistoryRowClick();
  testHistoryRenderBatching();
  console.log("History regression tests passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
