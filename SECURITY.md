# Security notes

## Dependency policy

Every dependency version in `package-lock.json` (direct and transitive) was published on or before
2026-09-30, i.e. at least 30 days before this release. Installs are done with
`npm install --before=2026-09-30T00:00:00Z`, and direct dependencies are pinned to exact versions.
When a fix exists only in a newer version it is not taken; the advisory is listed below instead.

The package that ships to users has a single runtime dependency: `yaml`. Everything below is a
development dependency (test runner and its toolchain) and is not part of the published package
(`files` in `package.json` contains only `dist`, `examples`, `README.md`, `LICENSE`).

## Open advisories (all in development dependencies, as reported by `npm audit` on 2026-10-30)

| Package (locked) | Advisory | Fixed in | Why it is not fixed here |
| --- | --- | --- | --- |
| `vite@7.3.6` | GHSA-9jrq-w75r-8gcw, GHSA-rq7h-c2jc-7f22 (dev server) and the three `launch-editor` advisories GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm | `vite@7.3.7` (published 2026-10-06) | newer than the 30 day cutoff |
| `postcss` -> `source-map-js@1.2.1` | GHSA-68fv-2mgg-jv7q | `source-map-js@1.2.2` (published 2026-09-30T14:08Z) | newer than the cutoff |
| `vitest@3.2.7`, `@vitest/mocker@3.2.7` | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | `vitest@4.1.12` (2026-10-15) or `5.x` | newer than the cutoff, and a major upgrade; this project pins vitest 3 |
| `tinypool@1.1.1` (via vitest) | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | `tinypool@2.1.2` (2026-08-23) | vitest 3 depends on tinypool 1.x; 2.x needs the vitest major upgrade above |

## Reachability

- None of these packages is imported by `chief-of-staff` at runtime or included in the published tarball.
- The vite advisories concern the vite dev server and the `launch-editor` helper. `vitest run` does not
  start a dev server, and the test suite does not use browser mode or `launch-editor`.
- The vitest/`@vitest/mocker` advisories need an attacker who can register mocks or reach the vitest
  API server; the tests here only run local code in a local process and do not start the vitest UI/API server.
- The tinypool and source-map-js issues require attacker-controlled worker options or source maps; the
  tests pass neither.
- Risk remains for contributors who run `vitest` against untrusted code; do not do that.

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
