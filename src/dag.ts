import { CosError } from "./errors.js";
import type { Task } from "./types.js";

export interface Node {
  id: string;
  after: string[];
}

/** Returns one dependency cycle as [a, b, ..., a], or undefined if the graph is acyclic. */
export function findCycle(nodes: readonly Node[]): string[] | undefined {
  const deps = new Map(nodes.map((n) => [n.id, n.after]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const s = state.get(id);
    if (s === "done") return undefined;
    if (s === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };

  for (const n of nodes) {
    const cycle = visit(n.id);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * Validates `incoming` against `existing` as a whole: duplicate ids, self dependencies,
 * unknown dependencies and cycles. Throws without side effects.
 */
export function validateGraph(existing: readonly Node[], incoming: readonly Node[]): void {
  const known = new Set(existing.map((n) => n.id));
  for (const n of incoming) {
    if (known.has(n.id)) throw new CosError(`task "${n.id}" already exists`);
    known.add(n.id);
  }
  for (const n of incoming) {
    const seen = new Set<string>();
    for (const dep of n.after) {
      if (dep === n.id) throw new CosError(`task "${n.id}" cannot depend on itself`);
      if (!known.has(dep)) throw new CosError(`task "${n.id}" depends on unknown task "${dep}"`);
      if (seen.has(dep)) throw new CosError(`task "${n.id}" lists dependency "${dep}" twice`);
      seen.add(dep);
    }
  }
  const cycle = findCycle([...existing, ...incoming]);
  if (cycle) throw new CosError(`dependency cycle: ${cycle.join(" -> ")}`);
}

/** Topological order (dependencies first); ties keep input order. Input must be acyclic. */
export function topoOrder<T extends Node>(nodes: readonly T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const out: T[] = [];
  const visit = (n: T): void => {
    if (done.has(n.id)) return;
    done.add(n.id);
    for (const dep of n.after) {
      const d = byId.get(dep);
      if (d) visit(d);
    }
    out.push(n);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** Longest dependency chain length below each node (roots are 0). */
export function depths(nodes: readonly Node[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    const value = node && node.after.length > 0 ? 1 + Math.max(...node.after.map(depth)) : 0;
    memo.set(id, value);
    return value;
  };
  for (const n of nodes) depth(n.id);
  return memo;
}

/**
 * Recomputes pending/ready from dependency state. Returns the tasks whose status changed.
 * Only `pending` and `ready` tasks are touched; every other status is owned by an explicit action.
 */
export function refreshReadiness(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const changed: Task[] = [];
  for (const t of tasks) {
    if (t.status !== "pending" && t.status !== "ready") continue;
    const satisfied = t.after.every((d) => byId.get(d)?.status === "completed");
    const next = satisfied ? "ready" : "pending";
    if (next !== t.status) {
      t.status = next;
      changed.push(t);
    }
  }
  return changed;
}
