// Agentic Workflow Designer — canvas UI.
// See docs/specs/agentic-workflow-designer.md (Section 4) for the UX spec.
//
// The canvas is a hand-rolled DOM + SVG implementation: cells are absolutely
// positioned cards inside a single transformed container, edges are cubic
// bezier paths in an SVG underlay that shares the same transform, so pan and
// zoom move everything together.

declare function switchToChatsTab(): void;
declare function renderMarkdown(text: string): string;
declare function renderQuestionCard(
  questions: Array<{ question: string; options: string[]; multiSelect?: boolean }>,
  container?: HTMLElement
): Promise<string>;

const CELL_WIDTH = 240;

// --- module state ---
let dsgInited = false;
let dsgView = { x: 60, y: 40, scale: 1 };
let dsgSelectedCellId: string | null = null;
let dsgSelectedEdgeId: string | null = null;
let dsgCellEls = new Map<string, HTMLElement>();
let dsgListLoaded = false;

function dsgEl<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function dsgWf(): MasonWorkflow | null {
  return mason.currentWorkflow;
}

function dsgRunning(): boolean {
  return !!mason.workflowRun?.running;
}

function dsgMarkDirty(): void {
  mason.workflowDirty = true;
  const save = dsgEl<HTMLButtonElement>("wfSave");
  if (save) save.classList.add("dirty");
}

function dsgClearDirty(): void {
  mason.workflowDirty = false;
  const save = dsgEl<HTMLButtonElement>("wfSave");
  if (save) save.classList.remove("dirty");
}

// --- view switching ---

function switchToDesignerView(): void {
  mason.currentView = "designer";
  const main = document.querySelector(".main") as HTMLElement | null;
  if (main) main.style.display = "none";
  document.getElementById("dashboardView")?.classList.remove("visible");
  const webview = document.getElementById("dashboardWebview");
  if (webview) webview.style.display = "none";
  document.getElementById("settingsView")?.classList.remove("visible");
  const settingsClose = document.getElementById("settingsViewClose");
  if (settingsClose) settingsClose.style.display = "none";
  document.getElementById("onboardingView")?.classList.remove("visible");
  document.getElementById("designerView")?.classList.add("visible");
  document.getElementById("designerBtn")?.classList.add("active");

  initDesigner();
  if (!dsgListLoaded) {
    dsgListLoaded = true;
    refreshWorkflowList().then(() => {
      if (!dsgWf()) {
        if (mason.workflows.length > 0) {
          openWorkflow(mason.workflows[0].id);
        } else {
          newWorkflow();
        }
      }
    });
  }
}

// Called by every other switchTo* via hideDesignerView().
function hideDesignerView(): void {
  document.getElementById("designerView")?.classList.remove("visible");
  document.getElementById("designerBtn")?.classList.remove("active");
}

// --- workflow CRUD ---

async function refreshWorkflowList(): Promise<void> {
  mason.workflows = await window.api.workflowList();
  const sel = dsgEl<HTMLSelectElement>("wfSelect");
  if (!sel) return;
  sel.innerHTML = "";
  for (const w of mason.workflows) {
    const opt = document.createElement("option");
    opt.value = w.id;
    opt.textContent = w.name;
    if (dsgWf()?.id === w.id) opt.selected = true;
    sel.appendChild(opt);
  }
  const newOpt = document.createElement("option");
  newOpt.value = "__new__";
  newOpt.textContent = "+ New workflow";
  sel.appendChild(newOpt);
  if (dsgWf()) sel.value = dsgWf()!.id;
}

