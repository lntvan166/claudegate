"""Tier 1/2 shell-write capture: command classification, target extraction, and
an end-to-end `Bash` payload through the real hook.

See docs/superpowers/specs/2026-08-11-bash-writes-capture-design.md.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "..", "hook.py")


def _load_hook_module():
    spec = importlib.util.spec_from_file_location("claudegate_hook", HOOK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook_module()


def session_file_for(claudegate_dir, root):
    normalized = os.path.normcase(os.path.abspath(root))
    h = hashlib.md5(normalized.encode()).hexdigest()
    return os.path.join(claudegate_dir, "sessions", f"{h}.json")


def paths(cmd, cwd=None):
    """Just the candidate tokens. `paths_from_command` returns (path, cwd) pairs
    because a relative target resolves against the directory the command runs
    in, not the session cwd; most cases below do not exercise that."""
    return [p for p, _ in hook.paths_from_command(cmd, cwd)]


def targets(cmd, cwd):
    """The absolute targets, resolved the way main() resolves them. A relative
    candidate whose cwd is unknowable is dropped, as main() drops it."""
    out = []
    for path, path_cwd in hook.paths_from_command(cmd, cwd):
        if os.path.isabs(path):
            out.append(path)
        elif path_cwd:
            out.append(os.path.normpath(os.path.join(path_cwd, path)))
    return out


PY_HEREDOC = (
    "python3 - <<'PY'\n"
    "p='manager/biz/monitor_filter.go'\n"
    "s=open(p).read()\n"
    "s=s.replace(old, new, 1)\n"
    "open(p,'w').write(s)\n"
    "PY"
)

CAT_HEREDOC = "cat > notes/out.txt <<EOF\nhello\nEOF"


class WriteDetectionTest(unittest.TestCase):
    """Tier 1 — does this command plausibly write a file at all?"""

    WRITERS = [
        "echo hi > out.txt",
        "echo hi >> log.txt",
        "cat > f <<EOF\nx\nEOF",
        "sed -i 's/old/new/' src/app.go",
        "sed --in-place 's/a/b/' a.py",
        "echo x | tee out.log",
        "cp a.go b.go",
        "mv old.go new.go",
        "install -m 0755 bin/x dist/x",
        "patch -p1 < fix.diff",
        "git apply fix.patch",
        "git checkout -- pkg/a.go",
        "git restore pkg/a.go",
        "dd if=a.img of=b.img",
        "truncate -s 0 log.txt",
        "touch new.go",
        "gofmt -w main.go",
        "goimports -w pkg/x.go",
        "prettier --write app/index.js",
        "black app.py",
        "rustfmt src/lib.rs",
        "ruff format tool.py",
        "clang-format -i a.c",
        "perl -pi -e 's/a/b/' f.txt",
        PY_HEREDOC,
        "python3 -c \"open('x/y.go','a').write('z')\"",
        CAT_HEREDOC,
        "for f in *.go; do gofmt -w $f; done",
    ]

    NON_WRITERS = [
        "ls",
        "ls -la src/",
        "go build ./...",
        "go test ./... 2>&1",
        "git status",
        "git diff --stat",
        "cat file.go",
        "grep -r foo .",
        "echo x > /dev/null",
        "echo boom >&2",
        "make generate",
        "npm run compile",
        # History operations bring in other people's changes: never a write.
        "git stash pop",
        "git reset --hard",
        "git checkout main",
        "python3 -c \"print(open('a.go').read())\"",
    ]

    def test_write_commands_detected(self):
        for cmd in self.WRITERS:
            with self.subTest(cmd=cmd):
                self.assertTrue(hook.command_may_write(cmd), "should be a write")

    def test_non_write_commands_rejected(self):
        for cmd in self.NON_WRITERS:
            with self.subTest(cmd=cmd):
                self.assertFalse(hook.command_may_write(cmd), "should not be a write")


class PathExtractionTest(unittest.TestCase):
    """Tier 2 — which files does the command name?"""

    # (command, paths that must appear in the extraction)
    CASES = [
        # --- redirection -------------------------------------------------
        ("echo hi > out.txt", ["out.txt"]),
        ("echo hi >> logs/app.log", ["logs/app.log"]),
        ("printf x > 'my dir/f.txt'", ["my dir/f.txt"]),
        ("cat > f <<EOF\nbody\nEOF", ["f"]),
        (CAT_HEREDOC, ["notes/out.txt"]),
        ("go test ./... 2>&1 | tee out.log", ["out.log"]),
        ("go build ./... &> build.log", ["build.log"]),
        ("echo x 2> err.txt", ["err.txt"]),
        # --- in-place tools ----------------------------------------------
        ("sed -i 's/old/new/' src/app.go", ["src/app.go"]),
        ("sed -i.bak 's|a|b|g' conf/site.yaml", ["conf/site.yaml"]),
        ("sed --in-place 's/a/b/' Makefile", ["Makefile"]),
        ("perl -pi -e 's/a/b/' lib/x.pm", ["lib/x.pm"]),
        ("echo x | tee pkg/gen.go", ["pkg/gen.go"]),
        ("cp src/a.go src/b.go", ["src/a.go", "src/b.go"]),
        ("mv old.txt new.txt", ["old.txt", "new.txt"]),
        ("install -m 0755 bin/tool dist/tool", ["bin/tool", "dist/tool"]),
        ("dd if=in.img of=out.img", ["in.img", "out.img"]),
        ("truncate -s 0 logs/app.log", ["logs/app.log"]),
        ("touch pkg/new.go", ["pkg/new.go"]),
        ("gofmt -w cmd/main.go", ["cmd/main.go"]),
        ("goimports -w pkg/x.go", ["pkg/x.go"]),
        ("prettier --write web/index.js", ["web/index.js"]),
        ("black app/main.py", ["app/main.py"]),
        ("rustfmt src/lib.rs", ["src/lib.rs"]),
        ("ruff format tool/run.py", ["tool/run.py"]),
        ("clang-format -i src/a.c", ["src/a.c"]),
        # --- git ---------------------------------------------------------
        ("git apply patches/fix.patch", ["patches/fix.patch"]),
        ("git checkout -- manager/biz/monitor_filter.go",
         ["manager/biz/monitor_filter.go"]),
        ("git restore internal/es_reader.go", ["internal/es_reader.go"]),
        # --- path-shaped literals (the reported failure) -----------------
        (PY_HEREDOC, ["manager/biz/monitor_filter.go"]),
        ("python3 -c \"open('pkg/gen.go','w').write(src)\"", ["pkg/gen.go"]),
        ("python3 - <<'PY'\nfrom pathlib import Path\n"
         "Path('a/b.txt').write_text('hi')\nPY", ["a/b.txt"]),
        ("sudo touch /etc/hosts.new", ["/etc/hosts.new"]),
        ("if true; then sed -i s/a/b/ cfg/app.yaml; fi", ["cfg/app.yaml"]),
    ]

    # These must extract absolutely nothing.
    NEGATIVE = [
        "ls",
        "go build ./...",
        "git status",
        "cat file.go",
        "grep -r foo .",
        "echo x > /dev/null",
        "make generate",
        "prettier --write src/",        # Tier 3: names no file
        "go generate ./...",
        "git checkout .",               # Tier 3: names no file
        "cat pkg/a.go pkg/b.go",
        "echo done >&2",
        "python3 -c \"print(open('a.go').read())\"",
        "for f in *.go; do gofmt -w $f; done",   # Tier 3: target is a variable
        "git commit -m 'fix: repair src/foo.go'",
        "docker build -t app:latest .",
    ]

    def test_expected_paths_extracted(self):
        for cmd, expected in self.CASES:
            with self.subTest(cmd=cmd):
                got = paths(cmd)
                for want in expected:
                    self.assertIn(want, got, f"{want!r} missing from {got!r}")

    def test_negative_controls_extract_nothing(self):
        for cmd in self.NEGATIVE:
            with self.subTest(cmd=cmd):
                self.assertEqual([], paths(cmd))

    def test_devices_and_fd_dups_never_extracted(self):
        for cmd in ["echo x > /dev/null",
                    "echo x > /dev/stderr",
                    "echo x > /dev/tty",
                    "sed -i s/a/b/ f.go 2>&1",
                    "sed -i s/a/b/ f.go >&2"]:
            with self.subTest(cmd=cmd):
                for p in paths(cmd):
                    self.assertFalse(p.startswith("/dev/"), p)
                    self.assertNotIn("&", p)

    def test_directories_and_wildcards_dropped(self):
        for cmd in ["prettier --write src/", "gofmt -w ./...", "cp -r a/ b/"]:
            with self.subTest(cmd=cmd):
                for p in paths(cmd):
                    self.assertFalse(p.endswith("/"), p)
                    self.assertNotIn("...", p)

    def test_sed_expression_is_not_a_path(self):
        got = paths("sed -i 's/old/new/g' src/app.go")
        self.assertEqual(["src/app.go"], got)

    def test_deduplicated_and_ordered(self):
        got = paths("cp a/x.go a/x.go && touch a/x.go")
        self.assertEqual(["a/x.go"], got)
        got = paths("cat > first.txt <<EOF\nEOF\ntouch second.txt")
        self.assertEqual(["first.txt", "second.txt"], got)

    def test_candidates_are_bounded(self):
        cmd = "touch " + " ".join(f"f{i}.txt" for i in range(200))
        self.assertLessEqual(len(paths(cmd)), hook.MAX_CANDIDATES)

    def test_pathological_input_is_bounded_and_safe(self):
        cmd = "cat > out.txt <<EOF\n" + ("x/y.go " * 200000) + "\nEOF"
        got = paths(cmd)  # must simply return
        self.assertLessEqual(len(got), hook.MAX_CANDIDATES)
        self.assertIn("out.txt", got)

    def test_non_string_and_empty_input(self):
        self.assertEqual([], paths(""))
        self.assertEqual([], paths(None))
        self.assertFalse(hook.command_may_write(""))


class SpeculativeHarvestTest(unittest.TestCase):
    """Tier 2c must not turn every slash-bearing word into a capture.

    Observed in a real session's hook.log, each of these produced a pending
    entry for a file that does not exist and never would:

        captured .../repo/origin/main
        captured .../repo/origin/release-1.4
        captured .../repo/github.com/acme/schema-lib

    A bogus entry is not merely cosmetic. Each one costs a session-file write,
    a full reload of that file (2 MB on the workspace where this was found), a
    reconcile pass, the prune, and a second write + reload — four
    parse/serialize cycles for a path that was a git refspec or a Go module
    path all along.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def write(self, rel, body="x"):
        full = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as fh:
            fh.write(body)
        return full

    def test_git_refspecs_are_not_paths(self):
        for cmd in [
            "git checkout origin/main",
            "git checkout origin/release-1.4 -b feature",
            "git reset --hard origin/main",
            "git restore origin/main",
            "git checkout upstream/release-1.2",
        ]:
            with self.subTest(cmd=cmd):
                got = paths(cmd, self.tmp)
                self.assertNotIn("origin/main", got, got)
                self.assertNotIn("origin/release-1.4", got, got)
                self.assertNotIn("upstream/release-1.2", got, got)

    def test_explicit_pathspec_after_dashdash_still_captured(self):
        # `--` is git's own disambiguator: everything after it IS a path.
        got = paths(
            "git checkout origin/main -- manager/biz/rule.go", self.tmp
        )
        self.assertIn("manager/biz/rule.go", got)
        self.assertNotIn("origin/main", got)

    def test_module_paths_are_not_speculative_targets(self):
        cmd = (
            "sed -i 's/a/b/' manager/biz/rule.go && "
            "go mod edit -replace github.com/acme/schema-lib=../schema-lib"
        )
        got = paths(cmd, self.tmp)
        self.assertIn("manager/biz/rule.go", got, "the real sed target survives")
        self.assertNotIn("github.com/acme/schema-lib", got, got)

    def test_extensionless_word_that_exists_on_disk_is_kept(self):
        # Existence is the escape hatch: a real extensionless file mentioned in a
        # writing command is still a legitimate baseline.
        self.write("scripts/build")
        cmd = "sed -i 's/a/b/' scripts/build"
        self.assertIn("scripts/build", paths(cmd, self.tmp))

    def test_speculative_extensionless_word_that_exists_is_kept(self):
        # Same file, but reached through Tier 2c (bound to a variable) rather
        # than named as the tool's argument.
        self.write("scripts/build")
        cmd = "p=scripts/build\nopen(p,'w').write(s)"
        self.assertIn("scripts/build", paths(cmd, self.tmp))

    def test_absolute_speculative_candidate_is_probed_without_a_cwd(self):
        # An absolute path needs no cwd to be checked. Requiring one dropped
        # real absolute candidates once the cwd could become unknown.
        full = self.write("scripts/build")
        cmd = "p=%s\nopen(p,'w').write(s)" % full
        self.assertIn(full, paths(cmd, None))
        self.assertIn(full, paths(cmd, self.tmp))

    def test_new_file_with_an_extension_is_still_captured(self):
        # The common create case: the file does NOT exist yet, and must still be
        # captured (originalContent stays null so a reject deletes it).
        cmd = "python3 - <<'PY'\np='pkg/generated_client.go'\nopen(p,'w').write(s)\nPY"
        self.assertIn("pkg/generated_client.go", paths(cmd, self.tmp))

    def test_explicit_targets_never_need_an_extension(self):
        # Tier 2a/2b are explicit, not speculative: a redirection or in-place
        # tool target is a write target by definition, extension or not.
        self.assertIn("Makefile", paths("cat > Makefile <<EOF\nx\nEOF", self.tmp))
        self.assertIn("build/Dockerfile", paths("cp a/Dockerfile build/Dockerfile", self.tmp))
        self.assertIn("conf/nginx", paths("sed -i 's/a/b/' conf/nginx", self.tmp))

    def test_cwd_is_optional_and_defaults_to_no_existence_check(self):
        # Called without a cwd (the older signature), extensionless speculative
        # candidates are simply dropped rather than resolved against the process
        # cwd, which is not the session's directory.
        got = paths("sed -i 's/a/b/' manager/biz/rule.go && echo origin/main")
        self.assertIn("manager/biz/rule.go", got)
        self.assertNotIn("origin/main", got)


