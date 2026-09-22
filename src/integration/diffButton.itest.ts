import * as assert from "assert";
import * as vscode from "vscode";
import {
  activateExtension, claudeGateDiffTabs, closeAllEditors, openEditor,
  readSession, sessionRoots, showPendingPanel, waitFor,
} from "./helpers";

// The editor title-bar "View Diff" button. Its `when` clause and its argument
// shape are both things only a real host can check: a command that expects a
// tree item but is invoked from a title bar receives nothing.
describe("View Diff from the editor title bar", () => {
  let pendingFile: string;

  before(async () => {
    await activateExtension();
    await showPendingPanel();
    pendingFile = await waitFor("a seeded pending file", () => {
      const all = sessionRoots().flatMap((r) => Object.keys(readSession(r)?.files ?? {}));
      return all.sort()[0];
    });
  });

  afterEach(async () => closeAllEditors());

  it("opens a claudegate diff for the active pending file", async () => {
    await openEditor(pendingFile);
    assert.strictEqual(claudeGateDiffTabs().length, 0, "precondition: no diff open");

    // Invoked with NO argument, exactly as the title-bar menu does it.
    await vscode.commands.executeCommand("claudegate.openActiveDiff");

    const tabs = await waitFor("a claudegate diff tab to open", () => {
      const t = claudeGateDiffTabs();
      return t.length > 0 ? t : undefined;
    });
    assert.ok(
      String(tabs[0].label).includes("Claude Gate"),
      `unexpected diff tab label: ${tabs[0].label}`,
    );
  });

  it("is harmless on a file with nothing pending", async () => {
    // The `when` clause hides the button here, but the command stays reachable
    // from the palette and a keybinding, so it must not throw.
    await vscode.commands.executeCommand("claudegate.openActiveDiff");
  });
});
