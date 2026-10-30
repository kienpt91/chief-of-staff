import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildEnv, expand, loadConfig, parseConfig, resolveInvocation, type Placeholders } from "../src/config.js";
import { evaluateRefcheckJson } from "../src/gates.js";
import { atomicWriteJson, pidAlive, readJson, withLockSync } from "../src/fsutil.js";
import { parsePlan } from "../src/plan.js";
import { runProcess } from "../src/process.js";
import { Store } from "../src/store.js";
import type { Run } from "../src/types.js";
import { tempDir, waitFor } from "./helpers.js";

const vars: Placeholders = { briefPath: "/b/brief.md", taskId: "t1", dispatchId: "d1", worktree: "/w", repo: "/r", runId: "run1" };

describe("config", () => {
  it("parses a full config and applies defaults", () => {
    const c = parseConfig("cfg", {
      workers: { default: { command: "agent", args: ["{briefPath}"], env: { A: "1" }, timeoutSec: 5, heartbeatTimeoutSec: 2 } },
      gates: [{ name: "tests", command: "npm test" }, { name: "refs", command: "refcheck", args: ["check", "--json"], format: "refcheck-json" }],
      concurrency: 3,
    });
    expect(c.concurrency).toBe(3);
    expect(c.workers.default?.heartbeatTimeoutSec).toBe(2);
    expect(c.gates[1]?.format).toBe("refcheck-json");
    expect(c.killGraceSec).toBe(2);
  });

  it.each([
    [{ workers: { x: { args: [] } } }, /command/],
    [{ workers: { x: { command: "a", args: "no" } } }, /args/],
    [{ workers: { x: { command: "a", timeoutSec: -1 } } }, /timeoutSec/],
    [{ gates: [{ command: "a" }] }, /name/],
    [{ gates: [{ name: "g", command: "a", format: "yaml" }] }, /format/],
    [{ gates: [{ name: "g", command: "a" }, { name: "g", command: "b" }] }, /duplicate gate/],
    [{ concurrency: 0 }, /concurrency/],
  ])("rejects invalid config %#", (raw, message) => {
    expect(() => parseConfig("cfg", raw)).toThrow(message);
  });

  it("loads a missing default config as empty but a missing explicit one as an error", () => {
    const dir = tempDir();
    expect(loadConfig(dir).workers).toEqual({});
    expect(() => loadConfig(dir, "nope.json")).toThrow(/cannot read config/);
  });

  it("expands placeholders and leaves unknown ones alone", () => {
    expect(expand("{briefPath}|{taskId}|{dispatchId}|{worktree}|{x}", vars)).toBe("/b/brief.md|t1|d1|/w|{x}");
  });

  it("runs args directly but a bare command through the shell", () => {
    expect(resolveInvocation({ command: "agent", args: ["--brief", "{briefPath}"] }, vars)).toMatchObject({ command: "agent", args: ["--brief", "/b/brief.md"] });
    expect(resolveInvocation({ command: "test -f {briefPath}" }, vars)).toMatchObject({ command: "/bin/sh", args: ["-c", "test -f '/b/brief.md'"] });
  });

  it("builds the environment from an allowlist only", () => {
    const config = parseConfig("cfg", { envAllow: ["EXTRA_OK"] });
    const parent = { PATH: "/bin", HOME: "/h", SOME_TOKEN: "leak", EXTRA_OK: "yes", EXTRA_NO: "no" };
    const env = buildEnv(config, { FROM_CONFIG: "{taskId}" }, vars, { COS_TASK: "t1" }, parent);
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", EXTRA_OK: "yes", FROM_CONFIG: "t1", COS_TASK: "t1" });
  });
});

describe("refcheck-json gate parsing", () => {
  const doc = (errors: number, warnings: number, findings: unknown[] = []) =>
    JSON.stringify({ version: 1, root: "/r", filesChecked: 3, findings, summary: { errors, warnings } });

  it("passes with zero errors, even with warnings and exit code 0", () => {
    expect(evaluateRefcheckJson(doc(0, 2), 0)).toMatchObject({ passed: true, summary: "0 error(s), 2 warning(s)" });
  });

  it("passes with zero errors even if the process exited 1", () => {
    expect(evaluateRefcheckJson(doc(0, 0), 1).passed).toBe(true);
  });

  it("fails on errors and lists the findings", () => {
    const finding = { rule: "unknown-export", severity: "error", file: "src/a.ts", line: 3, column: 9, message: "no export 'x'", suggestion: "y" };
    const r = evaluateRefcheckJson(doc(1, 0, [finding]), 1);
    expect(r.passed).toBe(false);
    expect(r.output).toBe("src/a.ts:3:9 error unknown-export: no export 'x' (suggestion: y)");
  });

  it("fails on exit code 2 even when the JSON claims zero errors", () => {
    expect(evaluateRefcheckJson(doc(0, 0), 2).passed).toBe(false);
  });

  it("fails on invalid JSON and on JSON that does not match the contract", () => {
    expect(evaluateRefcheckJson("refcheck: boom", 2)).toMatchObject({ passed: false, summary: "output is not valid JSON" });
    expect(evaluateRefcheckJson('{"ok":true}', 0).passed).toBe(false);
  });
});

