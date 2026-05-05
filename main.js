const { app, BrowserWindow, ipcMain, nativeImage, dialog, shell } = require("electron");
const { execSync, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

try {
  require("electron-reloader")(module, {
    watchRenderer: true,
    ignore: ["chat_history"],
  });
} catch (_) {}

const MASON_HOME = path.join(os.homedir(), ".mason");
const HISTORY_DIR = path.join(MASON_HOME, "chat_history");
const CONFIG_DIR = path.join(MASON_HOME, "config");
const WORKSPACES_FILE = path.join(CONFIG_DIR, "workspaces.json");
const MCP_SERVERS_FILE = path.join(CONFIG_DIR, "mcp_servers.json");

// Resolve full shell PATH for packaged app (macOS GUI apps don't inherit shell PATH)
function getShellEnv() {
  const userShell = process.env.SHELL || "/bin/zsh";
  try {
    // Use login shell (-l) to source .zshrc/.zprofile/.bash_profile
    const shellPath = execSync(`${userShell} -l -c 'echo $PATH'`, {
      encoding: "utf-8",
      timeout: 5000,
      env: { HOME: os.homedir(), USER: os.userInfo().username },
    }).trim();
    console.log(`[AUTH] Resolved shell PATH: ${shellPath.slice(0, 100)}...`);
    return { ...process.env, PATH: shellPath };
  } catch (err) {
    console.error(`[AUTH] Failed to resolve shell PATH: ${err.message}`);
    // Fallback: add common CLI locations
    const extra = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/homebrew/sbin",
      path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), "bin")].join(":");
    return { ...process.env, PATH: `${process.env.PATH}:${extra}` };
  }
}
const shellEnv = getShellEnv();

// Ensure ~/.mason directories exist on startup. Config files are created
// lazily on first save by saveWorkspaces / saveMcpServers / etc.
if (!fs.existsSync(MASON_HOME)) fs.mkdirSync(MASON_HOME);
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);

// Fetch with timeout
let activeChatController = null;

function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function chatFetch(url, options = {}, timeoutMs = 120000) {
  activeChatController = new AbortController();
  const timer = setTimeout(() => activeChatController.abort(), timeoutMs);
  return fetch(url, { ...options, signal: activeChatController.signal }).finally(() => {
    clearTimeout(timer);
    activeChatController = null;
  });
}

// Sanitize sensitive data from log output
function sanitizeLog(str) {
  return str
    .replace(/Bearer [^\s"]+/g, "Bearer ****")
    .replace(/"token"\s*:\s*"[^"]*"/g, '"token": "****"')
    .replace(/"access_token"\s*:\s*"[^"]*"/g, '"access_token": "****"')
    .replace(/dapi[a-f0-9]+/g, "dapi****");
}

const RESPONSES_API_MODELS = new Set([
  "databricks-gpt-5-2-codex",
]);

// --- Config parsing ---

function parseDatabricksCfg() {
  const cfgPath = path.join(os.homedir(), ".databrickscfg");
  if (!fs.existsSync(cfgPath)) return [];

  const text = fs.readFileSync(cfgPath, "utf-8");
  const profiles = [];
  let current = null;

  for (const line of text.split("\n")) {
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1], host: "", token: "" };
      profiles.push(current);
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (kvMatch) {
      const [, key, val] = kvMatch;
      if (key === "host") current.host = val.trim().replace(/\/+$/, "");
      if (key === "token") current.token = val.trim();
    }
  }

  // Include profiles that have a host — token is optional (OAuth profiles use CLI auth)
  return profiles.filter((p) => p.host);
}

// --- Chat history (JSON file-based) ---

function ensureHistoryDir() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
}

ipcMain.handle("get-profiles", () => parseDatabricksCfg());

ipcMain.handle("history-list", () => {
  ensureHistoryDir();
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf-8"));
    return { id: f.replace(".json", ""), title: data.title, updatedAt: data.updatedAt };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
});

