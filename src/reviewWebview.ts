import * as vscode from "vscode";
import * as fs from "fs";
import { SessionManager } from "./sessionManager";
import { WorktreeSessionRegistry } from "./worktreeSessionRegistry";
import { buildReviewPayload, buildFeedbackText, ReviewItemInput } from "./reviewWebviewModel";
import { isInWorkspace, isExcluded, isProtected } from "./workspaceScope";

export class ReviewWebviewPanel {
  private static current: ReviewWebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private batchOrder: string[] = []; // stable display order: seed pending, then late arrivals
  private relToAbs = new Map<string, string>(); // relPath -> absolute fs path, rebuilt each items() call

  static showOrReveal(
    context: vscode.ExtensionContext,
    sessionManager: SessionManager,
    worktreeRegistry: WorktreeSessionRegistry
  ): void {
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
    ReviewWebviewPanel.current = new ReviewWebviewPanel(panel, context, sessionManager, worktreeRegistry);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly sessionManager: SessionManager,
    private readonly worktreeRegistry: WorktreeSessionRegistry
  ) {
    this.batchOrder = this.currentPendingPaths();
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);
    // Worktree session changes already fan into the primary onSessionChange via
    // notifyChanged(), so a single subscription re-renders on any session change.
    this.sessionManager.onSessionChange(() => this.render(), null, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  // Resolve the SessionManager that owns a given absolute path: the worktree it
  // falls under, else the primary window session.
  private managerFor(absPath: string): SessionManager {
    return this.worktreeRegistry.managerFor(absPath) ?? this.sessionManager;
  }

  // Every session in scope: the primary window plus each nested worktree.
  private allManagers(): SessionManager[] {
    return [this.sessionManager, ...this.worktreeRegistry.getManagers().values()];
  }

  private currentPendingPaths(): string[] {
    const all: string[] = [];
    for (const mgr of this.allManagers()) {
      const s = mgr.getSession();
      if (!s) continue;
      for (const fp of Object.keys(s.files)) {
        if (isInWorkspace(fp) && !isExcluded(fp)) all.push(fp);
      }
    }
    return all.sort(
      (a, b) => (Number(isProtected(b)) - Number(isProtected(a))) || a.localeCompare(b)
    );
  }

  // Assemble the review items in stable batch order: every path seen while this
  // panel is open (seed pending set + any later captures), each tagged with its
  // current status (pending / kept / undone) and diff content, read from the
  // session (primary or worktree) that owns the path.
  private items(): ReviewItemInput[] {
    for (const fp of this.currentPendingPaths()) if (!this.batchOrder.includes(fp)) this.batchOrder.push(fp);

    this.relToAbs.clear();
    const items: ReviewItemInput[] = [];
    for (const fp of this.batchOrder) {
      if (!isInWorkspace(fp) || isExcluded(fp)) continue;
      const s = this.managerFor(fp).getSession();
      if (!s) continue;
      const rel = vscode.workspace.asRelativePath(fp, false).split(/[\\/]/).join("/");
      this.relToAbs.set(rel, fp);
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
    // Strict UTF-8 decode (see SessionManager.readFileOrNull): a binary file
    // must render as "no text to show", never as U+FFFD mojibake in the diff.
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fp));
    } catch {
      return null;
    }
  }

  private render(): void {
    const items = this.items();
    const { files, reviewedCount, totalCount } = buildReviewPayload(items);
    this.panel.webview.postMessage({
      type: "render",
      files,
      reviewedCount,
      totalCount,
      feedbackText: buildFeedbackText(items),
    });
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case "ready": this.render(); break;
      case "keep": {
        const target = m.path ? this.relToAbs.get(m.path) : undefined;
        if (target) this.managerFor(target).acceptFile(target);
        break;
      }
      case "undo": {
        const target = m.path ? this.relToAbs.get(m.path) : undefined;
        if (target) this.managerFor(target).rejectFile(target, m.reason || undefined);
        break;
      }
      case "keepAll":
        for (const mgr of this.allManagers()) mgr.acceptAll();
        break;
      case "undoAll": {
        const answer = await vscode.window.showWarningMessage(
          "Revert all pending files to their original content?", { modal: true }, "Revert All");
        if (answer === "Revert All") for (const mgr of this.allManagers()) mgr.rejectAll();
        break;
      }
      case "copyFeedback": {
        await vscode.env.clipboard.writeText(buildFeedbackText(this.items()));
        vscode.window.showInformationMessage("Claude Gate: review feedback copied to clipboard.");
        break;
      }
      case "openNative": {
        const target = m.path ? this.relToAbs.get(m.path) : undefined;
        if (!target) break;
        const s = this.managerFor(target).getSession();
        if (s?.files[target]) {
          // Pending → the original-vs-current diff.
          await vscode.commands.executeCommand("claudegate.openDiff", target);
        } else {
          // Decided → the frozen before→after of its latest record.
          const rec = s?.rejected[target] ?? [...(s?.accepted ?? [])].reverse().find((r) => r.path === target);
          if (rec) await vscode.commands.executeCommand("claudegate.openReviewRecord", rec.id);
        }
        break;
      }
    }
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
