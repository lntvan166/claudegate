import * as assert from "assert";
import * as path from "path";
import { pathIsUnder } from "./workspaceScope";

// pathIsUnder: the containment check behind isInWorkspace / out-of-workspace
// pruning. The case-insensitive branch guards the Windows data-loss bug where a
// drive-letter/dir case mismatch made a real pending file look out-of-workspace.
{
  const sep = path.sep;
  const root = `${sep}home${sep}me${sep}repo`;
  const file = `${root}${sep}src${sep}a.ts`;

  // basic containment
  assert.equal(pathIsUnder(file, root, false), true, "file under root");
  assert.equal(pathIsUnder(`${sep}home${sep}me${sep}other${sep}b.ts`, root, false), false, "sibling not under root");
  // the root dir itself is not "strictly inside" itself
  assert.equal(pathIsUnder(root, root, false), false, "root is not under itself");
  // a sibling that merely shares a name prefix is not inside (needs a separator)
  assert.equal(pathIsUnder(`${root}-backup${sep}x.ts`, root, false), false, "prefix-sibling not under root");

  // case sensitivity: a case-drifted path is OUT when case-sensitive (the bug)
  // but correctly IN when case-insensitive (Windows behavior).
  const drift = `${root.toUpperCase()}${sep}src${sep}a.ts`;
  assert.equal(pathIsUnder(drift, root, false), false, "case-sensitive: drift excluded");
  assert.equal(pathIsUnder(drift, root, true), true, "case-insensitive: drift included (no false prune)");

  console.log("ok - pathIsUnder (containment + Windows case-folding)");
}
