import * as assert from "assert";
import { createThrottle, createCoalescer } from "./scheduling";

// The coalescer blocks are timer-driven, so everything runs sequentially inside
// one IIFE (the bundle is CJS — no top-level await).
void (async () => {
{
  let clock = 0;
  const allow = createThrottle(1000, () => clock);

  assert.equal(allow(), true, "the first call is always allowed");
  assert.equal(allow(), false, "an immediate second call is suppressed");
  clock += 999;
  assert.equal(allow(), false, "still suppressed just inside the interval");
  clock += 1;
  assert.equal(allow(), true, "allowed once the interval has elapsed");
  assert.equal(allow(), false, "and the window restarts from the allowed call");
  console.log("ok - throttle allows the first call and one per interval after");
}

{
  // Regression guard for the accepted-panel TreeError storm: persist() fires a
  // session change AND the resulting fs.watch reload fires another, so a single
  // accept produced several full-tree refreshes. Firing them all raced inside
  // VS Code's async tree ("Data tree node not found"). A burst must collapse to
  // ONE run.
  let runs = 0;
  const c = createCoalescer(5, () => runs++);

  c.schedule();
  c.schedule();
  c.schedule();
  assert.equal(runs, 0, "nothing runs synchronously — the burst is still collecting");

  await new Promise((r) => setTimeout(r, 25));
  assert.equal(runs, 1, "a burst of three collapses to a single run");

  c.schedule();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(runs, 2, "a later burst runs again");

  c.dispose();
  console.log("ok - coalescer collapses a burst into one run");
}

{
  // A pending run must not fire after dispose — that would touch a tree provider
  // (or output channel) that the extension host has already torn down.
  let runs = 0;
  const c = createCoalescer(5, () => runs++);
  c.schedule();
  c.dispose();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(runs, 0, "dispose cancels the pending run");
  console.log("ok - coalescer dispose cancels a pending run");
}

{
  // A callback that throws must not kill the coalescer: the next schedule() has
  // to still work, or one bad refresh would freeze the panel for the session.
  let runs = 0;
  const c = createCoalescer(5, () => {
    runs++;
    throw new Error("boom");
  });
  c.schedule();
  await new Promise((r) => setTimeout(r, 25));
  c.schedule();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(runs, 2, "a throwing callback does not wedge the coalescer");
  c.dispose();
  console.log("ok - coalescer survives a throwing callback");
}
})();