ipcMain.handle("history-load", (_event, id) => {
  const filePath = path.join(HISTORY_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
});

ipcMain.handle("history-save", (_event, { id, title, model, messages }) => {
  ensureHistoryDir();
  const data = { title, model, messages, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(HISTORY_DIR, `${id}.json`), JSON.stringify(data, null, 2));
});

ipcMain.handle("history-delete", (_event, id) => {
  const filePath = path.join(HISTORY_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
});

// --- OAuth token via Databricks CLI ---

// OAuth token cache: { profile: { token, expiresAt } }
const tokenCache = {};
const TOKEN_CACHE_TTL = 4 * 60 * 1000; // 4 min (tokens last ~5 min, refresh early)

function getOAuthToken(profile) {
  // Check cache first
  const cached = tokenCache[profile];
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  try {
    const result = execSync(`databricks auth token --profile ${profile}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: shellEnv,
    }).trim();
    const parsed = JSON.parse(result);
    console.log(`[AUTH] Got OAuth token for profile ${profile} (expires: ${parsed.expiry || "unknown"})`);

    // Cache the token
    tokenCache[profile] = {
      token: parsed.access_token,
      expiresAt: Date.now() + TOKEN_CACHE_TTL,
    };

    return parsed.access_token;
  } catch (err) {
    console.error(`[AUTH] OAuth failed for profile ${profile}:`, err.message);
    // Clear stale cache entry
    delete tokenCache[profile];
    return null;
  }
}

function clearTokenCache(profile) {
  if (profile) {
    delete tokenCache[profile];
  } else {
    for (const key of Object.keys(tokenCache)) delete tokenCache[key];
  }
}

// Unified token getter: OAuth first, PAT fallback
function getToken(profileName) {
  const oauthToken = getOAuthToken(profileName);
  if (oauthToken) return oauthToken;

  // Fallback to PAT from config
  const profiles = parseDatabricksCfg();
  const profile = profiles.find((p) => p.name === profileName);
  if (profile?.token) {
    console.log(`[AUTH] Falling back to PAT for profile ${profileName}`);
    return profile.token;
  }

  throw new Error(`No auth available for profile "${profileName}". Click Authenticate in the + menu.`);
}

function runOAuthLogin(profile) {
  console.log(`[AUTH] Running databricks auth login --profile ${profile}...`);
  return new Promise((resolve) => {
    const proc = spawn("databricks", ["auth", "login", "--profile", profile], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: shellEnv,
    });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`[AUTH] Login completed for profile ${profile}`);
        resolve({ success: true });
      } else {
        console.error(`[AUTH] Login failed for profile ${profile}: ${stderr}`);
        resolve({ success: false, error: stderr || `Exit code ${code}` });
      }
    });
    proc.on("error", (err) => {
      console.error(`[AUTH] Login failed for profile ${profile}:`, err.message);
      resolve({ success: false, error: err.message });
    });
  });
}

ipcMain.handle("get-oauth-token", (_event, profile) => {
  return getOAuthToken(profile);
});

ipcMain.handle("clear-token-cache", (_event, profile) => {
  clearTokenCache(profile);
});

ipcMain.handle("get-token", (_event, profile) => {
  return getToken(profile);
});

ipcMain.handle("oauth-login", (_event, profile) => {
  return runOAuthLogin(profile);
});

// --- Workspace config persistence ---
// workspaces.json: { "PROFILE_NAME": { gatewayUrl, mcpServers[], customEndpoints[] }, ... }

function loadWorkspaces() {
  if (!fs.existsSync(WORKSPACES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf-8"));
  } catch (_) {
    return {};
  }
}

function saveWorkspaces(data) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(data, null, 2));
}

function getWorkspaceConfig(profile) {
  const all = loadWorkspaces();
  return all[profile] || { gatewayUrl: "", mcpServers: [], customEndpoints: [] };
}

function setWorkspaceConfig(profile, config) {
  const all = loadWorkspaces();
  all[profile] = config;
  saveWorkspaces(all);
}

ipcMain.handle("workspace-load", (_event, profile) => getWorkspaceConfig(profile));

ipcMain.handle("workspace-save", (_event, { profile, config }) => {
  setWorkspaceConfig(profile, config);
});

ipcMain.handle("workspaces-load-all", () => loadWorkspaces());

// Legacy compat — redirect to workspace config
ipcMain.handle("mcp-config-load", (_event, profile) => {
  return getWorkspaceConfig(profile || "DEFAULT").mcpServers || [];
});

ipcMain.handle("mcp-global-config-load", () => {
  if (!fs.existsSync(MCP_SERVERS_FILE)) return { http: [], stdio: [] };
  try {
    const data = JSON.parse(fs.readFileSync(MCP_SERVERS_FILE, "utf-8"));
    // Handle legacy format (plain array of URLs)
    if (Array.isArray(data)) return { http: data, stdio: [] };
    return { http: data.http || [], stdio: data.stdio || [] };
  } catch (_) {
    return { http: [], stdio: [] };
  }
});

ipcMain.handle("mcp-global-config-save", (_event, { stdio }) => {
  let existing = { http: [], stdio: [] };
  if (fs.existsSync(MCP_SERVERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(MCP_SERVERS_FILE, "utf-8"));
      if (!Array.isArray(data)) existing = { http: data.http || [], stdio: data.stdio || [] };
    } catch (_) {}
  }
  existing.stdio = stdio;
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MCP_SERVERS_FILE, JSON.stringify(existing, null, 2));
});

ipcMain.handle("mcp-config-save", (_event, { profile, servers }) => {
  const config = getWorkspaceConfig(profile || "DEFAULT");
  config.mcpServers = servers;
  setWorkspaceConfig(profile || "DEFAULT", config);
});

ipcMain.handle("endpoints-load", (_event, profile) => {
  return getWorkspaceConfig(profile || "DEFAULT").customEndpoints || [];
});

ipcMain.handle("endpoints-save", (_event, { profile, endpoints }) => {
  const config = getWorkspaceConfig(profile || "DEFAULT");
  config.customEndpoints = endpoints;
  setWorkspaceConfig(profile || "DEFAULT", config);
});

// --- MCP Client (stdio transport for local servers) ---

const stdioProcesses = {}; // key -> { process, pendingRequests, nextId }

function stdioKey(config) {
  return `stdio:${config.command}:${(config.args || []).join(":")}`;
}

function spawnStdioServer(config) {
  const key = stdioKey(config);
  if (stdioProcesses[key]?.process && !stdioProcesses[key].process.killed) {
    return stdioProcesses[key];
  }

  console.log(`[MCP-STDIO] Spawning: ${config.command} ${(config.args || []).join(" ")}`);
  const env = { ...process.env, ...(config.env || {}) };
  const proc = spawn(config.command, config.args || [], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state = {
    process: proc,
    pendingRequests: {},
    nextId: 1,
    buffer: "",
  };

  proc.stdout.on("data", (data) => {
    state.buffer += data.toString();
    // Process newline-delimited JSON-RPC messages
    let newlineIdx;
    while ((newlineIdx = state.buffer.indexOf("\n")) !== -1) {
      const line = state.buffer.slice(0, newlineIdx).trim();
      state.buffer = state.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        console.log(`[MCP-STDIO] <<< ${JSON.stringify(msg).slice(0, 300)}`);
        if (msg.id != null && state.pendingRequests[msg.id]) {
          const { resolve } = state.pendingRequests[msg.id];
          delete state.pendingRequests[msg.id];
          resolve(msg);
        }
      } catch (e) {
        console.error(`[MCP-STDIO] Parse error:`, e.message, `line:`, line.slice(0, 100));
      }
    }
  });

  proc.stderr.on("data", (data) => {
    console.error(`[MCP-STDIO] stderr:`, data.toString().trim());
  });

  proc.on("close", (code) => {
    console.log(`[MCP-STDIO] Process exited with code ${code}`);
    // Reject all pending requests
    for (const [id, { reject }] of Object.entries(state.pendingRequests)) {
      reject(new Error(`MCP stdio process exited (code ${code})`));
      delete state.pendingRequests[id];
    }
    delete stdioProcesses[key];
  });

  stdioProcesses[key] = state;
  return state;
}

function stdioRequest(state, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = state.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    console.log(`[MCP-STDIO] >>> ${method} (id=${id})`);
    state.pendingRequests[id] = { resolve, reject };
    state.process.stdin.write(JSON.stringify(msg) + "\n");

    // Timeout after 30s
    setTimeout(() => {
      if (state.pendingRequests[id]) {
        delete state.pendingRequests[id];
        reject(new Error(`MCP stdio timeout for ${method}`));
      }
    }, 30000);
  });
}

function stdioNotify(state, method, params = {}) {
  const msg = { jsonrpc: "2.0", method, params };
  state.process.stdin.write(JSON.stringify(msg) + "\n");
}

ipcMain.handle("mcp-stdio-connect", async (_event, { config }) => {
  console.log(`[MCP-STDIO] Connecting to ${config.command}...`);
  const state = spawnStdioServer(config);

  // Initialize
  const initResult = await stdioRequest(state, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mason", version: "1.0.0" },
  });
  console.log(`[MCP-STDIO] Initialized:`, JSON.stringify(initResult.result?.serverInfo || {}).slice(0, 200));

  // Send initialized notification
  stdioNotify(state, "notifications/initialized");

  // List tools
  const toolsResult = await stdioRequest(state, "tools/list");
  const tools = toolsResult.result?.tools || [];
  console.log(`[MCP-STDIO] Found ${tools.length} tools:`, tools.map((t) => t.name));

  return {
    key: stdioKey(config),
    serverInfo: initResult.result?.serverInfo || {},
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
});

ipcMain.handle("mcp-stdio-call-tool", async (_event, { key, toolName, args }) => {
  const state = stdioProcesses[key];
  if (!state) throw new Error(`No stdio MCP process for key: ${key}`);

  const result = await stdioRequest(state, "tools/call", { name: toolName, arguments: args });
  return result.result;
});

ipcMain.handle("mcp-read-config", (_event, { filePath }) => {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const configDir = path.dirname(filePath);
  let raw = fs.readFileSync(filePath, "utf-8");
  // Resolve template variables (e.g. ${CLAUDE_PLUGIN_ROOT})
  // Try env vars first, then configDir, then walk up to find a dir where paths resolve
  const varDirs = [configDir];
  for (let d = path.dirname(configDir), i = 0; i < 3; i++, d = path.dirname(d)) varDirs.push(d);

  const resolved = varDirs.find((dir) => {
    const test = raw.replace(/\$\{([^}]+)\}/g, (m, v) => process.env[v] || dir);
    try {
      const parsed = JSON.parse(test);
      const srv = Object.values(parsed.mcpServers || {})[0];
      return srv && fs.existsSync(srv.command);
    } catch { return false; }
  }) || configDir;

  raw = raw.replace(/\$\{([^}]+)\}/g, (m, v) => process.env[v] || resolved);
  const data = JSON.parse(raw);
  return data.mcpServers || {};
});

ipcMain.handle("mcp-stdio-disconnect", (_event, { key }) => {
  const state = stdioProcesses[key];
  if (state?.process && !state.process.killed) {
    state.process.kill();
    console.log(`[MCP-STDIO] Killed process: ${key}`);
  }
  delete stdioProcesses[key];
});

// --- MCP Client (Streamable HTTP transport) ---

const mcpSessions = {}; // serverUrl -> { sessionId, tools }

async function mcpRequest(serverUrl, token, method, params = {}) {
  const session = mcpSessions[serverUrl];
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Accept-Encoding": "identity",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": "2025-03-26",
  };
  if (session?.sessionId) {
    headers["MCP-Session-Id"] = session.sessionId;
  }

  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  };

  console.log(`[MCP] >>> ${method} -> ${serverUrl}`);
  console.log(`[MCP] >>> body:`, sanitizeLog(JSON.stringify(body, null, 2)));

  let res;
  try {
    res = await fetchWithTimeout(serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[MCP] !!! Network error for ${method}:`, err.message);
    throw new Error(`MCP network error: ${err.message}`);
  }

  console.log(`[MCP] <<< ${method} status=${res.status} content-type=${res.headers.get("content-type")}`);

  // Capture session ID from initialize response
  const newSessionId = res.headers.get("mcp-session-id");
  if (newSessionId) {
    console.log(`[MCP] Session ID: ${newSessionId}`);
    if (!mcpSessions[serverUrl]) mcpSessions[serverUrl] = {};
    mcpSessions[serverUrl].sessionId = newSessionId;
  }

  if (!res.ok) {
    const raw = await res.text();
    console.error(`[MCP] !!! Error response (${res.status}):`, sanitizeLog(raw.slice(0, 500)));
    // Log all response headers for auth debugging
    if (res.status === 401 || res.status === 403) {
      const hdrs = {};
      res.headers.forEach((v, k) => { hdrs[k] = v; });
      console.log(`[MCP] !!! Response headers:`, JSON.stringify(hdrs, null, 2));
    }
    // Extract readable message from JSON or HTML responses
    let msg;
    try {
      const json = JSON.parse(raw);
      msg = json.message || json.error || JSON.stringify(json);
    } catch (_) {
      msg = raw.includes("<html") ? `HTTP ${res.status} — server returned an HTML error page` : raw.slice(0, 200);
    }
    const err = new Error(`MCP ${res.status}: ${msg}`);
    err.statusCode = res.status;
    throw err;
  }

  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    console.log(`[MCP] <<< SSE body:`, sanitizeLog(text.slice(0, 500)));
    const lines = text.split("\n");
    let lastData = null;
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const d = line.slice(6).trim();
        if (d) lastData = d;
      }
    }
    if (lastData) {
      const parsed = JSON.parse(lastData);
      console.log(`[MCP] <<< SSE parsed:`, sanitizeLog(JSON.stringify(parsed, null, 2).slice(0, 500)));
      return parsed;
    }
    throw new Error("No data in SSE response");
  }

  const json = await res.json();
  console.log(`[MCP] <<< JSON:`, sanitizeLog(JSON.stringify(json, null, 2).slice(0, 500)));
  return json;
}

