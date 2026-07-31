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

  # DEMO fixture for recording the README/marketplace GIF — a multi-module
  # go.work layout with real git worktrees and one review session per worktree,
  # so the Pending panel opens already showing parallel-agent work grouped by
  # worktree. Uses generic names only (never a real workspace — see docs/demo-plan.md).
  python3 manual-test-seed.py --demo               # build ~/claudegate-demo
  python3 manual-test-seed.py --demo --clean       # remove it + all its session files

  # after you Accept a file in the panel, simulate Claude touching it again:
  python3 manual-test-seed.py --reedit src/auth.ts     # hook fires + a real change is written
  python3 manual-test-seed.py --noop-edit src/auth.ts  # hook fires but the file is unchanged

Open the workspace folder in VS Code/Cursor (with ClaudeGate installed) to review.
"""
import os, sys, json, hashlib, shutil, subprocess
from datetime import datetime, timedelta, timezone

HOME  = os.path.expanduser("~")
CGDIR = os.path.join(HOME, ".claudegate")
ROOTS = os.path.join(CGDIR, "workspace-roots.json")
HOOK  = os.path.join(CGDIR, "hook.py")

argv = sys.argv[1:]
def flag_value(name):
    return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else None
CLEAN  = "--clean" in argv
DEMO   = "--demo" in argv
REEDIT = flag_value("--reedit")
NOOP   = flag_value("--noop-edit")

# positional workspace = first bare arg not consumed as a flag or a flag's value
consumed = set()
for name in ("--reedit", "--noop-edit"):
    if name in argv:
        i = argv.index(name); consumed.update((i, i + 1))
pos = [a for j, a in enumerate(argv) if j not in consumed and not a.startswith("--")]
WS  = os.path.abspath(os.path.expanduser(pos[0])) if pos else os.path.expanduser("~/claudegate-manual-test")

def session_path_for(ws):
    """Canonical session file for a workspace/worktree root — mirrors
    SessionManager.sessionFilePathFor() and hook.py's workspace_session_file()."""
    p = os.path.abspath(ws)
    norm = p.lower() if sys.platform == "win32" else p
    return os.path.join(CGDIR, "sessions", hashlib.md5(norm.encode()).hexdigest() + ".json")


if DEMO and not pos:
    WS = os.path.expanduser("~/claudegate-demo")
spath = session_path_for(WS)


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


# ── demo fixture (for the README / marketplace GIF) ───────────────────────────
# A go.work-style multi-module layout: three ordinary repos, each with worktrees
# checked out under per-feature directories. This is the shape ClaudeGate is
# uniquely good at and the one the demo sells — two "agents" working in parallel,
# their edits captured into one review session PER WORKTREE, all surfaced in the
# window you open at the top. Every name here is deliberately generic.
DEMO_AGENT_A = "3f9c1e84-2a17-4b6d-9e05-7c4a1d8b2f60"   # working in ws-alpha
DEMO_AGENT_B = "b7e2d05a-6c31-49f8-a1d4-58e903c7b1ae"   # working in ws-beta

DEMO_REPOS = {
    "service-core":   "doc.go",
    "service-api":    "doc.go",
    "service-worker": "doc.go",
}

