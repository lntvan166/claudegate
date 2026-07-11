# Session History Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A view-only History panel in the Claude Gate sidebar that browses the session archives Clear Session writes to `~/.claudegate/history/`, with per-session delete, Clear History, and a `claudegate.history.enabled` opt-out setting.

**Architecture:** A pure vscode-free model (`historyModel.ts`) parses/filters archives; a `HistoryTreeProvider` (`historyPanel.ts`) renders session→record rows and watches the history dir; record clicks open native diffs via a `hist=` extension of the existing `claudegate:` content provider. `SessionManager.clearSession` gains an `{archive}` option so the setting stays in the caller.

**Tech Stack:** TypeScript, existing esbuild test harness (per-file bundle + node), VS Code TreeDataProvider / TextDocumentContentProvider. No new dependencies.

## Global Constraints

- View-only: no restore/re-apply commands for archived records exist anywhere.
- Only decided records (accepted[]/rejected{}) are shown; archives with zero decided records are skipped.
- Workspace scoping: `workspacePath` field match first, record-path inference fallback; non-matching archives are never shown or deleted.
- `claudegate.history.enabled` default `true`; `SessionManager` stays config-free (`clearSession({archive})`).
- Every new `src/*.test.ts` must be appended to the `test:unit` script chain in package.json.
- Every contributed command is registered and vice versa (internal `openHistoryRecord` is registered-only, like `openReviewRecord`).
- Do not bump the version or release.
- End every commit message with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Pure history model

**Files:**
- Create: `src/historyModel.ts`
- Test: `src/historyModel.test.ts`
- Modify: `package.json` (`test:unit` registration)

**Interfaces:**
- Produces:
  ```ts
  export interface HistoryRecordRef { id: string; path: string; kind: "kept" | "rejected";
    before: string | null; after: string | null; reason?: string; decidedAt?: string; }
  export interface HistoryArchiveSummary { file: string; sessionId: string; label: string;
    kept: number; rejected: number; bytes: number; records: HistoryRecordRef[]; }
  export function summarizeArchive(file: string, raw: unknown, bytes: number): HistoryArchiveSummary | null;
  export function archiveMatchesWorkspace(raw: unknown, workspaceRoot: string, caseInsensitive?: boolean): boolean;
  export function findArchiveRecord(raw: unknown, id: string): HistoryRecordRef | null;
  export function formatBytes(n: number): string;
  ```

- [ ] **Step 1: Write the failing test**

`src/historyModel.test.ts`:
```ts
import * as assert from "assert";
import { summarizeArchive, archiveMatchesWorkspace, findArchiveRecord, formatBytes } from "./historyModel";

const archive = {
  sessionId: "2026-07-10T09:31:00.000Z",
  workspacePath: "/ws/project",
  files: { "/ws/project/pending.ts": { originalContent: "p", reviewStatus: "pending" } },
  accepted: [
    { id: "t1::/ws/project/a.ts", path: "/ws/project/a.ts", before: "1", after: "2", decidedAt: "t1" },
    { id: "t2::/ws/project/b.ts", path: "/ws/project/b.ts", before: null, after: "new", decidedAt: "t2" },
  ],
  rejected: {
    "/ws/project/r.ts": { id: "t3::/ws/project/r.ts", path: "/ws/project/r.ts", before: "x", after: "y", decidedAt: "t3", reason: "keep old" },
  },
};

// summarize: counts, records, label from sessionId, pending excluded
{
  const s = summarizeArchive("/h/f.json", archive, 2048)!;
  assert.ok(s, "summarizes");
  assert.equal(s.kept, 2); assert.equal(s.rejected, 1);
  assert.equal(s.records.length, 3, "pending entries are NOT records");
  assert.equal(s.bytes, 2048);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s.label), `label is local Y-M-D H:M, got ${s.label}`);
  console.log("ok - summarizeArchive counts decided records, excludes pending");
}
// no decided records → null; garbage → null
{
  assert.equal(summarizeArchive("/h/e.json", { sessionId: "s", files: {}, accepted: [], rejected: {} }, 10), null);
  assert.equal(summarizeArchive("/h/g.json", "not an object", 10), null);
  assert.equal(summarizeArchive("/h/g2.json", null, 10), null);
  console.log("ok - summarizeArchive returns null for empty/garbage archives");
}
// unparseable sessionId → raw id used as label
{
  const s = summarizeArchive("/h/x.json", { ...archive, sessionId: "weird-id" }, 1)!;
  assert.equal(s.label, "weird-id");
  console.log("ok - summarizeArchive falls back to raw sessionId label");
}
// workspace matching: workspacePath equality wins
{
  assert.equal(archiveMatchesWorkspace(archive, "/ws/project"), true);
  assert.equal(archiveMatchesWorkspace(archive, "/other"), false, "workspacePath mismatch → no fallback");
  console.log("ok - archiveMatchesWorkspace honors embedded workspacePath");
}
// legacy archive (no workspacePath) → record-path inference
{
  const legacy = { ...archive } as any; delete legacy.workspacePath;
  assert.equal(archiveMatchesWorkspace(legacy, "/ws/project"), true, "record under root → match");
  assert.equal(archiveMatchesWorkspace(legacy, "/elsewhere"), false);
  console.log("ok - archiveMatchesWorkspace infers from record paths for legacy archives");
}
// win32 case-fold
{
  const w = { ...archive, workspacePath: "C:\\Proj" } as any;
  assert.equal(archiveMatchesWorkspace(w, "c:\\proj", true), true);
  console.log("ok - archiveMatchesWorkspace case-folds when asked (win32)");
}
// record lookup incl. reject reason
{
  const r = findArchiveRecord(archive, "t3::/ws/project/r.ts")!;
  assert.equal(r.kind, "rejected"); assert.equal(r.reason, "keep old"); assert.equal(r.after, "y");
  assert.equal(findArchiveRecord(archive, "nope"), null);
  console.log("ok - findArchiveRecord finds by id with reason");
}
// bytes formatting
{
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1572864), "1.5 MB");
  console.log("ok - formatBytes");
}
console.log("done");
```

