// First-launch onboarding wizard. Three steps: CLI install -> profile creation
// -> OAuth sign-in. Reused for re-onboarding when a user removes the only
// profile from Settings.

declare function reloadProfiles(name?: string): Promise<void>;
declare function loadWorkspaceConfig(): Promise<void>;
declare function autoConnectMcp(): Promise<void>;

interface OnboardingState {
  el: Record<string, HTMLElement | null>;
  cliReady: boolean;
  profileSaved: { name: string; host: string } | null;
}

const onboarding: OnboardingState = {
  el: {},
  cliReady: false,
  profileSaved: null,
};

function obEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setStepState(stepEl: HTMLElement | null, state: "pending" | "active" | "done"): void {
  if (!stepEl) return;
  stepEl.dataset.state = state;
}

function setOnboardingError(el: HTMLElement | null, message: string | null): void {
  if (!el) return;
  if (!message) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "";
  el.textContent = message;
}

function deriveProfileName(hostUrl: string): string {
  try {
    const u = new URL(hostUrl);
    const first = u.hostname.split(".")[0];
    return first || "default";
  } catch (_) {
    return "default";
  }
}

async function showOnboarding(): Promise<void> {
  mason.currentView = "onboarding";
  const main = document.querySelector(".main") as HTMLElement | null;
  if (main) main.style.display = "none";
  (mason.el.dashboardView as HTMLElement | null)?.classList.remove("visible");
  const webview = mason.el.dashboardWebview as HTMLElement | null;
  if (webview) webview.style.display = "none";
  (mason.el.settingsView as HTMLElement | null)?.classList.remove("visible");
  const settingsClose = mason.el.settingsViewClose as HTMLElement | null;
  if (settingsClose) settingsClose.style.display = "none";
  obEl("onboardingView")?.classList.add("visible");

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

  const hostInput = onboarding.el.host as HTMLInputElement | null;
  const nameInput = onboarding.el.name as HTMLInputElement | null;
  hostInput?.addEventListener("input", () => {
    if (nameInput && !nameInput.value && hostInput) {
      nameInput.placeholder = `Profile name (defaults to "${deriveProfileName(hostInput.value)}")`;
    }
  });

  onboarding.el.installBtn?.addEventListener("click", runCliInstall);
  onboarding.el.saveProfile?.addEventListener("click", runSaveProfile);
  onboarding.el.signIn?.addEventListener("click", runSignIn);
}

async function checkCliStep(): Promise<void> {
  setStepState(onboarding.el.stepCli, "active");
  if (onboarding.el.cliDetail) onboarding.el.cliDetail.textContent = "Checking…";
  if (onboarding.el.installBtn) onboarding.el.installBtn.style.display = "none";
  if (onboarding.el.progressWrap) onboarding.el.progressWrap.style.display = "none";

  const result = (await window.api.detectCli()) as {
    installed?: boolean;
    found?: boolean;
    path?: string;
    version?: string;
  };
  const installed = result.installed ?? result.found ?? false;
  if (installed) {
    const versionLine = result.version ? ` (${result.version.split("\n")[0]})` : "";
    if (onboarding.el.cliDetail)
      onboarding.el.cliDetail.textContent = `Found at ${result.path}${versionLine}`;
    setStepState(onboarding.el.stepCli, "done");
    onboarding.cliReady = true;
    activateWorkspaceStep();
  } else {
    if (onboarding.el.cliDetail)
      onboarding.el.cliDetail.textContent =
        "Not installed. Mason can install it for you (downloads ~30 MB to ~/.mason/bin).";
    if (onboarding.el.installBtn) onboarding.el.installBtn.style.display = "";
  }
}

