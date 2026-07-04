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

// ─── Open diff: original (left) vs current on-disk (right) ───────────────────

export async function openDiff(
  filePath: string,
  sessionManager: SessionManager
): Promise<void> {
  const session = sessionManager.getSession();
  if (!session?.files[filePath]) return;

  const entry = session.files[filePath];
  const label = path.basename(filePath);
  const beforeUri = originalUri(filePath);

  // Rejected new file: the file was deleted; show Claude's saved content instead
  if (entry.originalContent === null && entry.reviewStatus === "rejected") {
    const rightUri = claudeUri(filePath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      rightUri,
      `Claude Gate: ${label}  (rejected — Claude's version)`
    );
    return;
  }

  const currentUri = vscode.Uri.file(filePath);

  // Change-size suffix for the title (best-effort; empty on read failure).
  let suffix = "";
  try {
    const currentText = (await vscode.workspace.openTextDocument(filePath)).getText();
    suffix = ` · ${formatChangeCount(countChanges(entry.originalContent ?? "", currentText))}`;
  } catch {
    suffix = "";
  }

  const title =
    entry.originalContent === null
      ? `Claude Gate: ${label}  (new file${suffix})`
      : `Claude Gate: ${label}  (original ↔ current${suffix})`;

  await vscode.commands.executeCommand("vscode.diff", beforeUri, currentUri, title);

  // Scroll the right pane to the first changed line
  if (entry.originalContent !== null) {
    const currentDoc = await vscode.workspace.openTextDocument(filePath);
    const changes = diffLines(entry.originalContent, currentDoc.getText());
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
}
