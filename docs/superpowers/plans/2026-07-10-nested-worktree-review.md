# Nested Git Worktree Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a git worktree nested inside a workspace deterministically own its own review session, and surface that worktree's pending changes (with full accept/reject/diff actions) inside the parent workspace window — one canonical record shown from both windows — plus an "open worktree in new window" action.

**Architecture:** `hook.py` gains filesystem-only worktree detection and always routes a worktree file's capture to that worktree's own session (independent of which windows are open). In the parent window, a new `WorktreeSessionRegistry` attaches a reused `SessionManager` per nested worktree, watches its session file, and exposes it. The pending tree provider renders one group node per worktree; accept/reject/open-diff for those rows are dispatched to the owning worktree `SessionManager` via a small router. No new persistence/lock logic — worktree writes reuse the existing `SessionManager` paths.

**Tech Stack:** TypeScript (VS Code extension API, `esbuild` bundling), Python 3 (`hook.py`), Node `assert` + `console.log("ok - …")` unit tests bundled by esbuild with a `vscode` stub, Python `unittest` for the hook.

## Global Constraints

- **No `git` binary dependency.** Worktree detection is pure filesystem (`.git` file/dir + `.git/worktrees/*/gitdir`). (Design rule: "File snapshot over git — no git dependency.")
- **`hook.py` must FAIL OPEN and never block a Claude write.** Any error in worktree detection → fall back to today's longest-registered-root routing; never raise, never `sys.exit(non-zero)` on the write path.
- **No AI / model calls of any kind** (`no-ai-in-extension`).
- **Do not bump `package.json` version, edit `CHANGELOG.md`, tag, or publish.** Releasing is gated behind the `release` skill (CLAUDE.md).
- **Reuse existing concurrency primitives.** Worktree session writes go through the existing `SessionManager` (advisory lock + `mergeFreshCaptures` + atomic rename). Do NOT fork or reimplement locking.
- **Parent window shows worktree PENDING only** — not the worktree's accepted/rejected history (spec §3).
- **No migration** of the existing scattered `accepted`/`rejected` entries.
- **VS Code engine `^1.85.0`.** `vscode.openFolder` with `{ forceNewWindow: true }` and `onDidChangeWindowState` are available at this floor.
- Every new unit test file must be appended to the `test:unit` npm script so `npm test` runs it.
- Session hashing must stay identical to `hook.py` / `SessionManager` (`MD5(normcase(abspath(path)))`); reuse `SessionManager` for worktree sessions rather than re-hashing by hand.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/worktrees.ts` | Pure filesystem worktree detection/enumeration (`isWorktreeRoot`, `nestedWorktreesUnder`, `worktreeRootForPath`) | **New** |
| `src/worktrees.test.ts` | Unit tests for detection against temp-dir git layouts | **New** |
| `hooks/hook.py` | Route worktree files to the worktree's own session (fail-open) | Modify |
| `hooks/tests/test_worktree_routing.py` | Hook routing tests (worktree vs submodule vs fallback) | **New** |
| `src/worktreeSessionRegistry.ts` | Attach/watch/dispatch a `SessionManager` per nested worktree | **New** |
| `src/worktreeSessionRegistry.test.ts` | Registry tests (attach, `managerFor`, `totalPending`) | **New** |
| `src/reviewPanel.ts` | `WorktreeGroupItem` + render worktree groups in the pending panel | Modify |
| `src/diffProvider.ts` | Resolve baseline via the owning (worktree) session | Modify |
| `src/extension.ts` | Registry lifecycle, router dispatch, badge count, open-window command | Modify |
| `package.json` | `claudegate.openWorktreeWindow` command + menu | Modify |

**Design note (scope trims applied):** Within a worktree group node, children are a **flat file list** (not a nested folder tree) — worktrees carry a modest number of changed files and this avoids threading a foreign session through `FolderItem`/`directChildren`. The diff's **left/baseline** side is a frozen snapshot, so the content provider only needs to *resolve* the owning session; it need not fire change events for worktree files (the right side is the live on-disk file, which VS Code refreshes natively; on accept/reject the tab is closed).

---

### Task 1: Pure worktree detection (`src/worktrees.ts`)

**Files:**
- Create: `src/worktrees.ts`
- Test: `src/worktrees.test.ts`
- Modify: `package.json` (append the new test to `test:unit`)

**Interfaces:**
- Consumes: `pathIsUnder(child, parent, caseInsensitive?)` from `src/workspaceScope.ts`.
- Produces:
  - `isWorktreeRoot(dir: string): boolean`
  - `nestedWorktreesUnder(root: string): string[]` — absolute worktree working-dir paths strictly under `root`.
  - `worktreeRootForPath(filePath: string, roots: string[]): string | null` — longest `roots` entry containing `filePath`, else `null`.

- [ ] **Step 1: Write the failing test** — create `src/worktrees.test.ts`:

```ts
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isWorktreeRoot, nestedWorktreesUnder, worktreeRootForPath } from "./worktrees";

// Build a fake main repo at <root> with:
//   <root>/.git/                        (dir  → main repo)
//   <root>/.git/worktrees/ws/gitdir     (file → points at <root>/ws/.git)
//   <root>/ws/.git                       (file → "gitdir: <root>/.git/worktrees/ws")
//   <root>/sub/.git                      (file → submodule, points at .git/modules/sub)
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-wt-"));
  fs.mkdirSync(path.join(root, ".git", "worktrees", "ws"), { recursive: true });
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "ws", "gitdir"),
    path.join(root, "ws", ".git") + "\n");
  fs.writeFileSync(path.join(root, "ws", ".git"),
    `gitdir: ${path.join(root, ".git", "worktrees", "ws")}\n`);
  fs.writeFileSync(path.join(root, "sub", ".git"),
    `gitdir: ${path.join(root, ".git", "modules", "sub")}\n`);
  return root;
}

