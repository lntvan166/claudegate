# Edit-before-accept Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Accept, save any dirty editor for the affected pending file(s) before the accept reads disk, so edits made in the diff's right pane are not silently lost.

**Architecture:** A new async helper `saveDirtyPending(scope)` saves open dirty documents whose path is in `scope`. The four already-async accept command handlers in `extension.ts` call it before delegating to the synchronous `SessionManager` accept methods (Approach A — save at the vscode boundary). `SessionManager`, `readFileOrNull`, reject, and the session schema are untouched.

**Tech Stack:** TypeScript, VS Code extension API, esbuild-bundled node `assert` unit tests, hand-written `vscode` test stub.

## Global Constraints

- Each new `src/*.test.ts` MUST be appended to the `test:unit` script in `package.json` or it won't run.
- Tests importing `vscode`-dependent modules bundle with `--alias:vscode=./src/test-stubs/vscode.ts`.
- Case-tolerant path matching MUST use win32-only lowercasing (`process.platform === "win32"`), matching the codebase convention in `src/workspaceScope.ts` (`pathIsUnder`) and `src/reviewModel.ts` (`fileEntryFor`). Never lowercase on non-Windows.
- Do NOT bump the version, edit `CHANGELOG.md`, tag, or publish — releasing is gated behind the `release` skill.
- Reject paths (`rejectFile`, `rejectCurrent`, `rejectFolder`, `rejectAll`) MUST NOT be modified.

---

### Task 1: `saveDirtyPending` helper + unit test

**Files:**
- Create: `src/saveEdits.ts`
- Test: `src/saveEdits.test.ts`
- Modify: `src/test-stubs/vscode.ts` (add `workspace.textDocuments`)
- Modify: `package.json` (append test to `test:unit`)

**Interfaces:**
- Produces: `export async function saveDirtyPending(scope: Iterable<string>): Promise<void>` — saves every open `vscode.workspace.textDocuments` entry that `isDirty` and whose `uri.fsPath` is in `scope` (win32-case-tolerant). Resolves after all `save()` calls settle.

- [ ] **Step 1: Extend the vscode test stub with `textDocuments`**

In `src/test-stubs/vscode.ts`, add a mutable `textDocuments` array to the exported `workspace` object so tests can inject fake documents. Change the `workspace` const (currently starting at line 27) to include the field:

```ts
export const workspace = {
  workspaceFolders: undefined as readonly { uri: { fsPath: string } }[] | undefined,
  // Mutable so unit tests can inject fake documents ({ isDirty, uri:{fsPath}, save() }).
  textDocuments: [] as Array<{ isDirty: boolean; uri: { fsPath: string }; save: () => Thenable<boolean> }>,
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, def?: T): T | undefined => def,
  }),
  asRelativePath: (p: string): string => p,
};
```

- [ ] **Step 2: Write the failing test**

Create `src/saveEdits.test.ts`:

```ts
import assert from "node:assert";
import { workspace } from "./test-stubs/vscode";
import { saveDirtyPending } from "./saveEdits";

function run(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve()
    .then(fn)
    .then(() => console.log("ok -", name))
    .catch((e) => {
      console.error("FAIL -", name);
      console.error(e);
      process.exitCode = 1;
    });
}

type FakeDoc = { isDirty: boolean; uri: { fsPath: string }; save: () => Promise<boolean>; saved: boolean };
function doc(fsPath: string, isDirty: boolean): FakeDoc {
  const d: FakeDoc = {
    isDirty,
    uri: { fsPath },
    saved: false,
    save: async () => {
      d.saved = true;
      return true;
    },
  };
  return d;
}

run("saves a dirty in-scope document", async () => {
  const a = doc("/repo/a.ts", true);
  const b = doc("/repo/b.ts", true);
  workspace.textDocuments = [a, b];
  await saveDirtyPending(["/repo/a.ts"]);
  assert.equal(a.saved, true, "in-scope dirty doc should be saved");
  assert.equal(b.saved, false, "out-of-scope dirty doc must not be saved");
});

run("does not save a clean in-scope document", async () => {
  const a = doc("/repo/a.ts", false);
  workspace.textDocuments = [a];
  await saveDirtyPending(["/repo/a.ts"]);
  assert.equal(a.saved, false, "clean doc must not be saved");
});

run("win32 drive-letter case mismatch still matches", async () => {
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const a = doc("C:\\repo\\A.ts", true);
    workspace.textDocuments = [a];
    await saveDirtyPending(["c:\\repo\\a.ts"]);
    assert.equal(a.saved, true, "case-folded match should save on win32");
  } finally {
    Object.defineProperty(process, "platform", { value: orig, configurable: true });
  }
});

run("empty scope saves nothing", async () => {
  const a = doc("/repo/a.ts", true);
  workspace.textDocuments = [a];
  await saveDirtyPending([]);
  assert.equal(a.saved, false, "nothing in scope → no saves");
});

console.log("done");
```

- [ ] **Step 3: Append the test to `test:unit` in `package.json`**

Append this to the end of the `test:unit` script string (before the closing quote), joined with ` && `. It needs the vscode alias:

```
 && esbuild src/saveEdits.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/saveEdits.test.cjs && node out/saveEdits.test.cjs
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm run test:unit 2>&1 | tail -20`
Expected: FAIL — esbuild cannot resolve `./saveEdits` (module does not exist yet), or a runtime error for missing `saveDirtyPending`.

- [ ] **Step 5: Write the minimal implementation**

Create `src/saveEdits.ts`:

```ts
import * as vscode from "vscode";

// Saves any open, dirty text documents whose path is in `scope`, then resolves.
// Used by the Accept command handlers so edits made in the diff's editable right
// pane are flushed to disk before the (synchronous) accept reads disk content.
// Case-tolerant on win32 only: hook-stored session keys can differ in
// drive-letter case from a document's uri.fsPath.
export async function saveDirtyPending(scope: Iterable<string>): Promise<void> {
  const caseInsensitive = process.platform === "win32";
  const fold = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);
  const want = new Set<string>();
  for (const p of scope) want.add(fold(p));
  if (want.size === 0) return;

  const dirty = vscode.workspace.textDocuments.filter(
    (d) => d.isDirty && want.has(fold(d.uri.fsPath))
  );
  await Promise.all(dirty.map((d) => Promise.resolve(d.save())));
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test:unit 2>&1 | tail -20`
Expected: PASS — lines `ok - saves a dirty in-scope document`, `ok - does not save a clean in-scope document`, `ok - win32 drive-letter case mismatch still matches`, `ok - empty scope saves nothing`, and no `FAIL`.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/saveEdits.ts src/saveEdits.test.ts src/test-stubs/vscode.ts package.json
git commit -m "feat: saveDirtyPending helper to flush edits before accept"
```

---

### Task 2: Wire `saveDirtyPending` into the four Accept handlers

**Files:**
- Modify: `src/extension.ts` (handlers at ~344, ~366, ~388, ~470)

**Interfaces:**
- Consumes: `saveDirtyPending(scope: Iterable<string>): Promise<void>` from Task 1.

- [ ] **Step 1: Import the helper**

At the top of `src/extension.ts`, add alongside the existing imports:

```ts
import { saveDirtyPending } from "./saveEdits";
```

- [ ] **Step 2: `acceptFile` handler — save before accept**

In the `claudegate.acceptFile` handler (currently extension.ts:343-351), add the save after the `if (!filePath) return;` guard and before the accept:

```ts
      vscode.commands.registerCommand(
        "claudegate.acceptFile",
        async (item?: FileReviewItem | { filePath: string }) => {
          const filePath = item?.filePath ?? getActivePendingFilePath(managerFor);
          if (!filePath) return;
          await saveDirtyPending([filePath]);
          managerFor(filePath).acceptFile(filePath);
          await closeDiffEditor(filePath);
        }
      ),
