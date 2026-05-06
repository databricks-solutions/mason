// App initialization — wires up DOM refs, event listeners, and startup sequence

function initDomRefs() {
  mason.el = {
    messages: document.getElementById("messages"),
    input: document.getElementById("input"),
    send: document.getElementById("send"),
    modelBtn: document.getElementById("modelBtn"),
    modelBtnLabel: document.getElementById("modelBtnLabel"),
    modelMenu: document.getElementById("modelMenu"),
    profile: document.getElementById("profile"),
    newChat: document.getElementById("newChat"),
    sidebar: document.getElementById("sidebar"),
    sidebarToggle: document.getElementById("sidebarToggle"),
    darkModeToggle: document.getElementById("darkModeToggle"),
    darkModeTrack: document.getElementById("darkModeTrack"),
    darkModeThumb: document.getElementById("darkModeThumb"),
    systemPromptInput: document.getElementById("systemPromptInput"),
    systemPromptStatus: document.getElementById("systemPromptStatus"),
    systemPromptCount: document.getElementById("systemPromptCount"),
    historyList: document.getElementById("historyList"),
    plusBtn: document.getElementById("plusBtn"),
    popupMenu: document.getElementById("popupMenu"),
    mcpModal: document.getElementById("mcpModal"),
    mcpModalClose: document.getElementById("mcpModalClose"),
    mcpModalConnect: document.getElementById("mcpModalConnect"),
    mcpUrlInput: document.getElementById("mcpUrlInput"),
    mcpServerList: document.getElementById("mcpServerList"),
    mcpBadges: document.getElementById("mcpBadges"),
    navChats: document.getElementById("navChats"),
    navDashboards: document.getElementById("navDashboards"),
    dashboardList: document.getElementById("dashboardList"),
    dashboardView: document.getElementById("dashboardView"),
    dashboardBack: document.getElementById("dashboardBack"),
    dashboardWebview: document.getElementById("dashboardWebview"),
    onboardingView: document.getElementById("onboardingView"),
    sidebarSearch: document.getElementById("sidebarSearch"),
    settingsView: document.getElementById("settingsView"),
    settingsBtn: document.getElementById("settingsBtn"),
    settingsViewClose: document.getElementById("settingsViewClose"),
    toolsModal: document.getElementById("toolsModal"),
    toolsModalList: document.getElementById("toolsModalList"),
    toolsModalClose: document.getElementById("toolsModalClose"),
    endpointsList: document.getElementById("endpointsList"),
    profilesList: document.getElementById("profilesList"),
    profileHostInput: document.getElementById("profileHostInput"),
    profileNameInput: document.getElementById("profileNameInput"),
    profileAddBtn: document.getElementById("profileAddBtn"),
    profileAddError: document.getElementById("profileAddError"),
    cliStatus: document.getElementById("cliStatus"),
    devkitStatus: document.getElementById("devkitStatus"),
    devkitInstallBtn: document.getElementById("devkitInstallBtn"),
    devkitUninstallBtn: document.getElementById("devkitUninstallBtn"),
    devkitProgress: document.getElementById("devkitProgress"),
    devkitProgressText: document.getElementById("devkitProgressText"),
    devkitError: document.getElementById("devkitError"),
    endpointModel: document.getElementById("endpointModel"),
    endpointName: document.getElementById("endpointName"),
    endpointUrl: document.getElementById("endpointUrl"),
    endpointAdd: document.getElementById("endpointAdd"),
    autoLoadToggle: document.getElementById("autoLoadToolsToggle"),
    autoLoadTrack: document.getElementById("autoLoadToolsTrack"),
    autoLoadThumb: document.getElementById("autoLoadToolsThumb"),
    mcpStdioPath: document.getElementById("mcpStdioPath"),
    mcpStdioBrowse: document.getElementById("mcpStdioBrowse"),
    mcpStdioLoad: document.getElementById("mcpStdioLoad"),
    ucMcpList: document.getElementById("ucMcpList"),
    ucMcpRefresh: document.getElementById("ucMcpRefresh"),
    ucMcpSearch: document.getElementById("ucMcpSearch"),
    defaultModelSelect: document.getElementById("defaultModelSelect"),
    attachmentChips: document.getElementById("attachmentChips"),
  };
}

// --- Attachment chips ---

