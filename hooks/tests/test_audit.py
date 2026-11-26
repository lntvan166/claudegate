import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIT = os.path.join(HERE, "..", "audit.py")
sys.path.insert(0, os.path.dirname(AUDIT))
import audit  # noqa: E402


def md5(p):
    return hashlib.md5(os.path.normcase(os.path.abspath(p)).encode()).hexdigest()


class AuditTestBase(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self._old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        self.cg = os.path.join(self.home, ".claudegate")
        os.makedirs(os.path.join(self.cg, "sessions"))
        self.inflight = os.path.join(self.cg, "audit", "inflight")
        os.makedirs(self.inflight)
        self.root = os.path.join(self.home, "project")
        os.makedirs(self.root)
        self.roots = [self.root]
        self.write_roots()
        self.start = int(time.time() * 1000) - 2000
        # Everything pre-existing is old.
        self.old = (self.start - 60000) / 1000.0

    def tearDown(self):
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home
        shutil.rmtree(self.home, ignore_errors=True)

    def write_roots(self):
        with open(os.path.join(self.cg, "workspace-roots.json"), "w") as f:
            json.dump(self.roots, f)

    def put(self, rel, body="x\n", changed=False, root=None):
        p = os.path.join(root or self.root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w" if isinstance(body, str) else "wb") as f:
            f.write(body)
        t = (self.start + 100) / 1000.0 if changed else self.old
        os.utime(p, (t, t))
        return p

    def record(self, tid="t1", captured=(), implicit=False, background=False, started=None,
               already=(), cwd=None):
        rec = {"startedAt": self.start if started is None else started,
               "cwd": cwd or self.root, "sessionId": "s", "captured": list(captured),
               "alreadyPending": list(already), "implicit": implicit,
               "background": background}
        with open(os.path.join(self.inflight, tid + ".json"), "w") as f:
            json.dump(rec, f)

    def payload(self, tid="t1", event="PostToolUse", command="sed -i s/a/b/ a.go"):
        return {"tool_name": "Bash", "tool_use_id": tid, "hook_event_name": event,
                "session_id": "s", "cwd": self.root, "tool_input": {"command": command}}

    def lines(self, root=None):
        p = os.path.join(self.cg, "audit", md5(root or self.root) + ".jsonl")
        if not os.path.exists(p):
            return []
        with open(p) as f:
            return [json.loads(l) for l in f if l.strip()]

    def one(self, root=None):
        ls = self.lines(root)
        self.assertEqual(len(ls), 1, ls)
        return ls[0]

    def audit_files(self):
        top = os.path.join(self.cg, "audit")
        return sorted(n for n in os.listdir(top) if n.endswith(".jsonl") or ".jsonl." in n)


class AuditClassifyTest(AuditTestBase):
    def test_missed_file(self):
        a = self.put("a.go", changed=True)
        self.put("old.go")
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["missed"], [a])
        self.assertEqual(line["captured"], 0)
        self.assertEqual(line["root"], os.path.normcase(self.root))
        self.assertEqual(line["toolUseId"], "t1")
        self.assertEqual(line["sessionId"], "s")
        self.assertEqual(line["commandHead"], "sed -i s/a/b/ a.go")
        self.assertEqual(set(line), {"at", "sessionId", "toolUseId", "event", "durationMs", "cwd",
                                     "root", "commandHead", "background", "truncated", "missed",
                                     "uncertain", "phantom", "missedCount", "uncertainCount",
                                     "phantomCount", "covered", "implicit", "outOfScope",
                                     "tooLarge", "captured"})
        self.assertEqual(line["missedCount"], 1)
        self.assertFalse(os.path.exists(os.path.join(self.inflight, "t1.json")))

    def test_captured_not_missed(self):
        a = self.put("a.go", changed=True)
        self.record(captured=[a, a])
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["missed"], [])
        self.assertEqual(line["captured"], 1)

    def test_phantom(self):
        b = self.put("b.go")
        self.record(captured=[b])
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["phantom"], [b])
        self.assertEqual(line["captured"], 0)

    def test_phantom_never_created(self):
        ghost = os.path.join(self.root, "sub", "ghost.go")
        with open(os.path.join(self.cg, "sessions", md5(self.root) + ".json"), "w") as f:
            json.dump({"files": {ghost: {"originalContent": None, "reviewStatus": "pending",
                                         "capturedAt": "x"}}}, f)
        self.record(captured=[ghost])
        audit.run(self.payload())
        self.assertEqual(self.one()["phantom"], [ghost])

    def test_captured_deleted_is_a_change(self):
        gone = os.path.join(self.root, "gone.go")
        with open(os.path.join(self.cg, "sessions", md5(self.root) + ".json"), "w") as f:
            json.dump({"files": {gone: {"originalContent": "x", "reviewStatus": "pending",
                                        "capturedAt": "x"}}}, f)
        self.record(captured=[gone])
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["phantom"], line["captured"]), ([], 1))

    def test_implicit_never_missed(self):
        self.put("a.go", changed=True)
        self.record(implicit=True)
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["missed"], [])
        self.assertEqual(line["implicit"], 1)

    def test_gitignored_out_of_scope(self):
        subprocess.run(["git", "init", "-q", self.root], check=True)
        self.put(".gitignore", "bin/\n")
        self.put("bin/x", changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual(line["outOfScope"], 1)
        self.assertEqual(line["missed"], [])

    def test_gitignored_in_nested_repo(self):
        subprocess.run(["git", "init", "-q", self.root], check=True)
        inner = os.path.join(self.root, "inner")
        os.makedirs(inner)
        subprocess.run(["git", "init", "-q", inner], check=True)
        self.put("inner/.gitignore", "*.log\n")
        self.put("inner/app.log", changed=True)
        a = self.put("inner/a.go", changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["outOfScope"], line["missed"]), (1, [a]))

    def test_binary_out_of_scope(self):
        self.put("img.bin", b"\x89PNG\x00\x01\x02", changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["outOfScope"], line["missed"]), (1, []))

    def test_pending_elsewhere_is_covered(self):
        a = self.put("a.go", changed=True)
        with open(os.path.join(self.cg, "sessions", md5(self.root) + ".json"), "w") as f:
            json.dump({"files": {a: {"originalContent": "x", "reviewStatus": "pending",
                                     "sessionId": "other", "capturedAt": "2026-01-01T00:00:00+00:00"}}}, f)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["covered"], line["missed"]), (1, []))

    def test_pending_in_worktree_session_is_covered(self):
        wt = os.path.join(self.root, "wt")
        a = self.put("wt/a.go", changed=True)
        with open(os.path.join(self.cg, "sessions", md5(wt) + ".json"), "w") as f:
            json.dump({"files": {a: {"originalContent": "x", "reviewStatus": "pending",
                                     "capturedAt": "x"}}}, f)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.one()["covered"], 1)

    def _decided_session(self, a, decided_at, kind="rejected"):
        sess = {"files": {}, "accepted": [], "rejected": {}}
        rec = {"id": "x", "path": a, "before": "x", "after": "y", "decidedAt": decided_at,
               "sessionId": "s"}
        if kind == "rejected":
            sess["rejected"][a] = rec
        else:
            sess["accepted"].append(rec)
        with open(os.path.join(self.cg, "sessions", md5(self.root) + ".json"), "w") as f:
            json.dump(sess, f)

    @staticmethod
    def _iso(ms, z=True):
        from datetime import datetime, timezone
        dt = datetime.fromtimestamp(ms / 1000.0, timezone.utc)
        if z:   # the extension's toISOString()
            return dt.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (ms % 1000)
        return dt.isoformat()   # chrono-like, +00:00 and microseconds

    def test_reject_in_window_is_covered(self):
        # The user's own reject (or reapply) during the call writes the file
        # and removes it from `files`: never "Claude changed X, not captured".
        a = self.put("a.go", changed=True)
        self._decided_session(a, self._iso(self.start + 500))
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["covered"], line["missed"]), (1, []))

    def test_accept_in_window_is_covered(self):
        a = self.put("a.go", changed=True)
        self._decided_session(a, self._iso(self.start - 500, z=False), kind="accepted")
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["covered"], line["missed"]), (1, []))

    def test_decision_before_window_still_missed(self):
        a = self.put("a.go", changed=True)
        self._decided_session(a, self._iso(self.start - audit.WINDOW_SLACK_MS - 5000))
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.one()["missed"], [a])

    def test_iso_ms(self):
        self.assertEqual(audit._iso_ms("2026-11-13T10:00:00.123Z"), 1_794_564_000_123)
        self.assertEqual(audit._iso_ms("2026-11-13T10:00:00+00:00"), 1_794_564_000_000)
        self.assertEqual(audit._iso_ms("2026-11-13T17:00:00.123456+07:00"), 1_794_564_000_123)
        self.assertIsNone(audit._iso_ms("yesterday"))
        self.assertIsNone(audit._iso_ms(None))

    def test_long_call_uncertain(self):
        started = int(time.time() * 1000) - 11000
        self.start = started
        a = self.put("a.go", changed=True)
        self.record(started=started)
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["uncertain"], line["missed"]), ([a], []))
        self.assertGreaterEqual(line["durationMs"], 11000)

    def test_innermost_root_attribution(self):
        sub = os.path.join(self.root, "sub")
        self.roots.append(sub)
        self.write_roots()
        c = self.put("sub/c.go", changed=True)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.lines(self.root), [])
        self.assertEqual(self.one(sub)["missed"], [c])

    def test_unrelated_root_not_scanned(self):
        other = os.path.join(self.home, "other")
        self.roots.append(other)
        self.write_roots()
        self.put("z.go", changed=True, root=other)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.lines(other), [])

    def test_prune_and_symlink(self):
        self.put("node_modules/pkg/index.js", changed=True)
        self.put(".vscode-test/vscode/x.js", changed=True)
        self.put("web/.next/cache/y", changed=True)
        self.put(".git/index", changed=True)
        outside = os.path.join(self.home, "outside")
        os.makedirs(outside)
        self.put("o.go", changed=True, root=outside)
        os.symlink(outside, os.path.join(self.root, "link"))
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.lines(), [])

    def test_excluded_not_seen(self):
        with open(os.path.join(self.cg, "excludes.json"), "w") as f:
            json.dump({self.root: [".superpowers/sdd", "**/*.snap"]}, f)
        self.put(".superpowers/sdd/plan.md", changed=True)
        self.put("x/y.snap", changed=True)
        a = self.put("a.go", changed=True)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.one()["missed"], [a])

    def test_no_change_writes_nothing(self):
        self.put("a.go")
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.audit_files(), [])

    def test_background_flag_kept(self):
        self.put("a.go", changed=True)
        self.record(background=True)
        audit.run(self.payload())
        self.assertIs(self.one()["background"], True)

    def test_post_failure_event_also_audited(self):
        self.put("a.go", changed=True)
        self.record()
        audit.run(self.payload(event="PostToolUseFailure"))
        self.assertEqual(self.one()["event"], "PostToolUseFailure")

    def test_command_head_truncated(self):
        self.put("a.go", changed=True)
        self.record()
        audit.run(self.payload(command="x" * 500))
        self.assertEqual(len(self.one()["commandHead"]), 120)

    def test_already_pending_unchanged_is_nothing(self):
        b = self.put("b.go")
        self.record(already=[b])
        audit.run(self.payload())
        self.assertEqual(self.lines(), [])

    def test_already_pending_changed_is_captured(self):
        a = self.put("a.go", changed=True)
        self.record(already=[a])
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["captured"], line["missed"], line["phantom"]), (1, [], []))

    def test_already_pending_absent_before_is_nothing(self):
        # Deleted by an earlier call, named again: its directory is old.
        os.makedirs(os.path.join(self.root, "d"))
        os.utime(os.path.join(self.root, "d"), (self.old, self.old))
        gone = os.path.join(self.root, "d", "gone.go")
        self.record(already=[gone])
        audit.run(self.payload())
        self.assertEqual(self.lines(), [])

    def test_already_pending_deleted_now_is_captured(self):
        os.makedirs(os.path.join(self.root, "d"))
        gone = os.path.join(self.root, "d", "gone.go")   # dir mtime is now
        self.record(already=[gone])
        audit.run(self.payload())
        self.assertEqual(self.one()["captured"], 1)

    def test_latin1_text_out_of_scope(self):
        self.put("notes.txt", "caf\xe9 au lait\n".encode("latin-1"), changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["outOfScope"], line["missed"]), (1, []))

    def test_utf8_cut_at_sample_edge_is_text(self):
        body = ("a" * 8191 + "é" + "b" * 10).encode("utf-8")
        p = self.put("edge.txt", body, changed=True)
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.one()["missed"], [p])

    def test_too_large(self):
        self.put("big.sql", "x" * (2 * 1024 * 1024 + 1), changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((line["tooLarge"], line["missed"]), (1, []))

    def test_unparseable_session(self):
        a = self.put("a.go", changed=True)
        with open(os.path.join(self.cg, "sessions", md5(self.root) + ".json"), "w") as f:
            f.write('{"files": {%s: {"reviewStatus": "pend' % json.dumps(a))
        self.record()
        audit.run(self.payload())
        self.assertEqual(self.one()["missed"], [a])

    def test_lists_capped_with_counts(self):
        for i in range(205):
            self.put("m/f%03d.go" % i, changed=True)
        self.record()
        audit.run(self.payload())
        line = self.one()
        self.assertEqual((len(line["missed"]), line["missedCount"]), (200, 205))

    def test_own_files_never_audited(self):
        self.roots = [self.home]
        self.write_roots()
        self.put(".claudegate/hook.log", changed=True, root=self.home)
        self.record(cwd=self.home)
        audit.run(self.payload())
        self.assertEqual(self.audit_files(), [])

    def test_roots_inside_cwd_selected(self):
        a = self.put("a.go", changed=True)
        self.record(cwd=self.home)        # cwd is the parent of the root
        audit.run(self.payload())
        self.assertEqual(self.one()["missed"], [a])

    def test_audit_files_private(self):
        self.put("a.go", changed=True)
        self.record()
        audit.run(self.payload())
        d = os.path.join(self.cg, "audit")
        self.assertEqual(os.stat(d).st_mode & 0o777, 0o700)
        f = os.path.join(d, md5(self.root) + ".jsonl")
        self.assertEqual(os.stat(f).st_mode & 0o777, 0o600)

    def test_command_head_redacted(self):
        cases = [
            ("curl -H 'Authorization: Bearer abc.def' https://x", ["abc.def"]),
            ("curl -H 'Authorization: tok123' https://x", ["tok123"]),
            ("curl -H 'X: Basic dXNlcjpw' https://x", ["dXNlcjpw"]),
            ("git clone https://bob:hunter2@host/p", ["hunter2"]),
            ("curl -H 'Authorization: token ghp_X' https://api", ["ghp_X"]),
            ("curl -u admin:pw https://x", ["admin:pw"]),
            ("curl --user=admin:pw https://x", ["admin:pw"]),
            ('curl -H "X-Api-Key: S" https://x', ["S\""]),
            ("mysql -uroot -pS3cret db < dump.sql", ["S3cret"]),
            ("tool --password=pw1 --token=tk2 --api-key=ak3 --secret=sc4",
             ["pw1", "tk2", "ak3", "sc4"]),
            ("GITHUB_TOKEN=ghp_xyz API_KEY='k k' my_password=p9 AWS_ACCESS_KEY_ID=AK make",
             ["ghp_xyz", "k k", "p9", "=AK"]),
            ("tool --password pw1 --token  tk2 --api-key ak3 --secret 'sc 4'",
             ["pw1", "tk2", "ak3", "sc 4"]),
            ("cli --api_key AK9 --access-token AT9 --db-password=DP9", ["AK9", "AT9", "DP9"]),
        ]
        for cmd, secrets in cases:
            out = audit.redact(cmd)
            for secret in secrets:
                self.assertNotIn(secret, out, out)
            self.assertIn("***", out)
        self.assertEqual(audit.redact("sed -i s/a/b/ a.go && ls -p x"), "sed -i s/a/b/ a.go && ls -p x")
        self.assertEqual(audit.redact("tool --token-file t.txt --tokens 3"), "tool --token-file t.txt --tokens 3")
        self.put("a.go", changed=True)
        self.record()
        audit.run(self.payload(command="DB_PASSWORD=" + "z" * 200 + " ./migrate"))
        head = self.one()["commandHead"]
        self.assertTrue(head.startswith("DB_PASSWORD=***"), head)
        self.assertNotIn("z", head)


class AuditHashTest(unittest.TestCase):
    def test_audit_file_names_are_pinned(self):
        with open(os.path.join(HERE, "audit_hash_cases.json")) as f:
            cases = json.load(f)["cases"]
        self.assertTrue(cases)
        for c in cases:
            if os.name == "nt":
                continue   # POSIX roots
            self.assertEqual(audit._hash(c["root"]) + ".jsonl", c["file"])


class AuditScanTest(AuditTestBase):
    def test_claude_dir_is_skipped(self):
        # A workspace containing $HOME must not list Claude's own transcripts.
        self.roots = [self.home]
        self.write_roots()
        t = self.put("transcript.jsonl", changed=True, root=os.path.join(self.home, ".claude", "projects"))
        a = self.put("a.go", changed=True)
        changed, _ = audit.scan_changed([self.home], self.start - 1000)
        self.assertIn(a, changed)
        self.assertNotIn(t, changed)

    def test_claude_dir_symlink_target_is_skipped(self):
        real = os.path.join(self.root, "dotclaude")
        os.makedirs(real)
        os.symlink(real, os.path.join(self.home, ".claude"))
        t = self.put("dotclaude/todo.json", changed=True)
        changed, _ = audit.scan_changed([self.root], self.start - 1000)
        self.assertNotIn(t, changed)

    def test_git_timeout_capped_by_run_budget(self):
        # The run budget (300 ms) bounds walk + git; each check-ignore call
        # gets at most what is left of it.
        self.assertEqual(audit.RUN_BUDGET_MS, 300)
        self.assertLess(audit.SCAN_BUDGET_MS, audit.RUN_BUDGET_MS)
        import subprocess
        if subprocess.run(["git", "init", "-q", self.root], capture_output=True).returncode != 0:
            self.skipTest("git unavailable")
        a = self.put("a.go", changed=True)
        seen = []
        real = subprocess.run

        def spy(*args, **kw):
            seen.append(kw.get("timeout"))
            return real(*args, **kw)
        subprocess.run = spy
        try:
            audit.git_ignored([a], time.perf_counter() + 0.05)
            past = audit.git_ignored([a], time.perf_counter() - 1)
        finally:
            subprocess.run = real
        self.assertEqual(len(seen), 1, "an exhausted budget runs no git at all")
        self.assertLessEqual(seen[0], 0.05)
        self.assertEqual(past, (set(), {a}), "out of time: unchecked, so never a miss")


    def test_scan_stops_at_budget(self):
        for d in range(50):
            dd = os.path.join(self.root, "d%d" % d)
            os.makedirs(dd)
            for i in range(100):
                open(os.path.join(dd, "f%d.go" % i), "w").close()
        t0 = time.perf_counter()
        _, truncated = audit.scan_changed([self.root], 0, budget_ms=1)
        elapsed = (time.perf_counter() - t0) * 1000
        self.assertIs(truncated, True)
        self.assertLess(elapsed, 50)

    def test_truncated_flag_in_line(self):
        for d in range(20):
            dd = os.path.join(self.root, "d%d" % d)
            os.makedirs(dd)
            for i in range(100):
                open(os.path.join(dd, "f%d.go" % i), "w").close()
        a = self.put("a.go")
        self.record(captured=[a])
        audit.run(self.payload(), budget_ms=0)
        self.assertIs(self.one()["truncated"], True)

    def test_truncated_empty_still_writes(self):
        for d in range(20):
            for i in range(100):
                self.put("d%d/f%d.go" % (d, i))
        self.record()
        audit.run(self.payload(), budget_ms=0)
        line = self.one()
        self.assertIs(line["truncated"], True)
        self.assertEqual((line["missed"], line["captured"]), ([], 0))

    def test_no_git_uses_prune_list(self):
        subprocess.run(["git", "init", "-q", self.root], check=True)
        self.put(".gitignore", "bin/\n")
        b = self.put("bin/x", changed=True)
        self.record()
        saved = os.environ.get("PATH")
        os.environ["PATH"] = self.home   # no git here
        try:
            audit.run(self.payload())
        finally:
            os.environ["PATH"] = saved
        self.assertEqual(self.one()["missed"], [b])

    def test_rotate_at_5mb(self):
        p = os.path.join(self.cg, "audit", "r.jsonl")
        with open(p, "w") as f:
            f.write("x" * 5_000_000)
        audit.rotate(p)
        self.assertFalse(os.path.exists(p))
        self.assertEqual(os.path.getsize(p + ".1"), 5_000_000)
        with open(p, "w") as f:
            f.write("small")
        audit.rotate(p)
        self.assertTrue(os.path.exists(p))
        # A second rotation replaces the one old file.
        with open(p, "w") as f:
            f.write("y" * 5_000_001)
        audit.rotate(p)
        self.assertEqual(os.path.getsize(p + ".1"), 5_000_001)
        self.assertEqual(sorted(os.listdir(os.path.dirname(p))), ["inflight", "r.jsonl.1"])

    def test_append_rotates(self):
        self.put("a.go", changed=True)
        target = os.path.join(self.cg, "audit", md5(self.root) + ".jsonl")
        with open(target, "w") as f:
            f.write("x" * 5_000_000)
        self.record()
        audit.run(self.payload())
        self.assertTrue(os.path.exists(target + ".1"))
        self.assertEqual(len(self.lines()), 1)

    def test_exclude_cases_match_hook(self):
        with open(os.path.join(HERE, "exclude_cases.json")) as f:
            cases = json.load(f)
        for c in cases["cases"]:
            got = audit.is_excluded(c["path"], c.get("root", cases["root"]), c["globs"])
            self.assertEqual(got, c["excluded"], c)


class AuditProcessTest(AuditTestBase):
    def run_audit(self, stdin):
        return subprocess.run([sys.executable, AUDIT], input=stdin, text=True,
                              capture_output=True, env=dict(os.environ, HOME=self.home))

    def assert_silent(self, r):
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertEqual(self.audit_files(), [])

    def test_missing_inflight_is_silent(self):
        self.put("a.go", changed=True)
        self.assert_silent(self.run_audit(json.dumps(self.payload())))
        p = self.payload()
        del p["tool_use_id"]
        self.assert_silent(self.run_audit(json.dumps(p)))
        self.assert_silent(self.run_audit("not json {"))
        self.assert_silent(self.run_audit(""))
        self.assert_silent(self.run_audit("[1, 2]"))
        self.assert_silent(self.run_audit(json.dumps(self.payload(tid="../evil"))))

    def test_garbage_record_is_silent(self):
        self.put("a.go", changed=True)
        with open(os.path.join(self.inflight, "t1.json"), "w") as f:
            f.write("{garbage")
        self.assert_silent(self.run_audit(json.dumps(self.payload())))
        self.assertFalse(os.path.exists(os.path.join(self.inflight, "t1.json")))

    def test_process_writes_line(self):
        a = self.put("a.go", changed=True)
        self.record()
        r = self.run_audit(json.dumps(self.payload()))
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertEqual(self.one()["missed"], [a])

    def fake_git(self, body):
        bindir = os.path.join(self.home, "bin")
        os.makedirs(bindir, exist_ok=True)
        g = os.path.join(bindir, "git")
        with open(g, "w") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(g, 0o755)
        os.makedirs(os.path.join(self.root, ".git"), exist_ok=True)
        return dict(os.environ, HOME=self.home, PATH=bindir + os.pathsep + os.environ["PATH"])

    def test_slow_git_bounded_by_run_deadline(self):
        env = self.fake_git("exec sleep 2")
        a = self.put("a.go", changed=True)
        self.record()
        t0 = time.monotonic()
        r = subprocess.run([sys.executable, AUDIT], input=json.dumps(self.payload()),
                           text=True, capture_output=True, env=env)
        elapsed = time.monotonic() - t0
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertLess(elapsed, 1.0)          # git is capped at 300 ms
        line = self.one()
        self.assertEqual((line["uncertain"], line["missed"], line["truncated"]), ([a], [], True))

    def run_with(self, env):
        r = subprocess.run([sys.executable, AUDIT], input=json.dumps(self.payload()),
                           text=True, capture_output=True, env=env)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        return self.one()

    def test_implicit_with_hanging_git_never_uncertain(self):
        env = self.fake_git("exec sleep 2")
        self.put("a.go", changed=True)
        self.record(implicit=True)
        line = self.run_with(env)
        self.assertEqual((line["uncertain"], line["missed"], line["implicit"]), ([], [], 1))

    def test_binary_with_hanging_git_out_of_scope(self):
        env = self.fake_git("exec sleep 2")
        self.put("img.bin", b"\x00\x01\x02", changed=True)
        self.record()
        line = self.run_with(env)
        self.assertEqual((line["outOfScope"], line["uncertain"]), (1, []))

    def test_check_ignore_128_is_like_no_git(self):
        env = self.fake_git("exit 128")
        a = self.put("a.go", changed=True)
        self.record()
        line = self.run_with(env)
        self.assertEqual((line["missed"], line["uncertain"], line["truncated"]), ([a], [], False))


if __name__ == "__main__":
    unittest.main()