class ShapeNoiseTest(unittest.TestCase):
    """Each case is a real command (trimmed) from a workspace whose hook.log
    captured, in two days, 215 unique paths with nothing behind them. The
    extension pruned every one again, but each cost two rewrites of a 2 MB
    session file. The bogus path each used to produce is in the comment."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def got(self, cmd):
        return paths(cmd, self.tmp)

    def test_escaped_quote_does_not_end_a_double_quoted_word(self):
        # captured: on, sandbox,, every, author,, whether, it, can, go, to, prod
        cmd = ("sed -i \"s/'d': \\\"One feature's commits on sandbox, every author\\\"/"
               "'d': \\\"and whether it can go to prod\\\"/\" board/mcp.py")
        self.assertEqual(["board/mcp.py"], self.got(cmd))

    def test_sed_script_is_not_a_target(self):
        # captured: " None/d", " 0o022"
        self.assertEqual(["tests/test_app.py"],
                         self.got("sed -i '/    srv_board = None/d' tests/test_app.py"))
        self.assertEqual(["chezmoi.toml"],
                         self.got("sed -i '1i umask = 0o022' chezmoi.toml"))
        self.assertEqual(["cfg/app.yaml"], self.got("sed -i s/a/b/ cfg/app.yaml"))

    def test_sed_with_explicit_expressions_keeps_every_file(self):
        self.assertEqual(["a.go", "b.go"],
                         self.got("sed -i -e 's/a/b/' -e 's/c/d/' a.go b.go"))
        self.assertEqual(["x.txt"], self.got("sed -ne 's/a/b/p' -i x.txt"))

    def test_perl_e_script_is_not_a_target(self):
        self.assertEqual(["lib/x.pm"],
                         self.got("perl -pi -e 's/a = b/c/' lib/x.pm"))

    def test_rev_path_and_host_path_are_not_files(self):
        # captured: HEAD~1:services/grpc.go, build.dev:/tmp/rb-copy.db, prod:k.txt
        got = self.got("git show HEAD~1:services/grpc.go > /tmp/old.go; "
                       "scp build.dev:/tmp/rb-copy.db x.db; "
                       "git show prod:k.txt > out.txt")
        self.assertNotIn("HEAD~1:services/grpc.go", got)
        self.assertNotIn("build.dev:/tmp/rb-copy.db", got)
        self.assertNotIn("prod:k.txt", got)
        self.assertIn("/tmp/old.go", got)
        self.assertIn("out.txt", got)

    def test_git_range_is_not_a_file(self):
        # captured: base..HEAD, origin/main..HEAD
        got = self.got("git log base..HEAD origin/main..HEAD > log.txt")
        self.assertEqual(["log.txt"], got)

    def test_heredoc_string_literals_that_are_not_filenames(self):
        # captured: ASvc.GetThing, handler.GetThing, filepath.SkipDir,
        # strings.Builder, %s/go.mod, "handler.GetThing → repo.Load", .go, .git
        cmd = ("cat >> main_test.go <<'EOF'\n"
               'rpc := RPC{Name: "ASvc.GetThing", Path: []string{"handler.GetThing", "repo.Load"}}\n'
               'want := "handler.GetThing → repo.Load"\n'
               'mod := fmt.Sprintf("%s/go.mod", r)\n'
               'if strings.HasSuffix(p, ".go") || d.Name() == ".git" { return filepath.SkipDir }\n'
               'var b strings.Builder\n'
               "EOF")
        self.assertEqual(["main_test.go"], self.got(cmd))

    def test_dotted_names_need_a_known_extension_unless_on_disk(self):
        # captured: build.dev, board.app, acme.order.ops, v.icon, ta.style.opacity
        cmd = ("python3 - <<'PY'\n"
               "open('out.json', 'w').write(x)\n"
               "host = 'build.dev'; mod = 'board.app'; svc = 'acme.order.ops'\n"
               "el = 'ta.style.opacity'\n"
               "PY")
        self.assertEqual(["out.json"], self.got(cmd))

    def test_real_new_files_from_heredocs_are_still_captured(self):
        cmd = ("python3 - <<'PY'\n"
               "p = 'manager/biz/rule.go'\n"
               "q = 'docs/Dockerfile'\n"
               "open(p, 'w').write(s)\n"
               "open('features/x/commits.yaml', 'w').write(t)\n"
               "PY")
        got = self.got(cmd)
        self.assertIn("manager/biz/rule.go", got)
        self.assertIn("features/x/commits.yaml", got)

    def test_extensionless_or_unusual_file_on_disk_is_still_captured(self):
        os.makedirs(os.path.join(self.tmp, "ci"))
        for rel in ("ci/devi", "ci/build.Groovy", ".envrc"):
            with open(os.path.join(self.tmp, rel), "w") as f:
                f.write("x")
        got = self.got("python3 - <<'PY'\n"
                       "for p in ['ci/devi', 'ci/build.Groovy', '.envrc']:\n"
                       "    open(p, 'w').write(s)\n"
                       "PY")
        self.assertEqual(["ci/devi", "ci/build.Groovy", ".envrc"], got)

    def test_heredoc_quoting_cannot_swallow_the_command_after_it(self):
        # The body's `\"` and trailing `\\` used to misalign quote pairing so
        # far that the sed target after the heredoc was never seen.
        cmd = ("python3 - <<'PYEOF'\n"
               "p='ci/devi.sh'\n"
               'a="""  post "$(jq --arg r "$repo" \\\\\n'
               "      '{repo: $r}')\\\"\"\"\"\n"
               "open(p,'w').write(s)\n"
               "PYEOF\n"
               "sed -i 's/; \\[\\[ \\$rc == 0 \\]\\] || echo \"\\$out\"//' ci/test-release.sh")
        got = self.got(cmd)
        self.assertIn("ci/devi.sh", got)
        self.assertIn("ci/test-release.sh", got)

    def test_existing_file_with_a_space_is_still_captured(self):
        with open(os.path.join(self.tmp, "Team Report.json"), "w") as f:
            f.write("{}")
        got = self.got("python3 - <<'PY'\nopen('Team Report.json', 'w').write(s)\nPY")
        self.assertEqual(["Team Report.json"], got)

    def test_mixed_case_extension_is_not_a_known_file(self):
        got = self.got("python3 - <<'PY'\nopen('a.json','w'); x = 'frame.Ts'\nPY")
        self.assertEqual(["a.json"], got)

    def test_explicit_targets_keep_their_freedom(self):
        # Redirection and in-place tool targets are write targets by definition.
        self.assertEqual(["Makefile"], self.got("cat > Makefile <<'EOF'\nall:\nEOF"))
        self.assertEqual(["notes.weird"], self.got("echo x > notes.weird"))
        self.assertEqual(["my notes.md"], self.got('echo x > "my notes.md"'))


class RedirectionSourceTest(unittest.TestCase):
    """A redirection target skips every guard, so it must come from a real
    shell `>` — never from one inside a heredoc body or a quoted string. Each
    case below is a real command that captured its comparison operand as a file
    while scanning the raw text."""

    def test_comparison_in_heredoc_code_is_not_a_target(self):
        cmd = ("python3 - <<'EOF'\np='a.go'\ns=open(p).read() + \"\"\"\n"
               "\tif age > time.Minute {\n\t\treturn\n\t}\n\"\"\"\nopen(p,'w').write(s)\nEOF")
        self.assertNotIn("time.Minute", paths(cmd))
        self.assertIn("a.go", paths(cmd))

    def test_comparison_in_quoted_sql_is_not_a_target(self):
        cmd = 'psql db -c "select count(*) filter (where d.created_at > to_timestamp(0))" > out.txt'
        self.assertEqual(paths(cmd), ["out.txt"])

    def test_comparison_in_sd_argument_is_not_a_target(self):
        cmd = "sd -F 'const more = lines.length > LINES;' 'x' main.js"
        self.assertEqual(paths(cmd), ["main.js"])

    def test_real_redirections_still_found(self):
        self.assertEqual(paths("echo x > a.txt"), ["a.txt"])
        self.assertEqual(paths("echo x >> a.txt 2>&1"), ["a.txt"])
        self.assertEqual(paths("go vet 2> err.log"), ["err.log"])
        self.assertEqual(paths("cmd &> all.log"), ["all.log"])
        self.assertEqual(paths("echo x >a.txt"), ["a.txt"])
        self.assertEqual(paths('echo x > "my file.txt"'), ["my file.txt"])
        self.assertEqual(paths("cat > notes.md <<'EOF'\nbody > not_a_file\nEOF"), ["notes.md"])

    def test_fd_duplication_is_not_a_target(self):
        self.assertEqual(paths("go test ./... 2>&1 | tail"), [])
        self.assertEqual(paths("echo oops >&2"), [])

    def test_subshell_closing_paren_is_not_part_of_the_name(self):
        cmd = "(./server > app.log 2>&1 & echo $! > app.pid); sleep 1"
        self.assertEqual(sorted(paths(cmd)), ["app.log", "app.pid"])


