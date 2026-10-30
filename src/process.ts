import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pidAlive, regularFileSize } from "./fsutil.js";

/** Start time of a process as reported by ps; distinguishes a live process from a recycled pid. */
export function processFingerprint(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/** Process group id as reported by ps. */
function processGroupId(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    }).trim();
    const n = Number(out);
    return Number.isInteger(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Liveness check for supervisors: an unknown start time counts as alive (never orphan a live process by mistake). */
export function isSameProcess(pid: number | undefined, fingerprint: string | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return false;
  if (fingerprint === undefined) return true;
  const current = processFingerprint(pid);
  return current === undefined || current === fingerprint;
}

/**
 * Identity check before signalling a process group: the recorded start time must exist and match,
 * and the process must be the leader of its own group. Anything unknown means "do not kill".
 */
export function isVerifiedGroupLeader(pid: number | undefined, fingerprint: string | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || fingerprint === undefined) return false;
  if (!pidAlive(pid)) return false;
  return processFingerprint(pid) === fingerprint && processGroupId(pid) === pid;
}

const activeGroups = new Set<number>();

/** Kills every worker/gate process group started by this process (used on SIGINT/SIGTERM). */
export function terminateActiveProcesses(): void {
  for (const pid of activeGroups) killGroup(pid, "SIGKILL");
  activeGroups.clear();
}

/** Signals a process group. Refuses pids that could never be a child group leader (0, 1, negative, non-integers). */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

function openLogAppend(file: string): number {
  // O_NOFOLLOW: a log path swapped for a symlink is refused rather than followed
  return fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o644);
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
  /** Kill the process group when stdout+stderr files together exceed this many bytes. */
  maxOutputBytes?: number;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stalled: boolean;
  /** the process was killed because its output files exceeded maxOutputBytes */
  outputLimit: boolean;
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
  const outFd = openLogAppend(opts.stdoutPath);
  const errPath = opts.stderrPath ?? opts.stdoutPath;
  let errFd = outFd;
  if (errPath !== opts.stdoutPath) {
    try {
      errFd = openLogAppend(errPath);
    } catch (err) {
      fs.closeSync(outFd);
      throw err;
    }
  }
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
      resolve({ exitCode: null, signal: null, timedOut: false, stalled: false, outputLimit: false, spawnError: (err as Error).message, startedAt, endedAt: Date.now() });
      return;
    }

    let timedOut = false;
    let stalled = false;
    let outputLimit = false;
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
      if (opts.maxOutputBytes !== undefined && !outputLimit && !timedOut) {
        const total = (regularFileSize(opts.stdoutPath) ?? 0) + (errPath === opts.stdoutPath ? 0 : (regularFileSize(errPath) ?? 0));
        if (total > opts.maxOutputBytes) {
          outputLimit = true;
          terminate();
        }
      }
      if (opts.heartbeatFile && opts.heartbeatTimeoutMs !== undefined && !stalled && !timedOut) {
        // lstat: a heartbeat must be a regular file the worker touches, not a symlink to something else
        const size = regularFileSize(opts.heartbeatFile);
        if (size !== undefined) {
          const age = Date.now() - fs.lstatSync(opts.heartbeatFile).mtimeMs;
          if (age > opts.heartbeatTimeoutMs) {
            stalled = true;
            terminate();
          }
        }
      }
    }, opts.pollMs ?? 200);

    child.on("error", (err) => finish({ exitCode: null, signal: null, timedOut, stalled, outputLimit, spawnError: err.message }));
    child.on("exit", (code, signal) => {
      // a process that failed to spawn has no pid; its "error" event carries the reason
      if (child.pid === undefined) return;
      finish({ exitCode: code, signal, timedOut, stalled, outputLimit });
    });
  });
}
