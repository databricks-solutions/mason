import { app, BrowserWindow, ipcMain, nativeImage, dialog, shell, IpcMainInvokeEvent } from "electron";
import { execSync, spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

try {
  // electron-reloader watches main.js paths; in dev mode it picks up our
  // compiled file under build/ts/. It's fine if this throws in production.
  // @ts-ignore — no types shipped.
  require("electron-reloader")(module, {
    watchRenderer: true,
    ignore: ["chat_history"],
  });
} catch (_) {}

const MASON_HOME = path.join(os.homedir(), ".mason");
const HISTORY_DIR = path.join(MASON_HOME, "chat_history");
const CONFIG_DIR = path.join(MASON_HOME, "config");
const BIN_DIR = path.join(MASON_HOME, "bin");
const WORKSPACES_FILE = path.join(CONFIG_DIR, "workspaces.json");
const MCP_SERVERS_FILE = path.join(CONFIG_DIR, "mcp_servers.json");
const CLI_PATH_FILE = path.join(CONFIG_DIR, "cli_path.json");
const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");
const DATABRICKSCFG_PATH = path.join(os.homedir(), ".databrickscfg");
const DEVKIT_DIR = path.join(os.homedir(), ".ai-dev-kit");
const DEVKIT_REPO_DIR = path.join(DEVKIT_DIR, "repo");
const DEVKIT_VENV_PYTHON = path.join(DEVKIT_DIR, ".venv", "bin", "python");
const DEVKIT_MCP_ENTRY = path.join(DEVKIT_REPO_DIR, "databricks-mcp-server", "run_server.py");
const DEVKIT_VERSION_FILE = path.join(DEVKIT_REPO_DIR, ".ai-dev-kit", "version");
const DEVKIT_INSTALL_URL = "https://raw.githubusercontent.com/databricks-solutions/ai-dev-kit/main/install.sh";
const UV_INSTALL_URL = "https://astral.sh/uv/install.sh";
const MASON_REPO = "databricks-solutions/mason";
const MASON_RELEASES_URL = `https://github.com/${MASON_REPO}/releases/latest`;
const MCP_NAME_DEVKIT = "ai-dev-kit";

function getShellEnv(): NodeJS.ProcessEnv {
  const userShell = process.env.SHELL || "/bin/zsh";
  try {
    const shellPath = execSync(`${userShell} -l -c 'echo $PATH'`, {
      encoding: "utf-8",
      timeout: 5000,
      env: { HOME: os.homedir(), USER: os.userInfo().username },
    }).trim();
    console.log(`[AUTH] Resolved shell PATH: ${shellPath.slice(0, 100)}...`);
    return { ...process.env, PATH: shellPath };
  } catch (err) {
    console.error(`[AUTH] Failed to resolve shell PATH: ${(err as Error).message}`);
    const extra = [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      path.join(os.homedir(), ".local/bin"),
      path.join(os.homedir(), "bin"),
    ].join(":");
    return { ...process.env, PATH: `${process.env.PATH}:${extra}` };
  }
}
const shellEnv = getShellEnv();

if (!fs.existsSync(MASON_HOME)) fs.mkdirSync(MASON_HOME);
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR);
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR);

// --- Databricks CLI resolution + install ---

function managedCliPath(): string {
  return path.join(BIN_DIR, process.platform === "win32" ? "databricks.exe" : "databricks");
}

function databricksCliPath(): string | null {
  const which = process.platform === "win32" ? "where" : "command -v";
  try {
    const out = execSync(`${which} databricks`, { encoding: "utf-8", env: shellEnv, timeout: 3000 })
      .trim()
      .split("\n")[0];
    if (out && fs.existsSync(out)) return out;
  } catch (_) {}

  const managed = managedCliPath();
  if (fs.existsSync(managed)) return managed;

  if (fs.existsSync(CLI_PATH_FILE)) {
    try {
      const { path: saved } = JSON.parse(fs.readFileSync(CLI_PATH_FILE, "utf-8"));
      if (saved && fs.existsSync(saved)) return saved as string;
    } catch (_) {}
  }
  return null;
}

function getCliVersion(cliPath: string): string | null {
  try {
    const out = execSync(`"${cliPath}" --version`, { encoding: "utf-8", timeout: 3000 }).trim();
    return out;
  } catch (_) {
    return null;
  }
}

let activeChatController: AbortController | null = null;

function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function chatFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 120000
): Promise<Response> {
  activeChatController = new AbortController();
  const timer = setTimeout(() => activeChatController?.abort(), timeoutMs);
  return fetch(url, { ...options, signal: activeChatController.signal }).finally(() => {
    clearTimeout(timer);
    activeChatController = null;
  });
}

