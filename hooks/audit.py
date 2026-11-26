#!/usr/bin/env python3
"""ClaudeGate capture audit: PostToolUse / PostToolUseFailure hook for Bash.

hook.py (PreToolUse) leaves `~/.claudegate/audit/inflight/<tool_use_id>.json`
for every Bash call: when it started, its cwd, and the paths it captured. After
the call this script walks the registered roots that call could have touched,
finds the files whose mtime falls inside the call's window, classifies each one
and appends one line per innermost root to `~/.claudegate/audit/<hash>.jsonl`.

Classes of a changed file, in the order they are tested:
  captured    named in the record's `captured` or `alreadyPending`
  covered     pending in a session at scan time (an earlier capture, a
              Write/Edit landing mid-command, a concurrent call)
  outOfScope  ignored by git, or binary by capture's own test (a NUL, or not
              valid UTF-8)
  tooLarge    over MAX_CAPTURE_BYTES, which hook.py never captures
  implicit    the command contains an implicit op (git pull, make, ...)
  missed      none of the above; `uncertain` instead when the call ran longer
              than UNCERTAIN_AFTER_MS (the user may have saved meanwhile), or
              when git ran out of time for it
A newly captured path that did not change is a `phantom`. An already-pending
one that did not change is nothing: naming it cost no session write.

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

PRUNE = frozenset({".git", "node_modules", "vendor", "target", "dist", "build", ".venv",
                   ".vscode-test", ".next", "out", "coverage", ".cache", "__pycache__",
                   ".pytest_cache", ".mypy_cache", ".gradle", ".turbo"})
WINDOW_SLACK_MS = 1000          # mtime >= startedAt - this counts as changed
UNCERTAIN_AFTER_MS = 10000      # a longer call makes its misses uncertain
SCAN_BUDGET_MS = 150            # hard stop for the walk
RUN_BUDGET_MS = 1000            # hard stop for the whole run (walk + git)
MAX_CAPTURE_BYTES = 2 * 1024 * 1024   # hook.py does not capture larger files
LIST_CAP = 200                  # entries kept per list in a line
NESTED_ROOTS_CAP = 5            # registered roots inside cwd also scanned
DEADLINE_EVERY = 256            # entries between deadline checks
ROTATE_BYTES = 5_000_000
COMMAND_HEAD = 120
GIT_TIMEOUT_S = 0.3             # cap per git check-ignore call
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
                 all_roots=None, excludes=None, deadline=None, skip_paths=None):
    """Regular files under `roots` whose mtime >= since_ms, and whether the
    walk ran out of budget. Iterative, never follows symlinks, never crosses
    a filesystem boundary, prunes PRUNE, excluded directories and
    `skip_paths` (by default ~/.claudegate, so the audit never sees its own
    writes). A root nested inside another given root is covered by the outer
    walk. `all_roots` (the registered roots) decides which exclude globs apply
    below each directory: those of the innermost registered root, as in
    hook.py. `deadline` (perf_counter seconds) caps the budget further."""
    stop = time.perf_counter() + budget_ms / 1000.0
    if deadline is not None:
        stop = min(stop, deadline)
    since_ns = int(since_ms) * 1_000_000
    excludes = excludes or {}
    skip = {_norm(p) for p in (skip_paths if skip_paths is not None else [_cg_dir()])}
    registered = set(all_roots or ()) | {_norm(r) for r in roots}
    tops = sorted({_norm(r) for r in roots})
    tops = [r for r in tops if not any(o != r and _inside(r, o) for o in tops)]
    changed: list = []
    seen = 0
    for top in tops:
        if top in skip:
            continue
        try:
            dev = os.stat(top).st_dev
        except OSError:
            continue
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
                    if seen % DEADLINE_EVERY == 0 and time.perf_counter() > stop:
                        return changed, True
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in PRUNE:
                                continue
                            p = entry.path
                            np = os.path.normcase(p)
                            if np in skip:
                                continue
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
    """Capture's test, on a sample: hook.py skips a file whose strict UTF-8
    decode fails. A NUL also counts. Only the first 8 KiB are read, so a file
    that turns invalid later is still judged text."""
    import codecs
    try:
        with open(path, "rb") as f:
            sample = f.read(BINARY_SNIFF)
    except OSError:
        return False
    if b"\0" in sample:
        return True
    try:
        codecs.getincrementaldecoder("utf-8")("strict").decode(
            sample, final=len(sample) < BINARY_SNIFF)
    except UnicodeDecodeError:
        return True
    return False


_toplevel_cache: dict = {}


def _git_toplevel(path: str):
    """Nearest ancestor of `path` holding a `.git` (dir or file), memoised per
    directory. Pure filesystem: no subprocess."""
    start = os.path.dirname(path)
    walked = []
    cur = start
    top = None
    while True:
        if cur in _toplevel_cache:
            top = _toplevel_cache[cur]
            break
        walked.append(cur)
        if os.path.exists(os.path.join(cur, ".git")):
            top = cur
            break
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    for d in walked:
        _toplevel_cache[d] = top
    return top


def git_ignored(paths: list, deadline: float = None):
    """`(ignored, unchecked)`: the subset of `paths` git ignores, and those
    git could not be asked about in time (or failed on). One
    `git check-ignore` per toplevel, each with min(GIT_TIMEOUT_S, what is left
    of `deadline`). Outside git, or without git, nothing is ignored: the walk
    already applied the fixed prune list."""
    by_top: dict = {}
    for p in paths:
        top = _git_toplevel(p)
        if top is not None:
            by_top.setdefault(top, []).append(p)
    ignored: set = set()
    unchecked: set = set()
    if not by_top:
        return ignored, unchecked
    import subprocess   # lazily: most calls never get here, and it costs ~4 ms
    for top, files in sorted(by_top.items()):
        timeout = GIT_TIMEOUT_S
        if deadline is not None:
            timeout = min(timeout, deadline - time.perf_counter())
        if timeout <= 0:
            unchecked.update(files)
            continue
        rels = [os.path.relpath(f, top) for f in files]
        try:
            r = subprocess.run(["git", "-C", top, "check-ignore", "--stdin", "-z"],
                               input="\0".join(rels) + "\0", capture_output=True,
                               text=True, timeout=timeout)
        except FileNotFoundError:
            continue                    # no git: the prune list is all we have
        except (OSError, subprocess.SubprocessError, ValueError):
            unchecked.update(files)     # timed out, or could not run
            continue
        if r.returncode not in (0, 1):
            # 128 (not a repo to git, a safe.directory refusal, ...): as if
            # there were no git. Nothing is ignored; the prune list applies.
            continue
        back = dict(zip(rels, files))
        for rel in r.stdout.split("\0"):
            if rel in back:
                ignored.add(back[rel])
    return ignored, unchecked


# ── sessions ─────────────────────────────────────────────────────────────────

def _needles(path: str) -> list:
    """The forms `path` takes inside a session file's JSON: hook.py escapes
    non-ASCII, the extension does not."""
    out = {json.dumps(path)[1:-1], json.dumps(path, ensure_ascii=False)[1:-1]}
    return [n.encode("utf-8") for n in out]


class Sessions:
    """Pending entries, looked up lazily. A path's session is keyed by the hash
    of a registered root or of a nested worktree dir — both are ancestors — so
    every ancestor up to the outermost registered root containing it is tried.

    A session file can be many MB, so it is read as bytes and parsed only when
    the path occurs in it. Keys are compared through normcase."""

    def __init__(self, roots: list):
        self.roots = roots
        self.dir = os.path.join(_cg_dir(), "sessions")
        try:
            self.names = set(os.listdir(self.dir))
        except OSError:
            self.names = set()
        self.raw: dict = {}
        self.index: dict = {}
        self.fold = os.path.normcase("A") == "a"     # case-insensitive paths

    def _raw(self, name: str) -> bytes:
        if name not in self.raw:
            try:
                with open(os.path.join(self.dir, name), "rb") as f:
                    data = f.read()
            except OSError:
                data = b""
            self.raw[name] = data.lower() if self.fold else data
        return self.raw[name]

    def _index(self, name: str) -> dict:
        if name not in self.index:
            idx = {}
            try:
                with open(os.path.join(self.dir, name), "rb") as f:
                    data = json.loads(f.read())
                files = data.get("files") if isinstance(data, dict) else None
                if isinstance(files, dict):
                    for k, v in files.items():
                        if isinstance(k, str):
                            idx[_norm(k)] = v
            except (OSError, ValueError, TypeError):
                pass
            self.index[name] = idx
        return self.index[name]

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
        needles = None
        cur = os.path.dirname(np)
        while True:
            name = _hash(cur) + ".json"
            if name in self.names:
                if needles is None:
                    needles = _needles(np if self.fold else path)
                raw = self._raw(name)
                if any(n in raw for n in needles):
                    e = self._index(name).get(np)
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

def _dir_changed(d: str, since_ns: int) -> bool:
    """Whether the nearest existing ancestor of `d` changed in the window
    (a deletion updates its directory's mtime)."""
    while True:
        try:
            return os.lstat(d).st_mtime_ns >= since_ns
        except OSError:
            parent = os.path.dirname(d)
            if parent == d:
                return False
            d = parent


def innermost_root(path: str, roots: list):
    np = _norm(path)
    best = None
    for r in roots:
        if _inside(np, r) and (best is None or len(r) > len(best)):
            best = r
    return best


def _new_bucket() -> dict:
    return {"missed": [], "uncertain": [], "phantom": [], "covered": 0, "implicit": 0,
            "outOfScope": 0, "tooLarge": 0, "captured": 0}


def _paths(record: dict, key: str) -> list:
    v = record.get(key)
    return list(dict.fromkeys(p for p in v if isinstance(p, str))) if isinstance(v, list) else []


def classify(changed: list, record: dict, roots: list, since_ms: int, duration_ms: int,
             sessions=None, deadline: float = None):
    """`(buckets, truncated)`: {innermost root: bucket} for every root with a
    change or a phantom, and whether git ran out of time for some files."""
    captured = _paths(record, "captured")
    already = _paths(record, "alreadyPending")
    known = {_norm(p) for p in captured} | {_norm(p) for p in already}
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

    changed_norm = {_norm(p) for p in changed}

    def did_change(p, new):
        # Judged by its own stat, not by the walk, so a truncated walk cannot
        # turn a real capture into a phantom.
        try:
            return os.lstat(p).st_mtime_ns >= since_ns
        except FileNotFoundError:
            if not new:
                # Pending before, gone now: deleted by this call only if its
                # directory changed in the window. Named again after an
                # earlier deletion, it is nothing new.
                return _dir_changed(os.path.dirname(p), since_ns)
            # Gone after the call: a deletion, unless the capture recorded a
            # file that never existed (originalContent null) and still doesn't.
            e = sessions.entry(p)
            return e is not None and e.get("originalContent") is not None
        except OSError:
            return _norm(p) in changed_norm

    for p in captured:
        b = bucket(p)
        if b is None:
            continue
        if did_change(p, True):
            b["captured"] += 1
        else:
            b["phantom"].append(p)
    new_norm = {_norm(c) for c in captured}
    for p in already:
        if _norm(p) in new_norm:
            continue
        b = bucket(p)
        if b is not None and did_change(p, False):
            b["captured"] += 1

    rest = []
    for p in changed:
        if _norm(p) in known:
            continue
        if sessions.entry(p) is not None:
            b = bucket(p)
            if b is not None:
                b["covered"] += 1
            continue
        rest.append(p)

    ignored, unchecked = git_ignored(rest, deadline) if rest else (set(), set())
    for p in rest:
        b = bucket(p)
        if b is None:
            continue
        if p in ignored:
            b["outOfScope"] += 1
            continue
        try:
            too_large = os.lstat(p).st_size > MAX_CAPTURE_BYTES
        except OSError:
            too_large = False
        if too_large:
            b["tooLarge"] += 1
        elif is_binary(p):
            b["outOfScope"] += 1
        elif implicit:
            b["implicit"] += 1
        elif long_call or p in unchecked:
            # Git ran out of time for it: it may be ignored, so not a miss.
            b["uncertain"].append(p)
        else:
            b["missed"].append(p)

    for b in buckets.values():
        for k in ("missed", "uncertain", "phantom"):
            b[k].sort()
    return buckets, bool(unchecked)


# ── output ───────────────────────────────────────────────────────────────────

_SECRET_NAME = r"[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY)[A-Za-z0-9_]*"
_VALUE = r"""(?:"[^"]*"|'[^']*'|[^\s'"]+)"""
_REDACTIONS = [
    (re.compile(r"(?i)(Authorization:\s*)[^'\"\n]+"), r"\1***"),
    (re.compile(r"(?i)([\w-]*(?:token|key|secret|auth)[\w-]*:\s*)[^'\"\n]+"), r"\1***"),
    (re.compile(r"(?i)\b(Bearer|Basic)(\s+)[^\s'\"]+"), r"\1\2***"),
    (re.compile(r"(?i)((?:^|\s)(?:-u|--user)[ =])\S+:\S+"), r"\1***"),
    (re.compile(r"(?i)(--(?:password|token|api-key|secret)=)" + _VALUE), r"\1***"),
    (re.compile(r"(?i)\b(" + _SECRET_NAME + r")=" + _VALUE), r"\1=***"),
    (re.compile(r"(\b[A-Za-z][A-Za-z0-9+.-]*://)[^\s/@'\"]+@"), r"\1***@"),
]
_MYSQL_RE = re.compile(r"\bmysql\w*\b[^\n;&|]*")
_MYSQL_P_RE = re.compile(r"(\s-p)[^\s'\"]+")


def redact(command: str) -> str:
    """Mask credentials a command carries before any of it is stored."""
    for rx, repl in _REDACTIONS:
        command = rx.sub(repl, command)
    return _MYSQL_RE.sub(lambda m: _MYSQL_P_RE.sub(r"\1***", m.group(0)), command)


def rotate(path: str, max_bytes: int = ROTATE_BYTES) -> None:
    """Keep one old file. Rotate only if the file is still over the limit and
    is still the same file, so two writers racing here rotate once."""
    try:
        st = os.stat(path)
        if st.st_size < max_bytes:
            return
        again = os.stat(path)
        if again.st_ino != st.st_ino or again.st_size < max_bytes:
            return
        os.replace(path, path + ".1")
    except OSError:
        pass


def append_line(path: str, obj: dict) -> None:
    rotate(path)
    data = (json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        if os.write(fd, data) != len(data):
            raise OSError("short write")
    finally:
        os.close(fd)


def select_roots(record: dict, roots: list) -> list:
    """Registered roots that contain the call's cwd or a captured path, plus
    up to NESTED_ROOTS_CAP registered roots inside cwd (a command run from a
    parent directory of several projects)."""
    anchors = []
    cwd = record.get("cwd")
    ncwd = _norm(cwd) if isinstance(cwd, str) and cwd else None
    if ncwd:
        anchors.append(ncwd)
    anchors.extend(_norm(p) for p in _paths(record, "captured") + _paths(record, "alreadyPending"))
    chosen = [r for r in roots if any(_inside(a, r) for a in anchors)]
    if ncwd:
        inner = sorted((r for r in roots if r not in chosen and _inside(r, ncwd)),
                       key=lambda r: (len(r), r))
        chosen.extend(inner[:NESTED_ROOTS_CAP])
    return chosen


def _cap(lst: list) -> list:
    return lst[:LIST_CAP]


def run(payload: dict, now_ms: int = None, budget_ms: float = SCAN_BUDGET_MS,
        run_budget_ms: float = RUN_BUDGET_MS) -> None:
    deadline = time.perf_counter() + run_budget_ms / 1000.0
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
    changed, truncated = scan_changed(scan_roots, since, budget_ms, roots, load_excludes(),
                                      deadline=deadline)
    buckets, git_short = classify(changed, record, roots, since, duration, deadline=deadline)
    truncated = truncated or git_short
    buckets = {r: b for r, b in buckets.items()
               if b["phantom"] or b["captured"] or b["covered"] or b["outOfScope"]
               or b["tooLarge"] or b["implicit"] or b["missed"] or b["uncertain"]}
    if not buckets:
        if not truncated:
            return
        # A blind call is still worth a line: the report counts them.
        cwd = record.get("cwd")
        home = innermost_root(cwd, roots) if isinstance(cwd, str) and cwd else None
        buckets = {home or scan_roots[0]: _new_bucket()}

    tool_input = payload.get("tool_input") if isinstance(payload.get("tool_input"), dict) else {}
    command = tool_input.get("command") if isinstance(tool_input.get("command"), str) else ""
    session_id = record.get("sessionId")
    if not isinstance(session_id, str):
        session_id = payload.get("session_id") if isinstance(payload.get("session_id"), str) else None
    event = payload.get("hook_event_name")
    from datetime import datetime, timezone
    at = datetime.now(timezone.utc).isoformat()
    head = redact(command)[:COMMAND_HEAD]
    os.makedirs(audit_dir, mode=0o700, exist_ok=True)
    try:
        os.chmod(audit_dir, 0o700)
    except OSError:
        pass
    for root, b in sorted(buckets.items()):
        line = {
            "at": at,
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "event": event if isinstance(event, str) else None,
            "durationMs": duration,
            "cwd": record.get("cwd"),
            "root": root,
            "commandHead": head,
            "background": record.get("background") is True,
            "truncated": truncated,
            "missed": _cap(b["missed"]),
            "uncertain": _cap(b["uncertain"]),
            "phantom": _cap(b["phantom"]),
            "missedCount": len(b["missed"]),
            "uncertainCount": len(b["uncertain"]),
            "phantomCount": len(b["phantom"]),
            "covered": b["covered"],
            "implicit": b["implicit"],
            "outOfScope": b["outOfScope"],
            "tooLarge": b["tooLarge"],
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
