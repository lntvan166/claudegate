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
import bisect
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
EXCLUDES_FILE = os.path.join(CLAUDEGATE_DIR, "excludes.json")

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


# ── claudegate.exclude ───────────────────────────────────────────────────────
# The extension writes each window's active `claudegate.exclude` globs to
# excludes.json, keyed by workspace root (src/excludeSync.ts). An excluded file
# is skipped BEFORE it is read, so it never lands in the session at all. Before,
# exclude was display-only: the entry was captured in full and merely hidden.
#
# The matching below is a port of src/excludeMatcher.ts and must stay in step
# with it — hooks/tests/exclude_cases.json is run against both.

def glob_to_regex(glob: str) -> str:
    """Port of globToRegExp: `**` crosses separators (and eats a following `/`),
    `*` and `?` stay inside one segment. Returns an unanchored pattern string."""
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


def is_excluded(file_path: str, root: str, globs: list) -> bool:
    """Port of ExcludeMatcher.isExcluded: test the absolute path, the
    root-relative path and each ancestor directory of it, so a glob naming a
    folder (`.superpowers/sdd`, `**/dist`) excludes everything inside."""
    patterns = []
    for glob in globs:
        if not isinstance(glob, str):
            continue
        try:
            patterns.append(re.compile(glob_to_regex(glob)))
        except re.error:
            continue  # an invalid glob excludes nothing, as in the extension
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


_excludes_cache = None


