import * as assert from "assert";
import { failSoftLog } from "./safeLog";

{
  // Normal operation: everything is forwarded verbatim.
  const calls: string[] = [];
  const raw = {
    name: "Claude Gate",
    append: (v: string) => calls.push(`append:${v}`),
    appendLine: (v: string) => calls.push(`appendLine:${v}`),
    replace: (v: string) => calls.push(`replace:${v}`),
    clear: () => calls.push("clear"),
    show: (...a: unknown[]) => calls.push(`show:${JSON.stringify(a)}`),
    hide: () => calls.push("hide"),
    dispose: () => calls.push("dispose"),
  } as any;

  const log = failSoftLog(raw);
  assert.equal(log.name, "Claude Gate", "name is forwarded");
  log.appendLine("hello");
  log.append("x");
  log.replace("y");
  log.clear();
  log.show(true);
  log.hide();
  log.dispose();
  assert.deepEqual(
    calls,
    ["appendLine:hello", "append:x", "replace:y", "clear", "show:[true]", "hide", "dispose"],
    "every method reaches the underlying channel with its arguments"
  );
  console.log("ok - failSoftLog forwards to a healthy channel");
}

{
  // Regression: during extension-host teardown the channel throws
  // "Channel has been closed". That escaped WorktreeSessionRegistry.detach() and
  // aborted dispose() mid-loop, leaking an fs.watch handle per un-detached
  // worktree and showing the user a red error notification.
  const dead = {
    name: "Claude Gate",
    append() { throw new Error("Channel has been closed"); },
    appendLine() { throw new Error("Channel has been closed"); },
    replace() { throw new Error("Channel has been closed"); },
    clear() { throw new Error("Channel has been closed"); },
    show() { throw new Error("Channel has been closed"); },
    hide() { throw new Error("Channel has been closed"); },
    dispose() { throw new Error("Channel has been closed"); },
  } as any;

  const log = failSoftLog(dead);
  assert.doesNotThrow(() => log.appendLine("still writing during teardown"));
  assert.doesNotThrow(() => log.append("x"));
  assert.doesNotThrow(() => log.replace("y"));
  assert.doesNotThrow(() => log.clear());
  assert.doesNotThrow(() => log.show());
  assert.doesNotThrow(() => log.hide());
  assert.doesNotThrow(() => log.dispose());
  console.log("ok - failSoftLog swallows 'Channel has been closed' on every method");
}
