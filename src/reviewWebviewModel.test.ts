import assert from "node:assert";
import {
  buildReviewModel, buildFeedbackText, buildReviewPayload, ReviewItemInput,
} from "./reviewWebviewModel";

function run(name: string, fn: () => void): void {
  try { fn(); console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name); console.error(e); process.exitCode = 1; }
}

run("buildReviewModel summarizes counts, status, missing, no-change, new", () => {
  const items: ReviewItemInput[] = [
    { relPath: "a.ts", before: "x\n", after: "y\n", status: "pending", isNew: false, isProtected: false },
    { relPath: "new.ts", before: null, after: "hello\n", status: "pending", isNew: true, isProtected: false },
    { relPath: "same.ts", before: "z\n", after: "z\n", status: "pending", isNew: false, isProtected: false },
    { relPath: "gone.ts", before: "q\n", after: null, status: "pending", isNew: false, isProtected: false },
    { relPath: "kept.ts", before: "a\n", after: "b\n", status: "kept", isNew: false, isProtected: true },
  ];
  const model = buildReviewModel(items);
  assert.equal(model.totalCount, 5);
  assert.equal(model.reviewedCount, 1); // only "kept.ts"
  const same = model.files.find(f => f.relPath === "same.ts")!;
  assert.equal(same.noChange, true);
  const gone = model.files.find(f => f.relPath === "gone.ts")!;
  assert.equal(gone.missing, true);
  const nw = model.files.find(f => f.relPath === "new.ts")!;
  assert.equal(nw.isNew, true);
  const kept = model.files.find(f => f.relPath === "kept.ts")!;
  assert.equal(kept.status, "kept");
  assert.equal(kept.isProtected, true);
});

run("buildFeedbackText groups kept/reverted(with reason)/still-reviewing; omits empty sections", () => {
  const items: ReviewItemInput[] = [
    { relPath: "proto/carrier.proto", before: "a", after: "b", status: "kept", isNew: false, isProtected: false },
    { relPath: "internal/x.go", before: "a", after: "b", status: "undone", isNew: false, isProtected: false, reason: "still used by batch job" },
    { relPath: "internal/y.go", before: "a", after: "b", status: "undone", isNew: false, isProtected: false },
    { relPath: "proto/vendor.proto", before: "a", after: "b", status: "pending", isNew: false, isProtected: false },
  ];
  const text = buildFeedbackText(items);
  assert.ok(text.includes("KEPT:\n- proto/carrier.proto"));
  assert.ok(text.includes("REVERTED (don't re-apply as-is):"));
  assert.ok(text.includes("- internal/x.go — still used by batch job"));
  assert.ok(text.includes("- internal/y.go\n")); // no reason → path only
  assert.ok(text.includes("Still reviewing:\n- proto/vendor.proto"));
});

run("buildFeedbackText omits sections with no members", () => {
  const text = buildFeedbackText([
    { relPath: "a.ts", before: "x", after: "y", status: "kept", isNew: false, isProtected: false },
  ]);
  assert.ok(text.includes("KEPT:"));
  assert.ok(!text.includes("REVERTED"));
  assert.ok(!text.includes("Still reviewing"));
});

run("buildReviewPayload passes before/after through and computes counts/flags", () => {
  const items: ReviewItemInput[] = [
    { relPath: "a.ts", before: "x\n", after: "y\n", status: "pending", isNew: false, isProtected: false },
    { relPath: "gone.ts", before: "q\n", after: null, status: "pending", isNew: false, isProtected: false },
    { relPath: "same.ts", before: "z\n", after: "z\n", status: "pending", isNew: false, isProtected: false },
    { relPath: "k.ts", before: "a\n", after: "b\n", status: "kept", isNew: false, isProtected: true },
  ];
  const { files, reviewedCount, totalCount } = buildReviewPayload(items);
  assert.equal(totalCount, 4);
  assert.equal(reviewedCount, 1);
  const a = files.find(f => f.relPath === "a.ts")!;
  assert.equal(a.before, "x\n"); assert.equal(a.after, "y\n");
  assert.ok(a.added >= 1 && a.removed >= 1);
  assert.equal(files.find(f => f.relPath === "gone.ts")!.missing, true);
  assert.equal(files.find(f => f.relPath === "same.ts")!.noChange, true);
  assert.equal(files.find(f => f.relPath === "k.ts")!.isProtected, true);
});

console.log("done");
