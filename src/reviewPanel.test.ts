import * as assert from "assert";
import * as path from "path";
import { openFolderInNewWindow, FolderItem, FileReviewItem, RecordReviewItem, SessionItem } from "./reviewPanel";
import type { ReviewRecord, SessionManager } from "./sessionManager";
import { executedCommands } from "./test-stubs/vscode";

// ── openFolderInNewWindow opens the given folder as a NEW VS Code window ──
// Backs the "Open in New Window" right-click action on Pending folder nodes.
{
  executedCommands.length = 0;
  const dir = path.join(path.sep, "tmp", "ws-beta");

  openFolderInNewWindow(dir);

  assert.equal(executedCommands.length, 1, "dispatches exactly one command");
  const call = executedCommands[0];
  assert.equal(call.command, "vscode.openFolder", "uses vscode.openFolder");
  const [uri, opts] = call.args as [{ fsPath: string }, { forceNewWindow?: boolean }];
  assert.equal(uri.fsPath, dir, "opens the folder that was passed in");
  assert.equal(opts?.forceNewWindow, true, "forces a NEW window (not the current one)");
  console.log("ok - openFolderInNewWindow dispatches vscode.openFolder with forceNewWindow");
}

// ── Pending FolderItem exposes the contextValue + folderPath the menu binds to ──
// The package.json view/item/context `when` clause targets this exact
// contextValue, and the command reads folderPath — lock both.
{
  const dir = path.join(path.sep, "tmp", "sub");
  const item = new FolderItem(dir, "pending");
  assert.equal(item.contextValue, "claudegate.folder.pending", "menu when-clause contract");
  assert.equal(item.folderPath, dir, "carries folderPath for the command argument");
  console.log("ok - Pending FolderItem carries the contextValue + folderPath the menu binds to");
}

// ── Tree items carry stable, unique ids so VS Code diffs children by identity ──
// Without an id, VS Code regenerates a node handle from the label on every
// onDidChangeTreeData refresh; accepting one file tears down and rebuilds ALL
// rows, and a click landing in that window dispatches to a stale node —
// surfacing as "command 'claudegate.openDiff' not found" (microsoft/vscode#153982).
// Stable ids let VS Code remove only the changed row and keep the other rows'
// nodes live, so a fast follow-up click still resolves to a real command.
{
  const dummyMgr = {} as unknown as import("./sessionManager").SessionManager;
  const a  = new FileReviewItem(path.join(path.sep, "tmp", "a.ts"), "pending", dummyMgr);
  const a2 = new FileReviewItem(path.join(path.sep, "tmp", "a.ts"), "pending", dummyMgr);
  const b  = new FileReviewItem(path.join(path.sep, "tmp", "b.ts"), "pending", dummyMgr);
  assert.ok(a.id, "FileReviewItem has a stable id");
  assert.equal(a.id, a2.id, "same file → same id across refreshes (node identity preserved)");
  assert.notEqual(a.id, b.id, "different files → different ids (unique across the tree)");
  console.log("ok - FileReviewItem carries a stable, unique id");
}

// ── RecordReviewItem (accepted/rejected leaves) also carry a stable id ─────────
{
  const rec: ReviewRecord = {
    id: "2026-07-20T00:00:00.000Z::" + path.join(path.sep, "tmp", "a.ts"),
    path: path.join(path.sep, "tmp", "a.ts"),
    before: "x", after: "y",
    decidedAt: "2026-07-20T00:00:00.000Z", sessionId: "s",
  };
  const r  = new RecordReviewItem(rec, "accepted");
  const r2 = new RecordReviewItem(rec, "accepted");
  assert.ok(r.id, "RecordReviewItem has an id");
  assert.equal(r.id, r2.id, "same record → same id across refreshes");
  // Opened via the Accepted/Rejected views' onDidChangeSelection, not a command.
  assert.equal(r.command, undefined, "no TreeItem.command (opened via onDidChangeSelection)");
  assert.equal(r.recordId, rec.id, "exposes recordId for the selection handler");
  console.log("ok - RecordReviewItem carries a stable id, recordId, and no command");
}

// ── Container nodes (Folder / Session) carry ids so leaves keep their parent ──
// path stable across refresh; without stable parents the leaves re-render too.
{
  const f = new FolderItem(path.join(path.sep, "tmp", "sub"), "pending", "sess-1");
  assert.ok(f.id, "FolderItem has an id");
  const fOther = new FolderItem(path.join(path.sep, "tmp", "sub"), "pending", "sess-2");
  assert.notEqual(f.id, fOther.id, "same folder under different sessions → different ids (grouped mode)");

  const s = new SessionItem("sess-1", "Session 1", 3);
  assert.ok(s.id, "SessionItem has an id");
  console.log("ok - Folder/Session container nodes carry ids");
}

// ── Pending rows open via selection, NOT a TreeItem.command ───────────────────
// Binding the open to TreeItem.command lets VS Code dispatch it through the tree's
// click→command path, which fails with "Actual command not found, wanted to
// execute claudegate.openDiff/<handle>" when the node is stale mid-refresh (right
// after accepting another file — microsoft/vscode#173233). The pending panel's
// onDidChangeSelection handler opens the diff instead, so the row must (a) carry
// no command and (b) expose the SessionManager the handler passes to openDiff.
{
  const mgr = {} as unknown as SessionManager;
  const item = new FileReviewItem(path.join(path.sep, "tmp", "x.ts"), "pending", mgr);
  assert.equal(item.command, undefined, "no TreeItem.command (opened via onDidChangeSelection)");
  assert.equal(item.sessionManager, mgr, "exposes its SessionManager for the selection handler");
  console.log("ok - FileReviewItem opens via selection, carries its manager, has no command");
}
