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


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_input = hook_input.get("tool_input") or {}
    file_path = tool_input.get("file_path", "")
    if not file_path:
        sys.exit(0)

    cwd = hook_input.get("cwd", os.getcwd())
    session_id = hook_input.get("session_id")
    captured_at = datetime.now(timezone.utc).isoformat()

    if not os.path.isabs(file_path):
        file_path = os.path.normpath(os.path.join(cwd, file_path))

    workspace_root = workspace_root_for_file(file_path, cwd)
    if workspace_root is None:
        log_event("skip-no-root", file_path)
        sys.exit(0)
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
            sys.exit(0)
        except OSError:
            # Exists but unreadable (permissions, etc). Same reasoning as above.
            log_event("skip-unreadable", file_path)
            sys.exit(0)
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


if __name__ == "__main__":
    # Fail open, always. The hook runs synchronously before every Claude
    # Write/Edit/MultiEdit; an uncaught exception here would print a traceback to
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