class ShellDashCTest(unittest.TestCase):
    """A script passed to a local `sh -c` writes locally; one passed to a remote
    runner does not."""

    def test_redirect_inside_sh_c_is_captured(self):
        cmd = "setsid nohup sh -c './run_all.sh 2>&1 | grep -v warn >> results/run.log' >/dev/null 2>&1 &"
        self.assertEqual(paths(cmd), ["results/run.log"])

    def test_wrapped_shell_with_options_in_front(self):
        cmd = "systemd-run --user --unit=x -p Nice=10 sh -c './job.sh > outputs/pipeline.log 2>&1'"
        self.assertEqual(paths(cmd), ["outputs/pipeline.log"])

    def test_program_run_by_sh_c_is_not_captured(self):
        self.assertNotIn("./run_all.sh", paths("sh -c './run_all.sh > out.log'"))

    def test_remote_shells_are_not_local_writes(self):
        self.assertEqual(paths("ssh host bash -c 'echo x > /etc/motd'"), [])
        self.assertEqual(paths("docker exec c sh -c 'echo x > /app/f.txt'"), [])

    def test_sh_c_inside_sh_c_is_bounded(self):
        cmd = "sh -c \"sh -c 'sh -c \\\"echo > deep.txt\\\"'\""
        paths(cmd)  # must terminate; depth is capped


class SdTest(unittest.TestCase):
    """`sd FIND REPLACE FILES...` edits in place with no flag."""

    def test_files_after_find_and_replace(self):
        self.assertEqual(paths("sd 'a' 'b' x.md y.md"), ["x.md", "y.md"])

    def test_find_and_replace_are_not_explicit_targets(self):
        # Only FILES are explicit. A path-shaped FIND/REPLACE can still be picked
        # up by the speculative pass, like any word in a writing command — but
        # it is checked against the file-name guards there, not taken as given.
        self.assertEqual(hook._sd_targets(["old.go", "new.go", "main.md"]), ["main.md"])
        self.assertEqual(paths("sd 'a b' 'c d' main.md"), ["main.md"])

    def test_options_and_their_values_are_skipped(self):
        self.assertEqual(paths("sd -F -f i -n 2 'a' 'b' f.txt"), ["f.txt"])
        self.assertEqual(paths("sd -- '-x' '-y' f.txt"), ["f.txt"])

    def test_preview_and_stdin_do_not_write(self):
        self.assertFalse(hook.command_may_write("sd -p 'a' 'b' f.txt"))
        self.assertFalse(hook.command_may_write("cat f.txt | sd 'a' 'b'"))


class CdAwareResolutionTest(unittest.TestCase):
    """A relative target resolves against the directory the command actually runs
    in, not the session cwd.

    Observed in a real monorepo session. The command was

        cd <root>/sub && python3 - <<'PY'
        p = pathlib.Path('manager/biz/rule.go')
        ...

    and the hook recorded <root>/manager/biz/rule.go — a path with no file
    behind it, because the `cd` was ignored. That entry read as a no-op, the
    settle-window reconcile pruned it, and the real edit never reached the
    pending panel. One workspace had lost 47 captures this way, every one of
    them a `cd <subdir> && <write>` in a repo of submodules.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.sub = os.path.join(self.tmp, "sub")
        os.makedirs(self.sub)

    def test_absolute_cd_relocates_a_heredoc_target(self):
        cmd = (
            "cd %s && python3 - <<'PY'\n"
            "p = pathlib.Path('manager/biz/rule.go')\n"
            "p.write_text(s)\n"
            "PY" % self.sub
        )
        self.assertEqual(
            [os.path.join(self.sub, "manager/biz/rule.go")],
            targets(cmd, self.tmp),
        )

    def test_relative_cd_relocates_an_in_place_tool_target(self):
        cmd = "cd sub && sed -i 's/a/b/' x.go"
        self.assertIn(os.path.join(self.sub, "x.go"), targets(cmd, self.tmp))

    def test_relative_cd_relocates_a_redirection_target(self):
        cmd = "cd sub && cat > gen.go <<EOF\nx\nEOF"
        self.assertEqual([os.path.join(self.sub, "gen.go")], targets(cmd, self.tmp))

    def test_cd_is_applied_in_order_not_to_the_whole_command(self):
        # a.go is written BEFORE the cd and must still resolve against the base.
        cmd = "sed -i 's/a/b/' a.go && cd sub && sed -i 's/a/b/' b.go"
        self.assertEqual(
            [os.path.join(self.tmp, "a.go"), os.path.join(self.sub, "b.go")],
            targets(cmd, self.tmp),
        )

    def test_cd_dotdot_walks_back_up(self):
        cmd = "cd sub && cd .. && sed -i 's/a/b/' top.go"
        self.assertEqual([os.path.join(self.tmp, "top.go")], targets(cmd, self.tmp))

    def test_absolute_target_is_unaffected_by_cd(self):
        other = os.path.join(self.tmp, "other.go")
        cmd = "cd sub && sed -i 's/a/b/' %s" % other
        self.assertEqual([other], targets(cmd, self.tmp))

    def test_unknowable_cd_drops_later_relative_targets(self):
        # Once we have lost track of where the shell is, resolving against the
        # session cwd would invent a path that does not exist — the very bug
        # this guards. Dropping the candidate is the honest answer.
        for cmd in ['cd "$REPO_DIR" && sed -i \'s/a/b/\' x.go',
                    "cd && sed -i 's/a/b/' x.go",
                    "cd - && sed -i 's/a/b/' x.go",
                    "cd ~/elsewhere && sed -i 's/a/b/' x.go"]:
            with self.subTest(cmd=cmd):
                self.assertEqual([], targets(cmd, self.tmp), cmd)

    def test_unknowable_cd_is_sticky(self):
        cmd = "cd $D && cd sub && sed -i 's/a/b/' x.go"
        self.assertEqual([], targets(cmd, self.tmp))

    def test_cd_before_the_write_does_not_itself_become_a_candidate(self):
        cmd = "cd sub && sed -i 's/a/b/' x.go"
        self.assertNotIn("sub", paths(cmd, self.tmp))
        self.assertNotIn(self.sub, targets(cmd, self.tmp))

    def test_existence_probe_uses_the_effective_directory(self):
        # An extensionless speculative candidate is kept only if it exists. It
        # exists under sub/, not under the session cwd, so the probe has to look
        # in the directory the command actually runs in.
        os.makedirs(os.path.join(self.sub, "scripts"))
        with open(os.path.join(self.sub, "scripts", "build"), "w") as fh:
            fh.write("x")
        cmd = "cd sub && p=scripts/build\nopen(p,'w').write(s)"
        self.assertEqual(
            [os.path.join(self.sub, "scripts/build")], targets(cmd, self.tmp)
        )

    def test_same_relative_path_under_two_directories_is_two_targets(self):
        os.makedirs(os.path.join(self.tmp, "other"))
        cmd = "cd sub && touch x.go && cd ../other && touch x.go"
        self.assertEqual(
            [os.path.join(self.sub, "x.go"), os.path.join(self.tmp, "other/x.go")],
            targets(cmd, self.tmp),
        )

    def test_subshell_cd_does_not_leak_past_the_closing_paren(self):
        # `(cd sub` does not lex as a plain `cd` segment, so the subshell's cd is
        # ignored entirely and y.go still resolves against the base. Tracking it
        # would mean tracking paren depth to un-track it at the `)`; ignoring it
        # keeps the pre-existing behaviour instead of getting y.go wrong.
        # (x.go inside the parens is lost to the trailing `)` on its token, as it
        # was before cd tracking existed — a separate, pre-existing gap.)
        cmd = "(cd sub && sed -i 's/a/b/' x.go) && sed -i 's/a/b/' y.go"
        self.assertEqual([os.path.join(self.tmp, "y.go")], targets(cmd, self.tmp))

    def test_cd_inside_a_heredoc_body_is_data_not_shell(self):
        # Found by replaying 9,091 real Bash commands against this change. Plans
        # and docs are written with `cat >> f <<'PLAN'`, and their bodies quote
        # shell examples. Treating those as real cds stacked them up and sent
        # every later candidate into <root>/svc-lib/svc-lib/... —
        # turning captures that had been CORRECT into phantoms.
        cmd = (
            "cat >> docs/plan.md <<'PLAN'\n"
            "cd svc-lib && go build ./...\n"
            "cd svc-lib\n"
            "Then edit manager/repo/rule.go\n"
            "PLAN\n"
            "sed -i 's/a/b/' after.go"
        )
        self.assertEqual(
            [os.path.join(self.tmp, "docs/plan.md"),
             os.path.join(self.tmp, "after.go")],
            targets(cmd, self.tmp),
        )
        # A shell body is scanned as a script of its own: its cd moves its own
        # targets, and never the outer command's.
        ran = (
            "bash -s <<'SH'\n"
            "cd svc-lib\n"
            "sed -i 's/a/b/' manager/repo/rule.go\n"
            "SH\n"
            "sed -i 's/a/b/' after.go"
        )
        got = targets(ran, self.tmp)
        self.assertIn(os.path.join(self.tmp, "svc-lib/manager/repo/rule.go"), got)
        self.assertIn(os.path.join(self.tmp, "after.go"), got)
        self.assertNotIn(os.path.join(self.tmp, "svc-lib/after.go"), got)
        # Nor is the body's word guessed where the heredoc was opened.
        self.assertNotIn(os.path.join(self.tmp, "manager/repo/rule.go"), got)

    def test_a_real_cd_still_applies_to_the_heredoc_it_opens(self):
        # The body is data, but the shell that opened it is not: candidates in
        # the body resolve against wherever the heredoc was opened.
        cmd = (
            "cd sub && cat > gen.go <<'EOF'\n"
            "cd somewhere-else\n"
            "package x\n"
            "EOF\n"
            "sed -i 's/a/b/' after.go"
        )
        self.assertEqual(
            [os.path.join(self.sub, "gen.go"), os.path.join(self.sub, "after.go")],
            targets(cmd, self.tmp),
        )

    def test_unterminated_heredoc_still_suppresses_body_cds(self):
        cmd = "python3 - > f.md <<'MD'\ncd svc-lib\nopen('manager/rule.go', 'w')"
        self.assertEqual(
            [os.path.join(self.tmp, "f.md"), os.path.join(self.tmp, "manager/rule.go")],
            targets(cmd, self.tmp),
        )

    def test_cd_through_a_literal_variable_assignment(self):
        # `W=/abs/path` then `cd "$W"` is how this workspace's commands are
        # actually written. Without expansion the cd is unknowable and every
        # relative target after it is dropped — a capture that used to work.
        cmd = "T=%s\ncd \"$T\"\nsed -i 's/a/b/' x.go" % self.sub
        self.assertEqual([os.path.join(self.sub, "x.go")], targets(cmd, self.tmp))

    def test_cd_through_a_variable_with_a_suffix(self):
        cmd = "T=%s\ncd \"$T/deep\"\nsed -i 's/a/b/' x.go" % self.sub
        self.assertEqual(
            [os.path.join(self.sub, "deep/x.go")], targets(cmd, self.tmp)
        )

    def test_cd_through_a_braced_variable(self):
        cmd = "T=%s\ncd ${T}\nsed -i 's/a/b/' x.go" % self.sub
        self.assertEqual([os.path.join(self.sub, "x.go")], targets(cmd, self.tmp))

    def test_relative_variable_assignment_resolves_against_the_current_dir(self):
        cmd = "cd sub\nD=deep\ncd \"$D\"\nsed -i 's/a/b/' x.go"
        self.assertEqual(
            [os.path.join(self.sub, "deep/x.go")], targets(cmd, self.tmp)
        )

    def test_variable_defined_from_another_variable(self):
        cmd = "T=%s\nW=$T/deep\ncd \"$W\"\nsed -i 's/a/b/' x.go" % self.sub
        self.assertEqual(
            [os.path.join(self.sub, "deep/x.go")], targets(cmd, self.tmp)
        )

    def test_undefined_or_uncomputable_variable_stays_unknowable(self):
        for cmd in ["cd \"$NEVER_SET\" && sed -i 's/a/b/' x.go",
                    "D=$(pwd)\ncd \"$D\"\nsed -i 's/a/b/' x.go",
                    "cd \"$HOME/x\" && sed -i 's/a/b/' x.go"]:
            with self.subTest(cmd=cmd):
                self.assertEqual([], targets(cmd, self.tmp), cmd)

    def test_assignment_inside_a_heredoc_body_does_not_define_anything(self):
        cmd = ("cat > doc.md <<'MD'\n"
               "T=/somewhere/else\n"
               "MD\n"
               "cd \"$T\" && sed -i 's/a/b/' x.go")
        self.assertEqual([os.path.join(self.tmp, "doc.md")], targets(cmd, self.tmp))

    def test_cd_chain_past_path_max_becomes_unknowable(self):
        # Resolving each cd against an ever-longer path is quadratic, and this
        # runs synchronously before every Bash call (120 ms for one 64 KiB
        # command before the bound). Past PATH_MAX the directory cannot be
        # opened anyway, so the walk gives up rather than keep building.
        chain = " && ".join("cd %s" % ("d" * 200) for _ in range(30))
        self.assertGreater(30 * 201, hook._MAX_CWD_LEN, "fixture must exceed the cap")
        self.assertEqual([], targets(chain + " && touch x.go", self.tmp))

    def test_a_cd_chain_within_path_max_still_resolves(self):
        chain = "cd a && cd b && cd c"
        self.assertEqual(
            [os.path.join(self.tmp, "a/b/c/x.go")],
            targets(chain + " && touch x.go", self.tmp),
        )

    def test_worst_case_command_stays_off_the_hot_path(self):
        # A backstop for the quadratic, not a benchmark: the threshold is loose
        # enough not to flake and tight enough to catch the 120 ms shape.
        import time
        worst = " && ".join("cd d" for _ in range(hook.MAX_COMMAND_CHARS // 8))
        start = time.perf_counter()
        hook.paths_from_command(worst[: hook.MAX_COMMAND_CHARS], self.tmp)
        elapsed = time.perf_counter() - start
        self.assertLess(elapsed, 0.09, "cd tracking went quadratic: %.3fs" % elapsed)

    def test_cd_alone_writes_nothing(self):
        self.assertEqual([], paths("cd sub", self.tmp))
        self.assertFalse(hook.command_may_write("cd sub"))


class HeredocFeederTest(unittest.TestCase):
    """A heredoc body is harvested only when something runs it. The body of
    `cat > f <<EOF` is f's content; the paths it mentions are text."""

    BODY = ('let p = home.join("cg/excludes.json");\n'
            'fs::write(base.join("gen/a.go"), "x");\n'
            "See docs/notes/sandbox.sql and open('other.json','w')\n")

    def test_file_writing_bodies_yield_only_the_target(self):
        for cmd in [
            "cat > core/tests/x.rs <<'EOF'\n" + self.BODY + "EOF",
            "cat >> plan.md <<'EOF'\n" + self.BODY + "EOF",
            "cat <<'EOF' > out.md\n" + self.BODY + "EOF",
            "cat <<EOF >> out.md\n" + self.BODY + "EOF",
            "tee out.md <<'EOF'\n" + self.BODY + "EOF",
            "tee -a out.md <<'EOF' >/dev/null\n" + self.BODY + "EOF",
            "cat <<-'EOF' > out.md\n\t" + self.BODY + "\tEOF",
            "cat <<'EOF' | sudo tee out.md\n" + self.BODY + "EOF",
        ]:
            with self.subTest(cmd=cmd.splitlines()[0]):
                got = paths(cmd)
                self.assertEqual(1, len(got), got)
                self.assertIn(got[0], ("core/tests/x.rs", "plan.md", "out.md"))

    def test_data_consumers_yield_nothing_from_the_body(self):
        # psql reads SQL, git reads a message: neither runs the body here.
        for cmd in ["psql -f - > rows.txt <<'SQL'\n" + self.BODY + "SQL",
                    "git commit -F - <<'MSG'\nfix: write cfg/app.yaml\nopen('x.json','w')\nMSG"]:
            with self.subTest(cmd=cmd.splitlines()[0]):
                self.assertNotIn("other.json", paths(cmd))
                self.assertNotIn("x.json", paths(cmd))
                self.assertNotIn("cfg/app.yaml", paths(cmd))

    def test_python_body_is_still_harvested(self):
        for head in ["python3 - <<'PY'", "python3 <<PY", "python3.12 - <<'PY'",
                     "uv run python - <<'PY'", "sudo -u svc python3 - <<'PY'",
                     "cat <<'PY' | python3"]:
            with self.subTest(head=head):
                cmd = head + "\nopen('x.json', 'w').write(s)\nPY"
                self.assertEqual(["x.json"], paths(cmd))

    def test_shell_body_is_still_harvested(self):
        self.assertEqual(["f.go"], paths("bash -s <<'SH'\nsed -i 's/a/b/' f.go\nSH"))
        self.assertEqual(["f.go"], paths("cat <<'SH' | sh\nsed -i 's/a/b/' f.go\nSH"))

    def test_unknown_feeder_keeps_harvesting(self):
        # `$PY` could be anything; doubt keeps the old behaviour.
        self.assertEqual(["x.json"],
                         paths("$PY - <<'PY'\nopen('x.json', 'w').write(s)\nPY"))

    def test_remote_shell_body_is_not_local(self):
        self.assertEqual([], paths("ssh host 'bash -s' <<'EOF'\nsed -i 's/a/b/' /etc/x.conf\nEOF"))
        self.assertEqual([], paths("cat <<'EOF' | ssh host bash\nsed -i 's/a/b/' /etc/x.conf\nEOF"))

    def test_two_heredocs_with_different_feeders(self):
        cmd = ("cat > notes.md <<'MD'\n"
               "mentions docs/a.md and open('nope.json','w')\n"
               "MD\n"
               "python3 - <<'PY'\n"
               "open('gen/out.json', 'w').write(s)\n"
               "PY")
        self.assertEqual(["notes.md", "gen/out.json"], paths(cmd))

    def test_file_written_then_run_is_harvested(self):
        # The body still executes, one step removed.
        for run in ["python3 /tmp/gen.py", "bash gen.py", "/tmp/gen.py", "source gen.py",
                    "/usr/bin/env python3 -I /tmp/gen.py",
                    "node --import ./register.mjs gen.py"]:
            with self.subTest(run=run):
                cmd = ("cat > /tmp/gen.py <<'PY'\n"
                       "open('gen/out.json', 'w').write(s)\n"
                       "PY\n" + run)
                self.assertIn("gen/out.json", paths(cmd))
        # Written but not run: content only.
        cmd = "cat > /tmp/gen.py <<'PY'\nopen('gen/out.json', 'w')\nPY\ncat /tmp/gen.py"
        self.assertEqual(["/tmp/gen.py"], paths(cmd))
        # Handed to a program as DATA, not run as its script: content only.
        cmd = ("cat > notes.body <<'MD'\nopen('gen/out.json', 'w')\nMD\n"
               "python3 render.py --out x.html notes.body")
        self.assertNotIn("gen/out.json", paths(cmd))

    def test_many_heredocs_stay_off_the_hot_path(self):
        # A backstop for the quadratic: each heredoc once walked the rest of
        # the command to find what it feeds (350 ms on this input).
        import time
        cmd = "".join("cat > f%d.txt <<E\nx\nE\n" % i
                      + "echo a b c d e f g h > /dev/null; " * 20 + "\n"
                      for i in range(300))[: hook.MAX_COMMAND_CHARS]
        start = time.perf_counter()
        hook.paths_from_command(cmd, "/w")
        elapsed = time.perf_counter() - start
        self.assertLess(elapsed, 0.15, "heredoc feeder lookup went quadratic: %.3fs" % elapsed)

    def test_body_still_never_steers_the_cwd_or_defines_variables(self):
        cmd = "python3 - <<'PY'\nT=/elsewhere\ncd sub\nPY\nsed -i 's/a/b/' \"$T\"/x.go"
        self.assertEqual([], [p for p, c in hook.paths_from_command(cmd, "/w") if "elsewhere" in p])


