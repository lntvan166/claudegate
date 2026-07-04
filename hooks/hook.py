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
import hashlib
import random
from datetime import datetime, timezone

CLAUDEGATE_DIR = os.path.expanduser("~/.claudegate")
SESSIONS_DIR   = os.path.join(CLAUDEGATE_DIR, "sessions")
WORKSPACE_ROOTS_FILE = os.path.join(CLAUDEGATE_DIR, "workspace-roots.json")


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


# Known limitation: hook.py and the VS Code extension both read-modify-write
# the same JSON file without a cross-process lock. The probability of a
# collision is very low (both must be in their read→write window simultaneously)
# but is non-zero when the user is actively accepting/rejecting files while
# Claude is writing new ones. Atomic os.replace() prevents torn reads, but
# does not prevent one writer from overwriting the other's changes.

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
    }


def save_session(session: dict, session_file: str) -> None:
    # Use PID + random suffix so concurrent hook invocations (e.g. MultiEdit)
    # don't clobber each other's temp file before the atomic replace.
    os.makedirs(os.path.dirname(session_file), exist_ok=True)
    tmp = f"{session_file}.{os.getpid()}.{random.randint(0, 0xFFFFFF):06x}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(session, f, indent=2)
    os.replace(tmp, session_file)


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
        sys.exit(0)
    session_file = workspace_session_file(workspace_root)

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            original_content: str | None = f.read()
    except (FileNotFoundError, PermissionError):
        original_content = None

    session = load_session(session_file) or new_session()
    existing = session["files"].get(file_path)

    if existing is None:
        session["files"][file_path] = {
            "originalContent": original_content,
            "reviewStatus": "pending",
            "sessionId": session_id,
            "capturedAt": captured_at,
        }
        if session.get("status") == "reviewed":
            session["status"] = "active"
        save_session(session, session_file)

    # A pending entry is left untouched: its originalContent is the frozen
    # review baseline and must never advance while the file awaits review.

    elif existing["reviewStatus"] in ("accepted", "rejected"):
        existing["originalContent"] = original_content
        existing["reviewStatus"] = "pending"
        existing["sessionId"] = session_id
        existing["capturedAt"] = captured_at
        session["status"] = "active"
        save_session(session, session_file)


if __name__ == "__main__":
    main()
