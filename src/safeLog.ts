import * as vscode from "vscode";

/**
 * Wrap an OutputChannel so writing to it can never throw.
 *
 * VS Code closes the extension host's IPC channel *before* running `dispose()`
 * on an extension's subscriptions, so any `appendLine` reached from a teardown
 * path throws `Error: Channel has been closed`. Observed in the wild:
 *
 *   Error: Channel has been closed
 *     at Object.appendLine (extensionHostProcess.js)
 *     at Je.detach   (WorktreeSessionRegistry.detach)
 *     at Je.dispose  (WorktreeSessionRegistry.dispose)
 *
 * That surfaced to the user as a red "error occurred when disposing the
 * subscriptions" notification, and — worse — the throw escaped mid-loop, so the
 * worktree managers after the failing one never got `stopWatching()`: one leaked
 * `fs.watch` handle and reconcile timer each, on every window reload.
 *
 * Logging is diagnostics. It must never be able to break teardown, and it must
 * never be able to break a hot path either, so every method is guarded rather
 * than just `appendLine`.
 */
export function failSoftLog(channel: vscode.OutputChannel): vscode.OutputChannel {
  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* the channel is gone; there is nowhere left to report that */
    }
  };
  return {
    get name() {
      return channel.name;
    },
    append: (value: string) => guard(() => channel.append(value)),
    appendLine: (value: string) => guard(() => channel.appendLine(value)),
    replace: (value: string) => guard(() => channel.replace(value)),
    clear: () => guard(() => channel.clear()),
    // `show` is overloaded (preserveFocus / column+preserveFocus); forward the
    // arguments verbatim rather than picking one signature.
    show: (...args: unknown[]) =>
      guard(() => (channel.show as (...a: unknown[]) => void)(...args)),
    hide: () => guard(() => channel.hide()),
    dispose: () => guard(() => channel.dispose()),
  } as vscode.OutputChannel;
}
