import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import { pidAlive } from "../src/fsutil.js";
import {
  branchTip,
  fakeWorkerConfig,
  fileOnBranch,
  git,
  makeFixture,
  makeRepo,
  specLines,
  task,
  tempDir,
  waitFor,
  writeConfig,
} from "./helpers.js";

const worktreeOf = (repo: string, run: string, id: string) => path.join(repo, ".cos-worktrees", run, id);

describe("repository safety", () => {
  it("refuses to run outside a git repository", () => {
    expect(() => new Coordinator({ repo: tempDir() })).toThrow(/not inside a git working tree/);
  });

  it("refuses a repository without commits", () => {
    const dir = tempDir();
    git(dir, "init", "-q", "-b", "main");
    const cos = new Coordinator({ repo: dir });
    expect(() => cos.createRun({ objective: "x" })).toThrow(/no commits/);
  });

  it("creates a run without touching the user's branch or working tree", () => {
    const { repo, cos } = makeFixture();
    const headBefore = git(repo, "rev-parse", "HEAD");
    const run = cos.createRun({ objective: "build", id: "r1" });
    expect(run.integrationBranch).toBe("cos/r1/integration");
    expect(branchTip(repo, "cos/r1/integration")).toBe(headBefore);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(repo, "status", "--porcelain")).toBe("?? cos.config.json");
    expect(cos.stateDir).toBe(path.join(fs.realpathSync(repo), ".git", "cos"));
  });

  it("adds worktree and .cos patterns to .git/info/exclude once", () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "a", id: "r1" });
    cos.createRun({ objective: "b", id: "r2" });
    const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8").split("\n");
    expect(exclude.filter((l) => l === ".cos-worktrees/")).toHaveLength(1);
    expect(exclude).toContain(".cos/");
  });

  it("rejects duplicate and malformed run ids", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "a", id: "r1" });
    expect(() => cos.createRun({ objective: "a", id: "r1" })).toThrow(/already exists/);
    expect(() => cos.createRun({ objective: "a", id: "Bad Id" })).toThrow(/invalid run id/);
  });

  it("works from inside one of its own worktrees and finds the main repository", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "a", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: a.txt = 1"));
    await cos.dispatch("r1", "a");
    const inside = new Coordinator({ repo: worktreeOf(repo, "r1", "a") });
    expect(inside.repoRoot).toBe(fs.realpathSync(repo));
    expect(inside.listRuns().map((r) => r.id)).toEqual(["r1"]);
  });
});

describe("task graph", () => {
  it("marks tasks ready or pending from their dependencies", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    cos.addTask("r1", task("b", "x", { after: ["a"] }));
    expect(cos.listTasks("r1").map((t) => [t.id, t.status])).toEqual([["a", "ready"], ["b", "pending"]]);
  });

  it("generates sequential ids when none are given and rejects reserved ones", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    const a = cos.addTask("r1", { title: "A", spec: "x" });
    const b = cos.addTask("r1", { title: "B", spec: "x", after: [a.id] });
    expect([a.id, b.id]).toEqual(["t1", "t2"]);
    expect(() => cos.addTask("r1", task("integration", "x"))).toThrow(/reserved/);
  });

  it("rejects a cyclic plan atomically", () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    const file = path.join(repo, "plan.yaml");
    fs.writeFileSync(file, "tasks:\n  - {id: a, title: A, spec: x, after: [c]}\n  - {id: b, title: B, spec: x, after: [a]}\n  - {id: c, title: C, spec: x, after: [b]}\n");
    expect(() => cos.loadPlan(file, { runId: "r1" })).toThrow(/dependency cycle/);
    expect(cos.listTasks("r1")).toEqual([]);
  });

  it("does not leave a run behind when a plan with an objective is invalid", () => {
    const { repo, cos } = makeFixture();
    const file = path.join(repo, "plan.yaml");
    fs.writeFileSync(file, "objective: x\ntasks:\n  - {id: a, title: A, spec: x, after: [a]}\n");
    expect(() => cos.loadPlan(file, { newRunId: "p1" })).toThrow(/itself/);
    expect(cos.listRuns().map((r) => r.id)).not.toContain("p1");
  });

  it("creates a run from a plan objective and loads every task", () => {
    const { repo, cos } = makeFixture();
    const file = path.join(repo, "plan.json");
    fs.writeFileSync(file, JSON.stringify({ objective: "ship", tasks: [{ id: "a", title: "A", spec: "x" }, { id: "b", title: "B", spec: "y", after: ["a"] }] }));
    const res = cos.loadPlan(file, { newRunId: "p1" });
    expect(res.created).toBe(true);
    expect(res.tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("rejects dependencies on unknown tasks", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    expect(() => cos.addTask("r1", task("a", "x", { after: ["ghost"] }))).toThrow(/unknown task "ghost"/);
  });

  it("resolves task ids across runs and demands --run when ambiguous", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.createRun({ objective: "o", id: "r2" });
    cos.addTask("r1", task("a", "x"));
    cos.addTask("r2", task("a", "x"));
    cos.addTask("r2", task("only-r2", "x"));
    expect(cos.resolveTask("only-r2").runId).toBe("r2");
    expect(() => cos.resolveTask("a")).toThrow(/pass --run/);
    expect(() => cos.resolveRun()).toThrow(/several runs/);
  });
});

