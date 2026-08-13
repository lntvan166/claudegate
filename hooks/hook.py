#!/usr/bin/env python3
"""
ClaudeGate PreToolUse hook.
Captures original file content before any Claude write and records it in
~/.claudegate/sessions/<workspace-hash>.json.
Each workspace gets its own session file, so multiple simultaneous Claude
sessions in different projects don't interfere with each other.
"""
from __future__ import annotations

import sys
import json
import os
import re
import time
import hashlib
import random
from datetime import datetime, timezone

CLAUDEGATE_DIR = os.path.expanduser("~/.claudegate")
SESSIONS_DIR   = os.path.join(CLAUDEGATE_DIR, "sessions")
WORKSPACE_ROOTS_FILE = os.path.join(CLAUDEGATE_DIR, "workspace-roots.json")

HOOKLOG_SENTINEL = os.path.join(CLAUDEGATE_DIR, "hooklog.enabled")
HOOKLOG_FILE     = os.path.join(CLAUDEGATE_DIR, "hook.log")
HOOKLOG_MAX_BYTES = 1_000_000  # rolling debug aid; reset past this

# Advisory lock shared with the extension to serialize read-modify-write of the
# session file, so this hook cannot overwrite the extension's accepted/rejected
# log from a snapshot loaded microseconds before the user accepted a file.
# CRITICAL: this hook runs synchronously before every Claude write, so it must
# FAIL OPEN — never block the edit. We wait only briefly for the lock (the
# extension holds it for a few milliseconds at most) and proceed unlocked on
# timeout; a stale lock left by a crashed process is stolen after LOCK_STALE_S.
LOCK_STALE_S   = 3.0
LOCK_TIMEOUT_S = 0.5
LOCK_SLEEP_S   = 0.005


def acquire_lock(session_file: str):
    """Return (fd, lock_path). fd is None when we should proceed without the lock."""
    lock_path = session_file + ".lock"
    deadline = time.monotonic() + LOCK_TIMEOUT_S
    while True:
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, str(os.getpid()).encode())
            except OSError:
                pass  # pid is advisory
            return fd, lock_path
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(lock_path) > LOCK_STALE_S:
                    try:
                        os.unlink(lock_path)  # steal an abandoned lock
                    except OSError:
                        pass
                    continue
            except OSError:
                continue  # lock vanished between open and stat → retry
            if time.monotonic() >= deadline:
                return None, lock_path  # fail open: proceed unlocked
            time.sleep(LOCK_SLEEP_S)
        except OSError:
            return None, lock_path  # unexpected fs error → don't block the edit


def release_lock(fd, lock_path: str) -> None:
    if fd is None:
        return
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(lock_path)
    except OSError:
        pass


def workspace_root_for_file(file_path: str, cwd: str) -> str | None:
    """Match the VS Code extension session hash — use workspace folder, not Claude cwd."""
    abs_file = os.path.normcase(os.path.abspath(file_path))
    roots: list[str] = []
    try:
        with open(WORKSPACE_ROOTS_FILE, encoding="utf-8") as f:
            roots = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, TypeError):
        roots = []

    # Pick the most specific (longest) matching root so nested or stale roots
    # in the shared list never misroute a file to the wrong session.
    best: str | None = None
    for root in roots:
        abs_root = os.path.normcase(os.path.abspath(root))
        if abs_file == abs_root or abs_file.startswith(abs_root + os.sep):
            if best is None or len(abs_root) > len(best):
                best = abs_root

    if best is not None:
        return best

    return None


def workspace_session_file(workspace_root: str) -> str:
    """Return the session file path for the given workspace root."""
    normalized = os.path.normcase(os.path.abspath(workspace_root))
    workspace_hash = hashlib.md5(normalized.encode()).hexdigest()
    return os.path.join(SESSIONS_DIR, f"{workspace_hash}.json")