ipcMain.handle("mcp-connect", async (_event, { serverUrl, token }) => {
  console.log(`[MCP] Connecting to ${serverUrl}...`);

  // Step 1: Initialize
  const initResult = await mcpRequest(serverUrl, token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mason", version: "1.0.0" },
  });
  console.log(`[MCP] Initialize result:`, sanitizeLog(JSON.stringify(initResult, null, 2).slice(0, 500)));

  // Step 2: Send initialized notification
  const session = mcpSessions[serverUrl];
  console.log(`[MCP] Sending initialized notification (session=${session?.sessionId || "none"})...`);
  const notifHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": "2025-03-26",
  };
  if (session?.sessionId) notifHeaders["MCP-Session-Id"] = session.sessionId;

  try {
    const notifRes = await fetch(serverUrl, {
      method: "POST",
      headers: notifHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    console.log(`[MCP] Initialized notification status=${notifRes.status}`);
  } catch (err) {
    console.error(`[MCP] Initialized notification error:`, err.message);
  }

  // Step 3: List tools
  const toolsResult = await mcpRequest(serverUrl, token, "tools/list");
  const tools = toolsResult.result?.tools || [];
  console.log(`[MCP] Found ${tools.length} tools:`, tools.map((t) => t.name));

  if (!mcpSessions[serverUrl]) mcpSessions[serverUrl] = {};
  mcpSessions[serverUrl].tools = tools;

  return {
    serverInfo: initResult.result?.serverInfo || {},
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
});

ipcMain.handle("mcp-list-tools", (_event, { serverUrl }) => {
  const session = mcpSessions[serverUrl];
  if (!session?.tools) return [];
  return session.tools.map((t) => ({ name: t.name, description: t.description }));
});

ipcMain.handle("mcp-call-tool", async (_event, { serverUrl, token, toolName, args }) => {
  const result = await mcpRequest(serverUrl, token, "tools/call", {
    name: toolName,
    arguments: args,
  });
  return result.result;
});

// --- Chat API ---

// --- File dialog ---

ipcMain.handle("show-open-dialog", async (_event, options) => {
  return dialog.showOpenDialog(options);
});

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const { PDFParse } = require("pdf-parse");

ipcMain.handle("read-file-for-upload", async (_event, { filePath }) => {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const stats = fs.statSync(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name).slice(1).toLowerCase();

  // Images → base64 data URL for multimodal models
  if (IMAGE_EXTS.has(ext)) {
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    if (stats.size > MAX_IMAGE_BYTES) throw new Error(`Image too large (${(stats.size / 1024 / 1024).toFixed(1)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
    const buf = fs.readFileSync(filePath);
    const dataUrl = `data:${IMAGE_MIME[ext]};base64,${buf.toString("base64")}`;
    console.log(`[UPLOAD] Read image ${stats.size} bytes from ${filePath}`);
    return { name, ext, size: stats.size, kind: "image", dataUrl };
  }

  // PDFs → extract text via pdf-parse
  if (ext === "pdf") {
    const MAX_PDF_BYTES = 10 * 1024 * 1024;
    if (stats.size > MAX_PDF_BYTES) throw new Error(`PDF too large (${(stats.size / 1024 / 1024).toFixed(1)} MB > ${MAX_PDF_BYTES / 1024 / 1024} MB)`);
    const buf = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buf });
    let result;
    try {
      result = await parser.getText();
    } catch (e) {
      throw new Error(`Could not parse PDF: ${e.message}`);
    } finally {
      try { await parser.destroy(); } catch (_) {}
    }
    const MAX_TEXT_CHARS = 256 * 1024;
    let content = (result.text || "").trim();
    if (!content) throw new Error("PDF contains no extractable text (may be scanned images — OCR not supported yet)");
    let truncated = false;
    if (content.length > MAX_TEXT_CHARS) {
      content = content.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
    console.log(`[UPLOAD] Extracted ${content.length} chars from ${result.total || "?"}-page PDF ${filePath}${truncated ? " (truncated)" : ""}`);
    if (truncated) content += `\n\n[... PDF text truncated at ${MAX_TEXT_CHARS / 1024} KB ...]`;
    return { name, ext, size: stats.size, kind: "text", content };
  }

  // Text → inline as code block
  const MAX_TEXT_BYTES = 256 * 1024;
  if (stats.size > MAX_TEXT_BYTES) throw new Error(`Text file too large (${(stats.size / 1024).toFixed(0)} KB > ${MAX_TEXT_BYTES / 1024} KB)`);
  const buf = fs.readFileSync(filePath);
  if (buf.includes(0)) throw new Error("This file type isn't supported yet. Mason currently accepts text files (md, txt, code, csv, json, log, etc.), images (png, jpg, gif, webp), and PDFs.");
  const content = buf.toString("utf-8");
  console.log(`[UPLOAD] Read text ${stats.size} bytes from ${filePath}`);
  return { name, ext, size: stats.size, kind: "text", content };
});

// --- Built-in tools (local filesystem) ---

ipcMain.handle("builtin-tool-call", (_event, { toolName, args }) => {
  console.log(`[BUILTIN] Calling ${toolName} with args:`, JSON.stringify(args));

  if (toolName === "write_file") {
    const filePath = args.file_path;
    const content = args.content;
    if (!filePath || content === undefined) {
      return { error: "file_path and content are required" };
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`[BUILTIN] Wrote ${content.length} chars to ${filePath}`);
    return { success: true, message: `File written to ${filePath}` };
  }

  if (toolName === "read_file") {
    const filePath = args.file_path;
    if (!filePath) return { error: "file_path is required" };
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    const MAX_READ_CHARS = 256 * 1024;
    const offset = Math.max(0, parseInt(args.offset, 10) || 0);
    const length = Math.min(MAX_READ_CHARS, parseInt(args.length, 10) || MAX_READ_CHARS);
    const stats = fs.statSync(filePath);
    const fullContent = fs.readFileSync(filePath, "utf-8");
    const slice = fullContent.slice(offset, offset + length);
    const totalChars = fullContent.length;
    const endOffset = offset + slice.length;
    const truncated = endOffset < totalChars;
    let content = slice;
    if (truncated || offset > 0) {
      content += `\n\n[Showing chars ${offset}–${endOffset} of ${totalChars} total (${(stats.size / 1024).toFixed(1)} KB file). Call read_file again with offset=${endOffset} to read the next chunk.]`;
    }
    console.log(`[BUILTIN] Read ${slice.length} of ${totalChars} chars from ${filePath} (offset=${offset})`);
    return { success: true, content };
  }

  return { error: `Unknown builtin tool: ${toolName}` };
});

// --- Dashboard discovery ---

ipcMain.handle("list-dashboards", async (_event, { host, token }) => {
  if (!host || !token) return [];
  const baseUrl = `${host.replace(/\/+$/, "")}/api/2.0/lakeview/dashboards`;
  console.log(`[DASHBOARDS] Listing from ${baseUrl}`);

  try {
    // Fetch first page immediately
    const params = new URLSearchParams({ page_size: "100" });
    const res = await fetchWithTimeout(`${baseUrl}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`[DASHBOARDS] List failed: ${res.status}`);
      return { dashboards: [], hasMore: false };
    }
    const data = await res.json();
    const firstPage = data.dashboards || [];
    const nextPageToken = data.next_page_token || null;

    const toResult = (arr) => arr
      .filter((d) => d.lifecycle_state !== "TRASHED")
      .map((d) => ({
        id: d.dashboard_id,
        name: d.display_name,
        path: d.path,
        updatedAt: d.update_time,
      }))
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

    const dashboards = toResult(firstPage);
    console.log(`[DASHBOARDS] First page: ${dashboards.length} dashboards, hasMore: ${!!nextPageToken}`);

    // Fetch remaining pages in background if there are more
    if (nextPageToken) {
      (async () => {
        const allDashboards = [...firstPage];
        let pageToken = nextPageToken;
        const delay = (ms) => new Promise((r) => setTimeout(r, ms));
        while (pageToken) {
          await delay(500);
          try {
            const p = new URLSearchParams({ page_size: "100" });
            p.append("page_token", pageToken);
            const r = await fetchWithTimeout(`${baseUrl}?${p}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!r.ok) {
              if (r.status === 429) {
                console.log(`[DASHBOARDS] Rate limited, retrying after delay...`);
                await delay(2000);
                continue;
              }
              console.error(`[DASHBOARDS] Background page failed: ${r.status}`);
              break;
            }
            const d = await r.json();
            allDashboards.push(...(d.dashboards || []));
            pageToken = d.next_page_token || null;
          } catch (e) {
            console.error(`[DASHBOARDS] Background page error:`, e.message);
            break;
          }
        }
        const all = toResult(allDashboards);
        console.log(`[DASHBOARDS] Background complete: ${all.length} total dashboards`);
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send("dashboards-updated", all);
      })();
    }

    return { dashboards, hasMore: !!nextPageToken };
  } catch (err) {
    console.error(`[DASHBOARDS] Error:`, err.message);
    return { dashboards: [], hasMore: false };
  }
});

// --- External OAuth window ---

ipcMain.handle("open-auth-window", async (_event, { url, title }) => {
  // Validate URL — must be HTTPS to a Databricks workspace host
  if (!/^https:\/\/[^/]+\.(cloud\.databricks\.com|azuredatabricks\.net|databricksapps\.com|staging\.cloud\.databricks\.com)(\/|$)/i.test(url)) {
    throw new Error(`Refused to open non-Databricks URL: ${url}`);
  }
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 600,
      height: 700,
      title: title || "Authorize Connection",
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    win.loadURL(url);
    win.once("closed", () => resolve({ completed: true }));
  });
});

// --- Unity Catalog connections (external MCP discovery) ---

ipcMain.handle("list-uc-connections", async (_event, { host, token }) => {
  if (!host || !token) return [];
  const baseUrl = `${host.replace(/\/+$/, "")}/api/2.1/unity-catalog/connections`;
  console.log(`[UC] Listing connections from ${baseUrl}`);

  try {
    const allConnections = [];
    let pageToken = null;

    while (true) {
      const params = new URLSearchParams({ max_results: "100" });
      if (pageToken) params.append("page_token", pageToken);

      const res = await fetchWithTimeout(`${baseUrl}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.error(`[UC] List connections failed: ${res.status}`);
        break;
      }
      const data = await res.json();
      allConnections.push(...(data.connections || []));

      pageToken = data.next_page_token;
      if (!pageToken) break;
    }

    // Filter to HTTP connections (required for external MCP proxy)
    const connections = allConnections
      .filter((c) => c.connection_type === "HTTP")
      .map((c) => {
        // HTTP connections store the upstream service URL in options. The exact key
        // varies; check the common ones. Strip trailing slashes for clean joining.
        const opts = c.options || c.properties || {};
        const rawHost =
          opts.host || opts.base_url || opts.host_url || opts.url || opts.endpoint || "";
        const directHost = rawHost ? rawHost.replace(/\/+$/, "") : "";
        return {
          name: c.name,
          comment: c.comment || "",
          directHost,
        };
      });
    console.log(`[UC] Found ${connections.length} HTTP connections (of ${allConnections.length} total)`);
    for (const c of connections) {
      console.log(`[UC]   - ${c.name} -> ${c.directHost || "(no host; will use UC proxy)"}`);
    }
    return connections;
  } catch (err) {
    console.error(`[UC] Error listing connections:`, err.message);
    return [];
  }
});

// --- Model discovery ---

ipcMain.handle("discover-models", async (_event, { host, gatewayUrl, token }) => {
  // Backwards-compat: accept either { host } (preferred — workspace API)
  // or legacy { gatewayUrl } from older saved configs.
  const base = host || gatewayUrl;
  if (!base || !token) return [];
  const url = `${base.replace(/\/+$/, "")}/api/2.0/serving-endpoints`;
  console.log(`[MODELS] Discovering models from ${url}...`);

  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`[MODELS] Discovery failed: ${res.status}`);
      return [];
    }
    const data = await res.json();
    const endpoints = data.endpoints || [];

    // Group by provider based on name prefix
    const models = endpoints
      .filter((e) => e.endpoint_type === "FOUNDATION_MODEL_API" && e.task && e.task.includes("chat"))
      .map((e) => {
        let provider = "Other";
        const n = e.name;
        if (n.includes("claude")) provider = "Anthropic";
        else if (n.includes("gemini") || n.includes("gemma")) provider = "Google";
        else if (n.includes("llama") || n.includes("meta-llama")) provider = "Meta";
        else if (n.includes("gpt") || n.includes("codex")) provider = "OpenAI";
        else if (n.includes("qwen")) provider = "Qwen";

        // Derive a display label from the model ID
        const label = n.replace(/^databricks-/, "")
          .split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

        return { value: n, label, provider };
      })
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));

    console.log(`[MODELS] Found ${models.length} chat models`);
    return models;
  } catch (err) {
    console.error(`[MODELS] Discovery error:`, err.message);
    return [];
  }
});

