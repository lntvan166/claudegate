import * as assert from "assert";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "no workspace folder open in the test host");
  return root;
}

export async function activateExtension(): Promise<void> {
  // We activate onStartupFinished, so whether the extension is up when a test
  // runs depends on load order. Never rely on it.
  const ext = vscode.extensions.getExtension("lntvan166.claudegate");
  assert.ok(ext, "claudegate not found in the test host");
  await ext.activate();
}

/** Poll until `probe` returns something truthy. Reports the last error so a
 *  genuine failure is legible instead of a bare timeout. Never sleep-and-assert:
 *  the extension reacts to fs watchers, coalescers and setTimeout, so a fixed
 *  sleep flakes in both directions. */
export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? ` — last error: ${lastError}` : ""}`);
}

// ── Session files ────────────────────────────────────────────────────────────
// The session JSON under the sandbox HOME is the model state, and it is the
// public-API-free way to assert what an action actually did. Hash algorithm
// mirrors SessionManager and hook.py: MD5 of the resolved path, lowercased on
// Windows.

export interface SessionShape {
  files: Record<string, unknown>;
  accepted: unknown[];
  rejected: Record<string, unknown>;
}

export function sessionFileFor(root: string): string {
  const resolved = path.resolve(root);
  const normalized = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash("md5").update(normalized).digest("hex");
  return path.join(process.env.HOME!, ".claudegate", "sessions", `${hash}.json`);
}

export function readSession(root: string): SessionShape | null {
  try {
    return JSON.parse(fs.readFileSync(sessionFileFor(root), "utf-8")) as SessionShape;
  } catch {
    return null;
  }
}

/** Every root that owns a session: the workspace plus each git worktree the demo
 *  fixture checked out under it. Mirrors manual-test-seed.py's demo layout. */
export function sessionRoots(): string[] {
  const root = workspaceRoot();
  const roots = [root];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules") continue;
      const child = path.join(dir, e.name);
      // A worktree working dir has .git as a FILE ("gitdir: …"), not a directory.
      const dotGit = path.join(child, ".git");
      if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) roots.push(child);
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return roots;
}

/** Total pending entries across the workspace and every worktree session. */
export function totalPendingOnDisk(): number {
  return sessionRoots().reduce(
    (n, r) => n + Object.keys(readSession(r)?.files ?? {}).length, 0);
}

export function totalAcceptedOnDisk(): number {
  return sessionRoots().reduce((n, r) => n + (readSession(r)?.accepted.length ?? 0), 0);
}

/** A session root that is a nested worktree (not the workspace itself). */
export function someWorktreeRoot(): string {
  const [, ...worktrees] = sessionRoots();
  assert.ok(worktrees.length > 0, "demo fixture produced no nested worktrees");
  return worktrees[0];
}

/** A pending file INSIDE a worktree. Ownership is resolved with
 *  worktreeRootForPath, whose pathIsUnder test is strictly-inside — a worktree
 *  root does not match itself. That is correct for every real caller: file rows
 *  and folder rows both live under the root, while the root itself renders as a
 *  WorktreeGroupItem that already carries its own SessionManager. So ownership
 *  must be asserted with a path inside, never the root. */
export function someWorktreeFile(): string {
  for (const root of sessionRoots().slice(1)) {
    const files = Object.keys(readSession(root)?.files ?? {});
    if (files.length > 0) return files.sort()[0];
  }
  assert.fail("demo fixture produced no pending file inside a worktree");
}

// ── Editor ───────────────────────────────────────────────────────────────────

/** Show `filePath` and wait until it is genuinely the active editor. The first
 *  showTextDocument after the host launches can resolve BEFORE the editor is
 *  active, so polling is required, not optional. */
export async function openEditor(filePath: string): Promise<void> {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filePath));
  await waitFor(`${path.basename(filePath)} to become the active editor`, () =>
    vscode.window.activeTextEditor?.document.uri.fsPath === filePath);
}

export function claudeGateDiffTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) =>
      t.input instanceof vscode.TabInputTextDiff &&
      t.input.original.scheme === "claudegate");
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

/** Make the Pending panel visible — reveal is a deliberate no-op while hidden. */
export async function showPendingPanel(): Promise<void> {
  await vscode.commands.executeCommand("workbench.view.extension.claudegate");
  await waitFor("the pending panel to report itself visible", async () => {
    const s = await revealState();
    return s.visible;
  });
}

// ── The read-only test seam (see extension.ts, gated on CLAUDEGATE_ITEST) ────

export interface RevealState { visible: boolean; selection: string[] }

export function revealState(): Thenable<RevealState> {
  return vscode.commands.executeCommand<RevealState>("claudegate._test.revealState");
}

export function chainTo(filePath: string): Thenable<string[]> {
  return vscode.commands.executeCommand<string[]>("claudegate._test.chainTo", filePath);
}

export interface Scopes {
  count: number; pending: string[]; accepted: number; rejected: number;
}

export function scopes(): Thenable<Scopes> {
  return vscode.commands.executeCommand<Scopes>("claudegate._test.scopes");
}

export function ownerIsPrimary(p: string): Thenable<boolean> {
  return vscode.commands.executeCommand<boolean>("claudegate._test.ownerIsPrimary", p);
}
