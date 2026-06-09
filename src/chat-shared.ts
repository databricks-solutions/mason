// Shared chat-handler helpers used by both src/main.ts (Electron main process)
// and scripts/test-models.js (CLI regression sweep). Kept dependency-free so the
// compiled build/ts/chat-shared.js can be required from a plain Node script
// without dragging Electron in.

// Flatten a content field that might be a string, null, or an array of parts
// (Gemini, some Anthropic responses, etc. return `content: [{type:"text", text:"..."}]`).
// Without this, the renderer feeds an array to marked() and gets a confusing
// "input parameter is of type [object Array], string expected" error.
export function flattenContent(c: any): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        if (p == null) return "";
        if (typeof p.text === "string") return p.text;
        if (typeof p.content === "string") return p.content;
        return "";
      })
      .join("");
  }
  return String(c);
}

// Anthropic prompt-caching helper. Sets cache_control: {type: "ephemeral"}
// breakpoints on the heaviest static portions of the prompt (tools + last
// system message) so repeated turns within a 5-minute window read at ~10% of
// the input cost. No-op for non-Claude models.
export function applyAnthropicCaching(body: any, model: string): void {
  if (typeof model !== "string") return;
  if (!model.toLowerCase().includes("claude")) return;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const lastIdx = body.tools.length - 1;
    body.tools[lastIdx] = {
      ...body.tools[lastIdx],
      cache_control: { type: "ephemeral" },
    };
  }

  if (Array.isArray(body.messages)) {
    let lastSystemIdx = -1;
    for (let i = 0; i < body.messages.length; i++) {
      if (body.messages[i]?.role === "system") lastSystemIdx = i;
    }
    if (lastSystemIdx >= 0) {
      body.messages[lastSystemIdx] = {
        ...body.messages[lastSystemIdx],
        cache_control: { type: "ephemeral" },
      };
    }
  }
}

// Per-family max_tokens cap. The 16K default was chosen for Opus extended
// thinking; Llama caps at 8192 and Qwen 3 next caps at 10000, so we'd 400
// those models with "max_tokens cannot exceed N". Conservative default,
// bump only for Claude where we actually need the headroom.
export function maxTokensFor(model: string): number {
  if (typeof model !== "string") return 8192;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 16384;
  if (m.includes("qwen3-next") || m.includes("qwen3-80b")) return 10000;
  return 8192;
}

// stream_options.include_usage is supported by Anthropic and OpenAI-family
// models on the Databricks Gateway. Qwen / Llama / gpt-oss (Databricks' open-
// weights GPT proxy) 400 with "unknown field"; for those we skip it (we'd
// just lose the usage log line for non-Claude turns, which already don't
// carry cache_read anyway).
export function supportsStreamOptions(model: string): boolean {
  if (typeof model !== "string") return false;
  const m = model.toLowerCase();
  // gpt-oss-* matches the "gpt" substring but the upstream rejects the flag.
  if (m.includes("gpt-oss")) return false;
  return (
    m.includes("claude") ||
    m.includes("gpt") ||
    m.includes("codex") ||
    /\bo[1-9]\b/.test(m)
  );
}

// Some providers (Gemini) reject multiple system messages. Mason builds up to
// three (skills manifest + user systemPrompt + tool-aware nudge). Collapse to
// one combined system message immediately before send. cache_control on "the
// last system message" (see applyAnthropicCaching) still works — it's now the
// only one.
export function consolidateSystemMessages(messages: any[]): any[] {
  const systems: string[] = [];
  const rest: any[] = [];
  for (const m of messages) {
    if (m?.role === "system") {
      const content = typeof m.content === "string" ? m.content : flattenContent(m.content);
      if (content) systems.push(content);
    } else {
      rest.push(m);
    }
  }
  if (systems.length === 0) return rest;
  return [{ role: "system", content: systems.join("\n\n") }, ...rest];
}
