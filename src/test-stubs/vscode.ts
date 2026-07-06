// Minimal hand-written vscode stub so vscode-light modules (SessionManager) can
// be unit-tested. esbuild aliases "vscode" to this file for the test bundle;
// real @types/vscode is still used for typechecking.
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(data: T): void { for (const l of [...this.listeners]) l(data); }
  dispose(): void { this.listeners = []; }
}
export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void { this.callOnDispose(); }
}
export const window = {
  showErrorMessage: (..._args: unknown[]): undefined => undefined,
  showWarningMessage: (..._args: unknown[]): undefined => undefined,
  showInformationMessage: (..._args: unknown[]): undefined => undefined,
};
// No open folders → isInWorkspace() returns true, so a pre-populated session
// loads without pruneOutOfWorkspaceEntries throwing (which would mask the
// reload path under test).
export const workspace = {
  workspaceFolders: undefined as readonly { uri: { fsPath: string } }[] | undefined,
};