{
  const root = makeRepo();

  // isWorktreeRoot: worktree wd yes; main repo no; submodule no.
  assert.equal(isWorktreeRoot(path.join(root, "ws")), true, "ws is a worktree root");
  assert.equal(isWorktreeRoot(root), false, "main repo (.git dir) is not a worktree");
  assert.equal(isWorktreeRoot(path.join(root, "sub")), false, "submodule is not a worktree");

  // nestedWorktreesUnder: finds ws, excludes submodule.
  const found = nestedWorktreesUnder(root);
  assert.deepEqual(found, [path.resolve(path.join(root, "ws"))], "enumerates the nested worktree only");

  // worktreeRootForPath: file inside ws → ws; file elsewhere → null; longest match wins.
  const roots = [path.join(root, "ws")];
  assert.equal(worktreeRootForPath(path.join(root, "ws", "a.ts"), roots), path.join(root, "ws"), "file under ws");
  assert.equal(worktreeRootForPath(path.join(root, "src", "a.ts"), roots), null, "file outside any worktree → null");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok - worktree detection (worktree vs main vs submodule)");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npx esbuild src/worktrees.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/worktrees.test.cjs && node out/worktrees.test.cjs`
Expected: FAIL — esbuild error `Could not resolve "./worktrees"` (file not created yet).

- [ ] **Step 3: Write the minimal implementation** — create `src/worktrees.ts`:

```ts
import * as fs from "fs";
import * as path from "path";
import { pathIsUnder } from "./workspaceScope";

// A git worktree's working directory has a `.git` FILE (not a dir) whose content
// is `gitdir: <main-repo>/.git/worktrees/<name>`. A submodule ALSO uses a `.git`
// file, but its gitdir points into `<super>/.git/modules/<name>` — so we key on
// the `worktrees` path segment to avoid classifying a submodule as a worktree.
// Git writes the gitdir path with the platform separator, so accept either.
const WORKTREE_MARKER = /[\\/]worktrees[\\/]/;

// Read the `gitdir: <target>` line from a `.git` FILE, or null if it isn't one.
function gitFileTarget(dotGitPath: string): string | null {
  try {
    const raw = fs.readFileSync(dotGitPath, "utf-8").trim();
    const m = /^gitdir:\s*(.+)$/.exec(raw);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** True if `dir` is the working directory of a git worktree (not a submodule). */
export function isWorktreeRoot(dir: string): boolean {
  const dotGit = path.join(dir, ".git");
  try {
    if (!fs.lstatSync(dotGit).isFile()) return false; // main repo has a `.git` DIR
  } catch {
    return false;
  }
  const target = gitFileTarget(dotGit);
  return target !== null && WORKTREE_MARKER.test(target);
}

/**
 * Enumerate git worktree working directories nested strictly under `root`, using
 * only the filesystem (no `git` binary). A main repo records each worktree at
 * `<root>/.git/worktrees/<name>/gitdir`, whose content is the path to that
 * worktree's `.git` file; the worktree working directory is that file's parent.
 */
export function nestedWorktreesUnder(root: string): string[] {
  const dotGit = path.join(root, ".git");
  try {
    if (!fs.statSync(dotGit).isDirectory()) return []; // only a main repo has worktrees/
  } catch {
    return [];
  }
  const worktreesDir = path.join(dotGit, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(worktreesDir);
  } catch {
    return []; // no worktrees/ subdir
  }
  const found: string[] = [];
  for (const name of names) {
    let target: string;
    try {
      target = fs.readFileSync(path.join(worktreesDir, name, "gitdir"), "utf-8").trim();
    } catch {
      continue;
    }
    const wtRoot = path.resolve(path.dirname(target)); // parent of the `.git` file
    if (pathIsUnder(wtRoot, root)) found.push(wtRoot);
  }
  return found;
}

/** The `roots` entry that contains `filePath` (longest match), or null. */
export function worktreeRootForPath(filePath: string, roots: string[]): string | null {
  let best: string | null = null;
  for (const r of roots) {
    if (pathIsUnder(filePath, r) && (best === null || r.length > best.length)) best = r;
  }
  return best;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npx esbuild src/worktrees.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/worktrees.test.cjs && node out/worktrees.test.cjs`
Expected: PASS — prints `ok - worktree detection (worktree vs main vs submodule)`.

- [ ] **Step 5: Wire the test into `test:unit`** — in `package.json`, append to the `test:unit` script value, right before its closing quote (after the `sessionManager.test.cjs` / `hookInstaller.test.cjs` chain), this segment (note the leading ` && `):

```
 && esbuild src/worktrees.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/worktrees.test.cjs && node out/worktrees.test.cjs
```

- [ ] **Step 6: Run the full unit suite**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npm run test:unit`
Expected: PASS — the run ends with `ok - worktree detection (worktree vs main vs submodule)` among the others; exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/worktrees.ts src/worktrees.test.ts package.json
git commit -m "feat: pure filesystem git-worktree detection helpers"
```

---

### Task 2: Deterministic worktree routing in `hook.py`

**Files:**
- Modify: `hooks/hook.py` (add `worktree_root_for_file`; prefer it in `main()`)
- Test: `hooks/tests/test_worktree_routing.py`

**Interfaces:**
- Consumes: `workspace_root_for_file(file_path, cwd)` and `workspace_session_file(workspace_root)` (existing).
- Produces: `worktree_root_for_file(file_path: str, best_root: str) -> str | None` — the nested worktree root containing `file_path` when it is a real worktree strictly below `best_root`, else `None`. Never raises.

- [ ] **Step 1: Write the failing test** — create `hooks/tests/test_worktree_routing.py`:

```python
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "..", "hook.py")


def session_file_for(claudegate_dir, root):
    normalized = os.path.normcase(os.path.abspath(root))
    h = hashlib.md5(normalized.encode()).hexdigest()
    return os.path.join(claudegate_dir, "sessions", f"{h}.json")


class WorktreeRoutingTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.claudegate = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.claudegate, "sessions"))
        # Main repo = registered root; nested worktree "ws" is NOT registered.
        self.root = os.path.join(self.home, "project")
        os.makedirs(os.path.join(self.root, ".git", "worktrees", "ws"))
        self.ws = os.path.join(self.root, "ws")
        os.makedirs(self.ws)
        self.sub = os.path.join(self.root, "sub")
        os.makedirs(self.sub)
        # worktree markers
        with open(os.path.join(self.root, ".git", "worktrees", "ws", "gitdir"), "w") as f:
            f.write(os.path.join(self.ws, ".git") + "\n")
        with open(os.path.join(self.ws, ".git"), "w") as f:
            f.write("gitdir: " + os.path.join(self.root, ".git", "worktrees", "ws") + "\n")
        # submodule marker (must NOT be treated as a worktree)
        with open(os.path.join(self.sub, ".git"), "w") as f:
            f.write("gitdir: " + os.path.join(self.root, ".git", "modules", "sub") + "\n")
        with open(os.path.join(self.claudegate, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)  # only the parent root is registered

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_hook(self, file_path):
        payload = json.dumps({
            "tool_name": "Edit",
            "cwd": self.root,
            "tool_input": {"file_path": file_path},
        })
        env = dict(os.environ, HOME=self.home)
        subprocess.run([sys.executable, HOOK], input=payload, text=True, env=env, check=True)

    def test_worktree_file_routes_to_worktree_session(self):
        fp = os.path.join(self.ws, "a.txt")
        with open(fp, "w") as f:
            f.write("hi")
        self.run_hook(fp)
        ws_session = session_file_for(self.claudegate, self.ws)
        root_session = session_file_for(self.claudegate, self.root)
        self.assertTrue(os.path.exists(ws_session), "captured into the worktree session")
        self.assertIn(fp, json.load(open(ws_session))["files"])
        self.assertFalse(os.path.exists(root_session), "not captured into the parent session")

    def test_submodule_file_routes_to_parent_session(self):
        fp = os.path.join(self.sub, "a.txt")
        with open(fp, "w") as f:
            f.write("hi")
        self.run_hook(fp)
        root_session = session_file_for(self.claudegate, self.root)
        self.assertTrue(os.path.exists(root_session), "submodule stays with the parent")
        self.assertIn(fp, json.load(open(root_session))["files"])

    def test_plain_nested_file_routes_to_parent_session(self):
        d = os.path.join(self.root, "src")
        os.makedirs(d)
        fp = os.path.join(d, "a.txt")
        with open(fp, "w") as f:
            f.write("hi")
        self.run_hook(fp)
        root_session = session_file_for(self.claudegate, self.root)
        self.assertIn(fp, json.load(open(root_session))["files"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && python3 -m unittest hooks.tests.test_worktree_routing -v`
Expected: FAIL — `test_worktree_file_routes_to_worktree_session` fails: the worktree session does not exist and the file was captured into the parent (root) session (today's longest-match behavior).

- [ ] **Step 3: Add the detection helper** — in `hooks/hook.py`, insert this function immediately after `workspace_session_file()` (after line 106):

```python
def worktree_root_for_file(file_path: str, best_root: str) -> str | None:
    """Return the nested git-worktree working dir containing file_path, if it is a
    real worktree (not a submodule) strictly BELOW best_root. Pure filesystem and
    FAIL-OPEN: any error returns None so routing falls back to best_root. Never
    walks above best_root."""
    try:
        best_abs = os.path.normcase(os.path.abspath(best_root))
        cur = os.path.dirname(os.path.normcase(os.path.abspath(file_path)))
        while cur.startswith(best_abs + os.sep):  # strictly below best_root
            dot_git = os.path.join(cur, ".git")
            if os.path.isfile(dot_git):
                try:
                    with open(dot_git, encoding="utf-8") as f:
                        first = f.read().strip()
                except OSError:
                    return None
                # `gitdir: .../worktrees/<name>` marks a worktree; `.../modules/`
                # marks a submodule (leave those attributed to the parent root).
                if first.startswith("gitdir:") and (
                    "/worktrees/" in first or "\\worktrees\\" in first
                ):
                    return cur
                return None
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        return None
    except Exception:
        return None
```

- [ ] **Step 4: Prefer the worktree root in `main()`** — in `hooks/hook.py`, replace these lines (currently 166-169):

```python
    workspace_root = workspace_root_for_file(file_path, cwd)
    if workspace_root is None:
        sys.exit(0)
    session_file = workspace_session_file(workspace_root)
```

with:

```python
    workspace_root = workspace_root_for_file(file_path, cwd)
    if workspace_root is None:
        sys.exit(0)
    # A nested git worktree owns its own session deterministically, regardless of
    # which windows are open (fail-open: falls back to workspace_root on any error).
    worktree_root = worktree_root_for_file(file_path, workspace_root)
    if worktree_root is not None:
        workspace_root = worktree_root
    session_file = workspace_session_file(workspace_root)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && python3 -m unittest hooks.tests.test_worktree_routing -v`
Expected: PASS — all three tests OK.

- [ ] **Step 6: Run the existing hook suite to check for regressions**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npm run test:hook`
Expected: PASS — `test_hook.py` and `test_worktree_routing.py` all OK (the plain non-worktree tests still route to the registered root).

- [ ] **Step 7: Commit**

```bash
git add hooks/hook.py hooks/tests/test_worktree_routing.py
git commit -m "feat: hook routes nested-worktree edits to the worktree's own session"
```

---

### Task 3: Worktree session registry (`src/worktreeSessionRegistry.ts`)

**Files:**
- Create: `src/worktreeSessionRegistry.ts`
- Test: `src/worktreeSessionRegistry.test.ts`
- Modify: `package.json` (append the new test to `test:unit`)

**Interfaces:**
- Consumes: `SessionManager` (constructor `(log, workspacePath)`, `startWatching()`, `stopWatching()`, `getSession()`, `getPendingCount()`, `onSessionChange`); `nestedWorktreesUnder`, `worktreeRootForPath` from `./worktrees`.
- Produces: class `WorktreeSessionRegistry` with:
  - `constructor(log: vscode.OutputChannel, primaryRoot: string | undefined)`
  - `refresh(): void`
  - `getManagers(): Map<string, SessionManager>` (key = absolute worktree root)
  - `managerFor(filePath: string): SessionManager | null`
  - `totalPending(): number`
  - `onChange: vscode.Event<void>`
  - `dispose(): void`

- [ ] **Step 1: Write the failing test** — create `src/worktreeSessionRegistry.test.ts`:

```ts
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher } from "./workspaceScope";
import { workspace as stubWorkspace } from "./test-stubs/vscode";

const fakeLog = { appendLine() {} } as any;

function sessionPathFor(home: string, ws: string): string {
  const hash = crypto.createHash("md5").update(path.resolve(ws)).digest("hex");
  return path.join(home, ".claudegate", "sessions", `${hash}.json`);
}

{
  setExcludeMatcher(new ExcludeMatcher()); // nothing excluded
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  process.env.HOME = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-root-"));
  // parent window sees only `root`; worktree files live under it → in-workspace.
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: root } }];

  // Fake main repo + nested worktree "ws".
  fs.mkdirSync(path.join(root, ".git", "worktrees", "ws"), { recursive: true });
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "worktrees", "ws", "gitdir"), path.join(ws, ".git") + "\n");
  fs.writeFileSync(path.join(ws, ".git"), `gitdir: ${path.join(root, ".git", "worktrees", "ws")}\n`);

  // Pre-seed the worktree's session file with one pending file.
  const wsFile = path.join(ws, "a.ts");
  const sp = sessionPathFor(home, ws);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [wsFile]: { originalContent: "OLD", reviewStatus: "pending", newFile: false } },
    accepted: [], rejected: {},
  }));

  const reg = new WorktreeSessionRegistry(fakeLog, root);
  let changes = 0;
  reg.onChange(() => changes++);
  reg.refresh();

  assert.deepEqual([...reg.getManagers().keys()], [path.resolve(ws)], "attached the nested worktree");
  assert.equal(reg.totalPending(), 1, "counts the worktree's pending file");
  assert.ok(reg.managerFor(wsFile), "resolves the owning manager for a worktree file");
  assert.equal(reg.managerFor(path.join(root, "src", "x.ts")), null, "no manager for a non-worktree file");
  assert.ok(changes > 0, "refresh fired onChange");

  reg.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - worktree session registry attaches, counts, and routes");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npx esbuild src/worktreeSessionRegistry.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/worktreeSessionRegistry.test.cjs && node out/worktreeSessionRegistry.test.cjs`