describe("dispatch", () => {
  it("runs a task in its own worktree on its own branch and completes it", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "Build the thing", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: src/a.txt = hello"));
    const d = await cos.dispatch("r1", "a");

    expect(d.status).toBe("passed");
    expect(d.branch).toBe("cos/r1/a");
    expect(d.worktree).toBe(worktreeOf(fs.realpathSync(repo), "r1", "a"));
    expect(fileOnBranch(repo, "cos/r1/a", "src/a.txt")).toBe("hello\n");
    expect(d.result).toMatchObject({ outcome: "success", filesModified: expect.arrayContaining(["src/a.txt"]) });
    const t = cos.listTasks("r1")[0];
    expect(t).toMatchObject({ status: "completed", attempts: 1, lastDispatchId: d.id });
    const brief = fs.readFileSync(path.join(d.worktree ?? "", ".cos", "brief.md"), "utf8");
    expect(brief).toContain("Build the thing");
    expect(brief).toContain("fake.write: src/a.txt = hello");
    expect(brief).toContain("## Worker contract");
    expect(fs.existsSync(path.join(d.worktree ?? "", ".cos", "task.json"))).toBe(true);
  });

  it("leaves the user's checkout alone", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: src/a.txt = hello"));
    const head = git(repo, "rev-parse", "HEAD");
    await cos.dispatch("r1", "a");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(repo, "status", "--porcelain")).toBe("?? cos.config.json");
    expect(fs.existsSync(path.join(repo, "src", "a.txt"))).toBe(false);
  });

  it("isolates concurrent tasks that edit the same file", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", specLines("fake.write: shared.txt = from-a", "fake.sleep: 0.3")));
    cos.addTask("r1", task("b", specLines("fake.write: shared.txt = from-b", "fake.sleep: 0.3")));
    await Promise.all([cos.dispatch("r1", "a"), cos.dispatch("r1", "b")]);
    expect(fs.readFileSync(path.join(worktreeOf(repo, "r1", "a"), "shared.txt"), "utf8")).toBe("from-a\n");
    expect(fs.readFileSync(path.join(worktreeOf(repo, "r1", "b"), "shared.txt"), "utf8")).toBe("from-b\n");
    expect(fs.existsSync(path.join(repo, "shared.txt"))).toBe(false);
    expect(fileOnBranch(repo, "cos/r1/integration", "shared.txt")).toBeUndefined();
  });

  it("commits changes the worker left uncommitted", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", specLines("fake.write: left.txt = dirty", "fake.no-commit")));
    const d = await cos.dispatch("r1", "a");
    expect(d.status).toBe("passed");
    expect(fileOnBranch(repo, "cos/r1/a", "left.txt")).toBe("dirty\n");
    expect(git(repo, "log", "-1", "--format=%s", "cos/r1/a")).toMatch(/^cos: uncommitted changes from task a/);
    expect(git(worktreeOf(repo, "r1", "a"), "status", "--porcelain")).toBe("");
  });

  it("passes only an allowlisted environment to the worker", async () => {
    const key = ["COS", "TEST", "SECRET"].join("_");
    process.env[key] = "should-not-leak";
    try {
      const { repo, cos } = makeFixture({}, { env: { CONFIG_VAR: "{taskId}-cfg" } });
      cos.createRun({ objective: "o", id: "r1" });
      cos.addTask("r1", task("a", "fake.dump-env: env.txt"));
      await cos.dispatch("r1", "a");
      const names = (fileOnBranch(repo, "cos/r1/a", "env.txt") ?? "").split("\n");
      expect(names).not.toContain(key);
      expect(names).toEqual(expect.arrayContaining(["PATH", "COS_RUN", "COS_TASK", "COS_DISPATCH", "COS_BRIEF", "COS_WORKTREE", "CONFIG_VAR"]));
    } finally {
      delete process.env[key];
    }
  });

  it("records a failing worker as failed and escalates", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.fail: kaboom"));
    const d = await cos.dispatch("r1", "a");
    expect(d).toMatchObject({ status: "failed", failureKind: "worker", exitCode: 1 });
    expect(cos.listTasks("r1")[0]?.status).toBe("failed");
    const types = cos.inbox({ runId: "r1" }).map((m) => m.type);
    expect(types).toEqual(expect.arrayContaining(["worker_done", "escalation", "status"]));
    expect(fs.readFileSync(d.logPath ?? "", "utf8")).toContain("kaboom");
  });

  it("treats outcome=failure in result.json as failure even with exit code 0", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.result-failure: could not do it"));
    const d = await cos.dispatch("r1", "a");
    expect(d.status).toBe("failed");
    expect(d.failure).toContain("could not do it");
  });

  it("accepts exit code 0 without result.json", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.no-result"));
    expect((await cos.dispatch("r1", "a")).status).toBe("passed");
  });

  it("fails cleanly when the worker command does not exist", async () => {
    const { cos } = makeFixture({ workers: { default: { command: "/definitely/not/a/binary" } } });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    const d = await cos.dispatch("r1", "a");
    // macOS reports a missing binary as exit 127 from the forked child; Linux reports ENOENT at spawn
    expect(d.status).toBe("failed");
    expect(d.failure).toMatch(/could not start worker|exited with code 127 \(command not found/);
  });

  it("rejects unknown workers and tasks that are not ready", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    cos.addTask("r1", task("b", "x", { after: ["a"] }));
    await expect(cos.dispatch("r1", "a", { worker: "nope" })).rejects.toThrow(/no worker "nope"/);
    await expect(cos.dispatch("r1", "b")).rejects.toThrow(/pending.*only ready tasks/);
    expect(cos.listTasks("r1")[0]?.status).toBe("ready");
  });

  it("starts dependents from the integration branch with their dependencies merged", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: base.txt = from-a"));
    cos.addTask("r1", task("b", "fake.write: next.txt = from-b", { after: ["a"] }));
    await cos.dispatch("r1", "a");
    const d = await cos.dispatch("r1", "b");
    expect(d.status).toBe("passed");
    expect(fs.readFileSync(path.join(worktreeOf(repo, "r1", "b"), "base.txt"), "utf8")).toBe("from-a\n");
    expect(cos.listTasks("r1")[0]?.merged).toBeDefined();
    const brief = fs.readFileSync(path.join(worktreeOf(repo, "r1", "b"), ".cos", "brief.md"), "utf8");
    expect(brief).toContain("## Completed dependencies");
  });
});