- [ ] **Step 2: Register + run to verify it fails**

Append to `test:unit` in `package.json` (chained with `&&`):
```
&& esbuild src/historyModel.test.ts --bundle --platform=node --format=cjs --outfile=out/historyModel.test.cjs && node out/historyModel.test.cjs
```
Run: `npm run test:unit` — Expected: FAIL (cannot resolve `./historyModel`).

- [ ] **Step 3: Implement `src/historyModel.ts`**

```ts
// Pure, vscode-free parsing/filtering of session archives written by
// clearSession to ~/.claudegate/history/. Runs under plain node for tests.
import * as path from "path";

export interface HistoryRecordRef {
  id: string;
  path: string;
  kind: "kept" | "rejected";
  before: string | null;
  after: string | null;
  reason?: string;
  decidedAt?: string;
}

export interface HistoryArchiveSummary {
  file: string;
  sessionId: string;
  label: string;      // local "YYYY-MM-DD HH:mm", or the raw sessionId
  kept: number;
  rejected: number;
  bytes: number;
  records: HistoryRecordRef[];
}

// Local copy of the 3-line containment check so this module stays free of
// vscode imports (workspaceScope pulls in vscode at module load).
function isPathUnder(child: string, parent: string, caseInsensitive: boolean): boolean {
  const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  return norm(child).startsWith(norm(parent) + path.sep);
}

// Decided records only: accepted[] + rejected{}. Pending files{} entries have
// no stored "after" content, so they can't render a view-only diff.
function decidedRecords(raw: any): HistoryRecordRef[] {
  const out: HistoryRecordRef[] = [];
  if (Array.isArray(raw?.accepted)) {
    for (const r of raw.accepted) {
      if (!r || typeof r.path !== "string") continue;
      out.push({ id: String(r.id ?? `${r.decidedAt}::${r.path}`), path: r.path, kind: "kept",
        before: r.before ?? null, after: r.after ?? null, decidedAt: r.decidedAt });
    }
  }
  if (raw?.rejected && typeof raw.rejected === "object") {
    for (const r of Object.values<any>(raw.rejected)) {
      if (!r || typeof r.path !== "string") continue;
      out.push({ id: String(r.id ?? `${r.decidedAt}::${r.path}`), path: r.path, kind: "rejected",
        before: r.before ?? null, after: r.after ?? null,
        ...(r.reason ? { reason: r.reason } : {}), decidedAt: r.decidedAt });
    }
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function summarizeArchive(file: string, raw: unknown, bytes: number): HistoryArchiveSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const records = decidedRecords(raw);
  if (records.length === 0) return null; // nothing viewable → skip archive
  const sessionId = typeof (raw as any).sessionId === "string" ? (raw as any).sessionId : path.basename(file, ".json");
  const t = Date.parse(sessionId);
  const label = Number.isNaN(t)
    ? sessionId
    : (() => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; })();
  return {
    file, sessionId, label, bytes, records,
    kept: records.filter((r) => r.kind === "kept").length,
    rejected: records.filter((r) => r.kind === "rejected").length,
  };
}

// workspacePath (embedded by archiveSession since this feature) wins outright;
// legacy archives fall back to "any decided record path under the root".
export function archiveMatchesWorkspace(
  raw: unknown,
  workspaceRoot: string,
  caseInsensitive: boolean = process.platform === "win32"
): boolean {
  const root = path.resolve(workspaceRoot);
  const wp = (raw as any)?.workspacePath;
  if (typeof wp === "string") {
    const a = path.resolve(wp);
    return caseInsensitive ? a.toLowerCase() === root.toLowerCase() : a === root;
  }
  return decidedRecords(raw).some((r) => isPathUnder(r.path, root, caseInsensitive));
}

export function findArchiveRecord(raw: unknown, id: string): HistoryRecordRef | null {
  if (!raw || typeof raw !== "object") return null;
  return decidedRecords(raw).find((r) => r.id === id) ?? null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit` — Expected: all `ok - …` lines incl. the 8 new ones; PASS.

