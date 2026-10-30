import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import { pidAlive } from "../src/fsutil.js";
import { runCli } from "../src/commands.js";
import { PROJECT_ROOT, makeFixture, tempDir, waitFor } from "./helpers.js";

interface Out {
  code: number;
  out: string;
  err: string;
}

async function cos(cwd: string, ...argv: string[]): Promise<Out> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, { cwd, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const PLAN = `objective: Tiny service
tasks:
  - id: schema
    title: Create schema
    spec: |
      Create the schema.
      fake.write: db/schema.sql = CREATE TABLE users(id integer);
  - id: api
    title: Add API
    after: schema
    spec: |
      fake.ask: Which auth scheme?
  - id: docs
    title: Write docs
    after: [api]
    gate: Publish under /docs or /wiki?
    spec: Write the docs.
`;

describe("cli (in process)", () => {
  it("prints help and the version, and rejects unknown commands and flags", async () => {
    const { repo } = makeFixture();
    expect((await cos(repo, "--help")).out).toContain("Usage: cos <command>");
    expect((await cos(repo)).out).toContain("Usage: cos <command>");
    expect((await cos(repo, "--version")).out).toBe(JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version);
    expect(await cos(repo, "frobnicate")).toMatchObject({ code: 2, err: expect.stringContaining('unknown command "frobnicate"') });
    expect(await cos(repo, "status", "--nope")).toMatchObject({ code: 2, err: expect.stringContaining("nope") });
  });

  it("exits 2 with a clear message outside a git repository", async () => {
    const r = await cos(tempDir(), "run", "list");
    expect(r.code).toBe(2);
    expect(r.err).toContain("not inside a git working tree");
  });

  it("exits 2 for missing options", async () => {
    const { repo } = makeFixture();
    expect(await cos(repo, "run", "create")).toMatchObject({ code: 2, err: expect.stringContaining("missing --objective") });
  });

  it("drives a whole run: plan, start, question, answer, decision gate, merge, status", async () => {
    const { repo } = makeFixture();
    fs.writeFileSync(path.join(repo, "plan.yaml"), PLAN);

    const planned = await cos(repo, "plan", "plan.yaml", "--id", "demo");
    expect(planned.out).toContain("created run demo");
    expect(planned.out).toContain("loaded 3 task(s) into run demo");

    const first = await cos(repo, "run", "start", "--concurrency", "1");
    expect(first.code).toBe(1);
    expect(first.out).toContain("1 completed, 2 blocked");
    expect(first.out).toContain("merged dependency schema into cos/demo/integration");

    const inbox = await cos(repo, "inbox", "--type", "question");
    expect(inbox.out).toMatch(/^m\d+  question task=api/);
    expect(inbox.out).toContain("Which auth scheme?");
    const qid = /^(m\d+)  question/.exec(inbox.out)?.[1] ?? "";

    expect((await cos(repo, "answer", "--message", qid, "--text", "token")).out).toBe(`answered ${qid}; task api can continue`);
    const gates = await cos(repo, "gate", "list");
    const gid = /^(g\d+)/.exec(gates.out)?.[1] ?? "";
    expect(gates.out).toContain("Publish under /docs or /wiki?");
    expect((await cos(repo, "gate", "resolve", "--gate", gid, "--decision", "/docs")).out).toBe(`resolved ${gid}: /docs`);

    const second = await cos(repo, "run", "start");
    expect(second.code).toBe(0);
    expect(second.out).toContain("all tasks completed and merged");

    const status = await cos(repo, "status");
    expect(status.out).toContain("3 completed");
    expect(status.out).toMatch(/schema\s+completed\s+Create schema\s+\(merged\)/);

    const shown = await cos(repo, "task", "show", "--task", "api");
    expect(shown.out).toContain("d2 (attempt 1): asked");
    expect(shown.out).toContain("d3 (attempt 2): passed");
    expect((await cos(repo, "logs", "--task", "api")).out).toContain("fake-worker: finished api");
  });

  it("emits JSON for list commands and mermaid for status", async () => {
    const { repo } = makeFixture();
    await cos(repo, "run", "create", "--objective", "o", "--id", "r1");
    await cos(repo, "task", "add", "--title", "A", "--spec", "x", "--id", "a");
    await cos(repo, "task", "add", "--title", "B", "--spec", "y", "--id", "b", "--after", "a");
    const tasks = JSON.parse((await cos(repo, "task", "list", "--json")).out);
    expect(tasks.map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([["a", "ready"], ["b", "pending"]]);
    const mermaid = (await cos(repo, "status", "--format", "mermaid")).out;
    expect(mermaid).toContain("flowchart TD");
    expect(mermaid).toContain("a --> b");
    const runs = JSON.parse((await cos(repo, "run", "list", "--json")).out);
    expect(runs[0]).toMatchObject({ id: "r1", integrationBranch: "cos/r1/integration" });
  });

  it("dispatch exits 1 when the quality gate fails and prints the gate result", async () => {
    const { repo } = makeFixture({ gates: [{ name: "nope", command: "echo bad; exit 3" }] });
    await cos(repo, "run", "create", "--objective", "o", "--id", "r1");
    await cos(repo, "task", "add", "--title", "A", "--spec", "x", "--id", "a");
    const d = await cos(repo, "dispatch", "--task", "a");
    expect(d.code).toBe(1);
    expect(d.out).toContain("dispatch d1 for task a: failed (attempt 1)");
    expect(d.out).toContain("gate nope: FAILED (exit 3)");
    expect((await cos(repo, "task", "show", "--task", "a")).out).toContain("| bad");
  });

  it("merge reports conflicts with exit 1; cleanup skips dirty worktrees", async () => {
    const { repo } = makeFixture();
    await cos(repo, "run", "create", "--objective", "o", "--id", "r1");
    await cos(repo, "task", "add", "--title", "A", "--spec", "fake.write: f.txt = a", "--id", "a");
    await cos(repo, "task", "add", "--title", "B", "--spec", "fake.write: f.txt = b", "--id", "b");
    await cos(repo, "dispatch", "--task", "a");
    await cos(repo, "dispatch", "--task", "b");
    expect((await cos(repo, "merge", "--task", "a")).code).toBe(0);
    const conflict = await cos(repo, "merge", "--task", "b");
    expect(conflict).toMatchObject({ code: 1, out: expect.stringContaining("CONFLICT b: f.txt") });

    fs.writeFileSync(path.join(repo, ".cos-worktrees", "r1", "a", "wip.txt"), "wip");
    const cleaned = await cos(repo, "cleanup");
    expect(cleaned.code).toBe(1);
    expect(cleaned.out).toContain("skipped r1/a: uncommitted changes");
    expect(fs.existsSync(path.join(repo, ".cos-worktrees", "r1", "a", "wip.txt"))).toBe(true);
  });
});

/** Runs the real CLI entry point in a child process (TypeScript through the tsx loader). */
function spawnCli(cwd: string, args: string[]) {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  return spawn(process.execPath, ["--import", tsx, path.join(PROJECT_ROOT, "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("crash recovery with real processes", () => {
  it("recovers after the supervisor is killed with SIGKILL and stops the leftover worker", async () => {
    const { repo } = makeFixture({}, { timeoutSec: 120 });
    const setup = new Coordinator({ repo });
    setup.createRun({ objective: "o", id: "r1" });
    setup.addTask("r1", { id: "a", title: "A", spec: "fake.spawn-child\nfake.hang" });

    const supervisor = spawnCli(repo, ["run", "start", "--run", "r1"]);
    const exited = new Promise((resolve) => supervisor.on("exit", resolve));
    await waitFor(() => new Coordinator({ repo }).dispatches("r1")[0]?.pid !== undefined, 30_000);

    const view = new Coordinator({ repo });
    const running = view.dispatches("r1")[0];
    const workerPid = running?.pid ?? 0;
    expect(running?.status).toBe("running");
    expect(running?.supervisorPid).toBe(supervisor.pid);
    const childPidFile = path.join(repo, ".cos-worktrees", "r1", "a", ".cos", "child.pid");
    await waitFor(() => fs.existsSync(childPidFile));
    const childPid = Number(fs.readFileSync(childPidFile, "utf8"));

    supervisor.kill("SIGKILL");
    await exited;
    // the worker is detached, so it survives its supervisor
    expect(pidAlive(workerPid)).toBe(true);

    // a fresh process (any command) notices the dead supervisor and cleans up
    const restarted = await cos(repo, "recover");
    expect(restarted.out).toContain("orphaned d1 (task a)");
    await waitFor(() => !pidAlive(workerPid) && !pidAlive(childPid), 10_000);

    const after = new Coordinator({ repo });
    expect(after.dispatches("r1")[0]).toMatchObject({ status: "orphaned", failureKind: "orphaned" });
    expect(after.listTasks("r1")[0]?.status).toBe("failed");
  });

  it("kills running workers when the CLI receives SIGTERM, and the next command marks them orphaned", async () => {
    const { repo } = makeFixture({}, { timeoutSec: 120 });
    const setup = new Coordinator({ repo });
    setup.createRun({ objective: "o", id: "r1" });
    setup.addTask("r1", { id: "a", title: "A", spec: "fake.hang" });

    const supervisor = spawnCli(repo, ["run", "start", "--run", "r1"]);
    const exited = new Promise<number | null>((resolve) => supervisor.on("exit", resolve));
    await waitFor(() => new Coordinator({ repo }).dispatches("r1")[0]?.pid !== undefined, 30_000);
    const workerPid = new Coordinator({ repo }).dispatches("r1")[0]?.pid ?? 0;
    supervisor.kill("SIGTERM");
    expect(await exited).toBe(130);
    await waitFor(() => !pidAlive(workerPid), 10_000);
    expect((await cos(repo, "recover")).out).toContain("orphaned d1");
    expect(new Coordinator({ repo }).listTasks("r1")[0]?.status).toBe("failed");
  });
});
