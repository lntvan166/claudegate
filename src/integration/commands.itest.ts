import * as assert from "assert";
import * as vscode from "vscode";
import { activateExtension } from "./helpers";

// The cheapest class of bug a real host catches and the unit stub cannot: a
// command that is contributed in package.json but never registered (or vice
// versa) shows up only as a greyed-out menu entry at runtime.
describe("command registration", () => {
  before(async () => activateExtension());

  it("registers every command the panels and menus bind to", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      "claudegate.acceptFile",
      "claudegate.rejectFile",
      "claudegate.acceptAll",
      "claudegate.rejectAll",
      "claudegate.clearAccepted",
      "claudegate.clearRejected",
      "claudegate.revertAcceptedFolder",
      "claudegate.reapplyFolder",
      "claudegate.openDiff",
      "claudegate.openActiveDiff",
      "claudegate.openFile",
    ]) {
      assert.ok(all.includes(id), `${id} is contributed but not registered`);
    }
  });

  it("contributes no command it fails to register", async () => {
    const ext = vscode.extensions.getExtension("lntvan166.claudegate")!;
    const contributed: string[] = (ext.packageJSON.contributes?.commands ?? [])
      .map((c: { command: string }) => c.command);
    assert.ok(contributed.length > 0, "package.json contributes no commands?");
    const all = await vscode.commands.getCommands(true);
    const missing = contributed.filter((id) => !all.includes(id));
    assert.deepStrictEqual(missing, [], "contributed but unregistered");
  });
});
