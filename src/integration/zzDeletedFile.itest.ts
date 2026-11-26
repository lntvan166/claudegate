import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  activateExtension, closeAllEditors, sessionFileFor, waitFor, workspaceRoot,
} from "./helpers";

// A file the hook captured right before `rm` deleted it: pending, with a
// baseline, and nothing on disk. Opening its `file:` URI gave VS Code's
// "unable to open" pane with a Create File button; the diff must instead show
// every line removed against an empty `claudegate:` side.
//
// Named zz… so it runs last: the entry it seeds stays in the session, and the
// other suites pick "the first pending file" by sorted path.
describe("a pending file deleted from disk", () => {
  let target: string;

  before(async () => {
    await activateExtension();
    const root = workspaceRoot();
    target = path.join(root, "zz-deleted-by-claude.txt");
    assert.ok(!fs.existsSync(target), "precondition: the file must not exist");
    const sessionFile = sessionFileFor(root);
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    session.files[target] = {
      originalContent: "one\ntwo\nthree\n",
      reviewStatus: "pending",
      newFile: false,
      sessionId: "itest",
      capturedAt: new Date().toISOString(),
    };
    fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));
  });

  afterEach(async () => closeAllEditors());

  const deletedDiffTab = (): vscode.Tab | undefined =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) =>
        t.input instanceof vscode.TabInputTextDiff &&
        t.input.modified.fsPath === target);

  it("opens a diff against an empty claudegate side, titled as a deletion", async () => {
    // The extension picks the seeded entry up through its fs watcher; until
    // then openDiff finds no entry and opens nothing, so retry.
    const tab = await waitFor("the deleted file's diff to open", async () => {
      await vscode.commands.executeCommand("claudegate.openDiff", target);
      return deletedDiffTab();
    });
    const input = tab.input as vscode.TabInputTextDiff;
    assert.strictEqual(input.original.scheme, "claudegate");
    assert.strictEqual(input.modified.scheme, "claudegate",
      `right side must not be a file: URI (got ${input.modified.toString()})`);
    assert.ok(input.modified.query.includes("deleted=1"), input.modified.toString());
    assert.ok(String(tab.label).includes("deleted · −3 lines"), `label: ${tab.label}`);

    const right = await vscode.workspace.openTextDocument(input.modified);
    assert.strictEqual(right.getText(), "");
    const left = await vscode.workspace.openTextDocument(input.original);
    assert.strictEqual(left.getText(), "one\ntwo\nthree\n");
    // Nothing was created on disk by opening it.
    assert.ok(!fs.existsSync(target));
  });

  it("is included in Review All Pending without failing", async () => {
    await vscode.commands.executeCommand("claudegate.reviewAllPending");
    await waitFor("the pending multi-diff to open", () =>
      vscode.window.tabGroups.all.some((g) =>
        g.tabs.some((t) => String(t.label).startsWith("Claude Gate: Pending"))) || undefined);
    assert.ok(!fs.existsSync(target));
  });
});
