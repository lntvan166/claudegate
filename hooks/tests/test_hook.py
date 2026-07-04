import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "..", "hook.py")


def session_file_for(claudegate_dir, root):
    normalized = os.path.normcase(os.path.abspath(root))
    h = hashlib.md5(normalized.encode()).hexdigest()
    return os.path.join(claudegate_dir, "sessions", f"{h}.json")


class HookBaselineTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.claudegate = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.claudegate, "sessions"))
        # Workspace root = a project dir under the temp home.
        self.root = os.path.join(self.home, "project")
        os.makedirs(self.root)
        with open(os.path.join(self.claudegate, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)
        self.file = os.path.join(self.root, "a.txt")
        self.session_file = session_file_for(self.claudegate, self.root)

    def run_hook(self):
        payload = json.dumps({
            "tool_name": "Edit",
            "cwd": self.root,
            "tool_input": {"file_path": self.file},
        })
        env = dict(os.environ, HOME=self.home)
        subprocess.run(
            [sys.executable, HOOK],
            input=payload, text=True, env=env, check=True,
        )

    def write_session(self, entry):
        session = {"sessionId": "t", "status": "active", "files": {self.file: entry}}
        with open(self.session_file, "w") as f:
            json.dump(session, f)

    def read_entry(self):
        with open(self.session_file) as f:
            return json.load(f)["files"][self.file]

    def test_new_file_records_current_as_original(self):
        with open(self.file, "w") as f:
            f.write("v0")
        self.run_hook()
        entry = self.read_entry()
        self.assertEqual(entry["originalContent"], "v0")
        self.assertEqual(entry["reviewStatus"], "pending")

    def test_pending_nonnull_baseline_preserved(self):
        self.write_session({"originalContent": "v0", "reviewStatus": "pending"})
        with open(self.file, "w") as f:
            f.write("v1")
        self.run_hook()
        self.assertEqual(self.read_entry()["originalContent"], "v0")

    def test_pending_null_baseline_preserved(self):
        # Regression target: null-fill must NOT advance a pending baseline.
        self.write_session({"originalContent": None, "reviewStatus": "pending"})
        with open(self.file, "w") as f:
            f.write("v1")
        self.run_hook()
        self.assertIsNone(self.read_entry()["originalContent"])

    def test_accepted_entry_rebaselines_and_repends(self):
        self.write_session({"originalContent": "v0", "reviewStatus": "accepted"})
        with open(self.file, "w") as f:
            f.write("v1")  # the accepted content, present before Claude's next write
        self.run_hook()
        entry = self.read_entry()
        self.assertEqual(entry["originalContent"], "v1")
        self.assertEqual(entry["reviewStatus"], "pending")


if __name__ == "__main__":
    unittest.main()
