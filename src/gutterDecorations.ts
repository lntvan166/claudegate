import * as vscode from "vscode";
import * as path from "path";
import { SessionManager } from "./sessionManager";
import { classifyChangedLines } from "./lineDiff";
import { isInWorkspace, isExcluded } from "./workspaceScope";

const DEBOUNCE_MS = 300;

export class GutterDecorator {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly modified: vscode.TextEditorDecorationType;
  private readonly deleted: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sessionManager: SessionManager,
    context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel
  ) {
    const icon = (name: string) =>
      vscode.Uri.file(path.join(context.extensionPath, "media", name));
    const make = (svg: string, ruler: string) =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: icon(svg),
        gutterIconSize: "contain",
        overviewRulerColor: new vscode.ThemeColor(ruler),
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
    this.added = make("gutter-added.svg", "editorGutter.addedBackground");
    this.modified = make("gutter-modified.svg", "editorGutter.modifiedBackground");
    this.deleted = make("gutter-deleted.svg", "editorGutter.deletedBackground");
  }

  start(): void {
    this.refreshAllVisible();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed) this.refresh(ed); }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAllVisible()),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleForDoc(e.document)),
      this.sessionManager.onSessionChange(() => this.refreshAllVisible()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("claudegate.gutterDecorations.enabled")) this.refreshAllVisible();
      })
    );
  }

  stop(): void {
    if (this.debounce !== undefined) { clearTimeout(this.debounce); this.debounce = undefined; }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.added.dispose();
    this.modified.dispose();
    this.deleted.dispose();
  }

  private scheduleForDoc(doc: vscode.TextDocument): void {
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document === doc) this.refresh(ed);
      }
    }, DEBOUNCE_MS);
  }

  private refreshAllVisible(): void {
    for (const ed of vscode.window.visibleTextEditors) this.refresh(ed);
  }

  private refresh(editor: vscode.TextEditor): void {
    if (editor.document.uri.scheme !== "file") return;
    const fp = editor.document.uri.fsPath;
    const enabled = vscode.workspace
      .getConfiguration("claudegate")
      .get<boolean>("gutterDecorations.enabled", true);
    const entry = this.sessionManager.getSession()?.files[fp];
    if (!enabled || entry?.reviewStatus !== "pending" || !isInWorkspace(fp) || isExcluded(fp)) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.modified, []);
      editor.setDecorations(this.deleted, []);
      return;
    }
    const c = classifyChangedLines(entry.originalContent ?? "", editor.document.getText());
    const toRanges = (lines: number[]) => lines.map((l) => new vscode.Range(l, 0, l, 0));
    editor.setDecorations(this.added, toRanges(c.added));
    editor.setDecorations(this.modified, toRanges(c.modified));
    editor.setDecorations(this.deleted, toRanges(c.deleted));
  }
}
