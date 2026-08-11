import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  computeSettingsPatch,
  shouldWarnTrustInvalidation,
  hookHealthFrom,
  buildVerifyReport,
  backupsToPrune,
  verifySettingsContent,
  SETTINGS_BACKUP_RETENTION,
  HookInstaller,
} from "./hookInstaller";

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

// 4f. Touch only what we own. A real-world settings.json carries the user's
//     whole Claude config plus other tools' hooks; installing ours must leave
//     every one of those byte-for-byte intact (deep-equal, not just "present").
//     Regression pin for the hazard where a failed read produced a bare stub
//     that replaced all of this.
{
  const foreignHook = {
    matcher: "^Bash$",
    hooks: [{ type: "command", command: "/other/tool.sh" }],
  };
  const original = {
    model: "opus[1m]",
    theme: "dark",
    permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)"] },
    enabledPlugins: { "claude-mem@marketplace": true },
    extraKnownMarketplaces: { marketplace: { source: { source: "github", repo: "a/b" } } },
    apiKeyHelper: "/usr/local/bin/key.sh",
    hooks: {
      PreToolUse: [foreignHook],
      PostToolUse: [{ matcher: "^Write$", hooks: [{ type: "command", command: "/other/post.sh" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "/other/start.sh" }] }],
    },
  };
  const { content, changed } = computeSettingsPatch(JSON.stringify(original, null, 2), CMD);
  assert.equal(changed, true, "claudegate not present → append");
  const parsed = JSON.parse(content);

  for (const key of Object.keys(original)) {
    assert.ok(key in parsed, `top-level key "${key}" survived`);
  }
  assert.deepEqual(Object.keys(parsed), Object.keys(original), "no key added, dropped or reordered");
  for (const key of ["model", "theme", "permissions", "enabledPlugins", "extraKnownMarketplaces", "apiKeyHelper"] as const) {
    assert.deepEqual(parsed[key], original[key], `${key} untouched`);
  }
  assert.deepEqual(parsed.hooks.PostToolUse, original.hooks.PostToolUse, "foreign PostToolUse untouched");
  assert.deepEqual(parsed.hooks.SessionStart, original.hooks.SessionStart, "foreign SessionStart untouched");
  assert.deepEqual(parsed.hooks.PreToolUse[0], foreignHook, "foreign PreToolUse hook untouched, still first");
  assert.equal(parsed.hooks.PreToolUse.length, 2, "exactly one entry appended");
  assert.deepEqual(parsed.hooks.PreToolUse[1], ENTRY, "and it is ours");
  console.log("ok - a full settings.json round-trips intact apart from our added entry");
}

// ── verifySettingsContent (post-write verification) ──────────────────────────
{
  const before = JSON.stringify({ model: "opus", permissions: {}, hooks: {} });
  const good = computeSettingsPatch(before, CMD).content;
  assert.equal(verifySettingsContent(good, before, CMD), null, "a correct write verifies");

  // The catastrophic case: our entry landed but the user's config is gone.
  const stub = computeSettingsPatch("", CMD).content;
  assert.ok(
    (verifySettingsContent(stub, before, CMD) ?? "").includes("model"),
    "a lost top-level key is reported by name"
  );

  assert.ok(verifySettingsContent("not json", before, CMD), "unparseable result rejected");
  assert.ok(verifySettingsContent("[]", before, CMD), "non-object result rejected");
  assert.ok(
    verifySettingsContent(JSON.stringify(JSON.parse(before)), before, CMD),
    "a write that silently did nothing (our entry missing) is rejected"
  );
  assert.equal(
    verifySettingsContent(computeSettingsPatch("", CMD).content, "", CMD),
    null,
    "fresh install has no prior keys to preserve"
  );
  console.log("ok - verifySettingsContent catches lost keys, bad JSON and missing entry");
}

