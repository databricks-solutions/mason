// Workflow execution engine for the Agentic Workflow Designer.
// See docs/specs/agentic-workflow-designer.md (Section 6) for semantics.
//
// A workflow run is a sequence of cell runs; each cell run is one bounded
// headless agent loop (reusing resolveModelRouting / executeToolCore from
// agent-runner.ts); edges define order and context. Cells run one at a time —
// main.ts has a single in-flight chat controller, so sequential execution
// keeps Stop and chunk routing correct (spec 7.6 defers parallelism).

// --- budgets (spec 6.4) ---
const WORKFLOW_GLOBAL_BUDGET = 25; // cell runs per workflow run
const WORKFLOW_INNER_BUDGET = 40; // agent-loop iterations within one cell run
const WORKFLOW_DEFAULT_LOOP_CAP = 5; // feedback re-entries per cell
const ROUTE_TOOL_NAME = "route_output";

interface EngineCallbacks {
  onCellStatus(cellId: string, status: CellRunStatus): void;
  onCellTranscript(cellId: string, entry: CellTranscriptEntry): void;
  // Streamed text of the in-progress assistant turn (full text so far).
  onStreamText(cellId: string, text: string): void;
  askUser(
    questions: Array<{ question: string; options: string[]; multiSelect?: boolean }>
  ): Promise<string>;
}

// --- graph helpers ---

function wfFlowEdges(wf: MasonWorkflow): WorkflowEdge[] {
  return wf.edges.filter((e) => e.kind === "flow");
}

function wfCellById(wf: MasonWorkflow, id: string): WorkflowCellConfig | undefined {
  return wf.cells.find((c) => c.id === id);
}

// Route key shown to the model for an outgoing edge: explicit label first,
// target cell name fallback.
function wfRouteKey(wf: MasonWorkflow, edge: WorkflowEdge): string {
  if (edge.label && edge.label.trim()) return edge.label.trim();
  return wfCellById(wf, edge.to)?.name || edge.to;
}

// Input section header the downstream model sees for an inbound edge.
function wfInputLabel(wf: MasonWorkflow, edge: WorkflowEdge): string {
  if (edge.label && edge.label.trim()) return edge.label.trim();
  return wfCellById(wf, edge.from)?.name || edge.from;
}

function wfIsGate(wf: MasonWorkflow, cellId: string): boolean {
  return wf.edges.some((e) => e.from === cellId && e.kind === "feedback");
}

