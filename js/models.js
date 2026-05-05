// Model discovery and picker

async function discoverModels() {
  if (!mason.workspaceGatewayUrl) {
    console.log("[MODELS] No gateway URL, skipping discovery");
    mason.discoveredModels = [];
    renderModelMenu();
    return;
  }
  // Show loading state — but keep default model label if one is set
  if (!mason.defaultModel) {
    mason.el.modelBtnLabel.textContent = "Loading...";
  }
  let models;
  try {
    const token = await getAuthToken();
    console.log("[MODELS] Discovering models...");
    models = await window.api.discoverModels({ gatewayUrl: mason.workspaceGatewayUrl, token });
  } catch (e) {
    console.error("[MODELS] Discovery failed:", e.message);
    mason.el.modelBtnLabel.textContent = mason.selectedModelLabel;
    return;
  }

  const groups = {};
  for (const m of models) {
    if (!groups[m.provider]) groups[m.provider] = [];
    groups[m.provider].push({ value: m.value, label: m.label });
  }
  const order = ["Anthropic", "Google", "Meta", "OpenAI"];
  mason.discoveredModels = [];
  for (const p of order) {
    if (groups[p]) { mason.discoveredModels.push({ group: p, models: groups[p] }); delete groups[p]; }
  }
  for (const [p, ms] of Object.entries(groups)) {
    mason.discoveredModels.push({ group: p, models: ms });
  }

  console.log(`[MODELS] Loaded ${models.length} models in ${mason.discoveredModels.length} groups`);
  renderModelMenu();

  const allValues = models.map((m) => m.value);
  if (allValues.length > 0 && !allValues.includes(mason.selectedModelValue) && !mason.selectedModelValue.startsWith("custom:")) {
    if (mason.defaultModel && allValues.includes(mason.defaultModel.value)) {
      selectModelByValue(mason.defaultModel.value);
    } else {
      selectModelByValue(allValues[0]);
    }
  }
}

function selectModelByValue(value) {
  mason.selectedModelValue = value;
  for (const g of mason.discoveredModels) {
    for (const m of g.models) {
      if (m.value === value) { mason.selectedModelLabel = m.label; mason.el.modelBtnLabel.textContent = m.label; return; }
    }
  }
  for (const ep of mason.customEndpoints) {
    if (`custom:${ep.modelId}` === value) { mason.selectedModelLabel = ep.name; mason.el.modelBtnLabel.textContent = ep.name; return; }
  }
  mason.selectedModelLabel = value;
  mason.el.modelBtnLabel.textContent = value;
}

function renderModelMenu() {
  const menuEl = mason.el.modelMenu;
  menuEl.innerHTML = "";
  if (mason.discoveredModels.length === 0 && mason.customEndpoints.length === 0) {
    menuEl.innerHTML = '<div style="padding:12px 14px;opacity:0.4;font-size:0.83rem;">No models available. Set the AI Gateway URL in Settings.</div>';
    return;
  }
  for (const g of mason.discoveredModels) {
    const groupEl = document.createElement("div");
    groupEl.className = "model-menu-group";
    groupEl.textContent = g.group;
    menuEl.appendChild(groupEl);
    for (const m of g.models) {
      const item = document.createElement("div");
      item.className = `model-menu-item${m.value === mason.selectedModelValue ? " active" : ""}`;
      item.innerHTML = `<span class="check">${m.value === mason.selectedModelValue ? "&#10003;" : ""}</span>${escapeHtml(m.label)}`;
      item.addEventListener("click", () => {
        mason.selectedModelValue = m.value;
        mason.selectedModelLabel = m.label;
        mason.el.modelBtnLabel.textContent = m.label;
        menuEl.classList.remove("open");
        renderModelMenu();
      });
      menuEl.appendChild(item);
    }
  }
  if (mason.customEndpoints.length > 0) {
    const groupEl = document.createElement("div");
    groupEl.className = "model-menu-group";
    groupEl.textContent = "Custom";
    menuEl.appendChild(groupEl);
    for (const ep of mason.customEndpoints) {
      const val = `custom:${ep.modelId}`;
      const item = document.createElement("div");
      item.className = `model-menu-item${val === mason.selectedModelValue ? " active" : ""}`;
      item.innerHTML = `<span class="check">${val === mason.selectedModelValue ? "&#10003;" : ""}</span>${escapeHtml(ep.name)}`;
      item.addEventListener("click", () => {
        mason.selectedModelValue = val;
        mason.selectedModelLabel = ep.name;
        mason.el.modelBtnLabel.textContent = ep.name;
        menuEl.classList.remove("open");
        renderModelMenu();
      });
      menuEl.appendChild(item);
    }
  }
}

// Compat shim used by chatLoop
const modelEl = {
  get value() { return mason.selectedModelValue; },
  set value(v) { selectModelByValue(v); },
};
