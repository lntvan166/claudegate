# Review Claude's changes

When Claude edits files, they appear in the **Pending** panel of the Claude Gate sidebar.

- **Click a file** to open it in VS Code's native diff editor — original on the left, Claude's version on the right.
- **Accept** (`✓`) keeps the change; **Reject** (`✗`) restores the original.
- Use **Review All Pending** (the multi-diff icon on the Pending panel) to review every change — including files in nested git worktrees — in one pass.
- With a diff focused, `Ctrl/Cmd+Enter` accepts and `Ctrl/Cmd+Backspace` rejects.

Accepted and rejected changes are logged in their own panels, and you can revert or re-apply any decision later.