// Flatten a content field that might be a string, null, or an array of parts
// (Gemini, some Anthropic responses, etc. return `content: [{type:"text", text:"..."}]`).
// Without this, the renderer feeds an array to marked() and gets a confusing
// "input parameter is of type [object Array], string expected" error.
function flattenContent(c: any): string {
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

function sanitizeLog(str: string): string {
  return str
    .replace(/Bearer [^\s"]+/g, "Bearer ****")
    .replace(/"token"\s*:\s*"[^"]*"/g, '"token": "****"')
    .replace(/"access_token"\s*:\s*"[^"]*"/g, '"access_token": "****"')
    .replace(/dapi[a-f0-9]+/g, "dapi****");
}

// --- Config parsing ---

interface ParsedProfile {
  name: string;
  host: string;
  token: string;
}

function parseDatabricksCfg(): ParsedProfile[] {
  const cfgPath = path.join(os.homedir(), ".databrickscfg");
  if (!fs.existsSync(cfgPath)) return [];

  const text = fs.readFileSync(cfgPath, "utf-8");
  const profiles: ParsedProfile[] = [];
  let current: ParsedProfile | null = null;

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

  return profiles.filter((p) => p.host);
}

// --- Chat history ---

function ensureHistoryDir(): void {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
}

ipcMain.handle("get-profiles", () => parseDatabricksCfg());

ipcMain.handle("history-list", () => {
  ensureHistoryDir();
  const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf-8"));
      return { id: f.replace(".json", ""), title: data.title, updatedAt: data.updatedAt };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
});

ipcMain.handle("history-load", (_event: IpcMainInvokeEvent, id: string) => {
  const filePath = path.join(HISTORY_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
});

ipcMain.handle("history-save", (_event: IpcMainInvokeEvent, { id, title, model, messages }: any) => {
  ensureHistoryDir();
  const data = { title, model, messages, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(HISTORY_DIR, `${id}.json`), JSON.stringify(data, null, 2));
});

ipcMain.handle("history-delete", (_event: IpcMainInvokeEvent, id: string) => {
  const filePath = path.join(HISTORY_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
});

// --- OAuth via Databricks CLI ---

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}
const tokenCache: Record<string, TokenCacheEntry> = {};
const TOKEN_CACHE_TTL = 4 * 60 * 1000;

function getOAuthToken(profile: string): string | null {
  const cached = tokenCache[profile];
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const cli = databricksCliPath();
  if (!cli) {
    console.error(`[AUTH] Databricks CLI not installed; cannot fetch token for ${profile}`);
    return null;
  }
  try {
    const result = execSync(`"${cli}" auth token --profile ${profile}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: shellEnv,
    }).trim();
    const parsed = JSON.parse(result);
    console.log(`[AUTH] Got OAuth token for profile ${profile} (expires: ${parsed.expiry || "unknown"})`);
    tokenCache[profile] = {
      token: parsed.access_token,
      expiresAt: Date.now() + TOKEN_CACHE_TTL,
    };
    return parsed.access_token;
  } catch (err) {
    console.error(`[AUTH] OAuth failed for profile ${profile}:`, (err as Error).message);
    delete tokenCache[profile];
    return null;
  }
}

function clearTokenCache(profile?: string): void {
  if (profile) {
    delete tokenCache[profile];
  } else {
    for (const key of Object.keys(tokenCache)) delete tokenCache[key];
  }
}

function getToken(profileName: string): string {
  const oauthToken = getOAuthToken(profileName);
  if (oauthToken) return oauthToken;

  const profiles = parseDatabricksCfg();
  const profile = profiles.find((p) => p.name === profileName);
  if (profile?.token) {
    console.log(`[AUTH] Falling back to PAT for profile ${profileName}`);
    return profile.token;
  }

  throw new Error(`No auth available for profile "${profileName}". Click Authenticate in the + menu.`);
}

function runOAuthLogin(profile: string): Promise<{ success: boolean; error?: string }> {
  const cli = databricksCliPath();
  if (!cli) {
    return Promise.resolve({
      success: false,
      error: "Databricks CLI is not installed. Install it from Settings or finish onboarding.",
    });
  }
  console.log(`[AUTH] Running ${cli} auth login --profile ${profile}...`);
  return new Promise((resolve) => {
    const proc = spawn(cli, ["auth", "login", "--profile", profile], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: shellEnv,
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
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

ipcMain.handle("get-oauth-token", (_event: IpcMainInvokeEvent, profile: string) => getOAuthToken(profile));
ipcMain.handle("clear-token-cache", (_event: IpcMainInvokeEvent, profile?: string) => clearTokenCache(profile));
ipcMain.handle("get-token", (_event: IpcMainInvokeEvent, profile: string) => getToken(profile));
ipcMain.handle("oauth-login", (_event: IpcMainInvokeEvent, profile: string) => runOAuthLogin(profile));

// --- App self-update ---

function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => v.replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const [aMaj, aMin, aPatch] = parse(a);
  const [bMaj, bMin, bPatch] = parse(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}

ipcMain.handle("get-app-version", () => app.getVersion());

ipcMain.handle("set-titlebar-overlay", (event: IpcMainInvokeEvent, isDark: boolean) => {
  if (process.platform !== "win32") return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.setTitleBarOverlay({
    color: isDark ? "#141414" : "#f0f0f0",
    symbolColor: isDark ? "#e0e0e0" : "#333",
    height: 38,
  });
});

ipcMain.handle("check-update", async () => {
  const current = app.getVersion();
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${MASON_REPO}/releases/latest`,
      { headers: { "User-Agent": "mason-update-check", Accept: "application/vnd.github+json" } },
      10000
    );
    if (!res.ok) {
      console.error(`[UPDATE] GitHub API HTTP ${res.status}`);
      return { current, latest: null, hasUpdate: false, error: `HTTP ${res.status}` };
    }
    const data: any = await res.json();
    const latest = (data.tag_name || "").replace(/^v/, "");
    if (!latest) return { current, latest: null, hasUpdate: false, error: "no tag" };
    const hasUpdate = compareSemver(latest, current) > 0;
    return {
      current,
      latest,
      hasUpdate,
      releaseUrl: data.html_url || MASON_RELEASES_URL,
      publishedAt: data.published_at,
      notes: (data.body || "").slice(0, 800),
      autoUpdateSupported: process.platform === "darwin" && app.isPackaged,
    };
  } catch (err) {
    console.error("[UPDATE] check failed:", (err as Error).message);
    return { current, latest: null, hasUpdate: false, error: (err as Error).message };
  }
});

ipcMain.handle("open-release-page", (_event: IpcMainInvokeEvent, url?: string) => {
  const target = url || MASON_RELEASES_URL;
  if (!/^https:\/\/github\.com\//.test(target)) return false;
  shell.openExternal(target);
  return true;
});

ipcMain.handle("apply-update", () => {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Auto-update only supported on macOS today." };
  }
  if (!app.isPackaged) {
    return {
      ok: false,
      error: "Auto-update is disabled in dev mode (npm start). Quit and rerun npm start manually.",
    };
  }
  const logsDir = path.join(MASON_HOME, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `update-${Date.now()}.log`);
  console.log(`[UPDATE] Spawning installer; log -> ${logFile}`);
  const installUrl = "https://raw.githubusercontent.com/databricks-solutions/mason/main/scripts/install.sh";
  const script = [
    `set -e`,
    `sleep 3`,
    `echo "[mason-update] starting at $(date)" >> "${logFile}"`,
    `if curl -fsSL ${installUrl} | bash >> "${logFile}" 2>&1; then`,
    `  echo "[mason-update] install ok, relaunching" >> "${logFile}"`,
    `  open /Applications/Mason.app`,
    `else`,
    `  echo "[mason-update] install FAILED" >> "${logFile}"`,
    `  osascript -e 'display dialog "Mason update failed. See ${logFile.replace(/"/g, '\\"')} for details." buttons {"OK"} default button 1 with icon caution with title "Mason update"' || true`,
    `fi`,
  ].join("\n");
  const proc = spawn("bash", ["-c", script], {
    detached: true,
    stdio: "ignore",
    env: shellEnv,
  });
  proc.unref();
  setTimeout(() => app.quit(), 100);
  return { ok: true, logFile };
});

// --- Databricks CLI install ---

ipcMain.handle("detect-cli", () => {
  const cliPath = databricksCliPath();
  if (!cliPath) return { installed: false };
  return { installed: true, path: cliPath, version: getCliVersion(cliPath) };
});

function cliPlatformAsset(): { osPart: string; archPart: string; ext: string } {
  let osPart: string, archPart: string, ext: string;
  if (process.platform === "darwin") {
    osPart = "darwin";
    archPart = process.arch === "arm64" ? "arm64" : "amd64";
    ext = "zip";
  } else if (process.platform === "linux") {
    osPart = "linux";
    archPart = process.arch === "arm64" ? "arm64" : "amd64";
    ext = "tar.gz";
  } else if (process.platform === "win32") {
    osPart = "windows";
    archPart = "amd64";
    ext = "zip";
  } else {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  return { osPart, archPart, ext };
}

async function downloadToFile(
  url: string,
  dest: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  const res = await fetchWithTimeout(
    url,
    {
      headers: { "User-Agent": "mason-installer", Accept: "application/octet-stream" },
      redirect: "follow",
    },
    120000
  );
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const reader = (res.body as any).getReader();
  const out = fs.createWriteStream(dest);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
      received += value.length;
      if (onProgress && total) onProgress(Math.round((received / total) * 100));
    }
  } finally {
    out.end();
    await new Promise<void>((r) => out.on("close", () => r()));
  }
}

ipcMain.handle("install-cli", async (event: IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const send = (phase: string, percent: number): void => {
    if (win) win.webContents.send("cli-install-progress", { phase, percent });
  };
  try {
    send("query-release", 0);
    const releaseRes = await fetchWithTimeout(
      "https://api.github.com/repos/databricks/cli/releases/latest",
      { headers: { "User-Agent": "mason-installer", Accept: "application/vnd.github+json" } },
      30000
    );
    if (!releaseRes.ok) throw new Error(`Release lookup failed: HTTP ${releaseRes.status}`);
    const release: any = await releaseRes.json();
    const tag = release.tag_name;
    const version = tag.replace(/^v/, "");
    const { osPart, archPart, ext } = cliPlatformAsset();
    const assetName = `databricks_cli_${version}_${osPart}_${archPart}.${ext}`;
    const asset = (release.assets || []).find((a: any) => a.name === assetName);
    if (!asset) throw new Error(`No matching asset for this platform (looked for ${assetName})`);
    console.log(`[CLI] Found ${assetName} → ${asset.browser_download_url}`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-cli-"));
    const archive = path.join(tmpDir, assetName);

    send("download", 0);
    await downloadToFile(asset.browser_download_url, archive, (p) => send("download", p));

    send("extract", 0);
    if (ext === "zip") {
      if (process.platform === "win32") {
        execSync(
          `powershell -Command "Expand-Archive -Path '${archive}' -DestinationPath '${tmpDir}' -Force"`,
          { stdio: "ignore" }
        );
      } else {
        execSync(`unzip -oq "${archive}" -d "${tmpDir}"`, { stdio: "ignore" });
      }
    } else {
      execSync(`tar -xzf "${archive}" -C "${tmpDir}"`, { stdio: "ignore" });
    }

    const binName = process.platform === "win32" ? "databricks.exe" : "databricks";
    const extracted = fs.readdirSync(tmpDir).map((n) => path.join(tmpDir, n));
    let srcBin = extracted.find((p) => path.basename(p) === binName);
    if (!srcBin) {
      for (const entry of extracted) {
        if (fs.statSync(entry).isDirectory()) {
          const candidate = path.join(entry, binName);
          if (fs.existsSync(candidate)) {
            srcBin = candidate;
            break;
          }
        }
      }
    }
    if (!srcBin) throw new Error(`Could not find ${binName} in extracted archive`);

    const destBin = managedCliPath();
    if (fs.existsSync(destBin)) fs.unlinkSync(destBin);
    fs.copyFileSync(srcBin, destBin);
    if (process.platform !== "win32") fs.chmodSync(destBin, 0o755);

    fs.writeFileSync(CLI_PATH_FILE, JSON.stringify({ path: destBin, version }, null, 2));
    fs.rmSync(tmpDir, { recursive: true, force: true });

    send("done", 100);
    console.log(`[CLI] Installed ${tag} -> ${destBin}`);
    return { installed: true, path: destBin, version: getCliVersion(destBin) || version };
  } catch (err) {
    console.error("[CLI] Install failed:", (err as Error).message);
    send("error", 0);
    throw new Error(`Databricks CLI install failed: ${(err as Error).message}`);
  }
});

// --- Profile management ---

function isValidWorkspaceUrl(host: string): boolean {
  if (!host) return false;
  try {
    const u = new URL(host);
    if (u.protocol !== "https:") return false;
    return /\.(databricks\.com|azuredatabricks\.net|databricksapps\.com)$/i.test(u.hostname);
  } catch (_) {
    return false;
  }
}

ipcMain.handle("add-profile", (_event: IpcMainInvokeEvent, { name, host }: { name: string; host: string }) => {
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name))
    throw new Error("Profile name must be alphanumeric (with . _ -)");
  const cleanHost = String(host || "")
    .trim()
    .replace(/\/+$/, "");
  if (!isValidWorkspaceUrl(cleanHost)) throw new Error("Invalid workspace URL.");

  let text = "";
  if (fs.existsSync(DATABRICKSCFG_PATH)) {
    text = fs.readFileSync(DATABRICKSCFG_PATH, "utf-8");
  }
  const sectionRe = new RegExp(
    `(^|\\n)\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*?(?=\\n\\[|$)`
  );
  const block = `[${name}]\nhost = ${cleanHost}\nauth_type = databricks-cli\n`;
  if (sectionRe.test(text)) {
    text = text.replace(sectionRe, (_match: string, leading: string) => `${leading || ""}${block}`);
  } else {
    if (text && !text.endsWith("\n")) text += "\n";
    if (text) text += "\n";
    text += block;
  }
  fs.writeFileSync(DATABRICKSCFG_PATH, text, { mode: 0o600 });
  try {
    fs.chmodSync(DATABRICKSCFG_PATH, 0o600);
  } catch (_) {}
  console.log(`[PROFILE] Wrote profile [${name}] -> ${cleanHost}`);
  return { name, host: cleanHost };
});

ipcMain.handle("remove-profile", (_event: IpcMainInvokeEvent, name: string) => {
  if (!fs.existsSync(DATABRICKSCFG_PATH)) return false;
  let text = fs.readFileSync(DATABRICKSCFG_PATH, "utf-8");
  const sectionRe = new RegExp(
    `(^|\\n)\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*?(?=\\n\\[|$)`
  );
  if (!sectionRe.test(text)) return false;
  text = text.replace(sectionRe, "");
  text = text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  fs.writeFileSync(DATABRICKSCFG_PATH, text, { mode: 0o600 });
  clearTokenCache(name);
  const workspaces = loadWorkspaces();
  if (Object.prototype.hasOwnProperty.call(workspaces, name)) {
    delete workspaces[name];
    saveWorkspaces(workspaces);
    console.log(`[PROFILE] Also removed Mason workspace entry for [${name}]`);
  }
  console.log(`[PROFILE] Removed profile [${name}]`);
  return true;
});

function gcOrphanedWorkspaceEntries(): void {
  if (!fs.existsSync(WORKSPACES_FILE)) return;
  const workspaces = loadWorkspaces();
  const known = new Set(parseDatabricksCfg().map((p) => p.name));
  const orphans = Object.keys(workspaces).filter((name) => !known.has(name));
  if (orphans.length === 0) return;
  for (const name of orphans) delete workspaces[name];
  saveWorkspaces(workspaces);
  console.log(
    `[WORKSPACE] GC removed ${orphans.length} orphaned entr${orphans.length === 1 ? "y" : "ies"}: ${orphans.join(", ")}`
  );
}

// --- Workspace config ---

interface WorkspaceConfig {
  gatewayUrl?: string;
  mcpServers?: string[];
  customEndpoints?: any[];
  stdioServers?: Array<{ name: string; config: any }>;
  defaultModel?: any;
  [k: string]: any;
}
type Workspaces = Record<string, WorkspaceConfig>;

function loadWorkspaces(): Workspaces {
  if (!fs.existsSync(WORKSPACES_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(WORKSPACES_FILE, "utf-8"));
  } catch (_) {
    return {};
  }
}

function saveWorkspaces(data: Workspaces): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(data, null, 2));
}

