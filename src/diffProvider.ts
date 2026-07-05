import * as vscode from "vscode";
import * as path from "path";
import { diffLines } from "diff";
import { SessionManager } from "./sessionManager";
import { countChanges, formatChangeCount } from "./changeCount";

export const SCHEME = "claudegate";

// ─── Virtual document provider (serves original content for left side of diff) ─

export class ClaudeGateContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly sessionManager: SessionManager) {
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
    const session = this.sessionManager.getSession();
    if (!session) return "";

    // Record URIs carry the real file path (so the editor infers the language
    // for syntax highlighting) plus a `rec` query identifying the record.
    const params = new URLSearchParams(uri.query);
    const recId = params.get("rec");
    if (recId) {
      const side = params.get("side");
      const rec = [...session.accepted, ...Object.values(session.rejected)].find((r) => r.id === recId);
      if (!rec) return "";
      return (side === "after" ? rec.after : rec.before) ?? "";
    }

    // Look up by fsPath (the session key). On Windows uri.path is "/c:/…" while
    // the key is "c:\…", so uri.path would miss; uri.fsPath matches on all OSes.
    const entry = session.files[uri.fsPath];
    if (!entry) return "";
    return entry.originalContent ?? "// New file — no original content";
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

// ─── Open diff ───────────────────────────────────────────────────────────────
//
// Pending → baseline (originalContent) ↔ current file on disk (the proposal).
// files{} is pending-only now; accepted/rejected records are shown via
// openReviewRecord() below, diffing each record's own before/after snapshot.

export async function openDiff(
  filePath: string,
  sessionManager: SessionManager
): Promise<void> {
  const session = sessionManager.getSession();
  if (!session?.files[filePath]) return;

  const entry = session.files[filePath];
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

  const title =
    entry.originalContent === null
      ? `Claude Gate: ${label}  (new file${suffix})`
      : `Claude Gate: ${label}  (original ↔ current${suffix})`;

  await vscode.commands.executeCommand("vscode.diff", beforeUri, currentUri, title);

  if (entry.originalContent !== null) {
    revealFirstChange(beforeText, currentText);
  }
}

// ─── Open a record diff (Accepted / Rejected rows) ──────────────────────────

export async function openReviewRecord(id: string, sessionManager: SessionManager): Promise<void> {
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
