// App initialization — wires up DOM refs, event listeners, and startup sequence.

declare function setupMarkdown(): void;
declare function currentProfileName(): string;
declare function getSelectedProfile():
  | { name: string; host?: string }
  | undefined;
declare function escapeHtml(s: string): string;
declare function isValidDatabricksUrl(url: string): boolean;
declare function getAuthToken(): Promise<string>;
declare function discoverModels(): Promise<void>;
declare function renderModelMenu(): void;
declare function selectModelByValue(value: string): void;
declare function getAllToolDefs(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}>;
declare function getAllToolDefsUnfiltered(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: unknown };
  _source?: string;
}>;
declare function maybeDisableTools(tools: Array<{ name: string }>): void;
declare function connectMcpServer(url: string): Promise<void>;
declare function saveMcpConfig(): Promise<void>;
declare function autoConnectMcp(): Promise<void>;
declare function renderMcpServerList(): void;
declare function renderMcpBadges(): void;
declare function refreshUcMcp(): Promise<void>;
declare function renderUcMcpList(connections: any[], filter?: string): void;
declare function clearUcMcpCache(): void;
// cachedUcConnections is defined in mcp.ts (script scope).
declare function switchToChatsTab(): void;
declare function switchToDashboardsTab(): void;
declare function switchToSettingsView(): void;
declare function showOnboarding(): Promise<void>;
declare function loadDashboards(): Promise<void>;
declare function renderDashboardList(filter?: string): void;
declare function initDashboardListener(): void;
declare function refreshHistory(): Promise<void>;
declare function addMessageEl(role: string, text: string): void;
declare function newChat(): void;
declare function send(): Promise<void>;
declare function saveCurrentChat(): Promise<void>;

function initDomRefs(): void {
  const lookup: Record<string, string> = {
    messages: "messages",
    input: "input",
    send: "send",
    modelBtn: "modelBtn",
    modelBtnLabel: "modelBtnLabel",
    modelMenu: "modelMenu",
    profile: "profile",
    newChat: "newChat",
    sidebar: "sidebar",
    sidebarToggle: "sidebarToggle",
    darkModeToggle: "darkModeToggle",
    darkModeTrack: "darkModeTrack",
    darkModeThumb: "darkModeThumb",
    systemPromptInput: "systemPromptInput",
    systemPromptStatus: "systemPromptStatus",
    systemPromptCount: "systemPromptCount",
    historyList: "historyList",
    plusBtn: "plusBtn",
    popupMenu: "popupMenu",
    mcpModal: "mcpModal",
    mcpModalClose: "mcpModalClose",
    mcpModalConnect: "mcpModalConnect",
    mcpUrlInput: "mcpUrlInput",
    mcpServerList: "mcpServerList",
    mcpBadges: "mcpBadges",
    navChats: "navChats",
    navDashboards: "navDashboards",
    dashboardList: "dashboardList",
    dashboardView: "dashboardView",
    dashboardBack: "dashboardBack",
    dashboardWebview: "dashboardWebview",
    onboardingView: "onboardingView",
    sidebarSearch: "sidebarSearch",
    settingsView: "settingsView",
    settingsBtn: "settingsBtn",
    settingsViewClose: "settingsViewClose",
    sidebarVersion: "sidebarVersion",
    updateBtn: "updateBtn",
    updateModal: "updateModal",
    updateLatest: "updateLatest",
    updateCurrent: "updateCurrent",
    updateNotes: "updateNotes",
    updateOpen: "updateOpen",
    updateNow: "updateNow",
    updateLater: "updateLater",
    updateSkip: "updateSkip",
    toolsModal: "toolsModal",
    toolsModalList: "toolsModalList",
    toolsModalClose: "toolsModalClose",
    endpointsList: "endpointsList",
    profilesList: "profilesList",
    profileHostInput: "profileHostInput",
    profileNameInput: "profileNameInput",
    profileAddBtn: "profileAddBtn",
    profileAddError: "profileAddError",
    cliStatus: "cliStatus",
    devkitStatus: "devkitStatus",
    devkitInstallBtn: "devkitInstallBtn",
    devkitUninstallBtn: "devkitUninstallBtn",
    devkitProgress: "devkitProgress",
    devkitProgressText: "devkitProgressText",
    devkitError: "devkitError",
    endpointModel: "endpointModel",
    endpointName: "endpointName",
    endpointUrl: "endpointUrl",
    autoLoadToggle: "autoLoadToolsToggle",
    autoLoadTrack: "autoLoadToolsTrack",
    autoLoadThumb: "autoLoadToolsThumb",
    mcpStdioPath: "mcpStdioPath",
    mcpStdioBrowse: "mcpStdioBrowse",
    mcpStdioLoad: "mcpStdioLoad",
    ucMcpList: "ucMcpList",
    ucMcpRefresh: "ucMcpRefresh",
    ucMcpSearch: "ucMcpSearch",
    defaultModelSelect: "defaultModelSelect",
    attachmentChips: "attachmentChips",
    endpointAdd: "endpointAdd",
    skillsModal: "skillsModal",
    skillsModalList: "skillsModalList",
    skillsModalClose: "skillsModalClose",
    skillsSettingsList: "skillsSettingsList",
    skillsNewBtn: "skillsNewBtn",
    skillEditorModal: "skillEditorModal",
    skillEditorTitle: "skillEditorTitle",
    skillEditorName: "skillEditorName",
    skillEditorDescription: "skillEditorDescription",
    skillEditorBody: "skillEditorBody",
    skillEditorError: "skillEditorError",
    skillEditorSave: "skillEditorSave",
    skillEditorCancel: "skillEditorCancel",
    autoLoadSkillsToggle: "autoLoadSkillsToggle",
    autoLoadSkillsTrack: "autoLoadSkillsTrack",
    autoLoadSkillsThumb: "autoLoadSkillsThumb",
  };
  const refs: Record<string, HTMLElement | null> = {};
  for (const [key, id] of Object.entries(lookup)) {
    refs[key] = document.getElementById(id);
  }
  mason.el = refs;
}

// --- Attachment chips ---