function getWorkspaceConfig(profile: string): WorkspaceConfig {
  const all = loadWorkspaces();
  return all[profile] || { gatewayUrl: "", mcpServers: [], customEndpoints: [] };
}

function setWorkspaceConfig(profile: string, config: WorkspaceConfig): void {
  const all = loadWorkspaces();
  all[profile] = config;
  saveWorkspaces(all);
}

ipcMain.handle("workspace-load", (_event: IpcMainInvokeEvent, profile: string) => getWorkspaceConfig(profile));
ipcMain.handle("workspace-save", (_event: IpcMainInvokeEvent, { profile, config }: { profile: string; config: WorkspaceConfig }) => {
  setWorkspaceConfig(profile, config);
});
ipcMain.handle("workspaces-load-all", () => loadWorkspaces());

ipcMain.handle("mcp-config-load", (_event: IpcMainInvokeEvent, profile: string) => {
  return getWorkspaceConfig(profile || "DEFAULT").mcpServers || [];
});

interface McpGlobalConfig {
  http: string[];
  stdio: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    enabledByDefault?: boolean;
  }>;
}

ipcMain.handle("mcp-global-config-load", (): McpGlobalConfig => {
  if (!fs.existsSync(MCP_SERVERS_FILE)) return { http: [], stdio: [] };
  try {
    const data = JSON.parse(fs.readFileSync(MCP_SERVERS_FILE, "utf-8"));
    if (Array.isArray(data)) return { http: data, stdio: [] };
    return { http: data.http || [], stdio: data.stdio || [] };
  } catch (_) {
    return { http: [], stdio: [] };
  }
});

