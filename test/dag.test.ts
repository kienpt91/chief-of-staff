import { describe, expect, it } from "vitest";
import { depths, findCycle, refreshReadiness, topoOrder, validateGraph } from "../src/dag.js";
import type { Task } from "../src/types.js";

const n = (id: string, ...after: string[]) => ({ id, after });

function t(id: string, status: Task["status"], ...after: string[]): Task {
  return {
    id,
    runId: "r",
    title: id,
    spec: id,
    acceptance: [],
    after,
    status,
    attempts: 0,
    order: 0,
    createdAt: "",
    updatedAt: "",
  };
}

describe("dag", () => {
  it("finds no cycle in a diamond", () => {
    expect(findCycle([n("a"), n("b", "a"), n("c", "a"), n("d", "b", "c")])).toBeUndefined();
  });

  it("reports a cycle path", () => {
    const cycle = findCycle([n("a", "c"), n("b", "a"), n("c", "b")]);
    expect(cycle).toBeDefined();
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  it("rejects self dependency, unknown dependency and duplicates", () => {
    expect(() => validateGraph([], [n("a", "a")])).toThrow(/itself/);
    expect(() => validateGraph([], [n("a", "ghost")])).toThrow(/unknown task "ghost"/);
    expect(() => validateGraph([n("a")], [n("a")])).toThrow(/already exists/);
    expect(() => validateGraph([], [n("a"), n("a")])).toThrow(/already exists/);
    expect(() => validateGraph([n("a")], [n("b", "a", "a")])).toThrow(/twice/);
  });

  it("rejects a cycle inside an incoming batch", () => {
    expect(() => validateGraph([], [n("a", "b"), n("b", "a")])).toThrow(/dependency cycle: (a -> b -> a|b -> a -> b)/);
  });

  it("accepts a batch that depends on existing tasks", () => {
    expect(() => validateGraph([n("a")], [n("b", "a"), n("c", "b")])).not.toThrow();
  });

  it("orders dependencies first and keeps input order for ties", () => {
    const order = topoOrder([n("d", "b", "c"), n("b", "a"), n("a"), n("c", "a")]).map((x) => x.id);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("computes depth as the longest chain", () => {
    const d = depths([n("a"), n("b", "a"), n("c", "a", "b")]);
    expect([d.get("a"), d.get("b"), d.get("c")]).toEqual([0, 1, 2]);
  });

  it("refreshReadiness promotes and demotes only pending/ready tasks", () => {
    const tasks = [t("a", "completed"), t("b", "pending", "a"), t("c", "ready", "b"), t("d", "failed", "a"), t("e", "blocked")];
    const changed = refreshReadiness(tasks).map((x) => x.id);
    expect(changed.sort()).toEqual(["b", "c"]);
    expect(tasks.map((x) => x.status)).toEqual(["completed", "ready", "pending", "failed", "blocked"]);
  });
});