# (feature dir, repo, branch, agent session,
#  support files committed BEFORE the agent ran (never pending — they exist only
#  so every package compiles cleanly and the editor shows zero squiggles),
#  [(relpath, baseline|None, edited)])
#
# Every Go package below is self-contained and type-checks: a demo with red
# underlines everywhere undercuts exactly the impression the recording is for.
DEMO_WORKTREES = [
    ("ws-alpha", "service-api", "feat/checkout-validation", DEMO_AGENT_A, [
        ("handlers/order.go",
         'package handlers\n\n// Order is the payload Checkout validates and submits.\ntype Order struct {\n\tItems []string\n\tTotal float64\n}\n\nfunc submit(o *Order) error {\n\t_ = o\n\treturn nil\n}\n'),
    ], [
        ("handlers/checkout.go",
         'package handlers\n\nfunc Checkout(o *Order) error {\n\treturn submit(o)\n}\n',
         'package handlers\n\nfunc Checkout(o *Order) error {\n\tif len(o.Items) == 0 {\n\t\treturn ErrEmptyCart\n\t}\n\tif o.Total <= 0 {\n\t\treturn ErrInvalidTotal\n\t}\n\treturn submit(o)\n}\n'),
        ("handlers/errors.go", None,
         'package handlers\n\nimport "errors"\n\nvar (\n\tErrEmptyCart    = errors.New("cart is empty")\n\tErrInvalidTotal = errors.New("order total must be positive")\n)\n'),
        (".env",
         'API_URL=https://api.example.com\n',
         'API_URL=https://api.example.com\nPAYMENT_KEY=sk-live-0000000000\n'),
    ]),
    ("ws-alpha", "service-core", "feat/checkout-validation", DEMO_AGENT_A, [], [
        ("pricing/discount.go",
         'package pricing\n\nfunc Apply(total float64, pct float64) float64 {\n\treturn total - total*pct\n}\n',
         'package pricing\n\nfunc Apply(total float64, pct float64) float64 {\n\tif pct < 0 || pct > 1 {\n\t\tpct = 0\n\t}\n\treturn total - total*pct\n}\n'),
        ("pricing/discount_test.go", None,
         'package pricing\n\nimport "testing"\n\nfunc TestApplyClampsPct(t *testing.T) {\n\tif got := Apply(100, 2); got != 100 {\n\t\tt.Fatalf("want 100, got %v", got)\n\t}\n}\n'),
    ]),
    ("ws-beta", "service-worker", "feat/cache-ttl", DEMO_AGENT_B, [
        ("queue/msg.go",
         'package queue\n\n// Msg is one unit of work pulled off the queue.\ntype Msg struct {\n\tID      string\n\tRetries int\n}\n\nfunc handle(m *Msg) {\n\t_ = m\n}\n'),
    ], [
        ("queue/consumer.go",
         'package queue\n\nfunc Consume(m *Msg) {\n\thandle(m)\n}\n',
         'package queue\n\nfunc Consume(m *Msg) {\n\tif m.Retries > maxRetries {\n\t\tdeadLetter(m)\n\t\treturn\n\t}\n\thandle(m)\n}\n'),
        ("queue/deadletter.go", None,
         'package queue\n\nimport "log"\n\nconst maxRetries = 5\n\nfunc deadLetter(m *Msg) {\n\tlog.Printf("dropping %s after %d retries", m.ID, m.Retries)\n}\n'),
        ("queue/consumer_test.go", None,
         'package queue\n\nimport "testing"\n\nfunc TestConsumeDeadLetters(t *testing.T) {\n\tConsume(&Msg{ID: "m1", Retries: 9})\n}\n'),
    ]),
    ("ws-beta", "service-core", "feat/cache-ttl", DEMO_AGENT_B, [
        ("cache/entry.go",
         'package cache\n\nimport "time"\n\ntype entry struct {\n\tval     []byte\n\texpires time.Time\n}\n\nvar m = map[string]entry{}\n'),
    ], [
        ("cache/store.go",
         'package cache\n\nfunc Get(k string) ([]byte, bool) {\n\te, ok := m[k]\n\treturn e.val, ok\n}\n',
         'package cache\n\nimport "time"\n\nfunc Get(k string) ([]byte, bool) {\n\te, ok := m[k]\n\tif !ok || time.Now().After(e.expires) {\n\t\treturn nil, false\n\t}\n\treturn e.val, true\n}\n'),
        ("cache/ttl.go", None,
         'package cache\n\nimport "time"\n\nconst defaultTTL = 5 * time.Minute\n\n// Put stores v under k with the default expiry.\nfunc Put(k string, v []byte) {\n\tm[k] = entry{val: v, expires: time.Now().Add(defaultTTL)}\n}\n'),
    ]),
]

# Dropped into the demo workspace so it opens ready to record: no language-server
# squiggles (the fixture is a stack of tiny stub modules, and gopls will complain
# about the go.work layout no matter how valid each package is), and none of the
# chrome the shot list asks you to turn off by hand.
DEMO_VSCODE_SETTINGS = {
    "go.useLanguageServer": False,
    "go.lintOnSave": "off",
    "go.vetOnSave": "off",
    "go.buildOnSave": "off",
    "gopls": {"ui.diagnostic.analyses": {}},
    "problems.decorations.enabled": False,
    "editor.minimap.enabled": False,
    "breadcrumbs.enabled": False,
    "editor.renderWhitespace": "none",
    "editor.lightbulb.enabled": "off",
    "git.decorations.enabled": True,
    "workbench.startupEditor": "none",
    "explorer.compactFolders": False,
}

