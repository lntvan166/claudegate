import assert from "node:assert";
import { globToRegExp, ExcludeMatcher, DEFAULT_EXCLUDES, DEFAULT_PROTECTED } from "./excludeMatcher";

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log("ok -", name);
  } catch (e) {
    console.error("FAIL -", name);
    console.error(e);
    process.exitCode = 1;
  }
}

run("globToRegExp **/*.pb.go matches at any depth, not plain .go", () => {
  const re = globToRegExp("**/*.pb.go");
  assert.ok(re.test("api/user.pb.go"));
  assert.ok(re.test("/Users/x/api/user.pb.go"));
  assert.ok(!re.test("api/user.go"));
});

run("globToRegExp **/dist/** matches dist dir, not distinct", () => {
  const re = globToRegExp("**/dist/**");
  assert.ok(re.test("pkg/dist/index.js"));
  assert.ok(re.test("/repo/pkg/dist/index.js"));
  assert.ok(!re.test("pkg/distinct/index.js"));
});

run("globToRegExp ? matches exactly one non-separator char", () => {
  const re = globToRegExp("a?.ts");
  assert.ok(re.test("ab.ts"));
  assert.ok(!re.test("abc.ts"));
  assert.ok(!re.test("a/.ts"));
});

run("globToRegExp escapes regex metacharacters literally", () => {
  const re = globToRegExp("a+b.ts");
  assert.ok(re.test("a+b.ts"));
  assert.ok(!re.test("aaab.ts"));
});

run("ExcludeMatcher empty map excludes nothing", () => {
  const m = new ExcludeMatcher();
  m.reload({});
  assert.equal(m.isExcluded("/x/y.pb.go"), false);
  m.reload(undefined);
  assert.equal(m.isExcluded("/x/y.pb.go"), false);
});

run("ExcludeMatcher honors active(true) and ignores inactive(false)", () => {
  const m = new ExcludeMatcher();
  m.reload({ "**/*.pb.go": true, "**/skip/**": false });
  assert.equal(m.isExcluded("/x/y.pb.go"), true);
  assert.equal(m.isExcluded("/x/skip/z.ts"), false);
  assert.equal(m.isExcluded("/x/y.ts"), false);
});

run("ExcludeMatcher matches workspace-relative path via root", () => {
  const m = new ExcludeMatcher();
  m.reload({ "dist/**": true }, "/repo");
  assert.equal(m.isExcluded("/repo/dist/a.js"), true);
  assert.equal(m.isExcluded("/other/dist/a.js"), false);
});

run("ExcludeMatcher folder pattern excludes everything inside it", () => {
  const m = new ExcludeMatcher();
  m.reload({ ".superpowers/sdd": true }, "/repo");
  assert.equal(m.isExcluded("/repo/.superpowers/sdd/task-1.md"), true);
  assert.equal(m.isExcluded("/repo/.superpowers/sdd"), true); // the folder path itself
  assert.equal(m.isExcluded("/repo/.superpowers/other.md"), false); // sibling not excluded
});

run("ExcludeMatcher **/dir folder pattern excludes contents at any depth", () => {
  const m = new ExcludeMatcher();
  m.reload({ "**/dist": true }, "/repo");
  assert.equal(m.isExcluded("/repo/pkg/dist/bundle.js"), true);
  assert.equal(m.isExcluded("/repo/pkg/src/main.ts"), false);
});

run("default excludes match lock/minified/map/node_modules, not source", () => {
  const m = new ExcludeMatcher();
  m.reload(Object.fromEntries(DEFAULT_EXCLUDES.map((g) => [g, true])), "/repo");
  assert.equal(m.isExcluded("/repo/pkg/package-lock.json"), true);
  assert.equal(m.isExcluded("/repo/a/b.min.js"), true);
  assert.equal(m.isExcluded("/repo/dist/app.js.map"), true);
  assert.equal(m.isExcluded("/repo/node_modules/foo/index.js"), true);
  assert.equal(m.isExcluded("/repo/src/main.ts"), false);
});

run("a user false entry deactivates a default", () => {
  const m = new ExcludeMatcher();
  const map = Object.fromEntries(DEFAULT_EXCLUDES.map((g) => [g, true]));
  map["**/go.sum"] = false;
  m.reload(map, "/repo");
  assert.equal(m.isExcluded("/repo/go.sum"), false);
  assert.equal(m.isExcluded("/repo/yarn.lock"), true);
});

run("default protected globs match secrets, not normal files", () => {
  const m = new ExcludeMatcher();
  m.reload(Object.fromEntries(DEFAULT_PROTECTED.map((g) => [g, true])), "/repo");
  assert.equal(m.isExcluded("/repo/.env"), true);
  assert.equal(m.isExcluded("/repo/config/.env.local"), true);
  assert.equal(m.isExcluded("/repo/keys/server.pem"), true);
  assert.equal(m.isExcluded("/repo/README.md"), false);
});

console.log("done");
