import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { diffLines } from "diff";
import { SessionManager } from "./sessionManager";
import { fileEntryFor } from "./reviewModel";
import { countChanges, formatChangeCount } from "./changeCount";
import { findArchiveRecord, HistoryRecordRef } from "./historyModel";
import { pendingProgress } from "./reviewNav";
import { orderedPendingAcross, orderedPendingPaths } from "./pendingPaths";

export const SCHEME = "claudegate";

// Every session the panel draws from, supplied once at activation.
//
// The "N of M pending" counter in a diff title has to agree with what Next and
// Previous actually do, and those step across all sessions. Counting within the
// one session that owns the file would say "1 of 2" while alt+] walks a list of
// 224 — a number that contradicts the navigation it describes is worse than no
// number.
//
// A setter rather than another parameter because openDiff is called from three
// places that have no reason to know about the worktree registry, and the answer
// is the same for all of them.
let pendingScopes: (() => SessionManager[]) | null = null;

export function setPendingScopeProvider(fn: () => SessionManager[]): void {
  pendingScopes = fn;
}

// ─── Virtual document provider (serves original content for left side of diff) ─

export class ClaudeGateContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

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

  provideTextDocumentContent(uri: vscode.Uri): string {
    // Record URIs carry the real file path (so the editor infers the language
    // for syntax highlighting) plus a `rec` query identifying the record.
    const params = new URLSearchParams(uri.query);
    const hist = params.get("hist");
    if (hist) {
      const raw = loadArchive(hist);
      const rec = raw ? findArchiveRecord(raw, params.get("rec") ?? "") : null;
      if (!rec) return "";
      return (params.get("side") === "after" ? rec.after : rec.before) ?? "";
    }

    const recId = params.get("rec");
    if (recId) {
      // Accepted/rejected records are shown only for the primary session.
      const session = this.sessionManager.getSession();
      if (!session) return "";
      const side = params.get("side");
      const rec = [...session.accepted, ...Object.values(session.rejected)].find((r) => r.id === recId);
      if (!rec) return "";
      return (side === "after" ? rec.after : rec.before) ?? "";
    }

    // Look up by fsPath (the session key). On Windows uri.path is "/c:/…" while
    // the key is "c:\…", so uri.path would miss; uri.fsPath matches on all OSes.
    // Even fsPath can differ in drive-letter case from the hook-stored key
    // (Uri.file lowercases it), so use fileEntryFor's case-tolerant lookup.
    const owner = this.resolveManager(uri.fsPath).getSession();
    const entry = owner ? fileEntryFor(owner.files, uri.fsPath) : undefined;
    if (!entry) return "";
    // A file Claude CREATED has no baseline, and the empty document is the right
    // representation — it is what git, GitHub and VS Code's own SCM show for an
    // added file, and it makes every line of the new content render as a pure
    // addition.
    //
    // This used to return "// New file — no original content", which was wrong
    // three ways: `//` is not a comment in YAML, Python or shell, so it rendered
    // as syntax-highlighted content; the line showed as REMOVED, so a new file
    // appeared to have deleted something; and line 1 of the real content then
    // diffed as *changed* against it instead of added.
    return entry.originalContent ?? "";
  }
}

// The URI keeps the real file path (with its extension) so the diff editor
// applies the correct language/syntax highlighting; `rec` disambiguates records
// from the pending `originalUri` (which has no query) and from each other.
export function recordUri(filePath: string, id: string, side: "before" | "after"): vscode.Uri {
  return vscode.Uri.file(filePath).with({
    scheme: SCHEME,
    query: `rec=${encodeURIComponent(id)}&side=${side}`,
  });
}

export function originalUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({ scheme: SCHEME });
}

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

// ─── Open diff ───────────────────────────────────────────────────────────────
//
// Pending → baseline (originalContent) ↔ current file on disk (the proposal).
// files{} is pending-only now; accepted/rejected records are shown via
// openReviewRecord() below, diffing each record's own before/after snapshot.

