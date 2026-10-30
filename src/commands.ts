import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Coordinator } from "./coordinator.js";
import { CosError } from "./errors.js";
import {
  formatCleanup,
  formatDecision,
  formatDispatch,
  formatMerge,
  formatMessage,
  formatRun,
  formatSummary,
  formatTask,
} from "./format.js";
import { renderStatusMermaid, renderStatusText } from "./status.js";
import { MESSAGE_TYPES, type MessageType } from "./types.js";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  cwd: string;
}

const OPTIONS = {
  repo: { type: "string" },
  config: { type: "string" },
  run: { type: "string" },
  task: { type: "string" },
  id: { type: "string" },
  base: { type: "string" },
  objective: { type: "string" },
  title: { type: "string" },
  spec: { type: "string" },
  after: { type: "string", multiple: true },
  acceptance: { type: "string", multiple: true },
  worker: { type: "string" },
  json: { type: "boolean" },
  concurrency: { type: "string" },
  retries: { type: "string" },
  "no-merge": { type: "boolean" },
  wait: { type: "boolean" },
  force: { type: "boolean" },
  all: { type: "boolean" },
  branches: { type: "boolean" },
  type: { type: "string" },
  body: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  dispatch: { type: "string" },
  message: { type: "string" },
  text: { type: "string" },
  question: { type: "string" },
  options: { type: "string" },
  decision: { type: "string" },
  gate: { type: "string" },
  format: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export const HELP = `cos - chief of staff: run coding-agent workers on a task DAG in git worktrees

Usage: cos <command> [options]

Runs
  run create --objective <text> [--id <id>] [--base <ref>]   create a run (repo = current directory or --repo)
  run list                                                    list runs
  run start [--run <id>] [--concurrency <n>] [--retries <n>] [--no-merge] [--wait]
                                                              dispatch every ready task until nothing is runnable
  status [--run <id>] [--format text|mermaid|json]            task DAG with statuses
Tasks
  task add --title <t> --spec <s> [--id <id>] [--after <task>]... [--acceptance <a>]... [--worker <name>] [--run <id>]
  task list [--run <id>] [--json]
  task show --task <id> [--run <id>]
  plan <file.yaml|file.json> [--run <id>] [--id <new run id>]   load a whole DAG (creates a run if the plan has an objective)
Execution
  dispatch --task <id> [--worker <name>] [--run <id>]         run one attempt of a ready task
  retry --task <id> [--worker <name>] [--run <id>]            re-dispatch a failed task with the failure in the brief
  logs --task <id> [--dispatch <id>] [--run <id>]             print a worker log
  recover [--run <id>]                                        mark dispatches whose supervisor died as orphaned
Messages
  inbox [--run <id>] [--all] [--type status|question|escalation|worker_done] [--json]
  ack <message>... | --all [--run <id>]
  send --type <type> --body <text> [--task <id>] [--to <task>] [--from <label>] [--dispatch <id>] [--run <id>]
  answer --message <id> --text <answer> [--run <id>]
Decision gates
  gate open --task <id> --question <text> [--options a,b] [--run <id>]
  gate list [--all] [--run <id>]
  gate resolve --gate <id> --decision <text> [--run <id>]
Integration
  merge --task <id> | --all [--run <id>]                      merge completed task branches into the integration branch
  cleanup [--run <id>] [--task <id>] [--force] [--branches]   remove worktrees (never with uncommitted changes unless --force)

Global options: --repo <path> (default: current directory), --config <path> (default: cos.config.json), --json, --help, --version
Exit codes: 0 success, 1 work did not complete (failed/blocked/conflict), 2 usage or internal error`;

function need(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") throw new CosError(`missing ${flag}`);
  return value;
}

function intOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new CosError(`${flag} must be a non-negative integer`);
  return n;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    io.err(`cos: ${(err as Error).message}`);
    io.err('run "cos --help" for usage');
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.help || positionals[0] === "help" || (argv.length === 0)) {
    io.out(HELP);
    return 0;
  }
  if (v.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    io.out(pkg.version);
    return 0;
  }

  try {
    const cos = new Coordinator({
      repo: v.repo ?? io.cwd,
      config: v.config,
      log: (m) => io.out(`  ${m}`),
    });
    const [command, sub, ...rest] = positionals;
    const json = v.json === true;
    const printJson = (value: unknown): void => io.out(JSON.stringify(value, null, 2));

    const runOf = (): string => cos.resolveRun(v.run);
    const taskRef = (): { runId: string; taskId: string } => {
      const r = cos.resolveTask(need(v.task, "--task"), v.run);
      return { runId: r.runId, taskId: r.task.id };
    };
    // Every command first notices dispatches whose supervisor died (crash, kill -9, reboot).
    const autoRecovered = command === "run" && sub === "create" ? [] : cos.recover(v.run);
    if (command !== "recover") {
      for (const d of autoRecovered) io.err(`cos: dispatch ${d.id} (task ${d.taskId}) was orphaned by a dead supervisor; task marked failed`);
    }

    switch (command) {
      case "run": {
        if (sub === "create") {
          const run = cos.createRun({ objective: need(v.objective, "--objective"), id: v.id, base: v.base });
          if (json) printJson(run);
          else {
            io.out(`created run ${run.id}`);
            io.out(`  base ${run.baseRef}@${run.baseCommit.slice(0, 7)}, integration branch ${run.integrationBranch}`);
            io.out(`  state: ${path.relative(cos.repoRoot, cos.stateDir)}/`);
          }
          return 0;
        }
        if (sub === "list") {
          const runs = cos.listRuns();
          if (json) printJson(runs);
          else if (runs.length === 0) io.out("no runs");
          else for (const r of runs) io.out(formatRun(r));
          return 0;
        }
        if (sub === "start") {
          const summary = await cos.start(runOf(), {
            concurrency: intOption(v.concurrency, "--concurrency"),
            retries: intOption(v.retries, "--retries"),
            merge: v["no-merge"] !== true,
            wait: v.wait === true,
          });
          if (json) printJson(summary);
          else io.out(formatSummary(summary));
          return summary.complete ? 0 : 1;
        }
        throw new CosError('usage: cos run create|list|start');
      }

      case "task": {
        if (sub === "add") {
          const task = cos.addTask(runOf(), {
            id: v.id,
            title: need(v.title, "--title"),
            spec: need(v.spec, "--spec"),
            after: v.after,
            acceptance: v.acceptance,
            worker: v.worker,
          });
          if (json) printJson(task);
          else io.out(`added task ${task.id} [${task.status}]${task.after.length > 0 ? ` after ${task.after.join(", ")}` : ""}`);
          return 0;
        }
        if (sub === "list") {
          const tasks = cos.listTasks(runOf());
          if (json) printJson(tasks);
          else if (tasks.length === 0) io.out("no tasks");
          else for (const t of tasks) io.out(`${t.id}  ${t.status.padEnd(10)}  ${t.title}${t.after.length > 0 ? `  (after ${t.after.join(", ")})` : ""}`);
          return 0;
        }
        if (sub === "show") {
          const { runId, taskId } = taskRef();
          const task = cos.listTasks(runId).find((t) => t.id === taskId);
          if (!task) throw new CosError(`unknown task "${taskId}"`);
          const dispatches = cos.dispatches(runId, taskId);
          if (json) printJson({ task, dispatches });
          else io.out(formatTask(task, dispatches));
          return 0;
        }
        throw new CosError("usage: cos task add|list|show");
      }

      case "plan": {
        const file = sub;
        if (!file) throw new CosError("usage: cos plan <file.yaml|file.json> [--run <id>]");
        const res = cos.loadPlan(path.resolve(io.cwd, file), { runId: v.run, newRunId: v.id, base: v.base });
        if (json) printJson(res);
        else {
          if (res.created) io.out(`created run ${res.run.id} (integration branch ${res.run.integrationBranch})`);
          io.out(`loaded ${res.tasks.length} task(s) into run ${res.run.id}`);
        }
        return 0;
      }

      case "dispatch":
      case "retry": {
        const { runId, taskId } = taskRef();
        const d = await (command === "dispatch" ? cos.dispatch(runId, taskId, { worker: v.worker }) : cos.retry(runId, taskId, { worker: v.worker }));
        if (json) printJson(d);
        else io.out(formatDispatch(d));
        return d.status === "passed" ? 0 : 1;
      }

      case "logs": {
        const { runId, taskId } = taskRef();
        const list = cos.dispatches(runId, taskId);
        const d = v.dispatch ? list.find((x) => x.id === v.dispatch) : list[list.length - 1];
        if (!d?.logPath) throw new CosError(`no worker log for task "${taskId}"`);
        io.out(fs.existsSync(d.logPath) ? fs.readFileSync(d.logPath, "utf8").trimEnd() : "(log is empty)");
        return 0;
      }

      case "recover": {
        const recovered = autoRecovered;
        if (json) printJson(recovered);
        else if (recovered.length === 0) io.out("no orphaned dispatches");
        else for (const d of recovered) io.out(`orphaned ${d.id} (task ${d.taskId}): ${d.failure}`);
        return 0;
      }

      case "inbox": {
        const type = v.type as MessageType | undefined;
        if (type && !MESSAGE_TYPES.includes(type)) throw new CosError(`--type must be one of: ${MESSAGE_TYPES.join(", ")}`);
        const messages = cos.inbox({ runId: runOf(), all: v.all === true, type });
        if (json) printJson(messages);
        else if (messages.length === 0) io.out("inbox is empty");
        else for (const m of messages) io.out(formatMessage(m));
        return 0;
      }

      case "ack": {
        const ids = [sub, ...rest].filter((x): x is string => x !== undefined);
        if (ids.length === 0 && !v.all) throw new CosError("usage: cos ack <message>... | --all");
        const acked = cos.ack(runOf(), v.all ? "all" : ids);
        io.out(acked.length > 0 ? `acknowledged ${acked.join(", ")}` : "nothing to acknowledge");
        return 0;
      }

      case "send": {
        const type = (v.type ?? "status") as MessageType;
        const m = cos.send({
          runId: runOf(),
          type,
          body: need(v.body, "--body"),
          from: v.from,
          to: v.to,
          taskId: v.task,
          dispatchId: v.dispatch ?? process.env.COS_DISPATCH,
        });
        if (json) printJson(m);
        else io.out(`sent ${m.id} (${m.type}) to ${m.to}`);
        return 0;
      }

      case "answer": {
        const m = cos.answer(runOf(), need(v.message, "--message"), need(v.text, "--text"));
        io.out(`answered ${m.id}${m.taskId ? `; task ${m.taskId} can continue` : ""}`);
        return 0;
      }

      case "gate": {
        if (sub === "open") {
          const { runId, taskId } = taskRef();
          const options = v.options ? v.options.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
          const g = cos.openGate(runId, taskId, need(v.question, "--question"), options);
          io.out(`opened decision gate ${g.id}; task ${taskId} is blocked until "cos gate resolve --gate ${g.id} --decision <text>"`);
          return 0;
        }
        if (sub === "list") {
          const gates = cos.gates(runOf(), v.all === true);
          if (json) printJson(gates);
          else if (gates.length === 0) io.out("no open decision gates");
          else for (const g of gates) io.out(formatDecision(g));
          return 0;
        }
        if (sub === "resolve") {
          const g = cos.resolveGate(runOf(), need(v.gate, "--gate"), need(v.decision, "--decision"));
          io.out(`resolved ${g.id}: ${g.decision}`);
          return 0;
        }
        throw new CosError("usage: cos gate open|list|resolve");
      }

      case "merge": {
        if (v.all) {
          const results = await cos.mergeAll(runOf());
          if (json) printJson(results);
          else if (results.length === 0) io.out("nothing to merge");
          else for (const r of results) io.out(formatMerge(r));
          return results.every((r) => r.merged) ? 0 : 1;
        }
        const { runId, taskId } = taskRef();
        const r = await cos.merge(runId, taskId);
        if (json) printJson(r);
        else io.out(formatMerge(r));
        return r.merged ? 0 : 1;
      }

      case "status": {
        const report = cos.status(runOf());
        const format = json ? "json" : (v.format ?? "text");
        if (format === "json") printJson(report);
        else if (format === "mermaid") io.out(renderStatusMermaid(report));
        else if (format === "text") io.out(renderStatusText(report));
        else throw new CosError("--format must be text, mermaid or json");
        return 0;
      }

      case "cleanup": {
        const entries = cos.cleanup({
          runId: v.run,
          taskId: v.task,
          force: v.force === true,
          branches: v.branches === true,
        });
        if (json) printJson(entries);
        else io.out(formatCleanup(entries));
        return entries.some((e) => e.action === "skipped") ? 1 : 0;
      }

      default:
        throw new CosError(`unknown command "${command ?? ""}"; run "cos --help"`);
    }
  } catch (err) {
    if (err instanceof CosError) {
      io.err(`cos: ${err.message}`);
    } else {
      io.err(`cos: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    return 2;
  }
}
