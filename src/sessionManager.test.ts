import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { SessionManager } from "./sessionManager";
import { ExcludeMatcher } from "./excludeMatcher";
import { setExcludeMatcher } from "./workspaceScope";
import { workspace as stubWorkspace } from "./test-stubs/vscode";

const fakeLog = { appendLine() {} } as any;

function sessionPathFor(home: string, ws: string): string {
  const resolved = path.resolve(ws);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash("md5").update(normalized).digest("hex");
  return path.join(home, ".claudegate", "sessions", `${hash}.json`);
}
function newEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-home-"));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ws-"));
  process.env.HOME = home; // SessionManager reads os.homedir() → $HOME on POSIX
  process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not $HOME
  return { home, ws, sp: sessionPathFor(home, ws) };
}
function readSession(sp: string): any {
  return JSON.parse(fs.readFileSync(sp, "utf-8"));
}

// accept: appends a record, removes the pending entry, leaves the file on disk
{
  const { ws, sp } = newEnv();
  const fp = path.join(ws, "a.ts");
  fs.writeFileSync(fp, "NEW");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(fp, "OLD");
  sm.acceptFile(fp);
  const s = readSession(sp);
  assert.equal(s.files[fp], undefined, "accepted entry removed from files");
  assert.equal(s.accepted.length, 1, "one accepted record");
  assert.deepEqual([s.accepted[0].before, s.accepted[0].after], ["OLD", "NEW"]);
  assert.equal(fs.readFileSync(fp, "utf-8"), "NEW", "working file untouched by accept");
  sm.stopWatching();
  console.log("ok - accept records + leaves file");
}

// reject of an existing file restores the baseline on disk (atomically)
{
  const { ws, sp } = newEnv();
  const fp = path.join(ws, "b.ts");
  fs.writeFileSync(fp, "CLAUDE");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(fp, "BASE");
  sm.rejectFile(fp);
  assert.equal(fs.readFileSync(fp, "utf-8"), "BASE", "reject restored baseline");
  const s = readSession(sp);
  assert.ok(s.rejected[fp], "rejected record stored");
  assert.equal(s.rejected[fp].after, "CLAUDE", "discarded content saved");
  sm.stopWatching();
  console.log("ok - reject restores baseline on disk");
}

// rejectFile records the revert reason, and still preserves Claude's discarded content.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "c.ts");
  fs.writeFileSync(fp, "claude-edited\n");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(fp, "original\n");
  sm.rejectFile(fp, "reverted: wrong approach");
  const rec = sm.getSession()!.rejected[fp];
  assert.equal(rec.reason, "reverted: wrong approach", "reason stored on rejected record");
  assert.equal(rec.after, "claude-edited\n", "Claude's discarded version preserved");
  sm.stopWatching();
  console.log("ok - rejectFile records the revert reason");
}

// merge-on-write: a concurrent write to the session file (a fresh hook capture)
// is preserved when the extension persists.
{
  const { ws, sp } = newEnv();
  const a = path.join(ws, "a.ts");
  fs.writeFileSync(a, "A");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(a, "A0"); // persists the session (mtime recorded)
  // Simulate a hook writing a NEW pending entry directly to the session file:
  const disk = readSession(sp);
  const b = path.join(ws, "b.ts");
  disk.files[b] = {
    originalContent: "B0", reviewStatus: "pending",
    capturedAt: new Date(Date.now() + 1000).toISOString(),
  };
  fs.writeFileSync(sp, JSON.stringify(disk));
  // Force a distinctly-later mtime so the dual-writer guard sees the change
  // regardless of filesystem mtime granularity (coarse-mtime FSes could bucket
  // two synchronous writes into the same timestamp → flaky).
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(sp, later, later);
  // Now the extension persists (via accept of A); merge must keep b.
  sm.acceptFile(a);
  const s = readSession(sp);
  assert.ok(s.files[b], "concurrent hook capture merged, not lost");
  assert.equal(s.accepted.length, 1, "the accept was still recorded");
  sm.stopWatching();
  console.log("ok - merge-on-write preserves concurrent hook capture");
}

