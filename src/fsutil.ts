import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CosError } from "./errors.js";

export function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function atomicWriteJson(file: string, data: unknown): void {
  atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readJson<T>(file: string): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new CosError(`corrupt JSON in ${file}: ${(err as Error).message}`);
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

/**
 * Directory based lock: mkdir is atomic. The owner pid is stored inside so that
 * a lock left behind by a dead process can be stolen.
 */
function tryAcquire(lockDir: string, staleMs: number): boolean {
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), String(process.pid));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  try {
    const stat = fs.statSync(lockDir);
    let ownerAlive = true;
    try {
      const owner = Number(fs.readFileSync(path.join(lockDir, "owner"), "utf8"));
      if (Number.isInteger(owner) && owner > 0) ownerAlive = pidAlive(owner);
    } catch {
      // owner file not written yet; fall back to age
    }
    if (!ownerAlive || Date.now() - stat.mtimeMs > staleMs) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // vanished between calls; retry
  }
  return false;
}

export function withLockSync<T>(lockDir: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? 60_000;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquire(lockDir, staleMs)) {
    if (Date.now() > deadline) throw new CosError(`timed out waiting for lock ${lockDir}`);
    sleepSync(5 + Math.floor(Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export async function withLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const staleMs = opts.staleMs ?? 600_000;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquire(lockDir, staleMs)) {
    if (Date.now() > deadline) throw new CosError(`timed out waiting for lock ${lockDir}`);
    await sleep(20 + Math.floor(Math.random() * 20));
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[... ${text.length - maxChars} earlier characters omitted ...]\n${text.slice(text.length - maxChars)}`;
}