// ── backupsToPrune (retention) ───────────────────────────────────────────────
{
  const names = [
    "settings.json",
    "settings.json.claudegate.bak",           // legacy fixed backup — never pruned
    "other.json.claudegate-2026-01-01T00-00-00.000Z.bak", // another file's backup
    ...Array.from({ length: 7 }, (_, i) =>
      `settings.json.claudegate-2026-08-1${i}T10-00-00.000Z.bak`),
  ];
  const stale = backupsToPrune(names, "settings.json");
  assert.equal(SETTINGS_BACKUP_RETENTION, 5, "retention is 5");
  assert.equal(stale.length, 2, "7 timestamped backups → prune the 2 oldest");
  assert.deepEqual(
    stale,
    [
      "settings.json.claudegate-2026-08-10T10-00-00.000Z.bak",
      "settings.json.claudegate-2026-08-11T10-00-00.000Z.bak",
    ],
    "the OLDEST are pruned, newest retained"
  );
  assert.ok(!stale.includes("settings.json.claudegate.bak"), "legacy fixed backup is never pruned");
  assert.ok(!stale.some((n) => n.startsWith("other.json")), "another file's backups are not touched");
  assert.deepEqual(backupsToPrune(names.slice(0, 5), "settings.json"), [], "under the cap → prune nothing");
  // Same-millisecond collision suffix must still sort as the newer copy.
  const collided = ["a.claudegate-2026-08-11T10-00-00.000Z.bak", "a.claudegate-2026-08-11T10-00-00.000Z_1.bak"];
  assert.deepEqual(backupsToPrune(collided, "a", 1), [collided[0]], "the _1 collision copy is the newer one");
  console.log("ok - backupsToPrune keeps the newest 5 and spares foreign/legacy backups");
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

// 8. Non-hooks fields change (model/theme/plugins) while the hooks block is
//    byte-identical → Claude Code rewrote settings.json for its own reasons,
//    the loaded PreToolUse hook is untouched → must NOT warn. This is the
//    real-world false positive: the warning "kept showing without any update".
{
  const withHooks = JSON.parse(registered);
  const benign = JSON.stringify({ ...withHooks, theme: "dark", model: "opus[1m]" });
  assert.notEqual(benign, registered, "sanity: content actually changed");
  assert.ok(benign.includes("claudegate"), "sanity: hook still registered");
  assert.equal(
    shouldWarnTrustInvalidation(registered, benign),
    false,
    "non-hooks change → no warn"
  );
  console.log("ok - no warning when only non-hooks settings change");
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

// Regression: syncHookIfNeeded() healed the hook but never fired onHealthChange,
// so the status chip kept asserting the state it had at activation. Harmless while
// the hash check and install happen synchronously before the first render, but a
// single `await` added ahead of them would strand a warning chip over a hook that
// is actually fine — and the panel would look broken when nothing is.
async function testHookSyncHeals(): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-hookhome-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE

  // The installer reads bundled hooks from <extensionPath>/hooks/hook.py.
  const extPath = fs.mkdtempSync(path.join(os.tmpdir(), "cg-ext-"));
  fs.mkdirSync(path.join(extPath, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(extPath, "hooks", "hook.py"), "print('bundled v2')\n");

  const store = new Map<string, unknown>();
  const context = {
    extensionPath: extPath,
    globalState: {
      get: (k: string) => store.get(k),
      update: async (k: string, v: unknown) => { store.set(k, v); },
    },
    extension: { packageJSON: { version: "9.9.9" } },
  } as never;

  // Pre-install an OLDER hook so the sync has real work to do.
  fs.mkdirSync(path.join(home, ".claudegate"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claudegate", "hook.py"), "print('installed v1')\n");

  const installer = new HookInstaller(context, { appendLine() {} } as never);
  const fired: string[] = [];
  installer.onHealthChange((h) => fired.push(h));

  const action = await installer.syncHookIfNeeded();
  assert.equal(action, "updated", "an older installed hook is updated, not installed fresh");
  assert.equal(
    fs.readFileSync(path.join(home, ".claudegate", "hook.py"), "utf-8"),
    "print('bundled v2')\n",
    "the bundled hook replaced the stale one on disk"
  );
  assert.ok(fired.length > 0, "a sync that changed the hook fires onHealthChange");

  // Second sync: hashes now match, so it must early-return without re-firing —
  // otherwise every window focus would churn the status chip.
  const before = fired.length;
  const second = await installer.syncHookIfNeeded();
  assert.equal(second, "none", "a matching hash is a no-op");
  assert.equal(fired.length, before, "a no-op sync fires no health event");

  // refreshHealth() is what the focus handler calls to catch changes made outside
  // this window (hook deleted, registration hand-edited away).
  installer.refreshHealth();
  assert.equal(fired.length, before + 1, "refreshHealth always notifies subscribers");

  // The anti-silent-stop claim: a hook removed mid-session must be restored by the
  // next sync, not left broken until the window reloads. Without this, capture
  // stops while the status chip still reads "ok" — failure with no signal.
  const hookPath = path.join(home, ".claudegate", "hook.py");
  fs.rmSync(hookPath);
  assert.equal(installer.getHealth(), "not-installed", "a deleted hook is detected");

  const healed = await installer.syncHookIfNeeded();
  assert.equal(healed, "installed", "a deleted hook is re-installed, not reported as updated");
  assert.equal(
    fs.readFileSync(hookPath, "utf-8"),
    "print('bundled v2')\n",
    "the bundled hook is restored byte-for-byte"
  );
  assert.notEqual(installer.getHealth(), "not-installed", "health recovers after the heal");

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(extPath, { recursive: true, force: true });
  console.log("ok - hook sync heals the installed hook and reports the health change");
}

// ── Guarded ~/.claude/settings.json write protocol ───────────────────────────
// This file is the user's ENTIRE Claude Code config. Every assertion below
// pins a hazard that was live in the shipped extension: a transient read error
// replacing the whole config with a hook-only stub, a single fixed backup that
// the next bad write destroys, and a rename that turns a dotfiles symlink into
// a detached regular file.

const NO_LOG = { appendLine() { /* silence */ } } as never;
const NO_CONTEXT = {} as never;

/** Fresh isolated HOME with an empty ~/.claude. Returns { home, claudeDir, settingsPath }. */
function tempSettingsHome(): { home: string; claudeDir: string; settingsPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cg-settings-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  return { home, claudeDir, settingsPath: path.join(claudeDir, "settings.json") };
}

const USER_CONFIG = JSON.stringify(
  {
    model: "opus[1m]",
    permissions: { allow: ["Bash(npm test)"] },
    enabledPlugins: { "claude-mem@marketplace": true },
    hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "/other/tool.sh" }] }] },
  },
  null,
  2
);

