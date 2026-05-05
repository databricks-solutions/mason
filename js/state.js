// Shared application state
window.mason = {
  // Auth & profiles
  profiles: [],

  // Chat
  history: [],
  currentChatId: null,
  generating: false,
  chatAborted: false,
  attachedFiles: [], // { name, ext, size, content } — cleared on send



  // MCP servers: { type: "http"|"stdio", url?, key?, config?, serverInfo, tools[] }
  mcpServers: [],
  disabledTools: new Set(),

  // Models
  discoveredModels: [],
  selectedModelValue: "databricks-claude-sonnet-4",
  selectedModelLabel: "Claude Sonnet 4",
  customEndpoints: [],

  // Workspace
  workspaceGatewayUrl: "",
  autoLoadTools: true,

  // UI
  currentView: "chat", // "chat" | "dashboards" | "dashboard-detail"
  dashboardsList: [],
  autoConnectDone: false,

  // DOM refs (populated on init)
  el: {},
};
