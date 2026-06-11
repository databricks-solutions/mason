// Shared agent-loop primitives used by both the chat view (chat.ts) and the
// workflow engine (workflow-engine.ts). Script-mode global like every other
// renderer module — loaded before chat.js in index.html.
//
// What lives here is the *headless* core of a tool-bearing agent turn:
//   • resolveModelRouting — per-model gateway/format resolution, including the
//     tools→Responses promotion for models like GPT-5.5
//   • executeToolCore — execute one tool call (load_skill / builtin IPC /
//     HTTP MCP / stdio MCP) and return its result content + a short preview
//   • capToolResult — bound tool results so a single call can't blow context
//
// Deliberately *not* here: streaming/typewriter UI, history mutation, and
// ask_user (all UI-bound — each caller owns its own presentation).

declare function getGatewayUrl(): string | null;

const MAX_TOOL_RESULT_CHARS = 256 * 1024;
function capToolResult(text: string, toolName: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return (
    text.slice(0, MAX_TOOL_RESULT_CHARS) +
    `\n\n[Truncated: ${toolName} returned ${text.length} chars, only first ${MAX_TOOL_RESULT_CHARS} kept. Ask for a more specific query or read in chunks.]`
  );
}

interface ModelRouting {
  model: string;
  gateway: string;
  format: "chat" | "responses";
}

// Resolve which model id / gateway / API format a chat request should use.
// `sel` is a model picker value: either a discovered model id or
// "custom:<modelId>" for user-configured endpoints. When tools are attached
// and the model also supports the Responses API, promote to Responses — this
// works around GPT-5.5's server-side reasoning_effort injection that
// conflicts with tools in mlflow/v1/chat/completions.
function resolveModelRouting(sel: string, hasTools: boolean): ModelRouting {
  let gateway = getGatewayUrl() || "";
  let model = sel;
  let format: "chat" | "responses" | null = null;

  if (sel.startsWith("custom:")) {
    model = sel.replace("custom:", "");
    const ep = mason.customEndpoints.find((e) => e.modelId === model);
    if (ep) {
      if (ep.gatewayUrl) gateway = ep.gatewayUrl;
      format = ep.format || null;
    }
  } else {
    for (const g of mason.discoveredModels) {
      const m = g.models.find((x) => x.value === sel);
      if (m) {
        format = m.format || null;
        const supportsResponses = m.apiTypes && m.apiTypes.includes("openai/v1/responses");
        if (hasTools && supportsResponses) {
          format = "responses";
        }
        break;
      }
    }
  }

  return { model, gateway, format: format || "chat" };
}

interface ToolExecResult {
  ok: boolean;
  content: string; // goes into the role:"tool" message (already capped)
  preview: string; // short human-readable line for UI
}

// Execute one tool call, headlessly. Covers every dispatch path except
// ask_user (UI-bound; callers handle it themselves). Never throws — errors
// come back as { ok: false } with an "Error: …" content the model can read.
async function executeToolCore(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolExecResult> {
  try {
    if (toolName === "load_skill") {
      const slug = String(args.slug || "");
      if (!slug) throw new Error("slug is required");
      const skill = (await window.api.skillsLoad(slug)) as
        | { slug: string; name: string; description: string; body: string }
        | null;
      if (!skill) {
        return {
          ok: false,
          content: `Error: skill "${slug}" not found.`,
          preview: `skill "${slug}" not found`,
        };
      }
      const content = `# ${skill.name}\n\n${skill.body}`;
      return {
        ok: true,
        content: capToolResult(content, toolName),
        preview: `Loaded skill: ${slug}`,
      };
    }

    if (BUILTIN_TOOL_NAMES.has(toolName)) {
      const toolResult = (await window.api.builtinToolCall({ toolName, args })) as any;
      const resultText = capToolResult(JSON.stringify(toolResult), toolName);
      const preview =
        toolResult?.message ||
        (typeof toolResult?.content === "string" && toolResult.content.slice(0, 200)) ||
        resultText;
      return { ok: true, content: resultText, preview: String(preview) };
    }

    const server = findMcpServerForTool(toolName);
    if (!server) {
      return {
        ok: false,
        content: "Error: no MCP server found for this tool",
        preview: "no MCP server found for this tool",
      };
    }

    let toolResult: any;
    if (server.type === "stdio") {
      toolResult = await window.api.mcpStdioCallTool({ key: server.key!, toolName, args });
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
    return {
      ok: true,
      content: resultText,
      preview: resultText.slice(0, 200) + (resultText.length > 200 ? "..." : ""),
    };
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, content: `Error: ${msg}`, preview: msg };
  }
}
