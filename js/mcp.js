// MCP server management (HTTP + stdio)

async function connectMcpServer(url) {
  console.log(`[MCP UI] Connecting to ${url}...`);
  const token = await getAuthToken();
  const result = await window.api.mcpConnect({ serverUrl: url, token });
  // Extract friendly name from UC MCP URL pattern: /api/2.0/mcp/external/{name}
  const ucMatch = url.match(/\/api\/2\.0\/mcp\/external\/([^/?#]+)/);
  const displayName = ucMatch ? decodeURIComponent(ucMatch[1]) : null;
  console.log(`[MCP UI] Connected: ${displayName || result.serverInfo.name || url}, ${result.tools.length} tools`);
  mason.mcpServers.push({ type: "http", url, displayName, serverInfo: result.serverInfo, tools: result.tools });
  maybeDisableTools(result.tools);
  renderMcpBadges();
  await saveMcpHttp();
}

// Two save paths so each persists only the transport it owns. Previously a
// single saveMcpConfig() rebuilt BOTH lists from runtime state — meaning an
// HTTP add could clobber a stdio entry that lived on disk but hadn't yet been
// auto-connected (e.g. ai-dev-kit registered via Settings install).

async function saveMcpHttp() {
  const httpUrls = mason.mcpServers.filter((s) => s.type !== "stdio").map((s) => s.url);
  const profile = currentProfileName();
  const config = await window.api.workspaceLoad(profile);
  config.mcpServers = httpUrls;
  delete config.stdioServers;
  await window.api.workspaceSave({ profile, config });
}

async function saveMcpStdio() {
  const stdioConfigs = mason.mcpServers.filter((s) => s.type === "stdio").map((s) => ({
    name: s.configName,
    command: s.config.command,
    args: s.config.args || [],
    env: s.config.env || {},
  }));
  await window.api.mcpGlobalConfigSave({ stdio: stdioConfigs });
}

// Backwards-compatible wrapper: persists both lists. Used by paths that
// genuinely modified both (legacy stdio migration, multi-server load).
async function saveMcpConfig() {
  await saveMcpHttp();
  await saveMcpStdio();
}

function renderMcpServerList() {
  mason.el.mcpServerList.innerHTML = "";
  for (let i = 0; i < mason.mcpServers.length; i++) {
    const s = mason.mcpServers[i];
    const isStdio = s.type === "stdio";
    const name = s.displayName || s.serverInfo.name || s.configName || (isStdio ? "Local" : new URL(s.url).hostname);
    const typeLabel = isStdio ? "stdio" : "remote";
    const div = document.createElement("div");
    div.className = "mcp-server-item";
    div.innerHTML = `
      <div class="mcp-server-item-info">
        <span class="mcp-server-item-dot" style="background:${isStdio ? "#2196f3" : "#4caf50"};"></span>
        <span class="mcp-server-item-name">${escapeHtml(name)}</span>
        <span class="mcp-server-item-tools">${s.tools.length} tools &middot; ${typeLabel}</span>
      </div>
      <button class="mcp-server-remove" data-idx="${i}">&times;</button>
    `;
    div.querySelector(".mcp-server-remove").addEventListener("click", async () => {
      const removed = mason.mcpServers.splice(i, 1)[0];
      if (removed.type === "stdio" && removed.key) {
        try { await window.api.mcpStdioDisconnect({ key: removed.key }); } catch (_) {}
      }
      renderMcpServerList();
      renderMcpBadges();
      if (cachedUcConnections.length > 0) renderUcMcpList(cachedUcConnections);
      await saveMcpConfig();
    });
    mason.el.mcpServerList.appendChild(div);
  }
}

function renderMcpBadges() {
  mason.el.mcpBadges.innerHTML = "";
  if (mason.mcpServers.length === 0) return;

  if (mason.mcpServers.length === 1) {
    const s = mason.mcpServers[0];
    const isStdio = s.type === "stdio";
    const name = s.displayName || s.serverInfo.name || s.configName || (isStdio ? "Local" : new URL(s.url).hostname);
    const badge = document.createElement("span");
    badge.className = "mcp-badge";
    badge.innerHTML = `<span class="mcp-badge-dot" style="background:${isStdio ? "#2196f3" : "#4caf50"};"></span>${escapeHtml(name)}`;
    mason.el.mcpBadges.appendChild(badge);
    return;
  }

  const names = mason.mcpServers.map((s) => {
    const isStdio = s.type === "stdio";
    return s.displayName || s.serverInfo.name || s.configName || (isStdio ? "Local" : new URL(s.url).hostname);
  });
  const badge = document.createElement("span");
  badge.className = "mcp-badge mcp-badge-summary";
  badge.innerHTML = `<span class="mcp-badge-dot"></span>${mason.mcpServers.length} MCP connections`;
  badge.title = names.join("\n");
  mason.el.mcpBadges.appendChild(badge);
}

// --- Unity Catalog external MCP discovery ---

let cachedUcConnections = [];

async function discoverUcMcp() {
  const profile = getSelectedProfile();
  if (!profile) return [];
  try {
    const token = await getAuthToken();
    const connections = await window.api.listUcConnections({ host: profile.host, token });
    cachedUcConnections = connections;
    return connections;
  } catch (e) {
    console.error("[MCP UI] UC discovery failed:", e.message);
    return [];
  }
}

function renderUcMcpList(connections, filter = "") {
  const list = mason.el.ucMcpList;
  list.innerHTML = "";

  if (connections.length === 0) {
    list.innerHTML = '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">No external MCP connections found.</div>';
    return;
  }

  const profile = getSelectedProfile();
  const host = profile ? profile.host : "";
  const query = filter.toLowerCase();

  // Connected ones always show first, then filter by search
  const filtered = connections.filter((conn) => {
    if (!query) return true;
    return conn.name.toLowerCase().includes(query) || (conn.comment || "").toLowerCase().includes(query);
  });

  // Resolve the MCP URL for a UC connection: prefer the connection's own host
  // (e.g. a Databricks App at *.databricksapps.com), fall back to the UC external proxy.
  const mcpUrlFor = (conn) => {
    if (conn.directHost) return `${conn.directHost.replace(/\/+$/, "")}/mcp`;
    return `${host}/api/2.0/mcp/external/${encodeURIComponent(conn.name)}`;
  };

  // Sort: connected first, then alphabetical
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
      const btn = div.querySelector("button");
      btn.addEventListener("click", async () => {
        btn.textContent = "Connecting...";
        btn.disabled = true;
        try {
          await connectMcpServer(mcpUrl);
          renderMcpServerList();
          renderUcMcpList(cachedUcConnections, mason.el.ucMcpSearch.value);
        } catch (e) {
          if (e.message.includes("401") || e.message.includes("403") || e.message.includes("Unauthorized")) {
            btn.textContent = "Authorize...";
            const profile = getSelectedProfile();
            const authUrl = `${profile.host.replace(/\/+$/, "")}/explore/connections/${encodeURIComponent(conn.name)}`;
            await window.api.openAuthWindow({ url: authUrl, title: `Authorize ${conn.name}` });
            // Retry after auth window closes
            btn.textContent = "Connecting...";
            try {
              await connectMcpServer(mcpUrl);
              renderMcpServerList();
              renderUcMcpList(cachedUcConnections, mason.el.ucMcpSearch.value);
            } catch (retryErr) {
              alert(`Still failed after authorization: ${retryErr.message}`);
              btn.textContent = "Connect";
              btn.disabled = false;
            }
          } else {
            alert(`Failed to connect "${conn.name}": ${e.message}`);
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
    list.innerHTML = '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">No matching connections.</div>';
  }
}

async function refreshUcMcp() {
  const list = mason.el.ucMcpList;
  list.innerHTML = '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">Discovering...</div>';
  mason.el.ucMcpRefresh.disabled = true;
  try {
    const connections = await discoverUcMcp();
    renderUcMcpList(connections);
  } catch (_) {
    list.innerHTML = '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">Discovery failed.</div>';
  }
  mason.el.ucMcpRefresh.disabled = false;
}

function clearUcMcpCache() {
  cachedUcConnections = [];
}

// --- Auto-connect ---

async function autoConnectMcp() {
  if (mason.autoConnectDone) return;
  mason.autoConnectDone = true;

  const profile = currentProfileName();
  const wsConfig = await window.api.workspaceLoad(profile);
  const globalConfig = await window.api.mcpGlobalConfigLoad();

  await loadProfiles();
  if (!getSelectedProfile()) {
    console.log("[MCP UI] No profile available, skipping auto-connect");
    mason.autoConnectDone = false;
    return;
  }

  // Migrate: move any per-workspace stdio entries to global config
  if ((wsConfig.stdioServers || []).length > 0) {
    const existingGlobal = (globalConfig.stdio || []).map((s) => `${s.command}:${(s.args || []).join(":")}`);
    for (const { name, config: srvConfig } of wsConfig.stdioServers) {
      const key = `${srvConfig.command}:${(srvConfig.args || []).join(":")}`;
      if (!existingGlobal.includes(key)) {
        globalConfig.stdio = globalConfig.stdio || [];
        globalConfig.stdio.push({ name, command: srvConfig.command, args: srvConfig.args || [], env: srvConfig.env || {} });
      }
    }
    await window.api.mcpGlobalConfigSave({ stdio: globalConfig.stdio || [] });
    delete wsConfig.stdioServers;
    await window.api.workspaceSave({ profile, config: wsConfig });
    console.log("[MCP UI] Migrated per-workspace stdio servers to global config");
  }

  // Workspace HTTP (per-profile only)
  for (const url of (wsConfig.mcpServers || [])) {
    if (mason.mcpServers.some((s) => s.url === url)) continue;
    try {
      await connectMcpServer(url);
      console.log(`[MCP UI] Auto-connected HTTP: ${url}`);
    } catch (e) {
      // UC external MCP needs per-user OAuth on the underlying connection.
      // On 401/403, prompt once to authorize, then retry.
      const ucMatch = url.match(/^(https:\/\/[^/]+)\/api\/2\.0\/mcp\/external\/([^/?#]+)/);
      const isAuthError = e.message.includes("401") || e.message.includes("403") || e.message.includes("Unauthorized");
      if (ucMatch && isAuthError) {
        const [, host, name] = ucMatch;
        const decoded = decodeURIComponent(name);
        console.log(`[MCP UI] Auto-connect 401 for UC connection "${decoded}" — opening authorize window`);
        try {
          const authUrl = `${host}/explore/connections/${encodeURIComponent(decoded)}`;
          await window.api.openAuthWindow({ url: authUrl, title: `Authorize ${decoded}` });
          await connectMcpServer(url);
          console.log(`[MCP UI] Auto-connected after authorize: ${url}`);
          continue;
        } catch (retryErr) {
          console.error(`[MCP UI] Auto-connect still failed after authorize for ${url}:`, retryErr.message);
        }
      } else {
        console.error(`[MCP UI] Auto-connect failed for ${url}:`, e.message);
      }
    }
  }

  // Global stdio (shared across all profiles)
  for (const srv of (globalConfig.stdio || [])) {
    const srvConfig = { command: srv.command, args: srv.args || [], env: srv.env || {} };
    const key = `stdio:${srvConfig.command}:${srvConfig.args.join(":")}`;
    if (mason.mcpServers.some((s) => s.key === key)) continue;
    try {
      const result = await window.api.mcpStdioConnect({ config: srvConfig });
      mason.mcpServers.push({ type: "stdio", key: result.key, config: srvConfig, configName: srv.name, serverInfo: result.serverInfo, tools: result.tools });
      const shouldDisable = !mason.autoLoadTools || srv.enabledByDefault === false;
      if (shouldDisable) {
        for (const tool of result.tools) mason.disabledTools.add(tool.name);
      }
      console.log(`[MCP UI] Auto-connected global stdio: ${srv.name} (${result.tools.length} tools, enabled=${!shouldDisable})`);
    } catch (e) {
      console.error(`[MCP UI] Auto-connect global stdio failed for ${srv.name}:`, e.message);
    }
  }

  renderMcpServerList();
  renderMcpBadges();
}