Expected: FAIL — `Could not resolve "./worktreeSessionRegistry"`.

- [ ] **Step 3: Write the implementation** — create `src/worktreeSessionRegistry.ts`:

```ts
import * as vscode from "vscode";
import { SessionManager } from "./sessionManager";
import { nestedWorktreesUnder, worktreeRootForPath } from "./worktrees";

// Guardrail: never attach an unbounded number of worktree sessions. Well past any
// realistic count; excess are logged (never silently dropped) per spec §8.
const MAX_ATTACHED_WORKTREES = 10;

/**
 * Owns one reused SessionManager per git worktree nested under the window's
 * primary root. Each attached manager watches the worktree's own canonical
 * session file, so pending changes are visible here AND in the worktree's own
 * window, and a decision in either targets the same record.
 */
export class WorktreeSessionRegistry {
  private readonly managers = new Map<string, SessionManager>();
  private readonly subs = new Map<string, vscode.Disposable>();
  private readonly _onChange = new vscode.EventEmitter<void>();
  readonly onChange = this._onChange.event;

  constructor(
    private readonly log: vscode.OutputChannel,
    private readonly primaryRoot: string | undefined
  ) {}

  // Recompute the nested-worktree set and attach/detach managers to match.
  // Cheap (filesystem enumeration only) — call at activation and on a coarse
  // trigger (window focus / manual refresh), never in a hot loop.
  refresh(): void {
    if (!this.primaryRoot) return;
    let roots = nestedWorktreesUnder(this.primaryRoot);
    if (roots.length > MAX_ATTACHED_WORKTREES) {
      this.log.appendLine(
        `[WARN] ${roots.length} nested worktrees found; attaching only ${MAX_ATTACHED_WORKTREES}. ` +
        `Open the others directly to review them.`
      );
      roots = roots.slice(0, MAX_ATTACHED_WORKTREES);
    }
    const wanted = new Set(roots);
    for (const root of [...this.managers.keys()]) {
      if (!wanted.has(root)) this.detach(root);
    }
    for (const root of roots) {
      if (this.managers.has(root)) continue;
      const mgr = new SessionManager(this.log, root);
      this.subs.set(root, mgr.onSessionChange(() => this._onChange.fire()));
      mgr.startWatching(); // loads the session synchronously
      this.managers.set(root, mgr);
      this.log.appendLine(`[INFO] Attached worktree session: ${root}`);
    }
    this._onChange.fire();
  }

  private detach(root: string): void {
    this.subs.get(root)?.dispose();
    this.subs.delete(root);
    this.managers.get(root)?.stopWatching();
    this.managers.delete(root);
    this.log.appendLine(`[INFO] Detached worktree session: ${root}`);
  }

  getManagers(): Map<string, SessionManager> {
    return this.managers;
  }

  // The SessionManager that OWNS filePath (the worktree it falls under), or null.
  managerFor(filePath: string): SessionManager | null {
    const root = worktreeRootForPath(filePath, [...this.managers.keys()]);
    return root ? this.managers.get(root) ?? null : null;
  }

  // Total in-scope pending files across all attached worktrees (for the badge).
  totalPending(): number {
    let n = 0;
    for (const mgr of this.managers.values()) n += mgr.getPendingCount();
    return n;
  }

  dispose(): void {
    for (const root of [...this.managers.keys()]) this.detach(root);
    this._onChange.dispose();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npx esbuild src/worktreeSessionRegistry.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/worktreeSessionRegistry.test.cjs && node out/worktreeSessionRegistry.test.cjs`