// reject matrix for null baselines: confident-new deletes; uncertain leaves.
{
  const { ws, sp } = newEnv();
  const del = path.join(ws, "created.ts");
  fs.writeFileSync(del, "hi");
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching();
  sm.trackFileChange(del, null, true);   // confident new (hook path)
  sm.rejectFile(del);
  assert.ok(!fs.existsSync(del), "confident-new reject deletes the file");
  assert.ok(readSession(sp).rejected[del], "deleted file still recorded as rejected");
  sm.stopWatching();

  const { ws: ws2, sp: sp2 } = newEnv();
  const keep = path.join(ws2, "maybe-real.ts");
  fs.writeFileSync(keep, "user data");
  const sm2 = new SessionManager(fakeLog, ws2);
  sm2.startWatching();
  sm2.trackFileChange(keep, null);       // uncertain (watcher path, newFile=false)
  sm2.rejectFile(keep);
  assert.ok(fs.existsSync(keep), "uncertain-new reject leaves the file on disk");
  assert.equal(fs.readFileSync(keep, "utf-8"), "user data", "file content untouched");
  assert.ok(readSession(sp2).rejected[keep], "still recorded as rejected");
  sm2.stopWatching();
  console.log("ok - reject deletes only confident-new files");
}

// migrateSession must carry newFile through a disk reload (the real hook +
// fs.watch path): a confident-new flag survives → reject deletes; a legacy
// entry with no newFile → reject leaves the file (delete-safety).
{
  const { ws, sp } = newEnv();
  const nf = path.join(ws, "created.ts");
  fs.writeFileSync(nf, "content");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [nf]: { originalContent: null, reviewStatus: "pending", newFile: true, capturedAt: new Date().toISOString() } },
    accepted: [], rejected: {},
  }));
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching(); // loads via migrateSession (the fs.watch reload path)
  sm.rejectFile(nf);
  assert.ok(!fs.existsSync(nf), "newFile:true survives reload → reject deletes");
  sm.stopWatching();

  const { ws: ws2, sp: sp2 } = newEnv();
  const legacy = path.join(ws2, "maybe-real.ts");
  fs.writeFileSync(legacy, "user data");
  fs.mkdirSync(path.dirname(sp2), { recursive: true });
  fs.writeFileSync(sp2, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [legacy]: { originalContent: null, reviewStatus: "pending", capturedAt: new Date().toISOString() } },
    accepted: [], rejected: {},
  }));
  const sm2 = new SessionManager(fakeLog, ws2);
  sm2.startWatching();
  sm2.rejectFile(legacy);
  assert.ok(fs.existsSync(legacy), "legacy null entry (no newFile) → reject leaves file");
  sm2.stopWatching();
  console.log("ok - migrateSession carries newFile through reload (delete-safety)");
}


// ── Manual-test cases as integration tests ────────────────────────────────
// (UI-only cases — native diff "Revert Block", Review-All multi-diff tab reuse,
// group-by-session rendering, explorer badges — are not integration-testable
// and remain in the Extension-Host manual checklist.)

// Accepted panel is a full per-accept log.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "log.ts");
  fs.writeFileSync(fp, "B");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "A"); sm.acceptFile(fp);        // A→B
  fs.writeFileSync(fp, "C");
  sm.trackFileChange(fp, "B"); sm.acceptFile(fp);        // B→C
  const s = sm.getSession()!;
  assert.equal(s.accepted.length, 2, "two accepts logged");
  assert.deepEqual(s.accepted.map((r) => r.after), ["B", "C"]);
  sm.stopWatching();
  console.log("ok - accept keeps a full per-accept log");
}

// Re-editing an accepted file coexists: Accepted keeps history, Pending shows new.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "co.ts");
  fs.writeFileSync(fp, "B");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "A"); sm.acceptFile(fp);
  sm.trackFileChange(fp, "B");                           // hook re-edit
  const s = sm.getSession()!;
  assert.ok(s.files[fp], "re-edit re-appears in pending");
  assert.equal(s.accepted.length, 1, "accepted record preserved");
  sm.stopWatching();
  console.log("ok - re-edit of an accepted file coexists");
}

