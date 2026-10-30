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

## Reporting a vulnerability in chief-of-staff itself

Open a private security advisory on the GitHub repository (Security tab, "Report a vulnerability").

## Trust model of the tool

`cos` runs commands you configure (workers and quality gates) on your machine with your user's permissions.
Workers get an allowlisted environment, but they are not sandboxed: a worker can read and write anything your
user can. Only configure commands you trust, and review the task specs you feed them.
