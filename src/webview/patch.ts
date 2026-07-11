// Pure diff-parsing pipeline for the review webview: two strings in,
// react-diff-view hunks out. Kept vscode-free so it runs under plain node
// for regression tests.
//
// IMPORTANT: react-diff-view's parseDiff wraps gitdiff-parser, which parses
// GIT-style diff text. jsdiff's createTwoFilesPatch output ("Index:" header,
// "===" separator, tab-suffixed ---/+++ lines) is NOT compatible — feeding it
// in either throws ("Cannot read properties of undefined (reading 'changes')")
// or silently yields zero hunks, which blanked the whole panel. The documented
// pairing is unidiff's formatLines(diffLines(...)), which emits text
// gitdiff-parser accepts. Regression-locked by src/webview/patch.test.ts.
import { parseDiff, tokenize } from "react-diff-view";
import type { DiffType } from "react-diff-view";
import { diffLines, formatLines } from "unidiff";
import { refractor } from "refractor";

export interface ParsedFileDiff {
  type: DiffType;
  hunks: any[];
}

// Build react-diff-view hunks from before/after content. Returns null when
// there is nothing renderable (no changes, or the parse failed) — callers
// show a fallback instead of crashing the render tree.
export function parseFileDiff(before: string, after: string): ParsedFileDiff | null {
  try {
    const text = formatLines(diffLines(before, after), { context: 3 });
    if (!text.trim()) return null; // identical content → no diff text
    const files = parseDiff(text, { nearbySequences: "zip" });
    const file = files[0];
    if (!file || !file.hunks || file.hunks.length === 0) return null;
    return { type: file.type, hunks: file.hunks };
  } catch {
    return null; // never let a parse failure take down the panel render
  }
}

// refractor v4 returns a hast root ({type:"root", children:[…]}) from
// highlight(), while react-diff-view v3's tokenize iterates the return value
// directly (the refractor v3 contract). Adapt by unwrapping .children.
const refractorCompat = {
  ...refractor,
  highlight: (code: string, lang: string) => {
    const root: any = (refractor as any).highlight(code, lang);
    return root && Array.isArray(root.children) ? root.children : root;
  },
};

// Tokenize hunks for syntax highlighting; undefined (plain rendering) when the
// grammar is unknown or tokenization fails — highlighting is best-effort.
export function tokenizeHunks(hunks: any[], language: string): unknown {
  try {
    return tokenize(hunks, { highlight: true, language, refractor: refractorCompat });
  } catch {
    return undefined;
  }
}
