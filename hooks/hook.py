#!/usr/bin/env python3
"""
ClaudeGate PreToolUse hook.
Captures original file content before any Claude write and records it in
~/.claudegate/session.json.
"""
import sys
import json
import os
from datetime import datetime, timezone

SESSION_FILE = os.path.expanduser("~/.claudegate/session.json")


def load_session() -> dict | None:
    try:
        with open(SESSION_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def new_session() -> dict:
    return {
        "sessionId": datetime.now(timezone.utc).isoformat(),
        "status": "active",
        "files": {},
    }


def save_session(session: dict) -> None:
    os.makedirs(os.path.dirname(SESSION_FILE), exist_ok=True)
    with open(SESSION_FILE, "w", encoding="utf-8") as f:
        json.dump(session, f, indent=2)


def main() -> None:
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_input = hook_input.get("tool_input") or {}
    file_path = tool_input.get("file_path", "")
    if not file_path:
        sys.exit(0)

    if not os.path.isabs(file_path):
        cwd = hook_input.get("cwd", os.getcwd())
        file_path = os.path.normpath(os.path.join(cwd, file_path))

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            original_content: str | None = f.read()
    except (FileNotFoundError, PermissionError):
        original_content = None

    session = load_session() or new_session()

    existing = session["files"].get(file_path)

    if existing is None:
        # First time this file is touched in this session — record original
        session["files"][file_path] = {
            "originalContent": original_content,
            "reviewStatus": "pending",
        }
        # Re-open a reviewed session when Claude writes new files
        if session.get("status") == "reviewed":
            session["status"] = "active"
        save_session(session)

    elif existing["reviewStatus"] in ("accepted", "rejected"):
        # File was already reviewed but Claude is writing it again.
        # Capture the current state as the new "original" and mark pending.
        existing["originalContent"] = original_content
        existing["reviewStatus"] = "pending"
        session["status"] = "active"
        save_session(session)

    # If reviewStatus == "pending": original is already captured, do nothing.


if __name__ == "__main__":
    main()