async function runCliInstall(): Promise<void> {
  const installBtn = onboarding.el.installBtn as HTMLButtonElement | null;
  const progressWrap = onboarding.el.progressWrap as HTMLElement | null;
  const progressFill = onboarding.el.progressFill as HTMLElement | null;
  const progressText = onboarding.el.progressText as HTMLElement | null;

  if (installBtn) {
    installBtn.disabled = true;
    installBtn.textContent = "Installing…";
  }
  if (progressWrap) progressWrap.style.display = "";
  if (progressFill) progressFill.style.width = "0%";
  if (progressText) progressText.textContent = "Starting…";

  const onProgress = (payload: any): void => {
    const { phase, percent } = payload || {};
    let label = phase;
    if (phase === "query-release") label = "Looking up latest release";
    else if (phase === "download") label = `Downloading… ${percent}%`;
    else if (phase === "extract") label = "Extracting";
    else if (phase === "done") label = "Done";
    else if (phase === "error") label = "Error";
    if (progressText) progressText.textContent = label;
    if (typeof percent === "number" && progressFill) {
      progressFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }
  };
  window.api.onCliInstallProgress(onProgress);

  try {
    const result = (await window.api.installCli()) as {
      ok: boolean;
      path?: string;
      version?: string;
      error?: string;
    };
    if (!result.ok) throw new Error(result.error || "Install failed");
    const versionLine = result.version ? ` (${result.version.split("\n")[0]})` : "";
    if (onboarding.el.cliDetail)
      onboarding.el.cliDetail.textContent = `Installed at ${result.path}${versionLine}`;
    if (installBtn) installBtn.style.display = "none";
    if (progressWrap) progressWrap.style.display = "none";
    setStepState(onboarding.el.stepCli, "done");
    onboarding.cliReady = true;
    activateWorkspaceStep();
  } catch (e) {
    if (installBtn) {
      installBtn.disabled = false;
      installBtn.textContent = "Retry install";
    }
    if (progressText) progressText.textContent = (e as Error).message || "Install failed";
    if (progressFill) progressFill.style.width = "0%";
  } finally {
    window.api.removeCliInstallListeners();
  }
}

function activateWorkspaceStep(): void {
  setStepState(onboarding.el.stepWorkspace, "active");
  const host = onboarding.el.host as HTMLInputElement | null;
  const name = onboarding.el.name as HTMLInputElement | null;
  const saveProfile = onboarding.el.saveProfile as HTMLButtonElement | null;
  if (host) host.disabled = false;
  if (name) name.disabled = false;
  if (saveProfile) saveProfile.disabled = false;
  host?.focus();
}

async function runSaveProfile(): Promise<void> {
  setOnboardingError(onboarding.el.profileError, null);
  const hostInput = onboarding.el.host as HTMLInputElement | null;
  const nameInput = onboarding.el.name as HTMLInputElement | null;
  const saveProfile = onboarding.el.saveProfile as HTMLButtonElement | null;
  const host = hostInput?.value.trim() || "";
  if (!host) {
    setOnboardingError(onboarding.el.profileError, "Workspace URL is required.");
    return;
  }
  const name = nameInput?.value.trim() || deriveProfileName(host);

  if (saveProfile) {
    saveProfile.disabled = true;
    saveProfile.textContent = "Saving…";
  }
  try {
    await window.api.addProfile({ name, host });
    onboarding.profileSaved = { name, host };
    setStepState(onboarding.el.stepWorkspace, "done");
    if (hostInput) hostInput.disabled = true;
    if (nameInput) nameInput.disabled = true;
    if (saveProfile) saveProfile.textContent = `Saved [${name}]`;

    if (typeof reloadProfiles === "function") await reloadProfiles(name);

    setStepState(onboarding.el.stepAuth, "active");
    const signIn = onboarding.el.signIn as HTMLButtonElement | null;
    if (signIn) signIn.disabled = false;
    signIn?.focus();
  } catch (e) {
    if (saveProfile) {
      saveProfile.disabled = false;
      saveProfile.textContent = "Save workspace";
    }
    setOnboardingError(onboarding.el.profileError, (e as Error).message || "Failed to save profile.");
  }
}

async function runSignIn(): Promise<void> {
  setOnboardingError(onboarding.el.authError, null);
  if (!onboarding.profileSaved) return;
  const signIn = onboarding.el.signIn as HTMLButtonElement | null;
  if (signIn) {
    signIn.disabled = true;
    signIn.textContent = "Opening browser…";
  }
  try {
    const result = await window.api.oauthLogin(onboarding.profileSaved.name);
    if (!result.success) throw new Error(result.error || "Sign-in failed");
    setStepState(onboarding.el.stepAuth, "done");
    if (signIn) signIn.textContent = "Signed in";
    await finishOnboarding();
  } catch (e) {
    if (signIn) {
      signIn.disabled = false;
      signIn.textContent = "Retry sign-in";
    }
    setOnboardingError(onboarding.el.authError, (e as Error).message || "Sign-in failed");
  }
}

async function finishOnboarding(): Promise<void> {
  obEl("onboardingView")?.classList.remove("visible");
  if (typeof loadWorkspaceConfig === "function") await loadWorkspaceConfig();
  if (typeof autoConnectMcp === "function") {
    mason.autoConnectDone = false;
    await autoConnectMcp();
  }
  if (typeof switchToChatsTab === "function") switchToChatsTab();
}