class HeredocFeederEdgeTest(unittest.TestCase):
    """Shapes found in review: a feeder hidden behind a subshell or a
    substitution, bodies that list files, and files run one step removed."""

    B = "open('x.json', 'w').write(s)"

    def test_interpreter_behind_a_subshell_or_substitution(self):
        for cmd in [
            "(python3 - <<'EOF'\n%s\nEOF\n) | tail" % self.B,
            "echo $(python3 - <<'EOF'\n%s\nEOF\n)" % self.B,
            "OUT=$(python3 - <<'EOF'\n%s\nEOF\n)" % self.B,
            "env FOO=1 python3 - <<'EOF'\n%s\nEOF" % self.B,
        ]:
            with self.subTest(cmd=cmd.splitlines()[0]):
                self.assertIn("x.json", paths(cmd))

    def test_bodies_that_list_files_for_a_writer(self):
        for cmd in [
            "while read f; do sed -i 's/a/b/' \"$f\"; done <<'EOF'\nf.go\nEOF",
            "cat <<'EOF' | while read f; do gofmt -w \"$f\"; done\nf.go\nEOF",
            "xargs sed -i 's/a/b/' <<'EOF'\nf.go\nEOF",
            "cat <<'EOF' | xargs sed -i 's/a/b/'\nf.go\nEOF",
        ]:
            with self.subTest(cmd=cmd.splitlines()[0]):
                self.assertIn("f.go", paths(cmd))
        # tee's stdin is the content it writes, not a list of names.
        self.assertEqual(["out.md"], paths("cat <<'EOF' | tee out.md\nf.go\nEOF"))

    def test_unknown_runners_in_front_of_an_interpreter_still_harvest(self):
        # Runners are an open set: an unrecognised word does not end the search.
        for head in ["conda run -n env python -", "pipx run python -",
                     "mise exec -- python3 -", "pyenv exec python -",
                     "op run -- python3 -", "npm exec -- tsx -",
                     "nix-shell -p python3 --run python3", "devbox run python3 -",
                     "flock /tmp/l python3 -", "watch -n1 python3 -",
                     "timeout 30s python3 -", "sudo -u svc python3 -"]:
            with self.subTest(head=head):
                self.assertIn("x.json", paths("%s <<'EOF'\n%s\nEOF" % (head, self.B)))

    def test_shell_verdict_needs_the_command_position(self):
        # Behind an unknown word a shell's body is harvested, not scanned as
        # shell: its `sed -i f.go` is not an explicit target.
        self.assertEqual([], paths("flock /tmp/l bash -s <<'EOF'\nsed -i s/a/b/ f.go\nEOF"))
        self.assertEqual(["f.go"], paths("sudo bash -s <<'EOF'\nsed -i s/a/b/ f.go\nEOF"))

    def test_heredoc_after_a_descriptor_duplication(self):
        for head in ["python3 - 2>&1", "uv run python - 2>&1",
                     "python3 - >out.log 2>&1", "(uv run python - > r.txt 2>&1"]:
            with self.subTest(head=head):
                tail = "\n)" if head.startswith("(") else ""
                self.assertIn("x.json",
                              paths("%s <<'EOF'\n%s\nEOF%s" % (head, self.B, tail)))
        self.assertEqual(["f.go"], paths("bash -s 2>&1 <<'EOF'\nsed -i s/a/b/ f.go\nEOF"))

    def test_descriptor_duplication_leaves_other_operators_alone(self):
        self.assertEqual(["log"], paths("go build &>log"))
        self.assertEqual(["out.txt"], paths("cmd 2>/dev/null > out.txt"))
        self.assertEqual(["out.txt"], paths("cmd 2>&1 > out.txt"))
        self.assertEqual(["out.txt"], paths("echo x >&2 && echo y > out.txt"))
        self.assertEqual(["out.txt"], paths("sleep 1 & echo y > out.txt"))
        self.assertEqual(["f.go"], paths("go build 2>&1 && sed -i s/a/b/ f.go"))
        self.assertEqual([], paths("echo x 2>&1 file.go"))

    def test_shell_with_a_script_operand_is_not_scanned_as_shell(self):
        # The body is deploy.sh's stdin, not shell we can read.
        self.assertEqual([], paths("bash deploy.sh <<'EOF'\nrm > out.txt\nEOF"))
        self.assertEqual(["f.go"], paths("bash <<'EOF'\nsed -i 's/a/b/' f.go\nEOF"))

    def test_bare_r_counts_only_as_the_command(self):
        self.assertEqual(["x.json"], paths("R --vanilla <<'EOF'\n%s\nEOF" % self.B))
        self.assertEqual(["out.md"], paths("echo R > out.md <<'EOF'\n%s\nEOF" % self.B))

    def test_written_then_run_one_step_removed(self):
        for write, run in [
            ("cat > g.py", "uv run g.py"),
            ("cat > main.go", "go run main.go"),
            ("cat > g.py", "python3 -m g"),
            ("cat > g.ts", "npx tsx g.ts"),
        ]:
            with self.subTest(run=run):
                cmd = "%s <<'EOF'\n%s\nEOF\n%s" % (write, self.B, run)
                self.assertIn("x.json", paths(cmd))
        cmd = "cat <<'EOF' | tee g.py >/dev/null\n%s\nEOF\npython3 g.py" % self.B
        self.assertIn("x.json", paths(cmd))
        # `make` is codegen: the command's speculative pass is off (C1).
        self.assertEqual(["Makefile"],
                         paths("cat > Makefile <<'EOF'\n%s\nEOF\nmake" % self.B))
        # Staging or reading the file does not run it.
        for after in ["git add g.py", "cat g.py", "chmod +x g.py"]:
            with self.subTest(after=after):
                cmd = "cat > g.py <<'EOF'\n%s\nEOF\n%s" % (self.B, after)
                self.assertNotIn("x.json", paths(cmd))

    def test_two_heredocs_on_one_line(self):
        for cmd in [
            "cat > a.md <<A; python3 - <<B\nmention docs/z.md\nA\n%s\nB" % self.B,
            "python3 - <<B; cat > a.md <<A\n%s\nB\nmention docs/z.md\nA" % self.B,
        ]:
            with self.subTest(cmd=cmd.splitlines()[0]):
                got = paths(cmd)
                self.assertIn("a.md", got)
                self.assertIn("x.json", got)
                self.assertNotIn("docs/z.md", got)


