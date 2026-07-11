import { useState } from "preact/hooks";
import { DiffView } from "./DiffView";
import type { PayloadFile, DiffMode } from "./types";

interface Props {
  file: PayloadFile;
  diffMode: DiffMode;
  onKeep(path: string): void;
  onReject(path: string, reason?: string): void;
  onOpenNative(path: string): void;
}

export function FileCard({ file: f, diffMode, onKeep, onReject, onOpenNative }: Props) {
  const [collapsed, setCollapsed] = useState(f.status !== "pending");
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  return (
    <div class="cg-file">
      <div class="cg-fhead">
        <button class="cg-chev" aria-label={collapsed ? "Expand" : "Collapse"}
                onClick={() => setCollapsed(c => !c)}>{collapsed ? "▸" : "▾"}</button>
        {f.isProtected && <span class="cg-warn" title="Protected file">⚠</span>}
        <span class="cg-fn">{f.relPath}</span>
        <span class="cg-cnt"><span class="a">+{f.added}</span> <span class="d">−{f.removed}</span></span>
        <span class="cg-spacer" />
        <button class="cg-btn" onClick={() => onOpenNative(f.relPath)} title="Open in native diff">Open diff</button>
        {f.status === "pending"
          ? <>
              <button class="cg-btn undo" onClick={() => setNoteOpen(true)}>Reject</button>
              <button class="cg-btn keep" onClick={() => onKeep(f.relPath)}>Keep</button>
            </>
          : <span class={`cg-status ${f.status}`}>{f.status === "kept" ? "✓ kept" : "✗ rejected"}</span>}
      </div>

      {!collapsed && f.status === "pending" &&
        <DiffView before={f.before} after={f.after} relPath={f.relPath} viewType={diffMode} />}

      {f.status === "undone" && f.reason &&
        <div class="cg-note-shown">reason: {f.reason}</div>}

      {noteOpen &&
        <div class="cg-note">
          <span class="cg-note-label">Reject — note to AI (optional):</span>
          <input value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)}
                 placeholder="e.g. keep the old signature — still called by the batch job"
                 onKeyDown={(e) => {
                   if (e.key === "Enter") { onReject(f.relPath, note.trim() || undefined); setNoteOpen(false); }
                   if (e.key === "Escape") { setNoteOpen(false); setNote(""); }
                 }} />
          <button class="cg-btn" onClick={() => { setNoteOpen(false); setNote(""); }}>Cancel</button>
          <button class="cg-btn undo" onClick={() => { onReject(f.relPath, note.trim() || undefined); setNoteOpen(false); }}>Reject</button>
        </div>}
    </div>
  );
}
