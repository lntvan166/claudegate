import * as assert from "assert";

// The dedupe lives inside openDiff/openReviewRecord (diffProvider.ts) because
// that is the single point both open paths funnel through. This test drives the
// same rule in isolation so the window and its boundaries are pinned down; the
// integration suite covers the wiring.
//
// Why it exists: a click can arrive twice — TreeItem.command fires on every
// click, and a click that also changes the selection fires onDidChangeSelection
// too. VS Code reuses the diff editor so the duplicate is invisible, but
// openDiff reads the file off disk to compute the change count.

const OPEN_DEDUPE_MS = 300;

function makeGate() {
  let last: { key: string; at: number } | null = null;
  return (key: string, now: number): boolean => {
    if (last && last.key === key && now - last.at < OPEN_DEDUPE_MS) return true;
    last = { key, at: now };
    return false;
  };
}

// ── The second event of one click is swallowed ──────────────────────────────
{
  const gate = makeGate();
  assert.strictEqual(gate("file:/a.ts", 1000), false, "first open runs");
  assert.strictEqual(gate("file:/a.ts", 1010), true, "the same click's second event is dropped");
  console.log("ok - the duplicate event from a single click is collapsed");
}

// ── A deliberate re-open later still works ──────────────────────────────────
// The window must not be long enough to eat a user re-clicking a row on purpose.
{
  const gate = makeGate();
  gate("file:/a.ts", 1000);
  assert.strictEqual(gate("file:/a.ts", 1000 + OPEN_DEDUPE_MS), false,
    "exactly at the window edge the open runs again");
  assert.strictEqual(gate("file:/a.ts", 5000), false, "and long after, obviously");
  console.log("ok - a deliberate re-open after the window still opens");
}

// ── Different rows never block each other ───────────────────────────────────
// Stepping through pending files with next/prev fires in quick succession, and
// must not be throttled.
{
  const gate = makeGate();
  assert.strictEqual(gate("file:/a.ts", 1000), false, "first file");
  assert.strictEqual(gate("file:/b.ts", 1005), false, "a different file is never deduped");
  assert.strictEqual(gate("file:/a.ts", 1010), false,
    "and going back is a change of key, so it opens too");
  console.log("ok - rapid navigation between different rows is never throttled");
}

// ── Records and files share the gate but not their keys ─────────────────────
// A file and a record could otherwise collide on the same path.
{
  const gate = makeGate();
  assert.strictEqual(gate("file:/a.ts", 1000), false, "file open");
  assert.strictEqual(gate("rec:2026-01-01T00:00:00Z::/a.ts", 1005), false,
    "a record for the same path is a different key");
  console.log("ok - file and record opens are namespaced apart");
}