/** A settings blob with a stale claudegate wrapper path — always a semantic change. */
function staleConfig(): string {
  const parsed = JSON.parse(USER_CONFIG);
  parsed.hooks.PreToolUse.push({
    matcher: "^(Write|Edit|MultiEdit)$",
    hooks: [{ type: "command", command: "/old/home/.claudegate/hook.sh" }],
  });
  return JSON.stringify(parsed, null, 2);
}

const backupsIn = (dir: string): string[] =>
  fs.readdirSync(dir).filter((n) => n.endsWith(".bak")).sort();

// A perfectly good settings.json that we transiently cannot read: EACCES under a
// restrictive umask, EMFILE under a busy VS Code, EBUSY/EPERM on Windows while
// Claude Code rewrites the file for its own state. Injected because none of
// these can be provoked portably (chmod 000 proves nothing when running as root).
class UnreadableInstaller extends HookInstaller {
  protected readSettingsFileSync(): string {
    const err: NodeJS.ErrnoException = new Error("EACCES: permission denied, open 'settings.json'");
    err.code = "EACCES";
    throw err;
  }
}

function testUnreadableSettingsIsNeverOverwritten(): void {
  const { home, claudeDir, settingsPath } = tempSettingsHome();
  fs.writeFileSync(settingsPath, USER_CONFIG, "utf-8");

  const wrote = new UnreadableInstaller(NO_CONTEXT, NO_LOG).registerHookInSettings();

  assert.equal(wrote, false, "a non-ENOENT read error must abort the write");
  assert.equal(
    fs.readFileSync(settingsPath, "utf-8"),
    USER_CONFIG,
    "the user's entire config is untouched — NOT replaced by a hook-only stub"
  );
  assert.deepEqual(
    fs.readdirSync(claudeDir),
    ["settings.json"],
    "no write, no temp file and no backup churn"
  );

  // The same must hold for a real non-ENOENT errno: a directory at the settings
  // path makes readFileSync throw EISDIR.
  const other = tempSettingsHome();
  fs.mkdirSync(other.settingsPath);
  assert.equal(
    new HookInstaller(NO_CONTEXT, NO_LOG).registerHookInSettings(),
    false,
    "EISDIR aborts too"
  );
  assert.ok(fs.statSync(other.settingsPath).isDirectory(), "the existing path was not replaced");
  assert.deepEqual(fs.readdirSync(other.claudeDir), ["settings.json"], "and nothing was written");

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(other.home, { recursive: true, force: true });
  console.log("ok - a present-but-unreadable settings.json produces no write at all");
}