// Rejected keeps only the latest per file.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "rej.ts");
  fs.writeFileSync(fp, "X");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "BASE"); sm.rejectFile(fp);     // reject X
  fs.writeFileSync(fp, "Y");
  sm.trackFileChange(fp, "BASE"); sm.rejectFile(fp);     // reject Y
  const s = sm.getSession()!;
  assert.equal(Object.keys(s.rejected).length, 1, "one rejected record per file");
  assert.equal(s.rejected[fp].after, "Y", "latest reject kept");
  sm.stopWatching();
  console.log("ok - reject keeps only the latest per file");
}

// Re-apply a rejected change: rewrites Claude's version, returns to pending.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "reap.ts");
  fs.writeFileSync(fp, "CLAUDE");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "BASE"); sm.rejectFile(fp);
  assert.equal(fs.readFileSync(fp, "utf-8"), "BASE", "reject restored baseline");
  sm.reapplyRejected(fp);
  assert.equal(fs.readFileSync(fp, "utf-8"), "CLAUDE", "reapply rewrote Claude's version");
  const s = sm.getSession()!;
  assert.ok(s.files[fp], "reapplied file back to pending");
  assert.equal(s.rejected[fp], undefined, "removed from rejected store");
  sm.stopWatching();
  console.log("ok - reapply restores Claude's version and re-pends");
}

// Revert an accepted change: back to pending.
{
  const { ws } = newEnv();
  const fp = path.join(ws, "rev.ts");
  fs.writeFileSync(fp, "B");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, "A"); sm.acceptFile(fp);
  const id = sm.getSession()!.accepted[0].id;
  sm.revertAccepted(id);
  const s = sm.getSession()!;
  assert.equal(s.accepted.length, 0, "accepted record removed");
  assert.ok(s.files[fp], "returned to pending");
  sm.stopWatching();
  console.log("ok - revert accepted returns the file to pending");
}

// newFile survives an accept→revert→reject round-trip: a Claude-created file
// reopened via revert must still be DELETED on a later reject (not left on disk).
{
  const { ws } = newEnv();
  const fp = path.join(ws, "created.ts");
  fs.writeFileSync(fp, "CREATED");           // Claude created it
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(fp, null, true);        // newFile capture (null baseline)
  sm.acceptFile(fp);
  const id = sm.getSession()!.accepted[0].id;
  sm.revertAccepted(id);                     // reopen as pending
  assert.equal(sm.getSession()!.files[fp].newFile, true, "newFile restored on revert");
  sm.rejectFile(fp);
  assert.equal(fs.existsSync(fp), false, "reject deletes the reopened new file");
  sm.stopWatching();
  console.log("ok - newFile survives accept→revert→reject (delete-safety)");
}

// Clear commands reset the stores.
{
  const { ws } = newEnv();
  const a = path.join(ws, "ca.ts"); const b = path.join(ws, "cb.ts");
  fs.writeFileSync(a, "A2"); fs.writeFileSync(b, "B2");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(a, "A1"); sm.acceptFile(a);
  sm.trackFileChange(b, "B1"); sm.rejectFile(b);
  sm.clearAccepted();
  assert.equal(sm.getSession()!.accepted.length, 0, "clearAccepted empties the log");
  sm.clearRejected();
  assert.equal(Object.keys(sm.getSession()!.rejected).length, 0, "clearRejected empties the store");
  sm.stopWatching();
  console.log("ok - clearAccepted / clearRejected reset the stores");
}

// Excluded files (e.g. lock files) are not counted as pending.
{
  const { ws } = newEnv();
  const lock = path.join(ws, "package-lock.json");
  const src = path.join(ws, "x.ts");
  fs.writeFileSync(lock, "{}"); fs.writeFileSync(src, "S");
  const matcher = new ExcludeMatcher();
  matcher.reload({ "**/package-lock.json": true }, ws);
  setExcludeMatcher(matcher);
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(lock, "{ }"); sm.trackFileChange(src, "S0");
  assert.equal(sm.getPendingCount(), 1, "excluded lock file is not counted");
  setExcludeMatcher(new ExcludeMatcher()); // reset shared state for any later block
  sm.stopWatching();
  console.log("ok - excluded files are not counted as pending");
}


