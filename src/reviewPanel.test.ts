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
  const cmd = r.command as { command: string; arguments: unknown[] };
  assert.equal(cmd?.command, "claudegate.openReviewRecord",
    "carries a TreeItem.command — onDidChangeSelection cannot see a click on an already-selected row");
  assert.deepEqual(cmd?.arguments, [rec.id], "the command is given the record id to open");
  assert.equal(r.recordId, rec.id, "still exposes recordId for the selection fallback path");
  console.log("ok - RecordReviewItem carries a stable id, recordId, and its open command");
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

// ── Pending rows open via BOTH a TreeItem.command and selection ───────────────
// onDidChangeSelection cannot see a click on a row that is already selected —
// measured in a real host, selecting the same row twice fires the event once.
// Revealing the active file's row made that the normal case rather than an edge
// case, so clicking the row of the file you already have open did nothing.
// TreeItem.command fires on every click and is the only API that does; the
// selection path is kept as a fallback, and openDiff() collapses the pair.
{
  const mgr = {} as unknown as SessionManager;
  const fp = path.join(path.sep, "tmp", "x.ts");
  const item = new FileReviewItem(fp, "pending", mgr);
  const cmd = item.command as { command: string; arguments: unknown[] };
  assert.equal(cmd?.command, "claudegate.openDiff", "clicking a row dispatches the open command");
  assert.deepEqual(cmd?.arguments, [fp],
    "given only the path — the command resolves the owning worktree session itself");
  assert.equal(item.sessionManager, mgr, "still exposes its SessionManager for the selection fallback");
  console.log("ok - FileReviewItem opens via a click command, with selection as a fallback");
}
