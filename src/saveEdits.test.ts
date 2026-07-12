import assert from "node:assert";
import { workspace } from "./test-stubs/vscode";
import { saveDirtyPending } from "./saveEdits";

function run(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve()
    .then(fn)
    .then(() => console.log("ok -", name))
    .catch((e) => {
      console.error("FAIL -", name);
      console.error(e);
      process.exitCode = 1;
    });
}

type FakeDoc = { isDirty: boolean; uri: { fsPath: string }; save: () => Promise<boolean>; saved: boolean };
function doc(fsPath: string, isDirty: boolean): FakeDoc {
  const d: FakeDoc = {
    isDirty,
    uri: { fsPath },
    saved: false,
    save: async () => {
      d.saved = true;
      return true;
    },
  };
  return d;
}

run("saves a dirty in-scope document", async () => {
  const a = doc("/repo/a.ts", true);
  const b = doc("/repo/b.ts", true);
  workspace.textDocuments = [a, b];
  await saveDirtyPending(["/repo/a.ts"]);
  assert.equal(a.saved, true, "in-scope dirty doc should be saved");
  assert.equal(b.saved, false, "out-of-scope dirty doc must not be saved");
});

run("does not save a clean in-scope document", async () => {
  const a = doc("/repo/a.ts", false);
  workspace.textDocuments = [a];
  await saveDirtyPending(["/repo/a.ts"]);
  assert.equal(a.saved, false, "clean doc must not be saved");
});

run("win32 drive-letter case mismatch still matches", async () => {
  const orig = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    const a = doc("C:\\repo\\A.ts", true);
    workspace.textDocuments = [a];
    await saveDirtyPending(["c:\\repo\\a.ts"]);
    assert.equal(a.saved, true, "case-folded match should save on win32");
  } finally {
    Object.defineProperty(process, "platform", { value: orig, configurable: true });
  }
});

run("empty scope saves nothing", async () => {
  const a = doc("/repo/a.ts", true);
  workspace.textDocuments = [a];
  await saveDirtyPending([]);
  assert.equal(a.saved, false, "nothing in scope → no saves");
});

console.log("done");
