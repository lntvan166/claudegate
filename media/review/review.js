// @ts-nocheck
const vscode = acquireVsCodeApi();
let state = { model: { files: [], reviewedCount: 0, totalCount: 0 }, diffMode: "split", feedbackText: "", feedbackOpen: false };
const ui = { collapsed: {}, reasonOpen: {} }; // per-relPath UI state, preserved across renders

function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function splitRows(pieces) {
  // Build aligned left/right rows from the unified piece stream.
  const rows = []; let buf = { del: [], add: [] };
  const flush = () => {
    const n = Math.max(buf.del.length, buf.add.length);
    for (let i = 0; i < n; i++) rows.push({ left: buf.del[i] || null, right: buf.add[i] || null });
    buf = { del: [], add: [] };
  };
  for (const p of pieces) {
    if (p.type === "fold") { flush(); rows.push({ fold: p.hidden }); continue; }
    if (p.kind === "context") { flush(); rows.push({ left: p, right: p, ctx: true }); }
    else if (p.kind === "del") buf.del.push(p);
    else buf.add.push(p);
  }
  flush();
  return rows;
}

function diffHtml(file) {
  if (file.missing) return `<div class="fold">(file missing on disk)</div>`;
  if (file.noChange) return `<div class="fold">(no changes to review)</div>`;
  if (state.diffMode === "unified") {
    return `<div class="side">` + file.pieces.map((p) => {
      if (p.type === "fold") return `<div class="fold">⋯ ${p.hidden} hidden lines ⋯</div>`;
      const num = p.kind === "del" ? p.oldNum : p.newNum;
      return `<div class="row ${p.kind === "context" ? "" : p.kind}"><span class="gut">${num ?? ""}</span><span class="src">${esc(p.text)}</span></div>`;
    }).join("") + `</div>`;
  }
  const rows = splitRows(file.pieces);
  const cell = (c, side) => {
    if (!c) return `<div class="row empty"><span class="gut"></span><span class="src"></span></div>`;
    if (c.fold !== undefined) return `<div class="fold">⋯ ${c.fold} hidden lines ⋯</div>`;
    const p = side === "left" ? c.left : c.right;
    if (!p) return `<div class="row empty"><span class="gut"></span><span class="src"></span></div>`;
    const num = side === "left" ? p.oldNum : p.newNum;
    const kind = c.ctx ? "" : p.kind;
    return `<div class="row ${kind}"><span class="gut">${num ?? ""}</span><span class="src">${esc(p.text)}</span></div>`;
  };
  const left = rows.map((r) => r.fold !== undefined ? `<div class="fold">⋯ ${r.fold} hidden lines ⋯</div>` : cell(r, "left")).join("");
  const right = rows.map((r) => r.fold !== undefined ? `<div class="fold">&nbsp;</div>` : cell(r, "right")).join("");
  return `<div class="split"><div class="side left"><div class="sidehdr">Original</div>${left}</div><div class="side"><div class="sidehdr">Current (Claude's edit)</div>${right}</div></div>`;
}

function fileHtml(file) {
  const dir = file.relPath.includes("/") ? file.relPath.slice(0, file.relPath.lastIndexOf("/") + 1) : "";
  const base = file.relPath.slice(dir.length);
  const collapsed = ui.collapsed[file.relPath] ?? (file.status !== "pending");
  const badges = [file.added ? `<span class="badge add">+${file.added}</span>` : "", file.removed ? `<span class="badge del">−${file.removed}</span>` : ""].join(" ");
  let actions = "";
  if (file.status === "pending") actions = `<div class="factions"><button class="btn undo" data-undo="${esc(file.relPath)}">Undo</button><button class="btn keep" data-keep="${esc(file.relPath)}">Keep</button></div>`;
  else actions = `<span class="status ${file.status}">${file.status === "kept" ? "✓ kept" : "✗ undone"}</span>`;
  const head = `<div class="fhead" data-toggle="${esc(file.relPath)}"><span class="chev">${collapsed ? "▸" : "▾"}</span>${file.isProtected ? '<span class="warn">⚠</span>' : ""}<span class="fname">${esc(base)}</span><span class="fpath">${esc(dir)}</span>${badges}<div class="spacer"></div>${actions}</div>`;
  let body = "";
  if (!collapsed) body += diffHtml(file);
  if (ui.reasonOpen[file.relPath]) {
    body += `<div class="reason"><span class="rl">Reverting to original. Add a reason to feed back to AI (optional):</span><div class="rrow"><input data-reason-input="${esc(file.relPath)}" placeholder="e.g. don't drop legacyDropoff — still called by the batch job" /><button class="btn" data-reason-cancel="${esc(file.relPath)}">Cancel</button><button class="btn undo" data-reason-confirm="${esc(file.relPath)}">Revert</button></div></div>`;
  }
  return `<div class="file">${head}${body}</div>`;
}

