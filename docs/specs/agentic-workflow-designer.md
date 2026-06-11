# Engineering Specification — Agentic Workflow Designer

**Status:** Draft for review
**Author:** Mason core
**Target:** Mason v1.5.x (phased; see Rollout)
**Last updated:** 2026-06-11

---

## 1. Summary

Add a visual, node-based **Workflow Designer** to Mason — a drag-and-drop canvas (in the spirit of n8n / ComfyUI) where users compose multi-model agentic pipelines out of **Cells**. Each Cell selects a model, a subset of available tools (built-in + MCP + UC MCP), and a prompt. Cells are wired together with edges: an edge from Cell A to Cell B means *A runs first, and A's output is injected into B's context*. Edges can also express **feedback loops** (B sends results back to A for revision) and **review gates** (a cell decides whether the workflow ends or routes work back for another pass).

The designer is opened from a new button in the sidebar, directly **above the Profile section**. It replaces the chat pane with a full-pane canvas view, following the same view-swapping pattern as Dashboards/Settings/Onboarding.

Everything executes through the existing Databricks AI Gateway plumbing — per-model format routing, OAuth, streaming, MCP tool dispatch, Anthropic prompt caching — none of which changes. The workflow engine is a thin orchestrator that runs the existing per-turn agent loop once per cell, in graph order.

### Motivating user story (acceptance scenario)

> I click **Workflow Designer**. A designer pane opens in the chat window. I create a cell, select **Fable 5**, pick a couple of MCP tools, and write a prompt with the high-level goals and specs of the project. I create a second cell with **Opus 4.8**, a different toolset, and an additional prompt. I drag a line from the Fable cell to the Opus cell — meaning the Fable cell runs first and its output feeds the Opus cell. I create a third cell named **"unit tests"** with a Sonnet model. The Fable cell feeds its unit-test specs to the unit-tests cell via a second line, and the unit-tests cell *also* receives a line from the Opus cell (two inputs) so it can run Opus's work against the spec sheet. The unit-tests cell has a **feedback** line back to the Opus cell: it reports which tests passed and what gaps remain, and Opus iterates until they're closed. When the unit-tests cell deems the work complete, it hands off to the Fable cell for **final review**. Fable either ends the session or passes the work back to Opus for another round.

Section 12 walks this scenario through the spec end-to-end as the primary acceptance test.

---

## 2. Current-state evaluation (what we're building on)

A short audit of the parts of Mason this feature touches, and the constraints they impose.

### 2.1 Architecture facts that shape this design

| Fact | Where | Consequence for the designer |
|---|---|---|
| Renderer is **script-mode TypeScript** — no bundler, no imports; modules share one global scope and load via `<script src="build/ts/*.js">` in `index.html` | `tsconfig.json`, `index.html:420-431` | The canvas must be vanilla DOM/SVG or a zero-dependency vendored script. No React Flow / Svelte Flow. |
| Strict CSP: `script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com` | `index.html:5` | Any third-party canvas lib must be vendored into the repo (preferred per supply-chain policy) or served from cdnjs. |
| Full-pane views swap by toggling `.visible` / `display` on sibling containers; `mason.currentView` is the source of truth | `src/dashboards.ts` (`switchToChatsTab`, `switchToSettingsView`) | The designer is a new sibling view (`#designerView`) + a new `currentView` value, wired into every existing `switchTo*` function so views stay mutually exclusive. |
| The agent loop (`chatLoop` in `src/chat.ts`) already does everything a cell needs: per-model format resolution, Responses-promotion with tools, streaming + typewriter, tool dispatch (renderer-handled / builtin IPC / HTTP MCP / stdio MCP), 40-iteration budget, abort | `src/chat.ts:257-673` | The engine should **reuse** this, not reimplement it. Today `chatLoop` is hard-wired to `mason.history`, `mason.el.messages`, and the global model picker — it must be parameterized (Section 7.1). |
| **Single in-flight chat**: main.ts keeps one `activeChatController`; `abort-chat` aborts "the" request. `chat-chunk` IPC events are broadcast with no correlation ID | `src/main.ts` chat handler | MVP executes cells **sequentially** (one in-flight request at a time) so abort and chunk routing keep working unchanged. Parallel branch execution is deferred to Phase 3 and requires an IPC change (Section 7.6). |
| Tool definitions carry `_mcpServerUrl` and route per-type; tool filtering is a `disabledTools` set consulted by `getAllToolDefs()` | `src/tools.ts`, `src/chat.ts:258` | Cells need *per-cell* tool selection, not the global set. `getAllToolDefs()` gets an optional allowlist parameter (Section 7.2). |
| Models are discovered per-profile with `format` + `apiTypes` stamped; custom endpoints add a "Custom" group | `src/models.ts` | The cell's model picker reuses `mason.discoveredModels` and must re-validate on profile switch, like `loadChat()` does for saved chats. |
| User state lives under `~/.mason/`; chats are one JSON per conversation in `chat_history/` | `src/main.ts` history IPC | Workflows persist the same way: one JSON per workflow at `~/.mason/workflows/<id>.json`, with list/load/save/delete IPC mirroring the history handlers. |
| Cross-model compatibility is now covered by `scripts/test-models.js` (81-scenario sweep) and shared helpers in `src/chat-shared.ts` | v1.4.4 | The engine builds request bodies through the same shared helpers, so all models that pass the sweep work as cell models automatically. |

