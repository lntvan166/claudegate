import * as vscode from "vscode";
import * as path from "path";
import { diffLines } from "diff";
import { SessionManager } from "./sessionManager";

export const SCHEME = "claudegate";

// ─── Virtual document provider (serves original content for left side of diff) ─

export class ClaudeGateContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly sessionManager: SessionManager) {
    sessionManager.onSessionChange(() =>
      this._onDidChange.fire(vscode.Uri.parse(`${SCHEME}://refresh`))
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const session = this.sessionManager.getSession();
    if (!session) return "";
    const entry = session.files[uri.path];
    if (!entry) return "";
    return entry.originalContent ?? "// New file — no original content";
  }
}

export function originalUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(filePath).with({ scheme: SCHEME });
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
  const currentUri = vscode.Uri.file(filePath);
  const beforeUri = originalUri(filePath);

  const title =
    entry.originalContent === null
      ? `ClaudeGate: ${label}  (new file)`
      : `ClaudeGate: ${label}  (original ↔ current)`;

  await vscode.commands.executeCommand("vscode.diff", beforeUri, currentUri, title);

  // Scroll the right pane (current file) to the first changed line
  if (entry.originalContent !== null) {
    const currentDoc = await vscode.workspace.openTextDocument(filePath);
    const changes = diffLines(entry.originalContent, currentDoc.getText());
    let firstChangedLine = 0;
    let cursor = 0;
    for (const change of changes) {
      if (change.added || change.removed) { firstChangedLine = cursor; break; }
      if (!change.removed) cursor += change.count ?? 0;
    }
    // Reveal in the active diff editor
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.revealRange(
        new vscode.Range(firstChangedLine, 0, firstChangedLine, 0),
        vscode.TextEditorRevealType.InCenter
      );
    }
  }
}