function newWorkflow(): void {
  mason.currentWorkflow = {
    id: genId(),
    name: "Untitled workflow",
    version: 1,
    cells: [],
    edges: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  mason.workflowRun = null;
  dsgSelectedCellId = null;
  dsgSelectedEdgeId = null;
  dsgView = { x: 60, y: 40, scale: 1 };
  dsgClearDirty();
  renderDesigner();
  refreshWorkflowList();
}

async function openWorkflow(id: string): Promise<void> {
  const wf = (await window.api.workflowLoad(id)) as MasonWorkflow | null;
  if (!wf) return;
  mason.currentWorkflow = wf;
  mason.workflowRun = null;
  dsgSelectedCellId = null;
  dsgSelectedEdgeId = null;
  dsgClearDirty();
  renderDesigner();
  await refreshWorkflowList();
}

async function saveWorkflow(): Promise<void> {
  const wf = dsgWf();
  if (!wf) return;
  wf.name = dsgEl<HTMLInputElement>("wfName")?.value.trim() || "Untitled workflow";
  wf.updatedAt = Date.now();
  const result = await window.api.workflowSave(wf);
  if (result.ok) {
    dsgClearDirty();
    await refreshWorkflowList();
    dsgSetStatus("Saved.", false);
  } else {
    dsgSetStatus(result.error || "Save failed.", true);
  }
}

async function deleteWorkflow(): Promise<void> {
  const wf = dsgWf();
  if (!wf) return;
  if (!confirm(`Delete workflow "${wf.name}"? This cannot be undone.`)) return;
  await window.api.workflowDelete(wf.id);
  mason.currentWorkflow = null;
  await refreshWorkflowList();
  if (mason.workflows.length > 0) {
    await openWorkflow(mason.workflows[0].id);
  } else {
    newWorkflow();
  }
}

// --- coordinate helpers ---

function dsgApplyTransform(): void {
  const canvas = dsgEl<HTMLElement>("wfCanvas");
  if (!canvas) return;
  canvas.style.transform = `translate(${dsgView.x}px, ${dsgView.y}px) scale(${dsgView.scale})`;
}

function dsgScreenToCanvas(clientX: number, clientY: number): { x: number; y: number } {
  const wrap = dsgEl<HTMLElement>("wfCanvasWrap");
  const rect = wrap.getBoundingClientRect();
  return {
    x: (clientX - rect.left - dsgView.x) / dsgView.scale,
    y: (clientY - rect.top - dsgView.y) / dsgView.scale,
  };
}

// --- rendering ---

function renderDesigner(): void {
  const wf = dsgWf();
  const nameInput = dsgEl<HTMLInputElement>("wfName");
  if (nameInput && wf) nameInput.value = wf.name;
  const canvas = dsgEl<HTMLElement>("wfCanvas");
  if (!canvas || !wf) return;

  // Remove cell elements for deleted cells; (re)create the rest.
  for (const [id, el] of dsgCellEls) {
    if (!wf.cells.some((c) => c.id === id)) {
      el.remove();
      dsgCellEls.delete(id);
    }
  }
  for (const cell of wf.cells) renderCell(cell);
  dsgApplyTransform();
  redrawEdges();
  renderDrawer();
  dsgUpdateRunButton();
}

function dsgModelOptions(selected: string): string {
  let html = "";
  for (const g of mason.discoveredModels) {
    html += `<optgroup label="${escapeHtml(g.group)}">`;
    for (const m of g.models) {
      html += `<option value="${escapeHtml(m.value)}" ${m.value === selected ? "selected" : ""}>${escapeHtml(m.label)}</option>`;
    }
    html += "</optgroup>";
  }
  if (mason.customEndpoints.length > 0) {
    html += '<optgroup label="Custom">';
    for (const ep of mason.customEndpoints) {
      const val = `custom:${ep.modelId}`;
      html += `<option value="${escapeHtml(val)}" ${val === selected ? "selected" : ""}>${escapeHtml(ep.name)}</option>`;
    }
    html += "</optgroup>";
  }
  if (selected && !workflowModelAvailable(selected)) {
    html += `<option value="${escapeHtml(selected)}" selected>⚠ ${escapeHtml(selected)} (unavailable)</option>`;
  }
  return html;
}

function dsgStatusInfo(cellId: string): { label: string; cls: string } {
  const rec = mason.workflowRun?.cells[cellId];
  const status: CellRunStatus = rec?.status || "idle";
  return { label: status, cls: `wf-status-${status}` };
}

function renderCell(cell: WorkflowCellConfig): void {
  const canvas = dsgEl<HTMLElement>("wfCanvas");
  let el = dsgCellEls.get(cell.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "wf-cell";
    el.dataset.id = cell.id;
    el.innerHTML = `
      <div class="wf-port wf-port-feedback" data-port="feedback" title="Feedback input — drag a dashed line here from another cell's output"></div>
      <div class="wf-cell-header">
        <input class="wf-cell-name" spellcheck="false" aria-label="Cell name" />
        <button class="wf-cell-delete" title="Delete cell" aria-label="Delete cell">&times;</button>
      </div>
      <select class="wf-cell-model" aria-label="Model"></select>
      <div class="wf-cell-toolsrow">
        <button class="wf-cell-tools-btn"></button>
        <span class="wf-cell-status"></span>
      </div>
      <textarea class="wf-cell-prompt" rows="3" placeholder="Prompt — role, goals, instructions for this cell…" spellcheck="false"></textarea>
      <div class="wf-port wf-port-in" data-port="in" title="Input"></div>
      <div class="wf-port wf-port-out" data-port="out" title="Output — drag to another cell to connect"></div>
    `;
    canvas.appendChild(el);
    dsgCellEls.set(cell.id, el);
    dsgWireCell(el, cell.id);
  }
  el.style.left = `${cell.position.x}px`;
  el.style.top = `${cell.position.y}px`;
  el.classList.toggle("selected", dsgSelectedCellId === cell.id);

  const nameEl = el.querySelector(".wf-cell-name") as HTMLInputElement;
  if (document.activeElement !== nameEl) nameEl.value = cell.name;
  const modelEl2 = el.querySelector(".wf-cell-model") as HTMLSelectElement;
  modelEl2.innerHTML = dsgModelOptions(cell.model.value);
  modelEl2.value = cell.model.value;
  const toolsBtn = el.querySelector(".wf-cell-tools-btn") as HTMLButtonElement;
  toolsBtn.textContent = `⚒ ${cell.enabledTools.length} tool${cell.enabledTools.length === 1 ? "" : "s"}`;
  const promptEl = el.querySelector(".wf-cell-prompt") as HTMLTextAreaElement;
  if (document.activeElement !== promptEl) promptEl.value = cell.prompt;
  const statusEl = el.querySelector(".wf-cell-status") as HTMLElement;
  const st = dsgStatusInfo(cell.id);
  statusEl.textContent = st.label;
  statusEl.className = `wf-cell-status ${st.cls}`;
}

function dsgWireCell(el: HTMLElement, cellId: string): void {
  const cellOf = (): WorkflowCellConfig | undefined => dsgWf()?.cells.find((c) => c.id === cellId);

  // Select on any mousedown inside the cell.
  el.addEventListener("mousedown", () => {
    if (dsgSelectedCellId !== cellId) {
      dsgSelectedCellId = cellId;
      dsgSelectedEdgeId = null;
      for (const [id, cellEl] of dsgCellEls) cellEl.classList.toggle("selected", id === cellId);
      redrawEdges();
      renderDrawer();
    }
  });

  // Drag by header (but not from the name input or delete button).
  const header = el.querySelector(".wf-cell-header") as HTMLElement;
  header.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("input") || t.closest("button")) return;
    e.preventDefault();
    const cell = cellOf();
    if (!cell) return;
    const start = dsgScreenToCanvas(e.clientX, e.clientY);
    const orig = { ...cell.position };
    const onMove = (me: MouseEvent): void => {
      const now = dsgScreenToCanvas(me.clientX, me.clientY);
      cell.position = {
        x: Math.round(orig.x + (now.x - start.x)),
        y: Math.round(orig.y + (now.y - start.y)),
      };
      el.style.left = `${cell.position.x}px`;
      el.style.top = `${cell.position.y}px`;
      redrawEdges();
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      dsgMarkDirty();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  (el.querySelector(".wf-cell-name") as HTMLInputElement).addEventListener("input", (e) => {
    const cell = cellOf();
    if (cell) {
      cell.name = (e.target as HTMLInputElement).value;
      dsgMarkDirty();
    }
  });

  (el.querySelector(".wf-cell-delete") as HTMLButtonElement).addEventListener("click", () => {
    const wf = dsgWf();
    if (!wf || dsgRunning()) return;
    wf.cells = wf.cells.filter((c) => c.id !== cellId);
    wf.edges = wf.edges.filter((e) => e.from !== cellId && e.to !== cellId);
    if (dsgSelectedCellId === cellId) dsgSelectedCellId = null;
    dsgMarkDirty();
    renderDesigner();
  });

  (el.querySelector(".wf-cell-model") as HTMLSelectElement).addEventListener("change", (e) => {
    const cell = cellOf();
    if (!cell) return;
    const sel = e.target as HTMLSelectElement;
    cell.model = {
      value: sel.value,
      label: sel.options[sel.selectedIndex]?.textContent || sel.value,
    };
    dsgMarkDirty();
  });

  (el.querySelector(".wf-cell-prompt") as HTMLTextAreaElement).addEventListener("input", (e) => {
    const cell = cellOf();
    if (cell) {
      cell.prompt = (e.target as HTMLTextAreaElement).value;
      dsgMarkDirty();
    }
  });

  (el.querySelector(".wf-cell-tools-btn") as HTMLButtonElement).addEventListener("click", () =>
    openCellToolsModal(cellId)
  );

  // Edge creation from the output port.
  const outPort = el.querySelector(".wf-port-out") as HTMLElement;
  outPort.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dsgStartEdgeDrag(cellId, e);
  });
}

