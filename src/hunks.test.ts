import assert from "node:assert";
import { computeHunks, revertHunkText } from "./hunks";

function run(name: string, fn: () => void): void {
  try { fn(); console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name); console.error(e); process.exitCode = 1; }
}

run("computeHunks: single modified line → one hunk at its line", () => {
  const h = computeHunks("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(h.length, 1);
  assert.equal(h[0].startLine, 1);
  assert.equal(h[0].label, "+1 -1");
});

run("computeHunks: two separated changes → two hunks", () => {
  const h = computeHunks("a\nb\nc\nd\n", "A\nb\nC\nd\n");
  assert.equal(h.length, 2);
  assert.equal(h[0].startLine, 0);
  assert.equal(h[1].startLine, 2);
});

run("revertHunkText: reverting the only hunk yields the baseline", () => {
  assert.equal(revertHunkText("a\nb\nc\n", "a\nB\nc\n", 0), "a\nb\nc\n");
});

run("revertHunkText: two hunks — revert hunk 0 keeps hunk 1", () => {
  assert.equal(revertHunkText("a\nb\nc\nd\n", "A\nb\nC\nd\n", 0), "a\nb\nC\nd\n");
  assert.equal(revertHunkText("a\nb\nc\nd\n", "A\nb\nC\nd\n", 1), "A\nb\nc\nd\n");
});

run("revertHunkText: pure addition revert removes the added lines", () => {
  assert.equal(revertHunkText("a\nc\n", "a\nb\nc\n", 0), "a\nc\n");
});

run("revertHunkText: pure deletion revert re-inserts baseline lines", () => {
  assert.equal(revertHunkText("a\nb\nc\n", "a\nc\n", 0), "a\nb\nc\n");
});

run("revertHunkText: new file (baseline empty) revert → empty", () => {
  assert.equal(revertHunkText("", "x\ny\n", 0), "");
});

console.log("done");