def excludes_for_root(workspace_root: str) -> list:
    """The globs registered for `workspace_root` (already normcased/abspath'd by
    workspace_root_for_file). Read once per hook run — a Bash command can carry
    many candidates. Any problem with the file means no excludes (fail open:
    capture, and let the extension hide the row as it always has)."""
    global _excludes_cache
    if _excludes_cache is None:
        _excludes_cache = {}
        try:
            with open(EXCLUDES_FILE, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                for root, globs in data.items():
                    if isinstance(root, str) and isinstance(globs, list):
                        key = os.path.normcase(os.path.abspath(root))
                        _excludes_cache[key] = [g for g in globs if isinstance(g, str)]
        except (OSError, ValueError):
            pass
    return _excludes_cache.get(workspace_root, [])


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
        # This hook never captures an excluded file, so a session it creates has
        # no hidden backlog for the extension's one-time sweep to clear.
        "excludeCleanupDone": True,
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
_BAD_CHARS   = frozenset("$`*?!<>|;\"'()[]{}\n\t\\%")
# `C:/x` is the one colon a path may carry; `HEAD~1:f.go`, `prod:k.txt` and
# `host:/tmp/x` are git revisions and scp remotes, never local files.
_DRIVE_RE    = re.compile(r"^[A-Za-z]:[\\/]")
# `..` that is not a whole path segment: a git range (`base..HEAD`).
_RANGE_RE    = re.compile(r"[^/]\.\.|\.\.[^/]")
_EXT_RE      = re.compile(r"\.[A-Za-z][A-Za-z0-9_+-]{0,9}$")
# Extensions a speculative, not-yet-existing candidate may carry. Deliberately
# broad across languages and config formats — a missing entry here only costs a
# capture when the file is also new — and deliberately free of the scratch
# suffixes (`.tmp`, `.bak`, `.orig`) that name a file about to be renamed.
_KNOWN_EXTS = frozenset("""
    go mod sum work proto py pyi ipynb js jsx mjs cjs ts tsx mts cts vue svelte astro
    json jsonc json5 yaml yml toml ini cfg conf env properties xml xsd plist
    md mdx markdown txt rst adoc org csv tsv sql graphql gql prisma
    sh bash zsh fish ps1 psm1 bat cmd
    html htm css scss sass less styl
    java kt kts scala groovy gradle clj cljs edn ex exs erl hrl elm hs ml mli fs fsx
    rb rake gemspec php pl pm r rmd jl lua dart swift m mm c h cc cpp cxx hpp hh hxx
    cs csproj sln vb rs zig nim v sol
    tf tfvars hcl nix cmake mk make dockerfile containerfile
    tmpl tpl j2 jinja jinja2 hbs mustache ejs erb
    feature snap lock log patch diff svg ics service timer socket desktop
    """.split())
_KNOWN_DOTFILES = frozenset("""
    env envrc gitignore gitattributes gitmodules dockerignore editorconfig
    npmrc nvmrc yarnrc prettierrc prettierignore eslintrc eslintignore babelrc
    bashrc zshrc profile vimrc tmux.conf golangci
    """.split())
_KNOWN_BARE_NAMES = frozenset({
    "Makefile", "GNUmakefile", "Dockerfile", "Containerfile", "Jenkinsfile",
    "Procfile", "Gemfile", "Rakefile", "Vagrantfile", "Brewfile", "Justfile",
    "justfile", "LICENSE", "README", "CODEOWNERS", "OWNERS",
})
# `s/old/new/g`, `y|a|b|` — a sed script, not a path.
_SED_EXPR_RE = re.compile(r"^[0-9,]*[sy]([^\w\s])")


def _lex(text: str) -> list:
    """Quote-aware shell-ish lexer. Returns [(kind, value, offset)] with kind in
    {"word", "sep", "redir"}. Quotes are stripped and their contents joined onto
    the surrounding word, so `p='a/b.go'` lexes as one word `p=a/b.go`.

    `offset` is where the token starts in `text`. It exists so a candidate found
    by a regex over the raw text — a redirection target, a quoted literal inside
    a heredoc — can be attributed to the command segment it sits in, and so pick
    up that segment's working directory."""
    tokens: list = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r":
            i += 1
            continue
        start = i
        if c in _SEP_CHARS:
            while i < n and text[i] in _SEP_CHARS:
                i += 1
            tokens.append(("sep", "", start))
            continue
        if c in _REDIR_CHARS:
            while i < n and text[i] in _REDIR_CHARS:
                i += 1
            # `2>&1`, `<&0`, `>&-` duplicate a descriptor. The `&` is not a
            # separator — splitting on it put a heredoc opened after `2>&1`
            # into a segment whose only word was `1`, and dropped its body —
            # and nothing here names a file, so it leaves no token at all.
            if i + 1 < n and text[i] == "&" and (text[i + 1].isdigit() or text[i + 1] == "-"):
                i += 2
                while i < n and text[i].isdigit():
                    i += 1
                continue
            tokens.append(("redir", "", start))
            continue
        buf: list = []
        while i < n:
            c = text[i]
            if c in " \t\r" or c in _SEP_CHARS or c in _REDIR_CHARS:
                break
            if c == "\\":
                # An escaped character is literal. Line continuation drops both.
                if i + 1 < n and text[i + 1] != "\n":
                    buf.append(text[i + 1])
                i += 2
                continue
            if c == "'":
                j = text.find("'", i + 1)
                if j == -1:  # unbalanced quote: take the rest and stop
                    buf.append(text[i + 1:])
                    i = n
                    break
                buf.append(text[i + 1:j])
                i = j + 1
                continue
            if c == '"':
                i = _lex_double_quoted(text, i + 1, buf)
                continue
            buf.append(c)
            i += 1
        tokens.append(("word", "".join(buf), start))
    return tokens


def _lex_double_quoted(text: str, i: int, buf: list) -> int:
    """Append the body of a double-quoted string starting at `i` (just past the
    opening quote) to `buf`; return the index past the closing quote.

    `\\"` does not end the string. Treating it as the end is what turned
    `sed -i "s/\\"a b c\\"/\\"d e\\"/" f.py` into the "words" `a`, `b`, `c`,
    `d`, `e` — each captured as a file — while the real target `f.py` was lost
    in the misaligned tail."""
    n = len(text)
    while i < n:
        c = text[i]
        if c == '"':
            return i + 1
        if c == "\\" and i + 1 < n and text[i + 1] in '"\\$`':
            buf.append(text[i + 1])
            i += 2
            continue
        buf.append(c)
        i += 1
    return n  # unbalanced quote: took the rest


def _segments(tokens: list) -> list:
    """Split lexed tokens into command segments, as [(words, offset)] where
    offset is where the segment starts in the original text. The word following
    a redirection operator is dropped — `patch < fix.diff` reads that file, and
    `> out` targets are harvested separately by _redirect_targets."""
    segs: list = []
    cur: list = []
    cur_start = 0
    skip_next = False
    for kind, value, pos in tokens:
        if kind == "sep":
            if cur:
                segs.append((cur, cur_start))
            cur, skip_next = [], False
        elif kind == "redir":
            skip_next = True
        else:
            if skip_next:
                skip_next = False
                continue
            if not cur:
                cur_start = pos
            cur.append(value)
    if cur:
        segs.append((cur, cur_start))
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
    if tok != tok.strip():                         # ` None/d` — a fragment of a script
        return False
    if ":" in tok and not _DRIVE_RE.match(tok):    # rev:path, host:path, `key:`
        return False
    if _RANGE_RE.search(tok):                      # base..HEAD, a..b
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

    So a speculative candidate is kept when EITHER
      * it already exists on disk, which makes any real file a legitimate
        baseline, extensionless (`scripts/build`) or oddly named; or
      * its basename is a kind of file people write (`manager/biz/rule.go`,
        `Dockerfile`; see _known_file_name) — this is what keeps not-yet-created
        files capturable, the whole point of recording `originalContent: null`.
    """
    # An absolute path is checkable on its own; only a relative one needs to know
    # which directory it hangs off.
    if os.path.isabs(tok) or cwd:
        try:
            if os.path.isfile(tok if os.path.isabs(tok) else os.path.join(cwd, tok)):
                return True
        except (OSError, ValueError):
            pass
    if any(c.isspace() for c in tok):  # prose: `handler.GetThing → repo.Load`
        return False
    return _known_file_name(os.path.basename(tok))


def _known_file_name(base: str) -> bool:
    """Is this basename recognisably a file, without looking at the disk?

    "Has an extension" was the old test, and in a heredoc full of code it is no
    test at all: `ASvc.GetThing`, `filepath.SkipDir`, `strings.Builder`,
    `acme.order.ops` and `build.dev` all have one. A not-yet-existing file is only
    worth baselining if it is a kind of file people actually write, so the
    extension must be a known one. A file that exists already passed above,
    whatever its name."""
    m = _EXT_RE.search(base)
    if not m:
        return base in _KNOWN_BARE_NAMES
    ext = m.group(0)[1:]
    if not (ext.islower() or ext.isupper()):  # `frame.Ts`, `ASvc.GetThing`
        return False
    ext = ext.lower()
    if m.start() == 0:  # a dotfile: `.envrc` is a name, `.go` is a suffix
        return ext in _KNOWN_DOTFILES
    return ext in _KNOWN_EXTS


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
    """[(literal, offset)] — the offset attributes the literal to its segment."""
    out: list = []
    for pattern in (_SQ_LITERAL_RE, _DQ_LITERAL_RE):
        for m in pattern.finditer(text):
            out.append((m.group(1), m.start(1)))
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
        # `git checkout .` / a branch name names no file. A branch switch
        # brings in other people's changes: never a capture (_implicit_op).
        named = [a for a in rest if not a.startswith("-") and _pathspec_shaped(a)]
        return named or None
    # `stash pop/apply` and `reset --hard` rewrite the tree without naming a
    # file: history operations, logged by _implicit_op and never captured.
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
    if name == "sd":
        return _sd_targets(args)
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
                if name in _SCRIPT_TOOLS:
                    return _script_tool_files(name, args)
                return [x for x in args if not x.startswith("-")]
    return None


def _strip_prefix(words: list) -> list:
    """`words` without leading wrappers (`sudo`, `env`, …) and `VAR=value`."""
    while words:
        head = words[0]
        if head in _WRAPPERS:
            words = words[1:]
            continue
        name, _, _ = head.partition("=")
        if "=" in head and not head.startswith("-") and name.isidentifier():
            words = words[1:]
            continue
        break
    return words


# Commands that bring in OTHER people's changes, or rewrite many files without
# naming them. The maintainer's rule: a capture means "Claude changed this file
# and the user should review it", so these never create a pending entry. They
# are logged as `skip-implicit <cmd> <sub>` so the gap stays visible.
_IMPLICIT_GIT = frozenset({"pull", "merge", "rebase", "cherry-pick", "revert", "switch"})
_CODEGEN = frozenset({"protoc", "sqlc", "swag", "buf", "make", "gmake"})


def _implicit_op(words: list):
    """A short label (`git pull`, `make gen`, `tar -xzf`) when this segment is a
    never-capture operation, else None."""
    words = _strip_prefix(words)
    if not words:
        return None
    name = os.path.basename(words[0])
    args = words[1:]
    if name == "git":
        idx = 0
        while idx < len(args) and args[idx].startswith("-"):
            idx += 2 if args[idx] in ("-C", "-c") else 1
        if idx >= len(args):
            return None
        sub, rest = args[idx], args[idx + 1:]
        hit = (sub in _IMPLICIT_GIT
               or (sub == "stash" and rest[:1] in (["pop"], ["apply"]))
               or (sub == "reset" and "--hard" in rest)
               or (sub == "checkout" and "--" not in rest
                   and not any(not a.startswith("-") and _pathspec_shaped(a) for a in rest)))
        return "git " + sub if hit else None
    if name == "go":
        return "go generate" if args[:1] == ["generate"] else None
    if name in _CODEGEN or name == "unzip":
        return (name + " " + args[0]) if args else name
    if name == "tar" and args:
        first = args[0]
        extracts = (("x" in first and not first.startswith("-"))
                    or any(re.match(r"^-[a-zA-Z]*x", a) or a in ("--extract", "--get")
                           for a in args))
        return ("tar " + first) if extracts else None
    return None


_RM_RECURSIVE_RE = re.compile(r"^-[a-zA-Z]*[rR]")
# Characters the shell would expand. There is no glob expansion here, so an
# operand carrying one names no file we can snapshot: it is logged instead.
_GLOB_CHARS = frozenset("*?[{")
# Files one recursive delete may capture. Past it the directory is logged as
# `skip-too-many` and nothing in it is captured: a review panel of 400 deleted
# build outputs helps nobody, and the walk must stay off the hot path.
RM_WALK_CAP = 50
# Directory entries a walk may look at before giving up, whatever it finds.
_WALK_ENTRY_CAP = 2000


def _deletion(words: list):
    """`(recursive, operands)` for `rm` / `git rm`, else None. `git rm
    --cached` only unstages — nothing leaves the disk — so it is None too."""
    words = _strip_prefix(words)
    if not words:
        return None
    name = os.path.basename(words[0])
    args = words[1:]
    if name == "git":
        idx = 0
        while idx < len(args) and args[idx].startswith("-"):
            idx += 2 if args[idx] in ("-C", "-c") else 1
        if idx >= len(args) or args[idx] != "rm":
            return None
        args = args[idx + 1:]
        if "--cached" in args:
            return None
    elif name != "rm":
        return None
    recursive = False
    operands: list = []
    options_done = False
    for a in args:
        if not options_done and a == "--":
            options_done = True
            continue
        if a.startswith("#"):
            break                         # a shell comment: `rm a.go # old`
        if not options_done and a.startswith("-") and a != "-":
            if _RM_RECURSIVE_RE.match(a) or a == "--recursive":
                recursive = True
            continue
        operands.append(a)
    return recursive, operands


def _walk_files(top: str):
    """`(files, overflow)` — the regular files under `top`, never following a
    symlink and never entering `.git`. `overflow` is True, and the walk stops
    at once, when there are more than RM_WALK_CAP files or the walk has looked
    at _WALK_ENTRY_CAP entries."""
    files: list = []
    stack = [top]
    looked = 0
    while stack:
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                looked += 1
                if looked > _WALK_ENTRY_CAP:
                    return files, True
                if e.name == ".git":
                    continue
                try:
                    if e.is_symlink():
                        continue
                    if e.is_dir(follow_symlinks=False):
                        stack.append(e.path)
                    elif e.is_file(follow_symlinks=False):
                        files.append(e.path)
                        if len(files) > RM_WALK_CAP:
                            return files, True
                except OSError:
                    continue
    return sorted(files), False


def _touches_git_dir(path: str) -> bool:
    return ".git" in path.replace("\\", "/").split("/")


# `sd [OPTIONS] FIND REPLACE [FILES...]` edits FILES in place — unlike sed it
# needs no flag to do so — and with no FILES it filters stdin. `-p`/`--preview`
# prints the result instead of writing. Without this entry an `sd` edit counted
# as a write only when something else in the command happened to look like one.
_SD_VALUE_FLAGS = frozenset({"-f", "--flags", "-n", "--max-replacements"})


def _sd_targets(args: list):
    operands: list = []
    skip = False
    options_done = False
    for a in args:
        if skip:
            skip = False
            continue
        if not options_done and a == "--":
            options_done = True
            continue
        if not options_done and a.startswith("-") and a != "-":
            if a in ("-p", "--preview"):
                return None
            if a in _SD_VALUE_FLAGS:
                skip = True
            continue
        operands.append(a)
    files = operands[2:]
    return files if files else None


# sed and perl take a script, not just files: `sed -i 's/a/b/' f`. Passing the
# script on as a target is what captured ` None/d` out of
# `sed -i '/    srv_board = None/d' tests/test_app.py`.
_SCRIPT_TOOLS = {
    # flags whose NEXT argument is a script or script file
    "sed":  re.compile(r"^(?:-[a-zA-Z]*[ef]|--expression|--file)$"),
    "perl": re.compile(r"^-[a-zA-Z]*e$"),
}


def _script_tool_files(name: str, args: list) -> list:
    """The file operands of a sed/perl invocation. With an explicit `-e`/`-f`
    the scripts ride on those flags; without one, the first operand is the
    script (sed only — perl without `-e` takes a script FILE, not a target)."""
    takes_script = _SCRIPT_TOOLS[name]
    files: list = []
    explicit = False
    skip = False
    for a in args:
        if skip:
            skip = False
            continue
        if a.startswith("-"):
            if takes_script.match(a):
                explicit = skip = True
            elif a.startswith(("--expression=", "--file=")):
                explicit = True
            continue
        files.append(a)
    if not explicit and files:
        files = files[1:]
    return files


# `<<EOF`, `<<-'EOF'`, `<<"EOF"` — the delimiter that ends the body.
_HEREDOC_RE = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
# How many heredoc bodies we bother to map. Mapping them is linear in the text
# (each closer search resumes where the last body ended), so this is a sanity
# bound rather than a hot limit; the extras simply keep their `cd` tracking.
_MAX_HEREDOCS = 256


def _heredocs(text: str) -> list:
    """`[(op, start, end)]` for every heredoc: `op` is where its `<<` operator
    sits in `text`, `start`/`end` bound its BODY. Ordered, non-overlapping.

    A heredoc body is data, not shell. Plans and docs get written with
    `cat >> plan.md <<'PLAN'`, and their bodies quote shell examples — one real
    command carried seven `cd svc-lib` lines of prose. Honouring those as
    directory changes stacked them up and sent every later candidate into
    `<root>/svc-lib/svc-lib/...`, turning captures that had been correct into
    phantoms. So no body ever steers the working directory: anything harvested
    from one resolves against the directory in force where it was opened.

    Whether a body is harvested at all depends on what it feeds — see
    _heredoc_runs_code. `op` is what lets that be answered.
    """
    out: list = []
    matches: list = []
    for m in _HEREDOC_RE.finditer(text):
        matches.append(m)
        if len(matches) > 4 * _MAX_HEREDOCS:
            break
    pos = 0
    k = 0
    while k < len(matches) and len(out) < _MAX_HEREDOCS:
        m = matches[k]
        if m.start() < pos:      # inside a body we already mapped
            k += 1
            continue
        nl = text.find("\n", m.end())
        if nl == -1:
            break                # no body follows this or any later operator
        # `cat > a.md <<A; python3 - <<B` — every operator on the line opens a
        # body, and the bodies follow one after another in the same order.
        group = [m]
        k += 1
        while k < len(matches) and matches[k].start() < nl:
            group.append(matches[k])
            k += 1
        body = nl + 1
        for g in group:
            closer = re.compile(r"^[ \t]*" + re.escape(g.group(2)) + r"[ \t]*$", re.M)
            found = closer.search(text, body)
            # An unterminated heredoc runs to the end of the command — it is
            # still a body, and must still not steer the working directory.
            end = found.start() if found else len(text)
            if end > body and len(out) < _MAX_HEREDOCS:
                out.append((g.start(), body, end))
            if not found:
                body = len(text)
                break
            body = min(found.end() + 1, len(text))
        pos = body
    return out


# Programs that EXECUTE what arrives on stdin, so a heredoc fed to one is code
# that runs and may write files: `python3 - <<EOF`, `node <<EOF`, `bash -s
# <<EOF`. A version suffix is allowed (`python3.12`, `ruby3.3`, `lua5.4`). Any
# other consumer — `cat`/`tee` writing a file, `psql`, `git commit -F -`,
# `kubectl apply -f -` — takes the body as data: nothing in it can be a write
# target, and harvesting it is what turned `home.join("cg/excludes.json")` in a
# test file being written by `cat > x.rs <<EOF` into a pending entry.
_INTERPRETER_RE = re.compile(
    r"^(?:python|pypy|ipython|node|nodejs|deno|bun|ts-node|tsx|ruby|perl|php|"
    r"lua|luajit|bash|sh|zsh|dash|ksh|mksh|fish|Rscript|julia|tclsh|groovy|"
    r"pwsh|powershell|osascript)(?:[0-9]+(?:\.[0-9]+)*)?(?:\.exe)?$"
)
# The interpreters whose body is itself shell, and so can be scanned as a
# command of its own: its `sed -i f`, `> f` are explicit targets.
_SHELL_INTERPRETER_RE = re.compile(r"^(?:bash|sh|zsh|dash|ksh|mksh)(?:[0-9]+(?:\.[0-9]+)*)?$")
# Commands that run a script FILE named by their argument, for the
# write-then-run shape below. (`./gen.sh` is caught separately.)
_RUNS_FILE = frozenset({"source", "."})
# Words that may stand between the start of a segment and the interpreter it
# runs: `sudo -u svc python3`, `uv run python`, `timeout 30 node`. Interpreter
# detection walks past these (and flags, and a flag's value) and stops at the
# first word that is none of them, so `cat notes python3` is not python.
_RUNNERS = frozenset("""
    sudo doas env nohup time timeout nice ionice stdbuf setsid exec command
    chrt taskset unbuffer xvfb-run systemd-run uv uvx run poetry pipenv pdm rye
    hatch npx pnpm pnpx yarn bunx dotenv direnv ! { do then else elif if while until
    """.split())
_DURATION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+)?[smhd]?$")
# A pipeline stage that turns its stdin into FILE NAMES for a writer: the body
# of `xargs sed -i … <<EOF` or `cat <<EOF | while read f; do gofmt -w "$f"` is
# a list of the files about to be rewritten.
_LIST_CONSUMERS = frozenset({"xargs", "parallel"})
# Writers whose stdin is the CONTENT they write, not names: their heredoc stays
# data (`tee out.md <<EOF`).
_CONTENT_WRITERS = frozenset({"tee", "sponge"})


def _pipelines(tokens: list, text: str):
    """Group the shell tokens into pipelines of command words.

    Returns (pipelines, where): `pipelines` is a list of pipelines, each a list
    of segments, each segment a list of `(word, offset)`; `where[i]` is the
    `(pipeline, segment)` token i belongs to. Like _segments, the word after a
    redirection operator is not a command word. Unlike _segments, `|` does not
    end the pipeline: `cat <<EOF | python3` feeds python, not cat."""
    pipelines: list = [[[]]]
    where: list = []
    skip_next = False
    for kind, value, pos in tokens:
        if kind == "sep":
            end = pos
            while end < len(text) and text[end] in _SEP_CHARS:
                end += 1
            op = text[pos:end].replace("\n", "")
            if op in ("|", "|&"):
                pipelines[-1].append([])
            else:
                pipelines.append([[]])
            skip_next = False
        elif kind == "redir":
            skip_next = True
        elif skip_next:
            skip_next = False
        else:
            pipelines[-1][-1].append((value, pos))
        where.append((len(pipelines) - 1, len(pipelines[-1]) - 1))
    return pipelines, where


def _base(w: str) -> str:
    """`os.path.basename` for a shell word, without its per-call overhead —
    this runs on every word of every segment of a command with a heredoc."""
    return w[w.rfind("/") + 1:]


def _cmd_word(w: str) -> str:
    """`(python3`, `$(python3`, `` `python3 `` → `python3`. The lexer does not
    split on a subshell or substitution opener, so it arrives glued on."""
    while w:
        if w.startswith("$("):
            w = w[2:]
        elif w[0] in "(`":
            w = w[1:]
        else:
            break
    return w


def _segment_runs_code(words: list):
    """Does this command segment execute its stdin? "shell" when a local shell
    runs it as a script, True for any other interpreter, False when nothing
    does, None when the command cannot be determined (`$PY - <<EOF`,
    `OUT=$(python3 - <<EOF`, an empty segment)."""
    names = [w for w, _ in words]
    i = 0
    while i < len(names):
        m = _ASSIGN_RE.match(names[i])
        if not m:
            break
        # `OUT=$(python3 - <<EOF` — the command is inside the substitution.
        if "$(" in m.group(2) or "`" in m.group(2):
            return None
        i += 1
    names = names[i:]
    # `echo $(python3 - <<EOF …)` — a command substitution runs its own
    # command, wherever it sits in the segment: judge from there.
    for k, w in enumerate(names):
        if "$(" in w or "`" in w:
            if w.startswith(("$(", "`", "($(")):
                names = names[k:]
                break
            if k > 0:
                return None             # `x$(cmd` — glued on, cannot tell
    names = [_cmd_word(w) for w in names]
    if not names or not names[0] or any(c in names[0] for c in "$`"):
        return None
    value_next = False
    # `strict` holds while every word so far is a runner, a flag or a value we
    # know. A word we do not know (`conda run -n env python -`, `flock /tmp/l
    # python3 -`, `mise exec -- python3 -`) does not end the search: runners
    # are an open set, and an interpreter later in the segment still harvests.
    # It does end the "shell" verdict, whose explicit targets need certainty.
    strict = True
    for k, w in enumerate(names):
        base = _base(w)
        # A remote runner means the body runs elsewhere: `ssh host 'bash -s'`.
        if base in _REMOTE_RUNNERS:
            return False
        if _INTERPRETER_RE.match(base) or (base == "R" and k == 0):
            if not strict or not _SHELL_INTERPRETER_RE.match(base):
                return True
            # A shell reads stdin as its script only with no script of its
            # own: `bash -s`, bare `bash`. `bash deploy.sh <<EOF` hands the
            # body to deploy.sh — still code we cannot see, so harvested, but
            # not scanned as shell.
            rest = names[k + 1:]
            if "-s" in rest:
                return "shell"
            if any(re.match(r"^-[a-z]*c", a) or not a.startswith("-") for a in rest):
                return True
            return "shell"
        if w.startswith("-"):
            value_next = "=" not in w
            continue
        if (base in _RUNNERS or base in _WRAPPERS or _DURATION_RE.match(w)
                or _ASSIGN_RE.match(w)):    # `env FOO=1 python3`
            value_next = False
            continue
        if value_next:              # `sudo -u svc`, `nice -n 5`
            value_next = False
            continue
        strict = False
    return False


def _feeds_file_list(words: list) -> bool:
    """Does this segment read its stdin as a list of files to write?
    `xargs sed -i …`, `parallel gofmt -w`, `while read f`, or a writer that
    takes file operands (`sed -i … <<EOF` is harmless to harvest)."""
    names = [_cmd_word(w) for w, _ in words]
    if not names:
        return False
    if any(_base(w) in _LIST_CONSUMERS for w in names):
        return True
    if names[0] == "while" and "read" in names:
        return True
    plain = [w for w, _ in words]
    stripped = [w for w in plain if w not in _WRAPPERS and not _ASSIGN_RE.match(w)]
    if stripped and _base(stripped[0]) in _CONTENT_WRITERS:
        return False
    return _tool_targets(plain) is not None


def _heredoc_runs_code(tokens: list, text: str, heredocs: list) -> list:
    """For each heredoc, should its body be harvested? "shell" when a local
    shell runs it, True when other code runs it or we cannot tell, else False.

    A body is harvested when
      * a command in its pipeline, from the one it feeds onward, is an
        interpreter (`python3 - <<EOF`, `cat <<EOF | bash`);
      * it is a list of files for a writer: the redirect of a loop's `done`,
        or a pipeline through `xargs`, `parallel`, `while read`, or an
        in-place tool (`cat <<EOF | xargs sed -i …`);
      * the file it is written to is run later in the same command
        (`cat > gen.py <<EOF … EOF` then `python3 gen.py`) — the body still
        executes, just one step removed; or
      * the feeding command cannot be determined. A missed capture is worse
        than a phantom, so doubt keeps the old behaviour."""
    if not heredocs:
        return []
    pipelines, where = _pipelines(tokens, text)
    offsets = [pos for _k, _v, pos in tokens]
    # Everything below is one linear pass, computed once: a command can carry
    # hundreds of heredocs and thousands of segments, and asking each heredoc
    # to walk the rest of the command was quadratic (350 ms on a 64 KiB input).
    #
    # verdict_from[p][s] — the first non-False verdict at or after segment s
    # of pipeline p: what a heredoc feeding segment s flows into. Built only
    # for the pipelines that hold a heredoc.
    verdict_from: dict = {}

    def verdicts(p: int) -> list:
        if p not in verdict_from:
            pipeline = pipelines[p]
            acc = False
            suffix = [False] * len(pipeline)
            for s in range(len(pipeline) - 1, -1, -1):
                runs = _segment_runs_code(pipeline[s])
                if runs is None:
                    acc = True
                elif runs:
                    acc = runs
                elif _feeds_file_list(pipeline[s]):
                    acc = True
                suffix[s] = acc
            verdict_from[p] = suffix
        return verdict_from[p]

    # order[(p, s)] — the segment's position in the whole command; last_run[b]
    # — the last position at which a segment runs a script named b; seg_tokens
    # — each segment's own tokens. Built on first need: only a heredoc nothing
    # runs directly asks whether its file is run later.
    order: dict = {}
    last_run: dict = {}
    seg_tokens: dict = {}

    def index() -> None:
        if order:
            return
        for p, pipeline in enumerate(pipelines):
            for s, seg in enumerate(pipeline):
                order[(p, s)] = len(order)
                for f in _scripts_run_by([w for w, _ in seg]):
                    last_run[_base(f)] = order[(p, s)]
        for tok, at in zip(tokens, where):
            seg_tokens.setdefault(at, []).append(tok)

    out: list = []
    for op, _start, _end in heredocs:
        i = bisect.bisect_right(offsets, op) - 1
        # The `<<` must be a redirection token. Matched inside a quoted word
        # (`python3 -c "x <<EOF"`) it is not a heredoc we can attribute.
        if i < 0 or tokens[i][0] != "redir":
            out.append(True)
            continue
        p, s = where[i]
        seg = pipelines[p][s]
        # `while read f; do sed -i … "$f"; done <<EOF` — the loop's input.
        if seg and _cmd_word(seg[0][0]) == "done":
            out.append(True)
            continue
        verdict = verdicts(p)[s]
        if not verdict:
            # Written to a file that a later segment runs as its script. The
            # file may be written anywhere along the pipeline: `cat <<EOF |
            # tee gen.py`.
            index()
            if not last_run:            # nothing in the command runs a script
                out.append(False)
                continue
            names: set = set()
            for t in range(s, len(pipelines[p])):
                names |= {_base(x)
                          for x, _ in _redirect_targets(seg_tokens.get((p, t), []), text)}
                names |= {_base(a)
                          for a in (_tool_targets([w for w, _ in pipelines[p][t]]) or [])}
            names.discard("")
            last = order[(p, len(pipelines[p]) - 1)]
            verdict = any(last_run.get(n, -1) > last for n in names)
        out.append(verdict)
    return out


# Extensions of a file an interpreter runs as its script. With these, a file
# named later in the argument list still counts as the script — an option's
# value may stand first (`node --import ./register.mjs bench.mjs`).
_SCRIPT_EXTS = frozenset("""
    py js mjs cjs ts mts cts sh bash zsh rb pl php lua r jl tcl groovy ps1
    """.split())
_MAKEFILES = ("Makefile", "makefile", "GNUmakefile")
# Commands that only read, move or stage a file. Naming the written file does
# not run it: `cat > gen.py <<EOF … EOF; git add gen.py` leaves the body data.
_NEVER_RUNS = frozenset("""
    cat head tail less more wc grep rg egrep fgrep diff cmp git chmod chown ls
    stat file rm mv cp ln echo printf sed awk jq yq bat code vim vi nano
    touch install mkdir realpath readlink basename dirname sha256sum md5sum
    shellcheck ruff black prettier eslint gofmt tsc mypy pyright
    """.split())


def _has_script_ext(a: str) -> bool:
    return os.path.splitext(a)[1][1:].lower() in _SCRIPT_EXTS


def _scripts_run_by(words: list) -> list:
    """The files this segment may execute as a script: `./gen.sh` itself, or
    an interpreter's (or `source`'s) first operand and any later operand with a
    script extension (`python3 -I gen.py`, `node --import ./r.mjs bench.mjs`),
    `python3 -m gen` as `gen.py`, `go run x.go`, a Makefile under `make`. With
    no interpreter in sight, any operand with a script extension counts
    (`uv run gen.py`, `npx vitest gen.test.ts`).

    A data operand is not one: in `python3 render.py notes.body` the body is
    content, and so is the heredoc that wrote it."""
    i = 0
    while i < len(words):
        m = _ASSIGN_RE.match(words[i])
        if not m:
            break
        i += 1
    words = [_cmd_word(w) for w in words[i:]]
    while words and _base(words[0]) in _WRAPPERS:
        words = words[1:]
    if not words:
        return []
    first = _base(words[0])
    if "/" in words[0] and not _INTERPRETER_RE.match(first) and first not in _RUNNERS:
        return [words[0]]
    for k, w in enumerate(words):
        base = _base(w)
        if base in _REMOTE_RUNNERS:
            return []
        if _INTERPRETER_RE.match(base) or (base == "R" and k == 0) or w in _RUNS_FILE:
            args = words[k + 1:]
            modules: list = []
            operands: list = []
            j = 0
            while j < len(args):
                a = args[j]
                if a == "-m" and j + 1 < len(args):
                    modules.append(args[j + 1].rsplit(".", 1)[-1] + ".py")
                    j += 2
                    continue
                if not a.startswith("-"):
                    operands.append(a)
                j += 1
            if modules:
                return modules + [a for a in operands if _has_script_ext(a)]
            return operands[:1] + [a for a in operands[1:] if _has_script_ext(a)]
    if first in _NEVER_RUNS:
        return []
    operands = [a for a in words[1:] if not a.startswith("-")]
    if first == "make":
        out = list(_MAKEFILES)
        for j, a in enumerate(words[1:-1], 1):
            if a in ("-f", "--file", "--makefile"):
                out.append(words[j + 1])
        return out
    if first == "go" and operands[:1] == ["run"]:
        return [a for a in operands[1:] if a.endswith(".go")]
    return [a for a in operands if _has_script_ext(a)]


def _blank_spans(text: str, spans: list) -> str:
    """`text` with every span's characters replaced by spaces, newlines kept,
    so offsets into the result are offsets into `text`."""
    if not spans:
        return text
    parts: list = []
    pos = 0
    for start, end in spans:
        parts.append(text[pos:start])
        parts.append(re.sub(r"[^\n]", " ", text[start:end]))
        pos = end
    parts.append(text[pos:])
    return "".join(parts)


# `$W`, `${W}` — only the plain forms. Anything fancier (`${W:-x}`, `$(cmd)`)
# leaves a `$` behind and the destination stays unknowable.
_VAR_REF_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")
_ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)


# Names the hook never takes from its own environment, even under the guard:
# shell-managed or volatile values (`PWD` is the HOOK's directory, not the
# session's), and `HOME` (see CLAUDE.md, "Hook behavior").
_ENV_NEVER = frozenset({"PWD", "OLDPWD", "HOME", "TMPDIR", "SHLVL", "_"})


def _env_fallback(name: str) -> str | None:
    """An exported variable's value, if it may stand in for an unknown one.

    `cd $PROJ_PATH && cat > features/x/commits.yaml` — `PROJ_PATH` is exported
    from the user's shell rc, so the hook process sees the same value Claude's
    shell does. Only an absolute value counts; the caller still checks where
    the expanded path lands (see _expand_vars)."""
    if name in _ENV_NEVER or name.startswith("CLAUDE"):
        return None
    value = os.environ.get(name)
    if not value or not os.path.isabs(value):
        return None
    return value


def _registered_roots() -> list:
    """The workspace roots the extension registered, or [] on any trouble.
    Read on demand: only an environment fallback asks."""
    try:
        with open(WORKSPACE_ROOTS_FILE, encoding="utf-8") as f:
            roots = json.load(f)
        return [os.path.normcase(os.path.abspath(r)) for r in roots if isinstance(r, str)]
    except Exception:
        return []


def _inside_a_root(path: str) -> bool:
    p = os.path.normcase(os.path.abspath(path))
    return any(p == r or p.startswith(r + os.sep) for r in _registered_roots())


def _cd_guard(path: str) -> bool:
    """A `cd` through an environment value must land in a real directory."""
    return os.path.isabs(path) and os.path.isdir(path)


def _target_guard(path: str) -> bool:
    """A write target through an environment value must have a real parent
    directory or lie inside a registered workspace root."""
    if not os.path.isabs(path):
        return False
    return os.path.isdir(os.path.dirname(path)) or _inside_a_root(path)


def _assigned_before(env, name: str) -> bool:
    """Was `name` assigned, unset, read or looped over earlier in the command?"""
    if isinstance(env, _EnvAt):
        h = env.hist.get(name)
        return bool(h) and bisect.bisect_left(h[0], env.i) > 0
    return name in env


def _expand_vars(value: str, env, guard=None) -> str | None:
    """Substitute the literal assignments we have seen, or None if we cannot.

    `W=/tmp/wt-sandbox` followed by `cd "$W"` is how these commands are written
    in practice; without this the cd is unknowable and every relative target
    after it is dropped.

    With a `guard` (a `cd` destination or an explicit write target), a name
    the command never assigned may fall back to the hook's own environment —
    `cd $PROJ_PATH`, where `PROJ_PATH` is exported from the user's shell rc.
    Only when: nothing earlier in the command assigned or unset it (a local
    assignment wins, even an unknowable one); it is not shell-managed (`PWD`,
    `HOME`, … — _ENV_NEVER); its value is absolute; and `guard` accepts the
    fully expanded path. `$(pwd)` and anything fancier stay unknowable.
    """
    if "$" not in value:
        return value
    missing = False
    used_env = False

    def sub(m):
        nonlocal missing, used_env
        name = m.group(1) or m.group(2)
        got = env.get(name)
        if got is None and guard is not None and not _assigned_before(env, name):
            got = _env_fallback(name)
            used_env = used_env or got is not None
        if got is None:
            missing = True
            return ""
        return got

    out = _VAR_REF_RE.sub(sub, value)
    if missing or "$" in out:
        return None
    if used_env and not guard(out):
        return None
    return out


def _leading_assignments(words: list) -> list:
    """The `VAR=value` words that prefix a segment. Shell only treats an
    assignment as one before the command name; after it they are arguments."""
    out: list = []
    for w in words:
        m = _ASSIGN_RE.match(w)
        if not m:
            break
        out.append((m.group(1), m.group(2)))
    return out


# Shapes whose `cd` destination we cannot evaluate from the command text alone:
# a variable, a substitution, a glob, a brace expansion.
_UNKNOWABLE_CD_CHARS = frozenset("$`*?()[]{}")
# PATH_MAX. A directory path longer than this cannot be opened, so it cannot
# name a file we could baseline.
_MAX_CWD_LEN = 4096


def _cd_destination(words: list):
    """The argument of a plain `cd` segment, or None if the segment is not one.

    Returns "" for a `cd` whose destination is knowable only at runtime — bare
    `cd` (HOME), `cd -` (OLDPWD), or `cd a b`. Only an exact leading `cd` counts:
    `(cd sub && ...)` lexes with the paren attached, so a subshell keeps the
    old behaviour instead of leaking its cd past the closing `)`.
    """
    if not words or words[0] != "cd":
        return None
    args = [a for a in words[1:] if not a.startswith("-")]
    return args[0] if len(args) == 1 else ""


def _apply_cd(cur: str | None, dest: str) -> str | None:
    """The directory after `cd dest`, or None when it cannot be known.

    An unknown directory is deliberately sticky: once we have lost track of
    where the shell is, resolving a later relative path against the session cwd
    would invent a path with no file behind it. That invented entry is a no-op,
    the reconcile prunes it, and the real edit is never captured — silently.
    Dropping the candidate is the honest answer.
    """
    if not dest or cur is None:
        return None
    if dest.startswith("~") or any(c in dest for c in _UNKNOWABLE_CD_CHARS):
        return None
    out = os.path.normpath(dest if os.path.isabs(dest) else os.path.join(cur, dest))
    # A chain of relative cds grows the path on every step, and normpath over an
    # ever-longer string is quadratic — 120 ms for one 64 KiB command, on a hook
    # that runs synchronously before every Bash call. Past PATH_MAX the directory
    # cannot exist anyway, so give up on it; `None` is sticky, which ends the walk.
    if len(out) > _MAX_CWD_LEN:
        return None
    return out


class _EnvAt:
    """The literal assignments in force just before segment `i`, read from a
    per-variable history. A dict snapshot per segment was quadratic: 20,000
    `A<n>=x;` assignments in one command copied a growing dict 20,000 times."""

    __slots__ = ("hist", "i")

    def __init__(self, hist: dict, i: int):
        self.hist = hist
        self.i = i

    def get(self, name: str, default=None):
        h = self.hist.get(name)
        if not h:
            return default
        k = bisect.bisect_left(h[0], self.i) - 1
        return h[1][k] if k >= 0 else default


# Builtins whose operands are assignments that persist (`export F=a.go`).
_DECLARE_WORDS = frozenset({"export", "local", "readonly", "declare", "typeset"})


def _segment_assignments(words: list) -> list:
    """`[(name, value | None)]` this segment leaves behind in the shell. None
    means the variable now holds something we cannot know (`unset F`, `read F`,
    `for F in …`).

    A prefix assignment followed by a command (`F=a.go make`) only reaches that
    command's environment; it does not persist, so it is not recorded."""
    assignments = _leading_assignments(words)
    if len(assignments) == len(words):
        return assignments
    words = words[len(assignments):]   # a prefix: judge the command it precedes
    head = words[0]
    if head in _DECLARE_WORDS:
        out = []
        for w in words[1:]:
            m = _ASSIGN_RE.match(w)
            if m:
                out.append((m.group(1), m.group(2)))
        return out
    if head == "unset":
        return [(w, None) for w in words[1:] if not w.startswith("-") and w.isidentifier()]
    if head == "for" and len(words) > 1 and words[1].isidentifier():
        return [(words[1], None)]
    if "read" in words[:2] and head in ("read", "while", "until"):
        k = words.index("read")
        return [(w, None) for w in words[k + 1:] if not w.startswith("-") and w.isidentifier()]
    return []


def _segment_cwds(segments: list, cwd: str | None, heredocs: list):
    """Return (starts, cwds, envs) — the working directory, and the literal
    `VAR=value` assignments (see _expand_vars), in force at each segment.

    Ordering is the whole point. In `cd sub && sed -i b.go` the sed runs in
    <cwd>/sub, while in `sed -i a.go && cd sub` the sed runs in <cwd>; a single
    "final cwd" for the command would get one of the two wrong.

    Segments inside a heredoc body are data (see _heredocs): they inherit
    the directory in force where the heredoc was opened and never change it.
    """
    starts: list = []
    cwds: list = []
    envs: list = []
    hd_starts = [a for a, _ in heredocs]
    hist: dict = {}          # name -> ([segment index], [value or None])
    eff = cwd
    for j, (words, start) in enumerate(segments):
        starts.append(start)
        cwds.append(eff)
        envs.append(_EnvAt(hist, j))
        i = bisect.bisect_right(hd_starts, start) - 1
        if i >= 0 and start < heredocs[i][1]:
            continue                      # heredoc body — prose, not a command
        here = _EnvAt(hist, j + 1)        # sees this segment's own earlier assignments
        for name, value in _segment_assignments(words):
            expanded = _expand_vars(value, here) if value is not None else None
            h = hist.setdefault(name, ([], []))
            h[0].append(j)
            h[1].append(expanded)
        dest = _cd_destination(words)
        if dest is not None:
            expanded = _expand_vars(dest, here, _cd_guard) if dest else dest
            eff = _apply_cd(eff, expanded) if expanded is not None else None
    return starts, cwds, envs


def _redirect_targets(tokens: list, text: str):
    """Yield (target, offset) for each output redirection in `tokens`: a `redir`
    token containing `>` immediately followed by a word (`> f`, `>> f`, `2> f`,
    `&> f`). `>&2` / `>&-` are fd duplications — the next token is a separator,
    so they yield nothing. Input-only operators (`<`, `<<EOF`, `<<<`) are skipped."""
    for i, (kind, _value, pos) in enumerate(tokens):
        if kind != "redir":
            continue
        end = pos
        while end < len(text) and text[end] in _REDIR_CHARS:
            end += 1
        if ">" not in text[pos:end]:
            continue
        if i + 1 < len(tokens) and tokens[i + 1][0] == "word":
            # `(cmd > out.log 2>&1 & echo $! > app.pid)` — the lexer does not
            # split on parentheses, so the subshell's closing `)` arrives glued
            # to the last target. No real filename ends in `)`.
            target = tokens[i + 1][1].rstrip(")")
            if target:
                yield target, pos


_SHELLS = frozenset({"sh", "bash", "zsh", "dash"})
_REMOTE_RUNNERS = frozenset({"ssh", "docker", "podman", "kubectl", "lxc", "vagrant"})


def _shell_c_script(words: list):
    """The script of a `<shell> -c SCRIPT` in this segment, wherever the shell
    sits behind wrappers (`nohup`, `setsid`, `systemd-run --unit=x …`), or None.
    None as well when a remote runner precedes it."""
    for i, w in enumerate(words):
        base = os.path.basename(w)
        if base in _REMOTE_RUNNERS:
            return None
        if base in _SHELLS and i + 2 < len(words) and re.match(r"^-[a-z]*c[a-z]*$", words[i + 1]):
            return words[i + 2]
    return None


def _scan_command(command: str, cwd: str | None = None, _depth: int = 0):
    """Return (may_write, candidates, unresolved). Never raises for ordinary
    input.

    Each candidate is returned as `(path, cwd)`: a relative path means nothing
    without the directory the command actually runs in, which a `cd` inside the
    command can move. `cwd` seeds that and is also what a *speculative*
    (Tier 2c) candidate's existence is probed against.

    `unresolved` lists the raw explicit targets dropped because they name a
    variable we cannot expand (`cat > $T/x`) — the caller logs them, so a write
    we could not follow leaves a trace instead of vanishing.
    """
    if not command or not isinstance(command, str):
        return False, [], [], _new_extra()
    text = command[:MAX_COMMAND_CHARS]

    may_write = False
    ordered: list = []
    seen: set = set()
    unresolved: list = []
    # `notes`: (event, detail) lines for the caller to log, even when nothing
    # is captured. `dirs`: directories whose files a recursive delete removes,
    # walked by the caller.
    extra = _new_extra()

    # The shell and each heredoc body are lexed SEPARATELY. A body is Python, Go
    # or prose: lexed in line with the shell, its apostrophes, `\"` and
    # trailing backslashes misalign quote pairing for everything after it, and
    # the real `sed -i … f.sh` that follows the heredoc is swallowed into a
    # "quoted word". Lexed apart, a body's quoting can only confuse itself. Its
    # words are still harvested below (Tier 2c), just never read as commands.
    #
    # Only a body that RUNS is harvested at all (see _heredoc_runs_code). The
    # body of `cat > f <<EOF` is f's content: the paths it mentions are text,
    # and harvesting them made phantoms of `cg/excludes.json` in a test file
    # and of every path quoted in a plan. Such a body is blanked out of the
    # in-language (Tier 1) and quoted-literal passes too; the command's own
    # targets — `> f`, `tee f` — come from the shell tokens and still count.
    found = _heredocs(text)
    heredocs = [(start, end) for _op, start, end in found]
    shell_text = _blank_spans(text, heredocs)
    tokens = _lex(shell_text)
    runs = _heredoc_runs_code(tokens, shell_text, found)
    code_text = _blank_spans(text, [span for span, r in zip(heredocs, runs) if not r])
    body_words: list = []
    for (start, end), r in zip(heredocs, runs):
        if not r:
            continue
        body_tokens = _lex(text[start:end])
        # A shell body runs its own `cd`s (see Tier 2a″ below, which resolves
        # its explicit targets through them). A word after the first one does
        # not live where the heredoc was opened, so it is not guessed there.
        stop = len(text)
        if r == "shell":
            for words, pos in _segments(body_tokens):
                if _cd_destination(words) is not None:
                    stop = pos
                    break
        body_words.extend((value, start + pos) for kind, value, pos in body_tokens
                          if kind == "word" and pos < stop)
    segments = _segments(tokens)
    seg_starts, seg_cwds, seg_envs = _segment_cwds(segments, cwd, heredocs)

    def at(offset: int) -> int:
        return bisect.bisect_right(seg_starts, offset) - 1

    def cwd_at(offset: int):
        """The working directory in force at this point in the command text."""
        i = at(offset)
        return seg_cwds[i] if i >= 0 else cwd

    def explicit(tok: str, env) -> str | None:
        """An explicit target with its variables expanded, or None (recorded
        as unresolved) when they cannot be."""
        if "$" not in tok:
            return tok
        expanded = _expand_vars(tok, env if env is not None else {}, _target_guard)
        if expanded is None and tok not in unresolved and len(unresolved) < MAX_CANDIDATES:
            unresolved.append(tok)
        return expanded

    def add(tok: str, require_shape: bool, tok_cwd: str | None, env=None) -> None:
        if len(ordered) >= MAX_CANDIDATES:
            return                        # full: nothing more can be kept
        tok = _normalize_token(tok)
        # An explicit target naming a variable: substitute the literal
        # assignments seen earlier in the command (`F=a.go; sed -i … "$F"`), or
        # record it as unresolved. Never for a speculative word — `$x` in a
        # python body is not a target, and logging it would only be noise.
        if not require_shape and "$" in tok:
            expanded = _expand_vars(tok, env if env is not None else {}, _target_guard)
            if expanded is None:
                if tok not in unresolved and len(unresolved) < MAX_CANDIDATES:
                    unresolved.append(tok)
                return
            tok = expanded
        if not _plausible(tok):
            return
        # require_shape marks the speculative pass. Explicit targets (redirection,
        # in-place tool arguments) skip both checks — they are write targets by
        # definition, extension or not (`cat > Makefile`).
        if require_shape and not (_path_shaped(tok) and _names_a_file(tok, tok_cwd)):
            return
        # The same relative token under two directories is two different files,
        # so the directory is part of the identity.
        key = (tok, tok_cwd)
        if key in seen:
            return
        seen.add(key)
        if len(ordered) < MAX_CANDIDATES:
            ordered.append((tok, tok_cwd))

    # Tier 2a — explicit redirection targets (write targets by definition, so
    # they need no path shape: `cat > f <<EOF` names `f`).
    #
    # Read off the SHELL tokens, never the raw text. A regex over the raw text
    # also matched every `>` inside a heredoc body or a quoted string — Go's
    # `d > 30 * time.Minute`, SQL's `created_at > to_timestamp(…)` in `psql -c
    # "…"`, a JS `lines.length > LINES` inside an `sd` argument — and, being
    # "explicit", each of those skipped every guard and became a pending entry.
    # The lexer already knows a quoted `>` is text, and the heredoc bodies are
    # blanked out of `tokens`.
    for target, pos in _redirect_targets(tokens, text):
        if not _is_device(target):
            may_write = True
            i = at(pos)
            add(target, False, cwd_at(pos), seg_envs[i] if i >= 0 else None)

    # Never-capture operations: `git pull`, `make gen`, `tar -xzf`. Logged once
    # per command, never a candidate. Anything else in the command still counts.
    for segment, _start in segments:
        label = _implicit_op(segment)
        if label:
            _note(extra, "skip-implicit", label, once=True)
            break

    # Writes that name their files but must not switch on the speculative
    # pass (Tier 2c) for the rest of the command: `rm a.go` is not a reason to
    # guess at every word beside it.
    quiet_write = False

    # Deletions — `rm`, `git rm`. Snapshotting the file before it goes leaves
    # a pending entry whose disk state is "missing"; Reject writes it back.
    for (segment, _start), seg_cwd, seg_env in zip(segments, seg_cwds, seg_envs):
        deletion = _deletion(segment)
        if deletion is None:
            continue
        recursive, operands = deletion
        quiet_write = True
        for op in operands:
            if any(c in op for c in _GLOB_CHARS):
                _note(extra, "skip-glob", op)
                continue
            tok = explicit(op, seg_env)
            if tok is None or _touches_git_dir(tok):
                continue
            if not os.path.isabs(tok) and not seg_cwd:
                add(tok, False, seg_cwd)          # main() logs skip-unknown-cwd
                continue
            path = os.path.normpath(tok if os.path.isabs(tok) else os.path.join(seg_cwd, tok))
            try:
                if os.path.islink(path):
                    continue                      # rm removes the link, not a file we can restore
                if os.path.isdir(path):
                    if recursive and path not in extra["dirs"] and len(extra["dirs"]) < MAX_CANDIDATES:
                        extra["dirs"].append(path)
                    continue
                # Nothing there: deleting it changes nothing, and capturing it
                # would record a "new file" that never existed.
                if not os.path.isfile(path):
                    continue
            except (OSError, ValueError):
                continue
            add(tok, False, seg_cwd)

    # Tier 1/2b — known in-place writer tools and their arguments.
    for (segment, start), seg_cwd, seg_env in zip(segments, seg_cwds, seg_envs):
        targets = _tool_targets(segment)
        if targets is None:
            continue
        may_write = True
        for t in targets:
            add(t, False, seg_cwd, seg_env)

    # Tier 2a′ — a script handed to a local shell: `nohup sh -c 'run > out.log'`,
    # `systemd-run … bash -c "…"`. The script is one quoted word, so its
    # redirections are invisible to the token pass above; scan it as a command
    # of its own, in the same directory. Not when the shell runs elsewhere
    # (`ssh host bash -c …`, `docker exec c sh -c …`) — that file is not ours.
    if _depth < 2:
        for (segment, _start), seg_cwd in zip(segments, seg_cwds):
            script = _shell_c_script(segment)
            if script is None:
                continue
            inner_writes, inner, inner_unresolved, inner_extra = _scan_command(
                script, seg_cwd, _depth + 1)
            _merge_extra(extra, inner_extra)
            if inner_writes:
                may_write = True
            for tok in inner_unresolved:
                if tok not in unresolved and len(unresolved) < MAX_CANDIDATES:
                    unresolved.append(tok)
            for tok, tok_cwd in inner:
                key = (tok, tok_cwd)
                if key not in seen and len(ordered) < MAX_CANDIDATES:
                    seen.add(key)
                    ordered.append(key)

    # Tier 2a″ — a heredoc fed to a local shell (`bash -s <<EOF`, `cat <<EOF |
    # sh`) is a script like a `sh -c` one: scan it as a command of its own,
    # starting in the directory where the heredoc was opened. Its `cd`s move
    # only its own targets, never the outer command's.
    if _depth < 2:
        for (op, start, end), r in zip(found, runs):
            if r != "shell":
                continue
            inner_writes, inner, inner_unresolved, inner_extra = _scan_command(
                text[start:end], cwd_at(op), _depth + 1)
            _merge_extra(extra, inner_extra)
            if inner_writes:
                may_write = True
            for tok in inner_unresolved:
                if tok not in unresolved and len(unresolved) < MAX_CANDIDATES:
                    unresolved.append(tok)
            for key in inner:
                if key not in seen and len(ordered) < MAX_CANDIDATES:
                    seen.add(key)
                    ordered.append(key)

    # Tier 1 — in-language writes (python heredocs and -c one-liners). Not in
    # a body that is data: a test file written by `cat` that calls `.write(`.
    if _OPEN_WRITE_RE.search(code_text) or _WRITE_CALL_RE.search(code_text):
        may_write = True

    # Tier 2c — every path-shaped literal in the command. This is what catches
    # the reported failure, where the path is bound to a variable first:
    #   p='manager/biz/monitor_filter.go'   ← harvested here
    #   open(p,'w').write(s)                ← fires Tier 1
    # Not inside a `sh -c` script (depth > 0): there the words are mostly the
    # program being run (`sh -c './run_all.sh > out.log'`), and only the
    # explicit targets above are worth taking.
    if may_write and _depth == 0:
        for kind, value, pos in tokens:
            if kind == "word":
                add(value, True, cwd_at(pos))
        for value, pos in body_words:
            add(value, True, cwd_at(pos))
        for literal, pos in _quoted_literals(code_text):
            add(literal, True, cwd_at(pos))

    return may_write or quiet_write, ordered, unresolved, extra


def _new_extra() -> dict:
    return {"notes": [], "dirs": []}


def _note(extra: dict, event: str, detail: str, once: bool = False) -> None:
    """Queue a log line. `once`: at most one line of this event per command."""
    if once and any(e == event for e, _ in extra["notes"]):
        return
    if len(extra["notes"]) < MAX_CANDIDATES:
        extra["notes"].append((event, detail))


def _merge_extra(into: dict, other: dict) -> None:
    for event, detail in other["notes"]:
        _note(into, event, detail, once=(event == "skip-implicit"))
    for d in other["dirs"]:
        if d not in into["dirs"]:
            into["dirs"].append(d)


def command_may_write(command: str) -> bool:
    """Tier 1 — could this command plausibly write a file? Answering False here
    keeps the hook's filesystem work (and hook.log) off every `ls`/`go build`."""
    return _scan_command(command)[0]


def paths_from_command(command: str, cwd: str | None = None) -> list:
    """Tier 2 — candidate write targets as `(path, cwd)`, deduplicated, in
    discovery order. Gated on Tier 1: a command that cannot write yields no
    candidates at all, so `cat file.go` and `grep -r foo .` extract nothing.

    Each candidate carries the directory it resolves against, because a `cd`
    inside the command moves it: `cd sub && sed -i x.go` writes <cwd>/sub/x.go.
    A `cwd` of None means the directory is unknowable (`cd "$REPO"`) and the
    caller must drop the candidate rather than guess.

    Pass the tool call's `cwd` so an extensionless speculative candidate can be
    confirmed against the filesystem. Without it such candidates are dropped —
    the process cwd is not the session's directory, so resolving against it would
    be worse than not checking at all."""
    return scan_targets(command, cwd)[0]


def scan_targets(command: str, cwd: str | None = None):
    """`(paths_from_command(command, cwd), unresolved)` — the second item lists
    the explicit targets dropped because a variable in them cannot be expanded
    (see _scan_command). Both are empty for a command that cannot write."""
    full = scan_full(command, cwd)
    return full["candidates"], full["unresolved"]


def scan_full(command: str, cwd: str | None = None) -> dict:
    """Everything main() needs from one command: `candidates`, `unresolved`
    and `dirs` (all empty for a command that cannot write), and `notes` —
    (event, detail) log lines, kept even then (`skip-implicit git pull`)."""
    may_write, candidates, unresolved, extra = _scan_command(command, cwd)
    if not may_write:
        return {"candidates": [], "unresolved": [], "dirs": [], "notes": extra["notes"]}
    return {"candidates": candidates, "unresolved": unresolved,
            "dirs": extra["dirs"], "notes": extra["notes"]}


def capture_file(file_path: str, cwd: str, session_id, captured_at: str) -> None:
    """Run one target through the capture pipeline. Returns (never exits) on
    every skip, so a Bash command with several candidates keeps going."""
    if not os.path.isabs(file_path):
        file_path = os.path.normpath(os.path.join(cwd, file_path))

    workspace_root = workspace_root_for_file(file_path, cwd)
    if workspace_root is None:
        log_event("skip-no-root", file_path)
        return
    # Matched against the window's root, not a nested worktree's: the extension's
    # ExcludeMatcher is anchored at the primary workspace folder.
    if is_excluded(file_path, workspace_root, excludes_for_root(workspace_root)):
        log_event("skip-excluded", file_path)
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
        full = scan_full(command, cwd)
    except Exception:
        log_event("error")
        sys.exit(0)
    candidates, unresolved = full["candidates"], full["unresolved"]
    for event, detail in full["notes"]:
        log_event(event, detail[:MAX_CANDIDATE_LEN].replace("\\", "\\\\").replace("\n", "\\n"))
    # An explicit target whose variable we cannot expand (`cat > $T/x`) is
    # not captured — guessing would record a path with no file behind it — but
    # it is logged, one line per token, so the gap shows up in hook.log.
    for token in unresolved:
        log_event("skip-unknown-var",
                  token[:MAX_CANDIDATE_LEN].replace("\\", "\\\\").replace("\n", "\\n"))
    for candidate, candidate_cwd in candidates:
        # A relative path whose directory the command made unknowable (`cd
        # "$REPO"`) must be dropped. Falling back to the session cwd would
        # record a path with no file behind it: a no-op entry the reconcile
        # prunes, while the real edit goes uncaptured and unnoticed.
        if not os.path.isabs(candidate) and not candidate_cwd:
            log_event("skip-unknown-cwd", candidate)
            continue
        try:
            capture_file(candidate, candidate_cwd or cwd, session_id, captured_at)
        except Exception:
            # One bad candidate must not cost us the rest of the command.
            log_event("error")
    # `rm -r DIR`: each regular file in it, up to RM_WALK_CAP. Past the cap,
    # nothing from that directory — one log line instead.
    for directory in full["dirs"]:
        try:
            files, overflow = _walk_files(directory)
        except Exception:
            log_event("error")
            continue
        if overflow:
            log_event("skip-too-many", "%s >%d" % (directory, RM_WALK_CAP))
            continue
        for f in files:
            try:
                capture_file(f, cwd, session_id, captured_at)
            except Exception:
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
