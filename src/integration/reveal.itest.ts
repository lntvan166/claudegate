import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  activateExtension, chainTo, claudeGateDiffTabs, closeAllEditors, openEditor,
  readSession, revealState, showPendingPanel, sessionRoots, waitFor, workspaceRoot,
} from "./helpers";

// Everything here is behaviour that ONLY breaks in a real editor. Each assertion
// below corresponds to a bug that shipped:
//   - reveal drew nothing            ({select:false, focus:false} only scrolls)
//   - two rows wore ✓/✗ at once      (focus and selection are different things)
//   - a diff popped open per tab     (selecting a row is what opens the diff)
describe("revealing the active file in the Pending panel", () => {
  let pendingFiles: string[];

  before(async () => {
    await activateExtension();
    await showPendingPanel();
    pendingFiles = await waitFor("the seeded pending set to load", () => {
      const all = sessionRoots().flatMap((r) => Object.keys(readSession(r)?.files ?? {}));
      return all.length >= 2 ? all.sort() : undefined;
    });
  });

  afterEach(async () => closeAllEditors());

  it("builds a parent chain ending at the file's own row", async () => {
    const chain = await chainTo(pendingFiles[0]);
    assert.ok(chain.length > 0, "no chain built for a pending file");
    assert.strictEqual(
      chain[chain.length - 1],
      path.basename(pendingFiles[0]),
      "the chain must end at the file's row — reveal() targets the last element",
    );
  });

  it("returns an empty chain for a file with no row, instead of throwing", async () => {
    assert.deepStrictEqual(await chainTo(path.join(workspaceRoot(), "no", "such.ts")), []);
  });

  it("selects the row for the active editor", async () => {
    await openEditor(pendingFiles[0]);
    const state = await waitFor("the row to be selected", async () => {
      const s = await revealState();
      return s.selection.includes(pendingFiles[0]) ? s : undefined;
    });
    assert.deepStrictEqual(state.selection, [pendingFiles[0]], "exactly one row selected");
  });

  it("moves the selection when the active editor changes", async () => {
    await openEditor(pendingFiles[0]);
    await waitFor("the first row to be selected", async () =>
      (await revealState()).selection.includes(pendingFiles[0]));

    await openEditor(pendingFiles[1]);
    const state = await waitFor("the selection to follow", async () => {
      const s = await revealState();
      return s.selection.includes(pendingFiles[1]) ? s : undefined;
    });
    assert.deepStrictEqual(
      state.selection, [pendingFiles[1]],
      "the previous row must be deselected — otherwise two rows show inline actions",
    );
  });

  it("does NOT open a diff just because a file was opened", async () => {
    // The regression guard. Selecting a row is wired to openDiff, so without
    // `revealingPath` every tab switch would pop a diff editor open unbidden.
    assert.strictEqual(claudeGateDiffTabs().length, 0, "precondition: no diffs open");
    await openEditor(pendingFiles[0]);
    await waitFor("the row to be selected", async () =>
      (await revealState()).selection.includes(pendingFiles[0]));
    await new Promise((r) => setTimeout(r, 1500));   // let any stray openDiff land
    assert.strictEqual(claudeGateDiffTabs().length, 0, "reveal must not open a diff");
  });

  it("leaves keyboard focus in the editor", async () => {
    // reveal() passes focus:true to move the TREE's focus element. Measured here
    // because the obvious reading — that it steals editor focus — is wrong, and
    // acting on that wrong reading is what produced the two-rows-with-buttons bug.
    await openEditor(pendingFiles[0]);
    await waitFor("the row to be selected", async () =>
      (await revealState()).selection.includes(pendingFiles[0]));
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath, pendingFiles[0],
      "the editor must still be active after a reveal",
    );
  });
});