function testSymlinkedSettingsStaysASymlink(): void {
  const { home, claudeDir, settingsPath } = tempSettingsHome();
  const dotfiles = path.join(home, "dotfiles");
  fs.mkdirSync(dotfiles);
  const realFile = path.join(dotfiles, "settings.json");
  fs.writeFileSync(realFile, USER_CONFIG, "utf-8");
  fs.symlinkSync(realFile, settingsPath);

  const installer = new HookInstaller(NO_CONTEXT, NO_LOG);
  assert.equal(installer.registerHookInSettings(), true, "a fresh registration writes");

  assert.ok(fs.lstatSync(settingsPath).isSymbolicLink(), "settings.json is STILL a symlink");
  assert.equal(
    fs.realpathSync(settingsPath),
    fs.realpathSync(realFile),
    "and still points at the dotfiles target"
  );
  const written = JSON.parse(fs.readFileSync(realFile, "utf-8"));
  assert.ok(JSON.stringify(written).includes("claudegate"), "the dotfiles target received our entry");
  assert.equal(written.model, "opus[1m]", "the user's config survived");
  assert.deepEqual(
    written.hooks.PreToolUse[0],
    JSON.parse(USER_CONFIG).hooks.PreToolUse[0],
    "the foreign hook survived"
  );
  assert.deepEqual(
    fs.readdirSync(dotfiles),
    ["settings.json"],
    "no .bak or .tmp litter left inside the dotfiles repo"
  );

  // Backups live beside the literal path, in ~/.claude.
  const first = backupsIn(claudeDir);
  assert.equal(first.length, 1, "the pre-write state was backed up");
  assert.equal(
    fs.readFileSync(path.join(claudeDir, first[0]), "utf-8"),
    USER_CONFIG,
    "the backup holds the exact pre-write bytes"
  );

  // Hazard 2: a second write must ADD a backup, not overwrite the only good one.
  fs.writeFileSync(realFile, staleConfig(), "utf-8");
  assert.equal(installer.registerHookInSettings(), true, "a stale registration is repaired");
  const second = backupsIn(claudeDir);
  assert.equal(second.length, 2, "the second write added a backup instead of clobbering the first");
  assert.equal(
    fs.readFileSync(path.join(claudeDir, first[0]), "utf-8"),
    USER_CONFIG,
    "the first backup still holds the original config"
  );

  // Retention: newest 5 kept, older pruned.
  for (let i = 1; i <= 6; i++) {
    fs.writeFileSync(
      path.join(claudeDir, `settings.json.claudegate-1999-01-0${i}T00-00-00.000Z.bak`),
      `ancient ${i}`,
      "utf-8"
    );
  }
  fs.writeFileSync(realFile, staleConfig(), "utf-8");
  assert.equal(installer.registerHookInSettings(), true, "third real write");
  const kept = backupsIn(claudeDir);
  assert.equal(kept.length, SETTINGS_BACKUP_RETENTION, "retention caps backups at 5");
  assert.ok(!kept.some((n) => n.includes("1999-01-01")), "the oldest backups were pruned");
  assert.ok(kept.some((n) => n.includes("1999-01-06")), "the newest of the old backups is retained");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - a symlinked settings.json stays a symlink and backups are timestamped + capped");
}

// Simulates a write that lands wrong bytes (a partial write, a racing writer, a
// future bug in the patch logic). Verification must catch it and roll back.
class CorruptingInstaller extends HookInstaller {
  protected writeFileAtomic(filePath: string, _content: string): void {
    fs.writeFileSync(filePath, JSON.stringify({ hooks: {} }, null, 2), "utf-8");
  }
}