function renderAttachmentChips(): void {
  const el = mason.el.attachmentChips as HTMLElement | null;
  if (!el) return;
  el.innerHTML = "";
  const attached = mason.attachedFiles as Array<MasonAttachedFile & { size?: number; ext?: string }>;
  for (let i = 0; i < attached.length; i++) {
    const f = attached[i];
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.title = `${f.name} (${((f.size || 0) / 1024).toFixed(1)} KB)`;
    chip.innerHTML = `<span class="attachment-chip-name">${escapeHtml(f.name)}</span><span class="attachment-chip-badge">${escapeHtml(f.ext || "FILE")}</span><button class="attachment-chip-remove" aria-label="Remove">&times;</button>`;
    chip.querySelector(".attachment-chip-remove")!.addEventListener("click", () => {
      attached.splice(i, 1);
      renderAttachmentChips();
    });
    el.appendChild(chip);
  }
}

// --- Profiles ---

let profilesLoaded = false;
async function loadProfiles(): Promise<void> {
  if (profilesLoaded) return;
  profilesLoaded = true;
  await reloadProfiles();
}

async function reloadProfiles(selectedName?: string): Promise<void> {
  mason.profiles = (await window.api.getProfiles()) as any[];
  const profileEl = mason.el.profile as HTMLSelectElement | null;
  if (!profileEl) return;
  profileEl.innerHTML = "";
  for (const p of mason.profiles as Array<{ name: string; host?: string }>) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    if (selectedName ? p.name === selectedName : p.name === "DEFAULT") opt.selected = true;
    profileEl.appendChild(opt);
  }
}

// --- Workspace config ---

async function loadWorkspaceConfig(): Promise<void> {
  const profile = currentProfileName();
  const config = ((await window.api.workspaceLoad(profile)) || {}) as any;
  mason.customEndpoints = config.customEndpoints || [];
  mason.defaultModel = config.defaultModel || null;
  const modelBtnLabel = mason.el.modelBtnLabel as HTMLElement | null;
  if (mason.defaultModel) {
    mason.selectedModelValue = mason.defaultModel.value;
    mason.selectedModelLabel = mason.defaultModel.label;
    if (modelBtnLabel) modelBtnLabel.textContent = mason.defaultModel.label;
  }
  await discoverModels();
}

async function saveCustomEndpoints(): Promise<void> {
  const profile = currentProfileName();
  const config = ((await window.api.workspaceLoad(profile)) || {}) as any;
  config.customEndpoints = mason.customEndpoints;
  await window.api.workspaceSave({ profile, config });
  renderModelMenu();
}

function populateDefaultModelSelect(): void {
  const sel = mason.el.defaultModelSelect as HTMLSelectElement | null;
  if (!sel) return;
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

function refreshModelDropdown(): void {
  renderModelMenu();
}

// --- Settings helpers ---

function renderEndpointsList(): void {
  const listEl = mason.el.endpointsList as HTMLElement | null;
  if (!listEl) return;
  listEl.innerHTML = "";
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
    div.querySelector(".mcp-server-remove")!.addEventListener("click", async () => {
      mason.customEndpoints.splice(i, 1);
      await saveCustomEndpoints();
      renderEndpointsList();
    });
    listEl.appendChild(div);
  }
}

function updateToggleVisual(): void {
  const track = mason.el.autoLoadTrack as HTMLElement | null;
  const thumb = mason.el.autoLoadThumb as HTMLElement | null;
  if (track) track.style.background = mason.autoLoadTools ? "#4caf50" : "#ccc";
  if (thumb) thumb.style.transform = mason.autoLoadTools ? "translateX(20px)" : "translateX(0)";
}

// --- Settings: Workspaces ---

async function renderProfilesList(): Promise<void> {
  const listEl = mason.el.profilesList as HTMLElement | null;
  if (!listEl) return;
  listEl.innerHTML = "";
  const current = currentProfileName();
  for (const p of mason.profiles as Array<{ name: string; host?: string }>) {
    const div = document.createElement("div");
    div.className = "mcp-server-item";
    const isActive = p.name === current;
    div.innerHTML = `
      <div class="mcp-server-item-info">
        <span class="mcp-server-item-dot" style="background:${isActive ? "#4caf50" : "#999"};"></span>
        <span class="mcp-server-item-name">${escapeHtml(p.name)}${isActive ? " (active)" : ""}</span>
        <span class="mcp-server-item-tools">${escapeHtml(p.host || "")}</span>
      </div>
      <button class="mcp-server-remove" data-name="${escapeHtml(p.name)}" title="Remove">&times;</button>
    `;
    div.querySelector(".mcp-server-remove")!.addEventListener("click", async () => {
      if (!confirm(`Remove profile "${p.name}" from ~/.databrickscfg?`)) return;
      try {
        await window.api.removeProfile(p.name);
        await reloadProfiles();
        await renderProfilesList();
      } catch (e) {
        alert(`Failed to remove profile: ${(e as Error).message}`);
      }
    });
    listEl.appendChild(div);
  }
  if (mason.profiles.length === 0) {
    listEl.innerHTML =
      '<div style="opacity:0.5;font-size:0.82rem;padding:4px 0;">No profiles yet — add one below.</div>';
  }
  const cli = (await window.api.detectCli()) as any;
  const cliStatus = mason.el.cliStatus as HTMLElement | null;
  const installed = cli.installed ?? cli.found;
  if (cliStatus) {
    cliStatus.textContent = installed
      ? `Databricks CLI: ${cli.path}`
      : `Databricks CLI: not installed. New profiles will require it — restart Mason or reinstall to set it up.`;
  }
  await renderDevkitStatus();
}

// --- Settings: ai-dev-kit MCP ---

async function renderDevkitStatus(): Promise<void> {
  const statusEl = mason.el.devkitStatus as HTMLElement | null;
  const installBtn = mason.el.devkitInstallBtn as HTMLButtonElement | null;
  const uninstallBtn = mason.el.devkitUninstallBtn as HTMLButtonElement | null;
  const progress = mason.el.devkitProgress as HTMLElement | null;
  const error = mason.el.devkitError as HTMLElement | null;
  if (!statusEl) return;
  const result = (await window.api.detectDevkit()) as { installed?: boolean; version?: string };
  if (result.installed) {
    const v = result.version ? ` (${result.version})` : "";
    statusEl.innerHTML = `<span style="color:#4caf50;">●</span> Installed${escapeHtml(v)} at <code style="font-size:0.78rem;">~/.ai-dev-kit</code>`;
    if (installBtn) installBtn.style.display = "none";
    if (uninstallBtn) uninstallBtn.style.display = "";
  } else {
    statusEl.innerHTML = `<span style="opacity:0.5;">○</span> Not installed`;
    if (installBtn) installBtn.style.display = "";
    if (uninstallBtn) uninstallBtn.style.display = "none";
  }
  if (progress) progress.style.display = "none";
  if (error) error.style.display = "none";
}

