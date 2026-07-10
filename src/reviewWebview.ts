import * as vscode from "vscode";
import * as fs from "fs";
import { SessionManager } from "./sessionManager";
import { buildReviewModel, buildFeedbackText, ReviewItemInput } from "./reviewWebviewModel";
import { isInWorkspace, isExcluded, isProtected } from "./workspaceScope";

export class ReviewWebviewPanel {
  private static current: ReviewWebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private batchOrder: string[] = []; // stable display order: seed pending, then late arrivals

  static showOrReveal(context: vscode.ExtensionContext, sessionManager: SessionManager): void {
    if (ReviewWebviewPanel.current) {
      ReviewWebviewPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ReviewWebviewPanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "claudegate.reviewChanges",
      "Claude Gate: Review Changes",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] }
    );
    ReviewWebviewPanel.current = new ReviewWebviewPanel(panel, context, sessionManager);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly sessionManager: SessionManager
  ) {
    this.batchOrder = this.currentPendingPaths();
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    this.sessionManager.onSessionChange(() => this.render(), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private currentPendingPaths(): string[] {
    const s = this.sessionManager.getSession();
    if (!s) return [];
    return Object.keys(s.files)
      .filter((fp) => isInWorkspace(fp) && !isExcluded(fp))
      .sort((a, b) => (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b));
  }

  // Assemble the review items in stable batch order: every path seen while this
  // panel is open (seed pending set + any later captures), each tagged with its
  // current status (pending / kept / undone) and diff content.
  private items(): ReviewItemInput[] {
    const s = this.sessionManager.getSession();
    if (!s) return [];
    for (const fp of this.currentPendingPaths()) if (!this.batchOrder.includes(fp)) this.batchOrder.push(fp);

    const items: ReviewItemInput[] = [];
    for (const fp of this.batchOrder) {
      if (!isInWorkspace(fp) || isExcluded(fp)) continue;
      const rel = vscode.workspace.asRelativePath(fp, false).split(/[\\/]/).join("/");
      const pending = s.files[fp];
      if (pending) {
        const after = this.readOrNull(fp);
        items.push({
          relPath: rel, before: pending.originalContent, after,
          status: "pending", isNew: pending.originalContent === null, isProtected: isProtected(fp),
        });
        continue;
      }
      const rejected = s.rejected[fp];
      if (rejected) {
        items.push({ relPath: rel, before: rejected.before, after: rejected.after, status: "undone",
          isNew: !!rejected.newFile, isProtected: isProtected(fp), reason: rejected.reason });
        continue;
      }
      const accepted = [...s.accepted].reverse().find((r) => r.path === fp);
      if (accepted) {
        items.push({ relPath: rel, before: accepted.before, after: accepted.after, status: "kept",
          isNew: !!accepted.newFile, isProtected: isProtected(fp) });
      }
    }
    return items;
  }

  private readOrNull(fp: string): string | null {
    try { return fs.readFileSync(fp, "utf-8"); } catch { return null; }
  }

  private render(): void {
    const items = this.items();
    this.panel.webview.postMessage({
      type: "render",
      model: buildReviewModel(items),
      diffMode: vscode.workspace.getConfiguration("claudegate").get<string>("review.diffMode", "split"),
      feedbackText: buildFeedbackText(items),
    });
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case "ready": this.render(); break;
      case "keep": if (m.path) this.sessionManager.acceptFile(this.abs(m.path)); break;
      case "undo": if (m.path) this.sessionManager.rejectFile(this.abs(m.path), m.reason || undefined); break;
      case "keepAll": this.sessionManager.acceptAll(); break;
      case "undoAll": {
        const answer = await vscode.window.showWarningMessage(
          "Revert all pending files to their original content?", { modal: true }, "Revert All");
        if (answer === "Revert All") this.sessionManager.rejectAll();
        break;
      }
      case "setDiffMode":
        if (m.mode === "split" || m.mode === "unified")
          await vscode.workspace.getConfiguration("claudegate").update("review.diffMode", m.mode,
            (vscode.workspace.workspaceFolders?.length ?? 0) > 0 ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        break;
      case "copyFeedback": {
        await vscode.env.clipboard.writeText(buildFeedbackText(this.items()));
        vscode.window.showInformationMessage("Claude Gate: review feedback copied to clipboard.");
        break;
      }
    }
  }

  // relPath from the webview → absolute fs path via the first workspace folder.
  private abs(rel: string): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, rel).fsPath : rel;
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = getNonce();
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "review", "review.css"));
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "review", "review.js"));
    return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';" />
<link href="${css}" rel="stylesheet" /></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  private dispose(): void {
    ReviewWebviewPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = ""; for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
