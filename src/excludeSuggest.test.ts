import * as assert from "assert";
import * as path from "path";
import { extensionGlob, folderGlob, describeGlob } from "./excludeSuggest";

const p = (...parts: string[]) => path.join(path.sep, ...parts);

// ── extensionGlob ───────────────────────────────────────────────────────────
{
  assert.strictEqual(extensionGlob(p("repo", "docs", "plan.md")), "**/*.md");
  assert.strictEqual(extensionGlob(p("repo", "a.test.ts")), "**/*.ts",
    "a compound name excludes by its LAST extension, which is what the user sees");
  // An extensionless file would otherwise produce `**/*`, hiding the entire
  // review. Refusing is the only safe answer.
  assert.strictEqual(extensionGlob(p("repo", "Makefile")), undefined, "no extension → no glob");
  assert.strictEqual(extensionGlob(p("repo", ".env")), undefined,
    "a dotfile has no extension by this rule — `**/*.env` would be wrong for `.env`");
  console.log("ok - extensionGlob refuses names that would produce an over-broad pattern");
}

// ── folderGlob ──────────────────────────────────────────────────────────────
{
  const root = p("repo");
  assert.strictEqual(folderGlob(p("repo", "docs", "plans", "x.md"), root), "**/docs/plans/**",
    "relative to the workspace root, so the pattern is portable and readable");
  assert.strictEqual(folderGlob(p("repo", "x.md"), root), undefined,
    "a file at the root would exclude the whole workspace — refuse");
  assert.strictEqual(folderGlob(p("elsewhere", "tmp", "x.md"), root), "**/tmp/**",
    "outside the root, fall back to the directory's own name");
  assert.strictEqual(folderGlob(p("repo", "docs", "x.md")), "**/docs/**",
    "with no root known, the directory name is all there is");
  console.log("ok - folderGlob stays relative to the workspace and refuses the root itself");
}

// ── describeGlob — the prompt must state the RULE ───────────────────────────
// The user is about to hide files from review. A raw glob is something to parse;
// a sentence is something to agree or disagree with.
{
  assert.strictEqual(describeGlob("**/*.md"), "every .md file");
  assert.strictEqual(describeGlob("**/docs/plans/**"), "everything under docs/plans/");
  assert.strictEqual(describeGlob("weird[pattern"), "weird[pattern", "anything else is shown verbatim");
  console.log("ok - describeGlob turns a pattern into a sentence for the prompt");
}