def worktree_root_for_file(file_path: str, best_root: str) -> str | None:
    """Return the nested git-worktree working dir containing file_path, if it is a
    real worktree (not a submodule) strictly BELOW best_root. Pure filesystem and
    FAIL-OPEN: any error returns None so routing falls back to best_root. Never
    walks above best_root."""
    try:
        best_abs = os.path.normcase(os.path.abspath(best_root))
        cur = os.path.dirname(os.path.normcase(os.path.abspath(file_path)))
        while cur.startswith(best_abs + os.sep):  # strictly below best_root
            dot_git = os.path.join(cur, ".git")
            if os.path.isfile(dot_git):
                try:
                    with open(dot_git, encoding="utf-8") as f:
                        first = f.read().strip()
                except OSError:
                    return None
                # A worktree's gitdir is structurally `<main>/.git/worktrees/<name>`;
                # a submodule's is `<super>/.git/modules/<name>`. Check the two
                # segments above <name> are `worktrees` then `.git` (a substring
                # match would misclassify a submodule parked under a dir literally
                # named "worktrees").
                if first.startswith("gitdir:"):
                    target = first[len("gitdir:"):].strip()
                    parent = os.path.dirname(target)        # <main>/.git/worktrees
                    grandparent = os.path.dirname(parent)   # <main>/.git
                    if (os.path.basename(parent) == "worktrees"
                            and os.path.basename(grandparent) == ".git"):
                        return cur
                return None
            parent = os.path.dirname(cur)
            if parent == cur:
                break
            cur = parent
        return None
    except Exception:
        return None


# Concurrency: hook.py and the VS Code extension both read-modify-write the same
# JSON file. They coordinate via the fail-open advisory lock above, which
# serializes the read→write window in the common case; atomic os.replace() also
# prevents torn reads. Residual (accepted): because the hook must fail open (it
# can never block a Claude write), a write during a lock-timeout/steal window is
# still possible. The extension backstops this by always merging the on-disk
# files{} before it writes (see mergeFreshCaptures), so a hook capture survives
# even an unlocked collision.

