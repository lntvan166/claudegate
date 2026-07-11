# ClaudeGate CI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the minimal single-job CI with a 3-OS test matrix (adding the missing lint step) plus a Linux-only packaging smoke test, so every PR/push is verified across platforms before reaching 5k+ users.

**Architecture:** One `.github/workflows/ci.yml` file, two jobs. Job `test` runs the full lint/typecheck/compile/test cycle on ubuntu + macos + windows. Job `package` runs only after all test legs pass (`needs: test`), dry-run-packages the `.vsix` on Linux, and uploads it as an artifact. CI never publishes — publishing stays human-gated via the `release` skill.

**Tech Stack:** GitHub Actions, Node 20 (esbuild bundling), Python 3.11 (hook unittest), `@vscode/vsce` (packaging via `npx`).

## Global Constraints

- CI **never** runs `vsce publish` / `ovsx publish` — publishing is human-gated via the `release` skill (verbatim from spec / CLAUDE.md).
- No changes to `package.json`, source, or test files — all referenced npm scripts (`lint`, `typecheck`, `compile`, `test`) already exist.
- `vsce` is invoked via `npx --yes @vscode/vsce`, never added to `devDependencies` (matches existing project convention).
- Only file touched: `.github/workflows/ci.yml` (rewritten).
- Spec: `docs/superpowers/specs/2026-07-12-ci-design.md`.

---

### Task 1: Pre-flight — confirm the exact CI commands pass locally

Before changing CI, prove the four commands the matrix will run actually succeed on this machine. `lint` has **never run in CI**, so it may currently fail — if it does, that is a real finding to surface to the maintainer, not something to silently "fix" as part of this task.

**Files:**
- Modify: none (verification only)

**Interfaces:**
- Consumes: existing `package.json` scripts `lint`, `typecheck`, `compile`, `test`.
- Produces: confidence that the CI step list is correct; a known-good local baseline.

- [ ] **Step 1: Ensure a clean dependency install**

Run: `npm ci`
Expected: completes without error, `node_modules/` populated.

- [ ] **Step 2: Run lint (the step CI is missing today)**

Run: `npm run lint`
Expected: exit 0, no errors.
If it FAILS: stop and report the lint errors to the maintainer. Do **not** edit source to make lint pass as part of this CI task — that is separate work. The maintainer decides whether to fix lint first or temporarily drop the lint step.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exit 0, no output.

- [ ] **Step 4: Run compile**

Run: `npm run compile`
Expected: exit 0, produces `out/extension.js`.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: exit 0; TS unit tests print `ok - …` lines and the Python hook tests report `OK`.

- [ ] **Step 6: Run the packaging command locally**

Run: `npx --yes @vscode/vsce package --no-dependencies -o /tmp/claudegate-ci-test.vsix`
Expected: exit 0, prints `Packaged: …claudegate-ci-test.vsix`. Confirms the exact command the `package` job will use works and the `.vscodeignore` is valid. (No commit — this is a throwaway artifact in `/tmp`.)

---

### Task 2: Rewrite `.github/workflows/ci.yml`

**Files:**
- Modify (full rewrite): `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the npm scripts verified in Task 1.
- Produces: two GitHub Actions jobs, `test` (matrix) and `package` (needs: test).

- [ ] **Step 1: Replace the file contents**

Write `.github/workflows/ci.yml` with exactly:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run compile
      - run: npm test

  package:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npx --yes @vscode/vsce package --no-dependencies -o claudegate.vsix
      - uses: actions/upload-artifact@v4
        with:
          name: claudegate-vsix
          path: claudegate.vsix
```

- [ ] **Step 2: Validate the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"`
Expected: prints `yaml ok`. (If PyYAML is missing, instead run `npx --yes js-yaml .github/workflows/ci.yml >/dev/null && echo 'yaml ok'`.)

- [ ] **Step 3: Confirm every referenced npm script exists**

Run: `node -e "const s=require('./package.json').scripts; ['lint','typecheck','compile','test'].forEach(k=>{if(!s[k]){console.error('MISSING script:',k);process.exit(1)}}); console.log('all scripts present')"`
Expected: prints `all scripts present`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: 3-OS test matrix + packaging smoke test

