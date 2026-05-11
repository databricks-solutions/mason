// Chat send + agentic tool loop with streaming.

declare function getSelectedProfile():
  | { name: string; host?: string }
  | undefined;
declare function getAuthToken(): Promise<string>;
declare function getGatewayUrl(): string | null;
declare function addMessageEl(role: string, text: string): void;
declare function showThinking(): void;
declare function removeThinking(): void;
declare function clearWelcome(): void;
declare function renderMarkdown(text: string): string;
declare function renderAttachmentChips(): void;
declare function saveCurrentChat(): Promise<void>;
declare function trimHistory(history: any[]): any[];
declare function getAllToolDefs(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: unknown };
  _mcpServerUrl?: string;
}>;
declare function findMcpServerForTool(name: string): MasonMcpServer | null;
// BUILTIN_TOOL_NAMES and modelEl are defined in tools.ts / models.ts
// respectively; both files share this global scope.

interface AttachedFile {
  name: string;
  kind?: "text" | "image";
  ext?: string;
  content?: string;
  dataUrl?: string;
}

interface ToolCallPayload {
  id: string;
  function: { name: string; arguments: string };
}

interface ChatResultPayload {
  type: "text" | "tool_calls";
  content?: string | null;
  tool_calls?: ToolCallPayload[];
  streamed?: boolean;
}

const SEND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

const MAX_TOOL_RESULT_CHARS = 256 * 1024;
function capToolResult(text: string, toolName: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[Truncated: ${toolName} returned ${text.length} chars, only first ${MAX_TOOL_RESULT_CHARS} kept. Ask for a more specific query or read in chunks.]`
  );
}

function setGenerating(active: boolean): void {
  mason.generating = active;
  const sendBtn = mason.el.send as HTMLButtonElement | null;
  if (!sendBtn) return;
  sendBtn.innerHTML = active ? STOP_ICON : SEND_ICON;
  sendBtn.disabled = false;
  sendBtn.title = active ? "Stop" : "Send";
  sendBtn.setAttribute("aria-label", active ? "Stop generation" : "Send message");
}

async function send(): Promise<void> {
  if (mason.generating) {
    mason.chatAborted = true;
    window.api.abortChat();
    return;
  }

  const inputEl = mason.el.input as HTMLTextAreaElement | null;
  const text = inputEl?.value.trim() || "";
  if (!text && mason.attachedFiles.length === 0) return;

  if (!navigator.onLine) {
    addMessageEl("error", "You appear to be offline. Check your network connection.");
    return;
  }

  const profile = getSelectedProfile();
  if (!profile) {
    addMessageEl("error", "Select a Databricks profile in the sidebar.");
    return;
  }

  const attached = mason.attachedFiles as AttachedFile[];
  const textFiles = attached.filter((f) => f.kind === "text");
  const imageFiles = attached.filter((f) => f.kind === "image");

  let messageText = text;
  if (textFiles.length > 0) {
    const blocks = textFiles
      .map((f) => `**${f.name}**\n\`\`\`${f.ext || ""}\n${f.content}\n\`\`\``)
      .join("\n\n");
    const prefix = text ? `${text}\n\n` : "";
    messageText = `${prefix}--- Attached files ---\n\n${blocks}`;
  }

  let llmContent: string | Array<Record<string, unknown>>;
  if (imageFiles.length > 0) {
    const parts: Array<Record<string, unknown>> = [];
    if (messageText) parts.push({ type: "text", text: messageText });
    for (const img of imageFiles) {
      parts.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }
    llmContent = parts;
  } else {
    llmContent = messageText;
  }

  const displayText =
    attached.length > 0
      ? `${text}${text ? "\n\n" : ""}_📎 ${attached.length} file${attached.length > 1 ? "s" : ""} attached: ${attached.map((f) => f.name).join(", ")}_`
      : text;
  addMessageEl("user", displayText);
  (mason.history as any[]).push({ role: "user", content: llmContent });
  mason.attachedFiles = [];
  renderAttachmentChips();
  if (inputEl) {
    inputEl.value = "";
    inputEl.style.height = "auto";
  }
  mason.chatAborted = false;
  setGenerating(true);
  showThinking();

  try {
    await chatLoop(profile);
  } catch (e) {
    if (!mason.chatAborted) addMessageEl("error", (e as Error).message);
  } finally {
    removeThinking();
    setGenerating(false);
    inputEl?.focus();
  }
}