describe("scheduling", () => {
  it("never runs more workers at once than the concurrency limit", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    for (const id of ["a", "b", "c", "d"]) cos.addTask("r1", task(id, specLines(`fake.write: ${id}.txt = ${id}`, "fake.sleep: 0.8")));
    const summary = await cos.start("r1", { concurrency: 2 });
    expect(summary.complete).toBe(true);
    const spans = cos
      .dispatches("r1")
      .map((d) => [Date.parse(d.processStartedAt ?? ""), Date.parse(d.processEndedAt ?? "")] as const);
    expect(spans).toHaveLength(4);
    const overlapAt = (t: number) => spans.filter(([s, e]) => s <= t && t < e).length;
    const points = spans.flatMap(([s, e]) => [s, e - 1]);
    const max = Math.max(...points.map(overlapAt));
    expect(max).toBe(2);
  });

  it("runs a chain in dependency order and merges everything", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: a.txt = a"));
    cos.addTask("r1", task("b", "fake.write: b.txt = b", { after: ["a"] }));
    cos.addTask("r1", task("c", "fake.write: c.txt = c", { after: ["b"] }));
    const summary = await cos.start("r1");
    expect(summary).toMatchObject({ complete: true, dispatches: 3 });
    expect(cos.dispatches("r1").map((d) => d.taskId)).toEqual(["a", "b", "c"]);
    for (const f of ["a.txt", "b.txt", "c.txt"]) expect(fileOnBranch(repo, "cos/r1/integration", f)).toBeDefined();
    expect(fileOnBranch(repo, "main", "a.txt")).toBeUndefined();
  });

  it("does not dispatch dependents of a failed task and reports why", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.fail"));
    cos.addTask("r1", task("b", "x", { after: ["a"] }));
    const summary = await cos.start("r1");
    expect(summary.complete).toBe(false);
    expect(summary.counts).toMatchObject({ failed: 1, pending: 1 });
    expect(summary.attention.map((a) => a.taskId)).toEqual(["a", "b"]);
    expect(summary.attention[1]?.reason).toBe("waiting for a");
  });

  it("retries failed tasks automatically up to --retries", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.fail-until-attempt: 3"));
    const summary = await cos.start("r1", { retries: 2 });
    expect(summary.complete).toBe(true);
    expect(cos.listTasks("r1")[0]?.attempts).toBe(3);
    const budget = makeFixture();
    budget.cos.createRun({ objective: "o", id: "r1" });
    budget.cos.addTask("r1", task("a", "fake.fail-until-attempt: 4"));
    const short = await budget.cos.start("r1", { retries: 1 });
    expect(short.complete).toBe(false);
    expect(budget.cos.listTasks("r1")[0]).toMatchObject({ status: "failed", attempts: 2 });
  });
});

