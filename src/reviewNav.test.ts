import assert from "node:assert";
import { orderPending, stepPending, pendingProgress } from "./reviewNav";

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

run("orderPending sorts by localeCompare and does not mutate input", () => {
  const input = ["/b.ts", "/a.ts", "/c.ts"];
  assert.deepEqual(orderPending(input), ["/a.ts", "/b.ts", "/c.ts"]);
  assert.deepEqual(input, ["/b.ts", "/a.ts", "/c.ts"], "input must be untouched");
});

run("stepPending: mid-list neighbors", () => {
  const o = ["/a", "/b", "/c"];
  assert.deepEqual(stepPending(o, "/b", 1), { target: "/c" });
  assert.deepEqual(stepPending(o, "/b", -1), { target: "/a" });
});

run("stepPending: stops at the ends", () => {
  const o = ["/a", "/b", "/c"];
  assert.deepEqual(stepPending(o, "/c", 1), { atEnd: "last" });
  assert.deepEqual(stepPending(o, "/a", -1), { atEnd: "first" });
});

run("stepPending: current undefined opens first (next) or last (prev)", () => {
  const o = ["/a", "/b", "/c"];
  assert.deepEqual(stepPending(o, undefined, 1), { target: "/a" });
  assert.deepEqual(stepPending(o, undefined, -1), { target: "/c" });
});

run("stepPending: current not in list behaves like undefined", () => {
  const o = ["/a", "/b"];
  assert.deepEqual(stepPending(o, "/gone", 1), { target: "/a" });
  assert.deepEqual(stepPending(o, "/gone", -1), { target: "/b" });
});

run("stepPending: empty list", () => {
  assert.deepEqual(stepPending([], undefined, 1), { empty: true });
  assert.deepEqual(stepPending([], "/a", -1), { empty: true });
});

run("stepPending: single element reports atEnd both directions", () => {
  const o = ["/only"];
  assert.deepEqual(stepPending(o, "/only", 1), { atEnd: "last" });
  assert.deepEqual(stepPending(o, "/only", -1), { atEnd: "first" });
});

run("pendingProgress: 1-based index and total, undefined when absent", () => {
  const o = ["/a", "/b", "/c"];
  assert.deepEqual(pendingProgress(o, "/a"), { index: 1, total: 3 });
  assert.deepEqual(pendingProgress(o, "/c"), { index: 3, total: 3 });
  assert.equal(pendingProgress(o, "/missing"), undefined);
});

console.log("done");