// Flow-descendants of a cell (feedback edges don't propagate invalidation).
function wfFlowDescendants(wf: MasonWorkflow, startId: string): Set<string> {
  const out = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of wfFlowEdges(wf)) {
      if (e.from === id && !out.has(e.to)) {
        out.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return out;
}

// Validation per spec 4.3. Returns a list of human-readable errors; empty
// means runnable.
function validateWorkflow(wf: MasonWorkflow): string[] {
  const errors: string[] = [];
  if (wf.cells.length === 0) {
    errors.push("Add at least one cell.");
    return errors;
  }
  const ids = new Set(wf.cells.map((c) => c.id));
  for (const c of wf.cells) {
    if (!c.model?.value) errors.push(`Cell "${c.name}" has no model selected.`);
  }
  for (const e of wf.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) errors.push("An edge points at a deleted cell.");
    if (e.from === e.to) errors.push("A cell cannot connect to itself.");
  }

  // Flow-edge-only cycles are illegal (cycles must include a feedback edge).
  // Kahn's algorithm: if we can't consume every cell, there's a flow cycle.
  const indeg = new Map<string, number>();
  for (const c of wf.cells) indeg.set(c.id, 0);
  for (const e of wfFlowEdges(wf)) {
    if (ids.has(e.to)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  const queue = wf.cells.filter((c) => (indeg.get(c.id) || 0) === 0).map((c) => c.id);
  let consumed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    consumed += 1;
    for (const e of wfFlowEdges(wf)) {
      if (e.from !== id) continue;
      const d = (indeg.get(e.to) || 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  if (consumed < wf.cells.length) {
    errors.push(
      "Cells are connected in a loop of solid (flow) edges. Loops are only allowed through dashed feedback edges."
    );
  }

  // Model availability in the current profile.
  for (const c of wf.cells) {
    if (!c.model?.value) continue;
    if (!workflowModelAvailable(c.model.value)) {
      errors.push(
        `Cell "${c.name}" uses model "${c.model.label || c.model.value}", which isn't available in this workspace.`
      );
    }
  }
  return errors;
}

function workflowModelAvailable(value: string): boolean {
  if (value.startsWith("custom:")) {
    const id = value.replace("custom:", "");
    return mason.customEndpoints.some((e) => e.modelId === id);
  }
  return mason.discoveredModels.some((g) => g.models.some((m) => m.value === value));
}

// --- context assembly (spec 6.2) ---

interface FeedbackPayload {
  fromCell: string;
  notes: string;
  prevOutput: string;
  iteration: number;
}

function buildCellPreamble(
  wf: MasonWorkflow,
  cell: WorkflowCellConfig,
  routes: Array<{ key: string; edge: WorkflowEdge }> | null,
  runState: WorkflowRunState | null
): string {
  const lines: string[] = [
    `You are the cell "${cell.name}" in the agentic workflow "${wf.name}".`,
    `Workflow cells run in sequence; your final message becomes the input of downstream cells.`,
  ];
  const downstream = wfFlowEdges(wf)
    .filter((e) => e.from === cell.id)
    .map((e) => wfCellById(wf, e.to)?.name || e.to);
  if (downstream.length > 0 && !routes) {
    lines.push(`Your output will be passed to: ${downstream.join(", ")}.`);
  }
  if (routes) {
    lines.push(
      "",
      `When your work is complete you MUST call the "${ROUTE_TOOL_NAME}" tool exactly once to decide where the workflow goes next. Available routes:`
    );
    for (const r of routes) {
      const target = wfCellById(wf, r.edge.to);
      const targetName = target?.name || r.edge.to;
      if (r.edge.kind === "feedback" && target) {
        const cap = target.maxLoopIterations || WORKFLOW_DEFAULT_LOOP_CAP;
        const used = runState?.cells[target.id]?.iterations || 0;
        lines.push(
          `  - "${r.key}": send feedback back to the "${targetName}" cell (revision ${used} of ${cap} used — after ${cap} this route closes)`
        );
      } else {
        lines.push(`  - "${r.key}": hand off to the "${targetName}" cell`);
      }
    }
    lines.push(`  - "end": the workflow is complete; provide a final summary in notes`);
    lines.push(
      `Feedback loops are bounded — do not chase perfection. Judge against a concrete bar: once the work meets it, move forward or end. Reserve feedback routes for specific, fixable problems, and make each piece of feedback materially different from the last.`
    );
    lines.push(`Do not end your turn without calling ${ROUTE_TOOL_NAME}.`);
  }
  return lines.join("\n");
}

function buildCellMessages(
  wf: MasonWorkflow,
  cell: WorkflowCellConfig,
  delivered: Map<string, string>,
  feedback: FeedbackPayload | null,
  routes: Array<{ key: string; edge: WorkflowEdge }> | null,
  runState: WorkflowRunState | null
): any[] {
  const messages: any[] = [];
  if (cell.prompt.trim()) messages.push({ role: "system", content: cell.prompt.trim() });
  messages.push({ role: "system", content: buildCellPreamble(wf, cell, routes, runState) });

  const sections: string[] = [];
  for (const e of wfFlowEdges(wf)) {
    if (e.to !== cell.id) continue;
    const payload = delivered.get(e.id);
    if (payload === undefined) continue;
    // Annotate revised work with its revision count so gates feel the
    // convergence pressure ("revision 4 of 5" reads very differently from a
    // first draft).
    const source = wfCellById(wf, e.from);
    const srcIters = (source && runState?.cells[source.id]?.iterations) || 0;
    const srcCap = source?.maxLoopIterations || WORKFLOW_DEFAULT_LOOP_CAP;
    const revNote = srcIters > 1 ? ` (revision ${srcIters} of ${srcCap})` : "";
    sections.push(`## Input from "${wfInputLabel(wf, e)}"${revNote}\n\n${payload}`);
  }
  if (feedback) {
    const cap = cell.maxLoopIterations || WORKFLOW_DEFAULT_LOOP_CAP;
    sections.push(
      `## Feedback from "${feedback.fromCell}" (revision ${feedback.iteration} of ${cap})\n\n${feedback.notes}`
    );
    if (feedback.prevOutput) {
      sections.push(`## Your previous output\n\n${feedback.prevOutput}`);
    }
  }
  messages.push({
    role: "user",
    content: sections.length > 0 ? sections.join("\n\n") : "Begin. Follow your instructions.",
  });
  return messages;
}

function buildRouteTool(routes: Array<{ key: string; edge: WorkflowEdge }>): ToolDef {
  return {
    type: "function",
    function: {
      name: ROUTE_TOOL_NAME,
      description:
        "REQUIRED final action: choose where this workflow goes next. Call exactly once, when your work in this cell is complete.",
      parameters: {
        type: "object",
        properties: {
          route: {
            type: "string",
            enum: [...routes.map((r) => r.key), "end"],
            description: "The route to take next, or 'end' to complete the workflow.",
          },
          notes: {
            type: "string",
            description:
              "Feedback or instructions for the target cell — or the final summary if ending.",
          },
        },
        required: ["route", "notes"],
      },
    },
  };
}

// --- cell run (headless agent loop) ---

interface CellRunOutcome {
  outcome: "text" | "verdict" | "failed" | "aborted";
  finalText: string;
  verdict?: { route: string; notes: string };
  error?: string;
}

// Called when a gate proposes a verdict. Return null to accept, or an error
// string to reject (sent back as the tool result; the loop continues).
type VerdictGatekeeper = (verdict: { route: string; notes: string }) => string | null;

async function runCellLoop(
  wf: MasonWorkflow,
  cell: WorkflowCellConfig,
  initialMessages: any[],
  routes: Array<{ key: string; edge: WorkflowEdge }> | null,
  gatekeeper: VerdictGatekeeper | null,
  runState: WorkflowRunState,
  cb: EngineCallbacks
): Promise<CellRunOutcome> {
  const transcript: any[] = [...initialMessages];

  const allowlist = new Set(cell.enabledTools);
  const toolDefs = getAllToolDefs(allowlist);
  const missing = cell.enabledTools.filter(
    (n) => !toolDefs.some((t) => t.function.name === n)
  );
  if (missing.length > 0) {
    console.warn(`[WORKFLOW] Cell "${cell.name}": tools unavailable, dropped: ${missing.join(", ")}`);
  }
  const toolsForApi: any[] = toolDefs.map(({ type, function: fn }) => ({ type, function: fn }));
  if (routes) toolsForApi.push(buildRouteTool(routes));

  let routeReminders = 0;
  let budget = WORKFLOW_INNER_BUDGET;

  while (budget-- > 0) {
    if (runState.aborted) return { outcome: "aborted", finalText: "" };

    const token = await getAuthToken();
    const routing = resolveModelRouting(cell.model.value, toolsForApi.length > 0);
    const canStream = routing.format !== "responses";

    let streamedText = "";
    if (canStream) {
      window.api.onChatChunk((chunk: any) => {
        streamedText += chunk;
        cb.onStreamText(cell.id, streamedText);
      });
    }

    let result: any;
    try {
      result = await window.api.chat({
        token,
        model: routing.model,
        messages: transcript,
        tools: toolsForApi.length > 0 ? toolsForApi : undefined,
        gateway: routing.gateway,
        format: routing.format,
        stream: canStream,
      });
    } catch (e) {
      if (canStream) window.api.removeChatChunkListeners();
      if (runState.aborted) return { outcome: "aborted", finalText: streamedText };
      return { outcome: "failed", finalText: "", error: (e as Error).message };
    }
    if (canStream) window.api.removeChatChunkListeners();
    if (runState.aborted) return { outcome: "aborted", finalText: streamedText };

    if (result.type === "text") {
      const content = (result.content || "").trim();
      if (!content) {
        return {
          outcome: "failed",
          finalText: "",
          error:
            "Model returned an empty response — likely hit its token budget mid-thinking. Try a smaller prompt or a different model.",
        };
      }
      if (routes) {
        // Gates must route. Remind twice, then fail (spec 6.3 fallback).
        if (routeReminders < 2) {
          routeReminders += 1;
          transcript.push({ role: "assistant", content });
          cb.onCellTranscript(cell.id, { kind: "assistant", text: content });
          transcript.push({
            role: "user",
            content: `You must now call the ${ROUTE_TOOL_NAME} tool to choose the next route. Do not reply with text.`,
          });
          continue;
        }
        return {
          outcome: "failed",
          finalText: content,
          error: `Cell "${cell.name}" never called ${ROUTE_TOOL_NAME}. Use a tool-capable model for cells with feedback edges.`,
        };
      }
      cb.onCellTranscript(cell.id, { kind: "assistant", text: content });
      return { outcome: "text", finalText: content };
    }

    if (result.type === "tool_calls") {
      transcript.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.tool_calls,
      });
      if (result.content) {
        cb.onCellTranscript(cell.id, { kind: "assistant", text: result.content });
      }

      for (const tc of result.tool_calls || []) {
        const toolName = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch (_) {}

        if (toolName === ROUTE_TOOL_NAME && routes) {
          const verdict = {
            route: String(args.route || ""),
            notes: String(args.notes || ""),
          };
          const rejection = gatekeeper ? gatekeeper(verdict) : null;
          const known =
            verdict.route === "end" || routes.some((r) => r.key === verdict.route);
          if (!known) {
            transcript.push({
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: `Error: "${verdict.route}" is not a valid route. Choose one of: ${[...routes.map((r) => r.key), "end"].join(", ")}.`,
            });
            continue;
          }
          if (rejection) {
            cb.onCellTranscript(cell.id, { kind: "info", text: rejection });
            transcript.push({
              role: "tool",
              tool_call_id: tc.id,
              name: toolName,
              content: `Error: ${rejection}`,
            });
            continue;
          }
          // Accepted — the verdict ends the cell run. The latest assistant
          // text (preamble of this turn, or the previous turn's output)
          // stands as the cell's output.
          const lastText =
            result.content ||
            [...transcript].reverse().find((m: any) => m.role === "assistant" && typeof m.content === "string" && m.content)?.content ||
            "";
          return { outcome: "verdict", finalText: lastText, verdict };
        }

        if (toolName === "ask_user") {
          let questions: Array<{ question: string; options: string[]; multiSelect?: boolean }>;
          if (Array.isArray(args.questions)) {
            questions = args.questions as any[];
          } else if (typeof args.question === "string") {
            questions = [
              {
                question: args.question as string,
                options: (args.options as string[]) || [],
                multiSelect: Boolean(args.multiSelect),
              },
            ];
          } else {
            questions = [];
          }
          const answer = await cb.askUser(questions);
          transcript.push({
            role: "tool",
            tool_call_id: tc.id,
            name: toolName,
            content: answer,
          });
          continue;
        }

        cb.onCellTranscript(cell.id, { kind: "tool-call", text: `Calling tool: ${toolName}` });
        const r = await executeToolCore(toolName, args);
        transcript.push({
          role: "tool",
          tool_call_id: tc.id,
          name: toolName,
          content: r.content,
        });
        cb.onCellTranscript(cell.id, {
          kind: r.ok ? "tool-result" : "error",
          text: r.ok ? `${toolName}: ${r.preview}` : `Tool error (${toolName}): ${r.preview}`,
        });
        if (runState.aborted) return { outcome: "aborted", finalText: "" };
      }
      continue;
    }

    return { outcome: "failed", finalText: "", error: "Unexpected response type from gateway." };
  }

  return {
    outcome: "failed",
    finalText: "",
    error: `Cell "${cell.name}" hit the ${WORKFLOW_INNER_BUDGET}-step agent-loop budget without finishing.`,
  };
}

// --- workflow run (scheduler) ---

async function runWorkflow(wf: MasonWorkflow, cb: EngineCallbacks): Promise<WorkflowRunState> {
  const state: WorkflowRunState = {
    workflowId: wf.id,
    running: true,
    aborted: false,
    cells: {},
    startedAt: Date.now(),
    totalSteps: 0,
  };
  for (const c of wf.cells) {
    state.cells[c.id] = { status: "idle", transcript: [], output: "", iterations: 0 };
    cb.onCellStatus(c.id, "idle");
  }
  mason.workflowRun = state;

  // Payload delivered along each flow edge (edge id → text).
  const delivered = new Map<string, string>();
  const resolved = new Set<string>(); // done or skipped
  const pendingFeedback = new Map<string, FeedbackPayload>();

  console.log(`[WORKFLOW] Run started: "${wf.name}" (${wf.cells.length} cells, ${wf.edges.length} edges)`);

  const inboundFlow = (cellId: string): WorkflowEdge[] =>
    wfFlowEdges(wf).filter((e) => e.to === cellId);

  // Stable order: topological-ish by canvas position (top-to-bottom,
  // left-to-right) so execution order is visually predictable among ties.
  const cellOrder = [...wf.cells].sort(
    (a, b) => a.position.y - b.position.y || a.position.x - b.position.x
  );

  try {
    while (!state.aborted) {
      // Resolve skippable cells first: all inbound resolved, none delivered.
      let movedSomething = true;
      while (movedSomething) {
        movedSomething = false;
        for (const cell of cellOrder) {
          if (resolved.has(cell.id)) continue;
          const inbound = inboundFlow(cell.id);
          if (inbound.length === 0) continue;
          const allResolved = inbound.every((e) => resolved.has(e.from));
          const anyDelivered = inbound.some((e) => delivered.has(e.id));
          if (allResolved && !anyDelivered) {
            resolved.add(cell.id);
            state.cells[cell.id].status = "skipped";
            cb.onCellStatus(cell.id, "skipped");
            movedSomething = true;
          }
        }
      }

      // Pick the next eligible cell.
      const next = cellOrder.find((cell) => {
        if (resolved.has(cell.id)) return false;
        const inbound = inboundFlow(cell.id);
        if (!inbound.every((e) => resolved.has(e.from))) return false;
        return inbound.length === 0 || inbound.some((e) => delivered.has(e.id));
      });
      if (!next) break; // nothing left to run — workflow complete

      if (state.totalSteps >= WORKFLOW_GLOBAL_BUDGET) {
        state.error = `Workflow hit the global budget of ${WORKFLOW_GLOBAL_BUDGET} cell runs. Check for runaway feedback loops.`;
        break;
      }
      state.totalSteps += 1;

      const rec = state.cells[next.id];
      rec.status = "running";
      rec.iterations += 1;
      rec.error = undefined;
      rec.verdict = undefined;
      rec.transcript = [];
      cb.onCellStatus(next.id, "running");

      const outgoing = wf.edges.filter((e) => e.from === next.id);
      const isGate = outgoing.some((e) => e.kind === "feedback");
      // Route keys must be unique; disambiguate duplicates with a suffix.
      let routes: Array<{ key: string; edge: WorkflowEdge }> | null = null;
      if (isGate) {
        const seen = new Set<string>();
        routes = outgoing.map((edge) => {
          let key = wfRouteKey(wf, edge);
          while (seen.has(key) || key === "end") key = `${key}-2`;
          seen.add(key);
          return { key, edge };
        });
      }

      const feedback = pendingFeedback.get(next.id) || null;
      pendingFeedback.delete(next.id);
      const messages = buildCellMessages(wf, next, delivered, feedback, routes, state);

      console.log(
        `[WORKFLOW] Cell "${next.name}" running (model ${next.model.value}, ${next.enabledTools.length} tools${isGate ? ", gate" : ""}${feedback ? `, iteration ${rec.iterations}` : ""})`
      );

      // Gatekeeper: reject feedback routes whose target is out of loop budget
      // (spec 6.4 — force the gate to choose another route).
      const gatekeeper: VerdictGatekeeper | null = routes
        ? (verdict) => {
            if (verdict.route === "end") return null;
            const r = routes!.find((x) => x.key === verdict.route);
            if (!r || r.edge.kind !== "feedback") return null;
            const target = wfCellById(wf, r.edge.to)!;
            const cap = target.maxLoopIterations || WORKFLOW_DEFAULT_LOOP_CAP;
            if (state.cells[target.id].iterations >= cap) {
              return `Loop budget exhausted for "${target.name}" (${cap} iterations). Choose a different route or "end".`;
            }
            return null;
          }
        : null;

      const out = await runCellLoop(wf, next, messages, routes, gatekeeper, state, cb);

      if (out.outcome === "aborted") {
        rec.status = "failed";
        rec.error = "Stopped by user.";
        cb.onCellStatus(next.id, "failed");
        break;
      }
      if (out.outcome === "failed") {
        rec.status = "failed";
        rec.error = out.error;
        cb.onCellTranscript(next.id, { kind: "error", text: out.error || "Cell failed." });
        cb.onCellStatus(next.id, "failed");
        state.error = out.error;
        break;
      }

      rec.output = out.finalText;
      rec.status = "done";
      resolved.add(next.id);
      cb.onCellStatus(next.id, "done");

      if (out.outcome === "text") {
        // Non-gate: deliver output on every outgoing flow edge (fan-out).
        for (const e of outgoing) {
          if (e.kind === "flow") delivered.set(e.id, out.finalText);
        }
        continue;
      }

      // Gate verdict handling.
      const verdict = out.verdict!;
      rec.verdict = verdict;
      cb.onCellTranscript(next.id, {
        kind: "verdict",
        text: `Route: ${verdict.route} — ${verdict.notes}`,
      });
      console.log(
        `[WORKFLOW] Cell "${next.name}" verdict: route="${verdict.route}" (iteration ${rec.iterations})`
      );

      if (verdict.route === "end") continue; // delivers nothing; downstream skips

      const chosen = routes!.find((r) => r.key === verdict.route)!;
      if (chosen.edge.kind === "flow") {
        const payload = out.finalText
          ? `${out.finalText}\n\n## Notes from "${next.name}"\n\n${verdict.notes}`
          : verdict.notes;
        delivered.set(chosen.edge.id, payload);
        continue;
      }

      // Feedback route: re-open the target and everything downstream of it.
      const target = wfCellById(wf, chosen.edge.to)!;
      pendingFeedback.set(target.id, {
        fromCell: next.name,
        notes: verdict.notes,
        prevOutput: state.cells[target.id].output,
        iteration: state.cells[target.id].iterations + 1,
      });
      const reopen = wfFlowDescendants(wf, target.id);
      reopen.add(target.id);
      for (const id of reopen) {
        resolved.delete(id);
        // Outputs from re-opened cells are stale — clear their deliveries.
        for (const e of wfFlowEdges(wf)) {
          if (e.from === id) delivered.delete(e.id);
        }
        if (state.cells[id].status !== "running") {
          state.cells[id].status = "queued";
          cb.onCellStatus(id, "queued");
        }
      }
    }
  } finally {
    state.running = false;
    const secs = Math.round((Date.now() - state.startedAt) / 1000);
    console.log(
      `[WORKFLOW] Run ${state.aborted ? "stopped" : state.error ? "failed" : "complete"}: ${state.totalSteps} cell runs, ${secs}s`
    );
  }
  return state;
}
