import fs from "node:fs";
import path from "node:path";
import { CosError } from "./errors.js";

export interface CommandSpec {
  command: string;
  /** When omitted, `command` is run through `/bin/sh -c`. */
  args?: string[];
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface WorkerConfig extends CommandSpec {
  /** Kill the worker if `.cos/heartbeat` exists and has not been touched for this long. */
  heartbeatTimeoutSec?: number;
}

export interface GateConfig extends CommandSpec {
  name: string;
  format?: "exit" | "refcheck-json";
}

export interface Config {
  workers: Record<string, WorkerConfig>;
  gates: GateConfig[];
  concurrency: number;
  /** Extra environment variable names passed through to workers and gates. */
  envAllow: string[];
  killGraceSec: number;
}

export const DEFAULT_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
];

export const DEFAULT_WORKER_TIMEOUT_SEC = 1800;
export const DEFAULT_GATE_TIMEOUT_SEC = 600;

export function defaultConfig(): Config {
  return { workers: {}, gates: [], concurrency: 2, envAllow: [], killGraceSec: 2 };
}

function fail(file: string, msg: string): never {
  throw new CosError(`${file}: ${msg}`);
}

function parseCommand(file: string, where: string, raw: unknown): CommandSpec {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(file, `${where} must be an object`);
  const o = raw as Record<string, unknown>;
  if (typeof o.command !== "string" || o.command.trim() === "") fail(file, `${where}.command must be a non-empty string`);
  const spec: CommandSpec = { command: o.command };
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || !o.args.every((a) => typeof a === "string")) {
      fail(file, `${where}.args must be an array of strings`);
    }
    spec.args = o.args as string[];
  }
  if (o.env !== undefined) {
    if (typeof o.env !== "object" || o.env === null || Array.isArray(o.env)) fail(file, `${where}.env must be an object`);
    for (const [k, v] of Object.entries(o.env)) {
      if (typeof v !== "string") fail(file, `${where}.env.${k} must be a string`);
    }
    spec.env = o.env as Record<string, string>;
  }
  if (o.timeoutSec !== undefined) {
    if (typeof o.timeoutSec !== "number" || !(o.timeoutSec > 0)) fail(file, `${where}.timeoutSec must be a positive number`);
    spec.timeoutSec = o.timeoutSec;
  }
  return spec;
}

export function parseConfig(file: string, raw: unknown): Config {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(file, "config must be a JSON object");
  const o = raw as Record<string, unknown>;
  const config = defaultConfig();

  if (o.workers !== undefined) {
    if (typeof o.workers !== "object" || o.workers === null || Array.isArray(o.workers)) fail(file, "workers must be an object");
    for (const [name, w] of Object.entries(o.workers)) {
      const spec = parseCommand(file, `workers.${name}`, w) as WorkerConfig;
      const hb = (w as Record<string, unknown>).heartbeatTimeoutSec;
      if (hb !== undefined) {
        if (typeof hb !== "number" || !(hb > 0)) fail(file, `workers.${name}.heartbeatTimeoutSec must be a positive number`);
        spec.heartbeatTimeoutSec = hb;
      }
      config.workers[name] = spec;
    }
  }

  if (o.gates !== undefined) {
    if (!Array.isArray(o.gates)) fail(file, "gates must be an array");
    const names = new Set<string>();
    o.gates.forEach((g, i) => {
      const spec = parseCommand(file, `gates[${i}]`, g) as GateConfig;
      const { name, format } = g as Record<string, unknown>;
      if (typeof name !== "string" || name.trim() === "") fail(file, `gates[${i}].name must be a non-empty string`);
      if (names.has(name)) fail(file, `duplicate gate name "${name}"`);
      names.add(name);
      spec.name = name;
      if (format !== undefined) {
        if (format !== "exit" && format !== "refcheck-json") fail(file, `gates[${i}].format must be "exit" or "refcheck-json"`);
        spec.format = format;
      }
      config.gates.push(spec);
    });
  }

  if (o.concurrency !== undefined) {
    if (!Number.isInteger(o.concurrency) || (o.concurrency as number) < 1) fail(file, "concurrency must be an integer >= 1");
    config.concurrency = o.concurrency as number;
  }
  if (o.envAllow !== undefined) {
    if (!Array.isArray(o.envAllow) || !o.envAllow.every((e) => typeof e === "string")) fail(file, "envAllow must be an array of strings");
    config.envAllow = o.envAllow as string[];
  }
  if (o.killGraceSec !== undefined) {
    if (typeof o.killGraceSec !== "number" || !(o.killGraceSec >= 0)) fail(file, "killGraceSec must be a number >= 0");
    config.killGraceSec = o.killGraceSec;
  }
  return config;
}

/** Loads `cos.config.json` (or the given path). A missing default file yields an empty config. */
export function loadConfig(repoRoot: string, explicitPath?: string): Config {
  const file = path.resolve(repoRoot, explicitPath ?? "cos.config.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && explicitPath === undefined) return defaultConfig();
    throw new CosError(`cannot read config ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new CosError(`${file}: invalid JSON: ${(err as Error).message}`);
  }
  return parseConfig(file, raw);
}

export interface Placeholders {
  briefPath: string;
  taskId: string;
  dispatchId: string;
  worktree: string;
  repo: string;
  runId: string;
}

export function expand(template: string, vars: Placeholders): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) =>
    Object.hasOwn(vars, key) ? vars[key as keyof Placeholders] : m,
  );
}

export interface Invocation {
  command: string;
  args: string[];
  display: string;
}

export function resolveInvocation(spec: CommandSpec, vars: Placeholders): Invocation {
  if (spec.args === undefined) {
    const line = expand(spec.command, vars);
    return { command: "/bin/sh", args: ["-c", line], display: line };
  }
  const command = expand(spec.command, vars);
  const args = spec.args.map((a) => expand(a, vars));
  return { command, args, display: [command, ...args].map(quoteForDisplay).join(" ") };
}

function quoteForDisplay(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : JSON.stringify(s);
}

/** Explicit allowlist: only these variables from the parent environment, plus the spec's own env. */
export function buildEnv(
  config: Config,
  specEnv: Record<string, string> | undefined,
  vars: Placeholders,
  cosEnv: Record<string, string>,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...DEFAULT_ENV_ALLOW, ...config.envAllow]) {
    const v = parent[key];
    if (v !== undefined) env[key] = v;
  }
  for (const [k, v] of Object.entries(specEnv ?? {})) env[k] = expand(v, vars);
  return { ...env, ...cosEnv };
}
