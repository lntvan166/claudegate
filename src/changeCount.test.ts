import assert from "node:assert";
import { countChanges, formatChangeCount } from "./changeCount";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log("ok -", name);
  } catch (e) {
    console.error("FAIL -", name);
    console.error(e);
    process.exitCode = 1;
  }
}

run("countChanges: a modified line is 1 added + 1 removed", () => {
  assert.deepEqual(countChanges("a\nb\nc\n", "a\nB\nc\n"), { added: 1, removed: 1 });
});

run("countChanges: pure additions", () => {
  assert.deepEqual(countChanges("", "x\ny\n"), { added: 2, removed: 0 });
});

run("countChanges: identical content is zero", () => {
  assert.deepEqual(countChanges("x\ny\n", "x\ny\n"), { added: 0, removed: 0 });
});

run("formatChangeCount variants", () => {
  assert.equal(formatChangeCount({ added: 12, removed: 3 }), "+12 -3");
  assert.equal(formatChangeCount({ added: 7, removed: 0 }), "+7");
  assert.equal(formatChangeCount({ added: 0, removed: 4 }), "-4");
  assert.equal(formatChangeCount({ added: 0, removed: 0 }), "no changes");
});

console.log("done");
