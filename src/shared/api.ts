// Typed contract for the IPC bridge exposed on `window.api`.
//
// Both preload.ts and (eventually) main.ts import from this file. The
// renderer side gets ambient typing via `types/window.d.ts`. Many payloads
// are still `unknown` because the underlying shapes are complex unions
// (chat messages, MCP JSON-RPC, etc.) — we'll tighten those as renderer
// modules get ported to TypeScript.

export interface Profile {
  name: string;
  host?: string;
  authType?: string;
}

export interface AppVersion {
  version: string;
}

export interface UpdateInfo {
  available: boolean;
  current: string;
  latest?: string;
  url?: string;
  notes?: string;
}

export interface OAuthLoginResult {
  success: boolean;
  error?: string;
}

export interface ApplyUpdateResult {
  ok: boolean;
  logFile?: string;
  error?: string;
}

export interface CliInstallProgress {
  stage: string;
  message?: string;
  percent?: number;
}

export interface DevkitInstallProgress {
  stage: string;
  message?: string;
}

export interface HistoryEntry {
  id: string;
  title?: string;
  model?: unknown;
  ts?: number;
}

export interface HistorySaveParams {
  id: string;
  title?: string;
  model?: unknown;
  messages: unknown[];
}

export interface AddProfileParams {
  name: string;
  host: string;
}

export interface WorkspaceSaveParams {
  profile: string;
  config: unknown;
}

export interface McpConfigSaveParams {
  profile: string;
  servers: unknown[];
}

export interface EndpointsSaveParams {
  profile: string;
  endpoints: unknown[];
}

export interface McpGlobalConfigSaveParams {
  stdio?: unknown[];
  http?: string[];
}

export interface ChatParams {
  token: string;
  model: string;
  messages: unknown[];
  tools?: unknown[];
  gateway: string;
  format: "chat" | "responses";
  stream?: boolean;
}

export interface ChatResult {
  ok: boolean;
  content?: string;
  toolCalls?: unknown[];
  raw?: unknown;
  error?: string;
}

export interface ChatChunk {
  delta?: string;
  done?: boolean;
  error?: string;
}

export interface BuiltinToolCallParams {
  toolName: string;
  args: Record<string, unknown>;
}

export interface McpConnectParams {
  serverUrl: string;
  token: string;
}

export interface McpListToolsParams {
  serverUrl: string;
}

