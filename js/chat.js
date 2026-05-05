// Chat send + agentic tool loop with streaming

const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

const MAX_TOOL_RESULT_CHARS = 256 * 1024;
function capToolResult(text, toolName) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n[Truncated: ${toolName} returned ${text.length} chars, only first ${MAX_TOOL_RESULT_CHARS} kept. Ask for a more specific query or read in chunks.]`;
}

function setGenerating(active) {
  mason.generating = active;
  mason.el.send.innerHTML = active ? STOP_ICON : SEND_ICON;
  mason.el.send.disabled = false;
  mason.el.send.title = active ? "Stop" : "Send";
  mason.el.send.setAttribute("aria-label", active ? "Stop generation" : "Send message");
}

async function send() {
  // If generating, treat as stop
  if (mason.generating) {
    mason.chatAborted = true;
    window.api.abortChat();
    return;
  }

  const text = mason.el.input.value.trim();
  if (!text && mason.attachedFiles.length === 0) return;

  if (!navigator.onLine) { addMessageEl("error", "You appear to be offline. Check your network connection."); return; }

  const profile = getSelectedProfile();
  if (!profile) { addMessageEl("error", "Select a Databricks profile in the sidebar."); return; }

  // Build the LLM-facing message
  const textFiles = mason.attachedFiles.filter((f) => f.kind === "text");
  const imageFiles = mason.attachedFiles.filter((f) => f.kind === "image");

  // Inline text file contents into the prompt
  let messageText = text;
  if (textFiles.length > 0) {
    const blocks = textFiles.map((f) =>
      `**${f.name}**\n\`\`\`${f.ext || ""}\n${f.content}\n\`\`\``
    ).join("\n\n");
    const prefix = text ? `${text}\n\n` : "";
    messageText = `${prefix}--- Attached files ---\n\n${blocks}`;
  }

  // If there are images, use multimodal content array; otherwise, plain string
  let llmContent;
  if (imageFiles.length > 0) {
    llmContent = [];
    if (messageText) llmContent.push({ type: "text", text: messageText });
    for (const img of imageFiles) {
      llmContent.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }
  } else {
    llmContent = messageText;
  }

  // UI shows just what the user typed plus an attachment hint
  const displayText = mason.attachedFiles.length > 0
    ? `${text}${text ? "\n\n" : ""}_📎 ${mason.attachedFiles.length} file${mason.attachedFiles.length > 1 ? "s" : ""} attached: ${mason.attachedFiles.map((f) => f.name).join(", ")}_`
    : text;
  addMessageEl("user", displayText);
  mason.history.push({ role: "user", content: llmContent });
  mason.attachedFiles = [];
  renderAttachmentChips();
  mason.el.input.value = "";
  mason.el.input.style.height = "auto";
  mason.chatAborted = false;
  setGenerating(true);
  showThinking();

  try {
    await chatLoop(profile);
  } catch (e) {
    if (!mason.chatAborted) addMessageEl("error", e.message);
  } finally {
    removeThinking();
    setGenerating(false);
    mason.el.input.focus();
  }
}