ipcMain.handle("mcp-global-config-save", (_event: IpcMainInvokeEvent, { stdio }: { stdio: McpGlobalConfig["stdio"] }) => {
  let existing: McpGlobalConfig = { http: [], stdio: [] };
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

// --- Global settings ---

interface Settings {
  darkMode: boolean;
  systemPrompt: string;
  autoLoadTools: boolean;
}
const DEFAULT_SETTINGS: Settings = { darkMode: false, systemPrompt: "", autoLoadTools: true };

function readSettings(): Settings {
  if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    return { ...DEFAULT_SETTINGS, ...data };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings: Settings): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

ipcMain.handle("settings-load", () => readSettings());

ipcMain.handle("settings-save", (_event: IpcMainInvokeEvent, partial: Partial<Settings>) => {
  const next = { ...readSettings(), ...partial };
  writeSettings(next);
  return next;
});

// --- ai-dev-kit ---

function readDevkitVersion(): string | null {
  try {
    if (fs.existsSync(DEVKIT_VERSION_FILE)) {
      return fs.readFileSync(DEVKIT_VERSION_FILE, "utf-8").trim();
    }
  } catch (_) {}
  return null;
}

ipcMain.handle("detect-devkit", () => {
  const installed =
    fs.existsSync(DEVKIT_REPO_DIR) &&
    fs.existsSync(DEVKIT_VENV_PYTHON) &&
    fs.existsSync(DEVKIT_MCP_ENTRY);
  return {
    installed,
    repoPath: DEVKIT_REPO_DIR,
    venvPython: DEVKIT_VENV_PYTHON,
    mcpEntry: DEVKIT_MCP_ENTRY,
    version: installed ? readDevkitVersion() : null,
  };
});

function devkitEnv(profile?: string): Record<string, string> {
  return {
    DATABRICKS_CONFIG_PROFILE: profile || "DEFAULT",
    DATABRICKS_SDK_UPSTREAM: "mason",
    DATABRICKS_SDK_UPSTREAM_VERSION: app.getVersion(),
  };
}

function registerDevkitMcp(profile: string): McpGlobalConfig["stdio"][number] {
  let cfg: McpGlobalConfig = { http: [], stdio: [] };
  if (fs.existsSync(MCP_SERVERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(MCP_SERVERS_FILE, "utf-8"));
      if (Array.isArray(data)) cfg = { http: data, stdio: [] };
      else cfg = { http: data.http || [], stdio: data.stdio || [] };
    } catch (_) {}
  }
  const entry = {
    name: MCP_NAME_DEVKIT,
    command: DEVKIT_VENV_PYTHON,
    args: [DEVKIT_MCP_ENTRY],
    env: devkitEnv(profile),
    enabledByDefault: true,
  };
  const others = (cfg.stdio || []).filter((s) => s.name !== MCP_NAME_DEVKIT);
  cfg.stdio = [...others, entry];
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MCP_SERVERS_FILE, JSON.stringify(cfg, null, 2));
  return entry;
}

function migrateDevkitMcpEntry(): void {
  if (!fs.existsSync(MCP_SERVERS_FILE)) return;
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(MCP_SERVERS_FILE, "utf-8"));
  } catch (_) {
    return;
  }
  if (Array.isArray(cfg)) return;
  const stdio = cfg.stdio || [];
  const idx = stdio.findIndex((s: any) => s.name === MCP_NAME_DEVKIT);
  if (idx === -1) return;
  const current = stdio[idx];
  const pinnedProfile = current.env?.DATABRICKS_CONFIG_PROFILE || "DEFAULT";
  const desired = devkitEnv(pinnedProfile);
  const needsMigrate =
    !current.env ||
    current.env.DATABRICKS_CONFIG_PROFILE !== desired.DATABRICKS_CONFIG_PROFILE ||
    current.env.DATABRICKS_SDK_UPSTREAM !== desired.DATABRICKS_SDK_UPSTREAM ||
    current.env.DATABRICKS_SDK_UPSTREAM_VERSION !== desired.DATABRICKS_SDK_UPSTREAM_VERSION;
  if (!needsMigrate) return;
  stdio[idx] = { ...current, env: desired };
  cfg.stdio = stdio;
  fs.writeFileSync(MCP_SERVERS_FILE, JSON.stringify(cfg, null, 2));
  console.log("[DEVKIT] Migrated ai-dev-kit MCP entry env to upstream tracking");
}

function unregisterDevkitMcp(): boolean {
  if (!fs.existsSync(MCP_SERVERS_FILE)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(MCP_SERVERS_FILE, "utf-8"));
    if (Array.isArray(data)) return false;
    const before = (data.stdio || []).length;
    data.stdio = (data.stdio || []).filter((s: any) => s.name !== MCP_NAME_DEVKIT);
    if (data.stdio.length === before) return false;
    fs.writeFileSync(MCP_SERVERS_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (_) {
    return false;
  }
}

function spawnInstallStep(win: BrowserWindow | null, cmd: string, phase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bash", ["-lc", cmd], { env: shellEnv });
    const send = (line: string): void => {
      if (!line) return;
      console.log(`[DEVKIT] ${phase}: ${line}`);
      if (win && !win.isDestroyed()) win.webContents.send("devkit-install-progress", { phase, line });
    };
    let buffer = "";
    const onChunk = (data: Buffer): void => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        send(buffer.slice(0, idx).trimEnd());
        buffer = buffer.slice(idx + 1);
      }
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("close", (code) => {
      if (buffer.trim()) send(buffer.trim());
      if (code === 0) resolve();
      else reject(new Error(`${phase} failed (exit ${code})`));
    });
    proc.on("error", reject);
  });
}

ipcMain.handle("install-devkit", async (event: IpcMainInvokeEvent, { profile }: { profile?: string } = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const send = (phase: string, line: string): void => {
    if (win && !win.isDestroyed()) win.webContents.send("devkit-install-progress", { phase, line });
  };
  try {
    send("uv-check", "Checking for uv (Python package manager)…");
    let hasUv = false;
    try {
      execSync("command -v uv", { env: shellEnv, timeout: 3000, stdio: "ignore" });
      hasUv = true;
    } catch (_) {}
    if (!hasUv) {
      send("uv-install", "Installing uv to ~/.local/bin…");
      await spawnInstallStep(win, `curl -fsSL ${UV_INSTALL_URL} | sh`, "uv-install");
    } else {
      send("uv-check", "uv already installed");
    }

    send("devkit-install", "Running Databricks AI Dev Kit installer…");
    const profileArg = profile ? ` --profile "${profile.replace(/"/g, '\\"')}"` : "";
    await spawnInstallStep(
      win,
      `bash <(curl -fsSL ${DEVKIT_INSTALL_URL}) --global --silent --tools ""${profileArg}`,
      "devkit-install"
    );

    send("register", "Registering MCP server with Mason…");
    const entry = registerDevkitMcp(profile || "DEFAULT");
    send("done", "Installed");
    return { installed: true, version: readDevkitVersion(), entry };
  } catch (err) {
    console.error("[DEVKIT] install failed:", (err as Error).message);
    send("error", (err as Error).message);
    throw new Error(`AI Dev Kit install failed: ${(err as Error).message}`);
  }
});

