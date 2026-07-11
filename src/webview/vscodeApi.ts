// Thin typed wrapper around the webview host bridge. acquireVsCodeApi() may be
// called only once per webview, so we capture it here and share the singleton.
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T = unknown>(state: T): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();
