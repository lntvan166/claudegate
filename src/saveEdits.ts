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