### 2.2 What does *not* change

- `src/main.ts` chat handler, streaming/SSE accumulation, `chat-shared.ts` helpers, Anthropic caching, sanitization, trimHistory.
- MCP connect/persist/auto-heal logic in `src/mcp.ts`.
- Chat view behavior. The designer is purely additive; chat remains the default view.

---

## 3. Goals and non-goals

### Goals

1. Visual graph editor: create/rename/delete cells; drag to position; draw edges between cell ports; pan/zoom canvas.
2. Per-cell configuration: model (any discovered/custom model), tool subset, prompt, display name.
3. Sequential-dependency edges with output piping (A → B ⇒ A first, A's output in B's context).
4. **Fan-out and fan-in**: one output to many cells; many outputs into one cell (labeled multi-input join).
5. **Feedback loops** with model-driven routing: a cell can send work back to an upstream cell; a gate cell decides pass/fail/end via a structured verdict; bounded iteration.
6. Run controls: run, stop, per-cell live status, per-cell transcript inspection.
7. Persistence: named workflows saved per-user, listed in the designer, survive restarts and profile switches (with model re-validation).
8. Works with **every** chat-capable Gateway model — no Claude-only or OpenAI-only mechanics in the engine.

### Non-goals (this spec)

- Parallel cell execution within one run (Phase 3 candidate; see 7.6).
- Scheduled/headless workflow runs, webhooks, triggers (n8n-style automation). Mason is interactive.
- Sub-workflows / nesting, conditional branches beyond gate verdicts, human-in-the-loop nodes beyond the existing `ask_user` tool (which still works inside any cell).
- Sharing/exporting workflows to other users (the JSON file is trivially copyable; a UI for it is not in scope).
- Windows/Linux-specific designer differences — the view is pure renderer, identical everywhere.

---

## 4. UX design

### 4.1 Entry point

A new button in the sidebar, inside `.sidebar-settings`, **above** the `Profile` label/select (`index.html:34-36`):

```html
<button class="sidebar-designer-btn" id="designerBtn" title="Workflow Designer" aria-label="Open workflow designer">
  <svg><!-- node-graph glyph: three connected circles --></svg>
  <span>Workflow Designer</span>
</button>
```

Clicking it calls `switchToDesignerView()`. The button gets an `.active` state while the designer is open. `Cmd+D` is added as a keyboard shortcut (matching the `Cmd+,` settings pattern in `src/app.ts`).

### 4.2 The designer view

A new full-pane sibling of `.main` / `#settingsView` / `#dashboardView`:

