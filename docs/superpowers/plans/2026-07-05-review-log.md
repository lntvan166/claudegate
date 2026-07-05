# Persistent Review Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Accepted a persistent per-accept log and Rejected a latest-per-file record, keep Pending showing only real diffs, so re-editing an accepted file never loses history and no-op edits never create phantom pending rows.

**Architecture:** Split the session into live pending changes (`files{}`, as today) plus two decision stores (`accepted[]` log, `rejected{}` latest-per-file). Pure state transitions live in a new vscode-free `reviewModel.ts` (unit-tested); `sessionManager` adds disk I/O; panels/diff render pending vs records; `hook.py` is simplified to "create-pending-if-absent".

**Tech Stack:** TypeScript (VS Code extension API), Python 3 (hook), esbuild unit tests, `diff` npm lib.

## Global Constraints

- **No version bump** — folds into unreleased `1.3.0`.
- **No new npm dependencies.**
- Supersedes the interim `claudeContent`-on-`files` diff approach: delete `src/diffPlan.ts` + `src/diffPlan.test.ts`, remove `claudeContent` from `FileEntry`.
- Pending behavior (baseline → disk) must stay functionally identical to today, except no-op entries (baseline === disk) are hidden.
- Verify every task with `npm run typecheck && npm run compile`; run `npm run test:unit` where unit tests exist.
- `hook.py` changes require the user to re-run Setup Hook (auto-synced on activate) — note in docs.

---

### Task 1: Pure review model (`reviewModel.ts`)

**Files:**
- Create: `src/reviewModel.ts`
- Test: `src/reviewModel.test.ts`
- Modify: `package.json` (add the test to the `test:unit` chain)

**Interfaces:**
- Produces (used by Task 2):
  - `interface FileEntry { originalContent: string | null; reviewStatus: "pending"; sessionId?: string; capturedAt?: string }`
  - `interface ReviewRecord { id: string; path: string; before: string | null; after: string | null; decidedAt: string; sessionId?: string }`
  - `interface Session { sessionId: string; status: "active" | "reviewed"; files: Record<string, FileEntry>; accepted: ReviewRecord[]; rejected: Record<string, ReviewRecord> }`
  - `function makeRecordId(decidedAt: string, path: string): string`
  - `function hasRealChange(originalContent: string | null, diskContent: string | null): boolean`
  - `function acceptEntry(session: Session, path: string, after: string | null, decidedAt: string): void`
  - `function rejectEntry(session: Session, path: string, after: string | null, decidedAt: string): void`
  - `function migrateSession(raw: any): Session`

- [ ] **Step 1: Write the failing test**

Create `src/reviewModel.test.ts`:

```ts
import * as assert from "assert";
import {
  hasRealChange, acceptEntry, rejectEntry, migrateSession, makeRecordId, Session,
} from "./reviewModel";

function base(): Session {
  return { sessionId: "s", status: "active", files: {}, accepted: [], rejected: {} };
}

// hasRealChange
assert.equal(hasRealChange("a", "a"), false, "equal → no change");
assert.equal(hasRealChange("a", "b"), true, "differ → change");
assert.equal(hasRealChange(null, "x"), true, "new file present → change");
assert.equal(hasRealChange(null, null), false, "new file absent → no change");
console.log("ok - hasRealChange");

// accept appends a record and clears the pending entry
{
  const s = base();
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  acceptEntry(s, "/f", "B", "2026-01-01T00:00:00Z");
  assert.equal(s.files["/f"], undefined, "pending entry removed");
  assert.equal(s.accepted.length, 1);
  assert.deepEqual(
    { before: s.accepted[0].before, after: s.accepted[0].after, path: s.accepted[0].path },
    { before: "A", after: "B", path: "/f" }
  );
  console.log("ok - accept appends + clears pending");
}

// two accepts on one file → full log
{
  const s = base();
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  acceptEntry(s, "/f", "B", "2026-01-01T00:00:00Z");
  s.files["/f"] = { originalContent: "B", reviewStatus: "pending" };
  acceptEntry(s, "/f", "C", "2026-01-01T00:00:01Z");
  assert.deepEqual(s.accepted.map(r => r.after), ["B", "C"], "both accepts logged");
  console.log("ok - accept keeps a full log");
}

// reject is latest-per-file (second replaces first)
{
  const s = base();
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  rejectEntry(s, "/f", "X", "2026-01-01T00:00:00Z");
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  rejectEntry(s, "/f", "Y", "2026-01-01T00:00:01Z");
  assert.equal(Object.keys(s.rejected).length, 1, "one reject per file");
  assert.equal(s.rejected["/f"].after, "Y", "latest reject wins");
  console.log("ok - reject is latest-per-file");
}

// migration of a legacy accepted/rejected files entry
{
  const raw = {
    sessionId: "s", status: "reviewed",
    files: {
      "/p": { originalContent: "pending-A", reviewStatus: "pending" },
      "/a": { originalContent: "A", claudeContent: "B", reviewStatus: "accepted" },
      "/r": { originalContent: "R0", claudeContent: "R1", reviewStatus: "rejected" },
    },
  };
  const s = migrateSession(raw);
  assert.deepEqual(Object.keys(s.files), ["/p"], "only pending stays in files");
  assert.equal(s.accepted.length, 1);
  assert.deepEqual([s.accepted[0].before, s.accepted[0].after], ["A", "B"]);
  assert.equal(Object.keys(s.rejected).length, 1);
  assert.deepEqual([s.rejected["/r"].before, s.rejected["/r"].after], ["R0", "R1"]);
  console.log("ok - migrateSession converts legacy entries");
}

// makeRecordId is stable + distinct per (time, path)
assert.equal(makeRecordId("t", "/p"), "t::/p");
assert.notEqual(makeRecordId("t1", "/p"), makeRecordId("t2", "/p"));
console.log("ok - makeRecordId");

console.log("done");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx esbuild src/reviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewModel.test.cjs && node out/reviewModel.test.cjs`
Expected: FAIL — esbuild errors that `./reviewModel` has no such exports (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/reviewModel.ts`:

```ts
// Pure, vscode-free state transitions for the review log. sessionManager adds
// the disk I/O and calls these to mutate its in-memory Session.

export interface FileEntry {
  originalContent: string | null; // frozen "before" baseline (null = Claude created the file)
  reviewStatus: "pending";        // files{} holds only pending changes now
  sessionId?: string;
  capturedAt?: string;
}

export interface ReviewRecord {
  id: string;
  path: string;
  before: string | null; // baseline reviewed
  after: string | null;  // accepted content, or the discarded Claude version
  decidedAt: string;     // ISO timestamp
  sessionId?: string;
}

export interface Session {
  sessionId: string;
  status: "active" | "reviewed";
  files: Record<string, FileEntry>;
  accepted: ReviewRecord[];
  rejected: Record<string, ReviewRecord>;
}

export function makeRecordId(decidedAt: string, path: string): string {
  return `${decidedAt}::${path}`;
}

// A pending entry is a real change unless its baseline already equals the
// current disk content (no-op / failed edit). diskContent === null means the
// file is absent on disk.
export function hasRealChange(originalContent: string | null, diskContent: string | null): boolean {
  if (originalContent === null) return diskContent !== null; // new file: real iff it exists
  return originalContent !== diskContent;
}

export function acceptEntry(session: Session, path: string, after: string | null, decidedAt: string): void {
  const entry = session.files[path];
  if (!entry) return;
  session.accepted.push({
    id: makeRecordId(decidedAt, path),
    path,
    before: entry.originalContent,
    after,
    decidedAt,
    sessionId: entry.sessionId,
  });
  delete session.files[path];
}

export function rejectEntry(session: Session, path: string, after: string | null, decidedAt: string): void {
  const entry = session.files[path];
  if (!entry) return;
  session.rejected[path] = {
    id: makeRecordId(decidedAt, path),
    path,
    before: entry.originalContent,
    after,
    decidedAt,
    sessionId: entry.sessionId,
  };
  delete session.files[path];
}

// Convert a raw on-disk session (possibly legacy: accepted/rejected in files{})
// into the current shape. Best-effort — sessions are transient.
export function migrateSession(raw: any): Session {
  const session: Session = {
    sessionId: raw?.sessionId ?? new Date().toISOString(),
    status: raw?.status === "reviewed" ? "reviewed" : "active",
    files: {},
    accepted: Array.isArray(raw?.accepted) ? raw.accepted : [],
    rejected: raw?.rejected && typeof raw.rejected === "object" ? raw.rejected : {},
  };
  const files = raw?.files ?? {};
  for (const [path, e] of Object.entries<any>(files)) {
    const status = e?.reviewStatus;
    if (status === "accepted") {
      const decidedAt = e.capturedAt ?? session.sessionId;
      session.accepted.push({
        id: makeRecordId(decidedAt, path), path,
        before: e.originalContent ?? null,
        after: e.claudeContent ?? e.originalContent ?? null,
        decidedAt, sessionId: e.sessionId,
      });
    } else if (status === "rejected") {
      const decidedAt = e.capturedAt ?? session.sessionId;
      session.rejected[path] = {
        id: makeRecordId(decidedAt, path), path,
        before: e.originalContent ?? null,
        after: e.claudeContent ?? e.originalContent ?? null,
        decidedAt, sessionId: e.sessionId,
      };
    } else {
      // pending (or unknown → treat as pending)
      session.files[path] = {
        originalContent: e?.originalContent ?? null,
        reviewStatus: "pending",
        sessionId: e?.sessionId,
        capturedAt: e?.capturedAt,
      };
    }
  }
  return session;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx esbuild src/reviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewModel.test.cjs && node out/reviewModel.test.cjs`
Expected: PASS — all `ok - ...` lines then `done`.

- [ ] **Step 5: Add to the test chain and commit**

In `package.json`, append to the `test:unit` script (after the `changeCount.test.cjs` run — note `diffPlan.test` is removed in Task 2, so do not chain it):

```
 && esbuild src/reviewModel.test.ts --bundle --platform=node --format=cjs --outfile=out/reviewModel.test.cjs && node out/reviewModel.test.cjs
```

Run `npm run typecheck && npm run test:unit` (expect all suites green), then:

```bash
git add src/reviewModel.ts src/reviewModel.test.ts package.json
git commit -m "feat: pure review-model reducers (accept log, reject latest, migrate)"
```

---

### Task 2: sessionManager on the new model

**Files:**
- Modify: `src/sessionManager.ts` (types, load/migrate, accept/reject/undo/clear/counts)
- Modify: `src/diffProvider.ts` (revert to pending-only; drop the interim record branch)
- Modify: `src/extension.ts` (command handler signatures)
- Modify: `package.json` (remove `diffPlan.test` from the `test:unit` chain)
- Delete: `src/diffPlan.ts`, `src/diffPlan.test.ts`

**Interfaces:**
- Consumes (Task 1): `reviewModel.ts` — `Session`, `FileEntry`, `ReviewRecord`, `hasRealChange`, `acceptEntry`, `rejectEntry`, `migrateSession`, `makeRecordId`.
- Produces (used by Task 3):
  - `sessionManager.getSession(): Session | null`
  - `sessionManager.hasRealPendingChange(path: string): boolean` (reads disk)
  - `sessionManager.revertAccepted(id: string): void`
  - `sessionManager.reapplyRejected(path: string): void`
  - `sessionManager.acceptFile/rejectFile/acceptFolder/rejectFolder/acceptAll/rejectAll` (unchanged names)
  - `sessionManager.clearAccepted(): void`, `sessionManager.clearRejected(): void`

- [ ] **Step 1: Re-home the types onto reviewModel**

In `src/sessionManager.ts`, replace the local `FileEntry`/`Session` definitions and the `ReviewStatus` type with re-exports from `reviewModel`, keeping `ReviewStatus` for `reviewPanel`:

```ts
import {
  Session, FileEntry, ReviewRecord, hasRealChange, acceptEntry, rejectEntry,
  migrateSession, makeRecordId,
} from "./reviewModel";
export type { Session, FileEntry, ReviewRecord } from "./reviewModel";
export type ReviewStatus = "pending" | "accepted" | "rejected"; // panel tab id
```

- [ ] **Step 2: Migrate on load**

Replace the body of `loadSession()` so the parsed JSON runs through `migrateSession` and is re-persisted if it changed shape:

```ts
private loadSession(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(this.sessionPath, "utf-8"));
    const migrated = migrateSession(raw);
    const changed = JSON.stringify(migrated) !== JSON.stringify(raw);
    this.session = migrated;
    this.log.appendLine(
      `[INFO] Session loaded: ${Object.keys(this.session.files).length} pending, ` +
      `${this.session.accepted.length} accepted, ${Object.keys(this.session.rejected).length} rejected`
    );
    this.pruneOutOfWorkspaceEntries();
    if (changed) this.persist();
  } catch {
    this.session = null;
  }
  this._onSessionChange.fire(this.session);
  this.scheduleReconcile();
}
```

- [ ] **Step 3: Real-change helper + counts**

Add a public helper and update `getPendingCount()`:

```ts
hasRealPendingChange(filePath: string): boolean {
  const entry = this.session?.files[filePath];
  if (!entry) return false;
  return hasRealChange(entry.originalContent, this.readFileOrNull(filePath));
}

