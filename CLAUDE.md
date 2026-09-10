# CLAUDE.md — ClaudeGate Developer Guide

## What This Project Does

ClaudeGate is a VS Code/Cursor extension that captures file changes made by Claude Code and presents them in a structured review panel. The user can accept or reject each change using VS Code's native diff editor.

Two detection paths are supported:
- **PreToolUse hook (authoritative for all Claude Code).** The `~/.claude/settings.json` `PreToolUse` hook fires before every Claude write — for **both** the terminal CLI **and** the in-editor Claude Code extension (confirmed: both run the same hook, so a GUI edit is captured with correct original content and the in-editor session's `session_id`). This is the primary, attributed capture path. The registered matcher is `PRE_TOOL_MATCHER` in `src/hookInstaller.ts` — `^(Write|Edit|MultiEdit|Bash)$`. `Bash` is in it because Claude also rewrites files through the shell (`sed -i`, `cat > f <<EOF`, a `python3` heredoc); `hook.py` extracts the target paths from `tool_input.command` and runs them through the same capture pipeline.
- **DocumentTracker (non-Claude fallback, off by default).** The filesystem watcher exists only to capture **non-Claude** agents (Cursor Composer, Codex) that don't run Claude's hooks; it cannot attribute edits, so it is disabled unless `claudegate.fileWatcher.enabled` is set.

---

## Architecture

```
Claude Code (terminal CLI)   Claude Code (in-editor ext)      Non-Claude agents
         │                            │                       (Cursor, Codex)
         └──────── PreToolUse hook ───┘                             │
              hook.py snapshots the original            DocumentTracker (opt-in,
                          │                              off by default) FS watch
                          │                                         │
                          └──────────────────┬──────────────────────┘
                                             ▼
                          ~/.claudegate/sessions/<workspace>.json
                                             │
                                    Claude Gate review panels
```

---

## Key Files

| File | Responsibility |
|---|---|
| `src/extension.ts` | Activation, command registration, status bar |
| `src/sessionManager.ts` | Read/write session JSON, file watcher, accept/reject/clear logic |
| `src/documentTracker.ts` | GUI extension support — snapshots docs, detects FS changes |
| `src/reviewPanel.ts` | `vscode.TreeDataProvider` for the three sidebar panels |
| `src/diffProvider.ts` | `TextDocumentContentProvider` for `claudegate:` URIs; `openDiff` helper |
| `src/decorationProvider.ts` | File explorer badge (`!`) for pending files |
| `src/hookInstaller.ts` | Installs `hook.py` + `hook.sh`, patches `~/.claude/settings.json` |
| `hooks/hook.py` | Python hook script — copied to `~/.claudegate/hook.py` at setup |

---

## Session State Schema

Per-workspace session file at `~/.claudegate/sessions/<md5(workspacePath)>.json`:

```json
{
  "sessionId": "2026-05-31T10:00:00.000000+00:00",
  "status": "active | reviewed",
  "files": {
    "/absolute/path/to/file.ts": {
      "originalContent": "string | null",
      "reviewStatus": "pending",
      "sessionId": "string",
      "capturedAt": "ISO 8601 timestamp"
    }
  },
  "accepted": [
    {
      "id": "<decidedAt>::<path>",
      "path": "/absolute/path/to/file.ts",
      "before": "string | null",
      "after": "string | null",
      "decidedAt": "ISO 8601 timestamp",
      "sessionId": "string"
    }
  ],
  "rejected": {
    "/absolute/path/to/file.ts": {
      "id": "<decidedAt>::<path>",
      "path": "/absolute/path/to/file.ts",
      "before": "string | null",
      "after": "string | null",
      "decidedAt": "ISO 8601 timestamp",
      "sessionId": "string"
    }
  }
}
```

**Files (pending-only):**
- `files` contains only entries with `reviewStatus: "pending"` — unreviewed changes awaiting user decision.
- `originalContent: null` — Claude created this file (didn't exist before). Rejecting deletes the file.
- `originalContent` is the frozen "before" baseline. It is **not** advanced on accept; the next edit (via `hook.py`) re-snapshots the current on-disk content, so re-editing an accepted file appends a new pending entry with the new baseline.
- The entry is removed from `files` when it is accepted (appended to `accepted[]`) or rejected (stored in `rejected{}`).

**Accepted (persistent log):**
- `accepted` is an append-only array of every file the user has approved, with the before/after diffs that were accepted.
- Reversible: `revertAccepted(id)` removes the entry from `accepted[]` and re-adds it to `files` as pending (the frozen `before` becomes the new baseline).

**Rejected (latest per file):**
- `rejected` is a map of `path → ReviewRecord`, storing only the latest rejected change per file.
- Reapplicable: `reapplyRejected(path)` copies the `rejected[path]` entry back to `files` as pending with its frozen `before` baseline.

**Session lifecycle:**
- `status: active` — session has pending files.
- `status: reviewed` — set automatically when `files` is empty.
- The workspace hash is `MD5(path.resolve(workspacePath))` (lowercased on Windows). Both `hook.py` and `SessionManager` use the same algorithm so they always agree on the filename.

---

## Claude Code Hook Input Schema

`hook.py` receives this JSON on stdin for each `PreToolUse` event:

```json
{
  "session_id": "string",
  "transcript_path": "/path/to/transcript",
  "cwd": "/absolute/working/directory",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write | Edit | MultiEdit | Bash",
  "tool_input": {
    "file_path": "relative or absolute path to target file (Write/Edit/MultiEdit)",
    "command": "the shell command string (Bash)"
  }
}
```

**Hook behavior:**
- A `Bash` payload carries `command` instead of `file_path`. The hook first asks whether the command can plausibly write at all (redirection, `sed -i`, `tee`, `cp`/`mv`, `patch`, `git apply|checkout --|restore`, in-place formatters, …) and exits immediately if not — no filesystem work, no log spam for `ls` or `go build`. Otherwise it harvests candidate target paths from the command and runs **each one through the same pipeline** as a `file_path`. Harvesting leans liberal — a missed path is an uncaptured edit — but **not unboundedly so**, because a bogus capture is not free: it costs a session-file write, a full reload (multi-MB on a busy workspace), a reconcile, the prune, and a second write + reload. Two guards keep the false-positive rate down, both of which apply *only* to speculative candidates and never to an explicit redirection or in-place-tool target (`cat > Makefile` still captures `Makefile`):
  - **Speculative candidates must plausibly name a file** (`_names_a_file`): an extension on the basename, or an existing file on disk. This is what stops a Go module path (`github.com/acme/schema-lib`) becoming a pending entry. `paths_from_command(command, cwd)` takes the tool call's `cwd` for the existence probe; without it, extensionless speculative candidates are dropped rather than resolved against the *process* cwd, which is not the session's directory.
  - **`git` arguments must be pathspecs, not treeish** (`_pathspec_shaped`): with no explicit `--`, `git checkout origin/main` / `git reset --hard origin/release-1.4` name refs. Everything after a `--` is still taken verbatim as a path.
- `file_path` may be relative to `cwd`. The hook resolves it to an absolute path before storing.
- If the file is **already pending**, the hook leaves it untouched (preserves the frozen baseline).
- Otherwise (no entry yet, or — for legacy/pre-migration sessions — a non-pending entry) the hook creates a fresh pending entry with the current on-disk `originalContent`. The hook only ever writes `files`; the extension owns `accepted`/`rejected`, and accept/reject remove the entry from `files`, so on a current-model session a re-edit simply finds no entry and creates a new pending one.

---

## DocumentTracker (GUI path)

`src/documentTracker.ts` provides GUI extension support without hooks:

1. On `start()`: snapshots all currently open documents (`vscode.workspace.textDocuments`).
2. On `onDidOpenTextDocument`: snapshots newly opened documents — this is the "before Claude edits" capture point.
3. On `FileSystemWatcher` `onDidChange` / `onDidCreate`: if the changed file has a snapshot and is not already in the session, calls `sessionManager.trackFileChange(filePath, originalContent)`.

**Ignored paths**: `node_modules`, `.git`, `dist`, `build`, `out`, `target`, `vendor`, `__pycache__`, and other generated directories are skipped to avoid thousands of spurious events when Claude installs dependencies.

**Coexistence with hook**: whichever path fires first for a file owns it. The other path skips any file already present in the session.

---

## Development Setup

```bash
# Install dependencies
npm install

# Compile TypeScript (with source maps)
npm run compile

# Watch mode (auto-recompile on save)
npm run watch

# Type-check without emitting
npm run typecheck
```

Press **F5** in VS Code to launch the Extension Development Host.

To test the hook manually:

```bash
echo '{"tool_name":"Write","cwd":"/tmp","tool_input":{"file_path":"test.txt"}}' \
  | python3 hooks/hook.py
ls ~/.claudegate/sessions/
```

### Testing

- `npm test` runs `test:unit` (TS) + `test:hook` (Python `unittest` in `hooks/tests/`).
- Unit tests are plain `assert` + `console.log("ok - …")`, bundled per-file by esbuild and run with node. **Each new `src/*.test.ts` must be appended to the `test:unit` script in `package.json`** or it won't run.
- Tests that import VS Code-dependent modules bundle with `--alias:vscode=./src/test-stubs/vscode.ts`; isolate `~/.claudegate` via `process.env.HOME = fs.mkdtempSync(...)`.

### Integration tests: driving a real VS Code

`src/test-stubs/vscode.ts` is 89 lines. It proves the logic is right; it can
never prove that VS Code does what we assumed. Everything that only breaks in a
real editor — a command registered with the wrong argument shape, a tree view
that never refreshes, a diff that opens on the wrong side, an activation event
that does not fire — is currently caught by hand, with `MANUAL-TEST-1.3.0.md`
and a human clicking. Integration tests automate exactly that checklist.

**How it works.** `@vscode/test-electron` downloads a real VS Code, launches it
with this extension loaded from source and a workspace folder open, and then
`require`s one module of ours **inside the extension host**. In that module
`import * as vscode from "vscode"` is the real API, not the stub — so the test
sees what a user sees.

Three processes, and it matters which code runs where:

| Where | File | Can use |
|---|---|---|
| plain node | `src/integration/runTests.ts` | `@vscode/test-electron`, fs, spawn. **No `vscode`.** |
| extension host | `src/integration/index.ts` | exports `run(): Promise<void>`, loads the tests |
| extension host | `src/integration/*.itest.ts` | the **real** `vscode` API |

Tests live under `src/` so `npm run typecheck` and `npm run lint` cover them,
and are named `*.itest.ts` so the `test:unit` file list stays untouched.

#### The hazards, in the order they will bite

**1. Build the bundle first.** The host loads `out/extension.js`, never our
TypeScript. A run that compiles only the tests silently exercises the *previous*
build — the suite stays red against correct code, or green against broken code.
`test:integration` must depend on `compile`.

**2. Isolate `$HOME`. This is the big one for ClaudeGate.** `sessionManager.ts`,
`historyPanel.ts` and `extension.ts` all resolve state under
`os.homedir()/.claudegate`. `os.homedir()` reads `$HOME` on POSIX and
`%USERPROFILE%` on Windows, so pass both through `extensionTestsEnv`. Skip this
and the tests read your real sessions and `acceptAll` accepts your real pending
changes — against your real files. The unit tests already do the equivalent with
`process.env.HOME = fs.mkdtempSync(...)`; the same discipline, one process
further away.

**3. Activate explicitly.** We activate `onStartupFinished`, so whether the
extension is up when a test runs depends on load order. Do not rely on it:

```ts
const ext = vscode.extensions.getExtension("lntvan166.claudegate");
await ext!.activate();
```

**4. Poll, never sleep.** The extension reacts to fs watchers, debounced
refreshes and `setTimeout`. `await sleep(500); assert(...)` is a flake generator
in both directions. Use `waitFor` below. The same applies to the editor itself:
the first `showTextDocument` after the host launches can resolve *before* the
editor is actually active, so poll `vscode.window.activeTextEditor` until it is
the document you asked for.

**5. Assert on observable state.** `activate()` returns `void`, so there is no
API object to inspect, and **context keys like `claudegate.acceptedCount` cannot
be read back** — `setContext` is write-only. Assert on what the API does expose:

- `vscode.commands.getCommands(true)` — registration
- file contents on disk — the actual accept/reject outcome
- the session JSON under the temp `$HOME` — model state
- `vscode.window.tabGroups.all` — which editors and diffs are open
- `vscode.window.activeTextEditor.selection` — where navigation landed

**6. Seed with the script we already have.** `manual-test-seed.py <dir>` builds
the workspace *and* the matching session file, and expands `~`, so running it
with the temp `HOME` puts both in the sandbox. The fixture is already written —
it is the same one the manual checklist uses.

**7. Keep the artifacts out.** `.vscode-test/` is already in `.gitignore` and
`.vscodeignore` — leave it there, it holds a ~1GB VS Code download. Add
`out/integration/**` to `.vscodeignore` so the suite never ships.

#### The runner

```ts
// src/integration/runTests.ts — runs OUTSIDE VS Code. Never import "vscode" here.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..", "..");   // out/integration -> repo root
  const extensionTestsPath = path.resolve(__dirname, "index.js");

  // Throwaway HOME and workspace. Without the HOME override these tests would
  // operate on your real ~/.claudegate sessions and your real files.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudegate-itest-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claudegate-itest-ws-"));

  const seed = spawnSync("python3", [path.join(repoRoot, "manual-test-seed.py"), workspace], {
    env: { ...process.env, HOME: home },
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (seed.status !== 0) {
    throw new Error("manual-test-seed.py failed");
  }

  await runTests({
    vscodeExecutablePath: await downloadAndUnzipVSCode("stable"),
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath,
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust"],
    extensionTestsEnv: {
      HOME: home,
      USERPROFILE: home,
      CLAUDEGATE_ITEST_WS: workspace,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`--disable-extensions` turns off every *other* extension; the one under
development still loads.

#### The host entry and helpers

```ts
// src/integration/index.ts — the extension host requires this and calls run().
import * as fs from "fs";
import * as path from "path";
import Mocha = require("mocha");   // `import Mocha from` needs esModuleInterop at runtime; this does not

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60000 });
  for (const file of fs.readdirSync(__dirname)) {
    if (file.endsWith(".itest.js")) {
      mocha.addFile(path.join(__dirname, file));
    }
  }
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} failing`)) : resolve()));
  });
}
```

