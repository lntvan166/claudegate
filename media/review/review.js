// @ts-nocheck
// Review queue: a per-file summary of the pending batch. The actual diff opens
// in VS Code's native diff editor (message "openNative") — this view never
// renders diff content itself.
const vscode = acquireVsCodeApi();
let state = { model: { files: [], reviewedCount: 0, totalCount: 0 }, feedbackText: "", feedbackOpen: false };
const ui = { reasonOpen: {}, reasonText: {}, focusedIdx: 0, focusReason: false }; // preserved across renders

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function fileRow(file, idx) {
  const rp = file.relPath;
  const dir = rp.includes("/") ? rp.slice(0, rp.lastIndexOf("/") + 1) : "";
  const base = rp.slice(dir.length);
  const focused = idx === ui.focusedIdx;
  const badges = [file.added ? `<span class="badge add">+${file.added}</span>` : "",
                  file.removed ? `<span class="badge del">−${file.removed}</span>` : ""].join(" ");
  let right = "";
  if (file.status === "pending") {
    right = `<button class="btn undo" data-undo="${esc(rp)}" aria-label="Undo ${esc(rp)}">Undo</button>` +
            `<button class="btn keep" data-keep="${esc(rp)}" aria-label="Keep ${esc(rp)}">Keep</button>`;
  } else {
    right = `<span class="status ${file.status}">${file.status === "kept" ? "✓ kept" : "✗ undone"}</span>`;
  }
  const statusWord = file.status === "pending" ? "pending" : file.status;
  const aria = `${rp}, ${file.added || 0} added, ${file.removed || 0} removed, ${statusWord}${file.isProtected ? ", protected file" : ""}. Enter to open diff.`;
  const row = `<div class="frow" role="button" tabindex="${focused ? 0 : -1}" aria-label="${esc(aria)}" data-open="${esc(rp)}">` +
    `${file.isProtected ? '<span class="warn" title="Protected file" aria-hidden="true">⚠</span>' : ""}` +
    `<span class="fname">${esc(base)}</span><span class="fpath">${esc(dir)}</span>${badges}` +
    `<div class="spacer"></div><span class="factions">${right}</span></div>`;

  let extra = "";
  if (file.status === "undone" && file.reason) extra += `<div class="note">reason: ${esc(file.reason)}</div>`;
  if (ui.reasonOpen[rp]) {
    extra += `<div class="reason"><span class="rl">Reverting to original. Add a reason to feed back to AI (optional):</span>` +
      `<div class="rrow"><input data-reason-input="${esc(rp)}" placeholder="e.g. don't drop legacyDropoff — still called by the batch job" value="${esc(ui.reasonText[rp] ?? "")}" />` +
      `<button class="btn" data-reason-cancel="${esc(rp)}">Cancel</button>` +
      `<button class="btn undo" data-reason-confirm="${esc(rp)}">Revert</button></div></div>`;
  }
  return `<div class="file${focused ? " focused" : ""}" data-idx="${idx}">${row}${extra}</div>`;
}

function render() {
  const m = state.model;
  const app = document.getElementById("app");
  if (!m.files.length) {
    app.innerHTML = `<div class="empty-state">All changes reviewed 🎉<span class="hint">Nothing left to review — you can close this panel.</span></div>`;
    return;
  }
  if (ui.focusedIdx >= m.files.length) ui.focusedIdx = m.files.length - 1;
  if (ui.focusedIdx < 0) ui.focusedIdx = 0;
  const scrollX = window.scrollX, scrollY = window.scrollY;
  const pct = m.totalCount ? Math.round((m.reviewedCount / m.totalCount) * 100) : 0;
  const hint = `<span class="kbdhint" title="Keyboard shortcuts"><kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open diff · <kbd>a</kbd> keep · <kbd>x</kbd> undo</span>`;
  const toolbar = `<div class="toolbar"><span class="title">All Changes</span>` +
    `<span class="progress">${m.reviewedCount} of ${m.totalCount} reviewed</span><div class="progbar"><i></i></div>${hint}` +
    `<div class="spacer"></div>` +
    `<button class="btn" data-fb-toggle title="Toggle AI feedback panel" aria-label="Toggle AI feedback panel" aria-expanded="${state.feedbackOpen}">💬 Feedback to AI</button>` +
    `<button class="btn undo" data-undo-all>Undo All</button><button class="btn keep" data-keep-all>Keep All</button></div>`;
  const rows = m.files.map((f, i) => fileRow(f, i)).join("");
  const fb = `<div class="fbpanel ${state.feedbackOpen ? "" : "hidden"}"><div class="fbhdr"><span>💬 Feedback to AI</span>` +
    `<div class="spacer"></div><button class="btn" data-fb-copy title="Copy feedback to clipboard" aria-label="Copy feedback to clipboard">📋 Copy</button></div>` +
    `<div class="fbbody">${esc(state.feedbackText)}</div></div>`;
  app.innerHTML = toolbar + `<div id="files">${rows}</div>` + fb;
  const bar = document.querySelector(".progbar > i");
  if (bar) bar.style.width = pct + "%";
  window.scrollTo(scrollX, scrollY);
  if (ui.focusReason) {
    const inp = document.querySelector("[data-reason-input]");
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    ui.focusReason = false;
  } else {
    const el = document.querySelector(".file.focused > .frow");
    if (el) el.scrollIntoView({ block: "nearest" });
  }
}

