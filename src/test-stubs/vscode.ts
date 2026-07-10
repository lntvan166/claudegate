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
  activeTextEditor: undefined as unknown,
  tabGroups: { all: [] as unknown[] },
};
// No open folders → isInWorkspace() returns true, so a pre-populated session
// loads without pruneOutOfWorkspaceEntries throwing (which would mask the
// reload path under test).
export const workspace = {
  workspaceFolders: undefined as readonly { uri: { fsPath: string } }[] | undefined,
  // claudegate reads booleans like groupBySession; returning the default keeps
  // tree providers on their default (non-grouped) rendering under test.
  getConfiguration: (_section?: string) => ({
    get: <T>(_key: string, def?: T): T | undefined => def,
  }),
  asRelativePath: (p: string): string => p,
};

// ── TreeView / UI surface ─────────────────────────────────────────────────
// Enough of the TreeItem / Uri / theming API to instantiate the sidebar tree
// providers (reviewPanel.ts) and drive getChildren() headlessly.
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }

export class TreeItem {
  label: unknown;
  collapsibleState: TreeItemCollapsibleState;
  resourceUri: unknown;
  description: unknown;
  tooltip: unknown;
  contextValue: unknown;
  iconPath: unknown;
  command: unknown;
  constructor(label: unknown, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
export class ThemeColor { constructor(public id: string) {} }
export class MarkdownString { constructor(public value = "") {} }
export class Range { constructor(..._args: unknown[]) {} }
export enum TextEditorRevealType { InCenter = 2 }
// Referenced by reviewPanel.closeDiffEditor's `instanceof` check; exported so
// bundling tree-provider code against this stub stays warning-free.
export class TabInputTextDiff { constructor(public original?: unknown, public modified?: unknown) {} }

export class Uri {
  private constructor(
    public scheme: string,
    public fsPath: string,
    public path: string,
    public query = ""
  ) {}
  static file(p: string): Uri { return new Uri("file", p, p); }
  with(change: { scheme?: string; query?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, this.fsPath, this.path, change.query ?? this.query);
  }
}

// Records executeCommand calls so a test can assert command wiring if needed.
export const executedCommands: Array<{ command: string; args: unknown[] }> = [];
export const commands = {
  executeCommand: (command: string, ...args: unknown[]) => {
    executedCommands.push({ command, args });
    return Promise.resolve(undefined);
  },
  registerCommand: (_id: string, _cb: (...a: unknown[]) => unknown) => new Disposable(() => {}),
};
