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
        "git stash pop",
        "git reset --hard",
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
        ("make build &> build.log", ["build.log"]),
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
                got = hook.paths_from_command(cmd)
                for want in expected:
                    self.assertIn(want, got, f"{want!r} missing from {got!r}")

    def test_negative_controls_extract_nothing(self):
        for cmd in self.NEGATIVE:
            with self.subTest(cmd=cmd):
                self.assertEqual([], hook.paths_from_command(cmd))

    def test_devices_and_fd_dups_never_extracted(self):
        for cmd in ["echo x > /dev/null",
                    "echo x > /dev/stderr",
                    "echo x > /dev/tty",
                    "sed -i s/a/b/ f.go 2>&1",
                    "sed -i s/a/b/ f.go >&2"]:
            with self.subTest(cmd=cmd):
                for p in hook.paths_from_command(cmd):
                    self.assertFalse(p.startswith("/dev/"), p)
                    self.assertNotIn("&", p)

    def test_directories_and_wildcards_dropped(self):
        for cmd in ["prettier --write src/", "gofmt -w ./...", "cp -r a/ b/"]:
            with self.subTest(cmd=cmd):
                for p in hook.paths_from_command(cmd):
                    self.assertFalse(p.endswith("/"), p)
                    self.assertNotIn("...", p)

    def test_sed_expression_is_not_a_path(self):
        got = hook.paths_from_command("sed -i 's/old/new/g' src/app.go")
        self.assertEqual(["src/app.go"], got)

    def test_deduplicated_and_ordered(self):
        got = hook.paths_from_command("cp a/x.go a/x.go && touch a/x.go")
        self.assertEqual(["a/x.go"], got)
        got = hook.paths_from_command("cat > first.txt <<EOF\nEOF\ntouch second.txt")
        self.assertEqual(["first.txt", "second.txt"], got)

    def test_candidates_are_bounded(self):
        cmd = "touch " + " ".join(f"f{i}.txt" for i in range(200))
        self.assertLessEqual(len(hook.paths_from_command(cmd)), hook.MAX_CANDIDATES)

    def test_pathological_input_is_bounded_and_safe(self):
        cmd = "cat > out.txt <<EOF\n" + ("x/y.go " * 200000) + "\nEOF"
        got = hook.paths_from_command(cmd)  # must simply return
        self.assertLessEqual(len(got), hook.MAX_CANDIDATES)
        self.assertIn("out.txt", got)

    def test_non_string_and_empty_input(self):
        self.assertEqual([], hook.paths_from_command(""))
        self.assertEqual([], hook.paths_from_command(None))
        self.assertFalse(hook.command_may_write(""))


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

    def test_empty_bash_payload_fails_open(self):
        payload = json.dumps({
            "tool_name": "Bash", "cwd": self.root, "tool_input": {},
        })
        subprocess.run([sys.executable, HOOK], input=payload, text=True,
                       env=dict(os.environ, HOME=self.home), check=True)
        self.assertFalse(os.path.exists(self.session_file))


if __name__ == "__main__":
    unittest.main()
