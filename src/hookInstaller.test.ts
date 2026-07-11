import * as assert from "assert";
import { computeSettingsPatch, shouldWarnTrustInvalidation, hookHealthFrom, buildVerifyReport } from "./hookInstaller";

const CMD = "/home/me/.claudegate/hook.sh";
const ENTRY = {
  matcher: "^(Write|Edit|MultiEdit)$",
  hooks: [{ type: "command", command: CMD }],
};

// The registration write must be idempotent: rewriting ~/.claude/settings.json
// out from under a running Claude Code session invalidates its hook trust
// (anti-tampering), silently disabling capture until the session restarts.
// See docs/2026-07-06-hook-not-firing-in-running-session-bug.md.

// 1. Empty/absent settings → install, changed.
{
  const { content, changed } = computeSettingsPatch("", CMD);
  assert.equal(changed, true, "empty settings must be written");
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed.hooks.PreToolUse[0], ENTRY, "entry installed");
  console.log("ok - installs into empty settings");
}

// 2. Already-registered, byte-identical → NO write (the bug: this used to rewrite).
{
  const first = computeSettingsPatch("", CMD).content;
  const { content, changed } = computeSettingsPatch(first, CMD);
  assert.equal(changed, false, "byte-identical settings must NOT be rewritten");
  assert.equal(content, first, "content unchanged when already installed");
  console.log("ok - idempotent when already registered");
}

// 3. Foreign hooks present but no claudegate → append, changed, foreign preserved.
{
  const foreign = JSON.stringify(
    { hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "/other/tool.sh" }] }] } },
    null,
    2
  );
  const { content, changed } = computeSettingsPatch(foreign, CMD);
  assert.equal(changed, true, "must append when claudegate not present");
  const parsed = JSON.parse(content);
  assert.equal(parsed.hooks.PreToolUse.length, 2, "foreign hook preserved");
  assert.ok(
    parsed.hooks.PreToolUse.some((h: { hooks: { command: string }[] }) =>
      h.hooks.some((x) => x.command === "/other/tool.sh")
    ),
    "foreign command retained"
  );
  console.log("ok - appends without clobbering foreign hooks");
}

// 4. Malformed NON-EMPTY settings → refuse to write (never wipe the user's
//    config); report parseError so the caller aborts and warns.
{
  const raw = '{ "model": "x", not json';
  const { content, changed, parseError } = computeSettingsPatch(raw, CMD);
  assert.equal(parseError, true, "malformed settings flagged, not silently reset");
  assert.equal(changed, false, "malformed settings must NOT trigger a write");
  assert.equal(content, raw, "original bytes preserved (no data loss)");
  console.log("ok - refuses to overwrite malformed settings");
}

// 4b. Empty/whitespace file is NOT a parse error — it's a fresh install.
{
  const { changed, parseError } = computeSettingsPatch("   \n", CMD);
  assert.equal(parseError, undefined, "empty file is not a parse error");
  assert.equal(changed, true, "empty file → install");
  console.log("ok - empty file treated as fresh install, not corruption");
}

// 4c. Non-object JSON (array/number) → refuse (would clobber on write).
{
  const { changed, parseError } = computeSettingsPatch("[1,2,3]", CMD);
  assert.equal(parseError, true, "non-object top-level JSON flagged");
  assert.equal(changed, false, "non-object JSON must NOT trigger a write");
  console.log("ok - refuses non-object settings JSON");
}

// 4d. I1 — already installed but DIFFERENT formatting (4-space indent) → no
//     write. A byte-diff rewrite would reformat the file and invalidate hook
//     trust for every running session; only a semantic change may write.
{
  const fourSpace = JSON.stringify(
    { hooks: { PreToolUse: [ENTRY] } },
    null,
    4
  );
  const { changed } = computeSettingsPatch(fourSpace, CMD);
  assert.equal(changed, false, "formatting-only difference must NOT rewrite");
  console.log("ok - formatting-only difference does not rewrite (trust preserved)");
}