export interface McpCallToolParams {
  serverUrl: string;
  token: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface McpStdioConnectParams {
  config: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

export interface McpStdioCallToolParams {
  key: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface McpReadConfigParams {
  filePath: string;
}

export interface DiscoverModelsParams {
  host: string;
  gatewayUrl?: string;
  token: string;
}

export interface ListDashboardsParams {
  host: string;
  token: string;
}

export interface ListUcConnectionsParams {
  host: string;
  token: string;
}

export interface OpenAuthWindowParams {
  url: string;
  title?: string;
}

export interface ReadFileForUploadParams {
  filePath: string;
}

export interface InstallDevkitParams {
  profile?: string;
}

export type SkillSource = "user" | "ai-dev-kit";

export interface MasonSkillSummary {
  name: string;
  description: string;
  source: SkillSource;
  slug: string;
  path: string;
}

export interface MasonSkillSaveParams {
  name: string;
  description: string;
  body: string;
  // If slug is provided it identifies the existing skill being updated.
  // Otherwise a slug is derived from name.
  slug?: string;
}

export interface MasonSkillsConfig {
  disabledSkills: string[];
  autoLoadSkills: boolean;
}

export interface MasonApi {
  // Streaming chat chunk listener
  onChatChunk(callback: (chunk: ChatChunk) => void): void;
  removeChatChunkListeners(): void;

  // Profiles + auth
  getProfiles(): Promise<Profile[]>;
  getOAuthToken(profile: string): Promise<string>;
  clearTokenCache(profile?: string): Promise<void>;
  getToken(profile: string): Promise<string>;
  oauthLogin(profile: string): Promise<OAuthLoginResult>;
  addProfile(params: AddProfileParams): Promise<{ ok: boolean; error?: string }>;
  removeProfile(name: string): Promise<{ ok: boolean; error?: string }>;

  // Chat
  chat(params: ChatParams): Promise<ChatResult>;
  abortChat(): Promise<void>;

  // History
  historyList(): Promise<HistoryEntry[]>;
  historyLoad(id: string): Promise<{ id: string; title?: string; model?: unknown; messages: unknown[] } | null>;
  historySave(data: HistorySaveParams): Promise<{ ok: boolean }>;
  historyDelete(id: string): Promise<{ ok: boolean }>;

  // Built-in tools
  builtinToolCall(params: BuiltinToolCallParams): Promise<unknown>;

  // Remote MCP
  mcpConnect(params: McpConnectParams): Promise<unknown>;
  mcpListTools(params: McpListToolsParams): Promise<unknown>;
  mcpCallTool(params: McpCallToolParams): Promise<unknown>;

  // Local stdio MCP
  mcpReadConfig(params: McpReadConfigParams): Promise<unknown>;
  mcpStdioConnect(params: McpStdioConnectParams): Promise<unknown>;
  mcpStdioCallTool(params: McpStdioCallToolParams): Promise<unknown>;
  mcpStdioDisconnect(params: { key: string }): Promise<unknown>;
  mcpStdioRebindProfile(params: { profile: string }): Promise<{ rebound?: string[] }>;

  // MCP config
  mcpConfigLoad(profile: string): Promise<unknown>;
  mcpGlobalConfigLoad(): Promise<unknown>;
  mcpGlobalConfigSave(data: McpGlobalConfigSaveParams): Promise<{ ok: boolean }>;
  mcpConfigSave(data: McpConfigSaveParams): Promise<{ ok: boolean }>;

  // Workspace + endpoints
  endpointsLoad(profile: string): Promise<unknown>;
  endpointsSave(data: EndpointsSaveParams): Promise<{ ok: boolean }>;
  workspaceLoad(profile: string): Promise<unknown>;
  workspaceSave(data: WorkspaceSaveParams): Promise<{ ok: boolean }>;

  // Discovery
  discoverModels(params: DiscoverModelsParams): Promise<unknown>;
  listDashboards(params: ListDashboardsParams): Promise<unknown>;
  onDashboardsUpdated(callback: (dashboards: unknown) => void): void;
  listUcConnections(params: ListUcConnectionsParams): Promise<unknown>;
  openAuthWindow(params: OpenAuthWindowParams): Promise<unknown>;

  // File system
  showOpenDialog(options: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
  readFileForUpload(params: ReadFileForUploadParams): Promise<unknown>;

  // App + updates
  getAppVersion(): Promise<string>;
  setTitleBarOverlay(isDark: boolean): Promise<void>;
  checkUpdate(): Promise<UpdateInfo>;
  openReleasePage(url: string): Promise<void>;
  applyUpdate(): Promise<ApplyUpdateResult>;

  // CLI
  detectCli(): Promise<{ found: boolean; path?: string; version?: string }>;
  installCli(): Promise<{ ok: boolean; error?: string }>;
  onCliInstallProgress(callback: (payload: CliInstallProgress) => void): void;
  removeCliInstallListeners(): void;

  // Settings
  settingsLoad(): Promise<{ darkMode?: boolean; systemPrompt?: string; autoLoadTools?: boolean }>;
  settingsSave(partial: { darkMode?: boolean; systemPrompt?: string; autoLoadTools?: boolean }): Promise<{ ok: boolean }>;

  // Devkit
  detectDevkit(): Promise<{ installed: boolean; version?: string }>;
  installDevkit(params?: InstallDevkitParams): Promise<{ ok: boolean; error?: string }>;
  uninstallDevkit(): Promise<{ ok: boolean; error?: string }>;
  onDevkitInstallProgress(callback: (payload: DevkitInstallProgress) => void): void;
  removeDevkitInstallListeners(): void;

  // Skills
  skillsList(): Promise<MasonSkillSummary[]>;
  skillsLoad(slug: string): Promise<{ slug: string; name: string; description: string; body: string } | null>;
  skillsSave(params: MasonSkillSaveParams): Promise<MasonSkillSummary>;
  skillsDelete(slug: string): Promise<{ ok: boolean }>;
  skillsConfigLoad(): Promise<MasonSkillsConfig>;
  skillsConfigSave(partial: Partial<MasonSkillsConfig>): Promise<MasonSkillsConfig>;
}