// ── Pending-panel scope + real-change detection ───────────────────────────
// getPendingCount uses the same isInWorkspace && !isExcluded filter as the
// Pending panel's row list, so these lock the panel's display logic.

// hasRealPendingChange distinguishes a real change from a no-op / untracked.
{
  const { ws } = newEnv();
  const real = path.join(ws, "real.ts");   fs.writeFileSync(real, "NEW");
  const noop = path.join(ws, "noop.ts");   fs.writeFileSync(noop, "SAME");
  const made = path.join(ws, "made.ts");   fs.writeFileSync(made, "hi");
  const sm = new SessionManager(fakeLog, ws); sm.startWatching();
  sm.trackFileChange(real, "OLD");   // baseline != disk → real
  sm.trackFileChange(noop, "SAME");  // baseline == disk → no-op
  sm.trackFileChange(made, null);    // new file, present on disk → real
  assert.equal(sm.hasRealPendingChange(real), true, "modified file is a real change");
  assert.equal(sm.hasRealPendingChange(noop), false, "baseline == disk is a no-op");
  assert.equal(sm.hasRealPendingChange(made), true, "created file (exists) is a real change");
  assert.equal(sm.hasRealPendingChange(path.join(ws, "nope.ts")), false, "untracked file is not pending");
  sm.stopWatching();
  console.log("ok - hasRealPendingChange distinguishes real / no-op / untracked");
}

// Pending scope: out-of-workspace entries are pruned on load and never counted;
// excluded files stay in files{} but are not counted; only in-workspace,
// non-excluded files count toward the Pending panel.
{
  const { ws, sp } = newEnv();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cg-out-"));
  const inFp = path.join(ws, "in.ts");
  const outFp = path.join(outside, "out.ts");
  const lockFp = path.join(ws, "package-lock.json");
  for (const f of [inFp, outFp, lockFp]) fs.writeFileSync(f, "x2");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, JSON.stringify({
    sessionId: "t", status: "active", accepted: [], rejected: {},
    files: {
      [inFp]: { originalContent: "x1", reviewStatus: "pending" },
      [outFp]: { originalContent: "x1", reviewStatus: "pending" },
      [lockFp]: { originalContent: "x1", reviewStatus: "pending" },
    },
  }));
  const matcher = new ExcludeMatcher(); matcher.reload({ "**/package-lock.json": true }, ws);
  setExcludeMatcher(matcher);
  stubWorkspace.workspaceFolders = [{ uri: { fsPath: ws } }];
  const sm = new SessionManager(fakeLog, ws); sm.startWatching(); // load → prune out-of-workspace
  const files = sm.getSession()!.files;
  assert.equal(files[outFp], undefined, "out-of-workspace entry pruned on load");
  assert.ok(files[inFp], "in-workspace entry kept");
  assert.ok(files[lockFp], "excluded entry kept in files (only filtered from the count)");
  assert.equal(sm.getPendingCount(), 1, "only the in-workspace, non-excluded file is counted");
  stubWorkspace.workspaceFolders = undefined;   // reset shared stub state
  setExcludeMatcher(new ExcludeMatcher());       // reset shared matcher
  sm.stopWatching();
  console.log("ok - pending scope: out-of-workspace pruned, excluded uncounted");
}

