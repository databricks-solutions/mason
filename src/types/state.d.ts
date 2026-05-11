// Ambient types for the shared `window.mason` state object.
//
// Renderer modules are loaded as plain <script> tags (no bundler), so they
// access `mason` / `window.mason` as a global. This file declares the
// shape so TS-ported modules see proper types instead of `any`.

interface MasonModelDescriptor {
  value: string;
  label: string;
  format?: "chat" | "responses";
  apiTypes?: string[];
}

interface MasonAttachedFile {
  name: string;
  ext?: string;
  size?: number;
  content?: string;
}

interface MasonMcpServer {
  type: "http" | "stdio";
  url?: string;
  key?: string;
  configName?: string;
  config?: unknown;
  serverInfo?: unknown;
  tools?: unknown[];
}

interface MasonSettings {
  darkMode: boolean;
  systemPrompt: string;
  autoLoadTools: boolean;
}

interface MasonState {
  profiles: unknown[];

  history: unknown[];
  currentChatId: string | null;
  generating: boolean;
  chatAborted: boolean;
  attachedFiles: MasonAttachedFile[];

  mcpServers: MasonMcpServer[];
  disabledTools: Set<string>;

  discoveredModels: MasonModelDescriptor[];
  selectedModelValue: string;
  selectedModelLabel: string;
  customEndpoints: unknown[];

  autoLoadTools: boolean;

  settings: MasonSettings;
  systemPrompt: string;

  currentView: "chat" | "dashboards" | "dashboard-detail";
  dashboardsList: unknown[];
  autoConnectDone: boolean;

  el: Record<string, HTMLElement | null>;
}

declare global {
  interface Window {
    mason: MasonState;
  }
  // Available as a bare global since the file is loaded via <script>
  var mason: MasonState;
}

export {};