```
┌──────────────────────────────────────────────────────────────────────┐
│ toolbar: [workflow name ▾] [+ Cell] [▶ Run] [■ Stop] [💾 Save] [⋯]  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   canvas (pan/zoom)                                                  │
│                                                                      │
│   ┌─ Fable cell ────────┐        ┌─ Opus cell ─────────┐             │
│   │ ● Fable 5           │ ───▶   │ ● Opus 4.8          │             │
│   │ 🔧 2 tools          │        │ 🔧 5 tools          │             │
│   │ "High-level goals…" │        │ "Implement…"        │             │
│   │ ○ idle              │        │ ○ idle              │             │
│   └────────────○────────┘        └────────────○────────┘             │
│         │                              │      ▲                      │
│         ▼ (spec)                       ▼      ┊ feedback             │
│   ┌─ unit tests ─────────────────────────┐    ┊                      │
│   │ ● Sonnet 4.6   🔧 0 tools            │┄┄┄┄┘                      │
│   └──────────────────────────────────────┘                           │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ transcript drawer (collapsible): selected cell's live output         │
└──────────────────────────────────────────────────────────────────────┘
```

- **Toolbar.** Workflow name is an inline-editable dropdown listing saved workflows + "New workflow". Run/Stop mirror the chat send/stop affordance (same icons). The `⋯` menu holds Delete workflow, Duplicate, and Export JSON (writes via existing `write_file`-style IPC).
- **Canvas.** Pannable (space-drag or middle-drag) and zoomable (pinch / ctrl-wheel, 25%–200%). A dot-grid background communicates "canvas, not chat". Canvas transform is a single CSS `transform: translate(x,y) scale(z)` on an inner container, so cells and the SVG edge layer move together.
- **Cells** are DOM cards (~240px wide) showing: editable name, model picker (same grouped popup as the chat model picker, reused), tool count chip (click → per-cell Tools modal, reusing the existing modal with a cell-scoped selection set), prompt preview (click → expand to textarea), status lamp, and **ports**: one output port (right edge), one input port (left edge), one **feedback-in** port (top edge, dashed ring). Cells are draggable by their header.
- **Edges** are SVG cubic béziers in an underlay `<svg>` layer. Drawing: mousedown on an output port → ghost edge follows cursor → mouseup on an input port commits. Flow edges are solid; **feedback edges are dashed** and tinted Databricks red (`#ff3621`) to match the `ask_user` accent. Edges can carry an optional **label** (double-click) — labels become the input headers the downstream model sees (e.g. "spec", "implementation"), and the verdict route names for gates.
- **Edge deletion**: click to select (thickens), press Delete/Backspace, or click the small × that appears at the edge midpoint on hover.
- **Run states** per cell: `idle` (grey), `queued` (hollow pulse), `running` (Databricks-orange brick animation — reuse the existing `.thinking` bricks at small scale), `done` (green), `failed` (red), `skipped` (dim). Streaming output ticks into the transcript drawer live when the running cell is selected.
- **Transcript drawer**: bottom-docked, collapsible; shows the selected cell's most recent run as a miniature chat transcript (assistant text + tool-call lines), rendered with the existing `renderMarkdown` + tool-call styling. Pure read-only reuse of `messages.ts` rendering helpers.

### 4.3 Interaction details

- **Add cell:** `+ Cell` button or double-click empty canvas. New cells spawn at viewport center with the workspace default model preselected and zero tools enabled (deliberate: tool minimalism keeps token cost down; the chip nudges users to opt in).
- **Multi-input rendering:** a cell with 2+ inbound flow edges shows stacked input port dots with their edge labels.
- **Validation before run** (Run button disabled with tooltip until clean):
  - every cell has a model that exists in the current profile's discovered/custom list;
  - no flow-edge-only cycles (cycles are legal **only** if at least one edge in the cycle is a feedback edge — see 6.3);
  - at least one **terminal** path exists (a cell with no outgoing flow edges, or a gate with an `end` route).
- **Unsaved changes** dot on the Save button; autosave every 10s while the designer is open (mirrors chat autosave).
- **Profile switch while designer open:** model fields re-validate; cells whose model vanished get a warning badge and block Run until reassigned (same policy as `loadChat()` cross-workspace model validation).

---

## 5. Data model

New ambient types in `src/types/workflow.d.ts` (same pattern as `state.d.ts`):