Expected: PASS — prints `ok - worktree session registry attaches, counts, and routes`.

- [ ] **Step 5: Wire the test into `test:unit`** — append this segment to the `test:unit` script value in `package.json` (leading ` && `):

```
 && esbuild src/worktreeSessionRegistry.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/worktreeSessionRegistry.test.cjs && node out/worktreeSessionRegistry.test.cjs
```

- [ ] **Step 6: Run the full unit suite**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npm run test:unit`
Expected: PASS — includes `ok - worktree session registry attaches, counts, and routes`; exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/worktreeSessionRegistry.ts src/worktreeSessionRegistry.test.ts package.json
git commit -m "feat: WorktreeSessionRegistry attaches a SessionManager per nested worktree"
```

---

### Task 4: Render worktree groups in the pending panel (`src/reviewPanel.ts`)

**Files:**
- Modify: `src/reviewPanel.ts` (add `WorktreeGroupItem`; feed the registry into `FilteredTreeProvider`)

**Interfaces:**
- Consumes: `WorktreeSessionRegistry` (`getManagers()`, `onChange`) from `./worktreeSessionRegistry`; existing `FileReviewItem`, `isInWorkspace`, `isExcluded`, `isProtected`.
- Produces:
  - `export class WorktreeGroupItem extends vscode.TreeItem` with `worktreeRoot: string`, `sessionManager: SessionManager`, `contextValue = "claudegate.worktreeGroup"`.
  - `FilteredTreeProvider` constructor gains a 4th optional param `worktreeRegistry?: WorktreeSessionRegistry`; the pending root list appends one group per worktree with ≥1 pending file; expanding a group yields that worktree's pending `FileReviewItem`s.

