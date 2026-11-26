#!/usr/bin/env python3
"""ClaudeGate capture audit: PostToolUse / PostToolUseFailure hook for Bash.

hook.py (PreToolUse) leaves `~/.claudegate/audit/inflight/<tool_use_id>.json`
for every Bash call: when it started, its cwd, and the paths it captured. After
the call this script walks the registered roots that call could have touched,
finds the files whose mtime falls inside the call's window, classifies each one
and appends one line per innermost root to `~/.claudegate/audit/<hash>.jsonl`.

Classes of a changed file, in the order they are tested:
  captured    named in the record's `captured`
  covered     pending in a session at scan time (an earlier capture, a
              Write/Edit landing mid-command, a concurrent call)
  outOfScope  binary (a NUL in the first 8 KiB), or ignored by git
  implicit    the command contains an implicit op (git pull, make, ...)
  missed      none of the above; `uncertain` instead when the call ran longer
              than UNCERTAIN_AFTER_MS, since the user may have saved meanwhile
A captured path that did not change is a `phantom`.

Blind spots, by design: an mtime scan cannot see deletions, nor moves and copies
that keep mtimes (`mv`, `cp -p`, `rsync -a`).

Stdlib only, synchronous, and fail open: whatever happens, exit 0 with empty
stdout and stderr. It must NOT import hook.py — process start plus scan has to
stay around 30 ms — so the exclude matcher and binary test are copies.
"""

import hashlib
import json
import os
import re
import sys
import time

PRUNE = frozenset({".git", "node_modules", "vendor", "target", "dist", "build", ".venv"})
WINDOW_SLACK_MS = 1000          # mtime >= startedAt - this counts as changed
UNCERTAIN_AFTER_MS = 10000      # a longer call makes its misses uncertain
SCAN_BUDGET_MS = 150            # hard stop for the walk
DEADLINE_EVERY = 256            # entries between deadline checks
ROTATE_BYTES = 5_000_000
COMMAND_HEAD = 120
GIT_TIMEOUT_S = 1.0
BINARY_SNIFF = 8192
_TOOL_USE_ID_RE = re.compile(r"[A-Za-z0-9_.-]{1,128}")


def _cg_dir() -> str:
    # Resolved per call, not at import: tests run this in-process with a temp HOME.
    return os.path.join(os.path.expanduser("~"), ".claudegate")


def _norm(p: str) -> str:
    return os.path.normcase(os.path.abspath(p))


def _hash(root: str) -> str:
    """Same as the session files: md5 of normcase(abspath(root))."""
    return hashlib.md5(_norm(root).encode()).hexdigest()