// REGRESSION (nonstop-rewrite loop): a settled no-op pending entry (baseline ==
// disk, captured long ago) must be pruned by the reconcile timer AND STAY pruned.
// Before the fix, persist()'s dual-writer merge resurrected the just-pruned entry
// from the stale on-disk copy every cycle, so removed>0 fired persist forever
// (≈ every RECONCILE_GRACE_MS) — the file was rewritten nonstop and the UI
// reloaded without end. We assert the entry is gone and the file stops changing.
// oversized-session self-heal: a bloated session file still loads (the user keeps
// their pending changes), a WARN is logged so the bloat is visible, and the
// oldest accepted records are auto-trimmed to bound the file size.
{
  const { ws, sp } = newEnv();
  const fp = path.join(ws, "big.ts");
  fs.writeFileSync(fp, "NEW");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  const huge = "x".repeat(2_100_000);
  fs.writeFileSync(sp, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [fp]: { originalContent: "OLD", reviewStatus: "pending" } },
    // three ~2 MB blobs → ~6 MB file, over SESSION_SIZE_WARN_BYTES
    accepted: [0, 1, 2].map((i) => ({ id: "r" + i, path: fp, before: null, after: huge, decidedAt: "t" + i })),
    rejected: {},
  }));
  const lines: string[] = [];
  const capturingLog = { appendLine: (l: string) => lines.push(l) } as any;
  const sm = new SessionManager(capturingLog, ws);
  sm.startWatching();
  assert.ok(sm.getSession(), "oversized session still loads");
  assert.ok(sm.getSession()!.files[fp], "pending entry preserved from a large session");
  assert.ok(lines.some((l) => l.includes("[WARN]") && l.includes("large")), "large-session WARN logged");
  assert.ok(sm.getSession()!.accepted.length < 3, "oldest accepted records auto-trimmed");
  assert.equal(sm.getSession()!.accepted[sm.getSession()!.accepted.length - 1].id, "r2", "newest kept");
  assert.ok(fs.statSync(sp).size < 5_000_000, "self-heal rewrote the file under the warn threshold");
  sm.stopWatching();
  console.log("ok - oversized session self-heals (trims oldest accepted)");
}

