# Review All Pending (Multi-File Diff) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Review All Pending` command that opens every pending Claude change in VS Code's multi-file diff editor (view-only).

**Architecture:** A single `claudegate.reviewAllPending` command builds `[resourceUri, originalUri, modifiedUri]` tuples for the filtered/sorted pending files and calls the built-in `vscode.changes` multi-diff command, reusing the existing `originalUri` content provider. Surfaced via a Pending-panel title button + command palette.

**Tech Stack:** TypeScript (VS Code extension, esbuild + tsc). No new dependencies. Verification: typecheck/compile + manual (the command is `vscode`-coupled and semi-internal).

## Global Constraints

- **No new dependencies.**
- **View-only** — no accept/reject inside the multi-diff.
- **`vscode.changes` is semi-internal** — call via `executeCommand`, wrapped in try/catch with a graceful warning fallback.
- **Reuse** `originalUri` (left = `claudegate:` baseline), `Uri.file(fp)` (right = current), and the `pending ∧ isInWorkspace ∧ !isExcluded` filter; order protected-first then by path.
- **Folds into unreleased `1.3.0`** — extend the existing `## [1.3.0]` CHANGELOG entry; no version bump.
- **TypeScript verification** — `npm run typecheck` and `npm run compile` must pass.

---

## File Structure

- `src/extension.ts` — MODIFY: register `claudegate.reviewAllPending`; import `originalUri`.
- `package.json` — MODIFY: declare the command + Pending-panel title menu entry.
- `README.md`, `CHANGELOG.md` — MODIFY: docs (Task 2).

---

## Task 1: `Review All Pending` command + menu

**Files:**
- Modify: `src/extension.ts` (import `originalUri`; register the command)
- Modify: `package.json` (command + `view/title` menu)

**Interfaces:**
- Consumes: `originalUri(filePath)` from `./diffProvider`; `sessionManager.getSession()`; `isInWorkspace`/`isExcluded`/`isProtected` (already imported in extension.ts).
- Produces: command `claudegate.reviewAllPending`.

- [ ] **Step 1: Declare the command in `package.json`**

Add to `contributes.commands`:

```json
{ "command": "claudegate.reviewAllPending", "title": "Claude Gate: Review All Pending", "icon": "$(diff-multiple)" }
```

- [ ] **Step 2: Add the Pending-panel title button in `package.json`**

Add to `contributes.menus.view/title`:

```json
{ "command": "claudegate.reviewAllPending", "when": "view == claudegate.pendingPanel", "group": "navigation@5" }
```

- [ ] **Step 3: Import `originalUri` in `src/extension.ts`**

The extension imports from `./diffProvider` already (`ClaudeGateContentProvider, SCHEME`). Add `originalUri` to that import:

```typescript
import { ClaudeGateContentProvider, SCHEME, originalUri } from "./diffProvider";
```

- [ ] **Step 4: Register the command in `src/extension.ts`**

Inside the existing `context.subscriptions.push( ... )` command block, add:

```typescript
      vscode.commands.registerCommand("claudegate.reviewAllPending", async () => {
        const session = sessionManager.getSession();
        const paths = session
          ? Object.entries(session.files)
              .filter(([fp, e]) => e.reviewStatus === "pending" && isInWorkspace(fp) && !isExcluded(fp))
              .map(([fp]) => fp)
              .sort(
                (a, b) =>
                  (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
              )
          : [];
        if (paths.length === 0) {
          vscode.window.showInformationMessage("Claude Gate: no pending changes to review.");
          return;
        }
        const resourceList = paths.map((fp) => [
          vscode.Uri.file(fp),
          originalUri(fp),
          vscode.Uri.file(fp),
        ]);
        try {
          await vscode.commands.executeCommand(
            "vscode.changes",
            `Claude Gate: Pending (${paths.length})`,
            resourceList
          );
        } catch (err) {
          log.appendLine(`[WARN] reviewAllPending: vscode.changes failed: ${(err as Error).message}`);
          vscode.window.showWarningMessage(
            "Claude Gate: the multi-file diff view isn't available in this VS Code version."
          );
        }
      }),
```

(`log` is the OutputChannel already in scope in `activate`.)

- [ ] **Step 5: Typecheck and compile**

Run: `npm run typecheck && npm run compile && node -e "require('./package.json')"`
Expected: typecheck/compile exit 0; package.json parses.

- [ ] **Step 6: Manual verification (Extension Development Host)**

1. With several pending files, click the **Review All Pending** button in the Pending panel title bar (or run it from the palette) → one multi-diff tab opens showing each pending file's original ↔ current; protected files first.
2. A pending **new file** shows the "// New file — no original content" placeholder on the left.
3. Excluded / out-of-workspace / accepted / rejected files are **not** shown.
4. With no pending files → info toast "no pending changes to review.", no tab.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts package.json
git commit -m "feat: Review All Pending — open all pending changes in the multi-diff editor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Docs & CHANGELOG

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the command from Task 1.

- [ ] **Step 1: README — mention the action**

In `README.md`'s "The Review Flow" section, add a line after the existing steps:

```markdown
- **Review All Pending** — click the multi-file diff button in the Pending panel title bar (or run `Claude Gate: Review All Pending`) to open every pending change in one scrollable multi-diff tab.
```

- [ ] **Step 2: CHANGELOG — extend the 1.3.0 Added list**

In `CHANGELOG.md`, inside the existing `## [1.3.0]` → `### Added` list, append:

```markdown
- **Review All Pending** — a Pending-panel action (and `Claude Gate: Review All Pending` command) opens every pending change in VS Code's multi-file diff editor for one-pass review of multi-file refactors.
```

- [ ] **Step 3: Verify build**

Run: `npm run typecheck && npm run compile && npm run test:unit`
Expected: all exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document Review All Pending multi-diff view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** command + filter + protected-first sort + `vscode.changes` call + try/catch fallback + empty-toast → Task 1 Step 4; command/menu declaration → Task 1 Steps 1–2; `originalUri` reuse → Task 1 Steps 3–4; docs / no version bump → Task 2.
- **Placeholder scan:** none — full code in every step.
- **Type consistency:** `claudegate.reviewAllPending` id identical in `package.json` (command + menu) and `registerCommand`; `originalUri`, `isInWorkspace`, `isExcluded`, `isProtected`, `sessionManager`, `log` are existing symbols; `resourceList` tuple shape `[Uri, Uri, Uri]` matches the verified `vscode.changes` signature.