// 4e. I3 — a stale claudegate registration (wrong wrapper path) is repaired in
//     place to the correct command, not left broken.
{
  const stale = JSON.stringify(
    { hooks: { PreToolUse: [{ matcher: "^(Write|Edit|MultiEdit)$", hooks: [{ type: "command", command: "/old/path/.claudegate/hook.sh" }] }] } },
    null,
    2
  );
  const { content, changed } = computeSettingsPatch(stale, CMD);
  assert.equal(changed, true, "stale claudegate path must be repaired");
  const parsed = JSON.parse(content);
  const cmds = parsed.hooks.PreToolUse.flatMap((h: { hooks: { command: string }[] }) => h.hooks.map((x) => x.command));
  assert.ok(cmds.includes(CMD), "repaired to the correct command");
  assert.ok(!cmds.includes("/old/path/.claudegate/hook.sh"), "old command removed");
  assert.equal(parsed.hooks.PreToolUse.length, 1, "no duplicate claudegate entry created");
  console.log("ok - repairs a stale claudegate registration");
}

// ── Health signal: shouldWarnTrustInvalidation ────────────────────────────
const registered = computeSettingsPatch("", CMD).content; // contains "claudegate"

// 5. No change → never warn (covers our own no-op write / idle poll).
{
  assert.equal(shouldWarnTrustInvalidation(registered, registered), false, "identical → no warn");
  console.log("ok - no warning when settings unchanged");
}

// 6. Changed while claudegate still registered → warn (trust invalidated).
{
  const mutated = registered.replace("Write|Edit|MultiEdit", "Write|Edit");
  assert.notEqual(mutated, registered, "sanity: content actually changed");
  assert.equal(shouldWarnTrustInvalidation(registered, mutated), true, "changed + registered → warn");
  console.log("ok - warns when registered settings change mid-session");
}

// 7. Changed but claudegate removed → uninstall, not invalidation → no warn.
{
  assert.equal(shouldWarnTrustInvalidation(registered, "{}"), false, "claudegate removed → no warn");
  console.log("ok - no warning when claudegate entry is removed (uninstall)");
}

// ── hookHealthFrom precedence ────────────────────────────────────────────────
// hookHealthFrom precedence: not-installed → not-registered → trust-invalidated → stale → ok
{
  const S = (o: Partial<{scriptInstalled:boolean;registered:boolean;upToDate:boolean}>) =>
    ({ scriptInstalled: true, registered: true, upToDate: true, ...o });
  assert.equal(hookHealthFrom(S({ scriptInstalled: false }), false), "not-installed");
  assert.equal(hookHealthFrom(S({ registered: false }), false), "not-registered");
  assert.equal(hookHealthFrom(S({}), true), "trust-invalidated", "runtime trust flag outranks a healthy status");
  assert.equal(hookHealthFrom(S({ upToDate: false }), false), "stale");
  assert.equal(hookHealthFrom(S({}), false), "ok");
  // a not-installed hook can't be trust-invalidated — install state wins
  assert.equal(hookHealthFrom(S({ scriptInstalled: false }), true), "not-installed");
  console.log("ok - hookHealthFrom maps status + trust flag to health state");
}

// ── buildVerifyReport ────────────────────────────────────────────────────────
{
  const pass = buildVerifyReport([
    { label: "hook.py installed", ok: true },
    { label: "registered", ok: true },
  ]);
  assert.equal(pass.ok, true);
  assert.ok(pass.lines.every((l) => l.startsWith("✓ ")), "all-pass lines are checkmarks");

  const mixed = buildVerifyReport([
    { label: "hook.py installed", ok: true },
    { label: "registered", ok: false, detail: "not in settings.json" },
  ]);
  assert.equal(mixed.ok, false);
  assert.ok(mixed.lines.some((l) => l === "✗ registered — not in settings.json"), "failing line shows detail");
  assert.ok(mixed.lines.some((l) => l === "✓ hook.py installed"));
  console.log("ok - buildVerifyReport formats per-check lines + overall ok");
}

console.log("all hookInstaller tests passed");
