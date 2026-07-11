import { useMemo } from "preact/hooks";
import { parseDiff, Diff, Hunk, tokenize } from "react-diff-view";
import { createTwoFilesPatch } from "diff";
import { refractor } from "refractor";
import { languageFromPath } from "./language";

interface Props {
  before: string | null;
  after: string | null;
  relPath: string;
  viewType: "unified" | "split";
}

export function DiffView({ before, after, relPath, viewType }: Props) {
  const body = useMemo(() => {
    if (after === null) return { kind: "missing" as const };
    if (before === after) return { kind: "nochange" as const };
    // Build a git-style unified patch, then parse it for react-diff-view.
    const patch = createTwoFilesPatch(relPath, relPath, before ?? "", after ?? "", "", "");
    const parsed = parseDiff(patch, { nearbySequences: "zip" });
    if (!parsed.length) return { kind: "nochange" as const };
    const file = parsed[0];
    let tokens;
    try {
      tokens = tokenize(file.hunks, {
        highlight: true,
        language: languageFromPath(relPath),
        refractor,
      });
    } catch {
      tokens = undefined; // unknown grammar → render without highlighting
    }
    return { kind: "diff" as const, file, tokens };
  }, [before, after, relPath]);

  if (body.kind === "missing") return <div class="cg-empty">No preview (file is missing or binary).</div>;
  if (body.kind === "nochange") return <div class="cg-empty">No changes to review.</div>;

  return (
    <Diff viewType={viewType} diffType={body.file.type} hunks={body.file.hunks} tokens={body.tokens}>
      {(hunks: any[]) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
    </Diff>
  );
}
