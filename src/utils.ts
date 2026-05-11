// Shared utility functions. Script-mode TS — declared as globals so other
// renderer files can call them directly without import statements.

interface MasonProfile {
  name: string;
  host?: string;
  authType?: string;
}

interface MasonContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string };
}

interface MasonMessage {
  role: string;
  content?: string | MasonContentPart[];
}

function escapeHtml(str: string): string {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getSelectedProfile(): MasonProfile | undefined {
  const profileEl = mason.el.profile as HTMLSelectElement | null;
  if (!profileEl) return undefined;
  return (mason.profiles as MasonProfile[]).find((p) => p.name === profileEl.value);
}

function currentProfileName(): string {
  const p = getSelectedProfile();
  return p ? p.name : "DEFAULT";
}

async function getAuthToken(): Promise<string> {
  const profile = getSelectedProfile();
  if (!profile) throw new Error("No profile selected");
  return await window.api.getToken(profile.name);
}

// AI Gateway is a path on the workspace host: <host>/ai-gateway/...
// No per-workspace configuration needed — derive from the selected profile.
function getGatewayUrl(): string | null {
  const p = getSelectedProfile();
  if (!p || !p.host) return null;
  return `${p.host.replace(/\/+$/, "")}/ai-gateway`;
}

function isValidDatabricksUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    return (
      host.includes("databricks.com") ||
      host.includes("databricksapps.com") ||
      host.includes("azuredatabricks.net")
    );
  } catch (_) {
    return false;
  }
}

// Limit context window to avoid sending huge histories
const MAX_CONTEXT_MESSAGES = 50;
// ~3 MB of content ≈ 750k tokens — leaves headroom under typical 1M-token caps
const MAX_CONTEXT_CHARS = 3 * 1024 * 1024;

function messageSize(m: MasonMessage): number {
  if (typeof m.content === "string") return m.content.length;
  if (Array.isArray(m.content)) {
    return m.content.reduce((sum: number, p: MasonContentPart) => {
      if (p.type === "text") return sum + (p.text?.length || 0);
      if (p.type === "image_url") return sum + (p.image_url?.url?.length || 0);
      return sum + JSON.stringify(p).length;
    }, 0);
  }
  return 0;
}

function trimHistory(history: MasonMessage[]): MasonMessage[] {
  // Always preserve system messages; keep most-recent non-system within both
  // message-count and total-char limits.
  const systems = history.filter((m) => m.role === "system");
  const nonSystem = history.filter((m) => m.role !== "system");

  let kept = nonSystem.slice(-MAX_CONTEXT_MESSAGES);

  let total =
    systems.reduce((s, m) => s + messageSize(m), 0) +
    kept.reduce((s, m) => s + messageSize(m), 0);
  while (kept.length > 1 && total > MAX_CONTEXT_CHARS) {
    const dropped = kept.shift()!;
    total -= messageSize(dropped);
  }

  if (kept.length === 1 && total > MAX_CONTEXT_CHARS) {
    const m = kept[0];
    if (typeof m.content === "string") {
      const overhead = total - m.content.length;
      const budget = Math.max(1024, MAX_CONTEXT_CHARS - overhead);
      m.content =
        m.content.slice(0, budget) +
        `\n\n[... message truncated to fit context window ...]`;
    }
  }

  return [...systems, ...kept];
}
