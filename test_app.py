import os
import tempfile
import unittest
from unittest import mock

import app
import drive


class FakeWindow:
    def evaluate_js(self, script):
        pass


def failed_file(id, path):
    item = {"id": id, "name": os.path.basename(path), "mimeType": "application/pdf",
            "modifiedTime": "2024-05-06T07:08:09.000Z", "size": "10"}
    return {"name": item["name"], "path": path, "mimeType": item["mimeType"], "size": 10,
            "modifiedTime": item["modifiedTime"], "error": "Backend Error", "item": item}


class RetryTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dest = tmp.name
        patcher = mock.patch.object(app, "LAST_RUN", os.path.join(tmp.name, "last_run.json"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.api = app.Api()
        self.api._window = FakeWindow()
        self.api._state = {"dest": self.dest, "counts": {"downloaded": 5, "skipped": 1, "failed": 2},
                           "recent": [], "failedFiles": [failed_file("a", "a.pdf"), failed_file("b", "b.pdf")]}

    def test_retry_one_moves_it_from_failed_to_downloaded(self):
        with mock.patch.object(drive, "download", return_value="downloaded") as download:
            self.api._retry({"a"})
        download.assert_called_once()
        state = self.api._state
        self.assertEqual(state["counts"], {"downloaded": 6, "skipped": 1, "failed": 1})
        self.assertEqual([f["item"]["id"] for f in state["failedFiles"]], ["b"])
        self.assertEqual(state["phase"], "done")
        self.assertTrue(os.path.exists(os.path.join(self.dest, app.FAILED_REPORT)))

    def test_retry_all_that_fail_again_stay_listed(self):
        with mock.patch.object(drive, "download", side_effect=ValueError("still broken")):
            self.api._retry(None)
        state = self.api._state
        self.assertEqual(state["counts"]["failed"], 2)
        self.assertEqual([f["error"] for f in state["failedFiles"]], ["still broken", "still broken"])

    def test_report_removed_once_nothing_fails(self):
        open(os.path.join(self.dest, app.FAILED_REPORT), "w").close()
        with mock.patch.object(drive, "download", return_value="downloaded"):
            self.api._retry(None)
        self.assertEqual(self.api._state["failedFiles"], [])
        self.assertFalse(os.path.exists(os.path.join(self.dest, app.FAILED_REPORT)))


class CardKeyTest(unittest.TestCase):
    def test_keys(self):
        key = app.Api._card_key
        self.assertEqual(key(os.path.join("Work", "a.pdf")), "Work")
        self.assertIsNone(key("a.pdf"))
        self.assertEqual(key(os.path.join("Shared with me", "Team", "x", "a.pdf")), os.path.join("Shared with me", "Team"))
        self.assertIsNone(key(os.path.join("Shared with me", "a.pdf")))
        self.assertEqual(key(os.path.join("Shared drives", "Ops", "a.pdf")), os.path.join("Shared drives", "Ops"))


if __name__ == "__main__":
    unittest.main()
