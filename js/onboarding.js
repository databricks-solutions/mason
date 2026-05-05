// First-launch onboarding wizard. Three steps: CLI install -> profile creation
// -> OAuth sign-in. Reused for re-onboarding when a user removes the only
// profile from Settings.

const onboarding = {
  el: {},
  cliReady: false,
  profileSaved: null, // { name, host }
};

function obEl(id) { return document.getElementById(id); }

function setStepState(stepEl, state) {
  // state: "pending" | "active" | "done"
  stepEl.dataset.state = state;
}

function setOnboardingError(el, message) {
  if (!message) { el.style.display = "none"; el.textContent = ""; return; }
  el.style.display = "";
  el.textContent = message;
}

function deriveProfileName(hostUrl) {
  try {
    const u = new URL(hostUrl);
    // workspace.cloud.databricks.com -> "workspace"
    const first = u.hostname.split(".")[0];
    return first || "default";
  } catch (_) { return "default"; }
}

async function showOnboarding() {
  mason.currentView = "onboarding";
  // Hide all other panes; mirrors the dashboards/settings switch pattern.
  document.querySelector(".main").style.display = "none";
  if (mason.el.dashboardView) mason.el.dashboardView.classList.remove("visible");
  if (mason.el.dashboardWebview) mason.el.dashboardWebview.style.display = "none";
  if (mason.el.settingsView) mason.el.settingsView.classList.remove("visible");
  if (mason.el.settingsViewClose) mason.el.settingsViewClose.style.display = "none";
  obEl("onboardingView").classList.add("visible");

  // Cache step elements once.
  onboarding.el = {
    stepCli: obEl("onboardingStepCli"),
    stepWorkspace: obEl("onboardingStepWorkspace"),
    stepAuth: obEl("onboardingStepAuth"),
    cliDetail: obEl("onboardingCliDetail"),
    installBtn: obEl("onboardingInstallCli"),
    progressWrap: obEl("onboardingCliProgress"),
    progressFill: obEl("onboardingCliProgressFill"),
    progressText: obEl("onboardingCliProgressText"),
    host: obEl("onboardingHost"),
    name: obEl("onboardingName"),
    saveProfile: obEl("onboardingSaveProfile"),
    profileError: obEl("onboardingProfileError"),
    signIn: obEl("onboardingSignIn"),
    authError: obEl("onboardingAuthError"),
  };

  await checkCliStep();

  onboarding.el.host.addEventListener("input", () => {
    if (!onboarding.el.name.value) {
      onboarding.el.name.placeholder = `Profile name (defaults to "${deriveProfileName(onboarding.el.host.value)}")`;
    }
  });

  onboarding.el.installBtn.addEventListener("click", runCliInstall);
  onboarding.el.saveProfile.addEventListener("click", runSaveProfile);
  onboarding.el.signIn.addEventListener("click", runSignIn);
}

async function checkCliStep() {
  setStepState(onboarding.el.stepCli, "active");
  onboarding.el.cliDetail.textContent = "Checking…";
  onboarding.el.installBtn.style.display = "none";
  onboarding.el.progressWrap.style.display = "none";

  const result = await window.api.detectCli();
  if (result.installed) {
    onboarding.el.cliDetail.textContent = `Found at ${result.path}${result.version ? ` (${result.version.split("\n")[0]})` : ""}`;
    setStepState(onboarding.el.stepCli, "done");
    onboarding.cliReady = true;
    activateWorkspaceStep();
  } else {
    onboarding.el.cliDetail.textContent = "Not installed. Mason can install it for you (downloads ~30 MB to ~/.mason/bin).";
    onboarding.el.installBtn.style.display = "";
  }
}

