// Shared utility functions

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function currentProfileName() {
  const p = getSelectedProfile();
  return p ? p.name : "DEFAULT";
}

function getSelectedProfile() {
  return mason.profiles.find((p) => p.name === mason.el.profile.value);
}

async function getAuthToken() {
  const profile = getSelectedProfile();
  if (!profile) throw new Error("No profile selected");
  return await window.api.getToken(profile.name);
}

// Validate a Databricks URL
function isValidDatabricksUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname;
    return host.includes("databricks.com") || host.includes("databricksapps.com") || host.includes("azuredatabricks.net");
  } catch (_) {
    return false;
  }
}

// Limit context window to avoid sending huge histories
const MAX_CONTEXT_MESSAGES = 50;
// ~3 MB of content ≈ 750k tokens — leaves headroom under typical 1M-token caps
const MAX_CONTEXT_CHARS = 3 * 1024 * 1024;

function messageSize(m) {
  if (typeof m.content === "string") return m.content.length;
  if (Array.isArray(m.content)) {
    return m.content.reduce((sum, p) => {
      if (p.type === "text") return sum + (p.text?.length || 0);
      if (p.type === "image_url") return sum + (p.image_url?.url?.length || 0);
      return sum + JSON.stringify(p).length;
    }, 0);
  }
  return 0;
}

function trimHistory(history) {
  // Always preserve system messages; keep most-recent non-system within both message-count and total-char limits
  const systems = history.filter((m) => m.role === "system");
  const nonSystem = history.filter((m) => m.role !== "system");

  // Start with the last MAX_CONTEXT_MESSAGES messages
  let kept = nonSystem.slice(-MAX_CONTEXT_MESSAGES);

  // Drop oldest non-system messages until total chars fits
  let total = systems.reduce((s, m) => s + messageSize(m), 0)
    + kept.reduce((s, m) => s + messageSize(m), 0);
  while (kept.length > 1 && total > MAX_CONTEXT_CHARS) {
    const dropped = kept.shift();
    total -= messageSize(dropped);
  }

  // If a single remaining message is still too big (e.g. one giant tool result), truncate it
  if (kept.length === 1 && total > MAX_CONTEXT_CHARS) {
    const m = kept[0];
    if (typeof m.content === "string") {
      const overhead = total - m.content.length;
      const budget = Math.max(1024, MAX_CONTEXT_CHARS - overhead);
      m.content = m.content.slice(0, budget) + `\n\n[... message truncated to fit context window ...]`;
    }
  }

  return [...systems, ...kept];
}