ipcMain.handle("uninstall-devkit", async () => {
  unregisterDevkitMcp();
  if (fs.existsSync(DEVKIT_DIR)) {
    fs.rmSync(DEVKIT_DIR, { recursive: true, force: true });
  }
  console.log("[DEVKIT] Uninstalled");
  return { uninstalled: true };
});

ipcMain.handle("mcp-config-save", (_event: IpcMainInvokeEvent, { profile, servers }: { profile?: string; servers: string[] }) => {
  const config = getWorkspaceConfig(profile || "DEFAULT");
  config.mcpServers = servers;
  setWorkspaceConfig(profile || "DEFAULT", config);
});

ipcMain.handle("endpoints-load", (_event: IpcMainInvokeEvent, profile: string) => {
  return getWorkspaceConfig(profile || "DEFAULT").customEndpoints || [];
});

ipcMain.handle("endpoints-save", (_event: IpcMainInvokeEvent, { profile, endpoints }: { profile?: string; endpoints: any[] }) => {
  const config = getWorkspaceConfig(profile || "DEFAULT");
  config.customEndpoints = endpoints;
  setWorkspaceConfig(profile || "DEFAULT", config);
});

// --- MCP stdio ---

interface StdioState {
  process: ChildProcess;
  pendingRequests: Record<number, { resolve: (msg: any) => void; reject: (err: Error) => void }>;
  nextId: number;
  buffer: string;
}

const stdioProcesses: Record<string, StdioState> = {};

function stdioKey(config: { command: string; args?: string[] }): string {
  return `stdio:${config.command}:${(config.args || []).join(":")}`;
}

function spawnStdioServer(config: { command: string; args?: string[]; env?: Record<string, string> }): StdioState {
  const key = stdioKey(config);
  const existing = stdioProcesses[key];
  if (existing?.process && !existing.process.killed) {
    return existing;
  }

  console.log(`[MCP-STDIO] Spawning: ${config.command} ${(config.args || []).join(" ")}`);
  const augmentedPath = [BIN_DIR, shellEnv.PATH].filter(Boolean).join(":");
  const env: NodeJS.ProcessEnv = { ...shellEnv, PATH: augmentedPath, ...(config.env || {}) };
  const proc = spawn(config.command, config.args || [], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state: StdioState = {
    process: proc,
    pendingRequests: {},
    nextId: 1,
    buffer: "",
  };

  proc.stdout?.on("data", (data: Buffer) => {
    state.buffer += data.toString();
    let newlineIdx: number;
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
        console.error(`[MCP-STDIO] Parse error:`, (e as Error).message, `line:`, line.slice(0, 100));
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    console.error(`[MCP-STDIO] stderr:`, data.toString().trim());
  });

  proc.on("close", (code) => {
    console.log(`[MCP-STDIO] Process exited with code ${code}`);
    for (const [id, { reject }] of Object.entries(state.pendingRequests)) {
      reject(new Error(`MCP stdio process exited (code ${code})`));
      delete state.pendingRequests[Number(id)];
    }
    delete stdioProcesses[key];
  });

  stdioProcesses[key] = state;
  return state;
}

function stdioRequest(state: StdioState, method: string, params: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = state.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    console.log(`[MCP-STDIO] >>> ${method} (id=${id})`);
    state.pendingRequests[id] = { resolve, reject };
    state.process.stdin?.write(JSON.stringify(msg) + "\n");

    setTimeout(() => {
      if (state.pendingRequests[id]) {
        delete state.pendingRequests[id];
        reject(new Error(`MCP stdio timeout for ${method}`));
      }
    }, 30000);
  });
}

function stdioNotify(state: StdioState, method: string, params: any = {}): void {
  const msg = { jsonrpc: "2.0", method, params };
  state.process.stdin?.write(JSON.stringify(msg) + "\n");
}

ipcMain.handle("mcp-stdio-connect", async (_event: IpcMainInvokeEvent, { config }: { config: any }) => {
  console.log(`[MCP-STDIO] Connecting to ${config.command}...`);
  const state = spawnStdioServer(config);

  const initResult = await stdioRequest(state, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mason", version: "1.0.0" },
  });
  console.log(`[MCP-STDIO] Initialized:`, JSON.stringify(initResult.result?.serverInfo || {}).slice(0, 200));

  stdioNotify(state, "notifications/initialized");

  const toolsResult = await stdioRequest(state, "tools/list");
  const tools = toolsResult.result?.tools || [];
  console.log(
    `[MCP-STDIO] Found ${tools.length} tools:`,
    tools.map((t: any) => t.name)
  );

  return {
    key: stdioKey(config),
    serverInfo: initResult.result?.serverInfo || {},
    tools: tools.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
});

ipcMain.handle("mcp-stdio-call-tool", async (_event: IpcMainInvokeEvent, { key, toolName, args }: any) => {
  const state = stdioProcesses[key];
  if (!state) throw new Error(`No stdio MCP process for key: ${key}`);
  const result = await stdioRequest(state, "tools/call", { name: toolName, arguments: args });
  return result.result;
});

ipcMain.handle("mcp-read-config", (_event: IpcMainInvokeEvent, { filePath }: { filePath: string }) => {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const configDir = path.dirname(filePath);
  let raw = fs.readFileSync(filePath, "utf-8");
  const varDirs: string[] = [configDir];
  for (let d = path.dirname(configDir), i = 0; i < 3; i++, d = path.dirname(d)) varDirs.push(d);

  const resolved =
    varDirs.find((dir) => {
      const test = raw.replace(/\$\{([^}]+)\}/g, (_m, v) => process.env[v] || dir);
      try {
        const parsed = JSON.parse(test);
        const srv: any = Object.values(parsed.mcpServers || {})[0];
        return srv && fs.existsSync(srv.command);
      } catch {
        return false;
      }
    }) || configDir;

  raw = raw.replace(/\$\{([^}]+)\}/g, (_m, v) => process.env[v] || resolved);
  const data = JSON.parse(raw);
  return data.mcpServers || {};
});

ipcMain.handle("mcp-stdio-disconnect", (_event: IpcMainInvokeEvent, { key }: { key: string }) => {
  const state = stdioProcesses[key];
  if (state?.process && !state.process.killed) {
    state.process.kill();
    console.log(`[MCP-STDIO] Killed process: ${key}`);
  }
  delete stdioProcesses[key];
});