class UnresolvedVariableTest(unittest.TestCase):
    """An explicit target whose variable cannot be expanded is reported, not
    guessed; a literal assignment earlier in the command is substituted."""

    def test_unknown_variables_are_reported(self):
        for cmd, raw in [("cat > $T/x <<'EOF'\nhi\nEOF", "$T/x"),
                         ("sed -i 's/a/b/' \"$F\"", "$F"),
                         ("echo x > ${name}_test.go", "${name}_test.go")]:
            with self.subTest(cmd=cmd):
                cands, unresolved = hook.scan_targets(cmd, "/w")
                self.assertEqual([raw], unresolved)
                self.assertEqual([], [p for p, _ in cands if "$" in p])

    def test_literal_assignment_is_substituted_into_a_target(self):
        cands, unresolved = hook.scan_targets("F=gen/a.go\nsed -i 's/a/b/' \"$F\"", "/w")
        self.assertIn("gen/a.go", [p for p, _ in cands])
        self.assertEqual([], unresolved)

    def test_variable_scope(self):
        cases = [
            ("export F=a.go; sed -i s/a/b/ \"$F\"", "a.go", []),
            ("local F=a.go; sed -i s/a/b/ \"$F\"", "a.go", []),
            ("F=a.go; unset F; sed -i s/a/b/ \"$F\"", None, ["$F"]),
            ("F=a.go cmd; sed -i s/a/b/ \"$F\"", None, ["$F"]),
            ("F=a.go; read F; sed -i s/a/b/ \"$F\"", None, ["$F"]),
            ("F=a.go; for F in b c; do sed -i s/a/b/ \"$F\"; done", None, ["$F"]),
        ]
        for cmd, want, unresolved in cases:
            with self.subTest(cmd=cmd):
                _c, got_unresolved = hook.scan_targets(cmd, "/w")
                self.assertEqual(unresolved, got_unresolved)
                if want:
                    self.assertIn(want, [p for p, _ in _c])

    def test_many_assignments_stay_off_the_hot_path(self):
        # A dict snapshot per segment copied a growing env 20,000 times.
        import time
        cmd = "".join("A%d=x;" % i for i in range(20000))[: hook.MAX_COMMAND_CHARS - 20]
        cmd += "\nsed -i s/a/b/ f.go"
        start = time.perf_counter()
        hook.paths_from_command(cmd, "/w")
        elapsed = time.perf_counter() - start
        self.assertLess(elapsed, 0.09, "env tracking went quadratic: %.3fs" % elapsed)

    def test_speculative_words_are_never_reported(self):
        _c, unresolved = hook.scan_targets(
            "python3 - <<'PY'\nopen(f'$HOME/{x}.json', 'w')\nPY", "/w")
        self.assertEqual([], unresolved)


