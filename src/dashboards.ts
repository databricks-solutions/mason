// Dashboard navigation and display.

declare function getSelectedProfile():
  | { name: string; host?: string }
  | undefined;
declare function getAuthToken(): Promise<string>;
declare function updateToggleVisual(): void;
declare function populateDefaultModelSelect(): void;
declare function renderEndpointsList(): void;
declare function renderProfilesList(): void;
declare function refreshSkillsState(): Promise<void>;
declare function renderSkillsSettingsList(): void;
declare function updateSkillsAutoLoadVisual(): void;

function elAs<T extends HTMLElement>(key: string): T | null {
  return mason.el[key] as T | null;
}

function switchToChatsTab(): void {
  mason.currentView = "chat";
  const search = elAs<HTMLInputElement>("sidebarSearch");
  if (search) {
    search.value = "";
    search.placeholder = "Search chats...";
  }
  elAs<HTMLElement>("navChats")?.classList.add("active");
  elAs<HTMLElement>("navDashboards")?.classList.remove("active");
  const newChatEl = elAs<HTMLElement>("newChat");
  if (newChatEl) newChatEl.style.display = "";
  const historyList = elAs<HTMLElement>("historyList");
  if (historyList) historyList.style.display = "";
  elAs<HTMLElement>("dashboardList")?.classList.remove("visible");
  const main = document.querySelector(".main") as HTMLElement | null;
  if (main) main.style.display = "";
  elAs<HTMLElement>("dashboardView")?.classList.remove("visible");
  const webview = elAs<HTMLElement>("dashboardWebview");
  if (webview) webview.style.display = "none";
  elAs<HTMLElement>("settingsView")?.classList.remove("visible");
  const settingsClose = elAs<HTMLElement>("settingsViewClose");
  if (settingsClose) settingsClose.style.display = "none";
  elAs<HTMLElement>("onboardingView")?.classList.remove("visible");
}

function switchToDashboardsTab(): void {
  mason.currentView = "dashboards";
  const search = elAs<HTMLInputElement>("sidebarSearch");
  if (search) {
    search.value = "";
    search.placeholder = "Search dashboards...";
  }
  elAs<HTMLElement>("navDashboards")?.classList.add("active");
  elAs<HTMLElement>("navChats")?.classList.remove("active");
  const newChatEl = elAs<HTMLElement>("newChat");
  if (newChatEl) newChatEl.style.display = "none";
  const historyList = elAs<HTMLElement>("historyList");
  if (historyList) historyList.style.display = "none";
  elAs<HTMLElement>("dashboardList")?.classList.add("visible");
  const main = document.querySelector(".main") as HTMLElement | null;
  if (main) main.style.display = "none";
  elAs<HTMLElement>("dashboardView")?.classList.remove("visible");
  const webview = elAs<HTMLElement>("dashboardWebview");
  if (webview) webview.style.display = "none";
  elAs<HTMLElement>("settingsView")?.classList.remove("visible");
  const settingsClose = elAs<HTMLElement>("settingsViewClose");
  if (settingsClose) settingsClose.style.display = "none";
  loadDashboards();
}

function switchToSettingsView(): void {
  mason.currentView = "settings";
  const autoLoadToggle = elAs<HTMLInputElement>("autoLoadToggle");
  if (autoLoadToggle) autoLoadToggle.checked = mason.autoLoadTools;
  if (typeof updateToggleVisual === "function") updateToggleVisual();
  if (typeof populateDefaultModelSelect === "function") populateDefaultModelSelect();
  if (typeof renderEndpointsList === "function") renderEndpointsList();
  const main = document.querySelector(".main") as HTMLElement | null;
  if (main) main.style.display = "none";
  elAs<HTMLElement>("dashboardView")?.classList.remove("visible");
  const webview = elAs<HTMLElement>("dashboardWebview");
  if (webview) webview.style.display = "none";
  elAs<HTMLElement>("settingsView")?.classList.add("visible");
  const settingsClose = elAs<HTMLElement>("settingsViewClose");
  if (settingsClose) settingsClose.style.display = "inline-block";
  elAs<HTMLElement>("onboardingView")?.classList.remove("visible");
  if (typeof renderProfilesList === "function") renderProfilesList();
  if (typeof refreshSkillsState === "function") {
    refreshSkillsState().then(() => {
      if (typeof renderSkillsSettingsList === "function") renderSkillsSettingsList();
    });
  }
}