async function chatLoop(_profile: { host?: string }): Promise<void> {
  const toolDefs = getAllToolDefs();
  const toolsForApi =
    toolDefs.length > 0
      ? toolDefs.map(({ type, function: fn }) => ({ type, function: fn }))
      : null;

  console.log(`[CHAT] MCP servers: ${mason.mcpServers.length}, tools: ${toolDefs.length}`);
  if (toolsForApi)
    console.log(
      `[CHAT] Sending tools:`,
      JSON.stringify(toolsForApi.map((t) => t.function.name))
    );

  let maxIterations = 10;

  while (maxIterations-- > 0) {
    const chatToken = await getAuthToken();
    const sel = modelEl.value;
    let chatGateway = getGatewayUrl();
    let chatModel = sel;
    let chatFormat: "chat" | "responses" | null = null;

    if (sel.startsWith("custom:")) {
      chatModel = sel.replace("custom:", "");
      const ep = mason.customEndpoints.find((e) => e.modelId === chatModel);
      if (ep) {
        if (ep.gatewayUrl) chatGateway = ep.gatewayUrl;
        chatFormat = ep.format || null;
      }
    } else {
      for (const g of mason.discoveredModels) {
        const m = g.models.find((x) => x.value === sel);
        if (m) {
          chatFormat = m.format || null;
          const supportsResponses = m.apiTypes && m.apiTypes.includes("openai/v1/responses");
          if (toolsForApi && toolsForApi.length > 0 && supportsResponses) {
            chatFormat = "responses";
          }
          break;
        }
      }
    }

    const canStream = !toolsForApi;
    let streamingEl: HTMLElement | null = null;
    let streamedText = "";
    let typeTimer: ReturnType<typeof setTimeout> | null = null;

    if (canStream) {
      let typeQueue = "";
      let typePos = 0;
      let typeRunning = false;
      let firstChunk = true;
      const messagesEl = mason.el.messages as HTMLElement | null;
      function typeNext(): void {
        if (typePos < typeQueue.length && streamingEl) {
          const batch = typeQueue.slice(typePos, typePos + 3);
          typePos += batch.length;
          streamingEl.textContent = typeQueue.slice(0, typePos);
          if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
          typeTimer = setTimeout(typeNext, 12);
        } else {
          typeRunning = false;
          typeTimer = null;
        }
      }
      function ensureTyping(): void {
        if (!typeRunning) {
          typeRunning = true;
          typeNext();
        }
      }

      window.api.onChatChunk((chunk: any) => {
        if (firstChunk) {
          firstChunk = false;
          removeThinking();
          clearWelcome();
          streamingEl = document.createElement("div");
          streamingEl.className = "msg assistant";
          streamingEl.style.whiteSpace = "pre-wrap";
          if (messagesEl) {
            messagesEl.appendChild(streamingEl);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        }
        streamedText += chunk;
        typeQueue = streamedText;
        ensureTyping();
      });
    }

    const trimmed = trimHistory(mason.history as any[]);
    const sysPrompt = (mason.systemPrompt || "").trim();
    const hasUserSystem = trimmed.some((m: any) => m.role === "system");
    const messagesToSend =
      sysPrompt && !hasUserSystem
        ? [{ role: "system", content: sysPrompt }, ...trimmed]
        : trimmed;

    let result: ChatResultPayload;
    try {
      result = (await window.api.chat({
        token: chatToken,
        model: chatModel,
        messages: messagesToSend,
        tools: toolsForApi || undefined,
        gateway: chatGateway || "",
        format: (chatFormat || "chat") as "chat" | "responses",
        stream: canStream,
      })) as unknown as ChatResultPayload;
    } catch (e) {
      if (canStream) {
        window.api.removeChatChunkListeners();
        if (typeTimer) clearTimeout(typeTimer);
      }
      if (mason.chatAborted && streamedText) {
        const messagesEl = mason.el.messages as HTMLElement | null;
        const sel = streamingEl as HTMLElement | null;
        if (sel) {
          sel.style.whiteSpace = "";
          sel.innerHTML = renderMarkdown(streamedText);
          if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        (mason.history as any[]).push({ role: "assistant", content: streamedText });
        await saveCurrentChat();
        return;
      }
      throw e;
    }

    if (canStream) {
      window.api.removeChatChunkListeners();
      if (typeTimer) clearTimeout(typeTimer);
    }

    if (mason.chatAborted) return;

    console.log(`[CHAT] Response type: ${result.type}, streamed: ${!!result.streamed}`);

    if (result.type === "text") {
      const messagesEl = mason.el.messages as HTMLElement | null;
      (mason.history as any[]).push({ role: "assistant", content: result.content });
      const sel = streamingEl as HTMLElement | null;
      if (sel) {
        sel.style.whiteSpace = "";
        sel.innerHTML = renderMarkdown(result.content || "");
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        addMessageEl("assistant", result.content || "");
      }
      await saveCurrentChat();
      return;
    }

    if (result.type === "tool_calls") {
      if (result.content) addMessageEl("assistant", result.content);
      (mason.history as any[]).push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.tool_calls,
      });

      for (const tc of result.tool_calls || []) {
        const toolName = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch (_) {}

        addMessageEl("tool-call", `Calling tool: ${toolName}`);

        if (BUILTIN_TOOL_NAMES.has(toolName)) {
          try {
            const toolResult = (await window.api.builtinToolCall({ toolName, args })) as any;
            const resultText = capToolResult(JSON.stringify(toolResult), toolName);
            (mason.history as any[]).push({
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: resultText,
            });
            const preview =
              toolResult?.message ||
              (typeof toolResult?.content === "string" && toolResult.content.slice(0, 200)) ||
              resultText;
            addMessageEl("tool-call", `${toolName}: ${preview}`);
          } catch (e) {
            (mason.history as any[]).push({
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: `Error: ${(e as Error).message}`,
            });
            addMessageEl("error", `Tool error (${toolName}): ${(e as Error).message}`);
          }
          continue;
        }

        const server = findMcpServerForTool(toolName);
        if (!server) {
          (mason.history as any[]).push({
            role: "tool",
            tool_call_id: tc.id,
            name: toolName,
            content: "Error: no MCP server found for this tool",
          });
          continue;
        }

        try {
          let toolResult: any;
          if (server.type === "stdio") {
            toolResult = await window.api.mcpStdioCallTool({
              key: server.key!,
              toolName,
              args,
            });
          } else {
            const mcpToken = await getAuthToken();
            toolResult = await window.api.mcpCallTool({
              serverUrl: server.url!,
              token: mcpToken,
              toolName,
              args,
            });
          }
          const rawText = toolResult?.content
            ? toolResult.content.map((c: any) => c.text || JSON.stringify(c)).join("\n")
            : JSON.stringify(toolResult);
          const resultText = capToolResult(rawText, toolName);
          (mason.history as any[]).push({
            role: "tool",
            tool_call_id: tc.id,
            name: toolName,
            content: resultText,
          });
          addMessageEl(
            "tool-call",
            `${toolName} result: ${resultText.slice(0, 200)}${resultText.length > 200 ? "..." : ""}`
          );
        } catch (e) {
          (mason.history as any[]).push({
            role: "tool",
            tool_call_id: tc.id,
            name: toolName,
            content: `Error: ${(e as Error).message}`,
          });
          addMessageEl("error", `Tool error (${toolName}): ${(e as Error).message}`);
        }
      }

      showThinking();
      continue;
    }

    break;
  }
}
