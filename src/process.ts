import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pidAlive } from "./fsutil.js";

/** Start time of a process as reported by ps; distinguishes a live process from a recycled pid. */
export function processFingerprint(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** True if `pid` is alive and (when a fingerprint is known) still the same process. */
export function isSameProcess(pid: number | undefined, fingerprint: string | undefined): boolean {
  if (pid === undefined || !pidAlive(pid)) return false;
  if (fingerprint === undefined) return true;
  const current = processFingerprint(pid);
  return current === undefined || current === fingerprint;
}

const activeGroups = new Set<number>();

/** Kills every worker/gate process group started by this process (used on SIGINT/SIGTERM). */
export function terminateActiveProcesses(): void {
  for (const pid of activeGroups) killGroup(pid, "SIGKILL");
  activeGroups.clear();
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  killGraceMs: number;
  stdoutPath: string;
  /** Defaults to stdoutPath (merged stream). */
  stderrPath?: string;
  pollMs?: number;
  /** Kill if this file exists and its mtime is older than heartbeatTimeoutMs. */
  heartbeatFile?: string;
  heartbeatTimeoutMs?: number;
  onSpawn?: (pid: number) => void;
  /** Called every pollMs while the process runs. */
  onTick?: () => void;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stalled: boolean;
  spawnError?: string;
  startedAt: number;
  endedAt: number;
}

/**
 * Runs a command as the leader of its own process group. Output goes to files (not pipes), so
 * a worker keeps running if the supervisor dies. On timeout or stall the whole group gets
 * SIGTERM, then SIGKILL after the grace period. After the leader exits, stragglers in the
 * group are killed.
 */
export function runProcess(opts: RunProcessOptions): Promise<RunProcessResult> {
  fs.mkdirSync(path.dirname(opts.stdoutPath), { recursive: true });
  const outFd = fs.openSync(opts.stdoutPath, "a");
  const errPath = opts.stderrPath ?? opts.stdoutPath;
  const errFd = errPath === opts.stdoutPath ? outFd : fs.openSync(errPath, "a");
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        detached: true,
        stdio: ["ignore", outFd, errFd],
      });
    } catch (err) {
      closeFds();
      resolve({ exitCode: null, signal: null, timedOut: false, stalled: false, spawnError: (err as Error).message, startedAt, endedAt: Date.now() });
      return;
    }

    let timedOut = false;
    let stalled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    function closeFds(): void {
      fs.closeSync(outFd);
      if (errFd !== outFd) fs.closeSync(errFd);
    }

    const terminate = (): void => {
      if (child.pid === undefined) return;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      }, opts.killGraceMs);
    };

    const finish = (result: Omit<RunProcessResult, "startedAt" | "endedAt">): void => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) activeGroups.delete(child.pid);
      clearTimeout(timeout);
      clearInterval(ticker);
      clearTimeout(killTimer);
      if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
      closeFds();
      resolve({ ...result, startedAt, endedAt: Date.now() });
    };

    if (child.pid !== undefined) {
      activeGroups.add(child.pid);
      opts.onSpawn?.(child.pid);
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);

    const ticker = setInterval(() => {
      try {
        opts.onTick?.();
      } catch {
        // observers must never take the supervisor down
      }
      if (opts.heartbeatFile && opts.heartbeatTimeoutMs !== undefined && !stalled && !timedOut) {
        try {
          const age = Date.now() - fs.statSync(opts.heartbeatFile).mtimeMs;
          if (age > opts.heartbeatTimeoutMs) {
            stalled = true;
            terminate();
          }
        } catch {
          // no heartbeat file yet: heartbeat is optional
        }
      }
    }, opts.pollMs ?? 200);

    child.on("error", (err) => finish({ exitCode: null, signal: null, timedOut, stalled, spawnError: err.message }));
    child.on("exit", (code, signal) => {
      // a process that failed to spawn has no pid; its "error" event carries the reason
      if (child.pid === undefined) return;
      finish({ exitCode: code, signal, timedOut, stalled });
    });
  });
}