// --- Tools modal ---

function renderToolsModal(): void {
  const list = mason.el.toolsModalList as HTMLElement | null;
  if (!list) return;
  list.innerHTML = "";

  const groups: Record<string, Array<{
    type: "function";
    function: { name: string; description: string };
    _source?: string;
  }>> = {};
  for (const t of getAllToolDefsUnfiltered()) {
    const src = t._source || "unknown";
    if (!groups[src]) groups[src] = [];
    groups[src].push(t as any);
  }

  if (Object.keys(groups).length === 0) {
    list.innerHTML =
      '<div style="opacity:0.5;font-size:0.85rem;padding:8px;">No tools available. Connect an MCP server to add tools.</div>';
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
    header.querySelector("input")!.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      for (const t of tools) {
        if (target.checked) mason.disabledTools.delete(t.function.name);
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
      div.querySelector("input")!.addEventListener("change", (e) => {
        const target = e.target as HTMLInputElement;
        if (target.checked) mason.disabledTools.delete(name);
        else mason.disabledTools.add(name);
        renderToolsModal();
      });
      list.appendChild(div);
    }
  }
}

// --- Skills ---

async function refreshSkillsState(): Promise<void> {
  try {
    const [skills, cfg] = await Promise.all([
      window.api.skillsList(),
      window.api.skillsConfigLoad(),
    ]);
    mason.skills = (skills as MasonSkillSummary[]) || [];
    mason.disabledSkills = new Set(cfg.disabledSkills || []);
    mason.autoLoadSkills = cfg.autoLoadSkills !== false;
    updateSkillsAutoLoadVisual();
  } catch (e) {
    console.error("[SKILLS] refresh failed:", (e as Error).message);
  }
}

function updateSkillsAutoLoadVisual(): void {
  const track = mason.el.autoLoadSkillsTrack as HTMLElement | null;
  const thumb = mason.el.autoLoadSkillsThumb as HTMLElement | null;
  const toggle = mason.el.autoLoadSkillsToggle as HTMLInputElement | null;
  if (toggle) toggle.checked = mason.autoLoadSkills;
  if (track) track.style.background = mason.autoLoadSkills ? "#4caf50" : "#ccc";
  if (thumb) thumb.style.transform = mason.autoLoadSkills ? "translateX(20px)" : "translateX(0)";
}

