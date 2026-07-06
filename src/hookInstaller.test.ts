import * as assert from "assert";
import { computeSettingsPatch, shouldWarnTrustInvalidation } from "./hookInstaller";

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

// 4. Malformed settings → treated as fresh install, changed.
{
  const { content, changed } = computeSettingsPatch("{ not json", CMD);
  assert.equal(changed, true, "malformed settings replaced with valid ones");
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed.hooks.PreToolUse[0], ENTRY, "entry installed over garbage");
  console.log("ok - recovers from malformed settings");
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

console.log("all hookInstaller tests passed");