ipcMain.handle("mcp-stdio-rebind-profile", (_event: IpcMainInvokeEvent, { profile }: { profile: string }) => {
  if (!profile || !fs.existsSync(MCP_SERVERS_FILE)) return { rebound: [] };
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(MCP_SERVERS_FILE, "utf-8"));
  } catch (_) {
    return { rebound: [] };
  }
  if (Array.isArray(cfg)) return { rebound: [] };
  const stdio = cfg.stdio || [];
  const rebound: string[] = [];
  let changed = false;
  for (const entry of stdio) {
    if (!entry.env || entry.env.DATABRICKS_CONFIG_PROFILE === undefined) continue;
    const wasDifferent = entry.env.DATABRICKS_CONFIG_PROFILE !== profile;
    if (wasDifferent) {
      entry.env = { ...entry.env, DATABRICKS_CONFIG_PROFILE: profile };
      changed = true;
    }
    rebound.push(entry.name);
    const key = `stdio:${entry.command}:${(entry.args || []).join(":")}`;
    const state = stdioProcesses[key];
    if (state?.process && !state.process.killed) {
      try {
        state.process.kill("SIGTERM");
      } catch (_) {}
      console.log(`[MCP-STDIO] Killed for profile rebind: ${entry.name} -> ${profile}`);
    }
    delete stdioProcesses[key];
  }
  if (changed) fs.writeFileSync(MCP_SERVERS_FILE, JSON.stringify(cfg, null, 2));
  return { rebound, changed };
});

// --- MCP HTTP (Streamable transport) ---

interface McpSession {
  sessionId?: string;
  tools?: any[];
}
const mcpSessions: Record<string, McpSession> = {};

