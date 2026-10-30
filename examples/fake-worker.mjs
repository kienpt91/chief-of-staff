#!/usr/bin/env node
// A deterministic stand-in for a real coding agent, used by the demo and the test suite.
// DEMO ONLY: it executes the directives found in task specs, so only feed it plans you wrote yourself.
//
// Usage: node fake-worker.mjs <briefPath>
//
// It reads the brief, makes a deterministic edit, commits it and writes .cos/result.json.
// Behaviour is steered by directive lines inside the task specification, one per line:
//
//   fake.write: <path> = <content>        write a file ("\n" in content becomes a newline)
//   fake.fix-on-retry: <path> = <content> like fake.write, but only when the brief reports a failed earlier attempt
//   fake.fail[: <message>]                exit 1
//   fake.fail-until-attempt: <n>          exit 1 while the attempt number is below n
//   fake.result-failure[: <message>]      exit 0 but report outcome "failure" in result.json
//   fake.ask: <question>                  write .cos/question.json and exit 0, unless the brief already has an answer
//   fake.ask-wait: <question>             write .cos/question.json and wait for .cos/answer.json
//   fake.sleep: <seconds>                 sleep before working
//   fake.hang                             sleep for an hour (to exercise timeouts)
//   fake.spawn-child                      start a long-lived child process, pid in .cos/child.pid
//   fake.heartbeat                        touch .cos/heartbeat once at start
//   fake.dump-env: <path>                 write the names of the environment variables to <path>
//   fake.no-commit                        leave the edit uncommitted
//   fake.resolve-conflicts: <ours|theirs>  on a merge-conflict retry, merge the integration branch with -X <strategy>
//   fake.no-result                        do not write .cos/result.json

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const briefPath = process.argv[2] ?? process.env.COS_BRIEF;
if (!briefPath) {
  console.error("usage: fake-worker.mjs <briefPath>");
  process.exit(64);
}
const brief = fs.readFileSync(briefPath, "utf8");
const cosDir = path.dirname(path.resolve(briefPath));
const worktree = process.env.COS_WORKTREE ?? process.cwd();