function render() {
  const m = state.model;
  const app = document.getElementById("app");
  if (!m.files.length) { app.innerHTML = `<div class="empty-state">All changes reviewed 🎉</div>`; return; }
  const pct = m.totalCount ? Math.round((m.reviewedCount / m.totalCount) * 100) : 0;
  const toolbar = `<div class="toolbar"><span class="title">All Changes</span><span class="progress">${m.reviewedCount} of ${m.totalCount} reviewed</span><div class="progbar"><i style="width:${pct}%"></i></div><div class="spacer"></div><div class="seg"><button class="${state.diffMode === "split" ? "on" : ""}" data-mode="split">Split</button><button class="${state.diffMode === "unified" ? "on" : ""}" data-mode="unified">Unified</button></div><button class="btn" data-fb-toggle>💬 Feedback to AI</button><button class="btn undo" data-undo-all>Undo All</button><button class="btn keep" data-keep-all>Keep All</button></div>`;
  const files = m.files.map(fileHtml).join("");
  const fb = `<div class="fbpanel ${state.feedbackOpen ? "" : "hidden"}"><div class="fbhdr"><span>💬 Feedback to AI</span><div class="spacer"></div><button class="btn" data-fb-copy>📋 Copy</button></div><div class="fbbody">${esc(state.feedbackText)}</div></div>`;
  app.innerHTML = toolbar + `<div id="files">${files}</div>` + fb;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-keep],[data-undo],[data-toggle],[data-mode],[data-keep-all],[data-undo-all],[data-fb-toggle],[data-fb-copy],[data-reason-cancel],[data-reason-confirm]");
  if (!t) return;
  if (t.dataset.keep) vscode.postMessage({ type: "keep", path: t.dataset.keep });
  else if (t.dataset.undo) { ui.reasonOpen[t.dataset.undo] = true; ui.collapsed[t.dataset.undo] = ui.collapsed[t.dataset.undo] ?? false; render(); }
  else if (t.dataset.reasonCancel) { delete ui.reasonOpen[t.dataset.reasonCancel]; render(); }
  else if (t.dataset.reasonConfirm) { const inp = document.querySelector(`[data-reason-input="${CSS.escape(t.dataset.reasonConfirm)}"]`); vscode.postMessage({ type: "undo", path: t.dataset.reasonConfirm, reason: inp ? inp.value.trim() : "" }); delete ui.reasonOpen[t.dataset.reasonConfirm]; }
  else if (t.dataset.toggle) { ui.collapsed[t.dataset.toggle] = !(ui.collapsed[t.dataset.toggle] ?? false); render(); }
  else if (t.dataset.mode) { state.diffMode = t.dataset.mode; vscode.postMessage({ type: "setDiffMode", mode: t.dataset.mode }); render(); }
  else if (t.hasAttribute("data-keep-all")) vscode.postMessage({ type: "keepAll" });
  else if (t.hasAttribute("data-undo-all")) vscode.postMessage({ type: "undoAll" });
  else if (t.hasAttribute("data-fb-toggle")) { state.feedbackOpen = !state.feedbackOpen; render(); }
  else if (t.hasAttribute("data-fb-copy")) vscode.postMessage({ type: "copyFeedback" });
});

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "render") {
    state.model = msg.model; state.diffMode = msg.diffMode; state.feedbackText = msg.feedbackText;
    render();
  }
});

vscode.postMessage({ type: "ready" });
