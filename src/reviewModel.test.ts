import * as assert from "assert";
import {
  hasRealChange, shouldPruneNoOp, acceptEntry, rejectEntry, migrateSession,
  makeRecordId, Session, FileEntry, mergeFreshCaptures,
  MAX_ACCEPTED_RECORDS, capAcceptedLog, capAcceptedBytes, fileEntryFor,
  NOOP_SETTLE_MS, NEW_FILE_ABSENT_MS,
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
// The PreToolUse hook captures the baseline BEFORE the write lands, and the
// write can land SECONDS after the hook (measured up to ~6s under a busy hook
// chain / slow editor save). The pre-write reconcile therefore sees a disk state
// that still predates the write: a new file looks absent, an edited file looks
// unchanged. Pruning at the old 1.5s grace destroyed these legit pending entries
// before their content ever landed (the ".claude/*.commits.yaml vanishing" bug).
// The settle windows must comfortably exceed real write lag.
{
  const now = 1_000_000;
  const pend = (oc: string | null, capturedAt?: string): FileEntry =>
    ({ originalContent: oc, reviewStatus: "pending", capturedAt });
  const iso = (ms: number) => new Date(ms).toISOString();

  // real change → never pruned, regardless of age
  assert.equal(shouldPruneNoOp(pend("A", iso(now - 999_999)), "B", now), false, "real change kept");

  // --- existing-file no-op: kept until NOOP_SETTLE_MS elapses (write may lag) ---
  assert.equal(shouldPruneNoOp(pend("A", iso(now - (NOOP_SETTLE_MS - 1000))), "A", now), false,
    "no-op within settle window kept (slow edit's write may still land)");
  assert.equal(shouldPruneNoOp(pend("A", iso(now - (NOOP_SETTLE_MS + 1000))), "A", now), true,
    "settled no-op pruned once past the settle window");
  // no capturedAt (file-watcher path, created post-write) → treat as settled → prune
  assert.equal(shouldPruneNoOp(pend("A", undefined), "A", now), true, "no-op w/o capturedAt pruned");

  // --- new file: a hook capture PROMISES a write; kept until NEW_FILE_ABSENT_MS ---
  // new file that now exists (even empty) → real change → keep
  assert.equal(shouldPruneNoOp(pend(null, iso(now - 999_999)), "", now), false, "created (empty) new file kept");
  // new file not yet on disk but within the (generous) window → keep (write pending)
  assert.equal(shouldPruneNoOp(pend(null, iso(now - (NEW_FILE_ABSENT_MS - 1000))), null, now), false,
    "unwritten new file within window kept (hook-vs-write lag)");
  // new file that never appeared, past the window → genuine temp file → prune
  assert.equal(shouldPruneNoOp(pend(null, iso(now - (NEW_FILE_ABSENT_MS + 1000))), null, now), true,
    "vanished new file pruned once past the window");
  // REGRESSION (the reported bug): a new file still absent at the OLD 1.5s grace
  // must NOT be pruned — its write landed ~6s later in the field.
  assert.equal(shouldPruneNoOp(pend(null, iso(now - 1500)), null, now), false,
    "new file absent at old 1.5s grace is kept (hook-vs-write race fix)");
  console.log("ok - shouldPruneNoOp (write-lag-tolerant settle windows)");
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
    mergeFreshCaptures(mine, disk, { prunedFiles: new Map([["/n", iso(T)]]) });
    assert.equal(mine.files["/n"], undefined, "just-pruned no-op not resurrected by merge");
  }
  // …but a genuinely fresh RE-capture to a just-pruned path (newer capturedAt)
  // must still merge — the guard only suppresses the exact stale entry, never a
  // new hook write that landed in the prune→persist window.
  {
    const mine = sess({});
    const disk = sess({ "/n": pend("N2", iso(T + 100)) }); // hook re-captured after prune
    mergeFreshCaptures(mine, disk, { prunedFiles: new Map([["/n", iso(T)]]) });
    assert.ok(mine.files["/n"], "fresh re-capture (newer capturedAt) still merged despite prune");
  }
  console.log("ok - mergeFreshCaptures (dual-writer reconcile)");

  // DATA-LOSS (nested-worktree clobber): two extension windows own the same
  // session file (the attached-worktree manager + the worktree's own window).
  // A decision persisted by the other window lives only on disk when we persist;
  // the merge MUST union accepted[]/rejected{} from disk or we overwrite (lose) it.
  {
    // disk holds an accept record we don't have in memory → union it in
    const mine = sess({}, [{ id: "d::/mine", path: "/mine", before: "A", after: "B", decidedAt: iso(T) }]);
    const disk = sess({}, [{ id: "d::/other", path: "/other", before: "C", after: "D", decidedAt: iso(T + 100) }]);
    mergeFreshCaptures(mine, disk);
    const ids = mine.accepted.map(r => r.id).sort();
    assert.deepEqual(ids, ["d::/mine", "d::/other"], "other window's accept record unioned, not clobbered");
  }
  {
    // same accept id present on both sides → not duplicated
    const rec = { id: "d::/f", path: "/f", before: "A", after: "B", decidedAt: iso(T) };
    const mine = sess({}, [{ ...rec }]);
    const disk = sess({}, [{ ...rec }]);
    mergeFreshCaptures(mine, disk);
    assert.equal(mine.accepted.length, 1, "identical accept record not duplicated on union");
  }
  {
    // disk holds a NEWER reject for a path than mine → disk's wins (latest-per-path)
    const mine = sess({});
    mine.rejected["/r"] = { id: "old::/r", path: "/r", before: "R", after: "R1", decidedAt: iso(T) };
    const disk = sess({});
    disk.rejected["/r"] = { id: "new::/r", path: "/r", before: "R", after: "R2", decidedAt: iso(T + 100) };
    mergeFreshCaptures(mine, disk);
    assert.equal(mine.rejected["/r"].after, "R2", "newer reject from other window wins");
  }
  {
    // disk holds a reject for a path mine never rejected → unioned in
    const mine = sess({});
    const disk = sess({});
    disk.rejected["/r"] = { id: "d::/r", path: "/r", before: "R", after: "R2", decidedAt: iso(T) };
    mergeFreshCaptures(mine, disk);
    assert.ok(mine.rejected["/r"], "other window's reject record unioned in");
  }
  {
    // the other window ACCEPTED a file we still show as pending → the newer
    // decision from disk must drop it from our files{} (no double display)
    const mine = sess({ "/f": pend("A", iso(T)) });
    const disk = sess({}, [{ id: "d::/f", path: "/f", before: "A", after: "B", decidedAt: iso(T + 100) }]);
    mergeFreshCaptures(mine, disk);
    assert.equal(mine.files["/f"], undefined, "file decided in the other window drops from our pending");
    assert.equal(mine.accepted.length, 1, "and its accept record is adopted");
  }
  console.log("ok - mergeFreshCaptures unions accepted[]/rejected{} (worktree clobber)");

  // RESURRECTION guard: a decision the caller deliberately removed THIS cycle
  // (clear/revert/reapply) is still on the disk copy persist re-reads. The union
  // must not resurrect it, or clears never stick and persist can loop.
  {
    // clearAccepted: mine emptied it, disk still has the record → stays gone
    const mine = sess({});
    const disk = sess({}, [{ id: "d::/a", path: "/a", before: "A", after: "B", decidedAt: iso(T) }]);
    mergeFreshCaptures(mine, disk, { droppedAcceptedIds: new Set(["d::/a"]) });
    assert.equal(mine.accepted.length, 0, "just-cleared accept not resurrected");
  }
  {
    // …but a DIFFERENT accept the other window added (not in the dropped set)
    // must still survive the clear.
    const mine = sess({});
    const disk = sess({}, [
      { id: "d::/a", path: "/a", before: "A", after: "B", decidedAt: iso(T) },      // we cleared this
      { id: "d::/b", path: "/b", before: "C", after: "D", decidedAt: iso(T + 100) },// other window added
    ]);
    mergeFreshCaptures(mine, disk, { droppedAcceptedIds: new Set(["d::/a"]) });
    assert.deepEqual(mine.accepted.map(r => r.id), ["d::/b"], "concurrent accept survives our clear");
  }
  {
    // clearRejected / reapply: mine dropped the path, disk still has it → stays gone
    const mine = sess({});
    const disk = sess({});
    disk.rejected["/r"] = { id: "d::/r", path: "/r", before: "R", after: "R2", decidedAt: iso(T) };
    mergeFreshCaptures(mine, disk, { droppedRejectedPaths: new Set(["/r"]) });
    assert.equal(mine.rejected["/r"], undefined, "just-cleared reject not resurrected");
  }
  console.log("ok - mergeFreshCaptures does not resurrect just-removed decisions");

  // I3: accepting a file that was previously rejected clears the stale reject
  // record, so it can't linger in both the Accepted log and the Rejected panel.
  {
    const s = base();
    s.files["/f"] = { originalContent: "A", reviewStatus: "pending" };
    rejectEntry(s, "/f", "X", iso(T));
    assert.ok(s.rejected["/f"], "rejected first");
    s.files["/f"] = { originalContent: "A", reviewStatus: "pending" }; // re-edited → pending again
    acceptEntry(s, "/f", "B", iso(T + 100));
    assert.equal(s.rejected["/f"], undefined, "accept clears the prior reject record");
    assert.equal(s.accepted.length, 1, "accept still logged");
  }
  console.log("ok - acceptEntry clears a prior reject for the same path (I3)");
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

// capAcceptedBytes: bound the accepted log by SIZE (not just count). A handful of
// large-file accepts can blow past the file-size warning long before the 500-record
// count cap, so we drop oldest records until the log fits the byte budget.
{
  const s = base();
  const big = "x".repeat(10_000);
  for (let i = 0; i < 20; i++) {
    s.accepted.push({ id: `${i}`, path: `/f${i}`, before: null, after: big, decidedAt: `t${i}` });
  }
  const before = s.accepted.length;
  const dropped = capAcceptedBytes(s, 50_000); // ~5 records worth
  assert.ok(dropped > 0, "over-budget log is trimmed");
  assert.ok(s.accepted.length < before, "records dropped");
  assert.equal(s.accepted[s.accepted.length - 1].id, "19", "newest record kept");
  assert.equal(s.accepted[0].id, String(before - s.accepted.length), "dropped from the OLDEST end");
  assert.ok(Buffer.byteLength(JSON.stringify(s.accepted)) <= 50_000, "result fits the byte budget");
  console.log("ok - capAcceptedBytes trims oldest-first to a byte budget");
}
{
  // under budget → no change
  const s = base();
  s.accepted.push({ id: "1", path: "/f", before: null, after: "small", decidedAt: "t" });
  assert.equal(capAcceptedBytes(s, 1_000_000), 0, "under budget → nothing dropped");
  assert.equal(s.accepted.length, 1);
  console.log("ok - capAcceptedBytes is a no-op under budget");
}
{
  // A single accepted record larger than the whole budget must NOT wipe the log:
  // keep the newest record so one big-file accept can't erase all history.
  const s = base();
  const huge = "x".repeat(100_000);
  s.accepted.push({ id: "old", path: "/a", before: null, after: huge, decidedAt: "t0" });
  s.accepted.push({ id: "new", path: "/b", before: null, after: huge, decidedAt: "t1" });
  const dropped = capAcceptedBytes(s, 50_000); // budget smaller than one record
  assert.equal(dropped, 1, "only the older record is dropped");
  assert.equal(s.accepted.length, 1, "the newest record is retained");
  assert.equal(s.accepted[0].id, "new", "newest kept even though it exceeds the budget");
  console.log("ok - capAcceptedBytes always keeps the newest record");
}

// fileEntryFor: drive-letter/case tolerance for URI-derived path lookups (Windows).
{
  const files: Record<string, FileEntry> = { "C:\\Foo\\Bar.ts": { originalContent: "x", reviewStatus: "pending" } };
  assert.ok(fileEntryFor(files, "C:\\Foo\\Bar.ts", true), "exact match");
  assert.ok(fileEntryFor(files, "c:\\foo\\bar.ts", true), "case-insensitive match (win32): lowercased drive/path still resolves");
  assert.equal(fileEntryFor(files, "c:\\foo\\bar.ts", false), undefined, "case-sensitive (posix): differing case misses");
  assert.equal(fileEntryFor(files, "C:\\Other.ts", true), undefined, "unknown path → undefined");
  console.log("ok - fileEntryFor tolerates drive-letter case on win32");
}

console.log("done");
