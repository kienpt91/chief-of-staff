import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_GATE_TIMEOUT_SEC,
  buildEnv,
  resolveInvocation,
  type Config,
  type GateConfig,
  type Placeholders,
} from "./config.js";
import { tailText } from "./fsutil.js";
import { runProcess } from "./process.js";
import type { GateResult } from "./types.js";

const OUTPUT_LIMIT = 16_000;
const MAX_FINDINGS_SHOWN = 50;

export interface GateRunContext {
  config: Config;
  vars: Placeholders;
  cosEnv: Record<string, string>;
  /** directory for the raw gate logs */
  logDir: string;
  pollMs?: number;
}

interface RefcheckFinding {
  rule?: unknown;
  severity?: unknown;
  file?: unknown;
  line?: unknown;
  column?: unknown;
  message?: unknown;
  suggestion?: unknown;
}

/**
 * Interprets the refcheck JSON contract:
 * {"version":1,"root":string,"filesChecked":number,"findings":[...],"summary":{"errors":n,"warnings":n}}
 * Fails when summary.errors > 0, when the output is not that JSON, or on exit code >= 2 (usage/internal error).
 */
export function evaluateRefcheckJson(
  stdout: string,
  exitCode: number | null,
): { passed: boolean; summary: string; output: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return {
      passed: false,
      summary: "output is not valid JSON",
      output: tailText(stdout, OUTPUT_LIMIT) || "(no output)",
    };
  }
  const obj = parsed as { summary?: { errors?: unknown; warnings?: unknown }; findings?: unknown };
  const errors = obj?.summary?.errors;
  const warnings = obj?.summary?.warnings;
  if (typeof errors !== "number" || !Array.isArray(obj.findings)) {
    return {
      passed: false,
      summary: "JSON does not match the refcheck contract (summary.errors / findings missing)",
      output: tailText(stdout, OUTPUT_LIMIT),
    };
  }
  const findings = obj.findings as RefcheckFinding[];
  const lines = findings.slice(0, MAX_FINDINGS_SHOWN).map((f) => {
    const where = `${String(f.file)}:${String(f.line)}:${String(f.column)}`;
    const hint = typeof f.suggestion === "string" ? ` (suggestion: ${f.suggestion})` : "";
    return `${where} ${String(f.severity)} ${String(f.rule)}: ${String(f.message)}${hint}`;
  });
  if (findings.length > MAX_FINDINGS_SHOWN) lines.push(`... and ${findings.length - MAX_FINDINGS_SHOWN} more findings`);
  const summary = `${errors} error(s), ${typeof warnings === "number" ? warnings : 0} warning(s)`;
  const exitBad = exitCode !== null && exitCode >= 2;
  return {
    passed: errors === 0 && !exitBad,
    summary: exitBad ? `${summary}; exit code ${exitCode}` : summary,
    output: lines.join("\n"),
  };
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export async function runGate(gate: GateConfig, ctx: GateRunContext): Promise<GateResult> {
  const inv = resolveInvocation(gate, ctx.vars);
  const format = gate.format ?? "exit";
  const safeName = gate.name.replace(/[^\w.-]/g, "_");
  const outPath = path.join(ctx.logDir, `${ctx.vars.dispatchId}.gate-${safeName}.out.log`);
  const errPath = path.join(ctx.logDir, `${ctx.vars.dispatchId}.gate-${safeName}.err.log`);
  fs.rmSync(outPath, { force: true });
  fs.rmSync(errPath, { force: true });
  const timeoutSec = gate.timeoutSec ?? DEFAULT_GATE_TIMEOUT_SEC;

  const res = await runProcess({
    command: inv.command,
    args: inv.args,
    cwd: ctx.vars.worktree,
    env: buildEnv(ctx.config, gate.env, ctx.vars, ctx.cosEnv),
    timeoutMs: timeoutSec * 1000,
    killGraceMs: ctx.config.killGraceSec * 1000,
    stdoutPath: outPath,
    stderrPath: errPath,
    pollMs: ctx.pollMs,
  });
  const durationMs = res.endedAt - res.startedAt;
  const base = { name: gate.name, format, command: inv.display, durationMs, timedOut: res.timedOut };

  if (res.spawnError) {
    return { ...base, passed: false, exitCode: null, summary: `could not start: ${res.spawnError}`, output: "" };
  }
  const stdout = readText(outPath);
  const stderr = readText(errPath);
  if (res.timedOut) {
    const combined = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
    return {
      ...base,
      passed: false,
      exitCode: res.exitCode,
      summary: `timed out after ${timeoutSec}s`,
      output: tailText(combined, OUTPUT_LIMIT),
    };
  }
  if (format === "refcheck-json") {
    const verdict = evaluateRefcheckJson(stdout, res.exitCode);
    const output = verdict.passed || verdict.output !== "" ? verdict.output : tailText(stderr, OUTPUT_LIMIT);
    return { ...base, passed: verdict.passed, exitCode: res.exitCode, summary: verdict.summary, output };
  }
  const combined = [stdout, stderr].filter((s) => s.trim() !== "").join("\n--- stderr ---\n");
  const passed = res.exitCode === 0;
  return {
    ...base,
    passed,
    exitCode: res.exitCode,
    summary: passed ? "exit 0" : res.signal ? `killed by ${res.signal}` : `exit ${res.exitCode}`,
    output: tailText(combined, OUTPUT_LIMIT),
  };
}

/** Runs every configured gate in order (all of them, so a failure report is complete). */
export async function runGates(ctx: GateRunContext): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of ctx.config.gates) results.push(await runGate(gate, ctx));
  return results;
}
