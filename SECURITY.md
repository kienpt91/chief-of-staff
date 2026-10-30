# Security notes

## Dependency policy

Every dependency version in `package-lock.json` (direct and transitive) was published on or before
2026-10-23, i.e. at least 7 days before this update. Installs are done with
`npm install --before=2026-10-23T00:00:00Z --ignore-scripts --save-exact`, and direct dependencies are pinned to exact versions.
When a fix exists only in a newer version it is not taken; the advisory is listed below instead.

Installs, tests, typechecks and builds are run inside a throwaway container (non-root, capabilities dropped,
`node_modules` in a volume), never with the host's npm/node, and always with `--ignore-scripts` (CI uses
`npm ci --ignore-scripts`). No dependency needs its install scripts: `esbuild` (via `tsx`) ships its
platform binary as an optional package and `fsevents` is macOS-only and optional. GitHub Actions are pinned to
full commit SHAs of releases published on or before the cutoff. Dependabot is configured with a 7 day cooldown.

The package that ships to users has a single runtime dependency: `yaml`. Everything else is a
development dependency (test runner and its toolchain) and is not part of the published package
(`files` in `package.json` contains only `dist`, `examples`, `README.md`, `LICENSE`).

## Open advisories

None: `npm audit` and `npm audit --omit=dev` report 0 vulnerabilities for the current lockfile (2026-10-30).
The previously listed vite, `launch-editor`, `source-map-js`, vitest, `@vitest/mocker` and `tinypool` advisories
are fixed by the move to `vitest@4.1.12` (with `vite@8.3.5`, `source-map-js@1.2.2`; `tinypool` is no longer a dependency).
`vitest@5` was not taken because it requires Node 22 or newer and this package supports Node 20.

## Hardening done after a security review

A read-only review of the code found the issues below; the behaviour described is covered by tests in `test/security.test.ts`.

| Finding | Status |
| --- | --- |
| `cos`'s own git calls ran with the full environment inside worker-writable repos (hooks, `core.fsmonitor`, filters, merge drivers, `core.sshCommand` could run planted commands with the coordinator's secrets) | Fixed. Git runs with the worker allowlist only, with hooks/fsmonitor/pager/editor/ssh/credential helpers/signing disabled on the command line, filters, textconv, merge drivers, per-command pagers and signing programs found in the repo config overridden, and `commit --no-verify`. Residual: a driver planted by a concurrently running worker between the config listing and the git command is not overridden (it still gets only the allowlisted environment). |
| Worker-controlled `question.json` / `result.json` / gate logs read without type or size checks (FIFO hang, memory exhaustion) | Fixed. Regular non-symlink files only, opened `O_NOFOLLOW|O_NONBLOCK`, size-capped (`limits.*`), stored text clipped, gate logs read tail-only, workers and gates killed past `limits.outputBytes`. |
| `.cos` replaced by a symlink redirects coordinator writes and escapes the ignore rule | Fixed. `.cos` (and `.cos/inbox`, `.cos/history`) are forced to be real directories before writes; reads refuse a non-real `.cos`; exclude pattern is `.cos` without a trailing slash. |
| Racy lock stealing, live owners stolen from by age, unconditional release | Fixed. Locks are taken over only from dead owners, by renaming the directory away first; release checks the owner token. A narrow window remains if a lock is re-created between the staleness check and the rename; the code puts it back when it can detect that. |
| Recovery signals `-pid` from a state file; unknown start time counted as a match | Fixed. Pid must be an integer > 1; a recorded matching start time and process group leadership are required, otherwise nothing is signalled and a warning is recorded. |
| `refcheck-json` gate passes when the tool was killed by a signal or when findings contradict `summary.errors` | Fixed. Both fail the gate. Still true: gates run on the tree the worker edited, so a worker can influence a gate; this is documented, not prevented. |
| Shell-mode commands expanded placeholders unquoted | Fixed. Each substituted value is single-quoted. Behaviour change: do not add your own quotes around placeholders in shell mode. |
| Worker names looked up on a plain object (`constructor`, `__proto__`) | Fixed. `Object.hasOwn`, name pattern, reserved names rejected. |
| Example worker wrote to paths from task specs without containment | Fixed (contained to the worktree) and labelled demo-only. |
| Ids from the command line used in state paths; base ref starting with `-` passed to git | Fixed. Ids are validated before any path is built; refs starting with `-` are rejected. |
| `cleanup --branches --force` deleted unmerged branches; cleanup followed symlinked worktree paths | Fixed. Only branches already merged into the integration branch are deleted; a symlinked worktree path is refused. |
| Config read from the repository on every dispatch executes whatever it names | Partly addressed. A note is printed when `cos.config.json` is tracked by git. There is no trust prompt or signature: treat the file as code. |
| README/SECURITY claims broader than the code | Fixed. See the Security model section of the README. |

Known gaps that are by design: workers are not sandboxed (they can read `HOME`, write the shared `.git` and `.git/cos`), state files are not tamper-proof, and there is no authentication.

## Reporting a vulnerability in chief-of-staff itself

Open a private security advisory on the GitHub repository (Security tab, "Report a vulnerability").

## Trust model of the tool

`cos` runs commands you configure (workers and quality gates) on your machine with your user's permissions.
Workers, gates and cos's own git processes get an allowlisted environment (environment variables only), but nothing is sandboxed: a worker can read and write anything your
user can, including files under HOME and the repository's shared .git directory. Only configure commands you trust, and review the task specs you feed them.