```ts
interface WorkflowCellConfig {
  id: string;                    // genId()
  name: string;                  // user-visible, e.g. "unit tests"
  model: { value: string; label: string };  // same shape as defaultModel
  enabledTools: string[];        // tool names; resolved against getAllToolDefs() at run time
  prompt: string;                // cell system prompt (role, instructions)
  position: { x: number; y: number };
  maxLoopIterations?: number;    // per-cell feedback cap, default 5
}

type WorkflowEdgeKind = "flow" | "feedback";

interface WorkflowEdge {
  id: string;
  from: string;                  // cell id
  to: string;                    // cell id
  kind: WorkflowEdgeKind;
  label?: string;                // input header downstream / route name for gates
}

interface MasonWorkflow {
  id: string;
  name: string;
  version: 1;                    // schema version for forward migration
  cells: WorkflowCellConfig[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
}
```

Run-time state (renderer memory only in MVP; persisted run history is Phase 3):

```ts
type CellRunStatus = "idle" | "queued" | "running" | "done" | "failed" | "skipped";

interface CellRunRecord {
  status: CellRunStatus;
  transcript: unknown[];         // chat-completions message array for this cell's run
  output: string;                // final assistant text
  verdict?: { route: string; notes?: string };  // present for gate cells
  iterations: number;            // how many times this cell ran (feedback re-entries)
  error?: string;
}

interface WorkflowRunState {
  workflowId: string;
  running: boolean;
  cells: Record<string, CellRunRecord>;
  startedAt: number;
  totalSteps: number;            // global budget consumption, see 6.4
}
```

`MasonState` additions (`src/types/state.d.ts`):

```ts
currentView: "chat" | "dashboards" | "dashboard-detail" | "settings" | "onboarding" | "designer";
workflows: Array<{ id: string; name: string; updatedAt: number }>;  // list cache
currentWorkflow: MasonWorkflow | null;
workflowRun: WorkflowRunState | null;
workflowDirty: boolean;
```

### 5.1 Persistence

- Files: `~/.mason/workflows/<id>.json`, one per workflow, pretty-printed — identical lifecycle to `chat_history/`.
- New IPC handlers in `src/main.ts` + `MasonApi` (`src/shared/api.ts`):

```ts
workflowList(): Promise<Array<{ id: string; name: string; updatedAt: number }>>;
workflowLoad(id: string): Promise<MasonWorkflow | null>;
workflowSave(wf: MasonWorkflow): Promise<{ ok: boolean }>;
workflowDelete(id: string): Promise<{ ok: boolean }>;
```

Implementation mirrors the four `history*` handlers (read dir, parse JSON, atomic write via temp + rename). Workflows are **global**, not per-profile — the graph is portable; only model availability is profile-dependent, and that's checked at open/run time.

---

## 6. Execution semantics

This is the heart of the spec. The engine is deliberately simple: **a workflow run is a sequence of cell runs; each cell run is one bounded agent loop; edges define order and context.**

### 6.1 Scheduling (flow edges)

1. Strip feedback edges; the remaining flow edges must form a DAG (validated at save/run).
2. Compute in-degree per cell; cells with in-degree 0 are **sources** and are queued first.
3. Run cells one at a time (sequential — see 2.1 constraint). A cell becomes eligible when **all** of its inbound flow edges have a completed source. Among eligible cells, run in stable topological order (tie-break by canvas y-position, top-to-bottom, so execution order is visually predictable).
4. A cell with no outgoing flow edges is **terminal**. The run completes when no cell is eligible or queued and no feedback re-entry is pending.

### 6.2 Context assembly (what a cell actually sees)

Each cell run builds a fresh message array (cells do **not** share a transcript; the graph, not a chat log, is the memory):

```
[system]  <cell.prompt>
[system]  <workflow context preamble — generated, see below>
[user]    ## Input from "<edge.label || sourceCell.name>"
          <source cell's final output>

          ## Input from "<...>"           ← one section per inbound flow edge
          <...>
```

- The **preamble** tells the model where it sits: workflow name, its cell name, names of downstream cells, and — if it's a gate — the routing instructions (6.3). Generated by `buildCellPreamble()`; ~10 lines, kept terse.
- Multi-input joins are exactly the labeled sections above. Edge labels matter: in the user story, the unit-tests cell sees `## Input from "spec"` (Fable) and `## Input from "implementation"` (Opus), which is what lets a mid-tier model keep the two straight.
- On **feedback re-entry** (6.3), the cell's previous run transcript is *not* replayed. Instead the new run gets one extra input section: `## Feedback from "<gate cell name>" (iteration N)` with the gate's notes, plus its own previous final output under `## Your previous output`. This bounds context growth per iteration to (feedback + last output) instead of accumulating entire transcripts — the same philosophy as `trimHistory`.
- The existing global system prompt and skills manifest are **not** injected into cells (cells are purpose-built; the user writes the prompt). The `load_skill` and `ask_user` built-ins remain available if the cell's tool selection includes them.
- Multi-system collapse, `max_tokens` per family, `stream_options` gating, caching: all inherited automatically because the engine calls the same `window.api.chat` path through `chat-shared.ts`.