function openDashboard(dashboard: MasonDashboard): void {
  mason.currentView = "dashboard-detail";
  const profile = getSelectedProfile();
  if (!profile || !profile.host) return;
  const host = profile.host.replace(/\/+$/, "");
  const embedUrl = `${host}/embed/dashboardsv3/${dashboard.id}`;
  console.log(`[DASHBOARDS] Opening: ${dashboard.name} -> ${embedUrl}`);
  const main = document.querySelector(".main") as HTMLElement | null;
  if (main) main.style.display = "none";
  elAs<HTMLElement>("dashboardView")?.classList.add("visible");
  const webview = mason.el.dashboardWebview as HTMLIFrameElement | null;
  if (webview) {
    webview.style.display = "";
    webview.src = embedUrl;
  }
}

async function loadDashboards(): Promise<void> {
  const listEl = elAs<HTMLElement>("dashboardList");
  if (listEl) {
    listEl.innerHTML =
      '<div style="padding:12px;opacity:0.4;font-size:0.83rem;">Loading dashboards...</div>';
  }
  const profile = getSelectedProfile();
  if (!profile || !profile.host) {
    if (listEl) {
      listEl.innerHTML =
        '<div style="padding:12px;opacity:0.4;font-size:0.83rem;">Select a profile first.</div>';
    }
    return;
  }
  const token = await getAuthToken();
  const result = (await window.api.listDashboards({ host: profile.host, token })) as {
    dashboards?: MasonDashboard[];
    hasMore?: boolean;
  };
  mason.dashboardsList = result.dashboards || [];
  mason.dashboardsLoading = result.hasMore || false;
  renderDashboardList();
}

function initDashboardListener(): void {
  window.api.onDashboardsUpdated((dashboards) => {
    mason.dashboardsList = dashboards as MasonDashboard[];
    mason.dashboardsLoading = false;
    if (mason.currentView === "dashboards") {
      const search = elAs<HTMLInputElement>("sidebarSearch");
      renderDashboardList(search?.value || "");
    }
  });
}

function renderDashboardList(filter: string = ""): void {
  const listEl = elAs<HTMLElement>("dashboardList");
  if (!listEl) return;
  listEl.innerHTML = "";
  if (mason.dashboardsList.length === 0) {
    listEl.innerHTML =
      '<div style="padding:12px;opacity:0.4;font-size:0.83rem;">No dashboards found.</div>';
    return;
  }

  const query = filter.toLowerCase();
  const filtered = mason.dashboardsList.filter(
    (d) => !query || d.name.toLowerCase().includes(query)
  );

  const MAX_VISIBLE = 50;
  const visible = filtered.slice(0, MAX_VISIBLE);

  if (filtered.length === 0 && query) {
    listEl.innerHTML =
      '<div style="padding:12px;opacity:0.4;font-size:0.83rem;">No matching dashboards.</div>';
    return;
  }

  for (const d of visible) {
    const div = document.createElement("div");
    div.className = "dashboard-item";
    div.textContent = d.name;
    div.addEventListener("click", () => openDashboard(d));
    listEl.appendChild(div);
  }

  if (filtered.length > MAX_VISIBLE) {
    const more = document.createElement("div");
    more.style.cssText = "padding:8px 12px;opacity:0.4;font-size:0.78rem;text-align:center;";
    more.textContent = `Showing ${MAX_VISIBLE} of ${filtered.length} dashboards — use search to filter`;
    listEl.appendChild(more);
  }

  if (mason.dashboardsLoading) {
    const loading = document.createElement("div");
    loading.style.cssText = "padding:6px 12px;opacity:0.4;font-size:0.78rem;text-align:center;font-style:italic;";
    loading.textContent = "Loading more dashboards...";
    listEl.appendChild(loading);
  }
}