async function mcpRequest(serverUrl: string, token: string, method: string, params: any = {}): Promise<any> {
  const session = mcpSessions[serverUrl];
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Accept-Encoding": "identity",
    Authorization: `Bearer ${token}`,
    "MCP-Protocol-Version": "2025-03-26",
  };
  if (session?.sessionId) headers["MCP-Session-Id"] = session.sessionId;

  const body = { jsonrpc: "2.0", id: Date.now(), method, params };
  console.log(`[MCP] >>> ${method} -> ${serverUrl}`);
  console.log(`[MCP] >>> body:`, sanitizeLog(JSON.stringify(body, null, 2)));

  let res: Response;
  try {
    res = await fetchWithTimeout(serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[MCP] !!! Network error for ${method}:`, (err as Error).message);
    throw new Error(`MCP network error: ${(err as Error).message}`);
  }

  console.log(
    `[MCP] <<< ${method} status=${res.status} content-type=${res.headers.get("content-type")}`
  );

  const newSessionId = res.headers.get("mcp-session-id");
  if (newSessionId) {
    console.log(`[MCP] Session ID: ${newSessionId}`);
    if (!mcpSessions[serverUrl]) mcpSessions[serverUrl] = {};
    mcpSessions[serverUrl].sessionId = newSessionId;
  }

  if (!res.ok) {
    const raw = await res.text();
    console.error(`[MCP] !!! Error response (${res.status}):`, sanitizeLog(raw.slice(0, 500)));
    if (res.status === 401 || res.status === 403) {
      const hdrs: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        hdrs[k] = v;
      });
      console.log(`[MCP] !!! Response headers:`, JSON.stringify(hdrs, null, 2));
    }
    let msg: string;
    try {
      const json = JSON.parse(raw);
      msg = json.message || json.error || JSON.stringify(json);
    } catch (_) {
      msg = raw.includes("<html")
        ? `HTTP ${res.status} — server returned an HTML error page`
        : raw.slice(0, 200);
    }
    const err: any = new Error(`MCP ${res.status}: ${msg}`);
    err.statusCode = res.status;
    throw err;
  }

  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    console.log(`[MCP] <<< SSE body:`, sanitizeLog(text.slice(0, 500)));
    const lines = text.split("\n");
    let lastData: string | null = null;
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

ipcMain.handle("mcp-connect", async (_event: IpcMainInvokeEvent, { serverUrl, token }: { serverUrl: string; token: string }) => {
  console.log(`[MCP] Connecting to ${serverUrl}...`);

  const initResult = await mcpRequest(serverUrl, token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mason", version: "1.0.0" },
  });
  console.log(`[MCP] Initialize result:`, sanitizeLog(JSON.stringify(initResult, null, 2).slice(0, 500)));

  const session = mcpSessions[serverUrl];
  console.log(`[MCP] Sending initialized notification (session=${session?.sessionId || "none"})...`);
  const notifHeaders: Record<string, string> = {
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
    console.error(`[MCP] Initialized notification error:`, (err as Error).message);
  }

  const toolsResult = await mcpRequest(serverUrl, token, "tools/list");
  const tools = toolsResult.result?.tools || [];
  console.log(
    `[MCP] Found ${tools.length} tools:`,
    tools.map((t: any) => t.name)
  );

  if (!mcpSessions[serverUrl]) mcpSessions[serverUrl] = {};
  mcpSessions[serverUrl].tools = tools;

  return {
    serverInfo: initResult.result?.serverInfo || {},
    tools: tools.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  };
});

ipcMain.handle("mcp-list-tools", (_event: IpcMainInvokeEvent, { serverUrl }: { serverUrl: string }) => {
  const session = mcpSessions[serverUrl];
  if (!session?.tools) return [];
  return session.tools.map((t: any) => ({ name: t.name, description: t.description }));
});

ipcMain.handle("mcp-call-tool", async (_event: IpcMainInvokeEvent, { serverUrl, token, toolName, args }: any) => {
  const result = await mcpRequest(serverUrl, token, "tools/call", { name: toolName, arguments: args });
  return result.result;
});

// --- File dialog ---

ipcMain.handle("show-open-dialog", async (_event: IpcMainInvokeEvent, options: any) => {
  return dialog.showOpenDialog(options);
});

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
// pdf-parse is loaded lazily inside the PDF branch below. Eager require fails
// on Windows because the bundled pdf.js calls DOMMatrix during module init,
// which doesn't exist in Electron's main-process Node context on Windows.
// Lazy-loading keeps startup clean; PDF uploads on platforms where the load
// fails return a friendly error instead of crashing the whole app.
let _PDFParse: any = undefined;
function loadPDFParse(): any {
  if (_PDFParse !== undefined) return _PDFParse;
  try {
    // @ts-ignore — pdf-parse has no @types
    _PDFParse = require("pdf-parse").PDFParse;
  } catch (err) {
    console.error("[UPLOAD] pdf-parse failed to load:", (err as Error).message);
    _PDFParse = null;
  }
  return _PDFParse;
}

ipcMain.handle("read-file-for-upload", async (_event: IpcMainInvokeEvent, { filePath }: { filePath: string }) => {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const stats = fs.statSync(filePath);
  const name = path.basename(filePath);
  const ext = path.extname(name).slice(1).toLowerCase();

  if (IMAGE_EXTS.has(ext)) {
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    if (stats.size > MAX_IMAGE_BYTES)
      throw new Error(
        `Image too large (${(stats.size / 1024 / 1024).toFixed(1)} MB > ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`
      );
    const buf = fs.readFileSync(filePath);
    const dataUrl = `data:${IMAGE_MIME[ext]};base64,${buf.toString("base64")}`;
    console.log(`[UPLOAD] Read image ${stats.size} bytes from ${filePath}`);
    return { name, ext, size: stats.size, kind: "image", dataUrl };
  }

  if (ext === "pdf") {
    const MAX_PDF_BYTES = 10 * 1024 * 1024;
    if (stats.size > MAX_PDF_BYTES)
      throw new Error(
        `PDF too large (${(stats.size / 1024 / 1024).toFixed(1)} MB > ${MAX_PDF_BYTES / 1024 / 1024} MB)`
      );
    const PDFParse = loadPDFParse();
    if (!PDFParse) {
      throw new Error(
        "PDF support isn't available on this build. Convert the PDF to text or paste its content directly into the chat."
      );
    }
    const buf = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buf });
    let result: any;
    try {
      result = await parser.getText();
    } catch (e) {
      throw new Error(`Could not parse PDF: ${(e as Error).message}`);
    } finally {
      try {
        await parser.destroy();
      } catch (_) {}
    }
    const MAX_TEXT_CHARS = 256 * 1024;
    let content = (result.text || "").trim();
    if (!content)
      throw new Error("PDF contains no extractable text (may be scanned images — OCR not supported yet)");
    let truncated = false;
    if (content.length > MAX_TEXT_CHARS) {
      content = content.slice(0, MAX_TEXT_CHARS);
      truncated = true;
    }
    console.log(
      `[UPLOAD] Extracted ${content.length} chars from ${result.total || "?"}-page PDF ${filePath}${truncated ? " (truncated)" : ""}`
    );
    if (truncated) content += `\n\n[... PDF text truncated at ${MAX_TEXT_CHARS / 1024} KB ...]`;
    return { name, ext, size: stats.size, kind: "text", content };
  }

  const MAX_TEXT_BYTES = 256 * 1024;
  if (stats.size > MAX_TEXT_BYTES)
    throw new Error(`Text file too large (${(stats.size / 1024).toFixed(0)} KB > ${MAX_TEXT_BYTES / 1024} KB)`);
  const buf = fs.readFileSync(filePath);
  if (buf.includes(0))
    throw new Error(
      "This file type isn't supported yet. Mason currently accepts text files (md, txt, code, csv, json, log, etc.), images (png, jpg, gif, webp), and PDFs."
    );
  const content = buf.toString("utf-8");
  console.log(`[UPLOAD] Read text ${stats.size} bytes from ${filePath}`);
  return { name, ext, size: stats.size, kind: "text", content };
});

// --- Built-in tools ---

ipcMain.handle("builtin-tool-call", (_event: IpcMainInvokeEvent, { toolName, args }: { toolName: string; args: any }) => {
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

// --- Dashboards ---

ipcMain.handle("list-dashboards", async (_event: IpcMainInvokeEvent, { host, token }: { host: string; token: string }) => {
  if (!host || !token) return [];
  const baseUrl = `${host.replace(/\/+$/, "")}/api/2.0/lakeview/dashboards`;
  console.log(`[DASHBOARDS] Listing from ${baseUrl}`);

  try {
    const params = new URLSearchParams({ page_size: "100" });
    const res = await fetchWithTimeout(`${baseUrl}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`[DASHBOARDS] List failed: ${res.status}`);
      return { dashboards: [], hasMore: false };
    }
    const data: any = await res.json();
    const firstPage = data.dashboards || [];
    const nextPageToken = data.next_page_token || null;

    const toResult = (arr: any[]): any[] =>
      arr
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

    if (nextPageToken) {
      (async () => {
        const allDashboards = [...firstPage];
        let pageToken = nextPageToken;
        const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
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
            const d: any = await r.json();
            allDashboards.push(...(d.dashboards || []));
            pageToken = d.next_page_token || null;
          } catch (e) {
            console.error(`[DASHBOARDS] Background page error:`, (e as Error).message);
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
    console.error(`[DASHBOARDS] Error:`, (err as Error).message);
    return { dashboards: [], hasMore: false };
  }
});

// --- External OAuth window ---

ipcMain.handle("open-auth-window", async (_event: IpcMainInvokeEvent, { url, title }: { url: string; title?: string }) => {
  if (
    !/^https:\/\/[^/]+\.(cloud\.databricks\.com|azuredatabricks\.net|databricksapps\.com|staging\.cloud\.databricks\.com)(\/|$)/i.test(
      url
    )
  ) {
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

// --- Unity Catalog connections ---

ipcMain.handle("list-uc-connections", async (_event: IpcMainInvokeEvent, { host, token }: { host: string; token: string }) => {
  if (!host || !token) return [];
  const baseUrl = `${host.replace(/\/+$/, "")}/api/2.1/unity-catalog/connections`;
  console.log(`[UC] Listing connections from ${baseUrl}`);

  try {
    const allConnections: any[] = [];
    let pageToken: string | null = null;

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
      const data: any = await res.json();
      allConnections.push(...(data.connections || []));

      pageToken = data.next_page_token;
      if (!pageToken) break;
    }

    const connections = allConnections
      .filter((c) => c.connection_type === "HTTP")
      .map((c) => {
        const opts = c.options || c.properties || {};
        const rawHost = opts.host || opts.base_url || opts.host_url || opts.url || opts.endpoint || "";
        const directHost = rawHost ? rawHost.replace(/\/+$/, "") : "";
        return { name: c.name, comment: c.comment || "", directHost };
      });
    console.log(`[UC] Found ${connections.length} HTTP connections (of ${allConnections.length} total)`);
    for (const c of connections) {
      console.log(`[UC]   - ${c.name} -> ${c.directHost || "(no host; will use UC proxy)"}`);
    }
    return connections;
  } catch (err) {
    console.error(`[UC] Error listing connections:`, (err as Error).message);
    return [];
  }
});

// --- Model discovery ---

ipcMain.handle("discover-models", async (_event: IpcMainInvokeEvent, { host, gatewayUrl, token }: { host?: string; gatewayUrl?: string; token: string }) => {
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
    const data: any = await res.json();
    const endpoints = data.endpoints || [];

    const models = endpoints
      .filter(
        (e: any) =>
          e.endpoint_type === "FOUNDATION_MODEL_API" &&
          e.task &&
          e.task.includes("chat") &&
          e.state?.ready === "READY"
      )
      .map((e: any) => {
        const fm = e.config?.served_entities?.[0]?.foundation_model || {};
        const apiTypes = fm.api_types || [];
        const supportsChat = apiTypes.includes("mlflow/v1/chat/completions");
        const supportsResponses = apiTypes.includes("openai/v1/responses");
        let format: string | null = null;
        if (supportsChat) format = "chat";
        else if (supportsResponses) format = "responses";
        else return null;

        let provider = "Other";
        const n: string = e.name;
        if (n.includes("claude")) provider = "Anthropic";
        else if (n.includes("gemini") || n.includes("gemma")) provider = "Google";
        else if (n.includes("llama") || n.includes("meta-llama")) provider = "Meta";
        else if (n.includes("gpt") || n.includes("codex")) provider = "OpenAI";
        else if (n.includes("qwen")) provider = "Qwen";

        const label =
          fm.display_name ||
          n
            .replace(/^databricks-/, "")
            .split("-")
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");

        return { value: n, label, provider, format, apiTypes };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));

    console.log(`[MODELS] Found ${models.length} chat models`);
    return models;
  } catch (err) {
    console.error(`[MODELS] Discovery error:`, (err as Error).message);
    return [];
  }
});

// --- Chat API ---

ipcMain.handle(
  "chat",
  async (
    _event: IpcMainInvokeEvent,
    { token, model, messages, tools, gateway, format, stream }: any
  ) => {
    if (!gateway) {
      throw new Error(
        "No gateway URL available. Make sure the selected profile has a host in ~/.databrickscfg."
      );
    }
    let effectiveGateway = gateway;
    effectiveGateway = effectiveGateway.replace(/\/(mlflow|openai)\/v1\/.+$/, "");
    const isResponses = format === "responses";
    // Stream chat completions regardless of whether tools are attached.
    // We accumulate tool_calls deltas below and synthesize the result.
    // Responses API has a different streaming format we don't speak, so
    // we keep that path non-streamed.
    const shouldStream = stream && !isResponses;
    console.log(
      `[CHAT] model=${model}, gateway=${effectiveGateway}, format=${isResponses ? "responses" : "chat"}, stream=${shouldStream}, messages=${messages.length}, tools=${tools ? tools.length : 0}`
    );
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    let url: string;
    let body: any;

    if (isResponses) {
      url = `${effectiveGateway}/openai/v1/responses`;
      const input: any[] = [];
      for (const m of messages) {
        if (!m) continue;
        if (m.role === "tool") {
          input.push({
            type: "function_call_output",
            call_id: m.tool_call_id,
            output: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          });
          continue;
        }
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
          if (m.content) {
            input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
          }
          for (const tc of m.tool_calls) {
            input.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.function?.name,
              arguments: tc.function?.arguments || "{}",
            });
          }
          continue;
        }
        if ((m.role === "user" || m.role === "assistant" || m.role === "system") && m.content) {
          const textContent =
            typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map((p: any) => p.text || "").join("")
                : String(m.content);
          input.push({
            role: m.role,
            content: [
              {
                type: m.role === "assistant" ? "output_text" : "input_text",
                text: textContent,
              },
            ],
          });
        }
      }

      body = { model, max_output_tokens: 4096, input };

      if (tools && tools.length > 0) {
        body.tools = tools.map((t: any) => ({
          type: "function",
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        }));
        body.tool_choice = "auto";
        console.log(
          `[CHAT] Sending ${tools.length} tools (responses format): ${tools.map((t: any) => t.function.name).join(", ")}`
        );
      }
    } else {
      url = `${effectiveGateway}/mlflow/v1/chat/completions`;
      if (tools && tools.length > 0) {
        const toolNames = tools.map((t: any) => t.function.name).join(", ");
        const systemMsg = {
          role: "system",
          content: `You have access to the following tools and MUST use them when the user asks for data they can provide: ${toolNames}. Always call the appropriate tool rather than saying you don't have access. If the user's request is ambiguous or a key decision would affect scope, prefer calling ask_user with 2-4 options instead of guessing.`,
        };
        const hasSystem = messages.some((m: any) => m.role === "system");
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

    if (shouldStream) body.stream = true;

    const res = await chatFetch(
      url,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      120000
    );

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 404 && /is not enabled/i.test(text)) {
        throw new Error(
          `Can't reach the AI Gateway endpoint for "${model}". This usually means either:\n` +
            `  • AI Gateway isn't enabled on this workspace — a workspace admin can turn it on under Compute → Serving → AI Gateway.\n` +
            `  • The model itself isn't enabled — try a different model from the dropdown.\n` +
            `If you have access to another workspace where Mason is known to work, switch profiles in the sidebar.`
        );
      }
      throw new Error(`API ${res.status}: ${text}`);
    }

    if (shouldStream) {
      const win = BrowserWindow.getAllWindows()[0];
      let fullContent = "";
      // OpenAI/Anthropic chat-completions tool_calls arrive as deltas keyed
      // by index. First delta carries id+name+(maybe partial args); later
      // deltas carry arguments string chunks. We accumulate per-index, then
      // synthesize the chat-completions tool_calls[] shape at the end so the
      // existing renderer loop stays unchanged.
      const toolCallsAccum: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }> = [];
      const reader = (res.body as any).getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
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
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === "number" ? tc.index : 0;
                if (!toolCallsAccum[idx]) {
                  toolCallsAccum[idx] = {
                    id: "",
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                }
                const slot = toolCallsAccum[idx];
                if (tc.id) slot.id = tc.id;
                if (tc.type) slot.type = tc.type;
                if (tc.function?.name) slot.function.name = tc.function.name;
                if (typeof tc.function?.arguments === "string") {
                  slot.function.arguments += tc.function.arguments;
                }
              }
            }
          } catch (_) {}
        }
      }
      // Compact (in case the stream skipped an index) and decide the response shape.
      const toolCalls = toolCallsAccum.filter((tc) => tc && tc.function?.name);
      if (toolCalls.length > 0) {
        return {
          type: "tool_calls",
          tool_calls: toolCalls,
          content: flattenContent(fullContent),
          streamed: true,
        };
      }
      return { type: "text", content: fullContent, streamed: true };
    }

    const data: any = await res.json();

    if (isResponses) {
      const items = data.output || [];
      const toolCalls = items
        .filter((o: any) => o.type === "function_call")
        .map((o: any) => ({
          id: o.call_id,
          type: "function",
          function: { name: o.name, arguments: o.arguments || "{}" },
        }));

      const msg = items.find((o: any) => o.type === "message");
      let textContent = "";
      if (msg) {
        const textPart = (msg.content || []).find((c: any) => c.type === "output_text");
        if (textPart) textContent = textPart.text;
      }

      if (toolCalls.length > 0) {
        return { type: "tool_calls", content: textContent || null, tool_calls: toolCalls };
      }
      return { type: "text", content: flattenContent(textContent) || JSON.stringify(data) };
    }

    const choice = data.choices[0];

    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      return {
        type: "tool_calls",
        tool_calls: choice.message.tool_calls,
        content: flattenContent(choice.message.content),
      };
    }

    return { type: "text", content: flattenContent(choice.message.content) };
  }
);