getPendingCount(): number {
  if (!this.session) return 0;
  return Object.keys(this.session.files).filter(
    (fp) => isInWorkspace(fp) && !isExcluded(fp) && this.hasRealPendingChange(fp)
  ).length;
}
```

(`readFileOrNull` already returns `string | null` for missing files.)

- [ ] **Step 4: Accept / reject using the reducers**

Replace `acceptFile` and `rejectFile` (and the folder/all variants) so they read disk and call the pure reducers. `acceptFile`:

```ts
acceptFile(filePath: string): void {
  const entry = this.session?.files[filePath];
  if (!entry) return;
  const after = this.readFileOrNull(filePath);
  acceptEntry(this.session!, filePath, after, new Date().toISOString());
  this.log.appendLine(`[INFO] Accepted: ${filePath}`);
  this.persist();
}
```

`rejectFile` (restore disk, then record):

```ts
rejectFile(filePath: string): void {
  const entry = this.session?.files[filePath];
  if (!entry) return;
  const after = this.readFileOrNull(filePath); // Claude's discarded version
  try {
    if (entry.originalContent === null) fs.unlinkSync(filePath);
    else fs.writeFileSync(filePath, entry.originalContent, "utf-8");
  } catch (err) {
    this.log.appendLine(`[ERROR] reject ${filePath}: ${(err as Error).message}`);
    vscode.window.showErrorMessage(
      `Claude Gate: Could not restore ${path.basename(filePath)} — ${(err as Error).message}`
    );
    return;
  }
  rejectEntry(this.session!, filePath, after, new Date().toISOString());
  this.log.appendLine(`[INFO] Rejected: ${filePath}`);
  this.persist();
}
```

`acceptFolder`, `acceptAll`, `rejectFolder`, `rejectAll`: iterate matching **pending** paths (`Object.keys(this.session.files)`) with the same workspace/exclude guards used today, calling the same read-and-reduce logic inline (for reject, restore disk per file). Keep the existing error aggregation for the reject bulk variants. Set `this.session.status` to `"reviewed"` when no pending entries remain, else `"active"`, before `persist()`.

- [ ] **Step 5: Undo + clear**

Replace `revertAccepted`, `reapplyFile`, and the clear methods:

```ts
revertAccepted(id: string): void {
  const s = this.session;
  if (!s) return;
  const idx = s.accepted.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const rec = s.accepted[idx];
  s.accepted.splice(idx, 1);
  // Only reopen as pending if this record is still the file's on-disk state
  // and there is no pending entry already.
  if (!s.files[rec.path] && this.readFileOrNull(rec.path) === rec.after) {
    s.files[rec.path] = { originalContent: rec.before, reviewStatus: "pending", sessionId: rec.sessionId };
  }
  this.log.appendLine(`[INFO] Reverted accepted: ${rec.path}`);
  this.persist();
}

