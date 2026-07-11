import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryTreeProvider, HistorySessionItem, HistoryRecordItem, HistoryFolderItem } from "./historyPanel";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-hist-"));
const ws = "/ws/project";
const mk = (name: string, obj: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));

mk("2026-07-10.json", {
  sessionId: "2026-07-10T09:31:00.000Z", workspacePath: ws,
  files: {}, rejected: { "/ws/project/r.ts": { id: "r1", path: "/ws/project/r.ts", before: "a", after: "b", decidedAt: "t", reason: "why" } },
  accepted: [{ id: "a1", path: "/ws/project/a.ts", before: "1", after: "2", decidedAt: "t" }],
});
mk("other-ws.json", {
  sessionId: "2026-07-09T08:00:00.000Z", workspacePath: "/elsewhere",
  files: {}, accepted: [{ id: "x", path: "/elsewhere/z.ts", before: "1", after: "2", decidedAt: "t" }], rejected: {},
});
mk("empty.json", { sessionId: "s", files: {}, accepted: [], rejected: {} });
fs.writeFileSync(path.join(dir, "garbage.json"), "{ not json");

const p = new HistoryTreeProvider(ws, dir);
p.refresh();

assert.equal(p.getCount(), 1, "only the matching, non-empty, parseable archive shows");
const sessions = p.getChildren() as HistorySessionItem[];
assert.equal(sessions.length, 1);
assert.ok(String(sessions[0].description).includes("1✓"), "kept count in description");
assert.ok(String(sessions[0].description).includes("1✗"), "rejected count in description");
assert.equal(sessions[0].contextValue, "claudegate.historySession");

const records = p.getChildren(sessions[0]) as HistoryRecordItem[];
assert.equal(records.length, 2, "kept + rejected records");
const rec = records.find((r) => r.record.kind === "rejected")!;
assert.equal(rec.command?.command, "claudegate.openHistoryRecord");
assert.equal((rec.command?.arguments?.[1] as any).reason, "why", "record arg carries the reason");
assert.equal(records[0].label, path.relative(ws, (records[0].record).path), "record label is workspace-relative");

assert.deepEqual(p.matchingFiles(), [path.join(dir, "2026-07-10.json")]);
assert.ok(p.totalBytes() > 0);

// deletion reflected on refresh
fs.unlinkSync(path.join(dir, "2026-07-10.json"));
p.refresh();
assert.equal(p.getCount(), 0, "deleted archive disappears after refresh");

console.log("ok - history tree provider renders, scopes, and refreshes");

// tree grouping: records nested under folders become folder nodes → leaves
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "cg-hist2-"));
  const ws2 = "/ws/proj";
  fs.writeFileSync(path.join(d2, "s.json"), JSON.stringify({
    sessionId: "2026-07-10T00:00:00.000Z", workspacePath: ws2, files: {},
    accepted: [
      { id: "k1", path: "/ws/proj/src/a.ts", before: "1", after: "2", decidedAt: "t" },
      { id: "k2", path: "/ws/proj/src/util/b.ts", before: "1", after: "2", decidedAt: "t" },
      { id: "k3", path: "/ws/proj/top.ts", before: "1", after: "2", decidedAt: "t" },
    ],
    rejected: {},
  }));
  const tp = new HistoryTreeProvider(ws2, d2);
  tp.refresh();
  const [sess] = tp.getChildren() as HistorySessionItem[];

  const lvl1 = tp.getChildren(sess);
  const folders1 = lvl1.filter((i) => i instanceof HistoryFolderItem) as HistoryFolderItem[];
  const leaves1 = lvl1.filter((i) => i instanceof HistoryRecordItem) as HistoryRecordItem[];
  assert.equal(folders1.length, 1, "one 'src' folder at the session level");
  assert.equal(folders1[0].label, "src");
  assert.equal(leaves1.length, 1, "one top-level record leaf");
  assert.equal(leaves1[0].label, "top.ts", "leaf label is basename, not full path");

  const lvl2 = tp.getChildren(folders1[0]);
  const folders2 = lvl2.filter((i) => i instanceof HistoryFolderItem) as HistoryFolderItem[];
  const leaves2 = lvl2.filter((i) => i instanceof HistoryRecordItem) as HistoryRecordItem[];
  assert.equal(folders2.length, 1, "'util' subfolder under src");
  assert.equal(folders2[0].label, "util");
  assert.deepEqual(leaves2.map((l) => l.label), ["a.ts"], "a.ts leaf directly under src");

  const lvl3 = tp.getChildren(folders2[0]) as HistoryRecordItem[];
  assert.deepEqual(lvl3.map((l) => l.label), ["b.ts"], "b.ts leaf under src/util");
  assert.equal(lvl3[0].command?.command, "claudegate.openHistoryRecord", "leaf still opens the diff");
  console.log("ok - history records render as a folder tree");
}

console.log("done");