// --- Chat API ---

ipcMain.handle("chat", async (_event, { token, model, messages, tools, gateway, format, stream }) => {
  if (!gateway) {
    throw new Error("No gateway URL available. Make sure the selected profile has a host in ~/.databrickscfg.");
  }
  let effectiveGateway = gateway;
  effectiveGateway = effectiveGateway.replace(/\/(mlflow|openai)\/v1\/.+$/, "");
  const isResponses = format === "responses" || (!format && RESPONSES_API_MODELS.has(model));
  const shouldStream = stream && !isResponses && !(tools && tools.length > 0);
  console.log(`[CHAT] model=${model}, gateway=${effectiveGateway}, format=${isResponses ? "responses" : "chat"}, stream=${shouldStream}, messages=${messages.length}, tools=${tools ? tools.length : 0}`);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  let url, body;

  if (isResponses) {
    url = `${effectiveGateway}/openai/v1/responses`;
    if (tools && tools.length > 0) {
      console.log(`[CHAT] Warning: ${model} uses Responses API which does not support tool calling`);
    }
    const filteredMessages = messages.filter((m) =>
      m.role === "user" || m.role === "assistant" || m.role === "system"
    ).filter((m) => m.content);

    body = {
      model,
      max_output_tokens: 1024,
      input: filteredMessages.map((m) => ({
        role: m.role,
        content: [{
          type: m.role === "assistant" ? "output_text" : "input_text",
          text: m.content,
        }],
      })),
    };
  } else {
    url = `${effectiveGateway}/mlflow/v1/chat/completions`;
    if (tools && tools.length > 0) {
      const toolNames = tools.map((t) => t.function.name).join(", ");
      const systemMsg = {
        role: "system",
        content: `You have access to the following tools and MUST use them when the user asks for data they can provide: ${toolNames}. Always call the appropriate tool rather than saying you don't have access.`,
      };
      const hasSystem = messages.some((m) => m.role === "system");
      body = {
        model,
        max_tokens: 4096,
        messages: hasSystem ? messages : [systemMsg, ...messages],
        tools,
        tool_choice: "auto",
      };
      console.log(`[CHAT] Sending ${tools.length} tools: ${toolNames}`);
    } else {
      body = { model, max_tokens: 4096, messages };
    }
  }

  // Enable streaming for plain chat (no tools, no responses API)
  if (shouldStream) body.stream = true;

  const res = await chatFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, 120000);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }

  // Streaming response
  if (shouldStream) {
    const win = BrowserWindow.getAllWindows()[0];
    let fullContent = "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") break;
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            if (win) win.webContents.send("chat-chunk", delta.content);
          }
        } catch (_) {}
      }
    }
    return { type: "text", content: fullContent, streamed: true };
  }

  const data = await res.json();

  if (isResponses) {
    const msg = (data.output || []).find((o) => o.type === "message");
    if (msg) {
      const textPart = msg.content.find((c) => c.type === "output_text");
      if (textPart) return { type: "text", content: textPart.text };
    }
    return { type: "text", content: JSON.stringify(data) };
  }

  const choice = data.choices[0];

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    return {
      type: "tool_calls",
      tool_calls: choice.message.tool_calls,
      content: choice.message.content || "",
    };
  }

  return { type: "text", content: choice.message.content };
});

