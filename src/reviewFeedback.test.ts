import assert from "node:assert";
import { buildFeedbackText, sessionFeedbackItems, ReviewItemInput } from "./reviewFeedback";
import type { Session } from "./reviewModel";

function run(name: string, fn: () => void): void {
  try { fn(); console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name); console.error(e); process.exitCode = 1; }
}

run("buildFeedbackText groups kept/reverted(with reason)/still-reviewing; omits empty sections", () => {
  const items: ReviewItemInput[] = [
    { relPath: "proto/carrier.proto", status: "kept" },
    { relPath: "internal/x.go", status: "undone", reason: "still used by batch job" },
    { relPath: "internal/y.go", status: "undone" },
    { relPath: "proto/vendor.proto", status: "pending" },
  ];
  const text = buildFeedbackText(items);
  assert.ok(text.includes("KEPT:\n- proto/carrier.proto"));
  assert.ok(text.includes("REVERTED (don't re-apply as-is):"));
  assert.ok(text.includes("- internal/x.go — still used by batch job"));
  assert.ok(text.includes("- internal/y.go\n")); // no reason → path only
  assert.ok(text.includes("Still reviewing:\n- proto/vendor.proto"));
});

run("buildFeedbackText omits sections with no members", () => {
  const text = buildFeedbackText([{ relPath: "a.ts", status: "kept" }]);
  assert.ok(text.includes("KEPT:"));
  assert.ok(!text.includes("REVERTED"));
  assert.ok(!text.includes("Still reviewing"));
});

run("sessionFeedbackItems maps pending/accepted/rejected into feedback items", () => {
  const session: Session = {
    sessionId: "s", status: "active",
    files: { "/ws/a.ts": { originalContent: "x", reviewStatus: "pending" } },
    accepted: [
      { id: "1::/ws/k.ts", path: "/ws/k.ts", before: "a", after: "b", decidedAt: "t1" },
      { id: "2::/out/skip.ts", path: "/out/skip.ts", before: "a", after: "b", decidedAt: "t2" },
    ],
    rejected: {
      "/ws/r.ts": { id: "3::/ws/r.ts", path: "/ws/r.ts", before: "a", after: "b", decidedAt: "t3", reason: "why" },
    },
  };
  const items = sessionFeedbackItems(session, (p) => p.replace("/ws/", ""), (p) => p.startsWith("/ws/"));
  const by = (rp: string) => items.find((i) => i.relPath === rp)!;
  assert.equal(by("a.ts").status, "pending");
  assert.equal(by("k.ts").status, "kept");
  assert.equal(by("r.ts").status, "undone");
  assert.equal(by("r.ts").reason, "why", "reject reason carried into feedback");
  assert.ok(!items.some((i) => i.relPath.includes("skip")), "out-of-scope paths filtered");
  const text = buildFeedbackText(items);
  assert.ok(text.includes("KEPT:\n- k.ts"));
  assert.ok(text.includes("- r.ts — why"));
  assert.ok(text.includes("Still reviewing:\n- a.ts"));
});

run("sessionFeedbackItems: pending wins over a stale accept for the same path (re-edit)", () => {
  const session: Session = {
    sessionId: "s", status: "active",
    files: { "/ws/f.ts": { originalContent: "b", reviewStatus: "pending" } },
    accepted: [{ id: "1::/ws/f.ts", path: "/ws/f.ts", before: "a", after: "b", decidedAt: "t1" }],
    rejected: {},
  };
  const items = sessionFeedbackItems(session, (p) => p, () => true);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "pending", "re-edited file reports as pending, not kept");
});

console.log("done");
