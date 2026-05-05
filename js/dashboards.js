// Dashboard navigation and display

function switchToChatsTab() {
  mason.currentView = "chat";
  mason.el.sidebarSearch.value = "";
  mason.el.sidebarSearch.placeholder = "Search chats...";
  mason.el.navChats.classList.add("active");
  mason.el.navDashboards.classList.remove("active");
  mason.el.newChat.style.display = "";
  mason.el.historyList.style.display = "";
  mason.el.dashboardList.classList.remove("visible");
  document.querySelector(".main").style.display = "";
  mason.el.dashboardView.classList.remove("visible");
  mason.el.dashboardWebview.style.display = "none";
  if (mason.el.settingsView) mason.el.settingsView.classList.remove("visible");
  if (mason.el.settingsViewClose) mason.el.settingsViewClose.style.display = "none";
}

function switchToDashboardsTab() {
  mason.currentView = "dashboards";
  mason.el.sidebarSearch.value = "";
  mason.el.sidebarSearch.placeholder = "Search dashboards...";
  mason.el.navDashboards.classList.add("active");
  mason.el.navChats.classList.remove("active");
  mason.el.newChat.style.display = "none";
  mason.el.historyList.style.display = "none";
  mason.el.dashboardList.classList.add("visible");
  document.querySelector(".main").style.display = "none";
  mason.el.dashboardView.classList.remove("visible");
  mason.el.dashboardWebview.style.display = "none";
  if (mason.el.settingsView) mason.el.settingsView.classList.remove("visible");
  if (mason.el.settingsViewClose) mason.el.settingsViewClose.style.display = "none";
  loadDashboards();
}

function switchToSettingsView() {
  mason.currentView = "settings";
  // Sync settings UI with current state
  mason.el.autoLoadToggle.checked = mason.autoLoadTools;
  if (typeof updateToggleVisual === "function") updateToggleVisual();
  if (typeof populateDefaultModelSelect === "function") populateDefaultModelSelect();
  if (typeof renderEndpointsList === "function") renderEndpointsList();
  // Hide other panes
  document.querySelector(".main").style.display = "none";
  mason.el.dashboardView.classList.remove("visible");
  mason.el.dashboardWebview.style.display = "none";
  mason.el.settingsView.classList.add("visible");
  mason.el.settingsViewClose.style.display = "inline-block";
}

function openDashboard(dashboard) {
  mason.currentView = "dashboard-detail";
  const profile = getSelectedProfile();
  if (!profile) return;
  const host = profile.host.replace(/\/+$/, "");
  const embedUrl = `${host}/embed/dashboardsv3/${dashboard.id}`;
  console.log(`[DASHBOARDS] Opening: ${dashboard.name} -> ${embedUrl}`);
  document.querySelector(".main").style.display = "none";
  mason.el.dashboardView.classList.add("visible");
  mason.el.dashboardWebview.style.display = "";
  mason.el.dashboardWebview.src = embedUrl;
}

async function loadDashboards() {
  mason.el.dashboardList.innerHTML = '<div style="padding:12px;opacity:0.4;font-size:0.83rem;">Loading dashboards...</div>';
  const profile = getSelectedProfile();
  if (!profile) {
    mason.el.dashboardList.innerHTML = '<div style="padding:12px;opacity:0.4;font-size:0.83rem;">Select a profile first.</div>';
    return;
  }
  const token = await getAuthToken();
  const result = await window.api.listDashboards({ host: profile.host, token });
  mason.dashboardsList = result.dashboards || [];
  mason.dashboardsLoading = result.hasMore || false;
  renderDashboardList();
}

function initDashboardListener() {
  window.api.onDashboardsUpdated((dashboards) => {
    mason.dashboardsList = dashboards;
    mason.dashboardsLoading = false;
    if (mason.currentView === "dashboards") {
      renderDashboardList(mason.el.sidebarSearch.value);
    }
  });
}

function renderDashboardList(filter = "") {
  mason.el.dashboardList.innerHTML = "";
  if (mason.dashboardsList.length === 0) {
    mason.el.dashboardList.innerHTML = '<div style="padding:12px;opacity:0.4;font-size:0.83rem;">No dashboards found.</div>';
    return;
  }

  const query = filter.toLowerCase();
  const filtered = mason.dashboardsList.filter((d) => !query || d.name.toLowerCase().includes(query));

  const MAX_VISIBLE = 50;
  const visible = filtered.slice(0, MAX_VISIBLE);

  if (filtered.length === 0 && query) {
    mason.el.dashboardList.innerHTML = '<div style="padding:12px;opacity:0.4;font-size:0.83rem;">No matching dashboards.</div>';
    return;
  }

  for (const d of visible) {
    const div = document.createElement("div");
    div.className = "dashboard-item";
    div.textContent = d.name;
    div.addEventListener("click", () => openDashboard(d));
    mason.el.dashboardList.appendChild(div);
  }

  if (filtered.length > MAX_VISIBLE) {
    const more = document.createElement("div");
    more.style.cssText = "padding:8px 12px;opacity:0.4;font-size:0.78rem;text-align:center;";
    more.textContent = `Showing ${MAX_VISIBLE} of ${filtered.length} dashboards — use search to filter`;
    mason.el.dashboardList.appendChild(more);
  }

  if (mason.dashboardsLoading) {
    const loading = document.createElement("div");
    loading.style.cssText = "padding:6px 12px;opacity:0.4;font-size:0.78rem;text-align:center;font-style:italic;";
    loading.textContent = "Loading more dashboards...";
    mason.el.dashboardList.appendChild(loading);
  }
}
