// Runs OUTSIDE VS Code, in plain node. Never import "vscode" here — the module
// only exists inside the extension host.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..", "..");   // out/integration -> repo root
  const extensionTestsPath = path.resolve(__dirname, "index.js");

  // Throwaway HOME. Without this the suite reads your real ~/.claudegate
  // sessions and acceptAll accepts your real pending changes, against your real
  // files. os.homedir() reads $HOME on POSIX and %USERPROFILE% on Windows, so
  // both must be passed through.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claudegate-itest-home-"));

  // --demo builds a go.work layout with REAL git worktrees and one session file
  // per worktree, which is the only fixture that exercises the worktree scopes.
  // It forces its own workspace path under $HOME, so seeding with the sandbox
  // HOME puts both the workspace and its sessions inside the sandbox.
  const seed = spawnSync("python3", [path.join(repoRoot, "manual-test-seed.py"), "--demo"], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (seed.status !== 0) {
    throw new Error(`manual-test-seed.py --demo failed (exit ${seed.status})`);
  }
  const workspace = path.join(home, "claudegate-demo");
  if (!fs.existsSync(workspace)) {
    throw new Error(`seed did not create ${workspace}`);
  }

  await runTests({
    vscodeExecutablePath: await downloadAndUnzipVSCode("stable"),
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath,
    launchArgs: [
      workspace,
      "--disable-extensions",        // every OTHER extension; ours still loads
      "--disable-workspace-trust",
      "--no-sandbox",                // headless CI / xvfb
    ],
    extensionTestsEnv: {
      HOME: home,
      USERPROFILE: home,
      CLAUDEGATE_ITEST: "1",         // gates the read-only test command seam
      CLAUDEGATE_ITEST_WS: workspace,
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