- [ ] **Step 1: Write the failing test** — this behavior is UI-integration (tree items) and is verified manually in Task 6’s F5 check plus a compile/typecheck gate. Add a focused type/shape assertion by extending the existing panel-free logic. Since `FilteredTreeProvider` requires a live VS Code tree host, verify via **typecheck** (no new unit test file):

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npm run typecheck`
Expected (before edits): PASS — establishes a clean baseline to confirm the edits below keep types sound.

- [ ] **Step 2: Add the `WorktreeGroupItem` class** — in `src/reviewPanel.ts`, add this import near the top (after the existing `./sessionManager` import on line 4):

```ts
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
```

and add this class immediately after `SessionItem` (after line 73):

```ts
// ─── Worktree group item (parent window shows a nested worktree's pending) ─────

export class WorktreeGroupItem extends vscode.TreeItem {
  constructor(
    public readonly worktreeRoot: string,
    public readonly sessionManager: SessionManager,
    pendingCount: number
  ) {
    super(`${path.basename(worktreeRoot)} (worktree)`, vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri  = vscode.Uri.file(worktreeRoot);
    this.description  = `${pendingCount} pending`;
    this.tooltip      = new vscode.MarkdownString(
      `**Git worktree**\n\n${worktreeRoot}\n\n${pendingCount} pending file(s) · shown here and in the worktree's own window`
    );
    this.contextValue = "claudegate.worktreeGroup";
    this.iconPath     = new vscode.ThemeIcon("git-branch");
  }
}
```

- [ ] **Step 3: Feed the registry into the provider** — in `src/reviewPanel.ts`, extend the `FilteredTreeProvider` constructor (lines 147-154) to:

```ts
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly status: ReviewStatus,
    initialViewMode: ViewMode = "tree",
    private readonly worktreeRegistry?: WorktreeSessionRegistry
  ) {
    this.viewMode = initialViewMode;
    sessionManager.onSessionChange(() => this._onDidChangeTreeData.fire());
    worktreeRegistry?.onChange(() => this._onDidChangeTreeData.fire());
  }
