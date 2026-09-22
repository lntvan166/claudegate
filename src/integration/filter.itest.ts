import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  activateExtension, chainTo, closeAllEditors, openEditor, readSession,
  revealState, sessionRoots, showPendingPanel, totalPendingOnDisk, waitFor,
} from "./helpers";

interface FilterState {
  filter: string | null; shown: number; total: number; description: string | null;
}
const filterState = () =>
  vscode.commands.executeCommand<FilterState>("claudegate._test.filterState");
const setFilter = (f: string | null) =>
  vscode.commands.executeCommand("claudegate._test.setFilter", f);

describe("Pending panel filter", () => {
  let pendingFiles: string[];

  before(async () => {
    await activateExtension();
    await showPendingPanel();
    pendingFiles = await waitFor("the seeded pending set", () => {
      const all = sessionRoots().flatMap((r) => Object.keys(readSession(r)?.files ?? {}));
      return all.length >= 2 ? all.sort() : undefined;
    });
  });

  afterEach(async () => {
    await setFilter(null);
    await closeAllEditors();
  });

  it("narrows the tree to matching rows and reports shown-of-total", async () => {
    const before = await filterState();
    assert.strictEqual(before.filter, null, "precondition: unfiltered");
    assert.ok(before.total > 1, "fixture needs more than one pending file");
    assert.strictEqual(before.description, null, "no description while unfiltered");

    const target = pendingFiles[0];
    await setFilter(path.basename(target));

    const after = await filterState();
    assert.strictEqual(after.total, before.total, "the total is the unfiltered count");
    assert.ok(after.shown >= 1, "the matching row is still shown");
    assert.ok(after.shown < after.total, "and some rows are hidden");
    assert.ok(
      after.description?.includes(`${after.shown} of ${after.total}`),
      `description must carry both counts, got: ${after.description}`,
    );
  });

  it("hides a row that does not match, and chainTo agrees", async () => {
    await setFilter("zzz-matches-nothing");
    const state = await filterState();
    assert.strictEqual(state.shown, 0, "nothing matches");
    assert.deepStrictEqual(await chainTo(pendingFiles[0]), [],
      "a hidden file has no row, so no chain");
  });

  it("clears itself when the user opens a file the filter hides", async () => {
    // Navigating to a pending file is a deliberate act; a filter set earlier is
    // stale. Silently failing to reveal would look like the reveal is broken.
    await setFilter("zzz-matches-nothing");
    assert.strictEqual((await filterState()).shown, 0);

    await openEditor(pendingFiles[0]);

    const state = await waitFor("the filter to clear itself", async () => {
      const s = await filterState();
      return s.filter === null ? s : undefined;
    });
    assert.strictEqual(state.filter, null, "filter cleared");
    await waitFor("the row to be revealed after clearing", async () =>
      (await revealState()).selection.includes(pendingFiles[0]));
  });

  it("does not let Accept All silently skip filtered-out files", async () => {
    // A filter is a lens, not a selection. This is the same bug class as the
    // worktree one: acting on a subset of what exists, without saying so.
    const total = totalPendingOnDisk();
    assert.ok(total > 1, "fixture needs more than one pending file");

    await setFilter(path.basename(pendingFiles[0]));
    const state = await filterState();
    assert.ok(state.shown < state.total, "precondition: the filter hides something");

    // acceptAll's scope comes from the session managers, never the filtered view.
    const scoped = await vscode.commands.executeCommand<{ pending: string[] }>(
      "claudegate._test.scopes");
    assert.strictEqual(
      scoped.pending.length, total,
      "Accept All's scope must be the full pending set, not the filtered rows",
    );
  });
});