function renderAttachmentChips() {
  const el = mason.el.attachmentChips;
  el.innerHTML = "";
  for (let i = 0; i < mason.attachedFiles.length; i++) {
    const f = mason.attachedFiles[i];
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.title = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
    chip.innerHTML = `<span class="attachment-chip-name">${escapeHtml(f.name)}</span><span class="attachment-chip-badge">${escapeHtml(f.ext || "FILE")}</span><button class="attachment-chip-remove" aria-label="Remove">&times;</button>`;
    chip.querySelector(".attachment-chip-remove").addEventListener("click", () => {
      mason.attachedFiles.splice(i, 1);
      renderAttachmentChips();
    });
    el.appendChild(chip);
  }
}

// --- Profiles ---

let profilesLoaded = false;
async function loadProfiles() {
  if (profilesLoaded) return;
  profilesLoaded = true;
  await reloadProfiles();
}

// Re-read ~/.databrickscfg and rebuild the sidebar dropdown. Used after
// onboarding adds the first profile, after Settings → Workspaces add/remove,
// and any other path that mutates the file.
async function reloadProfiles(selectedName) {
  mason.profiles = await window.api.getProfiles();
  mason.el.profile.innerHTML = "";
  for (const p of mason.profiles) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    if (selectedName ? p.name === selectedName : p.name === "DEFAULT") opt.selected = true;
    mason.el.profile.appendChild(opt);
  }
}

// --- Workspace config ---

async function loadWorkspaceConfig() {
  const profile = currentProfileName();
  const config = await window.api.workspaceLoad(profile);
  // gatewayUrl in saved config is legacy — gateway is now derived from profile.host.
  // autoLoadTools also moved to the global settings.json (loaded in initApp).
  mason.customEndpoints = config.customEndpoints || [];
  mason.defaultModel = config.defaultModel || null;
  if (mason.defaultModel) {
    mason.selectedModelValue = mason.defaultModel.value;
    mason.selectedModelLabel = mason.defaultModel.label;
    mason.el.modelBtnLabel.textContent = mason.defaultModel.label;
  }
  await discoverModels();
}

async function saveCustomEndpoints() {
  const profile = currentProfileName();
  const config = await window.api.workspaceLoad(profile);
  config.customEndpoints = mason.customEndpoints;
  await window.api.workspaceSave({ profile, config });
  renderModelMenu();
}

function populateDefaultModelSelect() {
  const sel = mason.el.defaultModelSelect;
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "None — use first available";
  sel.appendChild(none);
  for (const g of mason.discoveredModels) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = g.group;
    for (const m of g.models) {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.label;
      optgroup.appendChild(opt);
    }
    sel.appendChild(optgroup);
  }
  if (mason.customEndpoints.length > 0) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = "Custom";
    for (const ep of mason.customEndpoints) {
      const opt = document.createElement("option");
      opt.value = `custom:${ep.modelId}`;
      opt.textContent = ep.name;
      optgroup.appendChild(opt);
    }
    sel.appendChild(optgroup);
  }
  sel.value = mason.defaultModel ? mason.defaultModel.value : "";
}

function refreshModelDropdown() {
  renderModelMenu();
}

// --- Settings helpers ---

function renderEndpointsList() {
  mason.el.endpointsList.innerHTML = "";
  for (let i = 0; i < mason.customEndpoints.length; i++) {
    const ep = mason.customEndpoints[i];
    const div = document.createElement("div");
    div.className = "mcp-server-item";
    div.innerHTML = `
      <div class="mcp-server-item-info">
        <span class="mcp-server-item-dot" style="background:#007aff;"></span>
        <span class="mcp-server-item-name">${escapeHtml(ep.name)}</span>
        <span class="mcp-server-item-tools">${ep.modelId}</span>
      </div>
      <button class="mcp-server-remove" data-idx="${i}">&times;</button>
    `;
    div.querySelector(".mcp-server-remove").addEventListener("click", async () => {
      mason.customEndpoints.splice(i, 1);
      await saveCustomEndpoints();
      renderEndpointsList();
    });
    mason.el.endpointsList.appendChild(div);
  }
}

function updateToggleVisual() {
  mason.el.autoLoadTrack.style.background = mason.autoLoadTools ? "#4caf50" : "#ccc";
  mason.el.autoLoadThumb.style.transform = mason.autoLoadTools ? "translateX(20px)" : "translateX(0)";
}

