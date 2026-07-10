import assert from "node:assert";
import {
  computeDiffPieces, buildReviewModel, buildFeedbackText, ReviewItemInput,
} from "./reviewWebviewModel";

function run(name: string, fn: () => void): void {
  try { fn(); console.log("ok -", name); }
  catch (e) { console.error("FAIL -", name); console.error(e); process.exitCode = 1; }
}

run("computeDiffPieces marks add/del/context and counts", () => {
  const pieces = computeDiffPieces("a\nb\nc\n", "a\nB\nc\n", 3);
  const lines = pieces.filter((p): p is Extract<typeof p, {type:"line"}> => p.type === "line");
  assert.equal(lines.filter(l => l.kind === "del").length, 1);
  assert.equal(lines.filter(l => l.kind === "add").length, 1);
  assert.ok(lines.some(l => l.kind === "context" && l.text === "a"));
});

run("computeDiffPieces folds large unchanged runs into a fold marker", () => {
  const big = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n") + "\n";
  const edited = big.replace("line25", "CHANGED25");
  const pieces = computeDiffPieces(big, edited, 3);
  const folds = pieces.filter(p => p.type === "fold") as { type: "fold"; hidden: number }[];
  assert.ok(folds.length >= 1, "expected at least one fold");
  assert.ok(folds.every(f => f.hidden > 0));
  // context is preserved around the change (3 lines each side)
  const lines = pieces.filter(p => p.type === "line") as { text: string }[];
  assert.ok(lines.some(l => l.text === "line22"));
  assert.ok(lines.some(l => l.text === "line28"));
});

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

console.log("done");
