import * as vscode from "vscode";
import * as path from "path";
import { diffLines } from "diff";
import { SessionManager } from "./sessionManager";
import { countChanges, formatChangeCount } from "./changeCount";
import { chooseRightSide } from "./diffPlan";

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
        this._onDidChange.fire(claudeUri(fp));
      }
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const session = this.sessionManager.getSession();
    if (!session) return "";
    const entry = session.files[uri.path];
    if (!entry) return "";
    if (uri.query === "side=claude") {
      return entry.claudeContent ?? "// Claude's version not available";
    }
    return entry.originalContent ?? "// New file — no original content";
  }
}

export function originalUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({ scheme: SCHEME });
}

export function claudeUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({ scheme: SCHEME, query: "side=claude" });
}

// ─── Open diff ───────────────────────────────────────────────────────────────
//
// Pending  → baseline (originalContent) ↔ current file on disk (the proposal).
// Accepted → baseline ↔ claudeContent (what you accepted): the working file no
//            longer differs, so diff the saved "after" snapshot instead.
// Rejected → baseline ↔ claudeContent (what you threw away): the file was
//            restored to baseline on disk, so again use the saved snapshot.

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

  // Reviewed files: show the saved before → after snapshot, independent of what
  // is on disk now (accept left the "after" in place, reject reverted it).
  if (chooseRightSide(entry.reviewStatus, entry.claudeContent != null) === "claude") {
    const afterText = entry.claudeContent ?? "";
    const verb = entry.reviewStatus === "accepted" ? "accepted" : "rejected";
    const suffix = ` · ${formatChangeCount(countChanges(beforeText, afterText))}`;
    const title =
      entry.originalContent === null
        ? `Claude Gate: ${label}  (${verb} — new file${suffix})`
        : `Claude Gate: ${label}  (${verb}${suffix})`;
    await vscode.commands.executeCommand("vscode.diff", beforeUri, claudeUri(filePath), title);
    revealFirstChange(beforeText, afterText);
    return;
  }

  // Pending (or a reviewed entry with no saved snapshot): baseline ↔ disk.
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
