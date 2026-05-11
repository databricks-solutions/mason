// Tool definitions and filtering.

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
  _mcpServerUrl?: string;
  _source?: string;
}

const BUILTIN_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file on the user's local machine. Creates directories if needed.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to write the file to" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read content from a file on the user's local machine. Returns at most 256 KB per call. For larger files, use offset to read in chunks — the response will tell you the total size and where to read next.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute path to the file to read" },
          offset: { type: "integer", description: "Character offset to start reading from (default 0)" },
          length: { type: "integer", description: "Maximum characters to return (default and max 262144)" },
        },
        required: ["file_path"],
      },
    },
  },
];
const BUILTIN_TOOL_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.function.name));

function getAllToolDefs(): ToolDef[] {
  const tools: ToolDef[] = BUILTIN_TOOLS.filter(
    (t) => !mason.disabledTools.has(t.function.name)
  );
  for (const server of mason.mcpServers) {
    const serverTools = (server.tools || []) as McpToolDescriptor[];
    for (const tool of serverTools) {
      if (mason.disabledTools.has(tool.name)) continue;
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
        _mcpServerUrl: server.url,
      });
    }
  }
  return tools;
}

function getAllToolDefsUnfiltered(): ToolDef[] {
  const tools: ToolDef[] = [...BUILTIN_TOOLS.map((t) => ({ ...t, _source: "built-in" }))];
  for (const server of mason.mcpServers) {
    const info = (server.serverInfo as { name?: string } | undefined) || {};
    const serverName =
      info.name || server.configName || (server.type === "stdio" ? "Local" : "Remote");
    const serverTools = (server.tools || []) as McpToolDescriptor[];
    for (const tool of serverTools) {
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.inputSchema || { type: "object", properties: {} },
        },
        _source: serverName,
      });
    }
  }
  return tools;
}

function findMcpServerForTool(toolName: string): MasonMcpServer | null {
  for (const s of mason.mcpServers) {
    const serverTools = (s.tools || []) as McpToolDescriptor[];
    if (serverTools.some((t) => t.name === toolName)) return s;
  }
  return null;
}

function maybeDisableTools(tools: McpToolDescriptor[]): void {
  if (!mason.autoLoadTools) {
    for (const t of tools) mason.disabledTools.add(t.name);
  }
}