// --- Settings: Workspaces ---

async function renderProfilesList() {
  const listEl = mason.el.profilesList;
  if (!listEl) return;
  listEl.innerHTML = "";
  const current = currentProfileName();
  for (const p of mason.profiles) {
    const div = document.createElement("div");
    div.className = "mcp-server-item";
    const isActive = p.name === current;
    div.innerHTML = `
      <div class="mcp-server-item-info">
        <span class="mcp-server-item-dot" style="background:${isActive ? "#4caf50" : "#999"};"></span>
        <span class="mcp-server-item-name">${escapeHtml(p.name)}${isActive ? " (active)" : ""}</span>
        <span class="mcp-server-item-tools">${escapeHtml(p.host)}</span>
      </div>
      <button class="mcp-server-remove" data-name="${escapeHtml(p.name)}" title="Remove">&times;</button>
    `;
    div.querySelector(".mcp-server-remove").addEventListener("click", async () => {
      if (!confirm(`Remove profile "${p.name}" from ~/.databrickscfg?`)) return;
      try {
        await window.api.removeProfile(p.name);
        await reloadProfiles();
        await renderProfilesList();
      } catch (e) {
        alert(`Failed to remove profile: ${e.message}`);
      }
    });
    listEl.appendChild(div);
  }
  if (mason.profiles.length === 0) {
    listEl.innerHTML = '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">No profiles yet — add one below.</div>';
  }
  // Refresh CLI status hint.
  const cli = await window.api.detectCli();
  if (mason.el.cliStatus) {
    mason.el.cliStatus.textContent = cli.installed
      ? `Databricks CLI: ${cli.path}`
      : `Databricks CLI: not installed. New profiles will require it — restart Mason or reinstall to set it up.`;
  }
  // Refresh ai-dev-kit status.
  await renderDevkitStatus();
}

// --- Settings: ai-dev-kit MCP ---

async function renderDevkitStatus() {
  if (!mason.el.devkitStatus) return;
  const result = await window.api.detectDevkit();
  if (result.installed) {
    const v = result.version ? ` (${result.version})` : "";
    mason.el.devkitStatus.innerHTML = `<span style="color:#4caf50;">●</span> Installed${escapeHtml(v)} at <code style="font-size:0.78rem;">~/.ai-dev-kit</code>`;
    mason.el.devkitInstallBtn.style.display = "none";
    mason.el.devkitUninstallBtn.style.display = "";
  } else {
    mason.el.devkitStatus.innerHTML = `<span style="opacity:0.5;">○</span> Not installed`;
    mason.el.devkitInstallBtn.style.display = "";
    mason.el.devkitUninstallBtn.style.display = "none";
  }
  mason.el.devkitProgress.style.display = "none";
  mason.el.devkitError.style.display = "none";
}

// --- Tools modal ---

function renderToolsModal() {
  const list = mason.el.toolsModalList;
  list.innerHTML = "";

  const groups = {};
  for (const t of getAllToolDefsUnfiltered()) {
    const src = t._source || "unknown";
    if (!groups[src]) groups[src] = [];
    groups[src].push(t);
  }

  if (Object.keys(groups).length === 0) {
    list.innerHTML = '<div style="opacity:0.5;font-size:0.85rem;padding:8px;">No tools available. Connect an MCP server to add tools.</div>';
    return;
  }

  const enabledCount = getAllToolDefs().length;
  const totalCount = getAllToolDefsUnfiltered().length;
  const counter = document.createElement("div");
  counter.style.cssText = "font-size:0.78rem;opacity:0.5;margin-bottom:8px;";
  counter.textContent = `${enabledCount} of ${totalCount} tools enabled`;
  list.appendChild(counter);

  for (const [source, tools] of Object.entries(groups)) {
    const allEnabled = tools.every((t) => !mason.disabledTools.has(t.function.name));
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 4px 4px;";
    header.innerHTML = `
      <input type="checkbox" ${allEnabled ? "checked" : ""} style="cursor:pointer;" />
      <span style="font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;opacity:0.45;">${escapeHtml(source)}</span>
      <span style="font-size:0.7rem;opacity:0.3;margin-left:auto;">${tools.length} tools</span>
    `;
    header.querySelector("input").addEventListener("change", (e) => {
      for (const t of tools) {
        if (e.target.checked) mason.disabledTools.delete(t.function.name);
        else mason.disabledTools.add(t.function.name);
      }
      renderToolsModal();
    });
    list.appendChild(header);

    for (const t of tools) {
      const name = t.function.name;
      const enabled = !mason.disabledTools.has(name);
      const div = document.createElement("div");
      div.style.cssText = `display:flex;align-items:flex-start;gap:8px;padding:5px 4px 5px 20px;opacity:${enabled ? "1" : "0.4"};`;
      div.innerHTML = `
        <input type="checkbox" ${enabled ? "checked" : ""} style="cursor:pointer;margin-top:3px;flex-shrink:0;" />
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;font-size:0.83rem;">${escapeHtml(name)}</div>
          <div style="opacity:0.55;font-size:0.75rem;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml((t.function.description || "").split("\n")[0])}</div>
        </div>
      `;
      div.querySelector("input").addEventListener("change", (e) => {
        if (e.target.checked) mason.disabledTools.delete(name);
        else mason.disabledTools.add(name);
        renderToolsModal();
      });
      list.appendChild(div);
    }
  }
}