async function runCliInstall() {
  onboarding.el.installBtn.disabled = true;
  onboarding.el.installBtn.textContent = "Installing…";
  onboarding.el.progressWrap.style.display = "";
  onboarding.el.progressFill.style.width = "0%";
  onboarding.el.progressText.textContent = "Starting…";

  const onProgress = ({ phase, percent }) => {
    let label = phase;
    if (phase === "query-release") label = "Looking up latest release";
    else if (phase === "download") label = `Downloading… ${percent}%`;
    else if (phase === "extract") label = "Extracting";
    else if (phase === "done") label = "Done";
    else if (phase === "error") label = "Error";
    onboarding.el.progressText.textContent = label;
    if (typeof percent === "number") {
      onboarding.el.progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }
  };
  window.api.onCliInstallProgress(onProgress);

  try {
    const result = await window.api.installCli();
    onboarding.el.cliDetail.textContent = `Installed at ${result.path}${result.version ? ` (${result.version.split("\n")[0]})` : ""}`;
    onboarding.el.installBtn.style.display = "none";
    onboarding.el.progressWrap.style.display = "none";
    setStepState(onboarding.el.stepCli, "done");
    onboarding.cliReady = true;
    activateWorkspaceStep();
  } catch (e) {
    onboarding.el.installBtn.disabled = false;
    onboarding.el.installBtn.textContent = "Retry install";
    onboarding.el.progressText.textContent = e.message || "Install failed";
    onboarding.el.progressFill.style.width = "0%";
  } finally {
    window.api.removeCliInstallListeners();
  }
}

function activateWorkspaceStep() {
  setStepState(onboarding.el.stepWorkspace, "active");
  onboarding.el.host.disabled = false;
  onboarding.el.name.disabled = false;
  onboarding.el.saveProfile.disabled = false;
  onboarding.el.host.focus();
}

async function runSaveProfile() {
  setOnboardingError(onboarding.el.profileError, null);
  const host = onboarding.el.host.value.trim();
  if (!host) { setOnboardingError(onboarding.el.profileError, "Workspace URL is required."); return; }
  const name = onboarding.el.name.value.trim() || deriveProfileName(host);

  onboarding.el.saveProfile.disabled = true;
  onboarding.el.saveProfile.textContent = "Saving…";
  try {
    await window.api.addProfile({ name, host });
    onboarding.profileSaved = { name, host };
    setStepState(onboarding.el.stepWorkspace, "done");
    onboarding.el.host.disabled = true;
    onboarding.el.name.disabled = true;
    onboarding.el.saveProfile.textContent = `Saved [${name}]`;

    // Reload profiles in the sidebar dropdown so the new one is selectable
    // even before sign-in completes.
    if (typeof reloadProfiles === "function") await reloadProfiles(name);

    setStepState(onboarding.el.stepAuth, "active");
    onboarding.el.signIn.disabled = false;
    onboarding.el.signIn.focus();
  } catch (e) {
    onboarding.el.saveProfile.disabled = false;
    onboarding.el.saveProfile.textContent = "Save workspace";
    setOnboardingError(onboarding.el.profileError, e.message || "Failed to save profile.");
  }
}

async function runSignIn() {
  setOnboardingError(onboarding.el.authError, null);
  if (!onboarding.profileSaved) return;
  onboarding.el.signIn.disabled = true;
  onboarding.el.signIn.textContent = "Opening browser…";
  try {
    const result = await window.api.oauthLogin(onboarding.profileSaved.name);
    if (!result.success) throw new Error(result.error || "Sign-in failed");
    setStepState(onboarding.el.stepAuth, "done");
    onboarding.el.signIn.textContent = "Signed in";
    // Hand off to the chat view + trigger normal post-auth flow.
    await finishOnboarding();
  } catch (e) {
    onboarding.el.signIn.disabled = false;
    onboarding.el.signIn.textContent = "Retry sign-in";
    setOnboardingError(onboarding.el.authError, e.message || "Sign-in failed");
  }
}

async function finishOnboarding() {
  obEl("onboardingView").classList.remove("visible");
  // Re-run the normal startup tail: load workspace config, discover models,
  // auto-connect MCP.
  if (typeof loadWorkspaceConfig === "function") await loadWorkspaceConfig();
  if (typeof autoConnectMcp === "function") {
    mason.autoConnectDone = false;
    await autoConnectMcp();
  }
  if (typeof switchToChatsTab === "function") switchToChatsTab();
}
