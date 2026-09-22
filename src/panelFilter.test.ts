import * as assert from "assert";
import { normalizeFilter, matchesFilter, filterLabel } from "./panelFilter";

// ── normalizeFilter collapses "empty" to a single null state ─────────────────
// Every downstream call site treats null as "no filter", so a cleared input box
// and a never-set one must not be two different things.
{
  assert.strictEqual(normalizeFilter(undefined), null, "undefined → null");
  assert.strictEqual(normalizeFilter(null), null, "null → null");
  assert.strictEqual(normalizeFilter(""), null, "empty → null");
  assert.strictEqual(normalizeFilter("   "), null, "whitespace-only → null");
  assert.strictEqual(normalizeFilter("  auth  "), "auth", "trimmed");
  console.log("ok - normalizeFilter collapses empty input to a single null state");
}

// ── A null filter matches everything ────────────────────────────────────────
// Keeps every call site free of "is there a filter?" branching.
{
  assert.ok(matchesFilter("/repo/pkg/ws/auth.go", null), "null filter matches");
  console.log("ok - a null filter matches every path");
}

// ── Case-insensitive substring over the whole path ──────────────────────────
{
  const p = "/repo/wt-feature/pkg/ws/auth.go";
  assert.ok(matchesFilter(p, "auth"),       "matches the file name");
  assert.ok(matchesFilter(p, "AUTH"),       "case-insensitive on the filter");
  assert.ok(matchesFilter(p, "pkg/ws"),     "matches a directory fragment");
  assert.ok(matchesFilter(p, "wt-feature"), "matches a worktree name");
  assert.ok(!matchesFilter(p, "handler"),   "non-match is excluded");
  console.log("ok - matchesFilter is a case-insensitive substring over the whole path");
}

// ── Separators are normalised in both directions ────────────────────────────
// Nobody types a backslash on purpose, and a Windows session stores paths with
// them — so a user typing `pkg/ws` must still match `pkg\\ws`.
{
  assert.ok(matchesFilter("C:\\repo\\pkg\\ws\\auth.go", "pkg/ws"),
    "forward-slash filter matches a backslash path");
  assert.ok(matchesFilter("/repo/pkg/ws/auth.go", "pkg\\ws"),
    "backslash filter matches a forward-slash path");
  console.log("ok - matchesFilter normalises path separators both ways");
}

// ── filterLabel: silent when unfiltered, explicit when not ──────────────────
// The counts are what stop a filtered panel from reading as a finished review.
{
  assert.strictEqual(filterLabel(null, 16, 16), undefined, "no filter → no description");
  assert.strictEqual(filterLabel("auth", 4, 16), "auth — 4 of 16", "shows both numbers");
  assert.strictEqual(filterLabel("zzz", 0, 16), "zzz — 0 of 16",
    "a filter matching nothing still reports the total, so an empty panel is legible");
  console.log("ok - filterLabel reports shown-of-total whenever a filter is set");
}