def _inside(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _load_json(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def registered_roots() -> list:
    data = _load_json(os.path.join(_cg_dir(), "workspace-roots.json"))
    if not isinstance(data, list):
        return []
    return sorted({_norm(r) for r in data if isinstance(r, str) and r})


# ── exclude matcher (copy of hook.py's port of src/excludeMatcher.ts) ────────
# hooks/tests/exclude_cases.json runs against this copy too.

def glob_to_regex(glob: str) -> str:
    g = glob.replace("\\", "/")
    out = []
    i = 0
    while i < len(g):
        c = g[i]
        if c == "*":
            if i + 1 < len(g) and g[i + 1] == "*":
                out.append(".*")
                i += 1
                if i + 1 < len(g) and g[i + 1] == "/":
                    i += 1
            else:
                out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c in "\\^$.|+()[]{}":
            out.append("\\" + c)
        else:
            out.append(c)
        i += 1
    return "".join(out)


def compile_globs(globs: list) -> list:
    patterns = []
    for glob in globs or []:
        if not isinstance(glob, str):
            continue
        try:
            patterns.append(re.compile(glob_to_regex(glob)))
        except re.error:
            continue
    return patterns


def excluded_by(file_path: str, root: str, patterns: list) -> bool:
    if not patterns:
        return False
    abs_path = file_path.replace("\\", "/")
    root_s = root.replace("\\", "/").rstrip("/")
    candidates = [abs_path]
    if root_s and abs_path.startswith(root_s + "/"):
        rel = abs_path[len(root_s) + 1:]
        parts = [p for p in rel.split("/") if p]
        candidates.append(rel)
        candidates.extend("/".join(parts[:i]) for i in range(1, len(parts)))
    return any(p.fullmatch(c) for p in patterns for c in candidates)


def is_excluded(file_path: str, root: str, globs: list) -> bool:
    return excluded_by(file_path, root, compile_globs(globs))


def load_excludes() -> dict:
    """{normalized root: compiled patterns}; empty on any trouble."""
    data = _load_json(os.path.join(_cg_dir(), "excludes.json"))
    out = {}
    if isinstance(data, dict):
        for root, globs in data.items():
            if isinstance(root, str) and isinstance(globs, list):
                pats = compile_globs(globs)
                if pats:
                    out[_norm(root)] = pats
    return out


# ── scan ─────────────────────────────────────────────────────────────────────

def scan_changed(roots, since_ms: int, budget_ms: float = SCAN_BUDGET_MS,
                 all_roots=None, excludes=None):
    """Regular files under `roots` whose mtime >= since_ms, and whether the
    walk ran out of budget. Iterative, never follows symlinks, never crosses
    a filesystem boundary, prunes PRUNE and excluded directories. A root nested
    inside another given root is covered by the outer walk. `all_roots` (the
    registered roots) decides which exclude globs apply below each directory:
    those of the innermost registered root, as in hook.py."""
    deadline = time.perf_counter() + budget_ms / 1000.0
    since_ns = int(since_ms) * 1_000_000
    excludes = excludes or {}
    registered = set(all_roots or ()) | {_norm(r) for r in roots}
    tops = sorted({_norm(r) for r in roots})
    tops = [r for r in tops if not any(o != r and _inside(r, o) for o in tops)]
    changed: list = []
    seen = 0
    for top in tops:
        try:
            top_st = os.stat(top)
        except OSError:
            continue
        dev = top_st.st_dev
        stack = [(top, top, excludes.get(top))]
        while stack:
            d, ex_root, pats = stack.pop()
            try:
                it = os.scandir(d)
            except OSError:
                continue
            with it:
                for entry in it:
                    seen += 1
                    if seen % DEADLINE_EVERY == 0 and time.perf_counter() > deadline:
                        return changed, True
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in PRUNE:
                                continue
                            p = entry.path
                            np = os.path.normcase(p)
                            sub_root, sub_pats = ex_root, pats
                            if np in registered:
                                sub_root, sub_pats = np, excludes.get(np)
                            elif sub_pats and excluded_by(p, ex_root, sub_pats):
                                continue
                            if entry.stat(follow_symlinks=False).st_dev != dev:
                                continue
                            stack.append((p, sub_root, sub_pats))
                        elif entry.is_file(follow_symlinks=False):
                            if entry.stat(follow_symlinks=False).st_mtime_ns >= since_ns:
                                if not (pats and excluded_by(entry.path, ex_root, pats)):
                                    changed.append(entry.path)
                    except OSError:
                        continue
    return changed, False


def is_binary(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return b"\0" in f.read(BINARY_SNIFF)
    except OSError:
        return False


def _git_toplevel(path: str):
    """Nearest ancestor of `path` holding a `.git` (dir or file). Pure
    filesystem: no subprocess."""
    cur = os.path.dirname(path)
    while True:
        if os.path.exists(os.path.join(cur, ".git")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


def git_ignored(paths: list) -> set:
    """The subset of `paths` git ignores. One `git check-ignore` per toplevel.
    Outside git, or without git, nothing is ignored: the walk already applied
    the fixed prune list."""
    by_top: dict = {}
    for p in paths:
        top = _git_toplevel(p)
        if top is not None:
            by_top.setdefault(top, []).append(p)
    if not by_top:
        return set()
    import subprocess   # lazily: most calls never get here, and it costs ~4 ms
    ignored: set = set()
    for top, files in by_top.items():
        rels = [os.path.relpath(f, top) for f in files]
        try:
            r = subprocess.run(["git", "-C", top, "check-ignore", "--stdin", "-z"],
                               input="\0".join(rels) + "\0", capture_output=True,
                               text=True, timeout=GIT_TIMEOUT_S)
        except (OSError, subprocess.SubprocessError, ValueError):
            continue
        if r.returncode not in (0, 1):
            continue
        back = dict(zip(rels, files))
        for rel in r.stdout.split("\0"):
            if rel in back:
                ignored.add(back[rel])
    return ignored


# ── sessions ─────────────────────────────────────────────────────────────────

class Sessions:
    """Pending entries, looked up lazily. A path's session is keyed by the hash
    of a registered root or of a nested worktree dir — both are ancestors — so
    every ancestor up to the outermost registered root containing it is tried."""

    def __init__(self, roots: list):
        self.roots = roots
        self.dir = os.path.join(_cg_dir(), "sessions")
        try:
            self.names = set(os.listdir(self.dir))
        except OSError:
            self.names = set()
        self.cache: dict = {}

    def _files(self, name: str) -> dict:
        if name not in self.cache:
            data = _load_json(os.path.join(self.dir, name))
            files = data.get("files") if isinstance(data, dict) else None
            self.cache[name] = files if isinstance(files, dict) else {}
        return self.cache[name]

    def entry(self, path: str):
        if not self.names:
            return None
        np = _norm(path)
        outer = None
        for r in self.roots:
            if _inside(np, r) and (outer is None or len(r) < len(outer)):
                outer = r
        if outer is None:
            return None
        cur = os.path.dirname(np)
        while True:
            name = _hash(cur) + ".json"
            if name in self.names:
                e = self._files(name).get(path)
                if e is None and np != path:
                    e = self._files(name).get(np)
                if isinstance(e, dict) and e.get("reviewStatus", "pending") == "pending":
                    return e
            if cur == outer or len(cur) <= len(outer):
                break
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        return None


# ── classify ─────────────────────────────────────────────────────────────────

def innermost_root(path: str, roots: list):
    np = _norm(path)
    best = None
    for r in roots:
        if _inside(np, r) and (best is None or len(r) > len(best)):
            best = r
    return best


def _new_bucket() -> dict:
    return {"missed": [], "uncertain": [], "phantom": [], "covered": 0,
            "implicit": 0, "outOfScope": 0, "captured": 0}


def classify(changed: list, record: dict, roots: list, since_ms: int,
             duration_ms: int, sessions=None, ignored_fn=git_ignored) -> dict:
    """{innermost root: bucket} for every root with a change or a phantom."""
    captured = list(dict.fromkeys(p for p in record.get("captured") or [] if isinstance(p, str)))
    cap_set = set(captured)
    implicit = record.get("implicit") is True
    long_call = duration_ms > UNCERTAIN_AFTER_MS
    sessions = sessions if sessions is not None else Sessions(roots)
    since_ns = int(since_ms) * 1_000_000
    buckets: dict = {}

    def bucket(path):
        r = innermost_root(path, roots)
        if r is None:
            return None
        return buckets.setdefault(r, _new_bucket())

    changed_set = set(changed)
    # Captured paths are judged by their own stat, not by the walk, so a
    # truncated walk cannot turn a real capture into a phantom.
    for p in captured:
        b = bucket(p)
        if b is None:
            continue
        try:
            did_change = os.lstat(p).st_mtime_ns >= since_ns
        except FileNotFoundError:
            # Gone after the call: a deletion, unless the capture recorded a
            # file that never existed (originalContent null) and still doesn't.
            e = sessions.entry(p)
            did_change = e is not None and e.get("originalContent") is not None
        except OSError:
            did_change = p in changed_set
        if did_change:
            b["captured"] += 1
        else:
            b["phantom"].append(p)

    rest = []
    for p in changed:
        if p in cap_set:
            continue
        if sessions.entry(p) is not None:
            b = bucket(p)
            if b is not None:
                b["covered"] += 1
            continue
        rest.append(p)

    binary = {p for p in rest if is_binary(p)}
    ignored = ignored_fn([p for p in rest if p not in binary]) if rest else set()
    for p in rest:
        b = bucket(p)
        if b is None:
            continue
        if p in binary or p in ignored:
            b["outOfScope"] += 1
        elif implicit:
            b["implicit"] += 1
        elif long_call:
            b["uncertain"].append(p)
        else:
            b["missed"].append(p)

    for b in buckets.values():
        for k in ("missed", "uncertain", "phantom"):
            b[k].sort()
    return {r: b for r, b in buckets.items()
            if b["phantom"] or b["captured"] or b["covered"] or b["outOfScope"]
            or b["implicit"] or b["missed"] or b["uncertain"]}


# ── output ───────────────────────────────────────────────────────────────────

def rotate(path: str, max_bytes: int = ROTATE_BYTES) -> None:
    try:
        if os.path.getsize(path) >= max_bytes:
            os.replace(path, path + ".1")
    except OSError:
        pass


def append_line(path: str, obj: dict) -> None:
    rotate(path)
    data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def select_roots(record: dict, roots: list) -> list:
    """Registered roots that contain the call's cwd or a captured path."""
    anchors = []
    cwd = record.get("cwd")
    if isinstance(cwd, str) and cwd:
        anchors.append(_norm(cwd))
    anchors.extend(_norm(p) for p in record.get("captured") or [] if isinstance(p, str))
    return [r for r in roots if any(_inside(a, r) for a in anchors)]


def run(payload: dict, now_ms: int = None, budget_ms: float = SCAN_BUDGET_MS) -> None:
    tool_use_id = payload.get("tool_use_id")
    if not isinstance(tool_use_id, str) or not _TOOL_USE_ID_RE.fullmatch(tool_use_id) \
            or tool_use_id in (".", ".."):
        return
    if payload.get("tool_name", "Bash") != "Bash":
        return
    audit_dir = os.path.join(_cg_dir(), "audit")
    rec_path = os.path.join(audit_dir, "inflight", tool_use_id + ".json")
    record = _load_json(rec_path)
    try:
        os.remove(rec_path)
    except OSError:
        pass
    if not isinstance(record, dict) or not isinstance(record.get("startedAt"), int):
        return

    started = record["startedAt"]
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    duration = max(0, now_ms - started)
    since = started - WINDOW_SLACK_MS
    roots = registered_roots()
    scan_roots = select_roots(record, roots)
    if not scan_roots:
        return
    changed, truncated = scan_changed(scan_roots, since, budget_ms, roots, load_excludes())
    buckets = classify(changed, record, roots, since, duration)
    if not buckets:
        return

    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    command = tool_input.get("command") if isinstance(tool_input.get("command"), str) else ""
    session_id = record.get("sessionId")
    if not isinstance(session_id, str):
        session_id = payload.get("session_id") if isinstance(payload.get("session_id"), str) else None
    from datetime import datetime, timezone
    at = datetime.now(timezone.utc).isoformat()
    os.makedirs(audit_dir, exist_ok=True)
    for root, b in sorted(buckets.items()):
        line = {
            "at": at,
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "event": payload.get("hook_event_name") if isinstance(payload.get("hook_event_name"), str) else None,
            "durationMs": duration,
            "cwd": record.get("cwd"),
            "root": root,
            "commandHead": command[:COMMAND_HEAD],
            "background": record.get("background") is True,
            "truncated": truncated,
            "missed": b["missed"],
            "uncertain": b["uncertain"],
            "phantom": b["phantom"],
            "covered": b["covered"],
            "implicit": b["implicit"],
            "outOfScope": b["outOfScope"],
            "captured": b["captured"],
        }
        try:
            append_line(os.path.join(audit_dir, _hash(root) + ".jsonl"), line)
        except OSError:
            continue


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    if isinstance(payload, dict):
        run(payload)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        pass
    os._exit(0)
