import * as assert from "assert";
import { chooseRightSide } from "./diffPlan";

// REGRESSION GUARD: the Accepted/Rejected diff fix must NOT change the pending
// panel. A pending file always diffs against the live file on disk.
assert.equal(chooseRightSide("pending", false), "disk", "pending → disk");
assert.equal(chooseRightSide("pending", true), "disk", "pending → disk even if a stale snapshot exists");
console.log("ok - pending always diffs baseline ↔ disk (pending panel unaffected)");

// Reviewed files show the saved before → after snapshot.
assert.equal(chooseRightSide("accepted", true), "claude", "accepted with snapshot → claude");
assert.equal(chooseRightSide("rejected", true), "claude", "rejected with snapshot → claude");
console.log("ok - accepted/rejected show the saved snapshot");

// Reviewed but no snapshot (pre-1.3 entry / read failure) falls back to disk.
assert.equal(chooseRightSide("accepted", false), "disk", "accepted, no snapshot → disk");
assert.equal(chooseRightSide("rejected", false), "disk", "rejected, no snapshot → disk");
console.log("ok - reviewed without a snapshot falls back to disk");

console.log("done");