```

- [ ] **Step 4: Append worktree groups at the pending root and expand them** — in `getChildren`, replace the root block (lines 183-195, the `// Root` comment through its `return this.directChildren(...)`) with:

```ts
    // Root
    if (!element) {
      if (grouped) return [...this.sessionGroups(session), ...this.worktreeGroups()];
      const files = this.filteredFiles(session);
      if (this.viewMode === "list") {
        const ordered = [...files].sort(
          (a, b) =>
            (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
        );
        return [
          ...ordered.map((fp) => new FileReviewItem(fp, this.status, this.sessionManager)),
          ...this.worktreeGroups(),
        ];
      }
      return [
        ...this.directChildren(files, getWorkspaceRoot(files), this.status, false),
        ...this.worktreeGroups(),
      ];
    }

    // Worktree group children (flat list, sourced from the worktree's own session)
    if (element instanceof WorktreeGroupItem) {
      return this.worktreeFiles(element);
    }
```

- [ ] **Step 5: Add the two helper methods** — in `src/reviewPanel.ts`, add these private methods to `FilteredTreeProvider` (e.g. immediately after `filteredFiles`, after line 306):

```ts
  // In-scope pending files of an arbitrary (worktree) session manager.
  private pendingOf(mgr: SessionManager): string[] {
    const s = mgr.getSession();
    if (!s) return [];
    return Object.keys(s.files).filter((fp) => isInWorkspace(fp) && !isExcluded(fp));
  }

  // One group node per attached worktree that currently has pending files.
  private worktreeGroups(): WorktreeGroupItem[] {
    if (this.status !== "pending" || !this.worktreeRegistry) return [];
    const items: WorktreeGroupItem[] = [];
    for (const [root, mgr] of this.worktreeRegistry.getManagers()) {
      const count = this.pendingOf(mgr).length;
      if (count > 0) items.push(new WorktreeGroupItem(root, mgr, count));
    }
    return items.sort((a, b) => a.worktreeRoot.localeCompare(b.worktreeRoot));
  }

  // Flat pending-file rows for one worktree group, bound to its session manager
  // so openDiff/accept/reject resolve against the correct (worktree) session.
  private worktreeFiles(group: WorktreeGroupItem): vscode.TreeItem[] {
    const files = this.pendingOf(group.sessionManager).sort(
      (a, b) => (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
    );
    return files.map((fp) => new FileReviewItem(fp, "pending", group.sessionManager, true));
  }
```

- [ ] **Step 6: Typecheck**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npm run typecheck`
Expected: PASS — no type errors. (Provider now references `WorktreeGroupItem`, `worktreeRegistry`, and the new helpers, all defined above.)

- [ ] **Step 7: Commit**

```bash
git add src/reviewPanel.ts
git commit -m "feat: show nested-worktree pending changes as a group in the pending panel"
```

---

### Task 5: Route actions to the owning session + open-worktree-window (`src/extension.ts`, `src/diffProvider.ts`, `package.json`)

**Files:**
- Modify: `src/diffProvider.ts` (resolve baseline via the owning session; `registerOpenDiff` takes a resolver)
- Modify: `src/extension.ts` (registry lifecycle, `managerFor` router, dispatch, badge, open-window command)
- Modify: `package.json` (`claudegate.openWorktreeWindow` command + menu)

**Interfaces:**
- Consumes: `WorktreeSessionRegistry`, `WorktreeGroupItem`, and the existing `SessionManager` action methods.
- Produces: a router `managerFor(filePath?: string): SessionManager` in `extension.ts`; `registerOpenDiff(context, resolve)`; `ClaudeGateContentProvider(primary, resolveManager)`; command `claudegate.openWorktreeWindow`.

- [ ] **Step 1: Resolver in the content provider** — in `src/diffProvider.ts`, change the `ClaudeGateContentProvider` constructor (lines 17-28) to accept a resolver, defaulting to the primary manager:

```ts
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly resolveManager: (filePath: string) => SessionManager = () => sessionManager
  ) {
    sessionManager.onSessionChange((session) => {
      if (!session) return;
      for (const fp of Object.keys(session.files)) {
        this._onDidChange.fire(originalUri(fp));
      }
      for (const r of [...session.accepted, ...Object.values(session.rejected)]) {
        this._onDidChange.fire(recordUri(r.path, r.id, "before"));
        this._onDidChange.fire(recordUri(r.path, r.id, "after"));
      }
    });
  }
```

- [ ] **Step 2: Resolve pending baseline via the owning session** — in `src/diffProvider.ts` `provideTextDocumentContent`, replace the pending lookup (lines 47-49) with:

```ts
    const owner = this.resolveManager(uri.fsPath).getSession();
    const entry = owner?.files[uri.fsPath];
    if (!entry) return "";
    return entry.originalContent ?? "// New file — no original content";
