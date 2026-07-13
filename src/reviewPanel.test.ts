import * as assert from "assert";
import * as path from "path";
import { openFolderInNewWindow, FolderItem } from "./reviewPanel";
import { executedCommands } from "./test-stubs/vscode";

// ── openFolderInNewWindow opens the given folder as a NEW VS Code window ──
// Backs the "Open in New Window" right-click action on Pending folder nodes.
{
  executedCommands.length = 0;
  const dir = path.join(path.sep, "tmp", "ws-shipperstatus");

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
