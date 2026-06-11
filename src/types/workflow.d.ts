// Ambient types for the Agentic Workflow Designer.
// See docs/specs/agentic-workflow-designer.md for semantics.

declare global {
  interface WorkflowCellConfig {
    id: string;
    name: string;
    model: { value: string; label: string };
    enabledTools: string[];
    prompt: string;
    position: { x: number; y: number };
    maxLoopIterations?: number; // feedback re-entry cap, default 5
  }

  type WorkflowEdgeKind = "flow" | "feedback";

  interface WorkflowEdge {
    id: string;
    from: string; // cell id
    to: string; // cell id
    kind: WorkflowEdgeKind;
    label?: string; // input header downstream / route name for gates
  }

  interface MasonWorkflow {
    id: string;
    name: string;
    version: 1;
    cells: WorkflowCellConfig[];
    edges: WorkflowEdge[];
    createdAt: number;
    updatedAt: number;
  }

  interface MasonWorkflowSummary {
    id: string;
    name: string;
    updatedAt: number;
  }

  type CellRunStatus = "idle" | "queued" | "running" | "done" | "failed" | "skipped";

  interface CellTranscriptEntry {
    kind: "assistant" | "tool-call" | "tool-result" | "error" | "verdict" | "info";
    text: string;
  }

  interface CellRunRecord {
    status: CellRunStatus;
    transcript: CellTranscriptEntry[];
    output: string; // final assistant text of the most recent run
    verdict?: { route: string; notes: string };
    iterations: number; // feedback re-entries (1 = first run)
    error?: string;
  }

  interface WorkflowRunState {
    workflowId: string;
    running: boolean;
    aborted: boolean;
    cells: Record<string, CellRunRecord>;
    startedAt: number;
    totalSteps: number; // cell runs consumed from the global budget
    error?: string;
  }
}

export {};
