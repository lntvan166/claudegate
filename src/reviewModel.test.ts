import * as assert from "assert";
import {
  hasRealChange, shouldPruneNoOp, acceptEntry, rejectEntry, migrateSession,
  makeRecordId, Session, FileEntry, mergeFreshCaptures,
} from "./reviewModel";

function base(): Session {
  return { sessionId: "s", status: "active", files: {}, accepted: [], rejected: {} };
}

// hasRealChange — this predicate decides both the reconcile no-op prune and the
// action-path guards, so its edges matter for Pending stability.
assert.equal(hasRealChange("a", "a"), false, "equal → no change");
assert.equal(hasRealChange("a", "b"), true, "differ → change");
assert.equal(hasRealChange(null, "x"), true, "new file present → change");
assert.equal(hasRealChange(null, null), false, "new file absent → no change");
assert.equal(hasRealChange(null, ""), true, "new EMPTY file present → real change (created)");
assert.equal(hasRealChange("", ""), false, "empty baseline == empty disk → no change");
assert.equal(hasRealChange("a\n", "a"), true, "trailing-newline difference → real change");
console.log("ok - hasRealChange (incl. empty/new-file/newline edges)");

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

// SOUL PATH: an accepted file re-edited by Claude must coexist — the accepted
// record persists AND a fresh pending entry appears for the same path.
{
  const s = base();
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  acceptEntry(s, "/f", "B", "t1");                 // accept A→B
  assert.equal(s.files["/f"], undefined, "accepted file leaves files{}");
  assert.equal(s.accepted.length, 1);
  // hook re-tracks the re-edit: a new pending entry, baseline = accepted content
  s.files["/f"] = { originalContent: "B", reviewStatus: "pending" };
  assert.ok(s.files["/f"], "re-edit re-enters files{} as pending");
  assert.equal(s.accepted.length, 1, "prior accepted record is NOT lost");
  assert.equal(s.accepted[0].after, "B", "accepted after == the new pending baseline (checkpoint chain)");
  console.log("ok - re-edit of an accepted file coexists (Pending + Accepted log)");
}

// A rejected file re-edited: rejected record kept, fresh pending entry appears.
{
  const s = base();
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
  rejectEntry(s, "/f", "bad", "t1");
  assert.equal(s.files["/f"], undefined);
  assert.ok(s.rejected["/f"]);
  s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };  // re-edit after restore
  assert.ok(s.rejected["/f"], "prior rejected record is NOT lost");
  assert.ok(s.files["/f"], "re-edit re-enters files{} as pending");
  console.log("ok - re-edit of a rejected file coexists (Pending + Rejected)");
}

// SOUL PATH (C1 regression): the reconcile prune must be per-entry age-based so
// a real edit whose write lands slightly late (a later file in a burst) is NEVER
// pruned before it appears.
{
  const GRACE = 1500;
  const now = 1_000_000;
  const pend = (oc: string | null, capturedAt?: string): FileEntry =>
    ({ originalContent: oc, reviewStatus: "pending", capturedAt });
  const iso = (ms: number) => new Date(ms).toISOString();

  // real change → never pruned, regardless of age
  assert.equal(shouldPruneNoOp(pend("A", iso(now - 10 * GRACE)), "B", now, GRACE), false, "real change kept");
  // no-op but YOUNG (write may still land) → keep — this is the C1 guard
  assert.equal(shouldPruneNoOp(pend("A", iso(now - 100)), "A", now, GRACE), false, "young no-op kept (burst-safe)");
  // no-op and SETTLED (past its own grace) → prune
  assert.equal(shouldPruneNoOp(pend("A", iso(now - 2 * GRACE)), "A", now, GRACE), true, "settled no-op pruned");
  // no-op with no capturedAt (file-watcher path, created post-write) → settled → prune
  assert.equal(shouldPruneNoOp(pend("A", undefined), "A", now, GRACE), true, "no-op w/o capturedAt pruned");
  // new file that now exists (even empty) → real change → keep
  assert.equal(shouldPruneNoOp(pend(null, iso(now - 2 * GRACE)), "", now, GRACE), false, "created (empty) new file kept");
  // new file that never appeared, settled → prune
  assert.equal(shouldPruneNoOp(pend(null, iso(now - 2 * GRACE)), null, now, GRACE), true, "vanished new file pruned");
  // new file not yet written, still young → keep (write pending)
  assert.equal(shouldPruneNoOp(pend(null, iso(now - 100)), null, now, GRACE), false, "young unwritten new file kept");
  console.log("ok - shouldPruneNoOp (per-entry grace; burst-safe reconcile)");
}