(async () => {
  const { ws, sp } = newEnv();
  const noop = path.join(ws, "noop.go");
  fs.writeFileSync(noop, "SAME");
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  const old = new Date(Date.now() - 60_000).toISOString(); // captured well past grace
  fs.writeFileSync(sp, JSON.stringify({
    sessionId: "t", status: "active",
    files: { [noop]: { originalContent: "SAME", reviewStatus: "pending", capturedAt: old } },
    accepted: [], rejected: {},
  }));
  const sm = new SessionManager(fakeLog, ws);
  sm.startWatching(); // load → schedules reconcile

  const RECONCILE_GRACE_MS = 1500;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(RECONCILE_GRACE_MS + 500);            // let reconcile fire + persist settle
  assert.equal(sm.getSession()!.files[noop], undefined, "settled no-op pruned in memory");
  assert.equal(readSession(sp).files[noop], undefined, "settled no-op pruned on disk");

  const before = fs.statSync(sp).mtimeMs;
  await sleep(RECONCILE_GRACE_MS + 500);            // if the loop persisted, mtime advances
  assert.equal(fs.statSync(sp).mtimeMs, before, "session file stops being rewritten (no loop)");
  assert.equal(readSession(sp).files[noop], undefined, "prune stays applied (not resurrected)");
  sm.stopWatching();
  console.log("ok - settled no-op prune sticks; no nonstop-rewrite loop");

  // C4: a file whose on-disk content is not valid UTF-8 (binary) must not be
  // captured as a lossy mojibake string — reading it returns null (treated as
  // unreadable), matching hook.py's strict-decode skip, so we never store or
  // later write back U+FFFD-corrupted bytes.
  {
    const { ws, sp } = newEnv();
    const fp = path.join(ws, "img.bin");
    fs.writeFileSync(fp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0xab])); // invalid UTF-8
    const sm = new SessionManager(fakeLog, ws);
    sm.startWatching();
    sm.trackFileChange(fp, "TEXT-BASELINE");
    sm.acceptFile(fp);
    const s = readSession(sp);
    assert.equal(s.accepted.length, 1, "accepted record written");
    assert.equal(s.accepted[0].after, null, "binary 'after' stored as null, not corrupted mojibake");
    sm.stopWatching();
    console.log("ok - binary/non-UTF-8 content is not captured as mojibake");
  }

  // corruption: an unparseable session file must not crash the load, must be
  // logged as corrupt (not silently swallowed), and — crucially — must be
  // distinguished from a normal absent file (ENOENT), which is not an error.
  {
    const { ws, sp } = newEnv();
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, "{ this is not valid json");
    const lines: string[] = [];
    const capLog = { appendLine: (l: string) => lines.push(l) } as any;
    const sm = new SessionManager(capLog, ws);
    sm.startWatching(); // loadSession runs synchronously; must not throw
    assert.equal(sm.getSession(), null, "corrupt first load → null (no prior good state to keep)");
    assert.ok(lines.some((l) => l.includes("[ERROR]") && l.includes("corrupt")), "corruption surfaced in the log");
    sm.stopWatching();
    console.log("ok - corrupt session file is logged, not silently swallowed");
  }

  // clearSession archives to history/ then deletes the session file.
  {
    const { ws, sp, home } = newEnv();
    const fp = path.join(ws, "c.ts");
    fs.writeFileSync(fp, "NEW");
    const sm = new SessionManager(fakeLog, ws);
    sm.startWatching();
    sm.trackFileChange(fp, "OLD");
    assert.ok(fs.existsSync(sp), "session file exists before clear");
    sm.clearSession();
    assert.equal(sm.getSession(), null, "session cleared in memory");
    assert.ok(!fs.existsSync(sp), "session file deleted");
    const historyDir = path.join(home, ".claudegate", "history");
    assert.ok(fs.existsSync(historyDir) && fs.readdirSync(historyDir).length >= 1, "archived a backup to history/");
    sm.stopWatching();
    console.log("ok - clearSession archives then deletes");
  }

  // clearSession must NOT destroy the session if the backup couldn't be written.
  {
    const { ws, sp, home } = newEnv();
    const fp = path.join(ws, "d.ts");
    fs.writeFileSync(fp, "NEW");
    const sm = new SessionManager(fakeLog, ws);
    sm.startWatching();
    sm.trackFileChange(fp, "OLD");
    // Block archiving: occupy the history directory path with a regular file so
    // mkdir fails → archive fails.
    fs.writeFileSync(path.join(home, ".claudegate", "history"), "not a dir");
    sm.clearSession();
    assert.ok(fs.existsSync(sp), "session file preserved when the backup fails");
    assert.ok(sm.getSession(), "in-memory session preserved when the backup fails");
    sm.stopWatching();
    console.log("ok - clearSession aborts (no delete) when archive fails");
  }

  // history archives embed workspacePath so the History panel can scope them
  {
    const { ws, home } = newEnv();
    const fp = path.join(ws, "h.ts");
    fs.writeFileSync(fp, "NEW");
    const sm = new SessionManager(fakeLog, ws);
    sm.startWatching();
    sm.trackFileChange(fp, "OLD");
    sm.acceptFile(fp);
    sm.clearSession();
    const historyDir = path.join(home, ".claudegate", "history");
    const files = fs.readdirSync(historyDir);
    assert.equal(files.length, 1, "one archive written");
    const arc = JSON.parse(fs.readFileSync(path.join(historyDir, files[0]), "utf-8"));
    assert.equal(arc.workspacePath, path.resolve(ws), "archive embeds resolved workspacePath");
    assert.equal(arc.accepted.length, 1, "archive carries the review log");
    sm.stopWatching();
    console.log("ok - clearSession archive embeds workspacePath");
  }

  // clearSession({archive:false}) skips the backup AND the abort guard
  {
    const { ws, sp, home } = newEnv();
    const fp = path.join(ws, "n.ts");
    fs.writeFileSync(fp, "NEW");
    const sm = new SessionManager(fakeLog, ws);
    sm.startWatching();
    sm.trackFileChange(fp, "OLD");
    // block the history dir (mkdir would fail) — with archive:false it must not matter
    fs.writeFileSync(path.join(home, ".claudegate", "history"), "not a dir");
    sm.clearSession({ archive: false });
    assert.equal(sm.getSession(), null, "session cleared in memory despite blocked history dir");
    assert.ok(!fs.existsSync(sp), "session file deleted without a backup (explicit opt-out)");
    sm.stopWatching();
    console.log("ok - clearSession({archive:false}) skips backup and guard");
  }

  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