function renderSkillsModal(): void {
  const list = mason.el.skillsModalList as HTMLElement | null;
  if (!list) return;
  list.innerHTML = "";

  if (mason.skills.length === 0) {
    list.innerHTML =
      '<div style="opacity:0.5;font-size:0.85rem;padding:8px;">No skills available. Create one in Settings → Skills, or install ai-dev-kit for bundled skills.</div>';
    return;
  }

  const enabledCount = mason.skills.filter((s) => !mason.disabledSkills.has(s.slug)).length;
  const counter = document.createElement("div");
  counter.style.cssText = "font-size:0.78rem;opacity:0.5;margin-bottom:8px;";
  counter.textContent = `${enabledCount} of ${mason.skills.length} skills enabled`;
  list.appendChild(counter);

  const groups: Record<MasonSkillSource, MasonSkillSummary[]> = { user: [], "ai-dev-kit": [] };
  for (const s of mason.skills) groups[s.source].push(s);

  const labels: Record<MasonSkillSource, string> = { user: "User", "ai-dev-kit": "ai-dev-kit" };
  for (const source of ["user", "ai-dev-kit"] as MasonSkillSource[]) {
    const items = groups[source];
    if (items.length === 0) continue;
    const header = document.createElement("div");
    header.style.cssText =
      "font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;opacity:0.45;padding:8px 4px 4px;";
    header.textContent = `${labels[source]} (${items.length})`;
    list.appendChild(header);

    for (const s of items) {
      const enabled = !mason.disabledSkills.has(s.slug);
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:flex-start;gap:8px;padding:6px 4px 6px 12px;opacity:${enabled ? "1" : "0.4"};`;
      row.innerHTML = `
        <input type="checkbox" ${enabled ? "checked" : ""} style="cursor:pointer;margin-top:3px;flex-shrink:0;" />
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;font-size:0.85rem;">${escapeHtml(s.name)}</div>
          <div style="opacity:0.6;font-size:0.76rem;line-height:1.35;">${escapeHtml(s.description || "")}</div>
        </div>
      `;
      const cb = row.querySelector("input") as HTMLInputElement;
      cb.addEventListener("change", async () => {
        if (cb.checked) mason.disabledSkills.delete(s.slug);
        else mason.disabledSkills.add(s.slug);
        await window.api.skillsConfigSave({ disabledSkills: Array.from(mason.disabledSkills) });
        renderSkillsModal();
      });
      list.appendChild(row);
    }
  }
}

function renderSkillsSettingsList(): void {
  const list = mason.el.skillsSettingsList as HTMLElement | null;
  if (!list) return;
  list.innerHTML = "";

  if (mason.skills.length === 0) {
    list.innerHTML =
      '<div style="opacity:0.5;font-size:0.82rem;padding:6px 0;">No skills yet — click + New Skill to create one.</div>';
    return;
  }

  for (const s of mason.skills) {
    const enabled = !mason.disabledSkills.has(s.slug);
    const div = document.createElement("div");
    div.className = "mcp-server-item";
    const sourceTag = s.source === "ai-dev-kit" ? "ai-dev-kit" : "user";
    const userActionsHtml =
      s.source === "user"
        ? `<button class="mcp-server-remove" data-act="edit" data-slug="${escapeHtml(s.slug)}" title="Edit" style="margin-right:4px;">&#9998;</button>
           <button class="mcp-server-remove" data-act="delete" data-slug="${escapeHtml(s.slug)}" title="Remove">&times;</button>`
        : "";
    div.innerHTML = `
      <div class="mcp-server-item-info">
        <input type="checkbox" ${enabled ? "checked" : ""} style="cursor:pointer;flex-shrink:0;" />
        <span class="mcp-server-item-name">${escapeHtml(s.name)}</span>
        <span class="mcp-server-item-tools">${sourceTag} &middot; ${escapeHtml(s.description || "")}</span>
      </div>
      <div style="display:flex;align-items:center;">${userActionsHtml}</div>
    `;
    const cb = div.querySelector('input[type="checkbox"]') as HTMLInputElement;
    cb.addEventListener("change", async () => {
      if (cb.checked) mason.disabledSkills.delete(s.slug);
      else mason.disabledSkills.add(s.slug);
      await window.api.skillsConfigSave({ disabledSkills: Array.from(mason.disabledSkills) });
      renderSkillsSettingsList();
    });
    const editBtn = div.querySelector('[data-act="edit"]') as HTMLButtonElement | null;
    editBtn?.addEventListener("click", () => openSkillEditor(s.slug));
    const delBtn = div.querySelector('[data-act="delete"]') as HTMLButtonElement | null;
    delBtn?.addEventListener("click", async () => {
      if (!confirm(`Delete the skill "${s.name}"? This removes ~/.mason/skills/${s.slug}/.`)) return;
      await window.api.skillsDelete(s.slug);
      await refreshSkillsState();
      renderSkillsSettingsList();
    });
    list.appendChild(div);
  }
}

let editingSkillSlug: string | null = null;

async function openSkillEditor(slug?: string): Promise<void> {
  const modal = mason.el.skillEditorModal as HTMLElement | null;
  const title = mason.el.skillEditorTitle as HTMLElement | null;
  const nameInput = mason.el.skillEditorName as HTMLInputElement | null;
  const descInput = mason.el.skillEditorDescription as HTMLInputElement | null;
  const bodyInput = mason.el.skillEditorBody as HTMLTextAreaElement | null;
  const errEl = mason.el.skillEditorError as HTMLElement | null;
  if (!modal || !nameInput || !descInput || !bodyInput) return;

  editingSkillSlug = slug || null;
  if (errEl) {
    errEl.style.display = "none";
    errEl.textContent = "";
  }

  if (slug) {
    const skill = (await window.api.skillsLoad(slug)) as
      | { slug: string; name: string; description: string; body: string }
      | null;
    if (!skill) {
      alert("Could not load skill.");
      return;
    }
    if (title) title.textContent = `Edit Skill — ${skill.name}`;
    nameInput.value = skill.name;
    descInput.value = skill.description;
    bodyInput.value = skill.body;
  } else {
    if (title) title.textContent = "New Skill";
    nameInput.value = "";
    descInput.value = "";
    bodyInput.value = "";
  }
  modal.classList.add("open");
  nameInput.focus();
}

function closeSkillEditor(): void {
  const modal = mason.el.skillEditorModal as HTMLElement | null;
  modal?.classList.remove("open");
  editingSkillSlug = null;
}

async function saveSkillEditor(): Promise<void> {
  const nameInput = mason.el.skillEditorName as HTMLInputElement | null;
  const descInput = mason.el.skillEditorDescription as HTMLInputElement | null;
  const bodyInput = mason.el.skillEditorBody as HTMLTextAreaElement | null;
  const errEl = mason.el.skillEditorError as HTMLElement | null;
  if (!nameInput || !descInput || !bodyInput) return;

  const name = nameInput.value.trim();
  const description = descInput.value.trim();
  const body = bodyInput.value;
  if (!name) {
    if (errEl) {
      errEl.style.display = "";
      errEl.textContent = "Name is required.";
    }
    return;
  }
  if (!body.trim()) {
    if (errEl) {
      errEl.style.display = "";
      errEl.textContent = "Body is required.";
    }
    return;
  }
  try {
    await window.api.skillsSave({
      name,
      description,
      body,
      slug: editingSkillSlug || undefined,
    });
    closeSkillEditor();
    await refreshSkillsState();
    renderSkillsSettingsList();
  } catch (e) {
    if (errEl) {
      errEl.style.display = "";
      errEl.textContent = (e as Error).message || "Save failed.";
    }
  }
}

// --- Wire up all event listeners ---

function initEventListeners(): void {
  const el = mason.el;

  // Delegated click handler for code block copy buttons
  (el.messages as HTMLElement | null)?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const btn = target.closest(".code-copy-btn") as HTMLElement | null;
    if (!btn) return;
    const code = btn.closest("pre")?.querySelector("code");
    if (code) {
      navigator.clipboard.writeText(code.textContent || "");
      btn.textContent = "✓";
      setTimeout(() => {
        btn.innerHTML = "&#128203;";
      }, 1500);
    }
  });

  // Auto-resize textarea
  const inputEl = el.input as HTMLTextAreaElement | null;
  inputEl?.addEventListener("input", () => {
    if (!inputEl) return;
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
  });

  // Sidebar toggle
  (el.sidebarToggle as HTMLElement | null)?.addEventListener("click", () =>
    (el.sidebar as HTMLElement | null)?.classList.toggle("hidden")
  );

  // Dark mode
  function applyDarkMode(isDark: boolean): void {
    document.body.classList.toggle("dark", isDark);
    const light = document.getElementById("hljs-light") as HTMLLinkElement | null;
    const dark = document.getElementById("hljs-dark") as HTMLLinkElement | null;
    if (light) light.disabled = isDark;
    if (dark) dark.disabled = !isDark;
    const track = el.darkModeTrack as HTMLElement | null;
    const thumb = el.darkModeThumb as HTMLElement | null;
    if (track) track.style.background = isDark ? "#4caf50" : "#ccc";
    if (thumb) thumb.style.transform = isDark ? "translateX(20px)" : "translateX(0)";
    if (window.api?.setTitleBarOverlay) window.api.setTitleBarOverlay(isDark);
  }
  const darkToggle = el.darkModeToggle as HTMLInputElement | null;
  darkToggle?.addEventListener("change", async () => {
    const isDark = darkToggle.checked;
    applyDarkMode(isDark);
    await window.api.settingsSave({ darkMode: isDark });
  });

  // System prompt
  const promptInput = el.systemPromptInput as HTMLTextAreaElement | null;
  const promptCount = el.systemPromptCount as HTMLElement | null;
  const promptStatus = el.systemPromptStatus as HTMLElement | null;
  function updateSystemPromptCount(): void {
    if (!promptInput || !promptCount) return;
    promptCount.textContent = `${promptInput.value.length} / 3000`;
  }
  let systemPromptSaveTimer: ReturnType<typeof setTimeout> | null = null;
  promptInput?.addEventListener("input", () => {
    updateSystemPromptCount();
    if (promptStatus) promptStatus.textContent = "Saving…";
    if (systemPromptSaveTimer) clearTimeout(systemPromptSaveTimer);
    systemPromptSaveTimer = setTimeout(async () => {
      const value = promptInput.value.trim();
      mason.systemPrompt = value;
      await window.api.settingsSave({ systemPrompt: value });
      if (promptStatus) {
        promptStatus.textContent = value ? "Saved" : "Cleared";
        setTimeout(() => {
          if (promptStatus) promptStatus.textContent = "";
        }, 1500);
      }
    }, 400);
  });

  applyDarkMode(!!mason.settings?.darkMode);
  if (darkToggle) darkToggle.checked = !!mason.settings?.darkMode;
  if (promptInput) promptInput.value = mason.settings?.systemPrompt || "";
  updateSystemPromptCount();

  // Dashboard nav tabs
  (el.navChats as HTMLElement | null)?.addEventListener("click", switchToChatsTab);
  (el.navDashboards as HTMLElement | null)?.addEventListener("click", switchToDashboardsTab);
  (el.dashboardBack as HTMLElement | null)?.addEventListener("click", switchToDashboardsTab);

  // Sidebar search
  const search = el.sidebarSearch as HTMLInputElement | null;
  search?.addEventListener("input", () => {
    const q = search.value.toLowerCase();
    if (mason.currentView === "dashboards") {
      renderDashboardList(q);
    } else {
      const historyList = el.historyList as HTMLElement | null;
      historyList?.querySelectorAll(".history-item").forEach((item) => {
        const title = item.querySelector(".history-item-title");
        const itemEl = item as HTMLElement;
        itemEl.style.display =
          title && title.textContent?.toLowerCase().includes(q) ? "" : "none";
      });
    }
  });

  // OAuth
  document.getElementById("menuAuth")?.addEventListener("click", async () => {
    (el.popupMenu as HTMLElement | null)?.classList.remove("open");
    const profile = getSelectedProfile();
    if (!profile) {
      alert("Select a Databricks profile first.");
      return;
    }
    const authText = document.getElementById("menuAuthText");
    if (authText) authText.textContent = "Authenticating...";
    try {
      const result = await window.api.oauthLogin(profile.name);
      if (authText) authText.textContent = result.success ? "Authenticated!" : "Failed — retry";
      if (result.success) {
        await discoverModels();
        if (mason.currentView === "dashboards") loadDashboards();
        mason.autoConnectDone = false;
        await autoConnectMcp();
      }
    } catch (_) {
      if (authText) authText.textContent = "Failed — retry";
    }
    setTimeout(() => {
      if (authText) authText.textContent = "Authenticate";
    }, 3000);
  });

  // Plus button popup
  const plusBtn = el.plusBtn as HTMLElement | null;
  const popup = el.popupMenu as HTMLElement | null;
  plusBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    popup?.classList.toggle("open");
  });
  document.addEventListener("click", () => popup?.classList.remove("open"));
  popup?.addEventListener("click", (e) => e.stopPropagation());

  // Model picker
  const modelBtn = el.modelBtn as HTMLElement | null;
  const modelMenu = el.modelMenu as HTMLElement | null;
  modelBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    renderModelMenu();
    modelMenu?.classList.toggle("open");
  });
  document.addEventListener("click", () => modelMenu?.classList.remove("open"));
  modelMenu?.addEventListener("click", (e) => e.stopPropagation());

  // Tools modal
  const toolsModal = el.toolsModal as HTMLElement | null;
  document.getElementById("menuTools")?.addEventListener("click", () => {
    popup?.classList.remove("open");
    renderToolsModal();
    toolsModal?.classList.add("open");
  });
  (el.toolsModalClose as HTMLElement | null)?.addEventListener("click", () =>
    toolsModal?.classList.remove("open")
  );
  toolsModal?.addEventListener("click", (e) => {
    if (e.target === toolsModal) toolsModal.classList.remove("open");
  });

  // Skills modal — toggle which skills the LLM sees in <available_skills>
  const skillsModal = el.skillsModal as HTMLElement | null;
  document.getElementById("menuSkills")?.addEventListener("click", async () => {
    popup?.classList.remove("open");
    await refreshSkillsState();
    renderSkillsModal();
    skillsModal?.classList.add("open");
  });
  (el.skillsModalClose as HTMLElement | null)?.addEventListener("click", () =>
    skillsModal?.classList.remove("open")
  );
  skillsModal?.addEventListener("click", (e) => {
    if (e.target === skillsModal) skillsModal.classList.remove("open");
  });

  // Skill editor modal (create/edit)
  const skillEditorModal = el.skillEditorModal as HTMLElement | null;
  (el.skillsNewBtn as HTMLElement | null)?.addEventListener("click", () => openSkillEditor());
  (el.skillEditorCancel as HTMLElement | null)?.addEventListener("click", () => closeSkillEditor());
  (el.skillEditorSave as HTMLElement | null)?.addEventListener("click", () => saveSkillEditor());
  skillEditorModal?.addEventListener("click", (e) => {
    if (e.target === skillEditorModal) closeSkillEditor();
  });

  // Auto-load skills toggle
  const autoLoadSkillsToggle = el.autoLoadSkillsToggle as HTMLInputElement | null;
  autoLoadSkillsToggle?.addEventListener("change", async () => {
    mason.autoLoadSkills = autoLoadSkillsToggle.checked;
    updateSkillsAutoLoadVisual();
    await window.api.skillsConfigSave({ autoLoadSkills: mason.autoLoadSkills });
  });

  // Upload Files
  document.getElementById("menuUploadFiles")?.addEventListener("click", async () => {
    popup?.classList.remove("open");
    if (mason.attachedFiles.length >= 5) {
      alert("Max 5 files attached. Remove one to add more.");
      return;
    }
    const result = (await window.api.showOpenDialog({
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
    })) as { canceled: boolean; filePaths: string[] };
    if (result.canceled || !result.filePaths.length) return;
    for (const filePath of result.filePaths) {
      if (mason.attachedFiles.length >= 5) {
        alert("Max 5 files reached");
        break;
      }
      if ((mason.attachedFiles as any[]).some((f) => f.path === filePath)) continue;
      try {
        const file = (await window.api.readFileForUpload({ filePath })) as any;
        (mason.attachedFiles as any[]).push({ ...file, path: filePath });
      } catch (e) {
        alert(`Could not attach "${filePath.split("/").pop()}": ${(e as Error).message}`);
      }
    }
    renderAttachmentChips();
  });

  // Settings view
  document.getElementById("menuSettings")?.addEventListener("click", () => {
    popup?.classList.remove("open");
    switchToSettingsView();
  });
  (el.settingsBtn as HTMLElement | null)?.addEventListener("click", () => switchToSettingsView());
  (el.settingsViewClose as HTMLElement | null)?.addEventListener("click", () => switchToChatsTab());

  // Update modal
  const updateModal = el.updateModal as HTMLElement | null;
  const updateLatest = el.updateLatest as HTMLElement | null;
  const updateNow = el.updateNow as HTMLButtonElement | null;
  const updateOpen = el.updateOpen as HTMLElement | null;
  function closeUpdateModal(): void {
    updateModal?.classList.remove("open");
  }
  (el.updateLater as HTMLElement | null)?.addEventListener("click", closeUpdateModal);
  (el.updateSkip as HTMLElement | null)?.addEventListener("click", () => {
    const skipped = (updateLatest?.textContent || "").replace(/^v/, "");
    if (skipped) localStorage.setItem("mason-skipped-update", skipped);
    closeUpdateModal();
  });
  updateOpen?.addEventListener("click", async () => {
    const url = (updateOpen as HTMLElement).dataset.url;
    if (url) await window.api.openReleasePage(url);
    closeUpdateModal();
  });
  updateNow?.addEventListener("click", async () => {
    const target = updateLatest?.textContent || "";
    if (
      !confirm(
        `Mason will quit and the installer will run in the background. Mason ${target} will relaunch automatically when finished (~1 minute).`
      )
    )
      return;
    updateNow.disabled = true;
    updateNow.textContent = "Updating…";
    try {
      const res = (await window.api.applyUpdate()) as { ok?: boolean; error?: string };
      if (!res || !res.ok) {
        alert(res?.error || "Auto-update failed.");
        updateNow.disabled = false;
        updateNow.textContent = "Update now";
      }
    } catch (e) {
      alert(`Auto-update failed: ${(e as Error).message}`);
      updateNow.disabled = false;
      updateNow.textContent = "Update now";
    }
  });
  updateModal?.addEventListener("click", (e) => {
    if (e.target === updateModal) closeUpdateModal();
  });
  (el.updateBtn as HTMLElement | null)?.addEventListener("click", () =>
    updateModal?.classList.add("open")
  );

  const autoLoadToggle = el.autoLoadToggle as HTMLInputElement | null;
  autoLoadToggle?.addEventListener("change", async () => {
    mason.autoLoadTools = autoLoadToggle.checked;
    updateToggleVisual();
    await window.api.settingsSave({ autoLoadTools: mason.autoLoadTools });
  });

  const defaultModelSelect = el.defaultModelSelect as HTMLSelectElement | null;
  defaultModelSelect?.addEventListener("change", async () => {
    const val = defaultModelSelect.value;
    if (!val) {
      mason.defaultModel = null;
    } else {
      const label = defaultModelSelect.options[defaultModelSelect.selectedIndex].textContent || "";
      mason.defaultModel = { value: val, label };
      selectModelByValue(val);
    }
    const profile = currentProfileName();
    const config = ((await window.api.workspaceLoad(profile)) || {}) as any;
    config.defaultModel = mason.defaultModel;
    await window.api.workspaceSave({ profile, config });
  });

  // ai-dev-kit MCP install / uninstall
  const devkitInstallBtn = el.devkitInstallBtn as HTMLButtonElement | null;
  const devkitUninstallBtn = el.devkitUninstallBtn as HTMLButtonElement | null;
  const devkitProgress = el.devkitProgress as HTMLElement | null;
  const devkitProgressText = el.devkitProgressText as HTMLElement | null;
  const devkitError = el.devkitError as HTMLElement | null;

  devkitInstallBtn?.addEventListener("click", async () => {
    if (devkitError) devkitError.style.display = "none";
    devkitInstallBtn.disabled = true;
    devkitInstallBtn.textContent = "Installing…";
    if (devkitProgress) devkitProgress.style.display = "";
    if (devkitProgressText) devkitProgressText.textContent = "Starting…";
    const onProgress = (payload: any): void => {
      const { phase, line } = payload || {};
      const labels: Record<string, string> = {
        "uv-check": "Checking for uv",
        "uv-install": "Installing uv",
        "devkit-install": "Installing AI Dev Kit",
        register: "Registering with Mason",
        done: "Done",
        error: "Error",
      };
      if (devkitProgressText) {
        devkitProgressText.textContent = `${labels[phase] || phase}${line ? `: ${line.slice(0, 80)}` : ""}`;
      }
    };
    window.api.onDevkitInstallProgress(onProgress);
    try {
      const profile = currentProfileName();
      await window.api.installDevkit({ profile });
      mason.autoConnectDone = false;
      if (typeof autoConnectMcp === "function") await autoConnectMcp();
      if (typeof renderMcpServerList === "function") renderMcpServerList();
      if (typeof renderMcpBadges === "function") renderMcpBadges();
    } catch (e) {
      if (devkitError) {
        devkitError.style.display = "";
        devkitError.textContent = (e as Error).message || "Install failed.";
      }
    } finally {
      window.api.removeDevkitInstallListeners();
      devkitInstallBtn.disabled = false;
      devkitInstallBtn.textContent = "Install";
      await renderDevkitStatus();
    }
  });

  devkitUninstallBtn?.addEventListener("click", async () => {
    if (
      !confirm(
        "Remove the Databricks AI Dev Kit (~/.ai-dev-kit) and unregister its MCP server from Mason?"
      )
    )
      return;
    devkitUninstallBtn.disabled = true;
    devkitUninstallBtn.textContent = "Removing…";
    try {
      const running = mason.mcpServers.find((s) => s.configName === "ai-dev-kit");
      if (running && running.key) {
        try {
          await window.api.mcpStdioDisconnect({ key: running.key });
        } catch (_) {}
        mason.mcpServers = mason.mcpServers.filter((s) => s !== running);
      }
      await window.api.uninstallDevkit();
      if (typeof renderMcpServerList === "function") renderMcpServerList();
      if (typeof renderMcpBadges === "function") renderMcpBadges();
    } catch (e) {
      alert(`Uninstall failed: ${(e as Error).message}`);
    } finally {
      devkitUninstallBtn.disabled = false;
      devkitUninstallBtn.textContent = "Uninstall";
      await renderDevkitStatus();
    }
  });

  const profileAddBtn = el.profileAddBtn as HTMLButtonElement | null;
  const profileHostInput = el.profileHostInput as HTMLInputElement | null;
  const profileNameInput = el.profileNameInput as HTMLInputElement | null;
  const profileAddError = el.profileAddError as HTMLElement | null;
  profileAddBtn?.addEventListener("click", async () => {
    if (profileAddError) profileAddError.style.display = "none";
    const host = profileHostInput?.value.trim() || "";
    if (!host) {
      if (profileAddError) {
        profileAddError.style.display = "";
        profileAddError.textContent = "Workspace URL is required.";
      }
      return;
    }
    if (!isValidDatabricksUrl(host)) {
      if (profileAddError) {
        profileAddError.style.display = "";
        profileAddError.textContent =
          "URL must be https://*.databricks.com, *.azuredatabricks.net, or *.databricksapps.com.";
      }
      return;
    }
    let name = profileNameInput?.value.trim() || "";
    if (!name) {
      try {
        name = new URL(host).hostname.split(".")[0];
      } catch (_) {
        name = "default";
      }
    }
    profileAddBtn.disabled = true;
    profileAddBtn.textContent = "Adding...";
    try {
      await window.api.addProfile({ name, host });
      if (profileHostInput) profileHostInput.value = "";
      if (profileNameInput) profileNameInput.value = "";
      await reloadProfiles(name);
      await renderProfilesList();
    } catch (e) {
      if (profileAddError) {
        profileAddError.style.display = "";
        profileAddError.textContent = (e as Error).message || "Failed to add profile.";
      }
    } finally {
      profileAddBtn.disabled = false;
      profileAddBtn.textContent = "Add Workspace";
    }
  });

  const endpointAdd = el.endpointAdd as HTMLButtonElement | null;
  const endpointModel = el.endpointModel as HTMLInputElement | null;
  const endpointName = el.endpointName as HTMLInputElement | null;
  const endpointUrl = el.endpointUrl as HTMLInputElement | null;
  endpointAdd?.addEventListener("click", async () => {
    const modelId = endpointModel?.value.trim() || "";
    if (!modelId) {
      alert("Model ID is required.");
      return;
    }
    const name = endpointName?.value.trim() || modelId;
    const url = endpointUrl?.value.trim() || null;
    mason.customEndpoints.push({
      name,
      gatewayUrl: url ? url.replace(/\/+$/, "") : null,
      modelId,
      format: "chat",
    });
    await saveCustomEndpoints();
    renderEndpointsList();
    if (endpointModel) endpointModel.value = "";
    if (endpointName) endpointName.value = "";
    if (endpointUrl) endpointUrl.value = "";
  });

  // MCP modal
  const mcpModal = el.mcpModal as HTMLElement | null;
  const ucMcpSearch = el.ucMcpSearch as HTMLInputElement | null;
  document.getElementById("menuMcp")?.addEventListener("click", () => {
    popup?.classList.remove("open");
    mcpModal?.classList.add("open");
    if (ucMcpSearch) ucMcpSearch.value = "";
    renderMcpServerList();
    refreshUcMcp();
  });
  (el.ucMcpRefresh as HTMLElement | null)?.addEventListener("click", () => refreshUcMcp());
  ucMcpSearch?.addEventListener("input", () => {
    if (cachedUcConnections.length > 0) renderUcMcpList(cachedUcConnections, ucMcpSearch.value);
  });
  (el.mcpModalClose as HTMLElement | null)?.addEventListener("click", () =>
    mcpModal?.classList.remove("open")
  );
  mcpModal?.addEventListener("click", (e) => {
    if (e.target === mcpModal) mcpModal.classList.remove("open");
  });

  // MCP HTTP connect
  const mcpModalConnect = el.mcpModalConnect as HTMLButtonElement | null;
  const mcpUrlInput = el.mcpUrlInput as HTMLInputElement | null;
  mcpModalConnect?.addEventListener("click", async () => {
    const url = mcpUrlInput?.value.trim() || "";
    if (!url) return;
    if (!getSelectedProfile()) {
      alert("Select a Databricks profile first.");
      return;
    }
    mcpModalConnect.textContent = "Connecting...";
    mcpModalConnect.disabled = true;
    try {
      await connectMcpServer(url);
      if (mcpUrlInput) mcpUrlInput.value = "";
      renderMcpServerList();
    } catch (e) {
      console.error(`[MCP UI] Connect failed:`, e);
      alert(`Failed to connect: ${(e as Error).message}`);
    } finally {
      mcpModalConnect.textContent = "Connect Remote";
      mcpModalConnect.disabled = false;
    }
  });

  // MCP stdio
  const mcpStdioBrowse = el.mcpStdioBrowse as HTMLButtonElement | null;
  const mcpStdioPath = el.mcpStdioPath as HTMLInputElement | null;
  const mcpStdioLoad = el.mcpStdioLoad as HTMLButtonElement | null;
  mcpStdioBrowse?.addEventListener("click", async () => {
    const result = (await window.api.showOpenDialog({
      title: "Select .mcp.json file",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    })) as { canceled: boolean; filePaths: string[] };
    if (!result.canceled && result.filePaths.length > 0 && mcpStdioPath) {
      mcpStdioPath.value = result.filePaths[0];
    }
  });
  mcpStdioLoad?.addEventListener("click", async () => {
    const filePath = mcpStdioPath?.value.trim() || "";
    if (!filePath) return;
    mcpStdioLoad.textContent = "Loading...";
    mcpStdioLoad.disabled = true;
    try {
      const servers = (await window.api.mcpReadConfig({ filePath })) as Record<
        string,
        MasonMcpStdioConfig
      >;
      for (const [name, config] of Object.entries(servers)) {
        const key = `stdio:${config.command}:${(config.args || []).join(":")}`;
        if (mason.mcpServers.some((s) => s.key === key)) continue;
        try {
          const result = (await window.api.mcpStdioConnect({
            config: { name, ...config },
          })) as { key: string; serverInfo: { name?: string }; tools: any[] };
          mason.mcpServers.push({
            type: "stdio",
            key: result.key,
            config,
            configName: name,
            serverInfo: result.serverInfo,
            tools: result.tools,
          });
          maybeDisableTools(result.tools);
        } catch (e) {
          alert(`Failed to connect "${name}": ${(e as Error).message}`);
        }
      }
      if (mcpStdioPath) mcpStdioPath.value = "";
      renderMcpServerList();
      renderMcpBadges();
      saveMcpConfig();
    } catch (e) {
      alert(`Failed to load: ${(e as Error).message}`);
    } finally {
      mcpStdioLoad.textContent = "Load from file";
      mcpStdioLoad.disabled = false;
    }
  });

  // Profile change
  const profileEl = el.profile as HTMLSelectElement | null;
  profileEl?.addEventListener("change", async () => {
    const profileName = currentProfileName();
    console.log(`[WORKSPACE] Switching to profile: ${profileName}`);

    try {
      await window.api.clearTokenCache();
    } catch (_) {}

    try {
      await getAuthToken();
    } catch (_) {
      addMessageEl(
        "tool-call",
        `Profile "${profileName}" needs authentication — opening browser…`
      );
      try {
        const result = await window.api.oauthLogin(profileName);
        if (!result?.success) {
          addMessageEl(
            "error",
            `OAuth login failed for "${profileName}". Click Authenticate in the + menu to retry.`
          );
        }
      } catch (e) {
        addMessageEl(
          "error",
          `OAuth login failed for "${profileName}": ${(e as Error).message}. Click Authenticate in the + menu to retry.`
        );
      }
    }

    let reboundNames: string[] = [];
    try {
      const result = await window.api.mcpStdioRebindProfile({ profile: profileName });
      reboundNames = result.rebound || [];
      if (reboundNames.length > 0) {
        console.log(`[WORKSPACE] Rebinding stdio MCPs to "${profileName}":`, reboundNames.join(", "));
      }
    } catch (e) {
      console.error("[WORKSPACE] Stdio rebind failed:", (e as Error).message);
    }

    mason.mcpServers = mason.mcpServers.filter(
      (s) => s.type === "stdio" && !reboundNames.includes(s.configName || "")
    );
    clearUcMcpCache();
    renderMcpBadges();
    await loadWorkspaceConfig();

    mason.autoConnectDone = false;
    await autoConnectMcp();
    if (mason.currentView === "dashboards") loadDashboards();
  });

  // Chat send
  (el.send as HTMLElement | null)?.addEventListener("click", send);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  (el.newChat as HTMLElement | null)?.addEventListener("click", newChat);

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "n") {
      e.preventDefault();
      newChat();
    }
    if (mod && e.key === "l") {
      e.preventDefault();
      inputEl?.focus();
    }
    if (mod && e.key === ",") {
      e.preventDefault();
      switchToSettingsView();
    }
    if (mod && e.key === "b") {
      e.preventDefault();
      (el.sidebar as HTMLElement | null)?.classList.toggle("hidden");
    }
    if (e.key === "Escape") {
      popup?.classList.remove("open");
      modelMenu?.classList.remove("open");
      toolsModal?.classList.remove("open");
      mcpModal?.classList.remove("open");
      skillsModal?.classList.remove("open");
      skillEditorModal?.classList.remove("open");
      if (mason.currentView === "settings") switchToChatsTab();
    }
  });
}

// --- Startup ---

async function initApp(): Promise<void> {
  initDomRefs();
  setupMarkdown();

  window.api
    .getAppVersion()
    .then((v) => {
      console.log(`[VERSION] getAppVersion returned: ${JSON.stringify(v)}`);
      const el = document.getElementById("sidebarVersion");
      if (v && el) el.textContent = `v${v}`;
    })
    .catch((e) => console.error("[VERSION] getAppVersion failed:", (e as Error).message));
  if (navigator.onLine) {
    Promise.resolve()
      .then(() => checkForUpdates())
      .catch((e) => console.error("[UPDATE]", (e as Error).message));
  }

  mason.settings = (await window.api.settingsLoad()) as MasonSettings;

  const lsDark = localStorage.getItem("mason-dark-mode");
  const lsPrompt = localStorage.getItem("mason-system-prompt");
  if ((lsDark || lsPrompt) && !mason.settings.systemPrompt && !mason.settings.darkMode) {
    const migrated = {
      darkMode: lsDark === "1",
      systemPrompt: lsPrompt || "",
    };
    mason.settings = (await window.api.settingsSave(migrated)) as unknown as MasonSettings;
    if (lsDark) localStorage.removeItem("mason-dark-mode");
    if (lsPrompt) localStorage.removeItem("mason-system-prompt");
  }
  mason.autoLoadTools = mason.settings.autoLoadTools !== false;
  mason.systemPrompt = mason.settings.systemPrompt || "";

  initEventListeners();
  initDashboardListener();

  // Skills are independent of profile/workspace state — load once at startup.
  await refreshSkillsState();

  await loadProfiles();

  if (!mason.profiles || mason.profiles.length === 0) {
    await showOnboarding();
    refreshHistory();
    return;
  }

  await loadWorkspaceConfig();

  refreshHistory();
  await autoConnectMcp();

  setInterval(async () => {
    if (mason.history.length > 0 && mason.currentChatId) {
      await saveCurrentChat();
    }
  }, 10000);
}

async function checkForUpdates(): Promise<void> {
  const result = (await window.api.checkUpdate()) as any;
  if (!result || !result.hasUpdate) return;
  const skipped = localStorage.getItem("mason-skipped-update");
  if (skipped === result.latest) {
    console.log(`[UPDATE] Skipping prompt for ${result.latest} (user-skipped).`);
    const updateBtn = mason.el.updateBtn as HTMLElement | null;
    if (updateBtn) updateBtn.style.display = "";
    return;
  }
  const latest = mason.el.updateLatest as HTMLElement | null;
  const current = mason.el.updateCurrent as HTMLElement | null;
  const open = mason.el.updateOpen as HTMLElement | null;
  const notes = mason.el.updateNotes as HTMLElement | null;
  const updateNow = mason.el.updateNow as HTMLElement | null;
  const updateBtn = mason.el.updateBtn as HTMLElement | null;
  const updateModal = mason.el.updateModal as HTMLElement | null;
  if (latest) latest.textContent = `v${result.latest}`;
  if (current) current.textContent = `v${result.current}`;
  if (open) (open as HTMLElement).dataset.url = result.releaseUrl || "";
  if (result.notes && notes) {
    notes.textContent = result.notes;
    notes.style.display = "";
  }
  if (result.autoUpdateSupported && updateNow) {
    updateNow.style.display = "";
  }
  if (updateBtn) updateBtn.style.display = "";
  updateModal?.classList.add("open");
}

// Global error handlers
window.addEventListener("error", (e) => {
  console.error("[ERROR]", e.error?.message || e.message);
  try {
    addMessageEl("error", `Unexpected error: ${e.error?.message || e.message}`);
  } catch (_) {}
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[ERROR] Unhandled rejection:", e.reason?.message || e.reason);
});

// Boot
initApp();