Within a cell run, the existing agent loop applies unchanged: the model may make tool calls (its enabled subset only), results round-trip, 40-iteration inner budget, streamed output.

### 6.3 Feedback loops and gates

A cell with at least one outgoing **feedback** edge, or with both flow and feedback outgoing edges, is a **gate**. Gates must end their run with an explicit routing decision. Mechanism: a built-in tool injected only into gate cell runs —

```jsonc
{
  "type": "function",
  "function": {
    "name": "route_output",
    "description": "REQUIRED final action: choose where this workflow goes next.",
    "parameters": {
      "type": "object",
      "properties": {
        "route": { "type": "string", "enum": ["<edge labels / cell names>", "end"] },
        "notes": { "type": "string", "description": "Feedback for the target cell, or final summary if ending." }
      },
      "required": ["route", "notes"]
    }
  }
}
```

- The enum is generated from the gate's outgoing edges (label preferred, target cell name fallback) plus `"end"` **iff** the gate is allowed to terminate (it has no mandatory downstream flow, or the user marked it terminal-capable — in the UI this is just "a gate with an outgoing flow edge can also choose end" toggle in the cell config; default on for gates with feedback edges).
- The preamble instructs: *"When your work is complete, call `route_output`. Do not finish without calling it."* The engine treats the `route_output` call as the end of the cell run (it does not round-trip a tool result; it consumes the verdict).
- **Tool-based verdicts work across every model family** that supports tool calling on the Gateway — this is why we use a tool rather than asking for JSON in prose (which Llama/Qwen reliability would make flaky). For the rare cell model without tool support, fallback: the engine appends a final user turn "Respond with exactly one word from: …" and parses; if parsing fails, the run errors with a clear message suggesting a tool-capable model for gates.
- **Routing:** `route = "end"` → mark terminal, workflow completes (or continues other pending branches). `route =` a **feedback** edge → re-queue the target cell with the feedback input (6.2), increment its iteration count. `route =` a **flow** edge label → normal continuation (the verdict notes ride along as an extra input section to that target).
- A feedback re-entry **invalidates downstream**: when Opus re-runs, the unit-tests cell (downstream of Opus) returns to `queued` and will run again after Opus completes. Already-done cells not downstream of the re-entered cell keep their outputs.

### 6.4 Budgets and termination (defense against infinite loops)

Three nested budgets, all surfaced in the UI when tripped:

| Budget | Default | Scope |
|---|---|---|
| Inner agent loop | 40 iterations | per cell run (existing `ITERATION_BUDGET`) |
| Feedback iterations | 5 per cell (`maxLoopIterations`) | re-entries of one cell within one workflow run |
| Global step budget | 25 cell runs | whole workflow run |

When the feedback cap is hit, the engine does **not** silently stop: it runs the gate one final time with the instruction that the loop budget is exhausted and it must choose a non-feedback route (or `end`), so the workflow always lands with a final artifact and an honest note. The global cap is the backstop for pathological graphs; hitting it fails the run with the standard "budget exhausted" error styling.

### 6.5 Failure and abort

- A cell run that throws (network, 4xx, tool crash) → cell `failed`, run stops, downstream cells `skipped`. The error renders in the cell card and transcript drawer. A **Resume from failed cell** button re-queues just the failed cell and continues (cheap to implement: all upstream outputs are still in `WorkflowRunState`).
- **Stop** button → `mason.workflowAborted = true` + `window.api.abortChat()` (aborts the single in-flight request). The running cell finalizes with whatever streamed (same partial-content policy as chat), marked `failed (aborted)`; the run stops.
- App quit mid-run: nothing persisted mid-run in MVP; the workflow definition itself was autosaved.

---

## 7. Implementation plan