ipcMain.handle("abort-chat", () => {
  if (activeChatController) {
    console.log("[CHAT] Aborting active request");
    activeChatController.abort();
    activeChatController = null;
  }
});

// --- Window ---

let windowStateKeeper;
try { windowStateKeeper = require("electron-window-state"); } catch (_) {}

function createWindow() {
  const stateOpts = { defaultWidth: 1000, defaultHeight: 720 };
  const windowState = windowStateKeeper ? windowStateKeeper(stateOpts) : null;

  const win = new BrowserWindow({
    x: windowState?.x,
    y: windowState?.y,
    width: windowState?.width || 1000,
    height: windowState?.height || 720,
    show: false,
    icon: path.join(__dirname, "build", "icon.icns"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (windowState) windowState.manage(win);
  win.loadFile("index.html");
  win.once("ready-to-show", () => win.show());

  // Block in-window navigation (markdown link clicks, etc.) — open in default browser instead
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  // Block window.open and target=_blank — route to default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

app.setName("Mason");

// Global error handlers
process.on("uncaughtException", (err) => {
  console.error("[CRASH] Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH] Unhandled rejection:", reason);
});

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(path.join(__dirname, "build", "icon.icns"));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Cleanup: kill all stdio MCP processes on quit
app.on("before-quit", () => {
  clearTokenCache();
  for (const [key, state] of Object.entries(stdioProcesses)) {
    if (state.process && !state.process.killed) {
      console.log(`[MCP-STDIO] Killing process on quit: ${key}`);
      state.process.kill("SIGTERM");
    }
  }
});
