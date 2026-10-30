import fs from "node:fs";
import path from "node:path";
import { CosError } from "./errors.js";
import { atomicWriteJson, readJson, withLockSync } from "./fsutil.js";
import type { Decision, Dispatch, Message, Run, Task } from "./types.js";

export const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function assertValidId(kind: string, id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new CosError(
      `invalid ${kind} id "${id}": use 1-48 lowercase letters, digits, "-" or "_", starting with a letter or digit`,
    );
  }
}

type Counter = keyof Run["counters"];

/** directory name -> singular label used in error messages */
const KIND_LABEL: Record<string, string> = {
  tasks: "task",
  dispatches: "dispatch",
  messages: "message",
  decisions: "decision",
};

/**
 * File-per-entity JSON store:
 *
 *   <root>/runs/<run>/run.json
 *   <root>/runs/<run>/tasks/<task>.json
 *   <root>/runs/<run>/dispatches/<dispatch>.json
 *   <root>/runs/<run>/messages/<message>.json
 *   <root>/runs/<run>/decisions/<decision>.json
 *
 * Every write is atomic (tmp file + rename). Read-modify-write sequences must run
 * inside `tx`, which holds a per-run lock.
 */
export class Store {
  constructor(readonly root: string) {}

  runDir(runId: string): string {
    // ids reach this point from the command line; never let one escape the state directory
    assertValidId("run", runId);
    return path.join(this.root, "runs", runId);
  }

  private file(runId: string, kind: string, id: string): string {
    assertValidId(KIND_LABEL[kind] ?? kind, id);
    return path.join(this.runDir(runId), kind, `${id}.json`);
  }

  private listDir<T>(runId: string, kind: string): T[] {
    const dir = path.join(this.runDir(runId), kind);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: T[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const value = readJson<T>(path.join(dir, name));
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  tx<T>(runId: string, fn: (store: Store) => T): T {
    return withLockSync(path.join(this.runDir(runId), ".lock"), () => fn(this));
  }

  // runs
  listRuns(): Run[] {
    const dir = path.join(this.root, "runs");
    if (!fs.existsSync(dir)) return [];
    const runs: Run[] = [];
    for (const name of fs.readdirSync(dir)) {
      const run = readJson<Run>(path.join(dir, name, "run.json"));
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  findRun(runId: string): Run | undefined {
    return readJson<Run>(path.join(this.runDir(runId), "run.json"));
  }

  getRun(runId: string): Run {
    const run = this.findRun(runId);
    if (!run) throw new CosError(`unknown run "${runId}"`);
    return run;
  }

  putRun(run: Run): void {
    atomicWriteJson(path.join(this.runDir(run.id), "run.json"), run);
  }

  allocId(runId: string, counter: Counter, prefix: string): string {
    const run = this.getRun(runId);
    run.counters[counter] += 1;
    this.putRun(run);
    return `${prefix}${run.counters[counter]}`;
  }

  // tasks
  listTasks(runId: string): Task[] {
    return this.listDir<Task>(runId, "tasks").sort((a, b) => a.order - b.order);
  }

  findTask(runId: string, taskId: string): Task | undefined {
    return readJson<Task>(this.file(runId, "tasks", taskId));
  }

  getTask(runId: string, taskId: string): Task {
    const task = this.findTask(runId, taskId);
    if (!task) throw new CosError(`unknown task "${taskId}" in run "${runId}"`);
    return task;
  }

  putTask(task: Task): void {
    task.updatedAt = new Date().toISOString();
    atomicWriteJson(this.file(task.runId, "tasks", task.id), task);
  }

  // dispatches
  listDispatches(runId: string): Dispatch[] {
    return this.listDir<Dispatch>(runId, "dispatches").sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
  }

  findDispatch(runId: string, id: string): Dispatch | undefined {
    return readJson<Dispatch>(this.file(runId, "dispatches", id));
  }

  getDispatch(runId: string, id: string): Dispatch {
    const d = this.findDispatch(runId, id);
    if (!d) throw new CosError(`unknown dispatch "${id}" in run "${runId}"`);
    return d;
  }

  putDispatch(d: Dispatch): void {
    atomicWriteJson(this.file(d.runId, "dispatches", d.id), d);
  }

  dispatchLogPath(runId: string, dispatchId: string): string {
    return path.join(this.runDir(runId), "logs", `${dispatchId}.log`);
  }

  dispatchBriefPath(runId: string, dispatchId: string): string {
    return path.join(this.runDir(runId), "dispatches", `${dispatchId}.brief.md`);
  }

  // messages
  listMessages(runId: string): Message[] {
    return this.listDir<Message>(runId, "messages").sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
  }

  findMessage(runId: string, id: string): Message | undefined {
    return readJson<Message>(this.file(runId, "messages", id));
  }

  getMessage(runId: string, id: string): Message {
    const m = this.findMessage(runId, id);
    if (!m) throw new CosError(`unknown message "${id}" in run "${runId}"`);
    return m;
  }

  putMessage(m: Message): void {
    atomicWriteJson(this.file(m.runId, "messages", m.id), m);
  }

  /** Allocates an id and persists the message. Must run inside `tx`. */
  addMessage(input: Omit<Message, "id" | "createdAt">): Message {
    const message: Message = {
      ...input,
      id: this.allocId(input.runId, "message", "m"),
      createdAt: new Date().toISOString(),
    };
    this.putMessage(message);
    return message;
  }

  // decisions
  listDecisions(runId: string): Decision[] {
    return this.listDir<Decision>(runId, "decisions").sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    );
  }

  findDecision(runId: string, id: string): Decision | undefined {
    return readJson<Decision>(this.file(runId, "decisions", id));
  }

  putDecision(d: Decision): void {
    atomicWriteJson(this.file(d.runId, "decisions", d.id), d);
  }
}