// --- edges ---

function dsgPortPos(
  cell: WorkflowCellConfig,
  port: "in" | "out" | "feedback"
): { x: number; y: number } {
  const el = dsgCellEls.get(cell.id);
  const h = el ? el.offsetHeight : 140;
  if (port === "out") return { x: cell.position.x + CELL_WIDTH, y: cell.position.y + h / 2 };
  if (port === "in") return { x: cell.position.x, y: cell.position.y + h / 2 };
  return { x: cell.position.x + CELL_WIDTH / 2, y: cell.position.y };
}

function dsgEdgePath(edge: WorkflowEdge): string {
  const wf = dsgWf()!;
  const from = wf.cells.find((c) => c.id === edge.from);
  const to = wf.cells.find((c) => c.id === edge.to);
  if (!from || !to) return "";
  const p1 = dsgPortPos(from, "out");
  if (edge.kind === "feedback") {
    const p2 = dsgPortPos(to, "feedback");
    const dx = Math.max(50, Math.abs(p2.x - p1.x) / 2);
    return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x} ${p2.y - 70}, ${p2.x} ${p2.y}`;
  }
  const p2 = dsgPortPos(to, "in");
  const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
  return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
}

function dsgEdgeMidpoint(edge: WorkflowEdge): { x: number; y: number } {
  const wf = dsgWf()!;
  const from = wf.cells.find((c) => c.id === edge.from);
  const to = wf.cells.find((c) => c.id === edge.to);
  if (!from || !to) return { x: 0, y: 0 };
  const p1 = dsgPortPos(from, "out");
  const p2 = dsgPortPos(to, edge.kind === "feedback" ? "feedback" : "in");
  return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
}

function redrawEdges(): void {
  const svg = dsgEl<HTMLElement>("wfEdgeSvg");
  const wf = dsgWf();
  if (!svg || !wf) return;
  const NS = "http://www.w3.org/2000/svg";
  svg.innerHTML = "";
  for (const edge of wf.edges) {
    const d = dsgEdgePath(edge);
    if (!d) continue;

    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute(
      "class",
      `wf-edge wf-edge-${edge.kind}${dsgSelectedEdgeId === edge.id ? " selected" : ""}`
    );
    svg.appendChild(path);

    // Fat invisible twin for clicks.
    const hit = document.createElementNS(NS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "wf-edge-hit");
    hit.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      dsgSelectedEdgeId = edge.id;
      dsgSelectedCellId = null;
      for (const el of dsgCellEls.values()) el.classList.remove("selected");
      redrawEdges();
      renderDrawer();
    });
    hit.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      dsgEditEdgeLabel(edge.id);
    });
    svg.appendChild(hit);

    if (edge.label) {
      const mid = dsgEdgeMidpoint(edge);
      const text = document.createElementNS(NS, "text");
      text.setAttribute("x", String(mid.x));
      text.setAttribute("y", String(mid.y - 6));
      text.setAttribute("class", "wf-edge-label");
      text.textContent = edge.label;
      svg.appendChild(text);
    }
  }
}

function dsgStartEdgeDrag(fromCellId: string, e: MouseEvent): void {
  const svg = dsgEl<HTMLElement>("wfEdgeSvg");
  const wf = dsgWf();
  if (!svg || !wf || dsgRunning()) return;
  const fromCell = wf.cells.find((c) => c.id === fromCellId)!;
  const p1 = dsgPortPos(fromCell, "out");
  const NS = "http://www.w3.org/2000/svg";
  const ghost = document.createElementNS(NS, "path");
  ghost.setAttribute("class", "wf-edge wf-edge-ghost");
  svg.appendChild(ghost);

  const onMove = (me: MouseEvent): void => {
    const p2 = dsgScreenToCanvas(me.clientX, me.clientY);
    const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
    ghost.setAttribute(
      "d",
      `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`
    );
  };
  const onUp = (me: MouseEvent): void => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    ghost.remove();
    const target = document.elementFromPoint(me.clientX, me.clientY) as HTMLElement | null;
    const cellEl = target?.closest(".wf-cell") as HTMLElement | null;
    if (!cellEl || !cellEl.dataset.id || cellEl.dataset.id === fromCellId) return;
    const kind: WorkflowEdgeKind =
      target?.closest(".wf-port-feedback") != null ? "feedback" : "flow";
    const to = cellEl.dataset.id;
    if (wf.edges.some((ed) => ed.from === fromCellId && ed.to === to && ed.kind === kind)) return;
    wf.edges.push({ id: genId(), from: fromCellId, to, kind });
    dsgMarkDirty();
    redrawEdges();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  onMove(e);
}

function dsgDeleteSelectedEdge(): void {
  const wf = dsgWf();
  if (!wf || !dsgSelectedEdgeId || dsgRunning()) return;
  wf.edges = wf.edges.filter((e) => e.id !== dsgSelectedEdgeId);
  dsgSelectedEdgeId = null;
  dsgMarkDirty();
  redrawEdges();
}

// Floating inline input for edge labels (window.prompt doesn't exist in
// Electron renderers).
function dsgEditEdgeLabel(edgeId: string): void {
  const wf = dsgWf();
  const wrap = dsgEl<HTMLElement>("wfCanvasWrap");
  if (!wf || !wrap) return;
  const edge = wf.edges.find((e) => e.id === edgeId);
  if (!edge) return;
  const mid = dsgEdgeMidpoint(edge);
  const input = document.createElement("input");
  input.className = "wf-edge-label-input";
  input.value = edge.label || "";
  input.placeholder = "Edge label (e.g. spec)";
  input.style.left = `${mid.x * dsgView.scale + dsgView.x}px`;
  input.style.top = `${mid.y * dsgView.scale + dsgView.y}px`;
  wrap.appendChild(input);
  input.focus();
  input.select();
  const commit = (): void => {
    edge.label = input.value.trim() || undefined;
    input.remove();
    dsgMarkDirty();
    redrawEdges();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") {
      input.removeEventListener("blur", commit);
      input.remove();
    }
    e.stopPropagation();
  });
}

// --- cells ---

function addCell(at?: { x: number; y: number }): void {
  const wf = dsgWf();
  if (!wf || dsgRunning()) return;
  const wrap = dsgEl<HTMLElement>("wfCanvasWrap");
  const rect = wrap.getBoundingClientRect();
  const center =
    at ||
    dsgScreenToCanvas(rect.left + rect.width / 2 - 120, rect.top + rect.height / 2 - 90);
  const fallback = mason.defaultModel || {
    value: mason.selectedModelValue,
    label: mason.selectedModelLabel,
  };
  wf.cells.push({
    id: genId(),
    name: `Cell ${wf.cells.length + 1}`,
    model: { ...fallback },
    enabledTools: [],
    prompt: "",
    position: { x: Math.round(center.x), y: Math.round(center.y) },
  });
  dsgMarkDirty();
  renderDesigner();
}

// --- per-cell tools modal ---

let dsgToolsCellId: string | null = null;

function openCellToolsModal(cellId: string): void {
  const wf = dsgWf();
  const cell = wf?.cells.find((c) => c.id === cellId);
  if (!cell) return;
  dsgToolsCellId = cellId;
  const modal = dsgEl<HTMLElement>("wfToolsModal");
  const list = dsgEl<HTMLElement>("wfToolsList");
  const title = dsgEl<HTMLElement>("wfToolsTitle");
  title.textContent = `Tools for "${cell.name}"`;
  list.innerHTML = "";

  const enabled = new Set(cell.enabledTools);
  const all = getAllToolDefsUnfiltered();
  const bySource = new Map<string, ToolDef[]>();
  for (const t of all) {
    const src = t._source || "Other";
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(t);
  }
  for (const [source, tools] of bySource) {
    const header = document.createElement("div");
    header.className = "wf-tools-group";
    header.textContent = source;
    list.appendChild(header);
    for (const t of tools) {
      const name = t.function.name;
      const row = document.createElement("label");
      row.className = "wf-tools-row";
      row.innerHTML = `<input type="checkbox" ${enabled.has(name) ? "checked" : ""} /><span class="wf-tools-name">${escapeHtml(name)}</span><span class="wf-tools-desc">${escapeHtml((t.function.description || "").slice(0, 90))}</span>`;
      (row.querySelector("input") as HTMLInputElement).addEventListener("change", (e) => {
        const on = (e.target as HTMLInputElement).checked;
        if (on) enabled.add(name);
        else enabled.delete(name);
        cell.enabledTools = [...enabled];
        dsgMarkDirty();
        renderCell(cell);
      });
      list.appendChild(row);
    }
  }
  modal.classList.add("open");
}

// --- run / stop ---

function dsgSetStatus(text: string, isError: boolean): void {
  const el = dsgEl<HTMLElement>("wfStatus");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function dsgUpdateRunButton(): void {
  const btn = dsgEl<HTMLButtonElement>("wfRun");
  if (!btn) return;
  const running = dsgRunning();
  btn.textContent = running ? "■ Stop" : "▶ Run";
  btn.classList.toggle("running", running);
}

async function runCurrentWorkflow(): Promise<void> {
  const wf = dsgWf();
  if (!wf) return;
  if (dsgRunning()) {
    // Stop.
    if (mason.workflowRun) mason.workflowRun.aborted = true;
    window.api.abortChat();
    return;
  }
  if (mason.generating) {
    dsgSetStatus("A chat response is still streaming — stop it first.", true);
    return;
  }
  const errors = validateWorkflow(wf);
  if (errors.length > 0) {
    dsgSetStatus(errors[0] + (errors.length > 1 ? ` (+${errors.length - 1} more)` : ""), true);
    return;
  }
  dsgSetStatus("", false);

  const callbacks: EngineCallbacks = {
    onCellStatus: (cellId) => {
      const cell = wf.cells.find((c) => c.id === cellId);
      if (cell) renderCell(cell);
      if (cellId === dsgSelectedCellId) renderDrawer();
      // Auto-follow the running cell so the drawer shows live output.
      if (mason.workflowRun?.cells[cellId]?.status === "running") {
        dsgSelectedCellId = cellId;
        dsgSelectedEdgeId = null;
        for (const [id, el] of dsgCellEls) el.classList.toggle("selected", id === cellId);
        renderDrawer();
      }
      dsgUpdateRunButton();
    },
    onCellTranscript: (cellId, entry) => {
      mason.workflowRun?.cells[cellId]?.transcript.push(entry);
      if (cellId === dsgSelectedCellId) renderDrawer();
    },
    onStreamText: (cellId, text) => {
      if (cellId !== dsgSelectedCellId) return;
      const live = document.getElementById("wfDrawerLive");
      if (live) {
        live.innerHTML = renderMarkdown(text);
        const body = dsgEl<HTMLElement>("wfDrawerBody");
        if (body) body.scrollTop = body.scrollHeight;
      }
    },
    askUser: (questions) => {
      const body = dsgEl<HTMLElement>("wfDrawerBody");
      dsgEl<HTMLElement>("wfDrawer")?.classList.remove("collapsed");
      return renderQuestionCard(questions, body || undefined);
    },
  };

  dsgUpdateRunButton();
  try {
    const state = await runWorkflow(wf, callbacks);
    if (state.aborted) {
      dsgSetStatus("Stopped.", false);
    } else if (state.error) {
      dsgSetStatus(state.error, true);
    } else {
      dsgSetStatus(`Done — ${state.totalSteps} cell run${state.totalSteps === 1 ? "" : "s"}.`, false);
    }
  } catch (e) {
    dsgSetStatus((e as Error).message, true);
  } finally {
    dsgUpdateRunButton();
    renderDesigner();
  }
}

// --- transcript drawer ---

function renderDrawer(): void {
  const title = dsgEl<HTMLElement>("wfDrawerTitle");
  const body = dsgEl<HTMLElement>("wfDrawerBody");
  if (!title || !body) return;
  const wf = dsgWf();

  if (dsgSelectedEdgeId && wf) {
    const edge = wf.edges.find((e) => e.id === dsgSelectedEdgeId);
    if (edge) {
      const from = wf.cells.find((c) => c.id === edge.from)?.name || "?";
      const to = wf.cells.find((c) => c.id === edge.to)?.name || "?";
      title.textContent = `${edge.kind === "feedback" ? "Feedback edge" : "Edge"}: ${from} → ${to}`;
      body.innerHTML = `<div class="wf-drawer-hint">${edge.label ? `Label: <b>${escapeHtml(edge.label)}</b>. ` : ""}Double-click the edge to ${edge.label ? "edit" : "add"} a label — labels become input headers downstream and route names for gates. Press Delete to remove the edge.</div>`;
      return;
    }
  }

  const cell = wf?.cells.find((c) => c.id === dsgSelectedCellId);
  if (!cell) {
    title.textContent = "Transcript";
    body.innerHTML =
      '<div class="wf-drawer-hint">Select a cell to see its run transcript. Drag from a cell\'s right port onto another cell to connect them; drop on the top port for a feedback edge.</div>';
    return;
  }
  const rec = mason.workflowRun?.cells[cell.id];
  const st = dsgStatusInfo(cell.id);
  title.innerHTML = `${escapeHtml(cell.name)} <span class="wf-cell-status ${st.cls}">${st.label}</span>`;
  body.innerHTML = "";
  if (!rec || (rec.transcript.length === 0 && !rec.output && rec.status !== "running")) {
    body.innerHTML = '<div class="wf-drawer-hint">No runs yet.</div>';
    return;
  }
  for (const entry of rec.transcript) {
    const div = document.createElement("div");
    div.className = `wf-tr wf-tr-${entry.kind}`;
    if (entry.kind === "assistant") {
      div.innerHTML = renderMarkdown(entry.text);
    } else {
      div.textContent = entry.text;
    }
    body.appendChild(div);
  }
  if (rec.status === "running") {
    const live = document.createElement("div");
    live.id = "wfDrawerLive";
    live.className = "wf-tr wf-tr-assistant";
    body.appendChild(live);
  } else if (rec.output) {
    const out = document.createElement("div");
    out.className = "wf-tr wf-tr-assistant wf-tr-output";
    out.innerHTML = renderMarkdown(rec.output);
    body.appendChild(out);
  }
  if (rec.error) {
    const err = document.createElement("div");
    err.className = "wf-tr wf-tr-error";
    err.textContent = rec.error;
    body.appendChild(err);
  }
  body.scrollTop = body.scrollHeight;
}

// --- template (spec section 12) ---

function dsgFindModel(needle: string): { value: string; label: string } | null {
  for (const g of mason.discoveredModels) {
    for (const m of g.models) {
      if (m.value.toLowerCase().includes(needle)) return { value: m.value, label: m.label };
    }
  }
  return null;
}

function insertTemplateWorkflow(): void {
  const fallback = mason.defaultModel || {
    value: mason.selectedModelValue,
    label: mason.selectedModelLabel,
  };
  const fable = dsgFindModel("fable") || fallback;
  const opus = dsgFindModel("opus") || fallback;
  const sonnet = dsgFindModel("sonnet") || fallback;

  const spec: WorkflowCellConfig = {
    id: genId(),
    name: "Spec",
    model: { ...fable },
    enabledTools: [],
    prompt:
      "You are the architect. Turn the high-level goals below into (1) a precise project specification and (2) a unit-test spec sheet listing concrete, verifiable acceptance tests. Be exhaustive but unambiguous.",
    position: { x: 40, y: 160 },
  };
  const impl: WorkflowCellConfig = {
    id: genId(),
    name: "Implement",
    model: { ...opus },
    enabledTools: ["write_file", "read_file"],
    prompt:
      "You are the implementer. Build exactly what the specification asks for. When you receive feedback about failing tests, close every gap it names.",
    position: { x: 380, y: 40 },
    maxLoopIterations: 5,
  };
  const tests: WorkflowCellConfig = {
    id: genId(),
    name: "Unit tests",
    model: { ...sonnet },
    enabledTools: ["read_file"],
    prompt:
      "You are the test runner. Evaluate the implementation against the unit-test spec sheet, test by test. Report which pass and which fail with specifics. If any fail, route feedback to the implementer; when all pass, hand off for final review.",
    position: { x: 720, y: 160 },
  };
  const review: WorkflowCellConfig = {
    id: genId(),
    name: "Final review",
    model: { ...fable },
    enabledTools: [],
    prompt:
      "You are the original architect reviewing the finished work against your specification. If it fully satisfies the spec, end the workflow with a final summary. If gaps remain, route feedback to the implementer describing exactly what to fix.",
    position: { x: 1060, y: 40 },
  };
  mason.currentWorkflow = {
    id: genId(),
    name: "Spec → Implement → Test → Review",
    version: 1,
    cells: [spec, impl, tests, review],
    edges: [
      { id: genId(), from: spec.id, to: impl.id, kind: "flow", label: "goals" },
      { id: genId(), from: spec.id, to: tests.id, kind: "flow", label: "spec" },
      { id: genId(), from: impl.id, to: tests.id, kind: "flow", label: "implementation" },
      { id: genId(), from: tests.id, to: impl.id, kind: "feedback", label: "test failures" },
      { id: genId(), from: tests.id, to: review.id, kind: "flow", label: "passing work" },
      { id: genId(), from: review.id, to: impl.id, kind: "feedback", label: "review feedback" },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  mason.workflowRun = null;
  dsgSelectedCellId = null;
  dsgSelectedEdgeId = null;
  dsgView = { x: 30, y: 30, scale: 0.85 };
  dsgMarkDirty();
  renderDesigner();
  refreshWorkflowList();
}

// --- profile switch revalidation ---

function designerOnProfileSwitch(): void {
  if (mason.currentView === "designer") renderDesigner();
}

// --- init / event wiring ---

function initDesigner(): void {
  if (dsgInited) return;
  dsgInited = true;

  dsgEl<HTMLButtonElement>("wfAddCell")?.addEventListener("click", () => addCell());
  dsgEl<HTMLButtonElement>("wfRun")?.addEventListener("click", () => runCurrentWorkflow());
  dsgEl<HTMLButtonElement>("wfSave")?.addEventListener("click", () => saveWorkflow());
  dsgEl<HTMLButtonElement>("wfNew")?.addEventListener("click", () => newWorkflow());
  dsgEl<HTMLButtonElement>("wfTemplate")?.addEventListener("click", () => insertTemplateWorkflow());
  dsgEl<HTMLButtonElement>("wfDeleteBtn")?.addEventListener("click", () => deleteWorkflow());
  dsgEl<HTMLInputElement>("wfName")?.addEventListener("input", () => {
    const wf = dsgWf();
    if (wf) {
      wf.name = dsgEl<HTMLInputElement>("wfName").value;
      dsgMarkDirty();
    }
  });
  dsgEl<HTMLSelectElement>("wfSelect")?.addEventListener("change", (e) => {
    const val = (e.target as HTMLSelectElement).value;
    if (val === "__new__") newWorkflow();
    else openWorkflow(val);
  });

  const toolsModal = dsgEl<HTMLElement>("wfToolsModal");
  dsgEl<HTMLElement>("wfToolsClose")?.addEventListener("click", () =>
    toolsModal.classList.remove("open")
  );
  toolsModal?.addEventListener("click", (e) => {
    if (e.target === toolsModal) toolsModal.classList.remove("open");
  });

  dsgEl<HTMLElement>("wfDrawerToggle")?.addEventListener("click", () =>
    dsgEl<HTMLElement>("wfDrawer")?.classList.toggle("collapsed")
  );

  // Canvas pan (drag empty space) + zoom (pinch / ctrl-wheel) + scroll-pan.
  const wrap = dsgEl<HTMLElement>("wfCanvasWrap");
  wrap?.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".wf-cell") || t.closest(".wf-edge-label-input")) return;
    // Clicking empty canvas clears selection.
    dsgSelectedCellId = null;
    dsgSelectedEdgeId = null;
    for (const el of dsgCellEls.values()) el.classList.remove("selected");
    redrawEdges();
    renderDrawer();
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const orig = { ...dsgView };
    const onMove = (me: MouseEvent): void => {
      dsgView.x = orig.x + (me.clientX - start.x);
      dsgView.y = orig.y + (me.clientY - start.y);
      dsgApplyTransform();
    };
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  wrap?.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Pinch / ctrl-wheel zoom around the cursor.
        const before = dsgScreenToCanvas(e.clientX, e.clientY);
        const factor = Math.exp(-e.deltaY * 0.01);
        dsgView.scale = Math.min(2, Math.max(0.25, dsgView.scale * factor));
        const rect = wrap.getBoundingClientRect();
        dsgView.x = e.clientX - rect.left - before.x * dsgView.scale;
        dsgView.y = e.clientY - rect.top - before.y * dsgView.scale;
      } else {
        dsgView.x -= e.deltaX;
        dsgView.y -= e.deltaY;
      }
      dsgApplyTransform();
    },
    { passive: false }
  );
  wrap?.addEventListener("dblclick", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".wf-cell")) return;
    const pos = dsgScreenToCanvas(e.clientX, e.clientY);
    addCell({ x: pos.x - 120, y: pos.y - 60 });
  });

  // Delete selected edge (not while typing in a field).
  document.addEventListener("keydown", (e) => {
    if (mason.currentView !== "designer") return;
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if ((e.key === "Delete" || e.key === "Backspace") && dsgSelectedEdgeId) {
      e.preventDefault();
      dsgDeleteSelectedEdge();
    }
  });

  // Autosave every 10s while the designer is open (mirrors chat autosave).
  setInterval(() => {
    if (mason.currentView === "designer" && mason.workflowDirty && !dsgRunning() && dsgWf()) {
      saveWorkflow();
    }
  }, 10_000);
}