// --- Wire up all event listeners ---

function initEventListeners() {
  const el = mason.el;

  // Delegated click handler for code block copy buttons (inline onclick stripped by DOMPurify)
  el.messages.addEventListener("click", (e) => {
    const btn = e.target.closest(".code-copy-btn");
    if (!btn) return;
    const code = btn.closest("pre")?.querySelector("code");
    if (code) {
      navigator.clipboard.writeText(code.textContent);
      btn.textContent = "\u2713";
      setTimeout(() => { btn.innerHTML = "&#128203;"; }, 1500);
    }
  });

  // Auto-resize textarea
  el.input.addEventListener("input", () => {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 180) + "px";
  });

  // Sidebar toggle
  el.sidebarToggle.addEventListener("click", () => el.sidebar.classList.toggle("hidden"));

  // Dark mode toggle. Persisted alongside other prefs in
  // ~/.mason/config/settings.json (one-time migration from old localStorage
  // values is handled in initApp).
  function applyDarkMode(isDark) {
    document.body.classList.toggle("dark", isDark);
    document.getElementById("hljs-light").disabled = isDark;
    document.getElementById("hljs-dark").disabled = !isDark;
    el.darkModeTrack.style.background = isDark ? "#4caf50" : "#ccc";
    el.darkModeThumb.style.transform = isDark ? "translateX(20px)" : "translateX(0)";
  }
  el.darkModeToggle.addEventListener("change", async () => {
    const isDark = el.darkModeToggle.checked;
    applyDarkMode(isDark);
    await window.api.settingsSave({ darkMode: isDark });
  });

  // Global system prompt — applies to every conversation across profiles.
  // chat.js reads it at request time via window.mason.systemPrompt; we keep
  // the live value mirrored there so chat.js doesn't have to re-read settings.
  function updateSystemPromptCount() {
    const len = el.systemPromptInput.value.length;
    el.systemPromptCount.textContent = `${len} / 3000`;
  }
  let systemPromptSaveTimer = null;
  el.systemPromptInput.addEventListener("input", () => {
    updateSystemPromptCount();
    el.systemPromptStatus.textContent = "Saving…";
    clearTimeout(systemPromptSaveTimer);
    systemPromptSaveTimer = setTimeout(async () => {
      const value = el.systemPromptInput.value.trim();
      mason.systemPrompt = value;
      await window.api.settingsSave({ systemPrompt: value });
      el.systemPromptStatus.textContent = value ? "Saved" : "Cleared";
      setTimeout(() => { el.systemPromptStatus.textContent = ""; }, 1500);
    }, 400);
  });

  // Apply settings loaded earlier in initApp. Done here (after DOM refs exist
  // and applyDarkMode is defined) so init order stays clean.
  applyDarkMode(!!mason.settings?.darkMode);
  el.darkModeToggle.checked = !!mason.settings?.darkMode;
  el.systemPromptInput.value = mason.settings?.systemPrompt || "";
  updateSystemPromptCount();

  // Dashboard nav tabs
  el.navChats.addEventListener("click", switchToChatsTab);
  el.navDashboards.addEventListener("click", switchToDashboardsTab);
  el.dashboardBack.addEventListener("click", switchToDashboardsTab);

  // Sidebar search
  el.sidebarSearch.addEventListener("input", () => {
    const q = el.sidebarSearch.value.toLowerCase();
    if (mason.currentView === "dashboards") {
      renderDashboardList(q);
    } else {
      el.historyList.querySelectorAll(".history-item").forEach((item) => {
        const title = item.querySelector(".history-item-title");
        item.style.display = (title && title.textContent.toLowerCase().includes(q)) ? "" : "none";
      });
    }
  });

  // OAuth login
  document.getElementById("menuAuth").addEventListener("click", async () => {
    el.popupMenu.classList.remove("open");
    const profile = getSelectedProfile();
    if (!profile) { alert("Select a Databricks profile first."); return; }
    const authText = document.getElementById("menuAuthText");
    authText.textContent = "Authenticating...";
    try {
      const result = await window.api.oauthLogin(profile.name);
      authText.textContent = result.success ? "Authenticated!" : "Failed — retry";
      if (result.success) {
        await discoverModels();
        if (mason.currentView === "dashboards") loadDashboards();
        // Retry any HTTP MCP servers that failed on initial connect
        mason.autoConnectDone = false;
        await autoConnectMcp();
      }
    } catch (_) {
      authText.textContent = "Failed — retry";
    }
    setTimeout(() => { authText.textContent = "Authenticate"; }, 3000);
  });

  // Plus button popup
  el.plusBtn.addEventListener("click", (e) => { e.stopPropagation(); el.popupMenu.classList.toggle("open"); });
  document.addEventListener("click", () => el.popupMenu.classList.remove("open"));
  el.popupMenu.addEventListener("click", (e) => e.stopPropagation());

  // Model picker
  el.modelBtn.addEventListener("click", (e) => { e.stopPropagation(); renderModelMenu(); el.modelMenu.classList.toggle("open"); });
  document.addEventListener("click", () => el.modelMenu.classList.remove("open"));
  el.modelMenu.addEventListener("click", (e) => e.stopPropagation());

  // Tools modal
  document.getElementById("menuTools").addEventListener("click", () => {
    el.popupMenu.classList.remove("open");
    renderToolsModal();
    el.toolsModal.classList.add("open");
  });
  el.toolsModalClose.addEventListener("click", () => el.toolsModal.classList.remove("open"));
  el.toolsModal.addEventListener("click", (e) => { if (e.target === el.toolsModal) el.toolsModal.classList.remove("open"); });

  // Upload Files
  document.getElementById("menuUploadFiles").addEventListener("click", async () => {
    el.popupMenu.classList.remove("open");
    if (mason.attachedFiles.length >= 5) { alert("Max 5 files attached. Remove one to add more."); return; }
    const result = await window.api.showOpenDialog({
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || !result.filePaths.length) return;
    for (const filePath of result.filePaths) {
      if (mason.attachedFiles.length >= 5) { alert("Max 5 files reached"); break; }
      if (mason.attachedFiles.some((f) => f.path === filePath)) continue;
      try {
        const file = await window.api.readFileForUpload({ filePath });
        mason.attachedFiles.push({ ...file, path: filePath });
      } catch (e) {
        alert(`Could not attach "${filePath.split("/").pop()}": ${e.message}`);
      }
    }
    renderAttachmentChips();
  });

  // Settings view
  document.getElementById("menuSettings").addEventListener("click", () => {
    el.popupMenu.classList.remove("open");
    switchToSettingsView();
  });
  el.settingsBtn.addEventListener("click", () => switchToSettingsView());
  el.settingsViewClose.addEventListener("click", () => switchToChatsTab());

  el.autoLoadToggle.addEventListener("change", async () => {
    mason.autoLoadTools = el.autoLoadToggle.checked;
    updateToggleVisual();
    // Persisted to global settings.json so the choice applies across profiles.
    await window.api.settingsSave({ autoLoadTools: mason.autoLoadTools });
  });

  el.defaultModelSelect.addEventListener("change", async () => {
    const val = el.defaultModelSelect.value;
    if (!val) {
      mason.defaultModel = null;
    } else {
      const label = el.defaultModelSelect.options[el.defaultModelSelect.selectedIndex].textContent;
      mason.defaultModel = { value: val, label };
      selectModelByValue(val);
    }
    const profile = currentProfileName();
    const config = await window.api.workspaceLoad(profile);
    config.defaultModel = mason.defaultModel;
    await window.api.workspaceSave({ profile, config });
  });

  // ai-dev-kit MCP install / uninstall
  el.devkitInstallBtn.addEventListener("click", async () => {
    el.devkitError.style.display = "none";
    el.devkitInstallBtn.disabled = true;
    el.devkitInstallBtn.textContent = "Installing…";
    el.devkitProgress.style.display = "";
    el.devkitProgressText.textContent = "Starting…";
    const onProgress = ({ phase, line }) => {
      const labels = {
        "uv-check": "Checking for uv",
        "uv-install": "Installing uv",
        "devkit-install": "Installing AI Dev Kit",
        "register": "Registering with Mason",
        "done": "Done",
        "error": "Error",
      };
      el.devkitProgressText.textContent = `${labels[phase] || phase}${line ? `: ${line.slice(0, 80)}` : ""}`;
    };
    window.api.onDevkitInstallProgress(onProgress);
    try {
      const profile = currentProfileName();
      await window.api.installDevkit({ profile });
      // Reload global MCP config + connect the new server in-place so the user
      // doesn't need to restart Mason.
      mason.autoConnectDone = false;
      if (typeof autoConnectMcp === "function") await autoConnectMcp();
      if (typeof renderMcpServerList === "function") renderMcpServerList();
      if (typeof renderMcpBadges === "function") renderMcpBadges();
    } catch (e) {
      el.devkitError.style.display = "";
      el.devkitError.textContent = e.message || "Install failed.";
    } finally {
      window.api.removeDevkitInstallListeners();
      el.devkitInstallBtn.disabled = false;
      el.devkitInstallBtn.textContent = "Install";
      await renderDevkitStatus();
    }
  });

  el.devkitUninstallBtn.addEventListener("click", async () => {
    if (!confirm("Remove the Databricks AI Dev Kit (~/.ai-dev-kit) and unregister its MCP server from Mason?")) return;
    el.devkitUninstallBtn.disabled = true;
    el.devkitUninstallBtn.textContent = "Removing…";
    try {
      // Disconnect the running stdio server before deleting its files.
      const running = mason.mcpServers.find((s) => s.configName === "ai-dev-kit");
      if (running && running.key) {
        try { await window.api.mcpStdioDisconnect({ key: running.key }); } catch (_) {}
        mason.mcpServers = mason.mcpServers.filter((s) => s !== running);
      }
      await window.api.uninstallDevkit();
      if (typeof renderMcpServerList === "function") renderMcpServerList();
      if (typeof renderMcpBadges === "function") renderMcpBadges();
    } catch (e) {
      alert(`Uninstall failed: ${e.message}`);
    } finally {
      el.devkitUninstallBtn.disabled = false;
      el.devkitUninstallBtn.textContent = "Uninstall";
      await renderDevkitStatus();
    }
  });

  el.profileAddBtn.addEventListener("click", async () => {
    el.profileAddError.style.display = "none";
    const host = el.profileHostInput.value.trim();
    if (!host) {
      el.profileAddError.style.display = "";
      el.profileAddError.textContent = "Workspace URL is required.";
      return;
    }
    if (!isValidDatabricksUrl(host)) {
      el.profileAddError.style.display = "";
      el.profileAddError.textContent = "URL must be https://*.databricks.com, *.azuredatabricks.net, or *.databricksapps.com.";
      return;
    }
    let name = el.profileNameInput.value.trim();
    if (!name) {
      try { name = new URL(host).hostname.split(".")[0]; } catch (_) { name = "default"; }
    }
    el.profileAddBtn.disabled = true;
    el.profileAddBtn.textContent = "Adding...";
    try {
      await window.api.addProfile({ name, host });
      el.profileHostInput.value = "";
      el.profileNameInput.value = "";
      await reloadProfiles(name);
      await renderProfilesList();
    } catch (e) {
      el.profileAddError.style.display = "";
      el.profileAddError.textContent = e.message || "Failed to add profile.";
    } finally {
      el.profileAddBtn.disabled = false;
      el.profileAddBtn.textContent = "Add Workspace";
    }
  });

  el.endpointAdd.addEventListener("click", async () => {
    const modelId = el.endpointModel.value.trim();
    if (!modelId) { alert("Model ID is required."); return; }
    const name = el.endpointName.value.trim() || modelId;
    const url = el.endpointUrl.value.trim() || null;
    mason.customEndpoints.push({ name, gatewayUrl: url ? url.replace(/\/+$/, "") : null, modelId, format: "chat" });
    await saveCustomEndpoints();
    renderEndpointsList();
    el.endpointModel.value = "";
    el.endpointName.value = "";
    el.endpointUrl.value = "";
  });

  // MCP modal
  document.getElementById("menuMcp").addEventListener("click", () => {
    el.popupMenu.classList.remove("open");
    el.mcpModal.classList.add("open");
    el.ucMcpSearch.value = "";
    renderMcpServerList();
    refreshUcMcp();
  });
  el.ucMcpRefresh.addEventListener("click", () => refreshUcMcp());
  el.ucMcpSearch.addEventListener("input", () => {
    if (cachedUcConnections.length > 0) renderUcMcpList(cachedUcConnections, el.ucMcpSearch.value);
  });
  el.mcpModalClose.addEventListener("click", () => el.mcpModal.classList.remove("open"));
  el.mcpModal.addEventListener("click", (e) => { if (e.target === el.mcpModal) el.mcpModal.classList.remove("open"); });

  // MCP HTTP connect
  el.mcpModalConnect.addEventListener("click", async () => {
    const url = el.mcpUrlInput.value.trim();
    if (!url) return;
    if (!getSelectedProfile()) { alert("Select a Databricks profile first."); return; }
    el.mcpModalConnect.textContent = "Connecting...";
    el.mcpModalConnect.disabled = true;
    try {
      await connectMcpServer(url);
      el.mcpUrlInput.value = "";
      renderMcpServerList();
    } catch (e) {
      console.error(`[MCP UI] Connect failed:`, e);
      alert(`Failed to connect: ${e.message}`);
    } finally {
      el.mcpModalConnect.textContent = "Connect Remote";
      el.mcpModalConnect.disabled = false;
    }
  });

  // MCP stdio browse
  el.mcpStdioBrowse.addEventListener("click", async () => {
    const result = await window.api.showOpenDialog({
      title: "Select .mcp.json file",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      el.mcpStdioPath.value = result.filePaths[0];
    }
  });

  // MCP stdio load
  el.mcpStdioLoad.addEventListener("click", async () => {
    const filePath = el.mcpStdioPath.value.trim();
    if (!filePath) return;
    el.mcpStdioLoad.textContent = "Loading...";
    el.mcpStdioLoad.disabled = true;
    try {
      const servers = await window.api.mcpReadConfig({ filePath });
      for (const [name, config] of Object.entries(servers)) {
        const key = `stdio:${config.command}:${(config.args || []).join(":")}`;
        if (mason.mcpServers.some((s) => s.key === key)) continue;
        try {
          const result = await window.api.mcpStdioConnect({ config });
          mason.mcpServers.push({ type: "stdio", key: result.key, config, configName: name, serverInfo: result.serverInfo, tools: result.tools });
          maybeDisableTools(result.tools);
        } catch (e) {
          alert(`Failed to connect "${name}": ${e.message}`);
        }
      }
      el.mcpStdioPath.value = "";
      renderMcpServerList();
      renderMcpBadges();
      saveMcpConfig();
    } catch (e) {
      alert(`Failed to load: ${e.message}`);
    } finally {
      el.mcpStdioLoad.textContent = "Load from file";
      el.mcpStdioLoad.disabled = false;
    }
  });

  // Profile change
  el.profile.addEventListener("change", async () => {
    const profileName = currentProfileName();
    console.log(`[WORKSPACE] Switching to profile: ${profileName}`);

    // Clear token cache for old profile
    try { await window.api.clearTokenCache(); } catch (_) {}

    // Validate auth
    try {
      await getAuthToken();
    } catch (e) {
      addMessageEl("error", `Profile "${profileName}" auth failed: ${e.message}. Click Authenticate in the + menu.`);
    }

    // Rebind any profile-bound stdio MCPs (those with DATABRICKS_CONFIG_PROFILE
    // set in their saved env — currently the ai-dev-kit MCP). main.js rewrites
    // the saved env and kills the running subprocesses; we drop the matching
    // entries from runtime so autoConnectMcp respawns them with the new env.
    let reboundNames = [];
    try {
      const result = await window.api.mcpStdioRebindProfile({ profile: profileName });
      reboundNames = result.rebound || [];
      if (reboundNames.length > 0) {
        console.log(`[WORKSPACE] Rebinding stdio MCPs to "${profileName}":`, reboundNames.join(", "));
      }
    } catch (e) {
      console.error("[WORKSPACE] Stdio rebind failed:", e.message);
    }

    // Keep stdio servers that aren't profile-bound; drop HTTP (always reload)
    // and any rebound stdio (its subprocess was just killed — let
    // autoConnectMcp spawn a fresh one with the new env).
    mason.mcpServers = mason.mcpServers.filter((s) =>
      s.type === "stdio" && !reboundNames.includes(s.configName)
    );
    clearUcMcpCache();
    renderMcpBadges();
    await loadWorkspaceConfig();

    mason.autoConnectDone = false;
    await autoConnectMcp();
    if (mason.currentView === "dashboards") loadDashboards();
  });

  // Chat send
  el.send.addEventListener("click", send);
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  el.newChat.addEventListener("click", newChat);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // Cmd+N — new chat
    if (mod && e.key === "n") { e.preventDefault(); newChat(); }

    // Cmd+L — focus input
    if (mod && e.key === "l") { e.preventDefault(); el.input.focus(); }

    // Cmd+, — open settings
    if (mod && e.key === ",") { e.preventDefault(); switchToSettingsView(); }

    // Cmd+B — toggle sidebar
    if (mod && e.key === "b") { e.preventDefault(); el.sidebar.classList.toggle("hidden"); }

    // Escape — close any open modal/popup; if on settings view, return to chats
    if (e.key === "Escape") {
      el.popupMenu.classList.remove("open");
      el.modelMenu.classList.remove("open");
      el.toolsModal.classList.remove("open");
      el.mcpModal.classList.remove("open");
      if (mason.currentView === "settings") switchToChatsTab();
    }
  });
}