async function chatLoop(profile) {
  const toolDefs = getAllToolDefs();
  const selectedModel = modelEl.value;
  const customEp = selectedModel.startsWith("custom:")
    ? mason.customEndpoints.find((e) => e.modelId === selectedModel.replace("custom:", ""))
    : null;
  const isResponsesApi = isResponsesApiModel(selectedModel) || (customEp && customEp.format === "responses");
  const toolsForApi = (toolDefs.length > 0 && !isResponsesApi)
    ? toolDefs.map(({ type, function: fn }) => ({ type, function: fn }))
    : null;

  console.log(`[CHAT] MCP servers: ${mason.mcpServers.length}, tools: ${toolDefs.length}, responsesApi: ${isResponsesApi}`);
  if (isResponsesApi && toolDefs.length > 0) {
    addMessageEl("error", "Tools are not supported with this model. Switch to Claude, Gemini, or Llama for tool calling.");
  }
  if (toolsForApi) console.log(`[CHAT] Sending tools:`, JSON.stringify(toolsForApi.map((t) => t.function.name)));

  let maxIterations = 10;

  while (maxIterations-- > 0) {
    const chatToken = await getAuthToken();
    const sel = modelEl.value;
    let chatGateway = mason.workspaceGatewayUrl || null;
    let chatModel = sel;
    let chatFormat = null;

    if (sel.startsWith("custom:")) {
      chatModel = sel.replace("custom:", "");
      const ep = mason.customEndpoints.find((e) => e.modelId === chatModel);
      if (ep) {
        if (ep.gatewayUrl) chatGateway = ep.gatewayUrl;
        chatFormat = ep.format;
      }
    }

    // Streaming when no tools
    const canStream = !toolsForApi;
    let streamingEl = null;
    let streamedText = "";
    let typeTimer = null;

    if (canStream) {
      let typeQueue = "";
      let typePos = 0;
      let typeRunning = false;
      let firstChunk = true;
      function typeNext() {
        if (typePos < typeQueue.length) {
          const batch = typeQueue.slice(typePos, typePos + 3);
          typePos += batch.length;
          streamingEl.textContent = typeQueue.slice(0, typePos);
          mason.el.messages.scrollTop = mason.el.messages.scrollHeight;
          typeTimer = setTimeout(typeNext, 12);
        } else {
          typeRunning = false;
          typeTimer = null;
        }
      }
      function ensureTyping() {
        if (!typeRunning) { typeRunning = true; typeNext(); }
      }

      window.api.onChatChunk((chunk) => {
        if (firstChunk) {
          firstChunk = false;
          removeThinking();
          clearWelcome();
          streamingEl = document.createElement("div");
          streamingEl.className = "msg assistant";
          streamingEl.style.whiteSpace = "pre-wrap";
          mason.el.messages.appendChild(streamingEl);
          mason.el.messages.scrollTop = mason.el.messages.scrollHeight;
        }
        streamedText += chunk;
        typeQueue = streamedText;
        ensureTyping();
      });
    }

    let result;
    try {
      result = await window.api.chat({
        token: chatToken,
        model: chatModel,
        messages: trimHistory(mason.history),
        tools: toolsForApi,
        gateway: chatGateway,
        format: chatFormat,
        stream: canStream,
      });
    } catch (e) {
      if (canStream) {
        window.api.removeChatChunkListeners();
        if (typeTimer) clearTimeout(typeTimer);
      }
      // If aborted and we have partial streamed content, finalize it
      if (mason.chatAborted && streamedText) {
        if (streamingEl) {
          streamingEl.style.whiteSpace = "";
          streamingEl.innerHTML = renderMarkdown(streamedText);
          mason.el.messages.scrollTop = mason.el.messages.scrollHeight;
        }
        mason.history.push({ role: "assistant", content: streamedText });
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
      mason.history.push({ role: "assistant", content: result.content });
      if (streamingEl) {
        streamingEl.style.whiteSpace = "";
        streamingEl.innerHTML = renderMarkdown(result.content);
        mason.el.messages.scrollTop = mason.el.messages.scrollHeight;
      } else {
        addMessageEl("assistant", result.content);
      }
      await saveCurrentChat();
      return;
    }

    if (result.type === "tool_calls") {
      if (result.content) addMessageEl("assistant", result.content);
      mason.history.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.tool_calls,
      });

      for (const tc of result.tool_calls) {
        const toolName = tc.function.name;
        let args = {};
        try { args = JSON.parse(tc.function.arguments); } catch (_) {}

        addMessageEl("tool-call", `Calling tool: ${toolName}`);

        if (BUILTIN_TOOL_NAMES.has(toolName)) {
          try {
            const toolResult = await window.api.builtinToolCall({ toolName, args });
            const resultText = capToolResult(JSON.stringify(toolResult), toolName);
            mason.history.push({ role: "tool", tool_call_id: tc.id, name: toolName, content: resultText });
            addMessageEl("tool-call", `${toolName}: ${toolResult.message || toolResult.content?.slice(0, 200) || resultText}`);
          } catch (e) {
            mason.history.push({ role: "tool", tool_call_id: tc.id, name: toolName, content: `Error: ${e.message}` });
            addMessageEl("error", `Tool error (${toolName}): ${e.message}`);
          }
          continue;
        }

        const server = findMcpServerForTool(toolName);
        if (!server) {
          mason.history.push({ role: "tool", tool_call_id: tc.id, name: toolName, content: "Error: no MCP server found for this tool" });
          continue;
        }

        try {
          let toolResult;
          if (server.type === "stdio") {
            toolResult = await window.api.mcpStdioCallTool({ key: server.key, toolName, args });
          } else {
            const mcpToken = await getAuthToken();
            toolResult = await window.api.mcpCallTool({ serverUrl: server.url, token: mcpToken, toolName, args });
          }
          const rawText = toolResult.content
            ? toolResult.content.map((c) => c.text || JSON.stringify(c)).join("\n")
            : JSON.stringify(toolResult);
          const resultText = capToolResult(rawText, toolName);
          mason.history.push({ role: "tool", tool_call_id: tc.id, name: toolName, content: resultText });
          addMessageEl("tool-call", `${toolName} result: ${resultText.slice(0, 200)}${resultText.length > 200 ? "..." : ""}`);
        } catch (e) {
          mason.history.push({ role: "tool", tool_call_id: tc.id, name: toolName, content: `Error: ${e.message}` });
          addMessageEl("error", `Tool error (${toolName}): ${e.message}`);
        }
      }

      showThinking();
      continue;
    }

    break;
  }
}
