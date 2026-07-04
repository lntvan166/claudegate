import assert from "node:assert";
import { classifyChangedLines } from "./lineDiff";

function run(name: string, fn: () => void): void {
  try { fn(); console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name); console.error(e); process.exitCode = 1; }
}

run("modified line", () => {
  assert.deepEqual(classifyChangedLines("a\nb\nc\n", "a\nB\nc\n"), { added: [], modified: [1], deleted: [] });
});
run("pure insertion", () => {
  assert.deepEqual(classifyChangedLines("a\nc\n", "a\nb\nc\n"), { added: [1], modified: [], deleted: [] });
});
run("pure deletion marks the boundary line", () => {
  const r = classifyChangedLines("a\nb\nc\n", "a\nc\n");
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.modified, []);
  assert.deepEqual(r.deleted, [1]);
});
run("no change → all empty", () => {
  assert.deepEqual(classifyChangedLines("a\nb\n", "a\nb\n"), { added: [], modified: [], deleted: [] });
});
run("new file → every current line added", () => {
  assert.deepEqual(classifyChangedLines("", "x\ny\n"), { added: [0, 1], modified: [], deleted: [] });
});

console.log("done");