### 7.1 Refactor: extract the agent loop (prerequisite, zero behavior change)

`chatLoop` (src/chat.ts) is split into:

```ts
// New: src/agent-runner.ts (script-mode, like all renderer files)
interface AgentRunIO {
  onAssistantText(text: string, streamed: boolean): void;
  onToolCallStart(name: string): void;
  onToolCallResult(name: string, preview: string): void;
  onStreamChunk?(delta: string): void;     // optional live tick
  confirmAskUser(questions: Question[]): Promise<string>;  // ask_user passthrough
}

interface AgentRunParams {
  model: { value: string; format: "chat" | "responses" | null; apiTypes?: string[] };
  gateway: string;
  messages: unknown[];           // pre-assembled, including system messages
  tools: ToolDef[] | null;       // already filtered
  iterationBudget?: number;      // default 40
  extraToolHandlers?: Record<string, (args: any) => "consume" | Promise<string>>;
                                 // route_output registers here; "consume" ends the run
}

async function runAgentLoop(params: AgentRunParams, io: AgentRunIO): Promise<{
  finalText: string;
  consumedTool?: { name: string; args: any };   // set when an extraToolHandler consumed
  transcript: unknown[];
  hitBudget: boolean;
}>
```

`chatLoop` becomes a thin adapter: it builds `AgentRunParams` from `mason.history` + global model picker + `getAllToolDefs()`, and an `AgentRunIO` that writes to `mason.el.messages` with the existing streaming/typewriter behavior. **All current chat behavior is preserved; the model-sweep suite plus manual chat smoke-testing gate this refactor (it ships as its own PR).** Format resolution (including the tools→Responses promotion) moves into a shared `resolveModelFormat()` used by both callers.

### 7.2 Tool filtering per cell

`getAllToolDefs()` gains an optional parameter:

```ts
function getAllToolDefs(allowlist?: Set<string>): ToolDef[]
```

`undefined` → current behavior (global `disabledTools`). A `Set` → intersect: only tools both globally available and in the allowlist. The cell's Tools modal writes `cell.enabledTools`; at run time the engine passes `new Set(cell.enabledTools)`. Tools that disappeared (MCP server offline) are silently dropped with a `[DESIGNER]` console warning and a badge on the cell.

### 7.3 New renderer modules

| File | Responsibility | Est. size |
|---|---|---|
| `src/designer.ts` | View switch, toolbar, canvas pan/zoom, cell DOM, edge SVG drawing/hit-testing, drag interactions, validation UI, transcript drawer | ~900 lines |
| `src/workflow-engine.ts` | Graph validation (cycle/reachability), scheduler, context assembly, gate verdict tool, budgets, run-state machine | ~450 lines |
| `src/types/workflow.d.ts` | Ambient types from Section 5 | ~80 lines |

Both `.ts` files are script-mode globals like every other renderer module; added to `index.html` script tags after `chat.js` (engine depends on `agent-runner.ts`, which loads before it). CSS additions go in `css/app.css` (`.designer-*`, `.cell-*`, `.edge-*` classes; dot-grid; dark-mode variants) — ~250 lines.

**Canvas technology decision: hand-rolled DOM + SVG, no library.** Rationale:
- The hard parts (bezier edges, port hit-targets, drag, pan/zoom transform) are ~300 lines of well-understood code; cell *content* (model picker, tools modal, prompt editor) is plain DOM we'd write anyway, and is the majority of the work in any approach.
- Script-mode + CSP + the org's supply-chain policy (exact-version, audited deps) make every vendored lib a liability. Drawflow (the best vanilla-JS fit) is effectively unmaintained; LiteGraph.js brings a canvas-rendering paradigm that fights DOM-based cell editors.
- Mason's house style is exactly this: small, dependency-free, fully owned modules.

### 7.4 Main process changes

- Four `workflow*` IPC handlers + `~/.mason/workflows/` dir creation (Section 5.1). ~70 lines, clone of the history handlers.
- **No changes** to the chat handler, MCP, or auth paths in MVP.

### 7.5 View wiring

