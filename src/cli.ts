#!/usr/bin/env node
import { runCli } from "./commands.js";
import { terminateActiveProcesses } from "./process.js";

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    terminateActiveProcesses();
    process.stderr.write(`\ncos: ${signal} received; running workers were killed. Run "cos recover" or any other command to mark interrupted dispatches.\n`);
    process.exit(130);
  });
}

const code = await runCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  cwd: process.cwd(),
});
process.exitCode = code;
