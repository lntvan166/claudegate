import * as assert from "assert";
import {
  hasRealChange, acceptEntry, rejectEntry, migrateSession, makeRecordId, Session,
} from "./reviewModel";

function base(): Session {
  return { sessionId: "s", status: "active", files: {}, accepted: [], rejected: {} };
}

// hasRealChange
assert.equal(hasRealChange("a", "a"), false, "equal → no change");
assert.equal(hasRealChange("a", "b"), true, "differ → change");
assert.equal(hasRealChange(null, "x"), true, "new file present → change");
assert.equal(hasRealChange(null, null), false, "new file absent → no change");
console.log("ok - hasRealChange");

// accept appends a record and clears the pending entry
{
  const s = base();
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  acceptEntry(s, "/f", "B", "2026-01-01T00:00:00Z");
  assert.equal(s.files["/f"], undefined, "pending entry removed");
  assert.equal(s.accepted.length, 1);
  assert.deepEqual(
    { before: s.accepted[0].before, after: s.accepted[0].after, path: s.accepted[0].path },
    { before: "A", after: "B", path: "/f" }
  );
  console.log("ok - accept appends + clears pending");
}

// two accepts on one file → full log
{
  const s = base();
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  acceptEntry(s, "/f", "B", "2026-01-01T00:00:00Z");
  s.files["/f"] = { originalContent: "B", reviewStatus: "pending" };
  acceptEntry(s, "/f", "C", "2026-01-01T00:00:01Z");
  assert.deepEqual(s.accepted.map(r => r.after), ["B", "C"], "both accepts logged");
  console.log("ok - accept keeps a full log");
}

// reject is latest-per-file (second replaces first)
{
  const s = base();
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  rejectEntry(s, "/f", "X", "2026-01-01T00:00:00Z");
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  rejectEntry(s, "/f", "Y", "2026-01-01T00:00:01Z");
  assert.equal(Object.keys(s.rejected).length, 1, "one reject per file");
  assert.equal(s.rejected["/f"].after, "Y", "latest reject wins");
  console.log("ok - reject is latest-per-file");
}

// migration of a legacy accepted/rejected files entry
{
  const raw = {
    sessionId: "s", status: "reviewed",
    files: {
      "/p": { originalContent: "pending-A", reviewStatus: "pending" },
      "/a": { originalContent: "A", claudeContent: "B", reviewStatus: "accepted" },
      "/r": { originalContent: "R0", claudeContent: "R1", reviewStatus: "rejected" },
    },
  };
  const s = migrateSession(raw);
  assert.deepEqual(Object.keys(s.files), ["/p"], "only pending stays in files");
  assert.equal(s.accepted.length, 1);
  assert.deepEqual([s.accepted[0].before, s.accepted[0].after], ["A", "B"]);
  assert.equal(Object.keys(s.rejected).length, 1);
  assert.deepEqual([s.rejected["/r"].before, s.rejected["/r"].after], ["R0", "R1"]);
  console.log("ok - migrateSession converts legacy entries");
}

// makeRecordId is stable + distinct per (time, path)
assert.equal(makeRecordId("t", "/p"), "t::/p");
assert.notEqual(makeRecordId("t1", "/p"), makeRecordId("t2", "/p"));
console.log("ok - makeRecordId");

console.log("done");
