// Ambient types for the shared `window.mason` state object.
//
// Renderer modules are loaded as plain <script> tags (no bundler), so they
// access `mason` / `window.mason` as a global. This file is a module with
// a `declare global` block so the interfaces are visible to every other
// renderer TS file without an import.

declare global {
  interface MasonModelDescriptor {
    value: string;
    label: string;
    format?: "chat" | "responses";
    apiTypes?: string[];
  }

  interface MasonModelGroup {
    group: string;
    models: MasonModelDescriptor[];
  }

  interface MasonCustomEndpoint {
    name: string;
    modelId: string;
    gatewayUrl?: string | null;
    format?: "chat" | "responses";
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

    discoveredModels: MasonModelGroup[];
    selectedModelValue: string;
    selectedModelLabel: string;
    customEndpoints: MasonCustomEndpoint[];

    autoLoadTools: boolean;

    settings: MasonSettings;
    systemPrompt: string;

    currentView: "chat" | "dashboards" | "dashboard-detail";
    dashboardsList: unknown[];
    autoConnectDone: boolean;

    defaultModel?: { value: string; label: string } | null;

    el: Record<string, HTMLElement | null>;
  }

  interface Window {
    mason: MasonState;
  }
  // Available as a bare global since the file is loaded via <script>
  var mason: MasonState;
}

export {};
