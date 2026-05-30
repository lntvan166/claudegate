#!/usr/bin/env python3
"""
ClaudeGate PreToolUse hook.
Captures original file content before any Claude write and records it in
~/.claudegate/sessions/<workspace-hash>.json.
Each workspace gets its own session file, so multiple simultaneous Claude
sessions in different projects don't interfere with each other.
"""
import sys
import json
import os
import hashlib
from datetime import datetime, timezone

CLAUDEGATE_DIR = os.path.expanduser("~/.claudegate")
SESSIONS_DIR   = os.path.join(CLAUDEGATE_DIR, "sessions")


def workspace_session_file(cwd: str) -> str:
    """Return the session file path for the given working directory."""
    # Normalise: resolve to absolute path, lower-case on Windows (normcase).
    normalized = os.path.normcase(os.path.abspath(cwd))
    workspace_hash = hashlib.md5(normalized.encode()).hexdigest()
    return os.path.join(SESSIONS_DIR, f"{workspace_hash}.json")


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
    os.makedirs(os.path.dirname(session_file), exist_ok=True)
    tmp = session_file + ".tmp"
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

    if not os.path.isabs(file_path):
        file_path = os.path.normpath(os.path.join(cwd, file_path))

    session_file = workspace_session_file(cwd)

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
        }
        if session.get("status") == "reviewed":
            session["status"] = "active"
        save_session(session, session_file)

    elif existing["reviewStatus"] in ("accepted", "rejected"):
        existing["originalContent"] = original_content
        existing["reviewStatus"] = "pending"
        session["status"] = "active"
        save_session(session, session_file)


if __name__ == "__main__":
    main()
