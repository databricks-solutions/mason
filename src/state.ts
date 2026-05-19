// Shared application state. Loaded as the first renderer script so every
// other module sees `window.mason` (and the bare `mason` global) ready.
window.mason = {
  // Auth & profiles
  profiles: [],

  // Chat
  history: [],
  currentChatId: null,
  generating: false,
  chatAborted: false,
  attachedFiles: [],

  // MCP servers
  mcpServers: [],
  disabledTools: new Set<string>(),

  // Models
  discoveredModels: [],
  selectedModelValue: "databricks-claude-sonnet-4",
  selectedModelLabel: "Claude Sonnet 4",
  customEndpoints: [],

  // Workspace
  autoLoadTools: true,

  // Global preferences (loaded from ~/.mason/config/settings.json on startup)
  settings: { darkMode: false, systemPrompt: "", autoLoadTools: true },
  systemPrompt: "",

  // UI
  currentView: "chat",
  dashboardsList: [],
  autoConnectDone: false,

  // Skills
  skills: [],
  disabledSkills: new Set<string>(),
  autoLoadSkills: true,

  // DOM refs (populated on init)
  el: {},
};