def load_session(session_file: str) -> dict | None:
    try:
        with open(session_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def new_session() -> dict:
    return {
        "sessionId": datetime.now(timezone.utc).isoformat(),
        "status": "active",
        "files": {},
        # The extension owns these decision stores; initialize them so a
        # hook-created session already matches the schema (no migration re-write).
        "accepted": [],
        "rejected": {},
    }


def save_session(session: dict, session_file: str) -> None:
    # Use PID + random suffix so concurrent hook invocations (e.g. MultiEdit)
    # don't clobber each other's temp file before the atomic replace.
    os.makedirs(os.path.dirname(session_file), exist_ok=True)
    tmp = f"{session_file}.{os.getpid()}.{random.randint(0, 0xFFFFFF):06x}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(session, f, indent=2)
    os.replace(tmp, session_file)


def log_event(event: str, detail: str = "") -> None:
    """Append a diagnostic line to ~/.claudegate/hook.log, but ONLY when the
    extension has created the sentinel (claudegate.hookLog.enabled=true).
    Best-effort and fully guarded: the hook must never break because logging
    failed. Self-truncates once the file passes the size cap."""
    try:
        if not os.path.exists(HOOKLOG_SENTINEL):
            return
        # For the top-level fail-open handler, derive the exception repr here —
        # inside this guard — so a raising __repr__ can't escape to the caller.
        if event == "error" and not detail:
            try:
                detail = repr(sys.exc_info()[1])
            except Exception:
                detail = "<unrepresentable>"
        try:
            if os.path.getsize(HOOKLOG_FILE) > HOOKLOG_MAX_BYTES:
                os.remove(HOOKLOG_FILE)
        except OSError:
            pass
        ts = datetime.now(timezone.utc).isoformat()
        line = f"{ts} {event}{(' ' + detail) if detail else ''}\n"
        with open(HOOKLOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass  # logging must never break the fail-open hook


# ---------------------------------------------------------------------------
# Shell-write capture (the `Bash` tool).
#
# A Bash payload carries `tool_input.command` — a shell string — and no
# `file_path`, so files rewritten by `sed -i`, a heredoc, or a python one-liner
# used to be captured by nothing at all. See
# docs/superpowers/specs/2026-08-11-bash-writes-capture-design.md.
#
# Three properties this code must never lose:
#   * PURE STRING PARSING. No subprocess, no glob expansion, no `git`
#     invocation. This runs synchronously before every shell command Claude
#     runs; it may not add measurable latency and may not have side effects.
#   * BOUNDED. Scanned text and emitted candidates are both capped, so a
#     pathological heredoc cannot stall a write.
#   * FAIL OPEN. Any exception degrades to "no capture" (the caller logs and
#     exits 0), never to a broken edit.
#
# Over-capture is deliberate and safe: a wrongly harvested path either matches
# its own baseline (hidden immediately, pruned by the extension's no-op sweep)
# or does not exist (pruned as an absent new file). Under-capture is the bug.
# ---------------------------------------------------------------------------

MAX_COMMAND_CHARS = 64 * 1024   # cap the scanned command text
MAX_CANDIDATES    = 25          # cap the paths one command may produce
MAX_CANDIDATE_LEN = 400

# Redirection into a real filename: `> f`, `>> f`, `2> f`, `&> f`. The (?!&)
# lookahead rejects fd duplication (`2>&1`, `>&2`), which creates no file.
_REDIRECT_RE = re.compile(
    r"""(?:^|[\s;&|(])\d*>{1,2}\s*(?!&)"""
    r"""((?:'[^']*'|"[^"]*"|[^\s;&|<>()'"])+)"""
)

# In-language writes: `open(p, 'w')` / `'a'` / `'w+'` / `'wb'`, plus the
# pathlib/file-object write calls that usually accompany them.
_OPEN_WRITE_RE = re.compile(r"""open\s*\([^()]*?,\s*(['"])[^'"]*[wa+][^'"]*\1""")
_WRITE_CALL_RE = re.compile(r"\.write(?:_text|_bytes|lines)?\s*\(")

# Tools whose non-flag arguments are write targets whenever they are invoked.
_ALWAYS_WRITE_TOOLS = frozenset({
    "tee", "cp", "mv", "install", "patch", "dd", "truncate", "touch",
    "black", "rustfmt", "sponge",
})

# Tools that only write when one of these flags is present.
_FLAG_WRITE_TOOLS = {
    "sed":          (re.compile(r"^--in-place"), re.compile(r"^-[a-zA-Z]*i")),
    "perl":         (re.compile(r"^-[a-zA-Z]*i"),),
    "gofmt":        (re.compile(r"^-w$"),),
    "goimports":    (re.compile(r"^-w$"),),
    "prettier":     (re.compile(r"^--write$"), re.compile(r"^-w$")),
    "clang-format": (re.compile(r"^-i$"),),
}

# Prefixes that stand in front of the real command: wrappers and the shell
# keywords that open a compound statement (`for f in *.go; do gofmt -w $f; done`).
_WRAPPERS = frozenset({
    "sudo", "env", "nohup", "time", "command", "exec", "xargs",
    "do", "then", "else", "elif", "if", "while", "until", "!", "{",
})

_SEP_CHARS   = ";\n&|"
_REDIR_CHARS = "<>"
_BAD_CHARS   = frozenset("$`*?!<>|;\"'()[]{}\n\t\\")
_EXT_RE      = re.compile(r"\.[A-Za-z][A-Za-z0-9_+-]{0,9}$")
# `s/old/new/g`, `y|a|b|` — a sed script, not a path.
_SED_EXPR_RE = re.compile(r"^[0-9,]*[sy]([^\w\s])")


def _lex(text: str) -> list:
    """Quote-aware shell-ish lexer. Returns [(kind, value)] with kind in
    {"word", "sep", "redir"}. Quotes are stripped and their contents joined onto
    the surrounding word, so `p='a/b.go'` lexes as one word `p=a/b.go`."""
    tokens: list = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r":
            i += 1
            continue
        if c in _SEP_CHARS:
            while i < n and text[i] in _SEP_CHARS:
                i += 1
            tokens.append(("sep", ""))
            continue
        if c in _REDIR_CHARS:
            while i < n and text[i] in _REDIR_CHARS:
                i += 1
            tokens.append(("redir", ""))
            continue
        buf: list = []
        while i < n:
            c = text[i]
            if c in " \t\r" or c in _SEP_CHARS or c in _REDIR_CHARS:
                break
            if c in "'\"":
                j = text.find(c, i + 1)
                if j == -1:  # unbalanced quote: take the rest and stop
                    buf.append(text[i + 1:])
                    i = n
                    break
                buf.append(text[i + 1:j])
                i = j + 1
                continue
            buf.append(c)
            i += 1
        tokens.append(("word", "".join(buf)))
    return tokens


def _segments(tokens: list) -> list:
    """Split lexed tokens into command segments. The word following a
    redirection operator is dropped — `patch < fix.diff` reads that file, and
    `> out` targets are harvested separately by _REDIRECT_RE."""
    segs: list = []
    cur: list = []
    skip_next = False
    for kind, value in tokens:
        if kind == "sep":
            if cur:
                segs.append(cur)
            cur, skip_next = [], False
        elif kind == "redir":
            skip_next = True
        else:
            if skip_next:
                skip_next = False
                continue
            cur.append(value)
    if cur:
        segs.append(cur)
    return segs


def _normalize_token(tok: str) -> str:
    """`p=a/b.go` → `a/b.go`, `of=out.img` → `out.img`, `--out=x.go` → `x.go`."""
    if "=" in tok:
        tok = tok.rsplit("=", 1)[1]
    return tok


def _is_device(tok: str) -> bool:
    return tok.startswith(("/dev/", "/proc/", "/sys/"))


def _plausible(tok: str) -> bool:
    """Could this token name a file we may safely baseline?"""
    if not tok or len(tok) > MAX_CANDIDATE_LEN:
        return False
    if tok in (".", "..", "-"):
        return False
    if tok.startswith("-") or tok.startswith("~"):
        return False
    if any(c in _BAD_CHARS for c in tok):
        return False
    if tok.endswith("/") or tok.endswith(os.sep):  # a directory, not a file
        return False
    if "://" in tok or "..." in tok:               # URL / go-package wildcard
        return False
    if _is_device(tok):
        return False
    if tok.isdigit():
        return False
    m = _SED_EXPR_RE.match(tok)
    if m and tok.count(m.group(1)) >= 2:
        return False
    return True


def _path_shaped(tok: str) -> bool:
    """A bare literal only counts as a path if it has a separator or extension."""
    return "/" in tok or bool(_EXT_RE.search(tok))


def _names_a_file(tok: str, cwd: str | None) -> bool:
    """Does this SPECULATIVE candidate plausibly name a file?

    Applied only to Tier 2c — the "every path-shaped word in a writing command"
    pass — never to an explicit redirection or in-place-tool target, which is a
    write target by definition.

    Tier 2c is deliberately liberal, and the liberality is usually harmless: a
    wrong guess becomes a no-op entry the settle-window reconcile prunes. But on
    a large session it is not free. Each bogus entry costs a session-file write,
    a full reload (2 MB on the workspace where this was diagnosed), a reconcile,
    the prune, and a second write + reload. The shapes that caused it, none of
    which is a file:

        origin/main, origin/release-1.4   ← git refspecs
        github.com/acme/schema-lib        ← a Go module path

    Every one shares a shape: slashes, but no extension on the final segment and
    nothing on disk. So a speculative candidate is kept when EITHER
      * its basename carries a file extension (`manager/biz/rule.go`) — this is
        what keeps not-yet-created files capturable, which is the whole point of
        recording `originalContent: null`; or
      * it already exists on disk, which makes an extensionless real file
        (`scripts/build`) a legitimate baseline.
    """
    if _EXT_RE.search(os.path.basename(tok)):
        return True
    if not cwd:
        return False
    try:
        return os.path.isfile(os.path.join(cwd, tok))
    except (OSError, ValueError):
        return False


def _strip_quotes(tok: str) -> str:
    return tok.replace("'", "").replace('"', "")


# Two independent passes rather than one alternation, so a literal nested inside
# another quoting layer is still seen: in
#   python3 -c "open('pkg/gen.go','w').write(s)"
# the double-quote pass yields the whole one-liner (discarded — it has parens),
# while the single-quote pass yields `pkg/gen.go`.
_SQ_LITERAL_RE = re.compile(r"'([^']*)'")
_DQ_LITERAL_RE = re.compile(r'"([^"]*)"')


def _quoted_literals(text: str) -> list:
    out: list = []
    for pattern in (_SQ_LITERAL_RE, _DQ_LITERAL_RE):
        for m in pattern.finditer(text):
            out.append(m.group(1))
    return out


def _pathspec_shaped(tok: str) -> bool:
    """Is this git argument a pathspec rather than a treeish?

    Without an explicit `--`, `git checkout <x>` / `git reset --hard <x>` is
    ambiguous, and git itself resolves it by trying `<x>` as a ref first. The old
    rule accepted anything with a slash, so every `git checkout origin/main` and
    `git reset --hard origin/release-1.4` harvested the REF as a file path — the
    two most frequent bogus captures in a real session's hook.log.

    A ref and a pathspec are cleanly separable in practice: a pathspec is either
    explicitly rooted (`./x`, `../x`, `/x`) or names a file (extension on the
    final segment). `origin/main` is neither. When the caller really does mean a
    file, git wants the `--` anyway, and that branch is handled above.
    """
    if tok.startswith(("./", "../", "/")):
        return True
    return _path_shaped(tok) and bool(_EXT_RE.search(os.path.basename(tok)))


def _git_targets(args: list):
    """Return write targets for a `git` invocation, or None if it doesn't write."""
    idx = 0
    while idx < len(args) and args[idx].startswith("-"):
        idx += 2 if args[idx] in ("-C", "-c") else 1
    if idx >= len(args):
        return None
    sub, rest = args[idx], args[idx + 1:]
    if sub == "apply":
        return [a for a in rest if not a.startswith("-")]
    if sub in ("checkout", "restore"):
        if "--" in rest:
            after = rest[rest.index("--") + 1:]
            return [a for a in after if not a.startswith("-")]
        # `git checkout .` / a branch name names no file — Tier 3, out of scope.
        return [a for a in rest if not a.startswith("-") and _pathspec_shaped(a)]
    if sub == "stash":
        return [] if rest and rest[0] in ("pop", "apply") else None
    if sub == "reset":
        if "--hard" not in rest:
            return None
        return [a for a in rest if not a.startswith("-") and _pathspec_shaped(a)]
    return None


def _tool_targets(words: list):
    """Return the write targets of one command segment, or None if the segment
    is not a known file-writing command. An empty list means "writes, but names
    no file" (e.g. `git stash pop`) — Tier 1 true, Tier 2 empty."""
    while words:
        head = words[0]
        if head in _WRAPPERS:
            words = words[1:]
            continue
        name, _, _ = head.partition("=")
        if "=" in head and not head.startswith("-") and name.isidentifier():
            words = words[1:]  # leading VAR=value assignment
            continue
        break
    if not words:
        return None

    name = os.path.basename(words[0])
    args = words[1:]

    if name == "git":
        return _git_targets(args)
    if name == "ruff":
        if args and args[0] == "format":
            return [a for a in args[1:] if not a.startswith("-")]
        return None
    if name in _ALWAYS_WRITE_TOOLS:
        return [a for a in args if not a.startswith("-")]
    patterns = _FLAG_WRITE_TOOLS.get(name)
    if patterns is not None:
        for a in args:
            if a.startswith("-") and any(p.match(a) for p in patterns):
                return [x for x in args if not x.startswith("-")]
    return None


def _scan_command(command: str, cwd: str | None = None):
    """Return (may_write, candidates). Never raises for ordinary input.

    `cwd` is only consulted to test whether a *speculative* (Tier 2c) candidate
    already exists on disk; every other decision is a pure function of the
    command text.
    """
    if not command or not isinstance(command, str):
        return False, []
    text = command[:MAX_COMMAND_CHARS]

    may_write = False
    ordered: list = []
    seen: set = set()

    def add(tok: str, require_shape: bool) -> None:
        tok = _normalize_token(tok)
        if not _plausible(tok):
            return
        # require_shape marks the speculative pass. Explicit targets (redirection,
        # in-place tool arguments) skip both checks — they are write targets by
        # definition, extension or not (`cat > Makefile`).
        if require_shape and not (_path_shaped(tok) and _names_a_file(tok, cwd)):
            return
        if tok in seen:
            return
        seen.add(tok)
        if len(ordered) < MAX_CANDIDATES:
            ordered.append(tok)

    # Tier 2a — explicit redirection targets (write targets by definition, so
    # they need no path shape: `cat > f <<EOF` names `f`).
    for m in _REDIRECT_RE.finditer(text):
        target = _strip_quotes(m.group(1))
        if target and not _is_device(target):
            may_write = True
            add(target, False)

    # Tier 1/2b — known in-place writer tools and their arguments.
    tokens = _lex(text)
    for segment in _segments(tokens):
        targets = _tool_targets(segment)
        if targets is None:
            continue
        may_write = True
        for t in targets:
            add(t, False)

    # Tier 1 — in-language writes (python heredocs and -c one-liners).
    if _OPEN_WRITE_RE.search(text) or _WRITE_CALL_RE.search(text):
        may_write = True

    # Tier 2c — every path-shaped literal in the command. This is what catches
    # the reported failure, where the path is bound to a variable first:
    #   p='manager/biz/monitor_filter.go'   ← harvested here
    #   open(p,'w').write(s)                ← fires Tier 1
    if may_write:
        for kind, value in tokens:
            if kind == "word":
                add(value, True)
        for literal in _quoted_literals(text):
            add(literal, True)

    return may_write, ordered


def command_may_write(command: str) -> bool:
    """Tier 1 — could this command plausibly write a file? Answering False here
    keeps the hook's filesystem work (and hook.log) off every `ls`/`go build`."""
    return _scan_command(command)[0]


def paths_from_command(command: str, cwd: str | None = None) -> list:
    """Tier 2 — candidate write targets, deduplicated, in discovery order.
    Gated on Tier 1: a command that cannot write yields no candidates at all,
    so `cat file.go` and `grep -r foo .` extract nothing.

    Pass the tool call's `cwd` so an extensionless speculative candidate can be
    confirmed against the filesystem. Without it such candidates are dropped —
    the process cwd is not the session's directory, so resolving against it would
    be worse than not checking at all."""
    may_write, candidates = _scan_command(command, cwd)
    return candidates if may_write else []


def capture_file(file_path: str, cwd: str, session_id, captured_at: str) -> None:
    """Run one target through the capture pipeline. Returns (never exits) on
    every skip, so a Bash command with several candidates keeps going."""
    if not os.path.isabs(file_path):
        file_path = os.path.normpath(os.path.join(cwd, file_path))

    workspace_root = workspace_root_for_file(file_path, cwd)
    if workspace_root is None:
        log_event("skip-no-root", file_path)
        return
    # A nested git worktree owns its own session deterministically, regardless of
    # which windows are open (fail-open: falls back to workspace_root on any error).
    worktree_root = worktree_root_for_file(file_path, workspace_root)
    if worktree_root is not None:
        workspace_root = worktree_root
    session_file = workspace_session_file(workspace_root)

    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                original_content: str | None = f.read()
        except UnicodeDecodeError:
            # Not UTF-8 text (binary). We cannot safely baseline or later
            # restore it, and must NOT record it as a null "new" file — that
            # would let a reject delete the user's real file. Skip capture (a
            # non-zero exit could also block the edit).
            log_event("skip-binary", file_path)
            return
        except OSError:
            # Exists but unreadable (permissions, etc) — or a directory, which a
            # liberal shell-path candidate can be. Same reasoning as above.
            log_event("skip-unreadable", file_path)
            return
    else:
        original_content = None  # genuinely new — Claude is creating it

    # Hold the advisory lock across the whole read-modify-write so an accept/
    # reject the extension persists in this window can't be clobbered by our
    # write (and vice-versa). Fail-open: acquire_lock returns None on timeout.
    fd, lock_path = acquire_lock(session_file)
    try:
        session = load_session(session_file) or new_session()
        existing = session["files"].get(file_path)
        if existing is None or existing.get("reviewStatus") != "pending":
            session["files"][file_path] = {
                "originalContent": original_content,
                "reviewStatus": "pending",
                "newFile": original_content is None,
                "sessionId": session_id,
                "capturedAt": captured_at,
            }
            if session.get("status") == "reviewed":
                session["status"] = "active"
            save_session(session, session_file)
            log_event("captured", file_path)
        else:
            # An existing pending entry keeps its frozen baseline (no-op).
            log_event("skip-already-pending", file_path)
    finally:
        release_lock(fd, lock_path)


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_input = hook_input.get("tool_input") or {}
    cwd = hook_input.get("cwd", os.getcwd())
    session_id = hook_input.get("session_id")
    captured_at = datetime.now(timezone.utc).isoformat()

    # Write/Edit/MultiEdit: one named target, the original flow.
    file_path = tool_input.get("file_path", "")
    if isinstance(file_path, str) and file_path:
        capture_file(file_path, cwd, session_id, captured_at)
        return

    # Bash: no file_path, a shell string instead. Extract candidate targets and
    # run each through the SAME pipeline. Fail open at every step.
    command = tool_input.get("command", "")
    if not isinstance(command, str) or not command:
        sys.exit(0)
    try:
        candidates = paths_from_command(command, cwd)
    except Exception:
        log_event("error")
        sys.exit(0)
    for candidate in candidates:
        try:
            capture_file(candidate, cwd, session_id, captured_at)
        except Exception:
            # One bad candidate must not cost us the rest of the command.
            log_event("error")


if __name__ == "__main__":
    # Fail open, always. The hook runs synchronously before every Claude
    # Write/Edit/MultiEdit/Bash; an uncaught exception here would print a traceback to
    # the user on every edit (and a non-zero exit could block the write). Any
    # unexpected error — an unwritable ~/.claudegate, a full disk, a malformed
    # workspace-roots.json that parses but isn't a list — must degrade to "no
    # capture", never to a broken editing experience. SystemExit (our own
    # sys.exit(0) paths) is not an Exception, so it propagates untouched.
    try:
        main()
    except Exception:
        # Compute repr() inside log_event's own guard, not here — an exception
        # with a raising __repr__ evaluated as an argument would escape this
        # handler and break fail-open. log_event swallows everything internally.
        log_event("error")
        sys.exit(0)
