import fs from "node:fs";
import path from "node:path";
import { cleanup, type CleanupEntry, type CleanupOptions } from "./cleanup.js";
import { loadConfig, type Config } from "./config.js";
import type { Ctx } from "./context.js";
import { dispatchTask, retryTask, type DispatchOptions } from "./dispatch.js";
import { CosError } from "./errors.js";
import { findRepo } from "./git.js";
import { mergeRun, mergeTask, type MergeResult } from "./merge.js";
import {
  ackMessages,
  answerQuestion,
  listInbox,
  sendMessage,
  type InboxQuery,
  type SendInput,
} from "./messages.js";
import { parsePlan } from "./plan.js";
import { recoverOrphans } from "./recovery.js";
import { runStart, type RunStartOptions, type RunSummary } from "./scheduler.js";
import { buildStatus, type StatusReport } from "./status.js";
import { Store } from "./store.js";
import {
  addTasks,
  createRun,
  listDecisions,
  listTasksRefreshed,
  openDecision,
  resolveDecision,
  type CreateRunInput,
  type TaskInput,
} from "./tasks.js";
import type { Decision, Dispatch, Message, Run, Task } from "./types.js";

export interface CoordinatorOptions {
  /** any directory inside the repository (or one of its worktrees); defaults to the current directory */
  repo?: string;
  /** config file path, relative to the repository root; defaults to cos.config.json */
  config?: string;
  /** worker supervision interval in milliseconds (default 250) */
  pollMs?: number;
  log?: (message: string) => void;
}

/** Coordinator-side API. One instance per repository; all state lives under `<git-dir>/cos/`. */
export class Coordinator {
  readonly ctx: Ctx;

  constructor(opts: CoordinatorOptions = {}) {
    const repo = findRepo(opts.repo ?? process.cwd());
    const store = new Store(path.join(repo.gitDir, "cos"));
    this.ctx = {
      repo,
      store,
      loadConfig: () => loadConfig(repo.root, opts.config),
      configFile: path.resolve(repo.root, opts.config ?? "cos.config.json"),
      pollMs: opts.pollMs ?? 250,
      log: opts.log ?? (() => undefined),
    };
  }

  get repoRoot(): string {
    return this.ctx.repo.root;
  }

  get stateDir(): string {
    return this.ctx.store.root;
  }

  config(): Config {
    return this.ctx.loadConfig();
  }

  // runs
  createRun(input: CreateRunInput): Run {
    return createRun(this.ctx, input);
  }

  listRuns(): Run[] {
    return this.ctx.store.listRuns();
  }

  getRun(runId: string): Run {
    return this.ctx.store.getRun(runId);
  }

  /** The explicit run id, or the only run in the repository. */
  resolveRun(runId?: string): string {
    if (runId) {
      this.ctx.store.getRun(runId);
      return runId;
    }
    const runs = this.ctx.store.listRuns();
    if (runs.length === 1 && runs[0]) return runs[0].id;
    if (runs.length === 0) throw new CosError('no runs in this repository; create one with "cos run create"');
    throw new CosError(`several runs exist (${runs.map((r) => r.id).join(", ")}); pass --run <id>`);
  }

  /** Finds the run that owns a task id; ambiguous ids need an explicit run. */
  resolveTask(taskId: string, runId?: string): { runId: string; task: Task } {
    if (runId) return { runId, task: this.ctx.store.getTask(runId, taskId) };
    const hits = this.ctx.store
      .listRuns()
      .map((r) => this.ctx.store.findTask(r.id, taskId))
      .filter((t): t is Task => t !== undefined);
    if (hits.length === 1 && hits[0]) return { runId: hits[0].runId, task: hits[0] };
    if (hits.length === 0) throw new CosError(`unknown task "${taskId}"`);
    throw new CosError(`task id "${taskId}" exists in runs ${hits.map((t) => t.runId).join(", ")}; pass --run <id>`);
  }

  // tasks
  addTask(runId: string, input: TaskInput): Task {
    const [task] = addTasks(this.ctx, runId, [input]);
    if (!task) throw new CosError("task was not created");
    return task;
  }

  addTasks(runId: string, inputs: TaskInput[]): Task[] {
    return addTasks(this.ctx, runId, inputs);
  }

  listTasks(runId: string): Task[] {
    return listTasksRefreshed(this.ctx, runId);
  }

  /** Loads a YAML/JSON plan into an existing run, or creates a run from the plan's objective. */
  loadPlan(file: string, opts: { runId?: string; newRunId?: string; base?: string } = {}): { run: Run; tasks: Task[]; created: boolean } {
    const abs = path.resolve(file);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch (err) {
      throw new CosError(`cannot read plan ${abs}: ${(err as Error).message}`);
    }
    const plan = parsePlan(abs, text);
    if (opts.runId) {
      const run = this.getRun(opts.runId);
      return { run, tasks: addTasks(this.ctx, run.id, plan.tasks), created: false };
    }
    if (!plan.objective) {
      throw new CosError("the plan has no objective; pass --run <id> to add its tasks to an existing run");
    }
    const run = createRun(this.ctx, { objective: plan.objective, id: opts.newRunId, base: opts.base });
    try {
      return { run, tasks: addTasks(this.ctx, run.id, plan.tasks), created: true };
    } catch (err) {
      fs.rmSync(this.ctx.store.runDir(run.id), { recursive: true, force: true });
      throw err;
    }
  }

  // execution
  dispatch(runId: string, taskId: string, opts?: DispatchOptions): Promise<Dispatch> {
    return dispatchTask(this.ctx, runId, taskId, opts);
  }

  retry(runId: string, taskId: string, opts?: DispatchOptions): Promise<Dispatch> {
    return retryTask(this.ctx, runId, taskId, opts);
  }

  start(runId: string, opts?: RunStartOptions): Promise<RunSummary> {
    return runStart(this.ctx, runId, opts);
  }

  recover(runId?: string): Dispatch[] {
    return recoverOrphans(this.ctx, runId);
  }

  dispatches(runId: string, taskId?: string): Dispatch[] {
    const all = this.ctx.store.listDispatches(runId);
    return taskId ? all.filter((d) => d.taskId === taskId) : all;
  }

  // messages
  inbox(q: InboxQuery): Message[] {
    return listInbox(this.ctx, q);
  }

  send(input: SendInput): Message {
    return sendMessage(this.ctx, input);
  }

  ack(runId: string, ids: string[] | "all"): string[] {
    return ackMessages(this.ctx, runId, ids);
  }

  answer(runId: string, messageId: string, text: string): Message {
    return answerQuestion(this.ctx, runId, messageId, text);
  }

  // decision gates
  openGate(runId: string, taskId: string, question: string, options?: string[]): Decision {
    return openDecision(this.ctx, runId, taskId, question, options);
  }

  gates(runId: string, includeResolved = false): Decision[] {
    return listDecisions(this.ctx, runId, includeResolved);
  }

  resolveGate(runId: string, gateId: string, decision: string): Decision {
    return resolveDecision(this.ctx, runId, gateId, decision);
  }

  // integration
  merge(runId: string, taskId: string): Promise<MergeResult> {
    return mergeTask(this.ctx, runId, taskId);
  }

  mergeAll(runId: string): Promise<MergeResult[]> {
    return mergeRun(this.ctx, runId);
  }

  cleanup(opts?: CleanupOptions): CleanupEntry[] {
    return cleanup(this.ctx, opts);
  }

  status(runId: string): StatusReport {
    return buildStatus(this.ctx, runId);
  }
}