# Static workspace files — not pending, just structure. Each FEATURE directory
# gets its own go.work tying together the module worktrees checked out inside it
# (this mirrors a real multi-module setup, and without it `go`/gopls reject every
# worktree with "directory prefix does not contain modules listed in go.work").
DEMO_STATIC_FILES = [
    ("go.work", 'go 1.22\n\nuse (\n\t./service-core\n\t./service-api\n\t./service-worker\n)\n'),
    ("ws-alpha/go.work", 'go 1.22\n\nuse (\n\t./service-api\n\t./service-core\n)\n'),
]

# Edits that are NOT inside any worktree, so they land in the workspace's own
# session and render alongside the worktree groups. `ws-beta/go.work` is the
# natural one: agent B pulled a second module into its feature workspace.
DEMO_ROOT_FILES = [
    ("ws-beta/go.work",
     'go 1.22\n\nuse (\n\t./service-worker\n)\n',
     'go 1.22\n\nuse (\n\t./service-worker\n\t./service-core\n)\n',
     DEMO_AGENT_B),
    ("README.md",
     '# demo\n\nA multi-module workspace.\n',
     '# demo\n\nA multi-module workspace.\n\n## Layout\n\nEach feature directory holds one git worktree per module:\n\n- `ws-alpha` — checkout validation\n- `ws-beta` — cache TTL\n',
     DEMO_AGENT_A),
    ("Makefile", None,
     'test:\n\tcd ws-alpha/service-core && go test ./...\n\tcd ws-beta/service-worker && go test ./...\n',
     DEMO_AGENT_A),
    ("scripts/release.sh",
     '#!/usr/bin/env bash\nset -e\n\ngo build ./...\n',
     '#!/usr/bin/env bash\nset -euo pipefail\n\ngo build ./...\ngo test ./...\n',
     DEMO_AGENT_A),
    ("CONTRIBUTING.md", None,
     '# Contributing\n\nRun `make test` before opening a pull request.\n',
     DEMO_AGENT_B),
]


def git(cwd, *args):
    subprocess.run(
        ["git", "-c", "user.name=ClaudeGate Demo", "-c", "user.email=demo@example.com",
         "-c", "commit.gpgsign=false", *args],
        cwd=cwd, check=True, capture_output=True, text=True,
    )


def demo_session_roots():
    """Every root that gets its own session file: the workspace + each worktree."""
    return [WS] + [os.path.join(WS, feat, repo) for feat, repo, _, _, _, _ in DEMO_WORKTREES]


def demo_stamp(minutes_ago):
    """A UTC ISO timestamp `minutes_ago` in the past.

    MUST be computed, never hardcoded. mergeFreshCaptures (reviewModel.ts) re-adds
    an on-disk pending entry unless a decision STRICTLY newer than its capturedAt
    supersedes it — so a capture stamped in the future can never be accepted: every
    accept is immediately undone by the next persist's dual-writer merge, the row
    stays in Pending, and clicking again just appends another duplicate record.
    A hardcoded "09:00Z" is in the future for anyone west of UTC+9 in the morning.
    """
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def write_session(root, entries):
    """entries: [(abs_path, baseline|None, session_id)] → write that root's session."""
    sp = session_path_for(root)
    os.makedirs(os.path.dirname(sp), exist_ok=True)
    files = {}
    for abs_path, baseline, sid in entries:
        files[abs_path] = {
            "originalContent": baseline,
            "reviewStatus": "pending",
            "newFile": baseline is None,
            "sessionId": sid,
            "capturedAt": demo_stamp(12),
        }
    json.dump({
        "sessionId": demo_stamp(15),
        "status": "active", "files": files, "accepted": [], "rejected": {},
    }, open(sp, "w"), indent=2)
    return sp


def demo_clean():
    for root in demo_session_roots():
        sp = session_path_for(root)
        if os.path.exists(sp):
            os.remove(sp); print(f"removed session {sp}")
    if os.path.exists(WS):
        shutil.rmtree(WS); print(f"removed workspace {WS}")
    try:
        roots = json.load(open(ROOTS))
        if WS in roots:
            json.dump([r for r in roots if r != WS], open(ROOTS, "w"), indent=2)
            print(f"unregistered {WS} from workspace-roots.json")
    except Exception:
        pass


