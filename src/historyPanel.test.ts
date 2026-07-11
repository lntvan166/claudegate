import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { HistoryTreeProvider, HistorySessionItem, HistoryRecordItem } from "./historyPanel";

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
console.log("done");
