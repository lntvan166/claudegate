#!/usr/bin/env python3
"""
ClaudeGate 1.3.0 manual-test seeder + edit simulator.

Creates a throwaway workspace of "Claude-edited" files on disk AND the matching
~/.claudegate session file, so the review panels light up without driving Claude.
It can also SIMULATE Claude re-editing a file (fires the real PreToolUse hook the
same way Claude Code does), so you can verify the review-log behaviour
deterministically.

  python3 manual-test-seed.py                      # seed  ~/claudegate-manual-test
  python3 manual-test-seed.py /path/to/ws          # seed a custom workspace dir
  python3 manual-test-seed.py --clean              # remove workspace + its session file

  # after you Accept a file in the panel, simulate Claude touching it again:
  python3 manual-test-seed.py --reedit src/auth.ts     # hook fires + a real change is written
  python3 manual-test-seed.py --noop-edit src/auth.ts  # hook fires but the file is unchanged

Open the workspace folder in VS Code/Cursor (with ClaudeGate installed) to review.
"""
import os, sys, json, hashlib, shutil, subprocess

HOME  = os.path.expanduser("~")
CGDIR = os.path.join(HOME, ".claudegate")
ROOTS = os.path.join(CGDIR, "workspace-roots.json")
HOOK  = os.path.join(CGDIR, "hook.py")

argv = sys.argv[1:]
def flag_value(name):
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None
CLEAN  = "--clean" in argv
REEDIT = flag_value("--reedit")
NOOP   = flag_value("--noop-edit")

# positional workspace = first bare arg not consumed as a flag or a flag's value
consumed = set()
for name in ("--reedit", "--noop-edit"):
    if name in argv:
        i = argv.index(name); consumed.update((i, i + 1))
pos = [a for j, a in enumerate(argv) if j not in consumed and not a.startswith("--")]
WS  = os.path.abspath(os.path.expanduser(pos[0])) if pos else os.path.expanduser("~/claudegate-manual-test")

norm   = WS.lower() if sys.platform == "win32" else WS   # mirrors SessionManager + hook.py
digest = hashlib.md5(norm.encode()).hexdigest()
spath  = os.path.join(CGDIR, "sessions", f"{digest}.json")


def ensure_root_registered(ws):
    """The hook resolves a file's workspace via workspace-roots.json (written by
    the extension). Register ws so the simulated hook call resolves it even if a
    window hasn't persisted it yet."""
    try:
        roots = json.load(open(ROOTS))
    except Exception:
        roots = []
    if ws not in roots:
        roots.append(ws)
        os.makedirs(CGDIR, exist_ok=True)
        json.dump(roots, open(ROOTS, "w"), indent=2)


def fire_hook(ws, rel):
    """Invoke the deployed hook exactly like Claude Code's PreToolUse does."""
    payload = json.dumps({
        "cwd": ws, "hook_event_name": "PreToolUse", "tool_name": "Edit",
        "session_id": "manual-test-session-A",
        "tool_input": {"file_path": rel},
    })
    subprocess.run(["python3", HOOK], input=payload, text=True, check=True)


if CLEAN:
    for p, rm in ((spath, os.remove), (WS, shutil.rmtree)):
        if os.path.exists(p): rm(p); print(f"removed {p}")
        else: print(f"(nothing at {p})")
    sys.exit(0)

if REEDIT or NOOP:
    rel = REEDIT or NOOP
    abs_path = os.path.join(WS, rel)
    if not os.path.exists(abs_path):
        sys.exit(f"error: {abs_path} does not exist — seed first (python3 manual-test-seed.py)")
    ensure_root_registered(WS)
    fire_hook(WS, rel)                       # PreToolUse: snapshots the pre-edit baseline
    if REEDIT:
        cur = open(abs_path).read()
        n = cur.count("simulated Claude re-edit") + 1
        open(abs_path, "w").write(cur.rstrip("\n") + f"\n// simulated Claude re-edit #{n}\n")
        print(f"re-edited {rel}: hook fired + a real change written.")
        print("Expect: this file appears in Pending with the new change; any prior")
        print("Accepted record for it stays in the Accepted panel.")
    else:
        print(f"no-op edit on {rel}: hook fired, file left unchanged.")
        print("Expect: NO empty Pending row appears; any Accepted record is preserved.")
    print(f"session: {spath}")
    sys.exit(0)

# ── seed ──────────────────────────────────────────────────────────────────────
# relpath, baseline(None => new file), disk(current/Claude-edited), session_id
S_A, S_B = "manual-test-session-A", "manual-test-session-B"
FILES = [
    ("src/auth.ts",
     'export function login(user, pass) {\n  const token = signJWT(user)\n  // issue the session\n  return token\n  // deprecated fallback\n}\n',
     'export function login(user, pass) {\n  const token = signJWT(user, "HS256")\n  // issue the session\n  if (!user.mfaVerified)\n    throw new Error("MFA required")\n  return token\n}\n',
     S_A),
    ("src/utils.ts",
     'export function slug(s) {\n  return s.toLowerCase()\n}\n',
     'export function slug(s) {\n  return s.trim().toLowerCase().replace(/\\s+/g, "-")\n}\n',
     S_A),
    ("src/newfeature.ts",
     None,
     'export function ping() {\n  return "pong"\n}\n',
     S_B),
    (".env",
     'API_URL=https://api.example.com\nDEBUG=false\n',
     'API_URL=https://api.example.com\nDEBUG=false\nSECRET_KEY=sk-live-0000000000\n',
     S_B),
    ("package-lock.json",
     '{ "lockfileVersion": 2, "requires": true }\n',
     '{ "lockfileVersion": 3, "requires": true }\n',
     S_B),
]

os.makedirs(os.path.dirname(spath), exist_ok=True)
files_json = {}
for rel, baseline, disk, sid in FILES:
    abs_path = os.path.join(WS, rel)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    open(abs_path, "w").write(disk)                       # disk = Claude's edited version
    files_json[abs_path] = {                              # session = pre-edit baseline
        "originalContent": baseline,
        "reviewStatus": "pending",
        "sessionId": sid,
        "capturedAt": "2026-07-05T10:00:00.000000+00:00",
    }

session = {
    "sessionId": "2026-07-05T10:00:00.000000+00:00",
    "status": "active",
    "files": files_json,
    "accepted": [],     # persistent per-accept log (new model)
    "rejected": {},     # latest reject per file (new model)
}
json.dump(session, open(spath, "w"), indent=2)

print(f"workspace : {WS}")
print(f"session   : {spath}")
print(f"seeded    : {len(FILES)} files (4 in-scope pending + 1 excluded lock file)")
print("\nNext: open the workspace folder in VS Code/Cursor with ClaudeGate installed.")
