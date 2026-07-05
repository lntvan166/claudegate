# Deferred: per-file Accept/Reject buttons inside the Review All Pending multi-diff

**Date:** 2026-07-05
**Status:** Deferred (shelved by user after research)

## Goal
Put ✓ Accept / ✗ Reject buttons in **each file's header row** inside the "Review All Pending" multi-file diff (next to the per-file "Open File" icon), like the screenshot the user shared.

## What was tried and ruled out
- **CodeLens at the top of each file** (`vscode.languages.registerCodeLensProvider`): works, but VS Code hides CodeLens in diff editors unless `diffEditor.codeLens` is enabled (default **false**), so it's invisible by default. Rejected (needs a global setting; user disliked the look).
- **`multiDiffEditor/resource/title` menu on the `vscode.changes` multi-diff**: the menu id is real (built-in git uses it), **but only populates for SCM-backed multi-diffs**. Our multi-diff is opened via `vscode.changes` (a plain resource list), which exposes no per-resource context — a probe with `when: resourceScheme == 'file'` showed nothing. Confirmed against the installed app bundle + git's own contribution (`when: scmProvider == git`).
- **Backing our multi-diff with a custom multi-diff source** (to get per-resource context): the multi-diff source-resolver API is **proposed/unavailable** in stable `@types/vscode` (v1.120) — unshippable to the marketplace.

## The only stable path (and why it was shelved)
Drive the review through the **SCM API** (`vscode.scm.createSourceControl` + resource groups). That gives:
- Native inline ✓/✗ per file in a Source Control panel (`scm/resourceState/context`, group `inline`) — **no gutter**. But that's a panel list, **not** buttons in the multi-diff headers.
- The SCM "Open Changes" **multi-diff with per-file title buttons** (`multiDiffEditor/resource/title` gated on `scmProvider`) — but it requires a **QuickDiffProvider** to supply each diff's "before", and QuickDiff also drives VS Code's **dirty-diff gutter** (which the user removed earlier for clashing with git). There is no per-provider way to suppress that gutter (`scm.diffDecorations` is global).

So the literal ask (buttons in the multi-diff headers) is only achievable via SCM + QuickDiff, which reintroduces the gutter. The user chose to **defer** rather than accept the gutter tradeoff.

## If revisited
- Reconsider once VS Code stabilizes a multi-diff source-resolver API (would allow per-resource actions on a non-SCM multi-diff without QuickDiff/gutter), or
- Accept the SCM + QuickDiff gutter (thinner than the removed custom gutter; controllable via `scm.diffDecorations`), or
- Ship the no-gutter SCM panel (per-file inline ✓/✗ in a Source Control view; click a file to open its diff) as an alternative review surface.

Current shipped behavior (kept): the `vscode.changes` "Review All Pending" multi-diff auto-refreshes on accept/reject; per-file accept/reject is done from the Pending panel row actions.