function section(heading) {
  const lines = brief.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return "";
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

const title = (brief.match(/^# Task brief: (.*)$/m) ?? [])[1] ?? "untitled";
const taskId = process.env.COS_TASK ?? (brief.match(/task `([^`]+)`/) ?? [])[1] ?? "task";
const attempt = Number((brief.match(/\(attempt (\d+)\)/) ?? [])[1] ?? 1);
const spec = section("## Task specification");
const isRetry = brief.includes("\n## Previous attempt failed\n");

const directives = [];
for (const line of spec.split("\n")) {
  const m = line.match(/^\s*fake\.([a-z-]+)(?:\s*:\s*(.*))?$/);
  if (m) directives.push({ name: m[1], value: (m[2] ?? "").trim() });
}
const all = (name) => directives.filter((d) => d.name === name);
const first = (name) => all(name)[0];

const answers = [];
const answerLines = section("## Answers to your earlier questions").split("\n");
for (let i = 0; i < answerLines.length; i++) {
  const q = answerLines[i].match(/^- Q: (.*)$/);
  const a = (answerLines[i + 1] ?? "").match(/^\s+A: (.*)$/);
  if (q && a) answers.push({ question: q[1], answer: a[1] });
}
const decisions = [];
const decisionLines = section("## Decisions made by the coordinator").split("\n");
for (let i = 0; i < decisionLines.length; i++) {
  const q = decisionLines[i].match(/^- (.*)$/);
  const d = (decisionLines[i + 1] ?? "").match(/^\s+Decision: (.*)$/);
  if (q && d) decisions.push({ question: q[1], decision: d[1] });
}

function writeFile(rel, content) {
  // Demo-only worker, but still refuse to write outside the worktree (absolute paths, "..", symlink escapes).
  const root = fs.realpathSync(worktree);
  const target = path.resolve(root, rel);
  const relative = path.relative(root, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    console.error(`fake-worker: refusing to write outside the worktree: ${rel}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const dirReal = fs.realpathSync(path.dirname(target));
  if (dirReal !== root && !dirReal.startsWith(root + path.sep)) {
    console.error(`fake-worker: refusing to write through a symlink out of the worktree: ${rel}`);
    process.exit(1);
  }
  fs.writeFileSync(target, `${content.replace(/\\n/g, "\n")}\n`);
}

function parseWrite(value) {
  const i = value.indexOf("=");
  if (i < 0) throw new Error(`bad directive value (expected "path = content"): ${value}`);
  return { rel: value.slice(0, i).trim(), content: value.slice(i + 1).trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeResult(outcome, summary, filesModified = []) {
  if (first("no-result")) return;
  fs.writeFileSync(path.join(cosDir, "result.json"), `${JSON.stringify({ outcome, summary, filesModified }, null, 2)}\n`);
}

if (first("heartbeat")) fs.writeFileSync(path.join(cosDir, "heartbeat"), String(Date.now()));

if (first("spawn-child")) {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  fs.writeFileSync(path.join(cosDir, "child.pid"), String(child.pid));
}

const dump = first("dump-env");
if (dump) writeFile(dump.value, Object.keys(process.env).sort().join("\n"));

for (const kind of ["ask", "ask-wait"]) {
  const d = first(kind);
  if (!d) continue;
  const answered = answers.find((a) => a.question === d.value);
  if (answered) continue;
  fs.writeFileSync(path.join(cosDir, "question.json"), `${JSON.stringify({ question: d.value })}\n`);
  if (kind === "ask") {
    console.log(`fake-worker: asked "${d.value}" and exiting to wait for the answer`);
    process.exit(0);
  }
  const answerFile = path.join(cosDir, "answer.json");
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(answerFile)) {
    if (Date.now() > deadline) {
      console.error("fake-worker: no answer within 60s");
      process.exit(1);
    }
    await sleep(100);
  }
  const got = JSON.parse(fs.readFileSync(answerFile, "utf8"));
  answers.push({ question: d.value, answer: got.answer });
}

const sleepFor = first("sleep");
if (sleepFor) await sleep(Number(sleepFor.value) * 1000);
if (first("hang")) await sleep(3_600_000);

const failMsg = first("fail");
if (failMsg) {
  console.error(`fake-worker: ${failMsg.value || "failing on request"}`);
  process.exit(1);
}
const failUntil = first("fail-until-attempt");
if (failUntil && attempt < Number(failUntil.value)) {
  console.error(`fake-worker: attempt ${attempt} fails (succeeds from attempt ${failUntil.value})`);
  process.exit(1);
}

// A brief with a "Merge conflict" section names the branch to merge; resolve with the requested strategy.
const resolve = first("resolve-conflicts");
const mergeTarget = (brief.match(/^Run `git merge ([^`]+)`/m) ?? [])[1];
if (resolve && mergeTarget) {
  const m = spawnSync(
    "git",
    ["-c", "user.name=fake-worker", "-c", "user.email=fake-worker@localhost", "merge", "--no-edit", "-X", resolve.value, mergeTarget],
    { cwd: worktree, encoding: "utf8" },
  );
  if (m.status !== 0) {
    console.error(`fake-worker: git merge failed: ${m.stderr || m.stdout}`);
    process.exit(1);
  }
}

const modified = [];
const body = [`task ${taskId}: ${title}`];
for (const a of answers) body.push(`answer: ${a.question} -> ${a.answer}`);
for (const d of decisions) body.push(`decision: ${d.question} -> ${d.decision}`);
const defaultFile = `fake-output/${taskId}.txt`;
writeFile(defaultFile, body.join("\n"));
modified.push(defaultFile);

for (const d of all("write")) {
  const { rel, content } = parseWrite(d.value);
  writeFile(rel, content);
  modified.push(rel);
}
if (isRetry) {
  for (const d of all("fix-on-retry")) {
    const { rel, content } = parseWrite(d.value);
    writeFile(rel, content);
    modified.push(rel);
  }
}

if (!first("no-commit")) {
  const run = (args) => spawnSync("git", args, { cwd: worktree, encoding: "utf8" });
  run(["add", "-A"]);
  if (run(["status", "--porcelain"]).stdout.trim() !== "") {
    const c = run(["-c", "user.name=fake-worker", "-c", "user.email=fake-worker@localhost", "commit", "-m", `fake-worker: ${title}`]);
    if (c.status !== 0) {
      console.error(`fake-worker: git commit failed: ${c.stderr || c.stdout}`);
      process.exit(1);
    }
  }
}

const resultFailure = first("result-failure");
if (resultFailure) {
  writeResult("failure", resultFailure.value || "reported failure", modified);
  process.exit(0);
}
writeResult("success", `${title} (${modified.length} file(s))`, modified);
console.log(`fake-worker: finished ${taskId} (attempt ${attempt})`);
