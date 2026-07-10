import * as assert from "assert";
import {
  hasRealChange, shouldPruneNoOp, acceptEntry, rejectEntry, migrateSession,
  makeRecordId, Session, FileEntry, mergeFreshCaptures,
  MAX_ACCEPTED_RECORDS, capAcceptedLog,
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
  const { session: s, changed } = migrateSession(raw);
  assert.deepEqual(Object.keys(s.files), ["/p"], "only pending stays in files");
  assert.equal(s.accepted.length, 1);
  assert.deepEqual([s.accepted[0].before, s.accepted[0].after], ["A", "B"]);
  assert.equal(Object.keys(s.rejected).length, 1);
  assert.deepEqual([s.rejected["/r"].before, s.rejected["/r"].after], ["R0", "R1"]);
  assert.equal(changed, true, "moving legacy entries flags the session as changed");
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
  // REGRESSION (nonstop-rewrite loop): reconcile just pruned a settled no-op
  // entry, so mine.files no longer has it — but the on-disk copy persist re-reads
  // still does. Without the prunedThisCycle guard the merge resurrects it every
  // persist, so removed>0 fires persist forever (~every RECONCILE_GRACE_MS) and
  // the UI reloads nonstop. The guard skips re-adding the SAME stale entry
  // (matched by capturedAt) so the prune sticks.
  {
    const mine = sess({});
    const disk = sess({ "/n": pend("N", iso(T)) }); // baseline==disk no-op still on disk
    mergeFreshCaptures(mine, disk, new Map([["/n", iso(T)]]));
    assert.equal(mine.files["/n"], undefined, "just-pruned no-op not resurrected by merge");
  }
  // …but a genuinely fresh RE-capture to a just-pruned path (newer capturedAt)
  // must still merge — the guard only suppresses the exact stale entry, never a
  // new hook write that landed in the prune→persist window.
  {
    const mine = sess({});
    const disk = sess({ "/n": pend("N2", iso(T + 100)) }); // hook re-captured after prune
    mergeFreshCaptures(mine, disk, new Map([["/n", iso(T)]]));
    assert.ok(mine.files["/n"], "fresh re-capture (newer capturedAt) still merged despite prune");
  }
  console.log("ok - mergeFreshCaptures (dual-writer reconcile)");
}

// migrateSession.changed — a well-formed current-model session must report
// changed=false so loadSession skips a redundant re-persist (no fs.watch churn /
// UI blink), while a raw with missing/invalid top-level fields reports changed=true.
{
  const wellFormed = {
    sessionId: "s", status: "active",
    files: { "/p": { originalContent: "A", reviewStatus: "pending" } },
    accepted: [], rejected: {},
  };
  assert.equal(migrateSession(wellFormed).changed, false, "clean session → no rewrite needed");

  assert.equal(migrateSession({ files: {} }).changed, true, "missing sessionId/status/accepted/rejected → changed");
  assert.equal(migrateSession({ sessionId: "s", status: "active", accepted: {}, rejected: {}, files: {} }).changed,
    true, "accepted not an array → changed");
  console.log("ok - migrateSession.changed flags only real normalization");
}

// capAcceptedLog / accepted cap — the log is bounded at MAX_ACCEPTED_RECORDS,
// dropping OLDEST-first so recent undo history is preserved.
{
  const s: Session = { sessionId: "s", status: "active", files: {}, accepted: [], rejected: {} };
  // Push cap + 10 accepts; oldest 10 should fall off.
  for (let i = 0; i < MAX_ACCEPTED_RECORDS + 10; i++) {
    s.files["/f"] = { originalContent: String(i), reviewStatus: "pending" };
    acceptEntry(s, "/f", "after" + i, `2026-01-01T00:00:${i}Z`);
  }
  assert.equal(s.accepted.length, MAX_ACCEPTED_RECORDS, "accepted[] capped at the max");
  assert.equal(s.accepted[0].before, "10", "oldest 10 dropped (before of the survivor is #10)");
  assert.equal(s.accepted[s.accepted.length - 1].after, "after" + (MAX_ACCEPTED_RECORDS + 9), "newest kept");

  // capAcceptedLog is a no-op (returns false) when already under the cap.
  const small: Session = { sessionId: "s", status: "active", files: {}, accepted: [{ id: "x", path: "/x", before: null, after: "a", decidedAt: "t" }], rejected: {} };
  assert.equal(capAcceptedLog(small), false, "under-cap log untouched");
  assert.equal(small.accepted.length, 1, "no records dropped under cap");
  console.log("ok - accepted log capped oldest-first at MAX_ACCEPTED_RECORDS");
}

// migrateSession heals a pre-cap over-sized accepted[] on load (drops oldest,
// flags changed so the trimmed form is written back).
{
  const bloated = {
    sessionId: "s", status: "active", files: {}, rejected: {},
    accepted: Array.from({ length: MAX_ACCEPTED_RECORDS + 5 }, (_v, i) =>
      ({ id: "r" + i, path: "/f", before: null, after: String(i), decidedAt: "t" + i })),
  };
  const { session, changed } = migrateSession(bloated);
  assert.equal(session.accepted.length, MAX_ACCEPTED_RECORDS, "over-cap log healed on migrate");
  assert.equal(changed, true, "trimming an over-cap log flags changed");
  assert.equal(session.accepted[0].after, "5", "oldest 5 dropped on heal");
  console.log("ok - migrateSession heals a pre-cap oversized accepted log");
}

// rejectEntry stores an optional reason on the record
{
  const session: Session = {
    sessionId: "s", status: "active" as const,
    files: { "/w/a.ts": { originalContent: "old", reviewStatus: "pending" as const } },
    accepted: [], rejected: {},
  };
  rejectEntry(session, "/w/a.ts", "new", "2026-07-10T00:00:00.000Z", "broke the API");
  assert.equal(session.rejected["/w/a.ts"].reason, "broke the API");
  assert.equal(session.files["/w/a.ts"], undefined); // entry removed from files{}
  console.log("ok - rejectEntry stores an optional reason on the record");
}

// rejectEntry omits reason when none is given
{
  const session: Session = {
    sessionId: "s", status: "active" as const,
    files: { "/w/b.ts": { originalContent: "old", reviewStatus: "pending" as const } },
    accepted: [], rejected: {},
  };
  rejectEntry(session, "/w/b.ts", "new", "2026-07-10T00:00:00.000Z");
  assert.equal(session.rejected["/w/b.ts"].reason, undefined);
  console.log("ok - rejectEntry omits reason when none is given");
}

console.log("done");
