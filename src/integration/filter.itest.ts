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

// Accept/Reject-matching are the scoped counterpart to Accept All, which
// deliberately ignores the filter. The risk they carry is the opposite of the
// bug that motivated them: acting on MORE than the filter describes.
describe("Accept / Reject matching", () => {
  before(async () => {
    await activateExtension();
    await showPendingPanel();
  });

  afterEach(async () => setFilter(null));

  it("registers both commands", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("claudegate.acceptFiltered"), "acceptFiltered not registered");
    assert.ok(all.includes("claudegate.rejectFiltered"), "rejectFiltered not registered");
  });

  it("does nothing at all when no filter is set", async () => {
    // Without this guard the command would silently behave as Accept All — the
    // exact all-or-nothing trap it exists to remove.
    const before = totalPendingOnDisk();
    assert.ok(before > 0, "precondition: something is pending");
    await vscode.commands.executeCommand("claudegate.acceptFiltered");
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(totalPendingOnDisk(), before,
      "an unfiltered panel must leave every pending file untouched");
  });

  it("acts on strictly fewer files than Accept All would", async () => {
    const state0 = await filterState();
    await setFilter("zzz-matches-nothing");
    const narrowed = await filterState();
    assert.strictEqual(narrowed.shown, 0, "nothing matches");
    assert.strictEqual(narrowed.total, state0.total, "but the total is unchanged");

    const before = totalPendingOnDisk();
    await vscode.commands.executeCommand("claudegate.acceptFiltered");
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual(totalPendingOnDisk(), before,
      "a filter matching nothing must accept nothing — not everything");
  });
});

// Accepting a file while the panel is filtered used to clear the filter: the
// auto-advance picked the first pending file OVERALL, the filter hid it, and the
// reveal cleared the filter to show it. From the user's side the filter simply
// vanished on every decision, which makes filtered review impossible.
describe("a decision does not clear the filter", () => {
  before(async () => {
    await activateExtension();
    await showPendingPanel();
  });

  afterEach(async () => {
    await setFilter(null);
    await closeAllEditors();
  });

  it("keeps the filter set after accepting a matching file", async () => {
    const files = await waitFor("pending files", () => {
      const a = sessionRoots().flatMap((r) => Object.keys(readSession(r)?.files ?? {})).sort();
      return a.length >= 3 ? a : undefined;
    });

    // Filter to exactly one file, so the auto-advance has to leave the filtered
    // set — the condition that used to clear it.
    const only = path.basename(files[0]);
    await setFilter(only);
    const narrowed = await filterState();
    assert.ok(narrowed.shown >= 1, "the filter matches at least the target file");
    assert.ok(narrowed.shown < narrowed.total, "and hides the rest");

    await openEditor(files[0]);
    await waitFor("the row to be selected", async () =>
      (await revealState()).selection.includes(files[0]));

    await vscode.commands.executeCommand("claudegate.acceptCurrent");
    await new Promise((r) => setTimeout(r, 1800));

    const after = await filterState();
    assert.strictEqual(after.filter, only,
      `the filter must survive a decision — it was "${only}", now ${JSON.stringify(after.filter)}`);
  });

  it("advances within the filter rather than out of it", async () => {
    const files = await waitFor("pending files", () => {
      const a = sessionRoots().flatMap((r) => Object.keys(readSession(r)?.files ?? {})).sort();
      return a.length >= 3 ? a : undefined;
    });

    // ".go" matches several files, so there is somewhere to advance TO.
    await setFilter(".go");
    const s = await filterState();
    assert.ok(s.shown >= 2, "need at least two matching files to test advancing");

    const goFiles = files.filter((f) => f.endsWith(".go"));
    await openEditor(goFiles[0]);
    await waitFor("selected", async () => (await revealState()).selection.includes(goFiles[0]));

    await vscode.commands.executeCommand("claudegate.acceptCurrent");
    await new Promise((r) => setTimeout(r, 1800));

    assert.strictEqual((await filterState()).filter, ".go", "filter intact");
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (active) {
      assert.ok(active.endsWith(".go"),
        `auto-advance landed on ${active}, which the filter does not match`);
    }
  });
});