// mergeFreshCaptures: reconcile concurrent hook captures at persist time.
{
  const T = 1_000_000;
  const pend = (oc: string | null, capturedAt?: string): FileEntry =>
    ({ originalContent: oc, reviewStatus: "pending", capturedAt });
  const iso = (ms: number) => new Date(ms).toISOString();
  const sess = (files: Record<string, FileEntry>, accepted = [] as any[]): Session =>
    ({ sessionId: "s", status: "active", files, accepted, rejected: {} });

  // a disk capture absent from mine with NO decision record → merged (we never
  // consumed it; keep it rather than lose a hook capture)
  {
    const mine = sess({});
    const disk = sess({ "/b": pend("B", iso(T + 100)) });
    mergeFreshCaptures(mine, disk);
    assert.ok(mine.files["/b"], "fresh capture merged in");
  }
  // REGRESSION (dropped-SKILL.md race): an unseen capture whose capturedAt is
  // OLDER than the extension's last load must still be merged when there is no
  // accept/reject decision for it. The old wall-clock rule (capturedAt >
  // lastLoaded) misread this as "user removed it" and silently dropped it while
  // an unrelated accept was persisted.
  {
    const mine = sess({ "/other": pend("O", iso(T + 50)) });
    const disk = sess({
      "/unseen": pend(null, iso(T - 100)), // hook capture the extension never saw
      "/other":  pend("O", iso(T + 50)),
    });
    acceptEntry(mine, "/other", "after", iso(T + 200)); // decide a DIFFERENT file
    mergeFreshCaptures(mine, disk);
    assert.ok(mine.files["/unseen"], "unseen capture with no decision must survive an unrelated accept");
  }
  // a capture the user actually DECIDED (accept newer than the capture) → NOT
  // re-added; the decision supersedes the stale on-disk pending entry
  {
    const mine = sess({}, [{ id: "d::/a", path: "/a", before: "A", after: "A2", decidedAt: iso(T + 100) }]);
    const disk = sess({ "/a": pend("A", iso(T)) }); // hook wrote before we accepted
    mergeFreshCaptures(mine, disk);
    assert.equal(mine.files["/a"], undefined, "decided (accepted) entry not resurrected");
  }
  // symmetric to the above but via REJECT: a reject newer than the capture → NOT
  // re-added (the merge must consult rejected{}, not just accepted[])
  {
    const mine = sess({});
    mine.rejected["/r"] = { id: "d::/r", path: "/r", before: "R", after: "R2", decidedAt: iso(T + 100) };
    const disk = sess({ "/r": pend("R", iso(T)) });
    mergeFreshCaptures(mine, disk);
    assert.equal(mine.files["/r"], undefined, "rejected entry not resurrected by merge");
  }
  // rejected THEN re-captured (capturedAt newer than the reject) → merged again
  {
    const mine = sess({});
    mine.rejected["/r"] = { id: "d::/r", path: "/r", before: "R", after: "R2", decidedAt: iso(T) };
    const disk = sess({ "/r": pend("R", iso(T + 100)) }); // edited again after reject
    mergeFreshCaptures(mine, disk);
    assert.ok(mine.files["/r"], "re-captured rejected file re-appears as pending");
  }
  // tie boundary (capturedAt === decidedAt) → KEEP: an equal timestamp can only
  // be a fresh concurrent re-capture, so dropping it would be data loss
  {
    const mine = sess({}, [{ id: "d::/t", path: "/t", before: "A", after: "A2", decidedAt: iso(T) }]);
    const disk = sess({ "/t": pend("A", iso(T)) });
    mergeFreshCaptures(mine, disk);
    assert.ok(mine.files["/t"], "capture tying the decision timestamp is kept (data-loss-averse)");
  }
  // path already in mine.files → mine kept (not overwritten)
  {
    const mine = sess({ "/f": pend("MINE", iso(T + 100)) });
    const disk = sess({ "/f": pend("DISK", iso(T + 200)) });
    mergeFreshCaptures(mine, disk);
    assert.equal(mine.files["/f"].originalContent, "MINE", "existing entry kept");
  }
  // coexistence: RE-captured file (capturedAt newer than its accept) → merged as
  // pending again; the accept record is preserved
  {
    const mine = sess({}, [{ id: "t::/f", path: "/f", before: "A", after: "B", decidedAt: iso(T) }]);
    const disk = sess({ "/f": pend("B", iso(T + 100)) }); // edited again after the accept
    mergeFreshCaptures(mine, disk);
    assert.ok(mine.files["/f"], "re-captured accepted file re-appears as pending");
    assert.equal(mine.accepted.length, 1, "accept record preserved");
  }
  // disk entry with no capturedAt → skipped (can't prove it's a real capture)
  {
    const mine = sess({});
    const disk = sess({ "/x": pend("X", undefined) });
    mergeFreshCaptures(mine, disk);
    assert.equal(mine.files["/x"], undefined, "no-capturedAt entry skipped");
  }
  console.log("ok - mergeFreshCaptures (dual-writer reconcile)");
}

console.log("done");
