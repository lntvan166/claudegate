#!/usr/bin/env python3
"""
ClaudeGate 1.3.0 manual-test seeder.

Creates a throwaway workspace of "Claude-edited" files on disk AND the matching
~/.claudegate session file (with the pre-edit baseline as originalContent), so
every 1.3.0 review feature lights up without having to drive Claude Code.

  python3 manual-test-seed.py                 # seed  ~/claudegate-manual-test
  python3 manual-test-seed.py /path/to/ws     # seed a custom workspace dir
  python3 manual-test-seed.py --clean         # remove workspace + its session file
  python3 manual-test-seed.py /path/to/ws --clean

Then in VS Code / Cursor (with the extension installed):
  File > Open Folder... > the workspace dir  →  the Claude Gate panels populate.
"""
import os, sys, json, hashlib, shutil

args   = [a for a in sys.argv[1:] if a != "--clean"]
CLEAN  = "--clean" in sys.argv
WS     = os.path.abspath(os.path.expanduser(args[0])) if args else os.path.expanduser("~/claudegate-manual-test")

home   = os.path.expanduser("~")
norm   = WS.lower() if sys.platform == "win32" else WS          # mirrors SessionManager + hook.py
digest = hashlib.md5(norm.encode()).hexdigest()
spath  = os.path.join(home, ".claudegate", "sessions", f"{digest}.json")

if CLEAN:
    for p, kind in ((spath, os.remove), (WS, shutil.rmtree)):
        if os.path.exists(p):
            kind(p); print(f"removed {p}")
        else:
            print(f"(nothing at {p})")
    sys.exit(0)

# relpath, baseline(None => new file), disk(current/Claude-edited), session_id
S_A, S_B = "manual-test-session-A", "manual-test-session-B"
FILES = [
    # 3 distinct hunks: line 2 MODIFIED, an ADDED block, a DELETED line ->
    # exercises all 3 gutter mark types + 3 per-hunk "Revert this change" lenses.
    ("src/auth.ts",
     'export function login(user, pass) {\n  const token = signJWT(user)\n  // issue the session\n  return token\n  // deprecated fallback\n}\n',
     'export function login(user, pass) {\n  const token = signJWT(user, "HS256")\n  // issue the session\n  if (!user.mfaVerified)\n    throw new Error("MFA required")\n  return token\n}\n',
     S_A),
    # single simple hunk -> basic accept/reject + one lens
    ("src/utils.ts",
     'export function slug(s) {\n  return s.toLowerCase()\n}\n',
     'export function slug(s) {\n  return s.trim().toLowerCase().replace(/\\s+/g, "-")\n}\n',
     S_A),
    # NEW file (originalContent null) -> all-added gutter; Reject deletes it
    ("src/newfeature.ts",
     None,
     'export function ping() {\n  return "pong"\n}\n',
     S_B),
    # PROTECTED (.env) -> warning + sorted to top of review
    (".env",
     'API_URL=https://api.example.com\nDEBUG=false\n',
     'API_URL=https://api.example.com\nDEBUG=false\nSECRET_KEY=sk-live-0000000000\n',
     S_B),
    # EXCLUDED (lock file) -> must NOT appear in the review panels
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
    with open(abs_path, "w") as f:
        f.write(disk)                                    # disk = Claude's edited version
    files_json[abs_path] = {                             # session = pre-edit baseline
        "originalContent": baseline,
        "reviewStatus": "pending",
        "sessionId": sid,
        "capturedAt": "2026-07-05T10:00:00.000000+00:00",
    }

session = {"sessionId": "2026-07-05T10:00:00.000000+00:00", "status": "active", "files": files_json}
with open(spath, "w") as f:
    json.dump(session, f, indent=2)

print(f"workspace : {WS}")
print(f"session   : {spath}")
print(f"seeded    : {len(FILES)} files (4 in-scope pending + 1 excluded lock file)")
print("\nNext: open the workspace folder in VS Code/Cursor with ClaudeGate installed.")