class EnvironmentFallbackTest(unittest.TestCase):
    """A name the command never assigns may come from the hook's environment
    (`cd $PROJ_PATH`, exported from the shell rc) — guarded."""

    def setUp(self):
        from unittest import mock
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.root = os.path.join(self.tmp, "root")
        os.makedirs(os.path.join(self.root, "svc"))
        roots = os.path.join(self.tmp, "workspace-roots.json")
        with open(roots, "w") as f:
            json.dump([self.root], f)
        self.patches = [
            mock.patch.object(hook, "WORKSPACE_ROOTS_FILE", roots),
            mock.patch.dict(os.environ, {"PROJ_V": self.root}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def got(self, cmd):
        return targets(cmd, "/elsewhere")

    def test_exported_root_variable_resolves_a_cd(self):
        self.assertEqual([os.path.join(self.root, "f.go")],
                         self.got("cd $PROJ_V && sed -i 's/a/b/' f.go"))

    def test_braced_and_quoted_forms_resolve(self):
        self.assertEqual([os.path.join(self.root, "svc/x.go")],
                         self.got("sed -i 's/a/b/' ${PROJ_V}/svc/x.go"))
        self.assertEqual([os.path.join(self.root, "svc/y.go")],
                         self.got('echo x > "$PROJ_V"/svc/y.go'))

    def test_target_inside_a_root_need_not_exist_yet(self):
        self.assertEqual([os.path.join(self.root, "new/dir/a.yaml")],
                         self.got("cat > $PROJ_V/new/dir/a.yaml <<EOF\nx\nEOF"))

    def test_assignment_in_the_command_wins(self):
        other = os.path.join(self.tmp, "other")
        os.makedirs(other)
        self.assertEqual([os.path.join(other, "f.go")],
                         self.got("PROJ_V=%s; cd $PROJ_V && sed -i 's/a/b/' f.go" % other))
        # Even an unknowable one: it stays unknown, never the environment.
        self.assertEqual([], self.got("PROJ_V=$(pwd); cd $PROJ_V && sed -i 's/a/b/' f.go"))

    def test_unset_before_use_stays_unknown(self):
        self.assertEqual([], self.got("unset PROJ_V; cd $PROJ_V && sed -i 's/a/b/' f.go"))

    def test_relative_value_stays_unknown(self):
        from unittest import mock
        with mock.patch.dict(os.environ, {"PROJ_V": "root"}):
            self.assertEqual([], self.got("cd $PROJ_V && sed -i 's/a/b/' f.go"))

    def test_missing_path_outside_every_root_stays_unknown(self):
        from unittest import mock
        with mock.patch.dict(os.environ, {"PROJ_V": os.path.join(self.tmp, "gone")}):
            self.assertEqual([], self.got("cd $PROJ_V && sed -i 's/a/b/' f.go"))
            self.assertEqual([], self.got("echo x > $PROJ_V/sub/a.go"))

    def test_shell_managed_names_stay_unknown(self):
        from unittest import mock
        with mock.patch.dict(os.environ, {"HOME": self.root, "PWD": self.root,
                                          "CLAUDE_X": self.root}):
            for var in ("HOME", "PWD", "CLAUDE_X"):
                with self.subTest(var=var):
                    self.assertEqual([], self.got("cd $%s && sed -i 's/a/b/' f.go" % var))
                    self.assertEqual([], self.got("echo x > $%s/a.go" % var))

    def test_no_fallback_after_loading_unseen_variables(self):
        for prefix in ["source .env && ", ". ./.env; ", "set -a; ", "eval \"$(direnv export bash)\"; ",
                       "export $(cat .env | xargs); ", "printf -v PROJ_V %s x; "]:
            with self.subTest(prefix=prefix):
                self.assertEqual([], [p for p in self.got(prefix + "cd $PROJ_V && sed -i 's/a/b/' f.go")
                                      if p.startswith(self.root)])
        # Before the load, the fallback still applies.
        self.assertIn(os.path.join(self.root, "f.go"),
                      self.got("cd $PROJ_V && sed -i 's/a/b/' f.go; source .env"))

    def test_speculative_words_never_use_the_environment(self):
        got = self.got("python3 - <<'PY'\nopen('$PROJ_V/a.json', 'w')\nPY")
        self.assertEqual([], [p for p in got if p.startswith(self.root)])


class ImplicitOperationTest(unittest.TestCase):
    """Commands that bring in other people's changes, or rewrite files without
    naming them, never capture; they are noted once as `skip-implicit`."""

    NEVER = [
        ("git pull", "git pull"), ("git merge origin/main", "git merge"),
        ("git rebase main", "git rebase"), ("git cherry-pick abc123", "git cherry-pick"),
        ("git revert HEAD", "git revert"), ("git stash pop", "git stash"),
        ("git stash apply", "git stash"), ("git reset --hard origin/main", "git reset"),
        ("git checkout feature/x", "git checkout"), ("git switch main", "git switch"),
        ("git -C svc-lib pull --rebase", "git pull"), ("go generate ./...", "go generate"),
        ("make gen", "make gen"), ("make", "make"), ("protoc --go_out=. a.proto", "protoc --go_out=."),
        ("sqlc generate", "sqlc generate"), ("swag init", "swag init"),
        ("buf generate", "buf generate"), ("unzip x.zip -d out", "unzip x.zip"),
        ("tar -xzf a.tgz", "tar -xzf"), ("tar xf a.tar", "tar xf"),
        ("tar --extract -f a.tar", "tar --extract"),
    ]

    def test_never_capture_commands_yield_nothing_and_one_note(self):
        for cmd, label in self.NEVER:
            with self.subTest(cmd=cmd):
                full = hook.scan_full(cmd, "/w")
                self.assertEqual([], full["candidates"])
                self.assertEqual([("skip-implicit", label)], full["notes"])

    def test_one_note_per_command(self):
        full = hook.scan_full("git pull && make gen && git merge x", "/w")
        self.assertEqual([("skip-implicit", "git pull")], full["notes"])

    def test_truncation_is_logged_once(self):
        full = hook.scan_full(" ".join("echo x > f%d.txt;" % i for i in range(30)), "/w")
        self.assertEqual(hook.MAX_CANDIDATES, len(full["candidates"]))
        self.assertEqual([("skip-budget", "5 dropped (first: f25.txt)")],
                         [n for n in full["notes"] if n[0] == "skip-budget"])
        tmp = os.path.realpath(tempfile.mkdtemp())
        try:
            cmd = "rm " + " ".join("f%d.go" % i for i in range(hook._FS_OPERAND_BUDGET + 3))
            notes = hook.scan_full(cmd, tmp)["notes"]
            self.assertIn(("skip-budget", "3 dropped (first: f%d.go)" % hook._FS_OPERAND_BUDGET), notes)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        self.assertFalse([n for n in hook.scan_full("echo x > a.txt", "/w")["notes"]])

    def test_mixed_command_still_captures_its_explicit_target(self):
        full = hook.scan_full("cd sub && git pull && sed -i 's/a/b/' f.go", "/w")
        self.assertEqual([("f.go", "/w/sub")], full["candidates"])
        self.assertEqual([("skip-implicit", "git pull")], full["notes"])

    def test_explicit_pathspec_forms_still_capture(self):
        self.assertEqual(["pkg/a.go"], paths("git checkout -- pkg/a.go"))
        self.assertEqual(["pkg/a.go"], paths("git checkout origin/main -- pkg/a.go"))
        self.assertEqual(["pkg/a.go"], paths("git restore pkg/a.go"))
        self.assertEqual(["fix.patch"], paths("git apply fix.patch"))
        self.assertEqual([], hook.scan_full("git apply fix.patch", "/w")["notes"])

    def test_no_speculation_at_all_in_an_implicit_command(self):
        # C1: once a command pulls, generates or extracts, its words may name
        # what that rewrote; only explicit targets elsewhere still count.
        tmp = os.path.realpath(tempfile.mkdtemp())
        try:
            for rel in ("src/app.ts", "internal/gen/models.go"):
                os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
                open(os.path.join(tmp, rel), "w").close()
            for cmd in [
                "make gen OUT=internal/gen/models.go > /tmp/g.log 2>&1",
                "buf generate internal/gen/models.go 2>&1 | tail -3 > /tmp/b.txt",
                "git stash pop 2>&1 | tee /tmp/s.log; git diff --stat src/app.ts",
                "git pull > /tmp/p.log; git log -- src/app.ts",
                "git pull && python3 - <<'PY'\nopen('src/app.ts','w').write(s)\nPY",
                "git pull && python3 -c \"open('src/app.ts','w')\"",
            ]:
                with self.subTest(cmd=cmd.splitlines()[0]):
                    got = [p for p, _ in hook.scan_full(cmd, tmp)["candidates"]]
                    self.assertFalse([p for p in got if not p.startswith("/tmp/") or p == "/tmp/g.log"], got)
            # The explicit target of another segment is still captured.
            self.assertEqual(["src/app.ts"],
                             [p for p, _ in hook.scan_full("git pull && sed -i s/a/b/ src/app.ts", tmp)["candidates"]])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_more_implicit_shapes(self):
        for cmd, label in [("git checkout -- .", "git checkout"), ("git checkout -- src/", "git checkout"),
                           ("git restore .", "git restore"), ("git restore --source=HEAD~3 .", "git restore"),
                           ("git stash", "git stash"), ("git stash -u", "git stash"),
                           ("git clean -fdx", "git clean"), ("git am x.patch", "git am"),
                           ("npm run gen", "npm run gen"), ("npm run generate:api", "npm run generate:api"),
                           ("timeout 60 buf generate", "buf generate"), ("npx prisma generate", "prisma generate"),
                           ("nice -n 5 make gen", "make gen"), ("git checkout release/1.x", "git checkout"),
                           ("git checkout feature/x.go", "git checkout")]:
            with self.subTest(cmd=cmd):
                full = hook.scan_full(cmd, "/nonexistent-dir")
                self.assertEqual([], full["candidates"])
                self.assertEqual([("skip-implicit", label)], full["notes"])
        for cmd in ["git stash list", "git stash show -p", "npm run test"]:
            with self.subTest(cmd=cmd):
                self.assertEqual([], hook.scan_full(cmd, "/w")["notes"])

    def test_implicit_ops_inside_subshells_substitutions_and_wrappers(self):
        # N1: `(git`, `$(git`, `` `git `` arrive glued; xargs/watch carry options.
        tmp = os.path.realpath(tempfile.mkdtemp())
        try:
            for rel in ("src/app.ts", "internal/gen/models.go", "dir/x"):
                os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
                open(os.path.join(tmp, rel), "w").close()
            cases = [
                ("(cd dir && git pull); sed -i s/a/b/ src/app.ts; git diff internal/gen/models.go",
                 "git pull", ["src/app.ts"]),
                ("(make gen) > /tmp/o; cat internal/gen/models.go", "make gen", []),
                ("OUT=$(git pull 2>&1); echo \"$OUT\" > /tmp/o; cat src/app.ts", "git pull", ["/tmp/o"]),
                ("echo `git stash pop` > /tmp/o; cat src/app.ts", "git stash", []),
                ("echo $(git stash pop) > /tmp/o; cat src/app.ts", "git stash", []),
                ("( git stash pop ) && python3 - <<E\nopen('src/app.ts','w')\nE", "git stash", []),
                ("xargs -n1 git pull > /tmp/o; cat src/app.ts", "git pull", []),
                ("xargs -n 1 git pull > /tmp/o; cat src/app.ts", "git pull", []),
                ("watch git pull > /tmp/o; cat src/app.ts", "git pull", []),
                ("watch -n 5 make gen > /tmp/o; cat src/app.ts", "make gen", []),
                ("(git pull)", "git pull", []),
            ]
            for cmd, label, want in cases:
                with self.subTest(cmd=cmd.splitlines()[0]):
                    full = hook.scan_full(cmd, tmp)
                    self.assertIn(("skip-implicit", label), full["notes"])
                    self.assertEqual(want, [p for p, _ in full["candidates"]])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_more_extractors_and_builds(self):
        for cmd, label in [("bsdtar -xf a.tar", "bsdtar -xf"), ("7z x a.7z", "7z x"),
                           ("7za x a.7z", "7za x"), ("gunzip a.gz", "gunzip a.gz"),
                           ("gzip -d a.gz", "gzip -d"), ("npm run build", "npm run build"),
                           ("pnpm run build:web", "pnpm run build:web"), ("yarn build", "yarn run build")]:
            with self.subTest(cmd=cmd):
                self.assertEqual([("skip-implicit", label)], hook.scan_full(cmd, "/w")["notes"])
        for cmd in ["gzip a.txt", "7z a out.7z src", "bsdtar -cf a.tar src"]:
            with self.subTest(cmd=cmd):
                self.assertEqual([], hook.scan_full(cmd, "/w")["notes"])

    def test_checkout_of_an_existing_file_is_a_restore(self):
        tmp = os.path.realpath(tempfile.mkdtemp())
        try:
            open(os.path.join(tmp, "a.go"), "w").close()
            full = hook.scan_full("git checkout a.go", tmp)
            self.assertEqual([("a.go", tmp)], full["candidates"])
            self.assertEqual([], full["notes"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_unfollowable_deletions_are_logged(self):
        for cmd, label in [("find . -name '*.o' -delete", "find -delete"),
                           ("find . -name x -exec rm {} +", "find -exec rm"),
                           ("xargs rm < list.txt", "xargs rm")]:
            with self.subTest(cmd=cmd):
                self.assertIn(("skip-unsupported", label), hook.scan_full(cmd, "/w")["notes"])

    def test_tar_create_is_not_an_extract(self):
        self.assertEqual([], hook.scan_full("tar -czf a.tgz src", "/w")["notes"])


class DeletionTest(unittest.TestCase):
    """`rm` / `git rm` operands are targets: the file is snapshotted before it
    goes, and Reject writes it back."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        for rel in ("a.go", "b.go", "src/x.go", "d/one.txt", "d/sub/two.txt", ".git/config"):
            path = os.path.join(self.tmp, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as f:
                f.write(rel)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def full(self, cmd):
        return hook.scan_full(cmd, self.tmp)

    def test_rm_and_git_rm_operands_are_targets(self):
        for cmd in ["rm src/x.go", "rm -f src/x.go", "rm -- src/x.go",
                    "git rm src/x.go", "git rm -q src/x.go", "rm src/x.go # gone"]:
            with self.subTest(cmd=cmd):
                self.assertEqual([("src/x.go", self.tmp)], self.full(cmd)["candidates"])
        self.assertEqual(["a.go", "b.go"], paths("rm a.go b.go", self.tmp))

    def test_dash_named_file_after_double_dash(self):
        open(os.path.join(self.tmp, "-x"), "w").close()
        self.assertEqual([("./-x", self.tmp)], self.full("rm -- -x")["candidates"])

    def test_missing_file_is_not_a_new_file(self):
        self.assertEqual([], self.full("rm -f gone.go")["candidates"])

    def test_git_rm_cached_removes_nothing(self):
        self.assertEqual([], self.full("git rm --cached src/x.go")["candidates"])

    def test_globs_are_logged_not_expanded(self):
        full = self.full("rm *.go src/?.go")
        self.assertEqual([], full["candidates"])
        self.assertEqual([("skip-glob", "*.go"), ("skip-glob", "src/?.go")], full["notes"])

    def test_git_dir_is_never_touched(self):
        self.assertEqual([], self.full("rm -rf .git/config")["candidates"])
        self.assertEqual([], self.full("rm -rf .git")["dirs"])
        files, overflow = hook._walk_files(self.tmp)
        self.assertFalse(overflow)
        self.assertFalse([f for f in files if "/.git/" in f])

    def test_recursive_rm_hands_the_directory_to_the_walk(self):
        full = self.full("rm -rf d")
        self.assertEqual([os.path.join(self.tmp, "d")], full["dirs"])
        self.assertEqual([], full["candidates"])
        files, overflow = hook._walk_files(os.path.join(self.tmp, "d"))
        self.assertFalse(overflow)
        self.assertEqual([os.path.join(self.tmp, "d/one.txt"),
                          os.path.join(self.tmp, "d/sub/two.txt")], files)
        # Without -r, rm cannot remove a directory: nothing to capture.
        self.assertEqual([], self.full("rm d")["dirs"])

    def test_walk_never_follows_a_symlink(self):
        outside = os.path.join(self.tmp, "outside")
        os.makedirs(outside)
        with open(os.path.join(outside, "secret.txt"), "w") as f:
            f.write("x")
        os.symlink(outside, os.path.join(self.tmp, "d", "link"))
        os.symlink(os.path.join(outside, "secret.txt"), os.path.join(self.tmp, "d", "file-link"))
        files, _ = hook._walk_files(os.path.join(self.tmp, "d"))
        self.assertFalse([f for f in files if "link" in f or "secret" in f], files)
        # A symlink operand: rm removes the link, not a file we could restore.
        self.assertEqual([], self.full("rm d/file-link")["candidates"])
        self.assertEqual([], self.full("rm -rf d/link")["dirs"])

    def test_walk_stops_at_the_cap(self):
        big = os.path.join(self.tmp, "big")
        os.makedirs(big)
        for i in range(hook.RM_WALK_CAP + 1):
            open(os.path.join(big, "f%d.txt" % i), "w").close()
        _files, overflow = hook._walk_files(big)
        self.assertTrue(overflow)
        os.remove(os.path.join(big, "f0.txt"))
        files, overflow = hook._walk_files(big)
        self.assertFalse(overflow)
        self.assertEqual(hook.RM_WALK_CAP, len(files))

    def test_entry_budget_is_shared_by_every_walk_of_a_command(self):
        for d in ("w1", "w2"):
            os.makedirs(os.path.join(self.tmp, d))
            for i in range(30):
                open(os.path.join(self.tmp, d, "f%d.txt" % i), "w").close()
        budget = [40]
        _f, overflow = hook._walk_files(os.path.join(self.tmp, "w1"), entries=budget)
        self.assertFalse(overflow)
        _f, overflow = hook._walk_files(os.path.join(self.tmp, "w2"), entries=budget)
        self.assertTrue(overflow, "the second walk must stop on what the first left")

    def test_walk_of_a_large_tree_stays_off_the_hot_path(self):
        import time
        big = os.path.join(self.tmp, "huge")
        for i in range(40):
            sub = os.path.join(big, "p%d" % i)
            os.makedirs(sub)
            for j in range(100):
                open(os.path.join(sub, "f%d.go" % j), "w").close()
        start = time.perf_counter()
        _files, overflow = hook._walk_files(big)
        elapsed = time.perf_counter() - start
        self.assertTrue(overflow)
        self.assertLess(elapsed, 0.05, "walk did not stop at the cap: %.3fs" % elapsed)

    def test_many_operands_stay_off_the_hot_path(self):
        # Each operand is a stat or two; a 64 KiB `rm a b c …` must not pay
        # for thousands of them (_FS_OPERAND_BUDGET).
        import time
        for cmd in ["rm " + " ".join("d%d/f%d.go" % (i, i) for i in range(8000)),
                    " ; ".join("npm i x%d" % i for i in range(5000))]:
            cmd = cmd[: hook.MAX_COMMAND_CHARS]
            start = time.perf_counter()
            hook.paths_from_command(cmd, self.tmp)
            elapsed = time.perf_counter() - start
            self.assertLess(elapsed, 0.09, "operand checks went unbounded: %.3fs" % elapsed)

    def test_deletion_alone_does_not_switch_on_speculation(self):
        # `docs/notes.md` exists but is only mentioned: rm names a.go alone.
        self.assertEqual(["a.go"], paths("rm a.go && echo see docs/notes.md b.go", self.tmp))


class NamedWriteTest(unittest.TestCase):
    """Commands that name the file they write as an argument."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        os.makedirs(os.path.join(self.tmp, "d"))
        open(os.path.join(self.tmp, "exists.txt"), "w").close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def full(self, cmd):
        return hook.scan_full(cmd, self.tmp)

    def names(self, cmd):
        return [p for p, _ in self.full(cmd)["candidates"]]

    def test_curl_output_forms(self):
        for cmd in ["curl -o data.json https://x/y", "curl -sSLo data.json https://x/y",
                    "curl --output data.json https://x/y", "curl --output=data.json https://x/y",
                    "curl -H 'A: b' -o data.json https://x/y"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(["data.json"], self.names(cmd))

    def test_curl_remote_name_uses_the_url_basename(self):
        self.assertEqual(["file.tgz"], self.names("curl -LO https://h/p/file.tgz?v=1"))
        self.assertEqual(["a.zip"], self.names("curl --remote-name https://h/a.zip"))
        full = self.full("curl -OJ https://h/dl")
        self.assertEqual([], full["candidates"])
        self.assertEqual([("skip-unknown-name", "curl -J")], full["notes"])
        self.assertEqual([("skip-unknown-name", "https://h/")], self.full("curl -O https://h/")["notes"])

    def test_wget_output_forms(self):
        for cmd in ["wget -O page.html https://x", "wget -qO page.html https://x",
                    "wget --output-document=page.html https://x",
                    "wget --output-document page.html https://x"]:
            with self.subTest(cmd=cmd):
                self.assertEqual(["page.html"], self.names(cmd))

    def test_stdout_and_devices_are_not_targets(self):
        for cmd in ["curl https://x", "curl -o - https://x", "curl -o /dev/null https://x",
                    "wget -qO- https://x", "wget -O /dev/null https://x"]:
            with self.subTest(cmd=cmd):
                self.assertEqual([], self.names(cmd))

    def test_git_mv_captures_both_sides(self):
        self.assertEqual(["a.go", "b.go"], self.names("git mv a.go b.go"))
        self.assertEqual([], self.names("git mv -n a.go b.go"))
        # Moving a directory moves files it does not name.
        full = self.full("git mv d e")
        self.assertEqual([], full["candidates"])
        self.assertEqual([("skip-unknown-name", "git mv d e")], full["notes"])

    def test_ln_captures_only_a_new_link(self):
        self.assertEqual(["link.go"], self.names("ln -s ../t.go link.go"))
        self.assertEqual(["link.go"], self.names("ln ../t.go link.go"))
        self.assertEqual(["y.sh"], self.names("ln -s ../x/y.sh"))
        # Replacing an existing path: Reject would write through the new link.
        full = self.full("ln -sf ../t.go exists.txt")
        self.assertEqual([], full["candidates"])
        self.assertEqual([("skip-link-replace", "exists.txt")], full["notes"])
        self.assertEqual([], self.names("ln -s ../t.go d"))
        # A link to a directory has no content to review.
        self.assertEqual([], self.names("ln -s d d-link"))
        self.assertEqual([], self.names("ln -s ../%s/d d-link2" % os.path.basename(self.tmp)))

    def test_curl_output_dir(self):
        self.assertEqual(["dl/a.json"], self.names("curl --output-dir dl -O https://x/a.json"))
        self.assertEqual(["dl/b.json"], self.names("curl --output-dir=dl -o b.json https://x"))
        self.assertEqual(["/abs/b.json"], self.names("curl --output-dir dl -o /abs/b.json https://x"))

    def test_copying_a_symlink_does_not_capture_the_destination(self):
        os.symlink("exists.txt", os.path.join(self.tmp, "flink"))
        for cmd in ["cp -a flink dest.txt", "cp -P flink dest.txt", "cp -R flink dest.txt", "mv flink dest.txt"]:
            with self.subTest(cmd=cmd):
                full = self.full(cmd)
                self.assertNotIn("dest.txt", [p for p, _ in full["candidates"]])
                self.assertIn(("skip-link-replace", "dest.txt"), full["notes"])
        # A plain cp follows the link and writes a regular file: captured.
        self.assertIn("dest.txt", self.names("cp flink dest.txt"))

    def test_named_writes_do_not_switch_on_speculation(self):
        self.assertEqual(["out.json"], self.names("curl -o out.json https://x && echo see notes.md"))


class ManifestTest(unittest.TestCase):
    """Package commands rewrite their manifest and lockfile without naming
    them. Only the files that already exist are captured."""

    ALL = ("go.mod", "go.sum", "package.json", "package-lock.json", "pnpm-lock.yaml",
           "yarn.lock", "bun.lock", "Cargo.toml", "Cargo.lock", "pyproject.toml",
           "uv.lock", "poetry.lock")

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        for f in self.ALL:
            open(os.path.join(self.tmp, f), "w").close()
        os.makedirs(os.path.join(self.tmp, "web"))
        open(os.path.join(self.tmp, "web", "package.json"), "w").close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def names(self, cmd):
        return [os.path.relpath(p, self.tmp) for p, _ in hook.scan_full(cmd, self.tmp)["candidates"]]

    def test_each_manifest_command(self):
        cases = [
            ("go mod tidy", ["go.mod", "go.sum"]),
            ("go get example.com/x@v1.2.3", ["go.mod", "go.sum"]),
            ("npm install", ["package.json", "package-lock.json"]),
            ("npm i -D left-pad", ["package.json", "package-lock.json"]),
            ("npm uninstall left-pad", ["package.json", "package-lock.json"]),
            ("pnpm add zod", ["package.json", "pnpm-lock.yaml"]),
            ("yarn add zod", ["package.json", "yarn.lock"]),
            ("yarn", ["package.json", "yarn.lock"]),
            ("bun add zod", ["package.json", "bun.lock"]),
            ("cargo add serde", ["Cargo.toml", "Cargo.lock"]),
            ("uv add httpx", ["pyproject.toml", "uv.lock"]),
            ("uv sync", ["pyproject.toml", "uv.lock"]),
            ("poetry lock", ["pyproject.toml", "poetry.lock"]),
        ]
        for cmd, want in cases:
            with self.subTest(cmd=cmd):
                self.assertEqual(want, self.names(cmd))

    def test_read_only_and_global_commands_capture_nothing(self):
        for cmd in ["go build ./...", "go mod download", "npm test", "npm run build",
                    "npm ci --dry-run", "npm i -g typescript", "cargo build", "uv run pytest",
                    "poetry run pytest", "yarn test"]:
            with self.subTest(cmd=cmd):
                self.assertEqual([], self.names(cmd))

    def test_only_existing_files(self):
        os.remove(os.path.join(self.tmp, "go.sum"))
        os.remove(os.path.join(self.tmp, "bun.lock"))
        self.assertEqual(["go.mod"], self.names("go mod tidy"))
        self.assertEqual(["package.json"], self.names("bun install"))

    def test_project_directory_options(self):
        for cmd in ["npm --prefix web install", "npm install --prefix web", "npm -C web i",
                    "yarn --cwd web add zod", "pnpm --dir=web add zod", "cd web && npm install"]:
            with self.subTest(cmd=cmd):
                self.assertEqual([os.path.join("web", "package.json")], self.names(cmd))
        self.assertEqual(["Cargo.toml", "Cargo.lock"],
                         self.names("cargo add serde --manifest-path Cargo.toml"))

    def test_walks_up_to_the_nearest_manifest_within_the_root(self):
        from unittest import mock
        os.makedirs(os.path.join(self.tmp, "web", "src", "deep"))
        roots = os.path.join(self.tmp, "roots.json")
        with open(roots, "w") as f:
            json.dump([self.tmp], f)
        with mock.patch.object(hook, "WORKSPACE_ROOTS_FILE", roots):
            self.assertEqual([os.path.join("web", "package.json")],
                             self.names("cd web/src/deep && npm install"))
        # Outside every root nothing is walked: only the directory itself.
        with mock.patch.object(hook, "WORKSPACE_ROOTS_FILE", os.path.join(self.tmp, "none.json")):
            self.assertEqual([], self.names("cd web/src/deep && npm install"))

    def test_flag_values_and_workspaces(self):
        self.assertEqual(["package.json", "package-lock.json"], self.names("npm --loglevel warn install"))
        self.assertEqual([os.path.join("web", "package.json"), "package-lock.json"],
                         self.names("npm i -D -w web left-pad"))
        self.assertEqual([os.path.join("web", "package.json"), "package-lock.json"],
                         self.names("npm install --workspace=web x"))

    def test_manifest_commands_do_not_switch_on_speculation(self):
        self.assertEqual(["go.mod", "go.sum"], self.names("go mod tidy && echo package.json"))


class NodeWriteTest(unittest.TestCase):
    """A JavaScript write call fed to node/tsx/deno/bun counts like python's
    open(…,'w'); its path-shaped literals are then harvested."""

    def test_eval_and_heredoc_forms(self):
        cases = [
            "node -e \"require('fs').writeFileSync('out/data.json', s)\"",
            "node --eval \"fs.appendFileSync('log.txt', s)\"",
            "node - <<'EOF'\nconst fs = require('fs');\nfs.writeFileSync('gen/a.json', s);\nEOF",
            "tsx - <<'EOF'\nawait fs.promises.writeFile('gen/a.json', s)\nEOF",
            "bun -e \"await Bun.write('gen/a.json', s)\"",
            "deno eval \"Deno.writeTextFileSync('gen/a.json', s)\"",
            "cat <<'EOF' | node\nfs.createWriteStream('gen/a.json')\nEOF",
        ]
        for cmd in cases:
            with self.subTest(cmd=cmd.splitlines()[0]):
                got = paths(cmd)
                self.assertTrue(got, cmd)
                self.assertTrue(all(p.endswith((".json", ".txt")) for p in got), got)

    def test_without_a_js_runtime_it_is_not_a_write(self):
        for cmd in ["grep -rn 'writeFileSync(' src/", "rg \"writeFile\\(\" lib/a.ts"]:
            with self.subTest(cmd=cmd):
                self.assertFalse(hook.command_may_write(cmd))
        # Written as file content, not run: still data.
        self.assertEqual(["a.ts"], paths(
            "cat > a.ts <<'EOF'\nfs.writeFileSync('x.json', s)\nEOF\ngit add a.ts"))

    def test_only_the_script_node_runs_counts(self):
        self.assertFalse(hook.command_may_write("node scripts/build.js && grep -n \"writeFile(\" src/app.ts"))
        self.assertEqual([], paths("node -e \"console.log('writeFile(')\" src/app.ts"))
        self.assertEqual(["o.json"], paths("node -e \"writeFileSync('o.json', x)\""))

    def test_reading_is_not_writing(self):
        self.assertEqual([], paths("node -e \"console.log(fs.readFileSync('a.json'))\""))


class ShellCaptureEndToEndTest(unittest.TestCase):
    """A real `Bash` payload on stdin, isolated HOME, registered workspace."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.cg = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.cg, "sessions"))
        self.root = os.path.join(self.home, "project")
        os.makedirs(os.path.join(self.root, "manager", "biz"))
        with open(os.path.join(self.cg, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)
        self.session_file = session_file_for(self.cg, self.root)
        self.logfile = os.path.join(self.cg, "hook.log")
        with open(os.path.join(self.cg, "hooklog.enabled"), "w"):
            pass

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def log(self):
        """hook.log contents. Read via a context manager so the suite stays
        ResourceWarning-clean."""
        with open(self.logfile, encoding="utf-8") as f:
            return f.read()

    def run_bash(self, command):
        payload = json.dumps({
            "tool_name": "Bash",
            "cwd": self.root,
            "session_id": "s1",
            "tool_input": {"command": command},
        })
        subprocess.run([sys.executable, HOOK], input=payload, text=True,
                       env=dict(os.environ, HOME=self.home), check=True)

    def session(self):
        with open(self.session_file) as f:
            return json.load(f)

    def seed(self, rel, content):
        p = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(content)
        return p

    def test_python_heredoc_captures_baseline(self):
        target = self.seed("manager/biz/monitor_filter.go", "package biz\n")
        self.run_bash(PY_HEREDOC)
        files = self.session()["files"]
        self.assertIn(target, files)
        self.assertEqual("package biz\n", files[target]["originalContent"])
        self.assertEqual("pending", files[target]["reviewStatus"])
        self.assertEqual("s1", files[target]["sessionId"])
        self.assertIn("captured", self.log())

    def test_sed_in_place_captures_baseline(self):
        target = self.seed("app.go", "old\n")
        self.run_bash("sed -i 's/old/new/' app.go")
        files = self.session()["files"]
        self.assertIn(target, files)
        self.assertEqual("old\n", files[target]["originalContent"])

    def test_cat_heredoc_captures_new_file(self):
        self.run_bash("cat > generated.txt <<EOF\nhello\nEOF")
        target = os.path.join(self.root, "generated.txt")
        files = self.session()["files"]
        self.assertIn(target, files)
        self.assertIsNone(files[target]["originalContent"], "new file baseline is null")
        self.assertTrue(files[target]["newFile"])

    def test_multiple_targets_in_one_command(self):
        a = self.seed("a.go", "A")
        b = self.seed("b.go", "B")
        self.run_bash("cp a.go b.go")
        files = self.session()["files"]
        self.assertIn(a, files)
        self.assertIn(b, files)
        self.assertEqual("A", files[a]["originalContent"])
        self.assertEqual("B", files[b]["originalContent"])

    def test_non_write_command_captures_nothing_and_logs_nothing(self):
        self.seed("main.go", "package main\n")
        self.run_bash("go build ./...")
        self.assertFalse(os.path.exists(self.session_file), "no session created")
        self.assertFalse(os.path.exists(self.logfile), "no log spam")

    def test_paths_outside_workspace_are_skipped(self):
        outside = os.path.join(self.home, "elsewhere")
        os.makedirs(outside)
        with open(os.path.join(outside, "x.txt"), "w") as f:
            f.write("v")
        self.run_bash(f"sed -i 's/a/b/' {os.path.join(outside, 'x.txt')}")
        self.assertFalse(os.path.exists(self.session_file))
        self.assertIn("skip-no-root", self.log())

    def test_binary_target_is_not_captured(self):
        p = os.path.join(self.root, "img.bin")
        with open(p, "wb") as f:
            f.write(bytes([0x89, 0xFF, 0xFE, 0x00]))
        self.run_bash("cp img.bin copy.bin")
        self.assertIn("skip-binary", self.log())
        files = self.session()["files"] if os.path.exists(self.session_file) else {}
        self.assertNotIn(p, files)

    def test_existing_pending_entry_keeps_its_baseline(self):
        target = self.seed("app.go", "v0")
        self.run_bash("sed -i 's/v0/v1/' app.go")
        with open(target, "w") as f:
            f.write("v1")
        self.run_bash("sed -i 's/v1/v2/' app.go")
        self.assertEqual("v0", self.session()["files"][target]["originalContent"])
        self.assertIn("skip-already-pending", self.log())

    def test_edit_payload_still_captures_unchanged(self):
        """Control: the file_path leg is untouched by the Bash dispatch."""
        target = self.seed("app.go", "v0")
        payload = json.dumps({
            "tool_name": "Edit", "cwd": self.root, "session_id": "s1",
            "tool_input": {"file_path": "app.go"},
        })
        subprocess.run([sys.executable, HOOK], input=payload, text=True,
                       env=dict(os.environ, HOME=self.home), check=True)
        self.assertEqual("v0", self.session()["files"][target]["originalContent"])


    def test_cd_into_subdirectory_captures_the_real_file(self):
        # The reported failure, end to end: without cd tracking this captured
        # <root>/manager/biz/rule.go, which does not exist, and the real file
        # under sub/ was never baselined.
        target = self.seed("sub/manager/biz/rule.go", "package biz\n")
        self.run_bash(
            "cd %s && python3 - <<'PY'\n"
            "import pathlib\n"
            "p = pathlib.Path('manager/biz/rule.go')\n"
            "p.write_text(p.read_text().replace('30', '90'))\n"
            "PY" % os.path.join(self.root, "sub")
        )
        files = self.session()["files"]
        self.assertIn(target, files)
        self.assertEqual("package biz\n", files[target]["originalContent"])
        self.assertNotIn(os.path.join(self.root, "manager/biz/rule.go"), files)

    def test_unknowable_cd_captures_nothing_rather_than_a_phantom(self):
        self.run_bash('cd "$REPO" && sed -i \'s/a/b/\' app.go')
        self.assertFalse(os.path.exists(self.session_file))
        self.assertIn("skip-unknown-cwd", self.log())

    def test_unknown_variable_target_is_logged_once_and_not_captured(self):
        self.run_bash("cat > $T/x <<'EOF'\nhello $T/x\nEOF\necho y > $T/x")
        lines = [l for l in self.log().splitlines() if "skip-unknown-var" in l]
        self.assertEqual(1, len(lines), lines)
        self.assertTrue(lines[0].endswith("skip-unknown-var $T/x"), lines[0])
        self.assertNotIn("captured", self.log())

    def test_unknown_variable_log_line_is_bounded_and_one_line(self):
        self.run_bash('echo x > "$D/a\nb' + "c" * 5000 + '"')
        lines = [l for l in self.log().splitlines() if "skip-unknown-var" in l]
        self.assertEqual(1, len(lines), lines)
        self.assertIn("$D/a\\nb", lines[0])
        self.assertLess(len(lines[0]), 600)

    def test_rm_captures_the_file_before_it_goes(self):
        target = self.seed("old.go", "package old\n")
        self.run_bash("rm old.go")
        entry = self.session()["files"][target]
        self.assertEqual("package old\n", entry["originalContent"])
        self.assertFalse(entry["newFile"])

    def test_recursive_rm_captures_each_file_and_honours_excludes(self):
        a = self.seed("gen/a.go", "a\n")
        b = self.seed("gen/sub/b.go", "b\n")
        with open(os.path.join(self.cg, "excludes.json"), "w") as f:
            json.dump({self.root: ["gen/sub"]}, f)
        self.run_bash("rm -rf gen")
        files = self.session()["files"]
        self.assertIn(a, files)
        self.assertNotIn(b, files)

    def test_recursive_rm_past_the_cap_captures_nothing(self):
        for i in range(hook.RM_WALK_CAP + 1):
            self.seed("many/f%d.txt" % i, "x")
        self.run_bash("rm -rf many")
        self.assertIn("skip-too-many %s >%d" % (os.path.join(self.root, "many"), hook.RM_WALK_CAP),
                      self.log())
        self.assertFalse(os.path.exists(self.session_file))

    def test_recursive_rm_of_several_dirs_is_one_batch(self):
        for d in range(3):
            for i in range(3):
                self.seed("d%d/f%d.go" % (d, i), "x\n")
        before = os.path.exists(self.session_file)
        self.run_bash("rm -rf d0 d1 d2")
        self.assertFalse(before)
        self.assertEqual(9, len(self.session()["files"]))
        self.assertEqual(9, self.log().count(" captured "))

    def test_total_files_per_command_is_capped(self):
        for d in range(2):
            for i in range(30):
                self.seed("t%d/f%d.go" % (d, i), "x\n")
        self.run_bash("rm -rf t0 t1")
        # t0 fits (30), t1 does not (30 > 50 - 30): nothing from it.
        files = self.session()["files"]
        self.assertEqual(30, len(files))
        self.assertTrue(all("/t0/" in f for f in files))
        self.assertEqual(1, self.log().count("skip-too-many"))

    def test_several_overflowing_dirs_are_one_line(self):
        for d in range(3):
            for i in range(hook.RM_WALK_CAP + 1):
                self.seed("o%d/f%d.txt" % (d, i), "x")
        self.run_bash("rm -rf o0 o1 o2")
        lines = [l for l in self.log().splitlines() if "skip-too-many" in l]
        self.assertEqual(1, len(lines), lines)
        self.assertTrue(lines[0].endswith("%s..%s (3 dirs)" % (os.path.join(self.root, "o0"),
                                                              os.path.join(self.root, "o2"))), lines[0])

    def test_walk_outside_every_root_or_excluded_is_skipped(self):
        outside = os.path.join(self.home, "outside")
        os.makedirs(outside)
        open(os.path.join(outside, "a.go"), "w").close()
        self.seed("gen/a.go", "x\n")
        with open(os.path.join(self.cg, "excludes.json"), "w") as f:
            json.dump({self.root: ["gen"]}, f)
        self.run_bash("rm -rf %s gen" % outside)
        self.assertIn("skip-no-root %s" % outside, self.log())
        self.assertIn("skip-excluded %s" % os.path.join(self.root, "gen"), self.log())
        self.assertFalse(os.path.exists(self.session_file))

    def test_large_file_is_not_captured(self):
        big = self.seed("dump.sql", "x" * (hook.MAX_CAPTURE_BYTES + 1))
        self.run_bash("rm -f dump.sql")
        self.assertIn("skip-too-large %s %d" % (big, hook.MAX_CAPTURE_BYTES + 1), self.log())
        self.assertFalse(os.path.exists(self.session_file))

    def test_large_file_edit_is_not_captured(self):
        big = self.seed("big.json", "x" * (hook.MAX_CAPTURE_BYTES + 1))
        payload = json.dumps({"tool_name": "Edit", "cwd": self.root, "session_id": "s1",
                              "tool_input": {"file_path": big}})
        subprocess.run([sys.executable, HOOK], input=payload, text=True,
                       env=dict(os.environ, HOME=self.home), check=True)
        self.assertIn("skip-too-large", self.log())
        self.assertFalse(os.path.exists(self.session_file))

    def test_never_capture_command_logs_skip_implicit_once(self):
        self.seed("f.go", "x\n")
        self.run_bash("git pull && git merge origin/main")
        lines = [l for l in self.log().splitlines() if "skip-implicit" in l]
        self.assertEqual(1, len(lines), lines)
        self.assertTrue(lines[0].endswith("skip-implicit git pull"), lines[0])
        self.assertNotIn("captured", self.log())

    def test_empty_bash_payload_fails_open(self):
        payload = json.dumps({
            "tool_name": "Bash", "cwd": self.root, "tool_input": {},
        })
        subprocess.run([sys.executable, HOOK], input=payload, text=True,
                       env=dict(os.environ, HOME=self.home), check=True)
        self.assertFalse(os.path.exists(self.session_file))


if __name__ == "__main__":
    unittest.main()