def demo_seed():
    if shutil.which("git") is None:
        sys.exit("error: git is required to build the demo fixture")
    if os.path.exists(WS):
        sys.exit(f"error: {WS} already exists — run with --demo --clean first")

    os.makedirs(WS)
    os.makedirs(os.path.join(WS, ".vscode"))
    json.dump(DEMO_VSCODE_SETTINGS,
              open(os.path.join(WS, ".vscode", "settings.json"), "w"), indent=2)

    # 1. Three ordinary repos, each with one committed placeholder + go.mod.
    for repo, seed_rel in DEMO_REPOS.items():
        rd = os.path.join(WS, repo)
        os.makedirs(rd, exist_ok=True)
        open(os.path.join(rd, seed_rel), "w").write(
            f"// Package {repo.replace('-', '')} is a demo module.\npackage {repo.replace('-', '')}\n")
        open(os.path.join(rd, "go.mod"), "w").write(f"module example.com/{repo}\n\ngo 1.22\n")
        git(rd, "init", "-q", "-b", "main")
        git(rd, "add", "-A")
        git(rd, "commit", "-q", "-m", "initial commit")

    # 2. A worktree per (feature dir, repo) — the layout the demo is about.
    for feat, repo, branch, _sid, support, edits in DEMO_WORKTREES:
        target = os.path.join(WS, feat, repo)
        os.makedirs(os.path.join(WS, feat), exist_ok=True)
        git(os.path.join(WS, repo), "worktree", "add", "-q", "-b", branch, target)

        # Support files + baselines are committed BEFORE the agent's edits, so the
        # pending diff is exactly the edit (not "whole file added") and every
        # package still compiles — a demo full of red squiggles sells nothing.
        for rel, content in support:
            ap = os.path.join(target, rel)
            os.makedirs(os.path.dirname(ap), exist_ok=True)
            open(ap, "w").write(content)
        for rel, baseline, _edited in edits:
            if baseline is None:
                continue
            ap = os.path.join(target, rel)
            os.makedirs(os.path.dirname(ap), exist_ok=True)
            open(ap, "w").write(baseline)
        git(target, "add", "-A")
        git(target, "commit", "-q", "-m", "baseline before agent run")

    # 3. Apply each agent's edits on disk + record the pre-edit baseline in that
    #    worktree's own session file (what the PreToolUse hook would have done).
    total = 0
    for feat, repo, _branch, sid, _support, edits in DEMO_WORKTREES:
        target = os.path.join(WS, feat, repo)
        entries = []
        for rel, baseline, edited in edits:
            ap = os.path.join(target, rel)
            os.makedirs(os.path.dirname(ap), exist_ok=True)
            open(ap, "w").write(edited)
            entries.append((ap, baseline, sid))
        write_session(target, entries)
        total += len(entries)

    # 4. Static structure (per-feature go.work files), then the root-level edits,
    #    which land in the workspace's own session.
    for rel, content in DEMO_STATIC_FILES:
        ap = os.path.join(WS, rel)
        os.makedirs(os.path.dirname(ap), exist_ok=True)
        open(ap, "w").write(content)

    root_entries = []
    for rel, baseline, edited, sid in DEMO_ROOT_FILES:
        ap = os.path.join(WS, rel)
        os.makedirs(os.path.dirname(ap), exist_ok=True)
        open(ap, "w").write(edited)
        root_entries.append((ap, baseline, sid))
    write_session(WS, root_entries)
    total += len(root_entries)

    ensure_root_registered(WS)

    print(f"demo workspace : {WS}")
    print(f"sessions       : {len(demo_session_roots())} "
          f"(1 workspace + {len(DEMO_WORKTREES)} worktrees)")
    print(f"pending files  : {total}  across 2 agent sessions")
    print(f"                 agent A {DEMO_AGENT_A[:8]} → ws-alpha")
    print(f"                 agent B {DEMO_AGENT_B[:8]} → ws-beta")
    print(f"\nOpen this folder in VS Code/Cursor with ClaudeGate installed:")
    print(f"  code {WS}")
    print("Then follow docs/demo-plan.md for the shot list.")
    print(f"\nTear down with: python3 manual-test-seed.py --demo --clean")


if DEMO:
    demo_clean() if CLEAN else demo_seed()
    sys.exit(0)

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
        "newFile": baseline is None,   # mirror the hook: confident-new ⇒ reject deletes
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