function testVerificationFailureRestoresBackup(): void {
  const { home, claudeDir, settingsPath } = tempSettingsHome();
  fs.writeFileSync(settingsPath, USER_CONFIG, "utf-8");

  const wrote = new CorruptingInstaller(NO_CONTEXT, NO_LOG).registerHookInSettings();

  assert.equal(wrote, false, "a write that fails verification is not reported as success");
  assert.equal(
    fs.readFileSync(settingsPath, "utf-8"),
    USER_CONFIG,
    "the user's config was restored from the backup, byte-for-byte"
  );
  assert.equal(backupsIn(claudeDir).length, 1, "the backup that made the rollback possible is kept");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - a post-write verification failure restores the backup");
}

// A full disk or a read-only ~/.claude makes the backup copy fail. Writing then
// means changing the user's config with nothing to roll back to — so it must abort.
class UnbackupableInstaller extends HookInstaller {
  protected backupSettings(): string | null {
    return null;
  }
}

function testWriteAbortsWhenBackupFails(): void {
  const { home, settingsPath } = tempSettingsHome();
  fs.writeFileSync(settingsPath, USER_CONFIG, "utf-8");

  const wrote = new UnbackupableInstaller(NO_CONTEXT, NO_LOG).registerHookInSettings();

  assert.equal(wrote, false, "no backup means no write");
  assert.equal(
    fs.readFileSync(settingsPath, "utf-8"),
    USER_CONFIG,
    "the config is untouched when we could not protect it first"
  );

  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - a failed backup aborts the write instead of proceeding unprotected");
}

function testMalformedSettingsRefusedOnDisk(): void {
  const { home, claudeDir, settingsPath } = tempSettingsHome();
  const garbage = '{ "model": "x", not json';
  fs.writeFileSync(settingsPath, garbage, "utf-8");

  const wrote = new HookInstaller(NO_CONTEXT, NO_LOG).registerHookInSettings();

  assert.equal(wrote, false, "malformed settings must not be written");
  assert.equal(fs.readFileSync(settingsPath, "utf-8"), garbage, "the bytes on disk are untouched");
  assert.deepEqual(backupsIn(claudeDir), [], "refusing early means no backup churn either");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - malformed settings.json is refused on disk, not overwritten");
}

function testAutomaticWriteIsBounded(): void {
  const { home, claudeDir, settingsPath } = tempSettingsHome();
  fs.mkdirSync(settingsPath); // unreadable → the automatic attempt fails

  const installer = new HookInstaller(NO_CONTEXT, NO_LOG);
  assert.equal(installer.syncSettingsIfNeeded(), false, "the one automatic attempt fails safely");

  // Repair the situation the way a user would, then confirm the automatic path
  // stays latched off (it must not retry on every window focus) while the
  // explicit Setup Hook action still works.
  fs.rmdirSync(settingsPath);
  fs.writeFileSync(settingsPath, USER_CONFIG, "utf-8");

  assert.equal(installer.syncSettingsIfNeeded(), false, "the automatic path is latched off after a failure");
  assert.equal(fs.readFileSync(settingsPath, "utf-8"), USER_CONFIG, "…and wrote nothing");
  assert.deepEqual(backupsIn(claudeDir), [], "…and took no backup");

  assert.equal(installer.registerHookInSettings(), true, "the explicit user action is still retryable");
  assert.ok(fs.readFileSync(settingsPath, "utf-8").includes("claudegate"), "Setup Hook installs the entry");

  fs.rmSync(home, { recursive: true, force: true });
  console.log("ok - the automatic settings write is attempted at most once and latches off");
}

void (async () => {
  await testHookSyncHeals();
  testUnreadableSettingsIsNeverOverwritten();
  testSymlinkedSettingsStaysASymlink();
  testVerificationFailureRestoresBackup();
  testWriteAbortsWhenBackupFails();
  testMalformedSettingsRefusedOnDisk();
  testAutomaticWriteIsBounded();
  console.log("all hookInstaller tests passed");
})();