```

- [ ] **Step 3: `acceptCurrent` handler — save before accept**

In the `claudegate.acceptCurrent` handler (currently extension.ts:366-374), add the save after the `if (!fp) return;` guard:

```ts
      vscode.commands.registerCommand("claudegate.acceptCurrent", async () => {
        const fp = getActivePendingFilePath(managerFor);
        if (!fp) return;
        await saveDirtyPending([fp]);
        managerFor(fp).acceptFile(fp);
        await closeDiffEditor(fp);
        if (vscode.workspace.getConfiguration("claudegate").get<boolean>("autoAdvance", true)) {
          await openNextPending();
        }
      }),
```

- [ ] **Step 4: `acceptFolder` handler — make async, derive scope, save before accept**

Replace the `claudegate.acceptFolder` handler (currently extension.ts:388-391, a non-async one-liner) with an async version that computes the pending paths under the folder (mirroring the filter `rejectFolder` uses at extension.ts:398-404) and saves them first:

```ts
      vscode.commands.registerCommand(
        "claudegate.acceptFolder",
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
          await saveDirtyPending(pendingFiles);
          mgr.acceptFolder(item.folderPath);
        }
      ),
```

- [ ] **Step 5: `acceptAll` handler — save the pending set before accept**

In the `claudegate.acceptAll` handler (currently extension.ts:470-483), add the save after the `if (pending.length === 0) return;` guard, before `sessionManager.acceptAll()`:

```ts
      vscode.commands.registerCommand("claudegate.acceptAll", async () => {
        const session = sessionManager.getSession();
        const pending = session
          ? Object.entries(session.files).filter(
              ([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp)
            )
          : [];
        if (pending.length === 0) return;
        await saveDirtyPending(pending.map(([fp]) => fp));
        sessionManager.acceptAll();
        await Promise.all(pending.map(([fp]) => closeDiffEditor(fp)));
        vscode.window.showInformationMessage(`Claude Gate: accepted ${pending.length} file(s).`);
      }),
```

- [ ] **Step 6: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: no errors; `out/extension.js` is emitted.

- [ ] **Step 7: Run the full test suite (nothing regressed)**

Run: `npm test 2>&1 | tail -25`
Expected: all unit tests print `ok - …` with no `FAIL`, and the Python hook tests pass (`OK`).

- [ ] **Step 8: Manual verification in the Extension Development Host**

This change has runtime behavior a unit test can't cover (real editors + accept). In VS Code, press **F5** to launch the Extension Development Host, then:

1. Make Claude Code edit a file so it appears in the **Pending** panel.
2. Open its diff (click the pending row). In the **right** pane, type an extra change. Do **not** save.
3. Click **Accept** on that file.
4. Open the **Accepted** panel row's diff and confirm the `after` side includes your manual edit; confirm the on-disk file also contains it.
5. Repeat once for a **new file** (created by Claude) — edit before accepting, confirm the edit persists.
6. With two edited-but-unsaved pending files, run **Accept All** and confirm both accepted records include the manual edits.

Expected: in every case the accepted content and the on-disk file include the unsaved edit (previously it would have been lost).

- [ ] **Step 9: Commit**

```bash
git add src/extension.ts
git commit -m "feat: flush unsaved edits before Accept in all accept commands"
```

---

## Notes for the implementer

- **Reject is intentionally untouched.** Reject means "discard Claude's change," so discarding unsaved edits with it is correct. Do not add saves to any reject handler.
- **No discoverability UI** (title hint / toast) — explicitly out of scope (YAGNI).
- If `d.save()` rejects (e.g. read-only file), `Promise.all` rejects and the handler's `await` throws before the accept runs, so stale content is never accepted. This matches the "don't lose edits" intent; no extra handling is required for this iteration.
