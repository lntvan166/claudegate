import * as assert from "assert";
import { languageFromPath } from "./language";

assert.equal(languageFromPath("src/a.ts"), "typescript");
assert.equal(languageFromPath("a.tsx"), "typescript");
assert.equal(languageFromPath("pkg.json"), "json");
assert.equal(languageFromPath("hook.py"), "python");
assert.equal(languageFromPath("README"), "text");
assert.equal(languageFromPath("weird.xyz"), "text");
console.log("ok - languageFromPath maps extensions to refractor ids");
