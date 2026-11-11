"""claudegate.exclude is honoured by the hook: an excluded file is skipped
before it is read, so it never enters the session. The matcher is a port of
src/excludeMatcher.ts; exclude_cases.json is shared with the TS test so the two
cannot drift apart."""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
HOOK = os.path.join(HERE, "..", "hook.py")

_spec = importlib.util.spec_from_file_location("claudegate_hook", HOOK)
hook = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hook)


def session_file_for(claudegate_dir, root):
    normalized = os.path.normcase(os.path.abspath(root))
    h = hashlib.md5(normalized.encode()).hexdigest()
    return os.path.join(claudegate_dir, "sessions", f"{h}.json")


class ExcludeParityTest(unittest.TestCase):
    def test_shared_cases(self):
        with open(os.path.join(HERE, "exclude_cases.json"), encoding="utf-8") as f:
            data = json.load(f)
        for case in data["cases"]:
            with self.subTest(globs=case["globs"], path=case["path"]):
                self.assertEqual(
                    hook.is_excluded(case["path"], data["root"], case["globs"]),
                    case["excluded"],
                )

    def test_invalid_glob_is_ignored(self):
        # An unbalanced bracket is escaped, so it compiles and matches literally;
        # a non-string entry is skipped. Neither may raise.
        self.assertFalse(hook.is_excluded("/r/a.txt", "/r", [123, "[x"]))


class HookSkipsExcludedTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.claudegate = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.claudegate, "sessions"))
        self.root = os.path.join(self.home, "project")
        os.makedirs(os.path.join(self.root, ".superpowers", "sdd", "feat"))
        with open(os.path.join(self.claudegate, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)
        open(os.path.join(self.claudegate, "hooklog.enabled"), "w").close()
        self.session_file = session_file_for(self.claudegate, self.root)

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def write_excludes(self, mapping):
        with open(os.path.join(self.claudegate, "excludes.json"), "w") as f:
            json.dump(mapping, f)

    def run_hook(self, tool_input, tool_name="Write"):
        payload = json.dumps({"tool_name": tool_name, "cwd": self.root, "tool_input": tool_input})
        subprocess.run([sys.executable, HOOK], input=payload, text=True,
                       env=dict(os.environ, HOME=self.home), check=True)

    def pending(self):
        if not os.path.exists(self.session_file):
            return {}
        with open(self.session_file) as f:
            return json.load(f)["files"]

    def log(self):
        with open(os.path.join(self.claudegate, "hook.log")) as f:
            return f.read()

    def test_excluded_write_is_not_captured(self):
        self.write_excludes({self.root: ["**/.superpowers/sdd"]})
        target = os.path.join(self.root, ".superpowers", "sdd", "feat", "task-1-report.md")
        self.run_hook({"file_path": target})
        self.assertNotIn(target, self.pending())
        self.assertIn("skip-excluded " + target, self.log())

    def test_excluded_bash_target_is_skipped_but_others_captured(self):
        self.write_excludes({self.root: [".superpowers/sdd"]})
        self.run_hook({"command": "echo x > .superpowers/sdd/feat/r.md && echo y > notes.md"}, "Bash")
        files = self.pending()
        self.assertIn(os.path.join(self.root, "notes.md"), files)
        self.assertNotIn(os.path.join(self.root, ".superpowers", "sdd", "feat", "r.md"), files)

    def test_non_excluded_file_still_captured(self):
        self.write_excludes({self.root: ["**/go.sum"]})
        target = os.path.join(self.root, "main.go")
        self.run_hook({"file_path": target})
        self.assertIn(target, self.pending())

    def test_other_roots_globs_do_not_apply(self):
        # excludes.json is shared by every window; only this root's globs count.
        self.write_excludes({os.path.join(self.home, "other"): ["**/*.md"]})
        target = os.path.join(self.root, "README.md")
        self.run_hook({"file_path": target})
        self.assertIn(target, self.pending())

    def test_missing_or_malformed_file_fails_open(self):
        target = os.path.join(self.root, "a.md")
        self.run_hook({"file_path": target})  # no excludes.json at all
        self.assertIn(target, self.pending())
        with open(os.path.join(self.claudegate, "excludes.json"), "w") as f:
            f.write("{not json")
        target2 = os.path.join(self.root, "b.md")
        self.run_hook({"file_path": target2})
        self.assertIn(target2, self.pending())


if __name__ == "__main__":
    unittest.main()
