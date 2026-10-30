export type TaskStatus =
  | "pending"
  | "ready"
  | "dispatched"
  | "review"
  | "completed"
  | "failed"
  | "blocked";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "ready",
  "dispatched",
  "review",
  "completed",
  "failed",
  "blocked",
];

export type BlockKind = "question" | "decision" | "merge-conflict";

export interface Blocked {
  kind: BlockKind;
  /** message id (question) or decision id (decision) */
  ref?: string;
  detail?: string;
  /** conflicting paths for merge-conflict */
  files?: string[];
}

export interface Run {
  id: string;
  objective: string;
  repoRoot: string;
  baseRef: string;
  baseCommit: string;
  integrationBranch: string;
  createdAt: string;
  counters: { task: number; dispatch: number; message: number; decision: number };
}

export interface Task {
  id: string;
  runId: string;
  title: string;
  spec: string;
  acceptance: string[];
  after: string[];
  worker?: string;
  status: TaskStatus;
  blocked?: Blocked;
  attempts: number;
  lastDispatchId?: string;
  failure?: string;
  /** set when the last merge attempt conflicted; cleared by a successful merge */
  mergeConflict?: { files: string[]; at: string };
  summary?: string;
  merged?: { at: string; commit: string };
  /** creation order, used for stable scheduling */
  order: number;
  createdAt: string;
  updatedAt: string;
}

export type DispatchStatus =
  | "running"
  | "gating"
  | "passed"
  | "failed"
  | "timed_out"
  | "stalled"
  | "orphaned"
  | "asked";

export type FailureKind = "worker" | "gate" | "spawn" | "timeout" | "stalled" | "orphaned" | "setup";

export interface WorkerResult {
  outcome: "success" | "failure";
  summary?: string;
  filesModified?: string[];
}

export interface GateResult {
  name: string;
  format: "exit" | "refcheck-json";
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  command: string;
  summary: string;
  /** tail of the gate output (or the formatted findings for refcheck-json) */
  output: string;
}

export interface Dispatch {
  id: string;
  runId: string;
  taskId: string;
  attempt: number;
  status: DispatchStatus;
  failureKind?: FailureKind;
  failure?: string;
  worker: string;
  command?: string;
  worktree?: string;
  branch?: string;
  briefPath?: string;
  logPath?: string;
  baseCommit?: string;
  headCommit?: string;
  pid?: number;
  pidStart?: string;
  supervisorPid: number;
  supervisorStart?: string;
  startedAt: string;
  processStartedAt?: string;
  processEndedAt?: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  result?: WorkerResult;
  gates?: GateResult[];
  /** things the coordinator ignored or refused, e.g. an oversized or non-regular worker file */
  warnings?: string[];
}

export type MessageType = "status" | "question" | "escalation" | "worker_done";
export const MESSAGE_TYPES: readonly MessageType[] = [
  "status",
  "question",
  "escalation",
  "worker_done",
];

export interface Message {
  id: string;
  runId: string;
  type: MessageType;
  /** "coordinator", "worker:<dispatchId>" or any label given to `cos send` */
  from: string;
  /** "coordinator" (the inbox) or a task id */
  to: string;
  taskId?: string;
  dispatchId?: string;
  body: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  ackedAt?: string;
  answer?: { text: string; at: string };
}

export interface Decision {
  id: string;
  runId: string;
  taskId: string;
  question: string;
  options?: string[];
  status: "open" | "resolved";
  decision?: string;
  openedAt: string;
  resolvedAt?: string;
}
