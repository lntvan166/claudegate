# Keyboard Review Stepper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add next/previous-pending navigation (⌥+] / ⌥+[) and a "N of M pending" progress suffix to ClaudeGate's one-at-a-time review flow, without a modal mode.

**Architecture:** Pure navigation math lives in a vscode-free module `src/reviewNav.ts` (unit-tested). A thin `src/pendingPaths.ts` builds the canonical ordered pending list from a `SessionManager` (single source of truth). `src/extension.ts` refactors `openNextPending` onto that helper and registers two commands; `src/diffProvider.ts` appends the progress suffix in `openDiff`. Keybindings/commands go in `package.json`.

**Tech Stack:** TypeScript, VS Code extension API, esbuild-bundled node `assert` unit tests.

## Global Constraints

- Each new `src/*.test.ts` MUST be appended to the `test:unit` script in `package.json` or it won't run.
- `src/reviewNav.ts` MUST be vscode-free (its test bundles WITHOUT the `--alias:vscode` flag).
- Navigation ordering is alphabetical by path via `localeCompare` — identical to the ordering `openNextPending` uses today. Next/prev and the progress count MUST use the same ordered list so they never disagree.
- Default keybindings use `alt+]` / `alt+[` (⌥ on mac === `alt` in VS Code keybinding syntax; one `key` field covers all platforms — do NOT add a `mac` override), gated `when: "claudegate.activeFileIsPending"`. Chosen so they do NOT clobber ⌘+]/⌘+[ indent in the editable right pane.
- Do NOT modify `SessionManager`, accept/reject logic, `autoAdvance`, the multi-diff (Review All) view, or the session schema.
- Do NOT bump the version, edit `CHANGELOG.md`, tag, or publish — releasing is gated behind the `release` skill.

---

### Task 1: `reviewNav.ts` pure navigation module + unit test

**Files:**
- Create: `src/reviewNav.ts`
- Test: `src/reviewNav.test.ts`
- Modify: `package.json` (append test to `test:unit`)

**Interfaces:**
- Produces:
  - `orderPending(paths: string[]): string[]` — returns a new array sorted by `localeCompare`.
  - `type Step = { target: string } | { atEnd: "first" | "last" } | { empty: true }`
  - `stepPending(ordered: string[], current: string | undefined, dir: 1 | -1): Step`
  - `pendingProgress(ordered: string[], path: string): { index: number; total: number } | undefined` — 1-based index.

- [ ] **Step 1: Write the failing test**

Create `src/reviewNav.test.ts`:

```ts
import assert from "node:assert";
import { orderPending, stepPending, pendingProgress } from "./reviewNav";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log("ok -", name);
  } catch (e) {
    console.error("FAIL -", name);
    console.error(e);
    process.exitCode = 1;
  }
}

run("orderPending sorts by localeCompare and does not mutate input", () => {
  const input = ["/b.ts", "/a.ts", "/c.ts"];
  assert.deepEqual(orderPending(input), ["/a.ts", "/b.ts", "/c.ts"]);
  assert.deepEqual(input, ["/b.ts", "/a.ts", "/c.ts"], "input must be untouched");
});

run("stepPending: mid-list neighbors", () => {
  const o = ["/a", "/b", "/c"];
  assert.deepEqual(stepPending(o, "/b", 1), { target: "/c" });
  assert.deepEqual(stepPending(o, "/b", -1), { target: "/a" });
});

run("stepPending: stops at the ends", () => {
  const o = ["/a", "/b", "/c"];
  assert.deepEqual(stepPending(o, "/c", 1), { atEnd: "last" });
  assert.deepEqual(stepPending(o, "/a", -1), { atEnd: "first" });
});

run("stepPending: current undefined opens first (next) or last (prev)", () => {
  const o = ["/a", "/b", "/c"];
  assert.deepEqual(stepPending(o, undefined, 1), { target: "/a" });
  assert.deepEqual(stepPending(o, undefined, -1), { target: "/c" });
});

run("stepPending: current not in list behaves like undefined", () => {
  const o = ["/a", "/b"];
  assert.deepEqual(stepPending(o, "/gone", 1), { target: "/a" });
  assert.deepEqual(stepPending(o, "/gone", -1), { target: "/b" });
});

run("stepPending: empty list", () => {
  assert.deepEqual(stepPending([], undefined, 1), { empty: true });
  assert.deepEqual(stepPending([], "/a", -1), { empty: true });
});

run("stepPending: single element reports atEnd both directions", () => {
  const o = ["/only"];
  assert.deepEqual(stepPending(o, "/only", 1), { atEnd: "last" });
  assert.deepEqual(stepPending(o, "/only", -1), { atEnd: "first" });
});

run("pendingProgress: 1-based index and total, undefined when absent", () => {
  const o = ["/a", "/b", "/c"];
  assert.deepEqual(pendingProgress(o, "/a"), { index: 1, total: 3 });
  assert.deepEqual(pendingProgress(o, "/c"), { index: 3, total: 3 });
  assert.equal(pendingProgress(o, "/missing"), undefined);
});

console.log("done");
```

- [ ] **Step 2: Append the test to `test:unit` in `package.json`**

Append to the end of the `test:unit` script string (joined with ` && `). NO vscode alias (module is pure):

```
 && esbuild src/reviewNav.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewNav.test.cjs && node out/reviewNav.test.cjs
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:unit 2>&1 | tail -20`
Expected: FAIL — esbuild cannot resolve `./reviewNav` (module does not exist yet).

- [ ] **Step 4: Write the implementation**

Create `src/reviewNav.ts`:

```ts
// Pure navigation math for the one-at-a-time review stepper. No VS Code deps,
// so it unit-tests without a host. The caller supplies already-resolved paths;
// comparison here is exact-string.

export function orderPending(paths: string[]): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export type Step =
  | { target: string }
  | { atEnd: "first" | "last" }
  | { empty: true };

// Given the ordered pending list, the currently-open pending path (or undefined),
// and a direction (+1 next / -1 prev), decide where to go.
export function stepPending(ordered: string[], current: string | undefined, dir: 1 | -1): Step {
  if (ordered.length === 0) return { empty: true };
  const i = current === undefined ? -1 : ordered.indexOf(current);
  if (i === -1) return { target: dir === 1 ? ordered[0] : ordered[ordered.length - 1] };
  const j = i + dir;
  if (j < 0) return { atEnd: "first" };
  if (j >= ordered.length) return { atEnd: "last" };
  return { target: ordered[j] };
}

// 1-based position of `path` within the ordered list, plus the total.
export function pendingProgress(
  ordered: string[],
  path: string
): { index: number; total: number } | undefined {
  const i = ordered.indexOf(path);
  return i === -1 ? undefined : { index: i + 1, total: ordered.length };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:unit 2>&1 | tail -20`
Expected: PASS — all `ok - …` lines for reviewNav, no `FAIL`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/reviewNav.ts src/reviewNav.test.ts package.json
git commit -m "feat: reviewNav pure module (orderPending/stepPending/pendingProgress)"
```

---

### Task 2: `pendingPaths.ts` shared list + next/prev commands + keybindings

**Files:**
- Create: `src/pendingPaths.ts`
- Modify: `src/extension.ts` (refactor `openNextPending`; register two commands; add imports)
- Modify: `package.json` (`contributes.commands`, `contributes.keybindings`)

**Interfaces:**
- Consumes: `orderPending`, `stepPending` from `src/reviewNav.ts` (Task 1).
- Produces: `orderedPendingPaths(mgr: SessionManager): string[]` — the canonical ordered pending list (pending + in-workspace + not-excluded + real on-disk change, sorted). Reused by Task 3.

- [ ] **Step 1: Create the shared helper**

Create `src/pendingPaths.ts`:

```ts
import { isInWorkspace, isExcluded } from "./workspaceScope";
import { SessionManager } from "./sessionManager";
import { orderPending } from "./reviewNav";

// Canonical ordered list of pending files for the stepper and the diff-title
// progress count. Same filter + ordering openNextPending used inline, extracted
// so navigation, auto-advance, and the "N of M" progress can never disagree.
export function orderedPendingPaths(mgr: SessionManager): string[] {
  const session = mgr.getSession();
  if (!session) return [];
  const paths = Object.keys(session.files).filter(
    (fp) =>
      session.files[fp].reviewStatus === "pending" &&
      isInWorkspace(fp) &&
      !isExcluded(fp) &&
      mgr.hasRealPendingChange(fp)
  );
  return orderPending(paths);
}
```

- [ ] **Step 2: Add imports to `src/extension.ts`**

Alongside the existing imports at the top of `src/extension.ts`:

```ts
import { orderedPendingPaths } from "./pendingPaths";
import { stepPending } from "./reviewNav";
```

- [ ] **Step 3: Refactor `openNextPending` onto the shared helper**

Replace the current `openNextPending` closure (extension.ts:301-320) with:

```ts
    const orderedPending = (): string[] => orderedPendingPaths(sessionManager);

    const openNextPending = async (): Promise<void> => {
      const next = orderedPending()[0];
      if (next) {
        await vscode.commands.executeCommand("claudegate.openDiff", next);
      } else {
        vscode.window.showInformationMessage("Claude Gate: all caught up ✓");
      }
    };
```

- [ ] **Step 4: Register the two navigation commands**

In the command-registration block, immediately after the `claudegate.rejectCurrent` handler (extension.ts:378-385, ends near line 385), add:

```ts
      vscode.commands.registerCommand("claudegate.nextPending", async () => {
        const step = stepPending(orderedPending(), getActivePendingFilePath(managerFor), 1);
        if ("target" in step) {
          await vscode.commands.executeCommand("claudegate.openDiff", step.target);
        } else if ("atEnd" in step) {
          vscode.window.showInformationMessage(
            step.atEnd === "last"
              ? "Claude Gate: last pending file"
              : "Claude Gate: first pending file"
          );
        } else {
          vscode.window.showInformationMessage("Claude Gate: all caught up ✓");
        }
      }),
      vscode.commands.registerCommand("claudegate.prevPending", async () => {
        const step = stepPending(orderedPending(), getActivePendingFilePath(managerFor), -1);
        if ("target" in step) {
          await vscode.commands.executeCommand("claudegate.openDiff", step.target);
        } else if ("atEnd" in step) {
          vscode.window.showInformationMessage(
            step.atEnd === "first"
              ? "Claude Gate: first pending file"
              : "Claude Gate: last pending file"
          );
        } else {
          vscode.window.showInformationMessage("Claude Gate: all caught up ✓");
        }
      }),
```

- [ ] **Step 5: Add commands to `package.json` `contributes.commands`**

Add these two objects to the `contributes.commands` array (anywhere in it):

```json
{ "command": "claudegate.nextPending", "title": "Claude Gate: Next Pending File" },
{ "command": "claudegate.prevPending", "title": "Claude Gate: Previous Pending File" }
```

- [ ] **Step 6: Add keybindings to `package.json` `contributes.keybindings`**

Add these two objects to the `contributes.keybindings` array:

```json
{ "command": "claudegate.nextPending", "key": "alt+]", "when": "claudegate.activeFileIsPending" },
{ "command": "claudegate.prevPending", "key": "alt+[", "when": "claudegate.activeFileIsPending" }
```

- [ ] **Step 7: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: no errors; `out/extension.js` emitted.

- [ ] **Step 8: Run the full test suite (nothing regressed)**

Run: `npm test 2>&1 | tail -25`
Expected: all unit tests `ok - …`, hook tests `OK`, no `FAIL`.

- [ ] **Step 9: Manual verification (F5)**

Press **F5** to launch the Extension Development Host:
1. Have Claude Code produce ≥3 pending files. Open one pending diff.
2. Press **⌥+]** → the next pending file's diff opens; review state unchanged. **⌥+[** → previous.
3. On the last pending file, **⌥+]** shows "Claude Gate: last pending file" and stays. On the first, **⌥+[** shows "first pending file".
4. In the editable right pane, confirm **⌘+]** / **⌘+[** still indent/outdent (not clobbered).

Expected: navigation works, ends stop with a hint, indent keys intact.

- [ ] **Step 10: Commit**

```bash
git add src/pendingPaths.ts src/extension.ts package.json
git commit -m "feat: next/prev pending navigation commands + alt+bracket keybindings"
```

---

### Task 3: Progress suffix in the diff title

**Files:**
- Modify: `src/diffProvider.ts` (`openDiff`, add imports)

**Interfaces:**
- Consumes: `orderedPendingPaths` from `src/pendingPaths.ts` (Task 2), `pendingProgress` from `src/reviewNav.ts` (Task 1).

- [ ] **Step 1: Add imports to `src/diffProvider.ts`**

Alongside the existing imports at the top of `src/diffProvider.ts`:

```ts
import { pendingProgress } from "./reviewNav";
import { orderedPendingPaths } from "./pendingPaths";
```

- [ ] **Step 2: Append the progress suffix in `openDiff`**

In `openDiff` (diffProvider.ts:120), the title is currently built as:

```ts
  const title =
    entry.originalContent === null
      ? `Claude Gate: ${label}  (new file${suffix})`
      : `Claude Gate: ${label}  (original ↔ current${suffix})`;
```

Replace it with a version that appends the pending position (computed from the same manager `openDiff` was given):

```ts
  const prog = pendingProgress(orderedPendingPaths(sessionManager), filePath);
  const progSuffix = prog ? `  ·  ${prog.index} of ${prog.total} pending` : "";
  const title =
    (entry.originalContent === null
      ? `Claude Gate: ${label}  (new file${suffix})`
      : `Claude Gate: ${label}  (original ↔ current${suffix})`) + progSuffix;
```

- [ ] **Step 3: Typecheck and compile**

Run: `npm run typecheck && npm run compile`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: all `ok - …` / `OK`, no `FAIL`.

- [ ] **Step 5: Manual verification (F5)**

Press **F5**:
1. With ≥3 pending files, open one diff → its tab title shows `· N of M pending` (e.g. `· 2 of 3 pending`).
2. Step with ⌥+] / ⌥+[ → the `N` updates to match position.
3. Accept one file → remaining diffs show the smaller `M` total.

Expected: title reflects the correct 1-based position and shrinking total.

- [ ] **Step 6: Commit**

```bash
git add src/diffProvider.ts
git commit -m "feat: show 'N of M pending' progress in the diff title"
```

---

## Notes for the implementer

- **Single ordering source:** `orderedPendingPaths` (Task 2) is the ONLY place the pending filter/sort lives after Task 2. Do not re-inline the filter in `openDiff` or the commands — call the helper.
- **No modal / single-key mode** — out of scope by design (collides with the editable right pane). Only chord keybindings.
- **`Step` discrimination:** use `"target" in step` / `"atEnd" in step` (as shown). Do not add a `kind` field — the union has none.
- **Keybindings:** one `key: "alt+]"` field covers mac (⌥) and win/linux (Alt); do NOT add a `mac` override, and do NOT use `cmd+]`/`ctrl+]` (those clobber indent in the now-editable right pane).
