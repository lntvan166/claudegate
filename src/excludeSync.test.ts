import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ExcludeMatcher } from "./excludeMatcher";
import { activeGlobs, persistExcludes, EXCLUDES_FILENAME } from "./excludeSync";

// 1. Parity: the shared cases hook.py's port is tested against
//    (hooks/tests/test_exclude.py). A disagreement means a file is hidden but
//    still captured, or captured but never shown.
{
  const data = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "hooks", "tests", "exclude_cases.json"), "utf-8"),
  ) as { root: string; cases: Array<{ globs: string[]; path: string; excluded: boolean }> };
  for (const c of data.cases) {
    const m = new ExcludeMatcher();
    m.reload(Object.fromEntries(c.globs.map((g) => [g, true])), data.root);
    assert.equal(m.isExcluded(c.path), c.excluded, `${JSON.stringify(c.globs)} vs ${c.path}`);
  }
  console.log(`ok - ExcludeMatcher agrees with the ${data.cases.length} shared exclude cases`);
}

// 2. Only globs mapped to true are handed to the hook.
{
  assert.deepEqual(activeGlobs({ "**/a": true, "**/b": false }), ["**/a"]);
  assert.deepEqual(activeGlobs(undefined), []);
  console.log("ok - activeGlobs keeps only active patterns");
}

// 3. persistExcludes merges per root, drops roots gone from disk, and clears a
//    root whose exclude set became empty.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudegate-excl-"));
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "claudegate-ws-a-"));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "claudegate-ws-b-"));
  const file = path.join(dir, EXCLUDES_FILENAME);
  fs.writeFileSync(file, JSON.stringify({ "/no/such/root": ["**/x"] }));

  persistExcludes(dir, rootA, ["**/go.sum"]);
  persistExcludes(dir, rootB, [".superpowers/sdd"]);
  let data = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(data, { [rootA]: ["**/go.sum"], [rootB]: [".superpowers/sdd"] }, "merged, stale root dropped");

  persistExcludes(dir, rootA, []);
  data = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(data, { [rootB]: [".superpowers/sdd"] }, "empty set removes the root");

  // Malformed file → start fresh rather than throw.
  fs.writeFileSync(file, "{not json");
  persistExcludes(dir, rootA, ["**/a"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { [rootA]: ["**/a"] });
  assert.deepEqual(fs.readdirSync(dir), [EXCLUDES_FILENAME], "no temp file left behind");

  for (const d of [dir, rootA, rootB]) fs.rmSync(d, { recursive: true, force: true });
  console.log("ok - persistExcludes merges windows, prunes stale roots, fails soft");
}