// A single click can arrive down two paths: TreeItem.command fires on every
// click, and a click that also CHANGES the selection fires onDidChangeSelection
// as well (see FileReviewItem). VS Code reuses the diff editor, so a double open
// is invisible — but openDiff reads the file off disk to compute the change
// count, and on a large file that is real work to do twice per click.
//
// Short window on purpose: it only has to span one click's two events, never a
// user deliberately re-opening the same diff.
const OPEN_DEDUPE_MS = 300;
let lastOpened: { key: string; at: number } | null = null;

function openedJustNow(key: string): boolean {
  const now = Date.now();
  if (lastOpened && lastOpened.key === key && now - lastOpened.at < OPEN_DEDUPE_MS) return true;
  lastOpened = { key, at: now };
  return false;
}

export async function openDiff(
  filePath: string,
  sessionManager: SessionManager
): Promise<void> {
  if (openedJustNow(`file:${filePath}`)) return;
  const session = sessionManager.getSession();
  if (!session?.files[filePath]) return;

  const entry = session.files[filePath];

  // A pending entry whose baseline already equals disk (the file was reverted to
  // baseline — git reset, editor undo — without a session-file change to trigger
  // reconcile) would open a blank diff. Self-heal it: drop the stale row so it
  // clears from the panel instead of lingering as a phantom, and show a note.
  if (!sessionManager.hasRealPendingChange(filePath)) {
    const removed = sessionManager.dropIfNoRealChange(filePath);
    vscode.window.showInformationMessage(
      `Claude Gate: no changes to review in ${path.basename(filePath)}${removed ? " — removed from Pending." : "."}`
    );
    return;
  }

  const label = path.basename(filePath);
  const beforeUri = originalUri(filePath);
  const beforeText = entry.originalContent ?? "";

  // Pending: baseline ↔ disk.
  const currentUri = vscode.Uri.file(filePath);
  let currentText = "";
  let suffix = "";
  try {
    currentText = (await vscode.workspace.openTextDocument(filePath)).getText();
    suffix = ` · ${formatChangeCount(countChanges(beforeText, currentText))}`;
  } catch {
    suffix = "";
  }

  const ordered = pendingScopes
    ? orderedPendingAcross(pendingScopes()).map((p) => p.filePath)
    : orderedPendingPaths(sessionManager);   // before activation wires it
  const prog = pendingProgress(ordered, filePath);
  const progSuffix = prog ? `  ·  ${prog.index} of ${prog.total} pending` : "";
  const title =
    (entry.originalContent === null
      ? `Claude Gate: ${label}  (new file${suffix})`
      : `Claude Gate: ${label}  (original ↔ current${suffix})`) + progSuffix;

  await vscode.commands.executeCommand("vscode.diff", beforeUri, currentUri, title);

  if (entry.originalContent !== null) {
    revealFirstChange(beforeText, currentText);
  }
}

// ─── Open a record diff (Accepted / Rejected rows) ──────────────────────────

export async function openReviewRecord(id: string, sessionManager: SessionManager): Promise<void> {
  if (openedJustNow(`rec:${id}`)) return;
  const session = sessionManager.getSession();
  if (!session) return;
  const rec = [...session.accepted, ...Object.values(session.rejected)].find((r) => r.id === id);
  if (!rec) return;
  const decision = session.accepted.includes(rec) ? "accepted" : "rejected";
  const label = path.basename(rec.path);
  const suffix = ` · ${formatChangeCount(countChanges(rec.before ?? "", rec.after ?? ""))}`;
  await vscode.commands.executeCommand(
    "vscode.diff", recordUri(rec.path, rec.id, "before"), recordUri(rec.path, rec.id, "after"),
    `Claude Gate: ${label}  (${decision}${suffix})`
  );
}

// Scroll the diff's right pane to the first changed line.
function revealFirstChange(before: string, after: string): void {
  const changes = diffLines(before, after);
  let firstChangedLine = 0;
  let cursor = 0;
  for (const change of changes) {
    if (change.added || change.removed) { firstChangedLine = cursor; break; }
    if (!change.removed) cursor += change.count ?? 0;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    editor.revealRange(
      new vscode.Range(firstChangedLine, 0, firstChangedLine, 0),
      vscode.TextEditorRevealType.InCenter
    );
  }
}