```

(Record URIs above still resolve against the primary `this.sessionManager` — worktree accepted/rejected history is not shown in the parent, per spec §3.)

- [ ] **Step 3: `registerOpenDiff` takes a resolver** — in `src/reviewPanel.ts`, change `registerOpenDiff` (lines 473-483) to:

```ts
export function registerOpenDiff(
  context: vscode.ExtensionContext,
  resolve: (filePath: string) => SessionManager
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudegate.openDiff",
      (filePath: string) => openDiff(filePath, resolve(filePath))
    )
  );
}
```

- [ ] **Step 4: Create + wire the registry and router in `extension.ts`** — in `src/extension.ts`, add the import (after line 20):

```ts
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
```

then, immediately after `const sessionManager = new SessionManager(log, workspacePath);` (line 108), add:

```ts
    const worktreeRegistry = new WorktreeSessionRegistry(log, workspacePath);
    // Route a file/folder path to its owning session: the worktree it falls under,
    // else the primary window session.
    const managerFor = (p?: string): SessionManager =>
      (p ? worktreeRegistry.managerFor(p) : null) ?? sessionManager;
```

- [ ] **Step 5: Pass the registry to the pending provider and content provider** — in `src/extension.ts`, change the pending provider construction (line 125) to:

```ts
    const pendingProvider  = new FilteredTreeProvider(sessionManager, "pending",  "tree", worktreeRegistry);
```

and change the content-provider registration (lines 130-133) to:

```ts
      vscode.workspace.registerTextDocumentContentProvider(
        SCHEME,
        new ClaudeGateContentProvider(sessionManager, managerFor)
      )
```

- [ ] **Step 6: Dispatch pending file/folder actions to the owning session** — in `src/extension.ts`, update these four command handlers to resolve the manager:
  - `claudegate.acceptFile` (line 250): `sessionManager.acceptFile(filePath);` → `managerFor(filePath).acceptFile(filePath);`
  - `claudegate.rejectFile` (line 266): `sessionManager.rejectFile(filePath);` → `managerFor(filePath).rejectFile(filePath);`
  - `claudegate.acceptFolder` (line 294): `(item: FolderItem) => sessionManager.acceptFolder(item.folderPath)` → `(item: FolderItem) => managerFor(item.folderPath).acceptFolder(item.folderPath)`
  - `claudegate.rejectFolder` (lines 299-318): change the session lookup and the reject call to use the owning manager:

```ts
        async (item: FolderItem) => {
          const mgr = managerFor(item.folderPath);
          const session = mgr.getSession();
          const pendingFiles = Object.entries(session?.files ?? {})
            .filter(
              ([fp, e]) =>
                fp.startsWith(item.folderPath + path.sep) &&
                e.reviewStatus === "pending"
            )
            .map(([fp]) => fp);
          if (pendingFiles.length === 0) return;
          const answer = await vscode.window.showWarningMessage(
            `Revert ${pendingFiles.length} file(s) in "${path.basename(item.folderPath)}" to their original content?`,
            { modal: false },
            "Revert"
          );
          if (answer === "Revert") {
            mgr.rejectFolder(item.folderPath);
            await Promise.all(pendingFiles.map((fp) => closeDiffEditor(fp)));
          }
        }
```

(Accept/reject **All** and the accepted/rejected-log commands stay on the primary `sessionManager` — worktree groups have per-file/folder actions only, and the worktree's own window owns its bulk/log actions.)

- [ ] **Step 7: Point `registerOpenDiff` at the router** — in `src/extension.ts`, change the call (line 499) from `registerOpenDiff(context, sessionManager);` to:

```ts
    registerOpenDiff(context, managerFor);
```

- [ ] **Step 8: Include worktree pending in the badge, and refresh on registry change** — in `src/extension.ts`, inside the `sessionManager.onSessionChange((session) => { ... })` counter, after the `for (const fp of Object.keys(session.files)) { ... }` loop closes (line 540) and **before** the `accepted = session.accepted.filter(...)` line (541), insert one line:

```ts
      pending += worktreeRegistry.totalPending();
```

Then, after `sessionManager.startWatching();` (line 572), add:

```ts
    worktreeRegistry.refresh();
    // A worktree session changing (or worktrees added/removed) re-runs the primary
    // counter (badge) via notifyChanged; the providers refresh via onChange directly.
    context.subscriptions.push(worktreeRegistry.onChange(() => sessionManager.notifyChanged()));
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((e) => { if (e.focused) worktreeRegistry.refresh(); })
    );
    context.subscriptions.push({ dispose: () => worktreeRegistry.dispose() });
```

- [ ] **Step 9: Register the open-worktree-window command** — in `src/extension.ts`, add the import for the item type (extend the existing `./reviewPanel` import block, lines 6-12, to include `WorktreeGroupItem`), then add this command inside the main `context.subscriptions.push( ... )` command list (e.g. after the `claudegate.reviewAllPending` command, before the closing `);` on line 497):

```ts
      vscode.commands.registerCommand(
        "claudegate.openWorktreeWindow",
        (item: WorktreeGroupItem) => {
          if (!item?.worktreeRoot) return;
          void vscode.commands.executeCommand(
            "vscode.openFolder",
            vscode.Uri.file(item.worktreeRoot),
            { forceNewWindow: true }
          );
        }
      ),
```

- [ ] **Step 10: Add the command + menu to `package.json`** — in `contributes.commands`, add:

```json
    {
      "command": "claudegate.openWorktreeWindow",
      "title": "Open Worktree in New Window",
      "category": "Claude Gate",
      "icon": "$(empty-window)"
    }
```

in `contributes.menus["view/item/context"]`, add:

```json
    {
      "command": "claudegate.openWorktreeWindow",
      "when": "view == claudegate.pendingPanel && viewItem == claudegate.worktreeGroup",
      "group": "inline@1"
    }
