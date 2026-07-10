import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "..", "hook.py")


def session_file_for(claudegate_dir, root):
    normalized = os.path.normcase(os.path.abspath(root))
    h = hashlib.md5(normalized.encode()).hexdigest()
    return os.path.join(claudegate_dir, "sessions", f"{h}.json")


class WorktreeRoutingTest(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.claudegate = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.claudegate, "sessions"))
        # Main repo = registered root; nested worktree "ws" is NOT registered.
        self.root = os.path.join(self.home, "project")
        os.makedirs(os.path.join(self.root, ".git", "worktrees", "ws"))
        self.ws = os.path.join(self.root, "ws")
        os.makedirs(self.ws)
        self.sub = os.path.join(self.root, "sub")
        os.makedirs(self.sub)
        # worktree markers
        with open(os.path.join(self.root, ".git", "worktrees", "ws", "gitdir"), "w") as f:
            f.write(os.path.join(self.ws, ".git") + "\n")
        with open(os.path.join(self.ws, ".git"), "w") as f:
            f.write("gitdir: " + os.path.join(self.root, ".git", "worktrees", "ws") + "\n")
        # submodule marker (must NOT be treated as a worktree)
        with open(os.path.join(self.sub, ".git"), "w") as f:
            f.write("gitdir: " + os.path.join(self.root, ".git", "modules", "sub") + "\n")
        with open(os.path.join(self.claudegate, "workspace-roots.json"), "w") as f:
            json.dump([self.root], f)  # only the parent root is registered

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_hook(self, file_path):
        payload = json.dumps({
            "tool_name": "Edit",
            "cwd": self.root,
            "tool_input": {"file_path": file_path},
        })
        env = dict(os.environ, HOME=self.home)
        subprocess.run([sys.executable, HOOK], input=payload, text=True, env=env, check=True)

    def test_worktree_file_routes_to_worktree_session(self):
        fp = os.path.join(self.ws, "a.txt")
        with open(fp, "w") as f:
            f.write("hi")
        self.run_hook(fp)
        ws_session = session_file_for(self.claudegate, self.ws)
        root_session = session_file_for(self.claudegate, self.root)
        self.assertTrue(os.path.exists(ws_session), "captured into the worktree session")
        self.assertIn(fp, json.load(open(ws_session))["files"])
        self.assertFalse(os.path.exists(root_session), "not captured into the parent session")

    def test_submodule_file_routes_to_parent_session(self):
        fp = os.path.join(self.sub, "a.txt")
        with open(fp, "w") as f:
            f.write("hi")
        self.run_hook(fp)
        root_session = session_file_for(self.claudegate, self.root)
        self.assertTrue(os.path.exists(root_session), "submodule stays with the parent")
        self.assertIn(fp, json.load(open(root_session))["files"])

    def test_plain_nested_file_routes_to_parent_session(self):
        d = os.path.join(self.root, "src")
        os.makedirs(d)
        fp = os.path.join(d, "a.txt")
        with open(fp, "w") as f:
            f.write("hi")
        self.run_hook(fp)
        root_session = session_file_for(self.claudegate, self.root)
        self.assertIn(fp, json.load(open(root_session))["files"])


if __name__ == "__main__":
    unittest.main()
