import * as assert from "assert";
import * as path from "path";
import { summarizeArchive, archiveMatchesWorkspace, findArchiveRecord, formatBytes } from "./historyModel";

const archive = {
  sessionId: "2026-07-10T09:31:00.000Z",
  workspacePath: "/ws/project",
  files: { "/ws/project/pending.ts": { originalContent: "p", reviewStatus: "pending" } },
  accepted: [
    { id: "t1::/ws/project/a.ts", path: "/ws/project/a.ts", before: "1", after: "2", decidedAt: "t1" },
    { id: "t2::/ws/project/b.ts", path: "/ws/project/b.ts", before: null, after: "new", decidedAt: "t2" },
  ],
  rejected: {
    "/ws/project/r.ts": { id: "t3::/ws/project/r.ts", path: "/ws/project/r.ts", before: "x", after: "y", decidedAt: "t3", reason: "keep old" },
  },
};

// summarize: counts, records, label from sessionId, pending excluded
{
  const s = summarizeArchive("/h/f.json", archive, 2048)!;
  assert.ok(s, "summarizes");
  assert.equal(s.kept, 2); assert.equal(s.rejected, 1);
  assert.equal(s.records.length, 3, "pending entries are NOT records");
  assert.equal(s.bytes, 2048);
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s.label), `label is local Y-M-D H:M, got ${s.label}`);
  console.log("ok - summarizeArchive counts decided records, excludes pending");
}
// no decided records → null; garbage → null
{
  assert.equal(summarizeArchive("/h/e.json", { sessionId: "s", files: {}, accepted: [], rejected: {} }, 10), null);
  assert.equal(summarizeArchive("/h/g.json", "not an object", 10), null);
  assert.equal(summarizeArchive("/h/g2.json", null, 10), null);
  console.log("ok - summarizeArchive returns null for empty/garbage archives");
}
// unparseable sessionId → raw id used as label
{
  const s = summarizeArchive("/h/x.json", { ...archive, sessionId: "weird-id" }, 1)!;
  assert.equal(s.label, "weird-id");
  console.log("ok - summarizeArchive falls back to raw sessionId label");
}
// workspace matching: workspacePath equality wins
{
  assert.equal(archiveMatchesWorkspace(archive, "/ws/project"), true);
  assert.equal(archiveMatchesWorkspace(archive, "/other"), false, "workspacePath mismatch → no fallback");
  console.log("ok - archiveMatchesWorkspace honors embedded workspacePath");
}
// legacy archive (no workspacePath) → record-path inference.
// Build native paths: isPathUnder resolves the root but compares the raw record
// path, so on Windows the fixture must use OS-native separators to match.
{
  const root = path.resolve("/ws/project");
  const legacy = {
    sessionId: "s", files: {},
    accepted: [{ id: "t1", path: path.join(root, "a.ts"), before: "1", after: "2", decidedAt: "t1" }],
    rejected: {},
  } as any;
  assert.equal(archiveMatchesWorkspace(legacy, root), true, "record under root → match");
  assert.equal(archiveMatchesWorkspace(legacy, path.resolve("/elsewhere")), false);
  console.log("ok - archiveMatchesWorkspace infers from record paths for legacy archives");
}
// win32 case-fold
{
  const w = { ...archive, workspacePath: "C:\\Proj" } as any;
  assert.equal(archiveMatchesWorkspace(w, "c:\\proj", true), true);
  console.log("ok - archiveMatchesWorkspace case-folds when asked (win32)");
}
// record lookup incl. reject reason
{
  const r = findArchiveRecord(archive, "t3::/ws/project/r.ts")!;
  assert.equal(r.kind, "rejected"); assert.equal(r.reason, "keep old"); assert.equal(r.after, "y");
  assert.equal(findArchiveRecord(archive, "nope"), null);
  console.log("ok - findArchiveRecord finds by id with reason");
}
// bytes formatting
{
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(1572864), "1.5 MB");
  console.log("ok - formatBytes");
}
console.log("done");