function focusFileOf(el) {
  const fileEl = el.closest(".file");
  if (fileEl && fileEl.dataset.idx !== undefined) ui.focusedIdx = Number(fileEl.dataset.idx);
}

function openNative(rp) { vscode.postMessage({ type: "openNative", path: rp }); }

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-keep],[data-undo],[data-open],[data-keep-all],[data-undo-all],[data-fb-toggle],[data-fb-copy],[data-reason-cancel],[data-reason-confirm]");
  if (!t) return;
  focusFileOf(t);
  if (t.dataset.keep) vscode.postMessage({ type: "keep", path: t.dataset.keep });
  else if (t.dataset.undo) { ui.reasonOpen[t.dataset.undo] = true; ui.focusReason = true; render(); }
  else if (t.dataset.reasonCancel) { delete ui.reasonOpen[t.dataset.reasonCancel]; delete ui.reasonText[t.dataset.reasonCancel]; render(); }
  else if (t.dataset.reasonConfirm) { const inp = document.querySelector(`[data-reason-input="${CSS.escape(t.dataset.reasonConfirm)}"]`); vscode.postMessage({ type: "undo", path: t.dataset.reasonConfirm, reason: inp ? inp.value.trim() : "" }); delete ui.reasonOpen[t.dataset.reasonConfirm]; delete ui.reasonText[t.dataset.reasonConfirm]; }
  else if (t.dataset.open) openNative(t.dataset.open);
  else if (t.hasAttribute("data-keep-all")) vscode.postMessage({ type: "keepAll" });
  else if (t.hasAttribute("data-undo-all")) vscode.postMessage({ type: "undoAll" });
  else if (t.hasAttribute("data-fb-toggle")) { state.feedbackOpen = !state.feedbackOpen; render(); }
  else if (t.hasAttribute("data-fb-copy")) vscode.postMessage({ type: "copyFeedback" });
});

document.addEventListener("input", (e) => {
  const t = e.target.closest("[data-reason-input]");
  if (!t) return;
  ui.reasonText[t.dataset.reasonInput] = t.value;
});

// Keyboard review: navigate the queue and decide without the mouse. Global
// keydown, except while typing in the reason input.
document.addEventListener("keydown", (e) => {
  const el = e.target;
  if (el && el.matches && el.matches("input, textarea")) {
    const p = el.dataset && el.dataset.reasonInput;
    if (p && e.key === "Enter") { vscode.postMessage({ type: "undo", path: p, reason: el.value.trim() }); delete ui.reasonOpen[p]; delete ui.reasonText[p]; e.preventDefault(); }
    else if (p && e.key === "Escape") { delete ui.reasonOpen[p]; delete ui.reasonText[p]; render(); e.preventDefault(); }
    return;
  }
  const files = state.model.files;
  if (!files.length) return;
  const idx = Math.min(Math.max(ui.focusedIdx, 0), files.length - 1);
  const f = files[idx];
  switch (e.key) {
    case "ArrowDown": case "j":
      ui.focusedIdx = Math.min(idx + 1, files.length - 1); render(); e.preventDefault(); break;
    case "ArrowUp": case "k":
      ui.focusedIdx = Math.max(idx - 1, 0); render(); e.preventDefault(); break;
    case "Enter": case " ":
      openNative(f.relPath); e.preventDefault(); break;
    case "a":
      if (f.status === "pending") vscode.postMessage({ type: "keep", path: f.relPath });
      e.preventDefault(); break;
    case "x":
      if (f.status === "pending") { ui.reasonOpen[f.relPath] = true; ui.focusReason = true; render(); }
      e.preventDefault(); break;
    case "Escape":
      if (Object.keys(ui.reasonOpen).length) { for (const k of Object.keys(ui.reasonOpen)) delete ui.reasonOpen[k]; render(); e.preventDefault(); }
      break;
  }
});

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "render") {
    state.model = msg.model; state.feedbackText = msg.feedbackText;
    render();
  }
});

vscode.postMessage({ type: "ready" });
