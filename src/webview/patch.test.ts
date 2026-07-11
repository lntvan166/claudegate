import * as assert from "assert";
import { parseFileDiff, tokenizeHunks } from "./patch";

// REGRESSION: the panel shipped with jsdiff's createTwoFilesPatch feeding
// react-diff-view's parseDiff, which either threw or produced zero hunks —
// blanking every file card below the toolbar. These cases assert the
// unidiff-based pipeline yields real, renderable hunks.

// modify: one changed line among context
{
  const d = parseFileDiff(
    "export function slug(s) {\n  return s.toLowerCase()\n}\n",
    'export function slug(s) {\n  return s.trim().toLowerCase()\n}\n'
  )!;
  assert.ok(d, "modify parses");
  assert.ok(d.hunks.length >= 1, "modify has hunks");
  const changes = d.hunks.reduce((n, h) => n + h.changes.length, 0);
  assert.ok(changes >= 3, "hunks carry the changed + context lines");
  console.log("ok - parseFileDiff: modify yields renderable hunks");
}

// new file: everything added
{
  const d = parseFileDiff("", 'export function ping() {\n  return "pong"\n}\n')!;
  assert.ok(d && d.hunks.length >= 1, "new-file parses with hunks");
  assert.ok(
    d.hunks[0].changes.every((c: any) => c.type === "insert"),
    "new file is all inserts"
  );
  console.log("ok - parseFileDiff: new file is all-insert hunks");
}

// no trailing newline on either side must still parse
{
  const d = parseFileDiff("a\nb", "a\nc")!;
  assert.ok(d && d.hunks.length >= 1, "no-trailing-newline parses");
  console.log("ok - parseFileDiff: no trailing newline still parses");
}

// multiple separated changes → multiple hunks
{
  const ctx = "ctx\n".repeat(10);
  const d = parseFileDiff("a\n" + ctx + "b\n", "A\n" + ctx + "B\n")!;
  assert.equal(d.hunks.length, 2, "two separated changes → two hunks");
  console.log("ok - parseFileDiff: separated changes yield separate hunks");
}

// identical content → null (caller renders the no-change fallback)
{
  assert.equal(parseFileDiff("same\n", "same\n"), null, "identical → null");
  console.log("ok - parseFileDiff: identical content returns null");
}

// tokenize: known grammar highlights (returns old/new rows); unknown grammar
// degrades to undefined instead of throwing (refractor v4 hast-root compat)
{
  const d = parseFileDiff("const a = 1\n", "const a = 2\n")!;
  const tokens: any = tokenizeHunks(d.hunks, "typescript");
  assert.ok(tokens && tokens.old && tokens.new, "typescript tokenizes into old/new rows");
  assert.equal(tokenizeHunks(d.hunks, "definitely-not-a-language"), undefined, "unknown grammar → undefined, no throw");
  console.log("ok - tokenizeHunks: highlights known grammars, degrades on unknown");
}

console.log("done");