- [ ] **Step 5: Commit**

```bash
git add src/historyModel.ts src/historyModel.test.ts package.json
git commit -m "feat: pure history-archive model (summarize/filter/find)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: SessionManager — embed workspacePath, optional archive

**Files:**
- Modify: `src/sessionManager.ts` (constructor, `archiveSession`, `clearSession`)
- Test: `src/sessionManager.test.ts` (append)

**Interfaces:**
- Produces: `clearSession(opts?: { archive?: boolean }): void` — default archives (current behavior + abort-on-backup-failure guard); `archive: false` skips the backup AND the guard (explicit opt-out).
- Archives now contain a top-level `workspacePath` (the resolved workspace root) and are written with `atomicWrite` instead of a byte copy.

- [ ] **Step 1: Write the failing tests**

Append inside the async IIFE of `src/sessionManager.test.ts` (before `console.log("done")`):
```ts
  // history archives embed workspacePath so the History panel can scope them
  {
    const { ws, home } = newEnv();
    const fp = path.join(ws, "h.ts");
    fs.writeFileSync(fp, "NEW");
    const sm = new SessionManager(fakeLog, ws);
    sm.startWatching();
    sm.trackFileChange(fp, "OLD");
    sm.acceptFile(fp);
    sm.clearSession();
    const historyDir = path.join(home, ".claudegate", "history");
    const files = fs.readdirSync(historyDir);
    assert.equal(files.length, 1, "one archive written");
    const arc = JSON.parse(fs.readFileSync(path.join(historyDir, files[0]), "utf-8"));
    assert.equal(arc.workspacePath, path.resolve(ws), "archive embeds resolved workspacePath");
    assert.equal(arc.accepted.length, 1, "archive carries the review log");
    sm.stopWatching();
    console.log("ok - clearSession archive embeds workspacePath");
  }

  // clearSession({archive:false}) skips the backup AND the abort guard
  {
    const { ws, sp, home } = newEnv();
    const fp = path.join(ws, "n.ts");
    fs.writeFileSync(fp, "NEW");
    const sm = new SessionManager(fakeLog, ws);
    sm.startWatching();
    sm.trackFileChange(fp, "OLD");
    // block the history dir (mkdir would fail) — with archive:false it must not matter
    fs.writeFileSync(path.join(home, ".claudegate", "history"), "not a dir");
    sm.clearSession({ archive: false });
    assert.equal(sm.getSession(), null, "session cleared in memory despite blocked history dir");
    assert.ok(!fs.existsSync(sp), "session file deleted without a backup (explicit opt-out)");
    sm.stopWatching();
    console.log("ok - clearSession({archive:false}) skips backup and guard");
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit` — Expected: FAIL — `clearSession` takes no options / archive has no `workspacePath` key.

- [ ] **Step 3: Implement**

In `src/sessionManager.ts`:

(a) Retain the workspace root — the constructor currently computes `resolved` inside the `if (workspacePath)` branch. Add a field and set it:
```ts
  private readonly workspaceRoot: string | null;
```
In the constructor: inside the `if (workspacePath)` branch add `this.workspaceRoot = resolved;`, and in the `else` branch add `this.workspaceRoot = null;`.

(b) Replace `clearSession` signature/body head:
```ts
  clearSession(opts: { archive?: boolean } = {}): void {
    if (!this.session) return;
    const archive = opts.archive !== false;
    // Never destroy the session without a backup — unless the user explicitly
    // disabled history (claudegate.history.enabled=false → archive:false).
    if (archive && !this.archiveSession()) {
      vscode.window.showErrorMessage(
        "Claude Gate: couldn't back up the review session, so it was NOT cleared — your history is intact. " +
        "See the Claude Gate Output channel for details."
      );
      return;
    }
```
(the rest of the method — unlink, null, fire, log — is unchanged).

(c) Rewrite `archiveSession` to embed the workspace and write atomically:
```ts
  // Write the session into history/ as a browsable archive (History panel).
  // Embeds workspacePath so the panel can scope archives per workspace.
  // Returns true when safely archived OR there is nothing on disk to lose;
  // false only when a real file exists but the write failed.
  private archiveSession(): boolean {
    if (!this.session) return true;
    if (!fs.existsSync(this.sessionPath)) return true; // in-memory only → nothing to lose
    try {
      const historyDir = path.join(this.claudegateDir, "history");
      fs.mkdirSync(historyDir, { recursive: true });
      const safeName = this.session.sessionId.replace(/[:.]/g, "-");
      const payload = JSON.stringify(
        { ...this.session, ...(this.workspaceRoot ? { workspacePath: this.workspaceRoot } : {}) },
        null, 2
      );
      this.atomicWrite(path.join(historyDir, `${safeName}.json`), payload);
      return true;
    } catch (err) {
      this.log.appendLine(`[WARN] ` + `Could not archive session: ${(err as Error).message}`);
      return false;
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit` — Expected: PASS incl. both existing clearSession tests (archive-then-delete; abort-when-blocked) and the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/sessionManager.ts src/sessionManager.test.ts
git commit -m "feat: archives embed workspacePath; clearSession({archive:false}) opt-out

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Diff provider — history record URIs

**Files:**
- Modify: `src/diffProvider.ts`

**Interfaces:**
- Produces:
  ```ts
  export function historyRecordUri(archiveFile: string, rec: { id: string; path: string }, side: "before" | "after"): vscode.Uri;
  export async function openHistoryRecord(archiveFile: string, rec: HistoryRecordRef): Promise<void>;
  ```
- Consumes: `findArchiveRecord`, `HistoryRecordRef` (Task 1).

- [ ] **Step 1: Implement**

In `src/diffProvider.ts`, add imports:
```ts
import * as fs from "fs";
import { findArchiveRecord, HistoryRecordRef } from "./historyModel";
```

Add near `recordUri`:
```ts
// ─── History archives (view-only) ───────────────────────────────────────────
// Archives are immutable once written, so a simple per-path cache is safe.
const archiveCache = new Map<string, unknown>();
function loadArchive(file: string): unknown | null {
  if (archiveCache.has(file)) return archiveCache.get(file)!;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    archiveCache.set(file, raw);
    return raw;
  } catch {
    return null;
  }
}

// URI keeps the real file path so the editor picks the right language; `hist`
// + `rec` route content resolution to the archive instead of the live session.
export function historyRecordUri(archiveFile: string, rec: { id: string; path: string }, side: "before" | "after"): vscode.Uri {
  const q = new URLSearchParams({ hist: archiveFile, rec: rec.id, side });
  return vscode.Uri.file(rec.path).with({ scheme: SCHEME, query: q.toString() });
}

export async function openHistoryRecord(archiveFile: string, rec: HistoryRecordRef): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.diff",
    historyRecordUri(archiveFile, rec, "before"),
    historyRecordUri(archiveFile, rec, "after"),
    `Claude Gate (history): ${path.basename(rec.path)} (${rec.kind})`
  );
}
```

In `provideTextDocumentContent`, immediately after `const params = new URLSearchParams(uri.query);` add the archive branch **before** the existing `rec` (live-record) branch:
```ts
    const hist = params.get("hist");
    if (hist) {
      const raw = loadArchive(hist);
      const rec = raw ? findArchiveRecord(raw, params.get("rec") ?? "") : null;
      if (!rec) return "";
      return (params.get("side") === "after" ? rec.after : rec.before) ?? "";
    }
```

- [ ] **Step 2: Typecheck + full suite (no dedicated unit test — vscode-bound; the parsing it delegates to is covered by Task 1)**

Run: `npm run typecheck && npm run test:unit` — Expected: clean / PASS.

- [ ] **Step 3: Commit**

```bash
git add src/diffProvider.ts
git commit -m "feat: serve archived history records through the claudegate: provider

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: History tree provider

**Files:**
- Create: `src/historyPanel.ts`
- Test: `src/historyPanel.test.ts`
- Modify: `package.json` (`test:unit` registration)

**Interfaces:**
- Produces:
  ```ts
  export class HistorySessionItem extends vscode.TreeItem { readonly summary: HistoryArchiveSummary; }
  export class HistoryRecordItem extends vscode.TreeItem { readonly archiveFile: string; readonly record: HistoryRecordRef; }
  export class HistoryTreeProvider implements vscode.TreeDataProvider<HistorySessionItem | HistoryRecordItem> {
    constructor(workspaceRoot: string | null, historyDir?: string);
    start(): void;   // mkdir + fs.watch(historyDir) → refresh on changes
    stop(): void;
    refresh(): void;
    getCount(): number;
    matchingFiles(): string[];  // absolute archive paths currently shown
    totalBytes(): number;
  }
  ```
- Record rows carry `command: { command: "claudegate.openHistoryRecord", arguments: [archiveFile, record] }` (registered in Task 5).

- [ ] **Step 1: Write the failing test**

`src/historyPanel.test.ts` (bundled with the vscode stub like `worktreePanel.test.ts`):
```ts
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryTreeProvider, HistorySessionItem, HistoryRecordItem } from "./historyPanel";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-hist-"));
const ws = "/ws/project";
const mk = (name: string, obj: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));

mk("2026-07-10.json", {
  sessionId: "2026-07-10T09:31:00.000Z", workspacePath: ws,
  files: {}, rejected: { "/ws/project/r.ts": { id: "r1", path: "/ws/project/r.ts", before: "a", after: "b", decidedAt: "t", reason: "why" } },
  accepted: [{ id: "a1", path: "/ws/project/a.ts", before: "1", after: "2", decidedAt: "t" }],
});
mk("other-ws.json", {
  sessionId: "2026-07-09T08:00:00.000Z", workspacePath: "/elsewhere",
  files: {}, accepted: [{ id: "x", path: "/elsewhere/z.ts", before: "1", after: "2", decidedAt: "t" }], rejected: {},
});
mk("empty.json", { sessionId: "s", files: {}, accepted: [], rejected: {} });
fs.writeFileSync(path.join(dir, "garbage.json"), "{ not json");

const p = new HistoryTreeProvider(ws, dir);
p.refresh();

assert.equal(p.getCount(), 1, "only the matching, non-empty, parseable archive shows");
const sessions = p.getChildren() as HistorySessionItem[];
assert.equal(sessions.length, 1);
assert.ok(String(sessions[0].description).includes("1✓"), "kept count in description");
assert.ok(String(sessions[0].description).includes("1✗"), "rejected count in description");
assert.equal(sessions[0].contextValue, "claudegate.historySession");

const records = p.getChildren(sessions[0]) as HistoryRecordItem[];
assert.equal(records.length, 2, "kept + rejected records");
const rec = records.find((r) => r.record.kind === "rejected")!;
assert.equal(rec.command?.command, "claudegate.openHistoryRecord");
assert.equal((rec.command?.arguments?.[1] as any).reason, "why", "record arg carries the reason");
assert.equal(records[0].label, path.relative(ws, (records[0].record).path), "record label is workspace-relative");

assert.deepEqual(p.matchingFiles(), [path.join(dir, "2026-07-10.json")]);
assert.ok(p.totalBytes() > 0);

// deletion reflected on refresh
fs.unlinkSync(path.join(dir, "2026-07-10.json"));
p.refresh();
assert.equal(p.getCount(), 0, "deleted archive disappears after refresh");

console.log("ok - history tree provider renders, scopes, and refreshes");
console.log("done");
```

- [ ] **Step 2: Register + verify it fails**

Append to `test:unit` in `package.json`:
```
&& esbuild src/historyPanel.test.ts --bundle --platform=node --format=cjs --alias:vscode=./src/test-stubs/vscode.ts --outfile=out/historyPanel.test.cjs && node out/historyPanel.test.cjs
```
Run: `npm run test:unit` — Expected: FAIL (cannot resolve `./historyPanel`).

- [ ] **Step 3: Implement `src/historyPanel.ts`**

```ts
// View-only History panel: browses the session archives clearSession writes to
// ~/.claudegate/history/, scoped to the current workspace. Records open native
// before→after diffs (claudegate.openHistoryRecord). No restore/re-apply.
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  HistoryArchiveSummary, HistoryRecordRef, archiveMatchesWorkspace, formatBytes, summarizeArchive,
} from "./historyModel";

export class HistorySessionItem extends vscode.TreeItem {
  constructor(public readonly summary: HistoryArchiveSummary) {
    super(summary.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${summary.kept}✓ ${summary.rejected}✗ · ${formatBytes(summary.bytes)}`;
    this.contextValue = "claudegate.historySession";
    this.iconPath = new vscode.ThemeIcon("history");
    this.tooltip = summary.file;
  }
}