ipcMain.handle("abort-chat", () => {
  if (activeChatController) {
    console.log("[CHAT] Aborting active request");
    activeChatController.abort();
    activeChatController = null;
  }
});

// --- Window ---

// @ts-ignore — electron-window-state has no types shipped.
let windowStateKeeper: any;
try {
  windowStateKeeper = require("electron-window-state");
} catch (_) {}

function createWindow(): BrowserWindow {
  const stateOpts = { defaultWidth: 1000, defaultHeight: 720 };
  const windowState = windowStateKeeper ? windowStateKeeper(stateOpts) : null;

  const win = new BrowserWindow({
    x: windowState?.x,
    y: windowState?.y,
    width: windowState?.width || 1000,
    height: windowState?.height || 720,
    show: false,
    icon: path.join(__dirname, "..", "..", "build", "icon.icns"),
    titleBarStyle:
      process.platform === "darwin"
        ? "hiddenInset"
        : process.platform === "win32"
          ? "hidden"
          : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 14 } : undefined,
    titleBarOverlay:
      process.platform === "win32"
        ? { color: "#f0f0f0", symbolColor: "#333", height: 38 }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (windowState) windowState.manage(win);
  win.loadFile(path.join(__dirname, "..", "..", "index.html"));
  win.once("ready-to-show", () => win.show());

  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

app.setName("Mason");

process.on("uncaughtException", (err) => {
  console.error("[CRASH] Uncaught exception:", err.message, err.stack);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH] Unhandled rejection:", reason);
});

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(path.join(__dirname, "..", "..", "build", "icon.icns"));
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
  }
  try {
    migrateDevkitMcpEntry();
  } catch (e) {
    console.error("[DEVKIT] migrate failed:", (e as Error).message);
  }
  try {
    gcOrphanedWorkspaceEntries();
  } catch (e) {
    console.error("[WORKSPACE] GC failed:", (e as Error).message);
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("before-quit", () => {
  clearTokenCache();
  for (const [key, state] of Object.entries(stdioProcesses)) {
    if (state.process && !state.process.killed) {
      console.log(`[MCP-STDIO] Killing process on quit: ${key}`);
      state.process.kill("SIGTERM");
    }
  }
});
