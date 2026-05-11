// MCP server management (HTTP + stdio).

declare function currentProfileName(): string;
declare function getAuthToken(): Promise<string>;
declare function getSelectedProfile():
  | { name: string; host?: string }
  | undefined;
declare function escapeHtml(s: string): string;
declare function maybeDisableTools(
  tools: Array<{ name: string }>
): void;
declare function loadProfiles(): Promise<void>;

interface McpHttpConnectResult {
  serverInfo: { name?: string };
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
}

interface McpStdioConnectResult extends McpHttpConnectResult {
  key: string;
}

interface UcConnection {
  name: string;
  comment?: string;
  directHost?: string;
}

interface WorkspaceConfig {
  mcpServers?: string[];
  stdioServers?: Array<{ name: string; config: MasonMcpStdioConfig }>;
  [k: string]: unknown;
}

interface McpGlobalConfig {
  stdio?: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabledByDefault?: boolean;
  }>;
}

async function connectMcpServer(url: string): Promise<void> {
  console.log(`[MCP UI] Connecting to ${url}...`);
  const token = await getAuthToken();
  const result = (await window.api.mcpConnect({ serverUrl: url, token })) as McpHttpConnectResult;
  const ucMatch = url.match(/\/api\/2\.0\/mcp\/external\/([^/?#]+)/);
  const displayName = ucMatch ? decodeURIComponent(ucMatch[1]) : null;
  console.log(
    `[MCP UI] Connected: ${displayName || result.serverInfo.name || url}, ${result.tools.length} tools`
  );
  mason.mcpServers.push({
    type: "http",
    url,
    displayName,
    serverInfo: result.serverInfo,
    tools: result.tools,
  });
  maybeDisableTools(result.tools);
  renderMcpBadges();
  await saveMcpHttp();
}

async function saveMcpHttp(): Promise<void> {
  const httpUrls = mason.mcpServers
    .filter((s) => s.type !== "stdio")
    .map((s) => s.url!)
    .filter(Boolean);
  const profile = currentProfileName();
  const config = ((await window.api.workspaceLoad(profile)) || {}) as WorkspaceConfig;
  config.mcpServers = httpUrls;
  delete config.stdioServers;
  await window.api.workspaceSave({ profile, config });
}

async function saveMcpStdio(): Promise<void> {
  const stdioConfigs = mason.mcpServers
    .filter((s) => s.type === "stdio")
    .map((s) => ({
      name: s.configName!,
      command: s.config?.command || "",
      args: s.config?.args || [],
      env: s.config?.env || {},
    }));
  await window.api.mcpGlobalConfigSave({ stdio: stdioConfigs });
}

async function saveMcpConfig(): Promise<void> {
  await saveMcpHttp();
  await saveMcpStdio();
}

function mcpServerDisplayName(s: MasonMcpServer): string {
  const isStdio = s.type === "stdio";
  if (s.displayName) return s.displayName;
  if (s.serverInfo?.name) return s.serverInfo.name;
  if (s.configName) return s.configName;
  if (isStdio) return "Local";
  if (s.url) {
    try {
      return new URL(s.url).hostname;
    } catch (_) {
      return s.url;
    }
  }
  return "Remote";
}

function renderMcpServerList(): void {
  const listEl = mason.el.mcpServerList as HTMLElement | null;
  if (!listEl) return;
  listEl.innerHTML = "";
  for (let i = 0; i < mason.mcpServers.length; i++) {
    const s = mason.mcpServers[i];
    const isStdio = s.type === "stdio";
    const name = mcpServerDisplayName(s);
    const typeLabel = isStdio ? "stdio" : "remote";
    const div = document.createElement("div");
    div.className = "mcp-server-item";
    div.innerHTML = `
      <div class="mcp-server-item-info">
        <span class="mcp-server-item-dot" style="background:${isStdio ? "#2196f3" : "#4caf50"};"></span>
        <span class="mcp-server-item-name">${escapeHtml(name)}</span>
        <span class="mcp-server-item-tools">${s.tools?.length || 0} tools &middot; ${typeLabel}</span>
      </div>
      <button class="mcp-server-remove" data-idx="${i}">&times;</button>
    `;
    div.querySelector(".mcp-server-remove")!.addEventListener("click", async () => {
      const removed = mason.mcpServers.splice(i, 1)[0];
      if (removed.type === "stdio" && removed.key) {
        try {
          await window.api.mcpStdioDisconnect({ key: removed.key });
        } catch (_) {}
      }
      renderMcpServerList();
      renderMcpBadges();
      if (cachedUcConnections.length > 0) renderUcMcpList(cachedUcConnections);
      await saveMcpConfig();
    });
    listEl.appendChild(div);
  }
}

function renderMcpBadges(): void {
  const badgesEl = mason.el.mcpBadges as HTMLElement | null;
  if (!badgesEl) return;
  badgesEl.innerHTML = "";
  if (mason.mcpServers.length === 0) return;

  if (mason.mcpServers.length === 1) {
    const s = mason.mcpServers[0];
    const isStdio = s.type === "stdio";
    const name = mcpServerDisplayName(s);
    const badge = document.createElement("span");
    badge.className = "mcp-badge";
    badge.innerHTML = `<span class="mcp-badge-dot" style="background:${isStdio ? "#2196f3" : "#4caf50"};"></span>${escapeHtml(name)}`;
    badgesEl.appendChild(badge);
    return;
  }

  const names = mason.mcpServers.map((s) => mcpServerDisplayName(s));
  const badge = document.createElement("span");
  badge.className = "mcp-badge mcp-badge-summary";
  badge.innerHTML = `<span class="mcp-badge-dot"></span>${mason.mcpServers.length} MCP connections`;
  badge.title = names.join("\n");
  badgesEl.appendChild(badge);
}

// --- Unity Catalog external MCP discovery ---

let cachedUcConnections: UcConnection[] = [];

async function discoverUcMcp(): Promise<UcConnection[]> {
  const profile = getSelectedProfile();
  if (!profile || !profile.host) return [];
  try {
    const token = await getAuthToken();
    const connections = (await window.api.listUcConnections({
      host: profile.host,
      token,
    })) as UcConnection[];
    cachedUcConnections = connections;
    return connections;
  } catch (e) {
    console.error("[MCP UI] UC discovery failed:", (e as Error).message);
    return [];
  }
}

function renderUcMcpList(connections: UcConnection[], filter: string = ""): void {
  const list = mason.el.ucMcpList as HTMLElement | null;
  if (!list) return;
  list.innerHTML = "";

  if (connections.length === 0) {
    list.innerHTML =
      '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">No external MCP connections found.</div>';
    return;
  }

  const profile = getSelectedProfile();
  const host = profile?.host || "";
  const query = filter.toLowerCase();

  const filtered = connections.filter((conn) => {
    if (!query) return true;
    return (
      conn.name.toLowerCase().includes(query) ||
      (conn.comment || "").toLowerCase().includes(query)
    );
  });

  const mcpUrlFor = (conn: UcConnection): string => {
    if (conn.directHost) return `${conn.directHost.replace(/\/+$/, "")}/mcp`;
    return `${host}/api/2.0/mcp/external/${encodeURIComponent(conn.name)}`;
  };

  const sorted = filtered.sort((a, b) => {
    const aConn = mason.mcpServers.some((s) => s.url === mcpUrlFor(a));
    const bConn = mason.mcpServers.some((s) => s.url === mcpUrlFor(b));
    if (aConn !== bConn) return aConn ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const MAX_VISIBLE = 20;
  const visible = sorted.slice(0, MAX_VISIBLE);

  for (const conn of visible) {
    const mcpUrl = mcpUrlFor(conn);
    const isConnected = mason.mcpServers.some((s) => s.url === mcpUrl);

    const div = document.createElement("div");
    div.className = "mcp-server-item";
    div.innerHTML = `
      <div class="mcp-server-item-info">
        <span class="mcp-server-item-dot" style="background:${isConnected ? "#4caf50" : "#999"};"></span>
        <span class="mcp-server-item-name">${escapeHtml(conn.name)}</span>
        <span class="mcp-server-item-tools">${escapeHtml(conn.comment || "UC connection")}</span>
      </div>
      <button class="modal-btn ${isConnected ? "secondary" : "primary"}" style="padding:4px 12px;font-size:0.78rem;">
        ${isConnected ? "Connected" : "Connect"}
      </button>
    `;

    if (!isConnected) {
      const btn = div.querySelector("button") as HTMLButtonElement;
      btn.addEventListener("click", async () => {
        btn.textContent = "Connecting...";
        btn.disabled = true;
        try {
          await connectMcpServer(mcpUrl);
          renderMcpServerList();
          const searchEl = mason.el.ucMcpSearch as HTMLInputElement | null;
          renderUcMcpList(cachedUcConnections, searchEl?.value || "");
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized")) {
            btn.textContent = "Authorize...";
            const profile = getSelectedProfile();
            if (profile?.host) {
              const authUrl = `${profile.host.replace(/\/+$/, "")}/explore/connections/${encodeURIComponent(conn.name)}`;
              await window.api.openAuthWindow({ url: authUrl, title: `Authorize ${conn.name}` });
            }
            btn.textContent = "Connecting...";
            try {
              await connectMcpServer(mcpUrl);
              renderMcpServerList();
              const searchEl = mason.el.ucMcpSearch as HTMLInputElement | null;
              renderUcMcpList(cachedUcConnections, searchEl?.value || "");
            } catch (retryErr) {
              alert(`Still failed after authorization: ${(retryErr as Error).message}`);
              btn.textContent = "Connect";
              btn.disabled = false;
            }
          } else {
            alert(`Failed to connect "${conn.name}": ${msg}`);
            btn.textContent = "Connect";
            btn.disabled = false;
          }
        }
      });
    }

    list.appendChild(div);
  }

  if (sorted.length > MAX_VISIBLE) {
    const more = document.createElement("div");
    more.style.cssText = "opacity:0.5;font-size:0.78rem;padding:6px 0;text-align:center;";
    more.textContent = `Showing ${MAX_VISIBLE} of ${sorted.length} connections — use search to filter`;
    list.appendChild(more);
  } else if (filtered.length === 0 && query) {
    list.innerHTML =
      '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">No matching connections.</div>';
  }
}

async function refreshUcMcp(): Promise<void> {
  const list = mason.el.ucMcpList as HTMLElement | null;
  if (!list) return;
  list.innerHTML =
    '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">Discovering...</div>';
  const refreshBtn = mason.el.ucMcpRefresh as HTMLButtonElement | null;
  if (refreshBtn) refreshBtn.disabled = true;
  try {
    const connections = await discoverUcMcp();
    renderUcMcpList(connections);
  } catch (_) {
    list.innerHTML =
      '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">Discovery failed.</div>';
  }
  if (refreshBtn) refreshBtn.disabled = false;
}

function clearUcMcpCache(): void {
  cachedUcConnections = [];
}

// --- Auto-connect ---

async function autoConnectMcp(): Promise<void> {
  if (mason.autoConnectDone) return;
  mason.autoConnectDone = true;

  const profile = currentProfileName();
  const wsConfig = ((await window.api.workspaceLoad(profile)) || {}) as WorkspaceConfig;
  const globalConfig = ((await window.api.mcpGlobalConfigLoad()) || {}) as McpGlobalConfig;

  await loadProfiles();
  if (!getSelectedProfile()) {
    console.log("[MCP UI] No profile available, skipping auto-connect");
    mason.autoConnectDone = false;
    return;
  }

  // Migrate: move any per-workspace stdio entries to global config
  if ((wsConfig.stdioServers || []).length > 0) {
    const existingGlobal = (globalConfig.stdio || []).map(
      (s) => `${s.command}:${(s.args || []).join(":")}`
    );
    for (const { name, config: srvConfig } of wsConfig.stdioServers!) {
      const key = `${srvConfig.command}:${(srvConfig.args || []).join(":")}`;
      if (!existingGlobal.includes(key)) {
        globalConfig.stdio = globalConfig.stdio || [];
        globalConfig.stdio.push({
          name,
          command: srvConfig.command,
          args: srvConfig.args || [],
          env: srvConfig.env || {},
        });
      }
    }
    await window.api.mcpGlobalConfigSave({ stdio: globalConfig.stdio || [] });
    delete wsConfig.stdioServers;
    await window.api.workspaceSave({ profile, config: wsConfig });
    console.log("[MCP UI] Migrated per-workspace stdio servers to global config");
  }

  for (const url of wsConfig.mcpServers || []) {
    if (mason.mcpServers.some((s) => s.url === url)) continue;
    try {
      await connectMcpServer(url);
      console.log(`[MCP UI] Auto-connected HTTP: ${url}`);
    } catch (e) {
      const msg = (e as Error).message;
      const ucMatch = url.match(/^(https:\/\/[^/]+)\/api\/2\.0\/mcp\/external\/([^/?#]+)/);
      const isAuthError = msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized");
      if (ucMatch && isAuthError) {
        const [, host, name] = ucMatch;
        const decoded = decodeURIComponent(name);
        console.log(
          `[MCP UI] Auto-connect 401 for UC connection "${decoded}" — opening authorize window`
        );
        try {
          const authUrl = `${host}/explore/connections/${encodeURIComponent(decoded)}`;
          await window.api.openAuthWindow({ url: authUrl, title: `Authorize ${decoded}` });
          await connectMcpServer(url);
          console.log(`[MCP UI] Auto-connected after authorize: ${url}`);
          continue;
        } catch (retryErr) {
          console.error(
            `[MCP UI] Auto-connect still failed after authorize for ${url}:`,
            (retryErr as Error).message
          );
        }
      } else {
        console.error(`[MCP UI] Auto-connect failed for ${url}:`, msg);
      }
    }
  }

  for (const srv of globalConfig.stdio || []) {
    const srvConfig: MasonMcpStdioConfig = {
      command: srv.command,
      args: srv.args || [],
      env: srv.env || {},
    };
    const key = `stdio:${srvConfig.command}:${(srvConfig.args || []).join(":")}`;
    if (mason.mcpServers.some((s) => s.key === key)) continue;
    try {
      const result = (await window.api.mcpStdioConnect({
        config: { name: srv.name, ...srvConfig },
      })) as McpStdioConnectResult;
      mason.mcpServers.push({
        type: "stdio",
        key: result.key,
        config: srvConfig,
        configName: srv.name,
        serverInfo: result.serverInfo,
        tools: result.tools,
      });
      const shouldDisable = !mason.autoLoadTools || srv.enabledByDefault === false;
      if (shouldDisable) {
        for (const tool of result.tools) mason.disabledTools.add(tool.name);
      }
      console.log(
        `[MCP UI] Auto-connected global stdio: ${srv.name} (${result.tools.length} tools, enabled=${!shouldDisable})`
      );
    } catch (e) {
      console.error(
        `[MCP UI] Auto-connect global stdio failed for ${srv.name}:`,
        (e as Error).message
      );
    }
  }

  renderMcpServerList();
  renderMcpBadges();
}