// --- Startup ---

async function initApp() {
  initDomRefs();
  setupMarkdown();

  // Load global settings before wiring up the toggles so initial values exist
  // when initEventListeners() applies them to the DOM.
  mason.settings = await window.api.settingsLoad();

  // One-time migration from the old localStorage keys that earlier versions
  // wrote. If we have local values but settings.json is at defaults, copy them
  // forward and clear the local ones so this only runs once.
  const lsDark = localStorage.getItem("mason-dark-mode");
  const lsPrompt = localStorage.getItem("mason-system-prompt");
  if ((lsDark || lsPrompt) && !mason.settings.systemPrompt && !mason.settings.darkMode) {
    const migrated = {
      darkMode: lsDark === "1",
      systemPrompt: lsPrompt || "",
    };
    mason.settings = await window.api.settingsSave(migrated);
    if (lsDark) localStorage.removeItem("mason-dark-mode");
    if (lsPrompt) localStorage.removeItem("mason-system-prompt");
  }
  mason.autoLoadTools = mason.settings.autoLoadTools !== false;
  mason.systemPrompt = mason.settings.systemPrompt || "";

  initEventListeners();
  initDashboardListener();

  await loadProfiles();

  // First-launch path: no profiles in ~/.databrickscfg → walk through the
  // onboarding wizard. The wizard finishes by calling loadWorkspaceConfig +
  // autoConnectMcp itself, so we return early here.
  if (!mason.profiles || mason.profiles.length === 0) {
    await showOnboarding();
    refreshHistory();
    return;
  }

  await loadWorkspaceConfig();

  refreshHistory();
  await autoConnectMcp();

  // Periodic auto-save for crash recovery
  setInterval(async () => {
    if (mason.history.length > 0 && mason.currentChatId) {
      await saveCurrentChat();
    }
  }, 10000);
}

// Global error handlers
window.addEventListener("error", (e) => {
  console.error("[ERROR]", e.error?.message || e.message);
  try { addMessageEl("error", `Unexpected error: ${e.error?.message || e.message}`); } catch (_) {}
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[ERROR] Unhandled rejection:", e.reason?.message || e.reason);
});

// Boot
initApp();
