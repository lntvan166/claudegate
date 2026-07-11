import { render } from "preact";
import { vscode } from "./vscodeApi";

function App() {
  return <div style="padding:12px">Claude Gate review — webview toolchain OK</div>;
}

const root = document.getElementById("app");
if (root) render(<App />, root);
vscode.postMessage({ type: "ready" });
