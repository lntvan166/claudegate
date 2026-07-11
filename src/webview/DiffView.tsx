import { useMemo } from "preact/hooks";
import { Diff, Hunk } from "react-diff-view";
import { languageFromPath } from "./language";
import { parseFileDiff, tokenizeHunks } from "./patch";

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
    // parseFileDiff owns the text→hunks pipeline (unidiff → parseDiff) and
    // never throws — a null here means nothing renderable, not a crash.
    const parsed = parseFileDiff(before ?? "", after ?? "");
    if (!parsed) return { kind: "nochange" as const };
    const tokens = tokenizeHunks(parsed.hunks, languageFromPath(relPath));
    return { kind: "diff" as const, file: parsed, tokens };
  }, [before, after, relPath]);

  if (body.kind === "missing") return <div class="cg-empty">No preview (file is missing or binary).</div>;
  if (body.kind === "nochange") return <div class="cg-empty">No changes to review.</div>;

  return (
    <Diff viewType={viewType} diffType={body.file.type} hunks={body.file.hunks} tokens={body.tokens as any}>
      {(hunks: any[]) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
    </Diff>
  );
}
