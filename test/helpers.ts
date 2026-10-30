import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { Coordinator } from "../src/coordinator.js";
import type { Config } from "../src/config.js";
import type { TaskInput } from "../src/tasks.js";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_WORKER = path.join(PROJECT_ROOT, "examples", "fake-worker.mjs");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

export function tempDir(prefix = "cos-test-"): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function git(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", args);
}

/** A real git repository with one commit on `main`, hermetic w.r.t. global git hooks/config. */
export function makeRepo(): string {
  const dir = tempDir("cos-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "core.hooksPath", "/dev/null");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial commit");
  return dir;
}

export function fakeWorkerConfig(extra: Partial<Config["workers"][string]> = {}): Config["workers"][string] {
  return { command: process.execPath, args: [FAKE_WORKER, "{briefPath}"], ...extra };
}

export function writeConfig(repo: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, "cos.config.json"), JSON.stringify(config, null, 2));
}

export interface Fixture {
  repo: string;
  cos: Coordinator;
  logs: string[];
}

/** Repo + config (fake worker as "default") + coordinator with fast polling. */
export function makeFixture(config: Record<string, unknown> = {}, worker: Partial<Config["workers"][string]> = {}): Fixture {
  const repo = makeRepo();
  writeConfig(repo, { workers: { default: fakeWorkerConfig(worker) }, killGraceSec: 0.5, ...config });
  const logs: string[] = [];
  const cos = new Coordinator({ repo, pollMs: 50, log: (m) => logs.push(m) });
  return { repo, cos, logs };
}

export function specLines(...lines: string[]): string {
  return lines.join("\n");
}

export function task(id: string, spec: string, extra: Partial<TaskInput> = {}): TaskInput {
  return { id, title: `Task ${id}`, spec, ...extra };
}

export function branchTip(repo: string, branch: string): string {
  return git(repo, "rev-parse", branch);
}

export function fileOnBranch(repo: string, branch: string, file: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${branch}:${file}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 20_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