export class HistoryRecordItem extends vscode.TreeItem {
  constructor(
    public readonly archiveFile: string,
    public readonly record: HistoryRecordRef,
    workspaceRoot: string | null
  ) {
    super(workspaceRoot ? path.relative(workspaceRoot, record.path) : record.path);
    this.iconPath = new vscode.ThemeIcon(record.kind === "kept" ? "check" : "close");
    this.description = record.kind;
    this.tooltip = record.reason ? `${record.kind} — ${record.reason}` : record.kind;
    this.command = {
      command: "claudegate.openHistoryRecord",
      title: "Open History Diff",
      arguments: [archiveFile, record],
    };
  }
}

type Item = HistorySessionItem | HistoryRecordItem;

export class HistoryTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private summaries: HistoryArchiveSummary[] = [];
  private watcher: fs.FSWatcher | null = null;

  constructor(
    private readonly workspaceRoot: string | null,
    private readonly historyDir: string = path.join(os.homedir(), ".claudegate", "history")
  ) {}

  // mkdir first so the watch target always exists (an empty dir is harmless);
  // the watcher keeps the panel live across windows (any writer/deleter).
  start(): void {
    try {
      fs.mkdirSync(this.historyDir, { recursive: true });
      this.watcher = fs.watch(this.historyDir, () => this.refresh());
    } catch { /* history unavailable → panel stays empty */ }
    this.refresh();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  refresh(): void {
    this.summaries = this.load();
    this._onDidChangeTreeData.fire();
  }

  getCount(): number { return this.summaries.length; }
  matchingFiles(): string[] { return this.summaries.map((s) => s.file); }
  totalBytes(): number { return this.summaries.reduce((n, s) => n + s.bytes, 0); }

  private load(): HistoryArchiveSummary[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.historyDir).filter((f) => f.endsWith(".json")); }
    catch { return []; }
    const out: HistoryArchiveSummary[] = [];
    for (const name of names) {
      const file = path.join(this.historyDir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        // no workspace open → show everything (legacy single-session windows)
        if (this.workspaceRoot && !archiveMatchesWorkspace(raw, this.workspaceRoot)) continue;
        const s = summarizeArchive(file, raw, fs.statSync(file).size);
        if (s) out.push(s);
      } catch { /* unreadable/garbage archive → skip */ }
    }
    return out.sort((a, b) => b.sessionId.localeCompare(a.sessionId)); // newest first
  }

  getTreeItem(item: Item): vscode.TreeItem { return item; }

  getChildren(element?: Item): Item[] {
    if (!element) return this.summaries.map((s) => new HistorySessionItem(s));
    if (element instanceof HistorySessionItem) {
      return element.summary.records.map((r) => new HistoryRecordItem(element.summary.file, r, this.workspaceRoot));
    }
    return [];
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit` — Expected: PASS incl. `ok - history tree provider renders, scopes, and refreshes`.

- [ ] **Step 5: Commit**

```bash
git add src/historyPanel.ts src/historyPanel.test.ts package.json
git commit -m "feat: History tree provider (workspace-scoped, view-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wiring — view, commands, setting, Settings row, README

**Files:**
- Modify: `package.json` (view, commands, menus, configuration)
- Modify: `src/extension.ts`
- Modify: `src/settingsPanel.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `HistoryTreeProvider`/items (Task 4), `openHistoryRecord` (Task 3), `clearSession({archive})` (Task 2), existing `updateClaudegateConfig` + `confirmBulk` helpers in extension.ts.

- [ ] **Step 1: package.json contributions**

`contributes.views.claudegate` — insert AFTER the rejectedPanel entry:
```json
{
  "id": "claudegate.historyPanel",
  "name": "History",
  "when": "claudegate.historyCount > 0"
},
```
`contributes.commands` — add:
```json
{ "command": "claudegate.clearHistory", "title": "Claude Gate: Clear History", "icon": "$(clear-all)" },
{ "command": "claudegate.deleteHistorySession", "title": "Delete Archived Session", "icon": "$(trash)" },
{ "command": "claudegate.toggleHistoryEnabled", "title": "Claude Gate: Toggle Session History" },
```
`contributes.menus["view/title"]` — add:
```json
{ "command": "claudegate.clearHistory", "when": "view == claudegate.historyPanel && claudegate.historyCount > 0", "group": "navigation@1" },
```
`contributes.menus["view/item/context"]` — add:
```json
{ "command": "claudegate.deleteHistorySession", "when": "view == claudegate.historyPanel && viewItem == claudegate.historySession", "group": "inline@1" },
```
`contributes.menus["commandPalette"]` — add (item-argument command, hide from palette; same pattern as `openWorktreeWindow`):
```json
{ "command": "claudegate.deleteHistorySession", "when": "false" },
```
`contributes.configuration.properties` — add:
```json
"claudegate.history.enabled": {
  "type": "boolean",
  "default": true,
  "markdownDescription": "Archive the session to `~/.claudegate/history/` when you run **Clear Session**, so past reviews stay browsable in the History panel. When disabled, Clear Session permanently deletes the review log."
}
```

- [ ] **Step 2: extension.ts wiring**

Imports:
```ts
import { HistoryTreeProvider, HistorySessionItem } from "./historyPanel";
import { formatBytes } from "./historyModel";
```
and extend the diffProvider import line with `openHistoryRecord`:
```ts
import { ClaudeGateContentProvider, SCHEME, openReviewRecord, openHistoryRecord, originalUri } from "./diffProvider";
```

After the settings view is created, add:
```ts
    // ── History panel (view-only archives from Clear Session) ───────────────
    const historyProvider = new HistoryTreeProvider(workspacePath ?? null);
    historyProvider.start();
    const historyView = vscode.window.createTreeView("claudegate.historyPanel", {
      treeDataProvider: historyProvider,
    });
    const updateHistoryContext = () =>
      vscode.commands.executeCommand("setContext", "claudegate.historyCount", historyProvider.getCount());
    context.subscriptions.push(
      historyView,
      { dispose: () => historyProvider.stop() },
      historyProvider.onDidChangeTreeData(updateHistoryContext)
    );
    updateHistoryContext();
```

In the commands array, add (near clearSession):
```ts
      vscode.commands.registerCommand("claudegate.clearHistory", async () => {
        const files = historyProvider.matchingFiles();
        if (files.length === 0) {
          vscode.window.showInformationMessage("Claude Gate: no archived sessions for this workspace.");
          return;
        }
        if (!(await confirmBulk(
          `Permanently delete ${files.length} archived session(s) (${formatBytes(historyProvider.totalBytes())})? This cannot be undone.`,
          "Delete History"
        ))) return;
        for (const f of files) {
          try { fs.unlinkSync(f); } catch (err) { log.appendLine(`[WARN] clearHistory: ${(err as Error).message}`); }
        }
        historyProvider.refresh();
        vscode.window.showInformationMessage(`Claude Gate: deleted ${files.length} archived session(s).`);
      }),

      vscode.commands.registerCommand("claudegate.deleteHistorySession", async (item: HistorySessionItem) => {
        if (!item?.summary) return;
        if (!(await confirmBulk(`Delete archived session "${item.summary.label}"? This cannot be undone.`, "Delete"))) return;
        try { fs.unlinkSync(item.summary.file); } catch (err) {
          vscode.window.showErrorMessage(`Claude Gate: could not delete the archive — ${(err as Error).message}`);
        }
        historyProvider.refresh();
      }),

      vscode.commands.registerCommand("claudegate.openHistoryRecord", (archiveFile: string, rec: any) =>
        openHistoryRecord(archiveFile, rec)
      ),

      vscode.commands.registerCommand("claudegate.toggleHistoryEnabled", async () => {
        const cur = vscode.workspace.getConfiguration("claudegate").get<boolean>("history.enabled", true);
        await updateClaudegateConfig("history.enabled", !cur);
      }),
```

Update the existing `claudegate.clearSession` handler to read the setting, adapt the wording, and pass the option:
```ts
      vscode.commands.registerCommand("claudegate.clearSession", async () => {
        const s = sessionManager.getSession();
        if (!s) return;
        const historyOn = vscode.workspace.getConfiguration("claudegate").get<boolean>("history.enabled", true);
        const pending = Object.keys(s.files).length;
        const base = pending > 0
          ? `Clear this review session? ${pending} pending change(s) will stop being tracked (files on disk are left as-is).`
          : "Clear this review session, including its accepted/rejected history?";
        const message = historyOn ? base : `${base}\n\nHistory saving is off — this permanently deletes the review log.`;
        if (!(await confirmBulk(message, "Clear Session"))) return;
        sessionManager.clearSession({ archive: historyOn });
        historyProvider.refresh();
      }),
```

- [ ] **Step 3: Settings panel row**

In `src/settingsPanel.ts`: add `"history"` to `SettingsKind`; add `{ kind: "history" }` to the root list right after `{ kind: "autoAdvance" }`; add `e.affectsConfiguration("claudegate.history.enabled")` to the config-change refresh condition; add the case:
```ts
      case "history": {
        const on = vscode.workspace
          .getConfiguration("claudegate")
          .get<boolean>("history.enabled", true);
        const ti = new vscode.TreeItem("Session History");
        ti.description = on ? "On" : "Off";
        ti.iconPath = new vscode.ThemeIcon("history");
        ti.tooltip = on
          ? "Clear Session archives the review log for the History panel. Click to turn off."
          : "Clear Session permanently deletes the review log. Click to turn archiving on.";
        ti.command = { command: "claudegate.toggleHistoryEnabled", title: "Toggle Session History" };
        return ti;
      }
```

- [ ] **Step 4: README**

Rename the `### The Three Panels` heading to `### The Panels` and append a bullet after the Rejected one:
```md
- **History** — appears once you've cleared a session. Clear Session archives the review log to `~/.claudegate/history/`; browse past sessions here (view-only), open any record as a before→after diff, delete one archive or clear them all. Turn archiving off with `claudegate.history.enabled`.
```

- [ ] **Step 5: Verify everything**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && npm run typecheck && npm test`
Expected: valid JSON, clean typecheck, all TS + Python tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/extension.ts src/settingsPanel.ts README.md
git commit -m "feat: Session History panel — view archives, clear controls, opt-out setting

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end verification + install

**Files:** none (verification only)

- [ ] **Step 1: Package and inspect**

Run: `rm -f claudegate-*.vsix && npx vsce package`
Expected: packages cleanly; file list unchanged shape (no new files should ship — history is all runtime).

- [ ] **Step 2: Install to Cursor for the maintainer's manual pass**

Run: `cursor --install-extension "$(pwd)/claudegate-<version>.vsix" --force && rm -f claudegate-*.vsix`

Manual checklist (maintainer, after Reload Window):
- Seed (`python3 manual-test-seed.py`), accept/reject a few files, run **Clear Session** → History panel appears with the session; counts/size shown.
- Click a ✓ and a ✗ record → native diffs open (rejected one shows the reason in the tooltip).
- Inline 🗑 deletes one archive after confirm; **Clear History** (title bar) deletes all for this workspace after confirm; panel hides when empty.
- Settings panel → **Session History: On** → click → Off; Clear Session dialog now warns about permanent deletion and writes no archive.
- A second workspace's archives don't appear (workspace scoping).

- [ ] **Step 3: Report**

Summarize results; leave release to the maintainer.
