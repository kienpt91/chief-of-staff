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

/** Reads coordinator-owned state (never worker-writable input; see readRegularFile for that). */
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

export type SafeRead =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; missing: boolean; reason: string };

const NOFOLLOW_NONBLOCK = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function openRegular(file: string): { fd: number; size: number } | { reason: string; missing: boolean } {
  let fd: number;
  try {
    // O_NOFOLLOW rejects a symlink as the last path component; O_NONBLOCK makes opening a FIFO return at once.
    fd = fs.openSync(file, NOFOLLOW_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { reason: "missing", missing: true };
    if (code === "ELOOP") return { reason: "is a symlink", missing: false };
    return { reason: `cannot be opened (${code ?? "error"})`, missing: false };
  }
  const st = fs.fstatSync(fd);
  if (!st.isFile()) {
    fs.closeSync(fd);
    return { reason: "is not a regular file", missing: false };
  }
  return { fd, size: st.size };
}

function readExactly(fd: number, length: number, position: number): string {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return buf.subarray(0, done).toString("utf8");
}

/**
 * Reads a file a worker can write. It must be a regular file (not a symlink, FIFO or device) of at most
 * `maxBytes`; nothing larger is ever read into memory and nothing here can block on a FIFO.
 */
export function readRegularFile(file: string, maxBytes: number): SafeRead {
  const opened = openRegular(file);
  if ("reason" in opened) return { ok: false, missing: opened.missing, reason: opened.reason };
  try {
    if (opened.size > maxBytes) return { ok: false, missing: false, reason: `is larger than ${maxBytes} bytes` };
    return { ok: true, text: readExactly(opened.fd, opened.size, 0), truncated: false };
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Like readRegularFile, but for logs that may legitimately be large: returns the last `maxBytes` only. */
export function readRegularTail(file: string, maxBytes: number): SafeRead {
  const opened = openRegular(file);
  if ("reason" in opened) return { ok: false, missing: opened.missing, reason: opened.reason };
  try {
    const start = Math.max(0, opened.size - maxBytes);
    return { ok: true, text: readExactly(opened.fd, opened.size - start, start), truncated: start > 0 };
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** True only for a real directory (a symlink to a directory does not count). */
export function isRealDir(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Size of a regular, non-symlink file, or undefined. */
export function regularFileSize(file: string): number | undefined {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() ? st.size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Makes sure `dir` is a real directory (not a symlink or a file) by replacing anything else.
 * Used for directories inside a worktree that the worker also controls, so coordinator writes
 * cannot be redirected elsewhere. Only the entry itself is removed, never a symlink's target.
 */
export function ensureRealDir(dir: string): void {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(dir);
  } catch {
    st = undefined;
  }
  if (st && !st.isDirectory()) {
    fs.rmSync(dir, { force: true });
    st = undefined;
  }
  if (!st) fs.mkdirSync(dir, { recursive: true });
}

export function clipText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 15))}...[truncated]`;
}

export function tailText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[... ${text.length - maxChars} earlier characters omitted ...]\n${text.slice(text.length - maxChars)}`;
}

interface LockOptions {
  timeoutMs?: number;
}

function readOwner(lockDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(lockDir, "owner"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Directory lock: mkdir is atomic, and the owner file holds "pid:token". A lock is only taken over
 * when its owner process is dead (or the owner file never appeared), never from a live owner
 * regardless of age. The takeover renames the directory away first, so two waiters cannot both
 * delete it, and checks that the directory it moved is the one it judged stale.
 * Returns the owner token on success.
 */
function tryAcquire(lockDir: string): string | undefined {
  const token = `${process.pid}:${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "owner"), token);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const observed = readOwner(lockDir);
  let stale: boolean;
  if (observed === undefined) {
    try {
      stale = Date.now() - fs.statSync(lockDir).mtimeMs > 2000;
    } catch {
      return undefined;
    }
  } else {
    const pid = Number(observed.split(":")[0]);
    stale = !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
  }
  if (!stale) return undefined;

  const grave = `${lockDir}.stale-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockDir, grave);
  } catch {
    return undefined; // somebody else already took it over
  }
  if (readOwner(grave) !== observed) {
    // we moved a lock that was re-created in the meantime: put it back if nobody took the spot
    try {
      fs.renameSync(grave, lockDir);
    } catch {
      fs.rmSync(grave, { recursive: true, force: true });
    }
    return undefined;
  }
  fs.rmSync(grave, { recursive: true, force: true });
  return undefined;
}

function release(lockDir: string, token: string): void {
  if (readOwner(lockDir) === token) fs.rmSync(lockDir, { recursive: true, force: true });
}

export function withLockSync<T>(lockDir: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let token = tryAcquire(lockDir);
  while (token === undefined) {
    if (Date.now() > deadline) throw new CosError(`timed out waiting for lock ${lockDir}`);
    sleepSync(5 + Math.floor(Math.random() * 10));
    token = tryAcquire(lockDir);
  }
  try {
    return fn();
  } finally {
    release(lockDir, token);
  }
}

export async function withLock<T>(lockDir: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let token = tryAcquire(lockDir);
  while (token === undefined) {
    if (Date.now() > deadline) throw new CosError(`timed out waiting for lock ${lockDir}`);
    await sleep(20 + Math.floor(Math.random() * 20));
    token = tryAcquire(lockDir);
  }
  try {
    return await fn();
  } finally {
    release(lockDir, token);
  }
}