- add lint step (was defined but never run in CI)
- run tests on ubuntu/macos/windows (fail-fast: false)
- npm cache on setup-node
- new package job (needs: test) dry-runs vsce package + uploads .vsix
- add workflow_dispatch trigger; publishing stays manual

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Push and observe the real CI run

There is no local GitHub Actions runner (`act` is not installed), so the authoritative verification is the actual run. This task pushes to a branch and watches CI end-to-end.

**Files:**
- Modify: none (observation only)

**Interfaces:**
- Consumes: the committed workflow from Task 2.
- Produces: a green CI run (or concrete failures to remediate).

- [ ] **Step 1: Push the branch**

If the commits are on `main`, they can be pushed directly; otherwise push the working branch. Run: `git push origin HEAD`
Expected: push succeeds.

- [ ] **Step 2: Watch the run to completion**

Run: `gh run watch $(gh run list --workflow=ci.yml --limit=1 --json databaseId --jq '.[0].databaseId') --exit-status`
Expected: exits 0 when all jobs (`test (ubuntu-latest)`, `test (macos-latest)`, `test (windows-latest)`, `package`) succeed. Non-zero means at least one leg failed.

- [ ] **Step 3: WATCH ITEM — Windows `python3`**

The `test:hook` script hardcodes `python3 -m unittest`. On Windows runners `python3` is not always on PATH (only `python`). `actions/setup-python@v5` installs a `python3` shim on Windows, so this is expected to work — but the `test (windows-latest)` leg is the first thing to check if the run fails.
Remediation if Windows fails on `python3: command not found`: report to maintainer with two options — (a) add a Windows-only step `- if: runner.os == 'Windows'` that aliases/symlinks `python3` to `python`, or (b) change `test:hook` in `package.json` to use `python` (a `package.json` change, out of this plan's scope, so maintainer decides).

- [ ] **Step 4: WATCH ITEM — `&&` chaining under pwsh**

`test:unit` chains ~13 esbuild+node invocations with `&&`. The default Windows `run:` shell is `pwsh` (PowerShell 7), which supports `&&`, so this is expected to pass. If the `test (windows-latest)` leg fails with a parser/`&&` error, report to maintainer (remediation would be a `package.json` script change, out of scope here).

- [ ] **Step 5: Confirm the artifact and the gate**

On a green run, verify:
- The `package` job produced a downloadable `claudegate-vsix` artifact: `gh run view <run-id>` lists it under Artifacts.
- The `package` job started only after all three `test` legs passed (visible in the run graph / `gh run view`).

- [ ] **Step 6: Report result**

Summarize to the maintainer: which legs passed, artifact link, and any watch-item remediation needed. Note the follow-up (not done in this plan): enabling branch protection in GitHub Settings → Branches → require the `test` and `package` status checks for `main`.

---

## Self-Review

**Spec coverage:**
- Triggers (push/PR/workflow_dispatch) → Task 2 Step 1. ✓
- `test` matrix 3-OS + lint/typecheck/compile/test + fail-fast:false + npm cache + Python 3.11 → Task 2 Step 1. ✓
- `package` job Linux-only, needs: test, vsce package --no-dependencies, upload artifact → Task 2 Step 1. ✓
- No auto-publish → Global Constraints + workflow contains no publish step. ✓
- Branch protection documented as manual follow-up → Task 3 Step 6. ✓
- No Node 18 / coverage / version checks → not present; correct. ✓
- Only `.github/workflows/ci.yml` touched → Task 2. ✓
- Success criteria (lint/type/test/hook failures fail CI; packaging failure fails package job; green run yields .vsix; package gated on test; never publishes) → covered by Task 1 (local proof) + Task 3 (real run). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code/command step shows the exact command. ✓

**Type consistency:** No code types in this plan (YAML + shell). Job names (`test`, `package`), artifact name (`claudegate-vsix`), and `.vsix` filename (`claudegate.vsix`) are used consistently across Task 2 and Task 3. ✓