- `index.html`: `#designerBtn` in the sidebar (4.1); `#designerView` container; two script tags.
- `src/dashboards.ts`: each `switchTo*` function additionally hides `#designerView`; new `switchToDesignerView()` follows `switchToSettingsView`'s shape; `designerBtn.classList` active-state maintenance.
- `src/app.ts`: DOM refs, event wiring, `Cmd+D`, Escape-closes-popups extended to designer popups, profile-switch hook → `revalidateWorkflowModels()`.

### 7.6 Deferred: parallel branch execution (Phase 3)

Requires: (a) main.ts tracking `Map<requestId, AbortController>` instead of a single `activeChatController`, (b) `chat-chunk` events carrying `requestId`, (c) `chat`/`abortChat` IPC accepting an id. Mechanical but cross-cutting; sequential execution is correct (just slower) for every graph, so this is pure optimization and explicitly out of MVP. The engine's scheduler is already written against an "eligible set" so only the run-one-at-a-time loop changes.

---

## 8. Token cost and caching considerations

- Each cell run is a fresh context — typically far *smaller* than a long chat (no 50-message history), but a feedback loop multiplies runs. The budgets in 6.4 cap worst-case spend; the toolbar shows cumulative usage for the run (input/output tokens summed from the existing per-turn `[CHAT] Usage` data, which main.ts already captures — we add the usage numbers to the chat IPC result payload so the renderer can display them; today they're only logged).
- Anthropic caching still helps inside a cell (multi-iteration inner tool loops re-read the cached tool/system prefix) but **not across cells** (different prompts/toolsets). The per-cell tool allowlist is the real cost lever: a 3-tool cell sends ~600 tokens of schemas instead of ~16K for all 80.
- The transcript drawer shows per-cell token usage after each run so users learn which cells are expensive.

---

## 9. Security and safety

- No new IPC surface beyond workflow file CRUD under `~/.mason/workflows/` (path is constructed main-side from an id slug — ids are `genId()` output, sanitized `[a-z0-9-]` — never from a renderer-supplied path).
- Cells can invoke the same tools chat can — no new capability, same user, same OAuth token. The per-cell allowlist only ever *narrows*.
- Workflow JSON renders through the same DOMPurify-sanitized markdown pipeline (cell prompts/outputs are user/model content; never `innerHTML` raw).
- Feedback loops are the new risk class (autonomous multi-step spend); mitigations are the three budgets (6.4), the always-visible Stop button, and sequential execution (one request in flight means Stop is instantaneous).

---

## 10. Logging

New `[DESIGNER]` (renderer/DevTools) and `[WORKFLOW]` (engine) prefixes, consistent with the existing table:

```
[WORKFLOW] Run started: "release pipeline" (4 cells, 5 edges)
[WORKFLOW] Cell "fable-spec" running (model databricks-fable-5, 2 tools)
[WORKFLOW] Cell "unit tests" verdict: route="implementation" notes="3 of 7 tests failing…" (iteration 2/5)
[WORKFLOW] Feedback budget exhausted for "opus-impl"; forcing terminal route
[WORKFLOW] Run complete: 9 cell runs, 142s, 88.4K in / 21.0K out tokens
```

---

## 11. Testing

1. **Unit (new, runs in CI-less `npm test:workflow` script):** graph validation (flow-cycle rejection, feedback-cycle acceptance, reachability), scheduler ordering incl. tie-breaks, context assembly snapshots (multi-input headers, feedback re-entry shape), verdict enum generation, budget enforcement (force-terminal behavior). Pure functions in `workflow-engine.ts` — testable in plain Node against `build/ts/`, same pattern as `test-models.js` consuming `chat-shared`.
2. **Model sweep extension:** add a `gate-verdict` scenario to `scripts/test-models.js` — attach the `route_output` tool with a 2-value enum and a prompt that demands a routing decision; assert a valid tool call comes back. This tells us *per model* whether it's gate-capable, and the designer can badge non-gate-capable models in the cell picker using the same family knowledge.
3. **Integration (`scripts/test-workflow.js`):** headless run of a 3-cell workflow (writer → reviewer-gate with feedback → terminal) against the live Gateway with cheap models (Haiku/Llama-8B), asserting completion within budgets and a coherent final output. Run manually before releases, like the sweep.
4. **Refactor gate (7.1):** full `test:models` sweep + manual chat smoke test (stream, tools, ask_user, abort, empty-response path) before the agent-runner extraction merges.
5. **Manual acceptance:** the Section 12 scenario, executed end-to-end.

---

## 12. Acceptance walkthrough (the user story, mapped)

| Story beat | Spec mechanism |
|---|---|
| "Click agentic designer, designer pane opens" | `#designerBtn` (4.1) → `switchToDesignerView()` (7.5) |
| "Select Fable 5, a couple of MCP tools, provide my prompt" | Cell config: model picker reusing discovered models; per-cell tool allowlist (7.2); prompt editor (4.2) |
| "Create another cell with Opus 4.8, different tools, additional prompt" | Second `WorkflowCellConfig`; per-cell everything |
| "Drag a line Fable → Opus; Fable runs first, output feeds Opus" | Flow edge (5); scheduling (6.1); context assembly (6.2) |
| "Unit-tests cell with Sonnet; receives Fable's spec **and** Opus's work (two inputs)" | Fan-in: two flow edges with labels `spec` and `implementation`; labeled multi-input sections (6.2) |
| "Provides Opus feedback; Opus iterates until gaps closed" | Unit-tests cell is a gate (feedback edge → Opus); `route_output` verdict (6.3); feedback re-entry context; downstream invalidation re-runs unit tests after each Opus pass |
| "Once complete, hands back to Fable for final review" | Unit-tests gate's flow edge → Fable review cell, taken when verdict route = that edge |
| "Fable ends the session or passes back to Opus" | Fable review cell is also a gate: routes `end` or feedback → Opus (6.3) |
| (implicit) "doesn't loop forever" | 5-iteration feedback caps + 25-run global budget + forced terminal route (6.4) |

Graph: `fable-spec ──spec──▶ unit-tests`, `fable-spec ──▶ opus-impl ──implementation──▶ unit-tests`, `unit-tests ┄feedback┄▶ opus-impl`, `unit-tests ──▶ fable-review`, `fable-review ┄feedback┄▶ opus-impl`, `fable-review` terminal-capable. This workflow ships as the built-in **"Spec → Implement → Test → Review"** template, available from the `⋯` menu, with model slots pre-filled from the workspace's discovered Fable/Opus/Sonnet endpoints when present.

---

## 13. Rollout

| Phase | Scope | Ships as |
|---|---|---|
| **0** | Agent-loop extraction (7.1) + per-cell tool param (7.2). Zero user-visible change; sweep-gated. | `refactor:` PR, v1.4.x |
| **1 (MVP)** | Designer view, cells, flow edges, DAG validation, sequential execution, save/load/autosave, transcript drawer, Stop/Resume. No gates yet — workflows must be DAGs. | `feat:` PR, v1.5.0 |
| **2** | Feedback edges, gates + `route_output`, budgets with forced-terminal, downstream invalidation, the built-in template, sweep `gate-verdict` scenario. | `feat:` PR, v1.5.x |
| **3** | Parallel branches (7.6 IPC change), persisted run history, per-run cost report, workflow export/import UI. | as demand warrants |

Phasing rationale: Phase 1 is independently useful (multi-model pipelines with fan-in/fan-out cover most real use) and de-risks the canvas; Phase 2's loop semantics are the most novel surface and benefit from Phase 1 user feedback on the context-assembly format.

---

## 14. Open questions (decide before Phase 1 build)

1. **Cell prompt = system or user message?** Spec says system (6.2). Some Gateway models weight system prompts oddly; the sweep's `multi-system` scenario covers delivery but not adherence. Cheap to flip later; flagged for prompt-quality testing during Phase 1.
2. **Should cells optionally share one conversation thread** (chat-style accumulation) instead of fresh-context-per-cell? Fresh context is the right default (predictable cost, no cross-contamination), but a "continue thread" edge option may emerge as a Phase 3 ask. Not in scope; noted so the engine keeps transcripts per cell-run (it does) rather than discarding them.
3. **`ask_user` inside a running workflow** pauses the whole run (sequential). Acceptable for MVP; the question card renders in the transcript drawer. Confirm with design whether the card should also surface as a modal so it isn't missed.
4. **Designer on small windows:** minimum useful canvas is ~900px wide. Below that, show the same "narrow window" treatment as dashboards? (Currently dashboards just squish.) Low stakes; default is squish.