describe("quality gate", () => {
  const okGate = { name: "has-ok", command: "echo missing-ok-marker; test -f ok.txt" };

  it("completes a task only when every gate passes", async () => {
    const { cos } = makeFixture({ gates: [okGate, { name: "always", command: "true" }] });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: ok.txt = yes"));
    const d = await cos.dispatch("r1", "a");
    expect(d.status).toBe("passed");
    expect(d.gates?.map((g) => [g.name, g.passed])).toEqual([["has-ok", true], ["always", true]]);
  });

  it("fails the task with the gate output attached when a gate fails", async () => {
    const { cos } = makeFixture({ gates: [okGate] });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: other.txt = x"));
    cos.addTask("r1", task("b", "x", { after: ["a"] }));
    const d = await cos.dispatch("r1", "a");
    expect(d).toMatchObject({ status: "failed", failureKind: "gate" });
    expect(d.gates?.[0]).toMatchObject({ name: "has-ok", passed: false, exitCode: 1 });
    expect(d.gates?.[0]?.output).toContain("missing-ok-marker");
    const tasks = cos.listTasks("r1");
    expect(tasks.map((t) => t.status)).toEqual(["failed", "pending"]);
    expect(tasks[0]?.failure).toContain("has-ok");
  });

  it("moves the task through review while gates run", async () => {
    const { cos } = makeFixture({ gates: [{ name: "slow", command: "sleep 0.6" }] });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: a.txt = a"));
    const running = cos.dispatch("r1", "a");
    await waitFor(() => cos.listTasks("r1")[0]?.status === "review");
    expect(cos.dispatches("r1")[0]?.status).toBe("gating");
    await running;
    expect(cos.listTasks("r1")[0]?.status).toBe("completed");
  });

  it("retries with the failure appended to the brief and reuses the worktree", async () => {
    const { repo, cos } = makeFixture({ gates: [okGate] });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", specLines("fake.write: a.txt = a", "fake.fix-on-retry: ok.txt = fixed")));
    const first = await cos.dispatch("r1", "a");
    expect(first.status).toBe("failed");

    const second = await cos.retry("r1", "a");
    expect(second).toMatchObject({ status: "passed", attempt: 2, worktree: first.worktree });
    const brief = fs.readFileSync(path.join(second.worktree ?? "", ".cos", "brief.md"), "utf8");
    expect(brief).toContain("## Previous attempt failed");
    expect(brief).toContain("Gate `has-ok` failed");
    expect(brief).toContain("missing-ok-marker");
    expect(fs.readFileSync(cos.ctx.store.dispatchBriefPath("r1", first.id), "utf8")).not.toContain("Previous attempt failed");
    expect(fileOnBranch(repo, "cos/r1/a", "ok.txt")).toBe("fixed\n");
    expect(cos.listTasks("r1")[0]?.status).toBe("completed");
  });

  it("only retries failed tasks", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    await expect(cos.retry("r1", "a")).rejects.toThrow(/only failed tasks/);
  });

  const refcheckGate = (payload: object, code: number) => ({
    name: "refs",
    format: "refcheck-json",
    command: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(JSON.stringify(payload))});process.exit(${code})`],
  });

  it("fails a refcheck-json gate on summary.errors > 0 and shows the findings", async () => {
    const payload = {
      version: 1,
      root: "/r",
      filesChecked: 1,
      findings: [{ rule: "unknown-import", severity: "error", file: "a.ts", line: 1, column: 1, message: "cannot resolve 'ghost'" }],
      summary: { errors: 1, warnings: 0 },
    };
    const { cos } = makeFixture({ gates: [refcheckGate(payload, 1)] });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    const d = await cos.dispatch("r1", "a");
    expect(d.status).toBe("failed");
    expect(d.gates?.[0]).toMatchObject({ passed: false, summary: "1 error(s), 0 warning(s)" });
    expect(d.gates?.[0]?.output).toContain("a.ts:1:1 error unknown-import: cannot resolve 'ghost'");
  });

  it("passes a refcheck-json gate that only has warnings", async () => {
    const payload = { version: 1, root: "/r", filesChecked: 1, findings: [], summary: { errors: 0, warnings: 4 } };
    const { cos } = makeFixture({ gates: [refcheckGate(payload, 0)] });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    expect((await cos.dispatch("r1", "a")).status).toBe("passed");
  });

  it("fails a refcheck-json gate whose output is not JSON", async () => {
    const { cos } = makeFixture({ gates: [{ name: "refs", format: "refcheck-json", command: "echo not-json" }] });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    const d = await cos.dispatch("r1", "a");
    expect(d.gates?.[0]).toMatchObject({ passed: false, summary: "output is not valid JSON" });
  });

  it("fails a gate that times out", async () => {
    const { cos } = makeFixture({ gates: [{ name: "hang", command: "sleep 30", timeoutSec: 0.5 }] });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    const d = await cos.dispatch("r1", "a");
    expect(d.gates?.[0]).toMatchObject({ passed: false, timedOut: true });
  });
});

describe("worker questions", () => {
  it("blocks the task on a question and resumes it with the answer in the brief", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.ask: Which database?"));
    cos.addTask("r1", task("b", "x", { after: ["a"] }));

    const first = await cos.dispatch("r1", "a");
    expect(first.status).toBe("asked");
    expect(cos.listTasks("r1")[0]).toMatchObject({ status: "blocked", blocked: { kind: "question" } });
    const [q] = cos.inbox({ runId: "r1", type: "question" });
    expect(q).toMatchObject({ body: "Which database?", taskId: "a", dispatchId: first.id });

    // not schedulable until answered
    expect((await cos.start("r1")).dispatches).toBe(0);

    cos.answer("r1", q?.id ?? "", "postgres");
    expect(cos.listTasks("r1").map((t) => t.status)).toEqual(["ready", "pending"]);
    expect(cos.inbox({ runId: "r1", type: "question" })).toEqual([]);

    const summary = await cos.start("r1");
    expect(summary.complete).toBe(true);
    expect(fileOnBranch(repo, "cos/r1/a", "fake-output/a.txt")).toContain("answer: Which database? -> postgres");
    const brief = fs.readFileSync(cos.ctx.store.dispatchBriefPath("r1", "d2"), "utf8");
    expect(brief).toContain("## Answers to your earlier questions");
  });

  it("delivers the answer to a worker that keeps running and waits", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.ask-wait: Tabs or spaces?"));
    const running = cos.dispatch("r1", "a");
    await waitFor(() => cos.inbox({ runId: "r1", type: "question" }).length === 1);
    expect(cos.listTasks("r1")[0]?.status).toBe("dispatched");
    const [q] = cos.inbox({ runId: "r1", type: "question" });
    cos.answer("r1", q?.id ?? "", "spaces");
    const d = await running;
    expect(d).toMatchObject({ status: "passed", attempt: 1 });
    expect(fileOnBranch(repo, "cos/r1/a", "fake-output/a.txt")).toContain("answer: Tabs or spaces? -> spaces");
  });

  it("refuses to answer twice or to answer something that is not a question", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.ask: Q?"));
    await cos.dispatch("r1", "a");
    const [q] = cos.inbox({ runId: "r1", type: "question" });
    const status = cos.inbox({ runId: "r1", type: "status" })[0];
    cos.answer("r1", q?.id ?? "", "yes");
    expect(() => cos.answer("r1", q?.id ?? "", "again")).toThrow(/already answered/);
    expect(() => cos.answer("r1", status?.id ?? "", "x")).toThrow(/not a question/);
    expect(() => cos.answer("r1", "m999", "x")).toThrow(/unknown message/);
  });
});

describe("decision gates", () => {
  it("blocks a task until the gate is resolved and passes the decision to the worker", async () => {
    const { repo, cos } = makeFixture();
    const file = path.join(repo, "plan.yaml");
    fs.writeFileSync(file, "objective: o\ntasks:\n  - {id: a, title: A, spec: x, gate: 'Publish under /docs or /wiki?'}\n  - {id: b, title: B, spec: y, after: [a]}\n");
    cos.loadPlan(file, { newRunId: "r1" });
    expect(cos.listTasks("r1").map((t) => t.status)).toEqual(["blocked", "pending"]);

    const idle = await cos.start("r1");
    expect(idle.dispatches).toBe(0);
    await expect(cos.dispatch("r1", "a")).rejects.toThrow(/blocked \(decision\)/);

    const [gate] = cos.gates("r1");
    expect(gate).toMatchObject({ taskId: "a", status: "open", question: "Publish under /docs or /wiki?" });
    cos.resolveGate("r1", gate?.id ?? "", "/docs");
    expect(cos.listTasks("r1").map((t) => t.status)).toEqual(["ready", "pending"]);
    expect(cos.gates("r1")).toEqual([]);

    expect((await cos.start("r1")).complete).toBe(true);
    expect(fileOnBranch(repo, "cos/r1/a", "fake-output/a.txt")).toContain("decision: Publish under /docs or /wiki? -> /docs");
  });

  it("keeps a task blocked until all of its gates are resolved", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    const g1 = cos.openGate("r1", "a", "first?");
    const g2 = cos.openGate("r1", "a", "second?");
    cos.resolveGate("r1", g1.id, "yes");
    expect(cos.listTasks("r1")[0]).toMatchObject({ status: "blocked", blocked: { ref: g2.id } });
    cos.resolveGate("r1", g2.id, "yes");
    expect(cos.listTasks("r1")[0]?.status).toBe("ready");
  });

  it("validates options, double resolution and running tasks", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", specLines("fake.sleep: 0.5")));
    const g = cos.openGate("r1", "a", "pick", ["x", "y"]);
    expect(() => cos.resolveGate("r1", g.id, "z")).toThrow(/must be one of: x, y/);
    cos.resolveGate("r1", g.id, "x");
    expect(() => cos.resolveGate("r1", g.id, "x")).toThrow(/already resolved/);
    const running = cos.dispatch("r1", "a");
    await waitFor(() => cos.listTasks("r1")[0]?.status === "dispatched");
    expect(() => cos.openGate("r1", "a", "too late?")).toThrow(/can only be opened on/);
    await running;
  });
});

describe("messages", () => {
  it("sends, lists, filters and acknowledges inbox messages", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    const s = cos.send({ runId: "r1", type: "status", body: "halfway", from: "worker:x" });
    const e = cos.send({ runId: "r1", type: "escalation", body: "help" });
    expect(cos.inbox({ runId: "r1" }).map((m) => m.id)).toEqual([s.id, e.id]);
    expect(cos.inbox({ runId: "r1", type: "escalation" }).map((m) => m.id)).toEqual([e.id]);
    expect(cos.ack("r1", [s.id])).toEqual([s.id]);
    expect(cos.inbox({ runId: "r1" }).map((m) => m.id)).toEqual([e.id]);
    expect(cos.inbox({ runId: "r1", all: true })).toHaveLength(2);
    expect(cos.ack("r1", "all")).toEqual([e.id]);
    expect(cos.ack("r1", [s.id])).toEqual([]);
  });

  it("rejects invalid types and empty bodies", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    expect(() => cos.send({ runId: "r1", type: "gossip" as never, body: "x" })).toThrow(/type must be one of/);
    expect(() => cos.send({ runId: "r1", type: "status", body: " " })).toThrow(/must not be empty/);
    expect(() => cos.send({ runId: "r1", type: "status", body: "x", to: "ghost" })).toThrow(/unknown task/);
  });

  it("delivers a message addressed to a task into its worktree inbox", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    const d = await cos.dispatch("r1", "a");
    const m = cos.send({ runId: "r1", type: "status", body: "priority changed", to: "a" });
    const delivered = path.join(d.worktree ?? "", ".cos", "inbox", `${m.id}.json`);
    expect(JSON.parse(fs.readFileSync(delivered, "utf8"))).toMatchObject({ body: "priority changed", to: "a" });
    expect(cos.inbox({ runId: "r1" }).map((x) => x.id)).not.toContain(m.id);
  });
});

describe("merge", () => {
  it("merges a completed task into the integration branch only", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: a.txt = a"));
    await cos.dispatch("r1", "a");
    expect(fileOnBranch(repo, "cos/r1/integration", "a.txt")).toBeUndefined();
    const res = await cos.merge("r1", "a");
    expect(res).toMatchObject({ merged: true });
    expect(fileOnBranch(repo, "cos/r1/integration", "a.txt")).toBe("a\n");
    expect(fileOnBranch(repo, "main", "a.txt")).toBeUndefined();
    expect(git(repo, "log", "-1", "--format=%s", "cos/r1/integration")).toBe("Merge task a: Task a");
    expect(cos.listTasks("r1")[0]?.merged?.commit).toBe(res.commit);
    expect(await cos.merge("r1", "a")).toMatchObject({ merged: true, already: true });
  });

  it("refuses to merge tasks that are not completed", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    await expect(cos.merge("r1", "a")).rejects.toThrow(/is ready; only completed tasks/);
  });

  async function conflictFixture() {
    const fx = makeFixture();
    fx.cos.createRun({ objective: "o", id: "r1" });
    fx.cos.addTask("r1", task("a", "fake.write: shared.txt = from-a"));
    fx.cos.addTask("r1", task("b", specLines("fake.write: shared.txt = from-b", "fake.resolve-conflicts: ours")));
    await Promise.all([fx.cos.dispatch("r1", "a"), fx.cos.dispatch("r1", "b")]);
    await fx.cos.merge("r1", "a");
    return fx;
  }

  it("aborts a conflicting merge cleanly and blocks the task", async () => {
    const { repo, cos } = await conflictFixture();
    const tipBefore = branchTip(repo, "cos/r1/integration");
    const res = await cos.merge("r1", "b");
    expect(res).toMatchObject({ merged: false, conflicts: ["shared.txt"] });

    expect(branchTip(repo, "cos/r1/integration")).toBe(tipBefore);
    const integration = worktreeOf(repo, "r1", "_integration");
    expect(git(integration, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(repo, ".git", "worktrees", "_integration", "MERGE_HEAD"))).toBe(false);
    expect(fs.readFileSync(path.join(integration, "shared.txt"), "utf8")).toBe("from-a\n");
    expect(cos.listTasks("r1").find((t) => t.id === "b")).toMatchObject({ status: "blocked", blocked: { kind: "merge-conflict", files: ["shared.txt"] } });
    expect(cos.inbox({ runId: "r1", type: "escalation" })[0]?.body).toContain("conflicts in: shared.txt");
  });

  it("re-dispatches a conflicted task with the conflict in the brief, then merges it", async () => {
    const { repo, cos } = await conflictFixture();
    await cos.merge("r1", "b");
    const d = await cos.retry("r1", "b");
    expect(d.status).toBe("passed");
    const brief = fs.readFileSync(path.join(d.worktree ?? "", ".cos", "brief.md"), "utf8");
    expect(brief).toContain("## Merge conflict");
    expect(brief).toContain("`shared.txt`");
    expect(brief).toContain("git merge cos/r1/integration");
    expect(await cos.merge("r1", "b")).toMatchObject({ merged: true });
    expect(fileOnBranch(repo, "cos/r1/integration", "shared.txt")).toBe("from-b\n");
    expect(cos.listTasks("r1").find((t) => t.id === "b")).toMatchObject({ status: "completed" });
  });

  it("run start merges what it can and reports a conflict as needing attention", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: shared.txt = from-a"));
    cos.addTask("r1", task("b", "fake.write: shared.txt = from-b"));
    const summary = await cos.start("r1", { concurrency: 1 });
    expect(summary.complete).toBe(false);
    expect(summary.merges.map((m) => [m.taskId, m.merged])).toEqual([["a", true], ["b", false]]);
    expect(summary.attention).toEqual([expect.objectContaining({ taskId: "b", status: "blocked" })]);
  });
});

describe("cleanup", () => {
  async function twoTasks() {
    const fx = makeFixture();
    fx.cos.createRun({ objective: "o", id: "r1" });
    fx.cos.addTask("r1", task("a", "fake.write: a.txt = a"));
    fx.cos.addTask("r1", task("b", "fake.write: b.txt = b"));
    await fx.cos.start("r1", { concurrency: 1 });
    return fx;
  }

  it("removes clean worktrees but keeps every branch, including the integration branch", async () => {
    const { repo, cos } = await twoTasks();
    const entries = cos.cleanup({ runId: "r1" });
    expect(entries.filter((e) => e.action === "removed").map((e) => e.name).sort()).toEqual(["a", "b", "integration"]);
    expect(fs.existsSync(worktreeOf(repo, "r1", "a"))).toBe(false);
    expect(fs.existsSync(path.join(repo, ".cos-worktrees", "r1"))).toBe(false);
    const branches = git(repo, "branch", "--format=%(refname:short)").split("\n");
    expect(branches).toEqual(expect.arrayContaining(["cos/r1/a", "cos/r1/b", "cos/r1/integration", "main"]));
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(".cos-worktrees");
  });

  it("never deletes a worktree with uncommitted changes without --force", async () => {
    const { repo, cos } = await twoTasks();
    const wtA = worktreeOf(repo, "r1", "a");
    fs.writeFileSync(path.join(wtA, "precious.txt"), "unsaved work");
    fs.appendFileSync(path.join(wtA, "a.txt"), "edited\n");
    const entries = cos.cleanup({ runId: "r1" });
    expect(entries.find((e) => e.name === "a")).toMatchObject({ action: "skipped", reason: expect.stringContaining("uncommitted changes") });
    expect(fs.readFileSync(path.join(wtA, "precious.txt"), "utf8")).toBe("unsaved work");
    expect(fs.existsSync(worktreeOf(repo, "r1", "b"))).toBe(false);

    const forced = cos.cleanup({ runId: "r1", force: true });
    expect(forced.find((e) => e.name === "a")?.action).toBe("removed");
    expect(fs.existsSync(wtA)).toBe(false);
  });

  it("skips a worktree whose worker is still running, even with --force", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.sleep: 1.5"));
    const running = cos.dispatch("r1", "a");
    await waitFor(() => cos.dispatches("r1")[0]?.pid !== undefined);
    const entries = cos.cleanup({ runId: "r1", force: true });
    expect(entries.find((e) => e.name === "a")).toMatchObject({ action: "skipped", reason: expect.stringContaining("worker is running") });
    expect((await running).status).toBe("passed");
  });

  it("deletes only merged task branches with --branches", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: a.txt = a"));
    cos.addTask("r1", task("b", "fake.write: b.txt = b"));
    await cos.dispatch("r1", "a");
    await cos.dispatch("r1", "b");
    await cos.merge("r1", "a");
    const entries = cos.cleanup({ runId: "r1", branches: true });
    expect(entries.find((e) => e.name === "a")?.branch).toBe("deleted");
    expect(entries.find((e) => e.name === "b")?.branch).toBe("kept");
    const branches = git(repo, "branch", "--format=%(refname:short)").split("\n");
    expect(branches).not.toContain("cos/r1/a");
    expect(branches).toEqual(expect.arrayContaining(["cos/r1/b", "cos/r1/integration"]));
  });

  it("recreates a removed worktree from its branch on retry", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.fail-until-attempt: 2"));
    await cos.dispatch("r1", "a");
    cos.cleanup({ runId: "r1", taskId: "a" });
    expect(fs.existsSync(worktreeOf(repo, "r1", "a"))).toBe(false);
    expect((await cos.retry("r1", "a")).status).toBe("passed");
  });

  it("reports an unknown task and a missing worktree", () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "x"));
    expect(() => cos.cleanup({ runId: "r1", taskId: "zzz" })).toThrow(/unknown task/);
    expect(cos.cleanup({ runId: "r1", taskId: "a" })).toEqual([expect.objectContaining({ action: "skipped", reason: "no worktree on disk" })]);
  });
});

describe("timeouts", () => {
  it("kills the worker's whole process group when it exceeds timeoutSec", async () => {
    const { repo, cos } = makeFixture({}, { timeoutSec: 1 });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", specLines("fake.spawn-child", "fake.hang")));
    const d = await cos.dispatch("r1", "a");
    expect(d).toMatchObject({ status: "timed_out", failureKind: "timeout" });
    expect(d.failure).toContain("timed out after 1s");
    const childPid = Number(fs.readFileSync(path.join(worktreeOf(repo, "r1", "a"), ".cos", "child.pid"), "utf8"));
    await waitFor(() => !pidAlive(childPid), 5000);
    expect(d.pid !== undefined && pidAlive(d.pid)).toBe(false);
    expect(cos.listTasks("r1")[0]?.status).toBe("failed");
  });

  it("kills a worker that stops touching its heartbeat file", async () => {
    const { cos } = makeFixture({}, { heartbeatTimeoutSec: 0.6, timeoutSec: 30 });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", specLines("fake.heartbeat", "fake.hang")));
    const d = await cos.dispatch("r1", "a");
    expect(d).toMatchObject({ status: "stalled", failureKind: "stalled" });
  });

  it("does not enforce a heartbeat the worker never started", async () => {
    const { cos } = makeFixture({}, { heartbeatTimeoutSec: 0.3 });
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.sleep: 1"));
    expect((await cos.dispatch("r1", "a")).status).toBe("passed");
  });
});

describe("crash recovery", () => {
  it("marks dispatches of a dead supervisor as orphaned after a restart and allows a retry", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.write: a.txt = a"));
    cos.addTask("r1", task("b", "x", { after: ["a"] }));

    // Simulate a supervisor that died mid-run: the state files say "dispatched" but nobody owns it.
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => dead.on("exit", r));
    cos.ctx.store.tx("r1", (s) => {
      const id = s.allocId("r1", "dispatch", "d");
      s.putDispatch({ id, runId: "r1", taskId: "a", attempt: 1, status: "running", worker: "default", supervisorPid: dead.pid ?? 1, startedAt: new Date().toISOString() });
      const t = s.getTask("r1", "a");
      Object.assign(t, { status: "dispatched", attempts: 1, lastDispatchId: id });
      s.putTask(t);
    });

    const restarted = new Coordinator({ repo, pollMs: 50 });
    expect(restarted.listTasks("r1").map((t) => t.status)).toEqual(["dispatched", "pending"]);
    const recovered = restarted.recover();
    expect(recovered.map((d) => [d.id, d.status])).toEqual([["d1", "orphaned"]]);
    expect(restarted.listTasks("r1").map((t) => t.status)).toEqual(["failed", "pending"]);
    expect(restarted.listTasks("r1")[0]?.failure).toContain("supervisor process");
    expect(restarted.inbox({ runId: "r1", type: "escalation" })[0]?.body).toContain('cos retry --task a');
    expect(restarted.recover()).toEqual([]);

    expect((await restarted.retry("r1", "a")).status).toBe("passed");
    expect(restarted.listTasks("r1").map((t) => t.status)).toEqual(["completed", "ready"]);
  });

  it("leaves dispatches of a live supervisor alone", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.sleep: 0.8"));
    const running = cos.dispatch("r1", "a");
    await waitFor(() => cos.dispatches("r1")[0]?.pid !== undefined);
    expect(cos.recover()).toEqual([]);
    expect((await running).status).toBe("passed");
  });
});

describe("run start --wait", () => {
  it("keeps polling while a task waits for an answer and finishes once it is answered elsewhere", async () => {
    const { repo, cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.ask: Which port?"));
    cos.addTask("r1", task("b", "fake.write: b.txt = b", { after: ["a"] }));
    const running = cos.start("r1", { wait: true });
    await waitFor(() => cos.inbox({ runId: "r1", type: "question" }).length === 1);
    // another process (a second Coordinator instance) answers
    const other = new Coordinator({ repo, pollMs: 50 });
    const [q] = other.inbox({ runId: "r1", type: "question" });
    other.answer("r1", q?.id ?? "", "8080");
    const summary = await running;
    expect(summary.complete).toBe(true);
    expect(cos.dispatches("r1").map((d) => [d.taskId, d.status])).toEqual([["a", "asked"], ["a", "passed"], ["b", "passed"]]);
  });

  it("returns immediately without --wait when only a question is outstanding", async () => {
    const { cos } = makeFixture();
    cos.createRun({ objective: "o", id: "r1" });
    cos.addTask("r1", task("a", "fake.ask: Which port?"));
    const summary = await cos.start("r1");
    expect(summary.complete).toBe(false);
    expect(summary.attention[0]).toMatchObject({ taskId: "a", status: "blocked" });
  });
});
