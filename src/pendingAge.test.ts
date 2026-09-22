import * as assert from "assert";
import { ageInDays, ageLabel, rowDescription, ageTooltipLine } from "./pendingAge";

const NOW = new Date("2026-09-22T12:00:00.000Z");
const ago = (days: number, hours = 0) =>
  new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();

// ── ageInDays counts WHOLE days, and never goes negative ────────────────────
{
  assert.strictEqual(ageInDays(ago(0), NOW), 0, "captured today → 0");
  assert.strictEqual(ageInDays(ago(0, 23), NOW), 0, "23 hours is still 0 whole days");
  assert.strictEqual(ageInDays(ago(1), NOW), 1, "exactly one day");
  assert.strictEqual(ageInDays(ago(71), NOW), 71, "the oldest real entry");
  // Clock skew, or a session file copied from a machine running ahead: "-3d"
  // reads as a bug, 0 reads as "just now".
  const future = new Date(NOW.getTime() + 3 * 86_400_000).toISOString();
  assert.strictEqual(ageInDays(future, NOW), 0, "a future timestamp clamps to 0, not negative");
  console.log("ok - ageInDays counts whole days and clamps future timestamps to 0");
}

// ── Unparseable or missing timestamps degrade to "no age", never NaN ────────
// Entries written by an older hook, or a hand-edited session file.
{
  assert.strictEqual(ageInDays(undefined, NOW), null, "missing");
  assert.strictEqual(ageInDays(null, NOW), null, "null");
  assert.strictEqual(ageInDays("", NOW), null, "empty");
  assert.strictEqual(ageInDays("not-a-date", NOW), null, "garbage");
  assert.strictEqual(ageLabel("not-a-date", NOW, 1), undefined, "and produces no label, not 'NaNd'");
  console.log("ok - a missing or unparseable timestamp degrades to no label");
}

// ── The threshold is what turns a label into a signal ───────────────────────
{
  assert.strictEqual(ageLabel(ago(0), NOW, 1), undefined, "today is below the default threshold");
  assert.strictEqual(ageLabel(ago(1), NOW, 1), "1d", "one day meets it");
  assert.strictEqual(ageLabel(ago(71), NOW, 1), "71d", "and old entries always show");

  // 0 is OFF, and it is the default: no row is labelled at any age.
  assert.strictEqual(ageLabel(ago(0), NOW, 0), undefined, "minDays 0 → off (today)");
  assert.strictEqual(ageLabel(ago(71), NOW, 0), undefined, "minDays 0 → off, even at 71 days");
  assert.strictEqual(ageLabel(ago(71), NOW, -5), undefined, "a negative threshold is also off");
  assert.strictEqual(ageLabel(ago(13), NOW, 14), undefined, "just under a 14-day threshold");
  assert.strictEqual(ageLabel(ago(14), NOW, 14), "14d", "exactly at it");
  assert.strictEqual(ageLabel(ago(71), NOW, 99999), undefined,
    "a huge threshold disables the label entirely");
  console.log("ok - ageLabel respects the threshold at, below and above the boundary");
}

// ── rowDescription shares the slot with the folder path in list mode ────────
{
  assert.strictEqual(rowDescription(undefined, "5d"), "5d",
    "tree mode: the slot is empty, so the age has it to itself");
  assert.strictEqual(rowDescription("pkg/ws", "5d"), "pkg/ws · 5d",
    "list mode: path first so paths stay left-aligned, age last");
  assert.strictEqual(rowDescription("pkg/ws", undefined), "pkg/ws", "no age → unchanged");
  assert.strictEqual(rowDescription(undefined, undefined), undefined, "neither → nothing");
  assert.strictEqual(rowDescription("", ""), undefined, "empty strings collapse to nothing");
  console.log("ok - rowDescription combines folder path and age without losing either");
}

// ── The hover stays complete even when the row is quiet ─────────────────────
{
  assert.match(String(ageTooltipLine(ago(0), NOW)), /today/,
    "a row with NO label still reports its age on hover");
  assert.match(String(ageTooltipLine(ago(1), NOW)), /1 day ago/, "singular");
  assert.match(String(ageTooltipLine(ago(5), NOW)), /5 days ago/, "plural");
  assert.strictEqual(ageTooltipLine("nope", NOW), undefined, "unparseable → no line");
  console.log("ok - the tooltip reports age even for rows kept clean by the threshold");
}
