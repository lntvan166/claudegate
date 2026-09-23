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

// Revealing necessarily scrolls — that is what "reveal" means in the TreeView
// API, and there is no option to select without it. So the panel following the
// editor has to be switchable off, or a user who wants a stable scroll position
// has no way out.
describe("auto-reveal can be turned off", () => {
  before(async () => activateExtension());

  after(async () => {
    await vscode.workspace.getConfiguration("claudegate")
      .update("autoRevealPending", undefined, vscode.ConfigurationTarget.Global);
  });

  it("registers the on-demand command, so turning it off loses nothing", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("claudegate.revealActiveFile"),
      "claudegate.revealActiveFile must exist as the manual escape hatch");
  });

  it("stops following the editor when disabled", async () => {
    const files = await waitFor("two pending files", () => {
      const a = sessionRoots().flatMap((r) => Object.keys(readSession(r)?.files ?? {})).sort();
      return a.length >= 2 ? a : undefined;
    });
    await showPendingPanel();

    // Establish a known selection while the feature is on.
    await openEditor(files[0]);
    await waitFor("the first row selected", async () =>
      (await revealState()).selection.includes(files[0]));

    await vscode.workspace.getConfiguration("claudegate")
      .update("autoRevealPending", false, vscode.ConfigurationTarget.Global);

    await openEditor(files[1]);
    await new Promise((r) => setTimeout(r, 1200));
    const after = await revealState();
    assert.deepStrictEqual(after.selection, [files[0]],
      "with auto-reveal off the selection must NOT follow the editor — that is what keeps the scroll position still");

    // And the manual command still does the job on request.
    await vscode.commands.executeCommand("claudegate.revealActiveFile");
    await waitFor("the manual reveal to move the selection", async () =>
      (await revealState()).selection.includes(files[1]));
  });
});

// The panel nudged its own scroll position after every click: clicking a row
// selects it, opens the diff, changes the active editor and comes straight back
// here — and reveal() re-scrolls even an element already on screen. The Explorer
// does not do this because it never re-reveals a row you just clicked.
describe("does not re-reveal a row that is already selected", () => {
  const revealCount = () => vscode.commands.executeCommand<number>("claudegate._test.revealCount");

  before(async () => {
    await activateExtension();
    await showPendingPanel();
  });

  it("skips the reveal when the active file's row is already the selection", async () => {
    const files = await waitFor("two pending files", () => {
      const a = sessionRoots().flatMap((r) => Object.keys(readSession(r)?.files ?? {})).sort();
      return a.length >= 2 ? a : undefined;
    });

    // Moving to a NOT-selected row must reveal: that is the feature.
    await openEditor(files[0]);
    await waitFor("the row to be selected", async () =>
      (await revealState()).selection.includes(files[0]));
    const afterFirst = await revealCount();

    // Re-activating the same file must NOT reveal again — its row is already
    // selected, so there is nothing to scroll to.
    await closeAllEditors();
    await openEditor(files[0]);
    await new Promise((r) => setTimeout(r, 1200));
    assert.strictEqual(await revealCount(), afterFirst,
      "re-opening the already-selected file must not reveal again (this is what moved the scroll)");

    // A different file still reveals.
    await openEditor(files[1]);
    await waitFor("the second row to be selected", async () =>
      (await revealState()).selection.includes(files[1]));
    assert.ok(await revealCount() > afterFirst, "a different row still reveals");
  });

  it("the explicit command reveals even when already selected", async () => {
    const files = await waitFor("a pending file", () => {
      const a = sessionRoots().flatMap((r) => Object.keys(readSession(r)?.files ?? {})).sort();
      return a.length ? a : undefined;
    });
    await openEditor(files[0]);
    await waitFor("selected", async () => (await revealState()).selection.includes(files[0]));
    const before = await revealCount();
    await vscode.commands.executeCommand("claudegate.revealActiveFile");
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(await revealCount() > before,
      "asking to be shown the active file must scroll to it even if its row is selected");
  });
});