```

and in `contributes.menus.commandPalette`, hide it from the palette (it needs an item arg):

```json
    {
      "command": "claudegate.openWorktreeWindow",
      "when": "false"
    }
```

- [ ] **Step 11: Typecheck, build, and full test suite**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && npm run typecheck && npm run compile && npm test`
Expected: PASS — typecheck clean, bundle written to `out/extension.js`, all unit tests print their `ok - …` lines, and the Python hook suite passes.

- [ ] **Step 12: Validate `package.json` is well-formed**

Run: `cd /home/tuvan/Documents/src/personal/claudegate && node -e "require('./package.json'); console.log('package.json OK')"`
Expected: `package.json OK` (no JSON parse error from the added entries).

- [ ] **Step 13: Commit**

```bash
git add src/extension.ts src/diffProvider.ts src/reviewPanel.ts package.json
git commit -m "feat: dispatch worktree review actions to the owning session + open-worktree-window"
```

---

### Task 6: End-to-end verification in the Extension Development Host

**Files:** none (manual verification with a real worktree)

- [ ] **Step 1: Create a scratch repo with a nested worktree**

```bash
tmp=$(mktemp -d); cd "$tmp" && git init -q proj && cd proj && \
  echo base > a.txt && git add . && git commit -qm init && \
  git worktree add -q ws-feature -b feature && echo "worktree at $tmp/proj/ws-feature"
```

- [ ] **Step 2: Launch the Extension Development Host** — open `/home/tuvan/Documents/src/personal/claudegate` in VS Code, press **F5**, and in the dev host open the folder `"$tmp/proj"` (the parent repo only). Ensure **Setup Hook** has been run so `~/.claudegate/hook.py` is current (re-run `Claude Gate: Setup Hook` in the dev host to copy the updated hook).

- [ ] **Step 3: Simulate a Claude edit inside the worktree** — from a terminal, fire the hook for a file under the worktree:

```bash
echo '{"tool_name":"Write","cwd":"'"$tmp"'/proj","tool_input":{"file_path":"'"$tmp"'/proj/ws-feature/x.txt"}}' \
  | python3 ~/.claudegate/hook.py
printf 'changed\n' > "$tmp/proj/ws-feature/x.txt"
```

Expected: the Pending panel shows a `ws-feature (worktree)` group with `x.txt` under it, carrying inline Accept/Reject actions, plus the group’s inline **Open Worktree in New Window** action. Confirm the session landed in the worktree’s file: `ls ~/.claudegate/sessions/` and verify a file hashed from `$tmp/proj/ws-feature` exists (not only the parent’s).

- [ ] **Step 4: Verify actions target the worktree session** — click the file to open the diff (baseline `base`/empty ↔ `changed`), then click **Accept**. Expected: the row disappears; the accepted record is written to the **worktree’s** session file (check that the parent session’s `accepted[]` did NOT gain the entry). Reject on a second edit restores the file. 

- [ ] **Step 5: Verify the open-window action** — click **Open Worktree in New Window** on the group. Expected: a new window opens on `$tmp/proj/ws-feature`; its own Pending panel shows the same pending file (same record), and accepting there clears it in both windows.

- [ ] **Step 6: Clean up**

```bash
rm -rf "$tmp"
```

- [ ] **Step 7: Record the verification result** — note pass/fail for Steps 3–5 in the PR/commit description. If any step fails, use superpowers:systematic-debugging before patching.

---

## Self-Review

**1. Spec coverage:**
- §1 goal (deterministic canonical routing) → Task 2. Visible-in-parent with full actions → Tasks 3–5. Single decision syncs both windows → Task 3 (reused SessionManager on one file) + Task 5 dispatch; verified in Task 6 Step 5. Open-worktree-window → Task 5 Steps 9–10, Task 6 Step 5.
- §5 detection contract (worktree vs submodule; `.git` file vs dir; nested-under-root) → Task 1 + Task 2 (both sides implement the same rule; submodule explicitly excluded and tested).
- §6 architecture (registry attaches reused SessionManager; router dispatch; content-provider resolution) → Tasks 3, 4, 5.
- §8 concurrency/perf (reuse lock/merge; watch small session files; detect once + on focus; cap+log) → Task 3 (`MAX_ATTACHED_WORKTREES`, reuse of SessionManager), Task 5 Step 8 (refresh on focus, not polling).
- §3/§Non-goals (pending-only in parent; no migration; no git binary; fail-open) → Task 4 (`status !== "pending"` guard on `worktreeGroups`), Global Constraints, Task 2 (`worktree_root_for_file` fail-open), Task 1 (filesystem-only).

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every run step gives an exact command and expected output. Task 4 Step 1 intentionally uses a typecheck baseline rather than a fake VS Code tree host (documented reason), with behavior verified end-to-end in Task 6.

**3. Type consistency:** `managerFor(p?: string): SessionManager` is used identically in `extension.ts` dispatch and passed as the `resolve`/`resolveManager` callback (`(filePath: string) => SessionManager`); the default arg in `ClaudeGateContentProvider`/`registerOpenDiff` matches that signature. `WorktreeGroupItem.sessionManager` (a `SessionManager`) is what `FileReviewItem`'s 3rd arg and `worktreeFiles` consume. `WorktreeSessionRegistry.getManagers()` returns `Map<string, SessionManager>`, iterated as `[root, mgr]` in `worktreeGroups`. `managerFor`/`totalPending`/`onChange`/`refresh`/`dispose` names match between Task 3 (definition) and Task 5 (use).
