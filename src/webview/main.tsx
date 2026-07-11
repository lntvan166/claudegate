import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { vscode } from "./vscodeApi";
import { Toolbar } from "./Toolbar";
import { DiffView } from "./DiffView";
import type { PayloadFile, RenderMessage, DiffMode } from "./types";
import "react-diff-view/style/index.css";
import "./theme.css";

function App() {
  const [files, setFiles] = useState<PayloadFile[]>([]);
  const [reviewed, setReviewed] = useState(0);
  const [total, setTotal] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [diffMode, setDiffMode] = useState<DiffMode>(
    (vscode.getState<{ diffMode?: DiffMode }>()?.diffMode) ?? "split"
  );

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data as RenderMessage;
      if (m?.type === "render") {
        setFiles(m.files); setReviewed(m.reviewedCount); setTotal(m.totalCount); setFeedbackText(m.feedbackText);
      }
    };
    window.addEventListener("message", onMsg);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const changeMode = (m: DiffMode) => { setDiffMode(m); vscode.setState({ diffMode: m }); };

  const counts = {
    kept: files.filter(f => f.status === "kept").length,
    rejected: files.filter(f => f.status === "undone").length,
    pending: files.filter(f => f.status === "pending").length,
  };

  if (!files.length) {
    return <div class="cg-empty-state">✓ All caught up — no pending changes to review.</div>;
  }

  return (
    <div class="cg">
      <Toolbar reviewedCount={reviewed} totalCount={total} counts={counts} diffMode={diffMode}
               onDiffMode={changeMode}
               onFeedback={() => setFeedbackOpen(o => !o)}
               onKeepAll={() => vscode.postMessage({ type: "keepAll" })}
               onRejectAll={() => vscode.postMessage({ type: "undoAll" })} />
      <div class="cg-files">
        {files.map(f => (
          <div class="cg-file" key={f.relPath}>
            <div class="cg-fhead">
              <span class="cg-fn">{f.relPath}</span>
              <span class="cg-cnt"><span class="a">+{f.added}</span> <span class="d">−{f.removed}</span></span>
              <span class="cg-spacer" />
              {f.status === "pending"
                ? <>
                    <button class="cg-btn undo" onClick={() => vscode.postMessage({ type: "undo", path: f.relPath })}>Reject</button>
                    <button class="cg-btn keep" onClick={() => vscode.postMessage({ type: "keep", path: f.relPath })}>Keep</button>
                  </>
                : <span class={`cg-status ${f.status}`}>{f.status === "kept" ? "✓ kept" : "✗ rejected"}</span>}
            </div>
            {f.status === "pending" && <DiffView before={f.before} after={f.after} relPath={f.relPath} viewType={diffMode} />}
          </div>
        ))}
      </div>
      {feedbackOpen && (
        <div class="cg-fb">
          <div class="cg-fbhead"><span>💬 Feedback to AI</span><span class="cg-spacer" />
            <button class="cg-btn" onClick={() => vscode.postMessage({ type: "copyFeedback" })}>📋 Copy</button></div>
          <pre class="cg-fbbody">{feedbackText}</pre>
        </div>
      )}
    </div>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