reapplyRejected(filePath: string): void {
  const s = this.session;
  const rec = s?.rejected[filePath];
  if (!s || !rec) return;
  if (rec.after == null) {
    vscode.window.showWarningMessage(
      `Claude Gate: Cannot re-apply — Claude's version of "${path.basename(filePath)}" was not saved.`
    );
    return;
  }
  try {
    fs.writeFileSync(filePath, rec.after, "utf-8");
  } catch (err) {
    vscode.window.showErrorMessage(
      `Claude Gate: Could not re-apply ${path.basename(filePath)} — ${(err as Error).message}`
    );
    return;
  }
  delete s.rejected[filePath];
  s.files[filePath] = { originalContent: rec.before, reviewStatus: "pending", sessionId: rec.sessionId };
  this.log.appendLine(`[INFO] Re-applied: ${filePath}`);
  this.persist();
}

clearAccepted(): void { if (this.session) { this.session.accepted = []; this.persist(); } }
clearRejected(): void { if (this.session) { this.session.rejected = {}; this.persist(); } }
```

Update `clearSession()` to also reset `accepted`/`rejected` (it likely writes a fresh empty session — ensure the new fields are `[]`/`{}`). Replace `revertAcceptedAll`/`revertAcceptedFolder`/`reapplyAll`/`reapplyFolder`/`clearAccepted`/`clearRejected` bodies to operate on the new stores: bulk revert = clear/scan `accepted`; bulk reapply = scan `rejected`. Keep method names so `extension.ts`/`package.json` command IDs stay valid. `reapplyAll` iterates `Object.keys(this.session.rejected)` calling `reapplyRejected`.

- [ ] **Step 6: Revert diffProvider to pending-only; delete diffPlan**

In `src/diffProvider.ts` remove the `import { chooseRightSide } from "./diffPlan"` line and the entire reviewed-snapshot branch in `openDiff` (the `if (chooseRightSide(...) === "claude")` block), leaving only the pending path (baseline `originalUri` ↔ file-on-disk) plus `revealFirstChange`. The `provideTextDocumentContent` `side=claude` branch and `claudeUri` become unused by pending; leave them for Task 3 (records will reuse a record URI, not `claudeUri`). Then:

```bash
git rm src/diffPlan.ts src/diffPlan.test.ts
```

In `package.json` remove the ` && esbuild src/diffPlan.test.ts ... && node out/diffPlan.test.cjs` segment from `test:unit`, and `rm -f out/diffPlan.test.cjs`.

- [ ] **Step 7: Fix command handler signatures in extension.ts**

Update the `claudegate.revertAccepted` handler to pass an **id** and `claudegate.reapplyFile` to call `reapplyRejected`. Since these are invoked from tree items (reworked in Task 3), read the argument defensively:

```ts
vscode.commands.registerCommand("claudegate.revertAccepted", (item: any) => {
  const id = typeof item === "string" ? item : item?.recordId;
  if (id) sessionManager.revertAccepted(id);
}),
vscode.commands.registerCommand("claudegate.reapplyFile", (item: any) => {
  const fp = typeof item === "string" ? item : item?.filePath;
  if (fp) sessionManager.reapplyRejected(fp);
}),
```

Leave other command registrations as-is (their session methods keep their names).

- [ ] **Step 8: Verify + commit**

Run `npm run typecheck && npm run compile && npm run test:unit`.
Expected: typecheck/compile clean; `reviewModel` + existing suites pass (no `diffPlan` suite).

```bash
git add -A
git commit -m "feat: sessionManager on the review-log model (migrate, accept log, reject latest, undo, clear)"
```

---

### Task 3: Panels + record diffs

**Files:**
- Modify: `src/reviewPanel.ts` (accepted/rejected from records; pending real-diff filter; record row command)
- Modify: `src/diffProvider.ts` (record URIs + `openReviewRecord`)
- Modify: `src/extension.ts` (register `claudegate.openReviewRecord`)
- Modify: `src/decorationProvider.ts` (pending badge via `hasRealPendingChange`)
- Modify: `package.json` (declare `claudegate.openReviewRecord`? no — it is arg-only like `openDiff`; do NOT add to `contributes.commands`)

**Interfaces:**
- Consumes (Task 2): `sessionManager.getSession()`, `hasRealPendingChange`, `revertAccepted(id)`, `reapplyRejected(path)`, `ReviewRecord`.
- Produces: tree items carrying `recordId` (accepted rows) / `filePath` (rejected rows); `claudegate.openReviewRecord(id: string)`; `openReviewRecord(id, sessionManager)` in diffProvider.

- [ ] **Step 1: Record diff URIs + open helper in diffProvider**

Add record URI helpers and content resolution. In `src/diffProvider.ts`:

```ts
export function recordUri(id: string, side: "before" | "after"): vscode.Uri {
  return vscode.Uri.parse(`${SCHEME}:record?id=${encodeURIComponent(id)}&side=${side}`);
}
```

In `provideTextDocumentContent`, before the existing file-path logic, handle record URIs:

```ts
if (uri.path === "record") {
  const params = new URLSearchParams(uri.query);
  const id = params.get("id") ?? "";
  const side = params.get("side");
  const session = this.sessionManager.getSession();
  const rec = session
    ? [...session.accepted, ...Object.values(session.rejected)].find((r) => r.id === id)
    : undefined;
  if (!rec) return "";
  return (side === "after" ? rec.after : rec.before) ?? "";
}
```

Add the open helper:

```ts
export async function openReviewRecord(id: string, sessionManager: SessionManager): Promise<void> {
  const session = sessionManager.getSession();
  if (!session) return;
  const rec = [...session.accepted, ...Object.values(session.rejected)].find((r) => r.id === id);
  if (!rec) return;
  const decision = session.accepted.includes(rec) ? "accepted" : "rejected";
  const label = path.basename(rec.path);
  const suffix = ` · ${formatChangeCount(countChanges(rec.before ?? "", rec.after ?? ""))}`;
  await vscode.commands.executeCommand(
    "vscode.diff", recordUri(rec.id, "before"), recordUri(rec.id, "after"),
    `Claude Gate: ${label}  (${decision}${suffix})`
  );
}
```

In the content provider's `onSessionChange` handler, also fire change for record URIs:

```ts
for (const r of [...session.accepted, ...Object.values(session.rejected)]) {
  this._onDidChange.fire(recordUri(r.id, "before"));
  this._onDidChange.fire(recordUri(r.id, "after"));
}
```

- [ ] **Step 2: Register the record-open command**

In `src/extension.ts`, add alongside the `claudegate.openDiff` registration:

```ts
vscode.commands.registerCommand("claudegate.openReviewRecord", (id: string) =>
  openReviewRecord(id, sessionManager)
),
```

Import `openReviewRecord` from `./diffProvider`.

- [ ] **Step 3: Record tree items in reviewPanel**

Add a `RecordReviewItem` class (mirrors `FileReviewItem` but for a `ReviewRecord`):

```ts
export class RecordReviewItem extends vscode.TreeItem {
  constructor(
    public readonly record: ReviewRecord,
    public readonly decision: "accepted" | "rejected",
    showPath = true
  ) {
    super(path.basename(record.path), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = vscode.Uri.file(record.path);
    this.description = showPath ? relativeDir(record.path) : undefined;
    this.filePath = record.path;
    this.recordId = record.id;
    this.contextValue = decision === "accepted" ? "claudegate.file.accepted" : "claudegate.file.rejected";
    this.tooltip = new vscode.MarkdownString(
      `**${path.basename(record.path)}**\n\n${record.path}\n\n*${decision}* · ${new Date(record.decidedAt).toLocaleString()}`
    );
    this.command = { command: "claudegate.openReviewRecord", title: "Open Diff", arguments: [record.id] };
    if (isProtected(record.path)) {
      this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
    }
  }
  filePath: string;
  recordId: string;
}
```

Import `ReviewRecord` from `./sessionManager`.

- [ ] **Step 4: Feed the three panels from the right source**

In `FilteredTreeProvider`, branch by `this.status`:
- **pending**: build rows from `Object.keys(session.files)` filtered by `isInWorkspace && !isExcluded && sessionManager.hasRealPendingChange(fp)` (extend the existing `filteredFiles`); rows stay `FileReviewItem` with `reviewStatus: "pending"` and the `openDiff` command.
- **accepted**: rows from `session.accepted` (filter by `isInWorkspace && !isExcluded`), newest-first (`[...accepted].reverse()`), each a `RecordReviewItem(rec, "accepted")`.
- **rejected**: rows from `Object.values(session.rejected)` (same filter), each a `RecordReviewItem(rec, "rejected")`.

For tree/list/session grouping: pending keeps today's grouping. For accepted/rejected, group by directory in tree mode using `record.path` (reuse the existing directory-grouping helper, passing record paths and building `RecordReviewItem` leaves). Session grouping (`groupBySession`) for records uses `record.sessionId`. Keep list mode flat. Update `getPendingCount`-style badges via the provider's existing count path (accepted count = filtered `accepted.length`; rejected count = filtered `rejected` size).

- [ ] **Step 5: Decoration provider pending-only**

In `src/decorationProvider.ts`, wherever it decides the pending set, filter to real changes via `sessionManager.hasRealPendingChange(fp)` (badge only files that are genuinely pending). Accepted/rejected files are not badged (records aren't in `files`).

- [ ] **Step 6: Update the count/badge wiring in extension.ts**

In the `sessionManager.onSessionChange` handler in `extension.ts`, recompute counts from the new shape:

```ts
let pending = 0;
for (const fp of Object.keys(session.files))
  if (isInWorkspace(fp) && !isExcluded(fp) && sessionManager.hasRealPendingChange(fp)) pending++;
const accepted = session.accepted.filter((r) => isInWorkspace(r.path) && !isExcluded(r.path)).length;
const rejected = Object.values(session.rejected).filter((r) => isInWorkspace(r.path) && !isExcluded(r.path)).length;
vscode.commands.executeCommand("setContext", "claudegate.acceptedCount", accepted);
vscode.commands.executeCommand("setContext", "claudegate.rejectedCount", rejected);
// pendingView.badge + badgeBar.text use `pending` as before
```

- [ ] **Step 7: Verify + commit**

Run `npm run typecheck && npm run compile && npm run test:unit` (all green). Manual smoke via `python3 manual-test-seed.py` then F5 is done in Task 4.

```bash
git add -A
git commit -m "feat: Accepted log + Rejected latest panels with per-record diffs; real-diff Pending"
```

---

### Task 4: Hook, docs, manual verification

**Files:**
- Modify: `hooks/hook.py`
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `README.md`

**Interfaces:** none (docs + hook).

- [ ] **Step 1: Simplify the hook**

In `hooks/hook.py`, replace the entry-handling block (currently `if existing is None: ... elif existing["reviewStatus"] in ("accepted","rejected"): ...`) with:

```python
    existing = session["files"].get(file_path)
    if existing is None or existing.get("reviewStatus") != "pending":
        session["files"][file_path] = {
            "originalContent": original_content,
            "reviewStatus": "pending",
            "sessionId": session_id,
            "capturedAt": captured_at,
        }
        if session.get("status") == "reviewed":
            session["status"] = "active"
        save_session(session, session_file)
    # else: an existing pending entry keeps its frozen baseline (no-op)
```

- [ ] **Step 2: Manually test the hook path**

```bash
python3 manual-test-seed.py --clean && python3 manual-test-seed.py
echo '{"cwd":"'"$HOME"'/claudegate-manual-test","hook_event_name":"PreToolUse","tool_name":"Edit","session_id":"t","tool_input":{"file_path":"src/auth.ts"}}' | python3 hooks/hook.py
```
Expected: exits 0; the session file's `auth.ts` entry stays `reviewStatus:"pending"` (already pending → untouched).

- [ ] **Step 3: Update docs**

- `CLAUDE.md`: rewrite "Session State Schema" to the `files` (pending) + `accepted[]` + `rejected{}` model and `ReviewRecord`; update the hook description to create-pending-if-absent.
- `CHANGELOG.md` (under `## [1.3.0]` → `### Fixed`/`### Changed`): "Accepted panel is now a persistent per-accept log and Rejected keeps the latest reject per file; re-editing an accepted file no longer loses history, and no-op/failed edits no longer create empty Pending rows."
- `README.md`: update the Pending/Accepted/Rejected descriptions to match the new panel meanings.

- [ ] **Step 4: Verify + commit**

Run `npm run typecheck && npm run compile && npm run test:unit` (green).

```bash
git add -A
git commit -m "feat: simplify hook to create-pending-if-absent; document review-log model"
```

- [ ] **Step 5: Full manual test (Extension Development Host)**

Rebuild + reinstall (`vsce package` then `--install-extension ... --force` in Cursor and VS Code), re-seed, and run the relevant checks in `MANUAL-TEST-1.3.0.md` plus: accept `auth.ts` → Accepted shows A→B; edit again via Claude → Pending shows B→C while Accepted keeps A→B; a failed/no-op edit creates no empty Pending row.

---

## Self-Review

**Spec coverage:** model (Task 1 types + Task 2 session) ✓; pending real-diff filter (Task 2 §3, Task 3 §4) ✓; accepted log + rejected latest (Task 1 reducers, Task 3 panels) ✓; per-record diffs (Task 3 §1) ✓; simplified hook (Task 4 §1) ✓; migration (Task 1 `migrateSession`, Task 2 §2) ✓; undo + clear (Task 2 §5) ✓; decoration pending-only (Task 3 §5) ✓; docs (Task 4 §3) ✓; delete diffPlan (Task 2 §6) ✓.

**Type consistency:** `Session`/`FileEntry`/`ReviewRecord` defined in Task 1, re-exported in Task 2, consumed in Task 3. `revertAccepted(id)`, `reapplyRejected(path)`, `hasRealPendingChange(path)`, `openReviewRecord(id)`, `recordUri(id, side)` are named identically across the tasks that produce and consume them. `RecordReviewItem` exposes `recordId`/`filePath` matching the defensive command handlers in Task 2 §7.