```ts
// src/integration/helpers.ts
import * as assert from "assert";
import * as vscode from "vscode";

export function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "no workspace folder open in the test host");
  return root;
}

export async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.getExtension("lntvan166.claudegate");
  assert.ok(ext, "claudegate not found in the test host");
  await ext.activate();
}

/** Poll until `probe` returns something truthy. Reports the last error so a
 *  genuine failure is legible instead of a bare timeout. */
export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? ` — last error: ${lastError}` : ""}`);
}
```

#### A test

```ts
// src/integration/review.itest.ts
import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { activateExtension, waitFor, workspaceRoot } from "./helpers";

describe("review flow", () => {
  before(async () => activateExtension());

  it("registers its commands", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ["claudegate.acceptFile", "claudegate.rejectFile", "claudegate.acceptAll"]) {
      assert.ok(all.includes(id), `${id} not registered`);
    }
  });

  it("accepting everything keeps Claude's version on disk", async () => {
    const file = path.join(workspaceRoot(), "src", "utils.ts");
    const claudeVersion = fs.readFileSync(file, "utf8");

    await vscode.commands.executeCommand("claudegate.acceptAll");

    await waitFor("the pending set to drain", () => {
      const sessions = path.join(process.env.HOME!, ".claudegate", "sessions");
      return fs
        .readdirSync(sessions)
        .every((f) => !JSON.stringify(
          JSON.parse(fs.readFileSync(path.join(sessions, f), "utf8")),
        ).includes('"pending"'));
    });

    assert.strictEqual(fs.readFileSync(file, "utf8"), claudeVersion);
  });
});
```

Check argument shapes against `registerCommand` in `src/extension.ts` before
writing a test — most of the per-file commands take a tree item, not a `Uri`.

#### Wiring it up

```json
"build:itest": "esbuild src/integration/runTests.ts src/integration/index.ts src/integration/*.itest.ts --bundle --platform=node --format=cjs --external:vscode --external:mocha --external:@vscode/test-electron --outdir=out/integration",
"test:integration": "npm run compile && npm run build:itest && node out/integration/runTests.js"
```

`--external:vscode` is mandatory: the module only exists inside the host and
bundling it produces a build that fails at require time. Add
`@vscode/test-electron` and `mocha` to `devDependencies`.

Keep `test:integration` out of `npm test`. It downloads VS Code on first run and
takes tens of seconds; `npm test` should stay fast enough to run on every save.
Run it before a release, and in CI as its own job — headless Linux needs
`xvfb-run -a npm run test:integration`.

#### Verifying against a real workspace

The same harness can be pointed at a real folder instead of a generated fixture,
which is how you check behaviour that only shows up at real scale — a repo with
hundreds of pending files, real worktrees, a real session history. Copy
`runTests.ts` to `runReal.ts`, take the path from an environment variable, and
seed nothing:

```ts
const workspace = process.env.CLAUDEGATE_REAL_WS;
if (!workspace) {
  throw new Error("set CLAUDEGATE_REAL_WS to the workspace to verify against");
}
```

Two rules for that variant. Keep the temp `$HOME` — a real *workspace* is fine,
a real `~/.claudegate` is not. And keep the assertions read-only, or point it at
a scratch clone: `acceptAll` against a repo you care about is not a test, it is
an incident.

## Subagent / Background-Task Git Safety

Subagents run in the **same working directory** (no worktree isolation by default), so a stray `git checkout`/`reset` — or a race — can land a commit as a **dangling commit on the wrong base**, leaving the branch HEAD unmoved with a clean tree (work recoverable only via `git cherry-pick <sha>`).

- When dispatching a subagent that commits: instruct it to run ONLY `git add <files>` + `git commit` on the current branch, NEVER `checkout/switch/reset/rebase/stash/branch`, and to confirm `git branch --show-current` before committing.
- After each subagent returns, verify HEAD actually advanced on the expected branch (`git log --oneline -1`, clean status, files present) before trusting the work. If not, find the dangling commit (`git log --oneline <sha>`) and `cherry-pick` it.
- Prefer worktree isolation for parallel or file-mutating agents.

---

## Publishing to the Marketplace

**Do NOT cut a release, bump the version, tag, or run `vsce publish` on your own.** Releasing is gated behind the `release` skill and must only happen when the maintainer explicitly invokes it (`/release` or "make a release"). Until then, leave `package.json` version, `CHANGELOG.md`, tags, and publishing untouched — even after landing a fix. Just land the change; the maintainer decides when to release.

When the maintainer does invoke the `release` skill, it owns the whole flow (semver bump → CHANGELOG → tests → bundle → auth → commit → tag → `vsce publish`) and pauses for confirmation before the irreversible publish.

```bash
npm install -g @vscode/vsce   # one-time
vsce login <publisher-id>      # requires Azure DevOps PAT with Marketplace → Manage scope
vsce publish                   # publishes the current package.json version
```

The release also publishes to **Open VSX** (`ovsx publish`) so Cursor/VSCodium/Windsurf auto-update. The Open VSX token is stored as the **`OVSX_PAT`** environment variable (set in `~/.zshrc`); `ovsx` reads it automatically, so no need to pass `-p`. Never commit the token value — only reference the `OVSX_PAT` name.

The `.vscodeignore` file controls what gets packaged. vsce reads `.vscodeignore` (not `.vsixignore`). Keep dev-only directories (`.superpowers/`, `docs/`, `.claude/`, `.qodo/`) listed there.

---

## How Hook Changes Reach a Running Session

`~/.claude/settings.json` does not invoke `hook.py` directly. It invokes a stable
wrapper (`~/.claudegate/hook.sh`, or `hook.bat` on Windows) whose path never
changes and which re-execs `hook.py` **fresh on every tool call**:

```bash
#!/usr/bin/env bash
python3 "$HOME/.claudegate/hook.py"
```

| Change | Effect on a **running** Claude session |
|---|---|
| `hooks/hook.py` content | Picked up on the session's next tool call. No restart. |
| `~/.claude/settings.json` hooks block | Picked up on the session's next tool call **on Claude Code 2.1.227+**. Older versions snapshotted hook config at session start and needed a restart. |

**This corrects an earlier rule in this file** that called the settings.json case
"cold" — that a write silently stopped capture in every running session until it
restarted. Measured on 2.1.227:

- every running session (including 25-hour-old ones) holds an `inotify` watch on
  the settings file, mask `c06`;
- a hook added mid-session to the **project** `settings.local.json` fired on the
  very next tool call;
- the same was then verified for the **user-global** `~/.claude/settings.json` —
  the file we actually write — in a session hours old;
- in both cases the pre-existing claudegate hook kept firing throughout: adding
  or repairing a hook does **not** revoke the others.

Consequences:

- `HookInstaller.syncHookIfNeeded()` rewrites `~/.claudegate/*` **silently and
  automatically** (activation + window focus). It must fire `onHealthChange`
  afterwards or the status chip keeps reporting the pre-heal state.
- `HookInstaller.syncSettingsIfNeeded()` may likewise write `settings.json`
  **silently**, at activation, because the change takes effect immediately. It is
  deliberately bounded: at most one attempt per activation, latching off on
  failure, and **repair only** — it never performs a first-time install, which
  stays the explicit **Setup Hook** action. This is how a widened
  `PRE_TOOL_MATCHER` (e.g. adding `Bash`) reaches users who installed earlier;
  nothing else could, since `computeSettingsPatch` is the only code that inspects
  the matcher.
- Every settings.json write still runs the full guarded protocol (ENOENT-only
  fresh install, timestamped backup, realpath write, post-write verify with
  rollback) — that file holds the user's entire Claude config.
- `watchSettingsForTrustInvalidation()` is retained for the older versions, but
  its message is a heads-up, **not** an outage report: do not reintroduce
  "your sessions have stopped tracking, restart them".

When diagnosing "capture stopped", check `~/.claudegate/hook.log` first — daily
entry counts show immediately whether the hook stopped firing or whether the
records are landing somewhere the panel isn't displaying (the far more common
cause historically: worktree sessions, see v1.10.1 / v1.12.0 / v1.12.1).

---

## Adding Features

- **New commands**: Register in `src/extension.ts` and add to `contributes.commands` + `contributes.menus` in `package.json`.
- **Hook changes**: Edit `hooks/hook.py` — the extension auto-syncs it to `~/.claudegate/hook.py` at activation and on window focus, and running Claude sessions pick it up immediately (see **How Hook Changes Reach a Running Session**). Re-running **Setup Hook** is only needed when the `settings.json` registration is missing entirely — a *stale* one (wrong wrapper path, outdated matcher) is repaired automatically at the next activation.
- **Captured tools**: change `PRE_TOOL_MATCHER` in `src/hookInstaller.ts` and teach `hooks/hook.py` to read that tool's `tool_input`. The constant is compared by `computeSettingsPatch`, so existing installs migrate themselves; a matcher hardcoded anywhere else would strand every user who installed before the change.
- **Session behavior**: `src/sessionManager.ts` owns all session read/write logic; keep side effects there.
- **GUI detection changes**: `src/documentTracker.ts` owns all VS Code document/FS watching logic.

---

## Design Decisions

- **File snapshot over git**: No git dependency — works in any directory, including non-git projects.
- **Per-workspace session files** (`~/.claudegate/sessions/<hash>.json`): Multiple simultaneous Claude sessions in different projects stay fully isolated. The hash is `MD5(resolvedWorkspacePath)`, computed identically by `hook.py` and `SessionManager`.
- **Two detection paths**: The `PreToolUse` hook is authoritative for all Claude Code — terminal CLI and in-editor extension both run the same hook, firing synchronously before writes, for `Write`/`Edit`/`MultiEdit` **and** `Bash`. The `DocumentTracker` is a non-Claude fallback for agents like Cursor Composer or Codex that don't run Claude's hooks; it cannot attribute edits, so it's disabled by default.
- **Shell writes captured by extraction, not by watching**: a `Bash` payload is parsed for write intent and target paths rather than resolved by observing the filesystem, so the baseline is still snapshotted *before* the write and stays attributable to the session. Commands that write without naming a file (`make generate`, `prettier --write src/`) are out of scope by design.
- **Only pending files get a badge**: Accepted and rejected files are undecorated in the file explorer to avoid clashing with git's own `A`/`R` status indicators.
- **Python for the hook**: Python 3 is pre-installed on macOS/Linux and handles JSON and file I/O without extra dependencies.
- **Nothing expensive runs synchronously on a coarse trigger** — see the section below.

---

## Extension-Host Responsiveness

Every trigger this extension listens to fires far more often than the work behind
it is worth doing. Two of them are load-bearing, and both are rate-limited. Treat
this as a standing constraint, not an optimization: the extension host is a single
thread shared with every other extension, and a synchronous stall there freezes
the editor's UI.

**Window focus** fires on every alt-tab. The sweep behind it (worktree rescan,
reconcile of every attached session, hook health check) is real filesystem work.

- `createThrottle(FOCUS_SWEEP_MIN_INTERVAL_MS)` in `src/extension.ts` drops
  sub-interval focus events outright.
- `WorktreeSessionRegistry.refresh()` applies its own, longer
  `RESCAN_MIN_INTERVAL_MS` on top, coalesces concurrent callers onto one in-flight
  walk, and takes `{ force: true }` for activation and user-driven refreshes so
  nothing a user explicitly asks for is ever delayed.
- `nestedWorktreesUnder()` is **async and must stay async**. It is the single most
  expensive routine here — measured at ~2,500 `readdir` + ~2,700 `lstat` on a real
  `go.work` monorepo. Synchronously that blocked the host for ~42 ms warm (far
  worse with a cold page cache); the bounded-concurrency BFS keeps the worst
  event-loop stall at ~2 ms for the same tree. `worktrees.test.ts` asserts the loop
  keeps turning during a scan.

**Session change** fires at least twice per user decision: once from `persist()`
and once from the `fs.watch` reload that write triggers. Both consumers coalesce
via `createCoalescer` (`src/scheduling.ts`):

- `FilteredTreeProvider` collapses the burst into one `onDidChangeTreeData` fire.
  Firing each change separately raced inside VS Code's async tree and threw
  `TreeError [claudegate.acceptedPanel] Data tree node not found` /
  `Tree element not found` during multi-file accepts. `setViewMode()` deliberately
  fires directly — a button press must repaint at once and cannot storm.
- The badge/context fan-out and the "Review All Pending" multi-diff rebuild in
  `extension.ts` likewise. The multi-diff one matters most: `pendingReviewPaths()`
  reads **every** pending file off disk to test it for a real change.

Note the coalescer is not a debounce — it does not extend its deadline on each
call, so a continuous stream still runs at a steady cadence instead of starving.

**Logging must never throw.** VS Code closes the host's IPC channel *before*
running `dispose()` on subscriptions, so `appendLine` from a teardown path raises
`Error: Channel has been closed`. That escaped `WorktreeSessionRegistry.detach()`
and aborted `dispose()` mid-loop, leaking an `fs.watch` handle and a reconcile
timer per un-detached worktree on every window reload. `activate()` wraps the
channel in `failSoftLog()` (`src/safeLog.ts`) and passes only the wrapper
downstream; `dispose()` additionally guards each detach.

When diagnosing "the editor feels slow with ClaudeGate installed", check in this
order: the Claude Gate output channel for a `Session file is large` warning (a
multi-MB session re-parses on every watch event), then `~/.claudegate/hook.log`
for bogus captures driving that churn, then whether a new synchronous filesystem
walk has crept onto a focus or session-change path.
