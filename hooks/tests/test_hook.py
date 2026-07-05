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

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def run_hook(self, session_id=None):
        payload_obj = {
            "tool_name": "Edit",
            "cwd": self.root,
            "tool_input": {"file_path": self.file},
        }
        if session_id is not None:
            payload_obj["session_id"] = session_id
        payload = json.dumps(payload_obj)
        env = dict(os.environ, HOME=self.home)
        subprocess.run(
            [sys.executable, HOOK],
            input=payload, text=True, env=env, check=True,
        )

    def write_session(self, entry):
        session = {"sessionId": "t", "status": "active", "files": {self.file: entry}}
        with open(self.session_file, "w") as f:
            json.dump(session, f)

    def write_full_session(self, files=None, accepted=None, rejected=None):
        session = {
            "sessionId": "t", "status": "active",
            "files": files or {},
            "accepted": accepted or [],
            "rejected": rejected or {},
        }
        with open(self.session_file, "w") as f:
            json.dump(session, f)

    def read_session(self):
        with open(self.session_file) as f:
            return json.load(f)

    def read_entry(self):
        return self.read_session()["files"][self.file]

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

    def test_captures_session_id_and_timestamp(self):
        with open(self.file, "w") as f:
            f.write("v0")
        self.run_hook(session_id="s-123")
        entry = self.read_entry()
        self.assertEqual(entry["sessionId"], "s-123")
        self.assertTrue(entry.get("capturedAt"))

    # ── Review-log model: re-editing a decided file (the "soul" path) ──────────

    def test_reedit_after_accept_creates_pending_and_keeps_log(self):
        # New model: an accepted file is NOT in files{}; it lives in accepted[].
        # Claude editing it again must create a FRESH pending entry (baseline =
        # the accepted content now on disk) WITHOUT disturbing the accepted log.
        record = {"id": "t::a", "path": self.file, "before": "v0",
                  "after": "v1", "decidedAt": "t"}
        self.write_full_session(files={}, accepted=[record])
        with open(self.file, "w") as f:
            f.write("v1")  # the accepted content, present before Claude's next write
        self.run_hook()
        session = self.read_session()
        self.assertIn(self.file, session["files"], "re-edit must create a pending entry")
        self.assertEqual(session["files"][self.file]["originalContent"], "v1")
        self.assertEqual(session["files"][self.file]["reviewStatus"], "pending")
        self.assertEqual(session["accepted"], [record], "accepted log must be preserved")

    def test_reedit_after_reject_creates_pending_and_keeps_log(self):
        # A rejected file lives in rejected{} (restored on disk), not files{}.
        record = {"id": "t::r", "path": self.file, "before": "v0",
                  "after": "bad", "decidedAt": "t"}
        self.write_full_session(files={}, rejected={self.file: record})
        with open(self.file, "w") as f:
            f.write("v0")  # disk was restored to baseline at reject time
        self.run_hook()
        session = self.read_session()
        self.assertEqual(session["files"][self.file]["reviewStatus"], "pending")
        self.assertEqual(session["files"][self.file]["originalContent"], "v0")
        self.assertEqual(session["rejected"], {self.file: record},
                         "rejected store must be preserved")

    def test_hook_never_writes_decision_stores(self):
        # A brand-new capture must leave accepted[]/rejected{} exactly as found.
        acc = [{"id": "t::x", "path": "/other", "before": "a", "after": "b", "decidedAt": "t"}]
        self.write_full_session(files={}, accepted=acc, rejected={})
        with open(self.file, "w") as f:
            f.write("v0")
        self.run_hook()
        session = self.read_session()
        self.assertEqual(session["accepted"], acc)
        self.assertEqual(session["rejected"], {})

    def test_new_session_has_log_stores(self):
        # No session yet → the hook creates one already matching the schema.
        with open(self.file, "w") as f:
            f.write("v0")
        self.run_hook()
        session = self.read_session()
        self.assertEqual(session["accepted"], [])
        self.assertEqual(session["rejected"], {})

    def test_nonexistent_file_records_null(self):
        # Hook fires before Claude creates the file → it does not exist yet.
        self.assertFalse(os.path.exists(self.file))
        self.run_hook()
        self.assertIsNone(self.read_entry()["originalContent"])

    def test_nonexistent_file_marked_new(self):
        self.assertFalse(os.path.exists(self.file))
        self.run_hook()
        self.assertTrue(self.read_entry()["newFile"])

    def test_existing_file_not_marked_new(self):
        with open(self.file, "w") as f:
            f.write("v0")
        self.run_hook()
        self.assertFalse(self.read_entry().get("newFile", False))

    def test_existing_unreadable_file_is_skipped(self):
        # An existing file we cannot read must NOT be recorded as a null "new"
        # file (that would let a reject delete it). It is skipped entirely.
        with open(self.file, "w") as f:
            f.write("secret")
        os.chmod(self.file, 0)
        try:
            if os.access(self.file, os.R_OK):
                self.skipTest("cannot make file unreadable (running as root?)")
            self.run_hook()
            files = {}
            if os.path.exists(self.session_file):
                with open(self.session_file) as f:
                    files = json.load(f).get("files", {})
            self.assertNotIn(self.file, files)
        finally:
            os.chmod(self.file, 0o644)

    def test_existing_binary_file_is_skipped(self):
        # A readable but non-UTF-8 (binary) file must not crash the hook (a
        # non-zero PreToolUse exit could block Claude's edit) and must not be
        # recorded — we can't baseline/restore it as text.
        with open(self.file, "wb") as f:
            f.write(b"\xff\xfe\x00\x01binary\x80")
        self.run_hook()
        files = {}
        if os.path.exists(self.session_file):
            with open(self.session_file) as f:
                files = json.load(f).get("files", {})
        self.assertNotIn(self.file, files)


if __name__ == "__main__":
    unittest.main()