describe("plan parsing", () => {
  it("parses YAML with string or list dependencies", () => {
    const plan = parsePlan("p.yaml", "objective: Ship it\ntasks:\n  - id: a\n    title: A\n    spec: do a\n  - id: b\n    title: B\n    spec: do b\n    after: a\n    acceptance: [x, y]\n    gate: ok?\n");
    expect(plan.objective).toBe("Ship it");
    expect(plan.tasks[1]).toMatchObject({ id: "b", after: ["a"], acceptance: ["x", "y"], gate: "ok?" });
  });

  it("parses JSON too", () => {
    expect(parsePlan("p.json", '{"tasks":[{"title":"T","spec":"S"}]}').tasks).toHaveLength(1);
  });

  it.each([
    ["", /object/],
    ["tasks: []", /non-empty/],
    ["tasks:\n  - title: x", /spec is required/],
    ["tasks:\n  - spec: x", /title is required/],
    ["tasks:\n  - title: x\n    spec: y\n    after: [1]", /list of strings/],
  ])("rejects bad plan %#", (text, message) => {
    expect(() => parsePlan("p.yaml", text)).toThrow(message);
  });
});

describe("store and filesystem helpers", () => {
  const run = (id: string): Run => ({
    id,
    objective: "o",
    repoRoot: "/r",
    baseRef: "main",
    baseCommit: "abc",
    integrationBranch: `cos/${id}/integration`,
    createdAt: new Date().toISOString(),
    counters: { task: 0, dispatch: 0, message: 0, decision: 0 },
  });

  it("writes JSON atomically and reads it back", () => {
    const file = path.join(tempDir(), "x", "y.json");
    atomicWriteJson(file, { a: 1 });
    expect(readJson(file)).toEqual({ a: 1 });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["y.json"]);
    expect(readJson(path.join(path.dirname(file), "missing.json"))).toBeUndefined();
  });

  it("reports corrupt state files clearly", () => {
    const file = path.join(tempDir(), "bad.json");
    fs.writeFileSync(file, "{not json");
    expect(() => readJson(file)).toThrow(/corrupt JSON/);
  });

  it("allocates unique ids across store instances (state survives a restart)", () => {
    const root = tempDir();
    const a = new Store(root);
    a.putRun(run("r1"));
    const ids = [a.tx("r1", (s) => s.allocId("r1", "message", "m")), new Store(root).tx("r1", (s) => s.allocId("r1", "message", "m"))];
    expect(ids).toEqual(["m1", "m2"]);
    expect(new Store(root).listRuns().map((r) => r.id)).toEqual(["r1"]);
  });

  it("steals a lock whose owner died", async () => {
    const dir = tempDir();
    const lock = path.join(dir, ".lock");
    const dead = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => dead.on("exit", r));
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), String(dead.pid));
    expect(pidAlive(dead.pid ?? 0)).toBe(false);
    expect(withLockSync(lock, () => "ok", { timeoutMs: 2000 })).toBe("ok");
  });

  it("times out on a lock held by a live process", () => {
    const dir = tempDir();
    const lock = path.join(dir, ".lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner"), String(process.pid));
    expect(() => withLockSync(lock, () => 1, { timeoutMs: 100 })).toThrow(/timed out waiting for lock/);
  });
});

describe("process runner", () => {
  it("kills the whole process group on timeout", async () => {
    const dir = tempDir();
    const pidFile = path.join(dir, "child.pid");
    const script = `const {spawn}=require('child_process');const c=spawn('sleep',['60'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    const res = await runProcess({
      command: process.execPath,
      args: ["-e", script],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 700,
      killGraceMs: 300,
      stdoutPath: path.join(dir, "out.log"),
    });
    expect(res.timedOut).toBe(true);
    const childPid = Number(fs.readFileSync(pidFile, "utf8"));
    await waitFor(() => !pidAlive(childPid), 5000);
  });

  it("reports spawn errors instead of throwing", async () => {
    const dir = tempDir();
    const res = await runProcess({ command: "/definitely/not/here", args: [], cwd: dir, env: {}, timeoutMs: 1000, killGraceMs: 100, stdoutPath: path.join(dir, "o.log") });
    expect(res.spawnError).toMatch(/ENOENT/);
  });
});
