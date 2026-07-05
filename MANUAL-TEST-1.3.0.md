# ClaudeGate 1.3.0 — Manual Test Checklist

## 0. Install the build

```bash
# In VS Code / Cursor:
#   Extensions panel > "..." menu > Install from VSIX...  > claudegate-1.3.0.vsix
# or from the CLI:
code --install-extension claudegate-1.3.0.vsix       # VS Code
cursor --install-extension claudegate-1.3.0.vsix     # Cursor
```
Reload the window after installing.

## 1. Seed the test workspace

```bash
python3 manual-test-seed.py          # creates ~/claudegate-manual-test + its session file
```
Then **File > Open Folder…** → `~/claudegate-manual-test`.

The seed creates 5 files (baseline vs. Claude-edited):

| File | Scenario | What it exercises |
|---|---|---|
| `src/auth.ts` | 3 hunks: modified line, added block, deleted line | native diff coloring + built-in "Revert Block" in the diff |
| `src/utils.ts` | 1 simple hunk | basic accept/reject |
| `src/newfeature.ts` | brand-new file (no baseline) | new-file badge, all-added gutter, reject-deletes |
| `.env` | protected file, 1 hunk | protected warning + sorted to top |
| `package-lock.json` | excluded lock file | must **NOT** appear in review |

> Re-seed anytime after accepting/rejecting: `python3 manual-test-seed.py --clean && python3 manual-test-seed.py`

The seeder can also **simulate Claude touching a file again** (fires the real hook exactly like Claude Code does), so you can test the review-log behaviour without a live Claude session:

```bash
python3 manual-test-seed.py --reedit src/auth.ts     # hook fires + writes a real change
python3 manual-test-seed.py --noop-edit src/auth.ts  # hook fires but leaves the file unchanged
```

---

## 2. Feature checks

### Pending panel + scope (default excludes / protected)
- [ ] The Claude Gate **Pending** panel lists `.env`, `src/auth.ts`, `src/newfeature.ts`, `src/utils.ts` — **4** files.
- [ ] `package-lock.json` is **absent** (default exclude working).
- [ ] `.env` shows a **protected** warning indicator and is **sorted to the top**.
- [ ] `src/newfeature.ts` is marked as a **new/created** file.
- [ ] Explorer shows the `!` pending badge on the 4 in-scope files (not on `package-lock.json`).

### Clean normal editor (no custom gutter)
- [ ] Open `src/auth.ts` **directly** (not the diff). There are **no** ClaudeGate green/blue/red gutter marks and **no** "Revert this change" CodeLens — only git's own gutter (if the file is under git) and the normal editor. *(The custom gutter + per-hunk CodeLens were removed.)*

### Per-block revert lives in the diff (native)
- [ ] Open the ClaudeGate diff for `src/auth.ts` (click the row / Open Diff). The diff shows the 3 changes with VS Code's **native** coloring.
- [ ] Hover a changed block in the diff gutter → VS Code's built-in **"Revert Block"** arrow appears; clicking it reverts just that block on the editable (right) side. Save to persist. *(This is VS Code's own diff feature, not a ClaudeGate command.)*

### Review All Pending — reuse & focus (fixed)
- [ ] Trigger **Claude Gate: Review All Pending** (Pending-panel action or Command Palette) → a **multi-file diff** tab opens with every in-scope pending change (not the lock file).
- [ ] Trigger it **again** → **no second tab** is created; the existing "Claude Gate: Pending (N)" tab is reused and **focused** (fresh content).
- [ ] Accept/reject one file, then trigger again → the single tab reappears with the **updated** count/files.

### Accept / Reject basics
- [ ] Accept `src/utils.ts` → moves to Accepted; disk keeps Claude's version.
- [ ] Reject `.env` → moves to Rejected; disk restored to baseline (SECRET_KEY line gone). Re-apply restores it.
- [ ] Reject `src/newfeature.ts` (a new file) → moves to Rejected and is **deleted from disk**. Re-apply from the Rejected panel re-creates it.

### Review log — Accepted history, Rejected latest, no phantom rows (the big one)
This is the new model. Each panel means exactly what it says.

*Accepted persists when Claude re-edits:*
- [ ] **Accept** `src/auth.ts` → it leaves Pending and appears in the **Accepted** panel. Click its Accepted row → the diff shows what you accepted (baseline → accepted content).
- [ ] Simulate Claude editing it again: `python3 manual-test-seed.py --reedit src/auth.ts`
- [ ] `src/auth.ts` now appears in **Pending** showing **only the new change**, **and its Accepted row is still there** (A→B preserved). ✅ the original bug is fixed.
- [ ] Accept the new pending change → the **Accepted** panel now lists **two** rows for `auth.ts` (the full log); each row opens its own diff.

*No phantom rows from no-op / failed edits:*
- [ ] Accept `src/utils.ts`. Then: `python3 manual-test-seed.py --noop-edit src/utils.ts`
- [ ] **No empty Pending row** appears for `utils.ts`, and its **Accepted row is untouched**. ✅ (a failed/no-op edit can no longer wipe an accepted decision or leave an empty diff)

*Rejected keeps the latest per file:*
- [ ] Reject `.env` → it appears in **Rejected**; the row diffs baseline → the discarded `SECRET_KEY` change.
- [ ] Re-edit and reject again: `python3 manual-test-seed.py --reedit .env`, then reject the new `.env` pending row → the Rejected panel still shows **one** `.env` row (the latest replaced the previous).

*Undo:*
- [ ] On an Accepted row → **Revert to Pending** puts it back in Pending. On a Rejected row → **Re-apply** writes Claude's version back and returns it to Pending.

*Bulk paths ignore no-op entries:*
- [ ] After a `--noop-edit`, **Accept All** / **Review All Pending** do **not** pick up the no-op file (no empty diff, no phantom accepted record).

### File watcher off by default (changed)
- [ ] Command Palette → confirm **`Claude Gate: Enable File Watcher`** exists.
- [ ] `claudegate.fileWatcher.enabled` defaults to **false** (Settings shows unchecked). *(Real-agent path: only needed for Cursor Composer / Codex.)*

### Group by session (folded-in)
- [ ] Run **Claude Gate: Toggle Group by Session** (or set `claudegate.groupBySession` = true) → files group into **session-A** (`auth.ts`, `utils.ts`) and **session-B** (`newfeature.ts`, `.env`).

---

## 3. Cleanup

```bash
python3 manual-test-seed.py --clean   # removes the workspace + its session file
```
