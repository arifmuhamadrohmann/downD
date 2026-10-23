import os
import tempfile
import unittest
from unittest import mock

import drive


class FakeService:
    """Answers files().list() from a {folder_id: [items]} dict."""

    def __init__(self, tree):
        self.tree = tree

    def files(self):
        return self

    def list(self, q, **_):
        key = q.split("'")[1] if "'" in q else "sharedWithMe"
        return Result({"files": self.tree.get(key, [])})


class Result:
    def __init__(self, value):
        self.value = value

    def execute(self, num_retries=0):
        return self.value


def item(id, name, mime="application/pdf", created="2024-01-01T00:00:00Z"):
    return {"id": id, "name": name, "mimeType": mime, "createdTime": created,
            "modifiedTime": "2024-05-06T07:08:09.000Z", "size": "10"}


class SafeNameTest(unittest.TestCase):
    def test_windows_rules(self):
        self.assertEqual(drive.safe_name('a/b:c*?"<>|.txt'), "a_b_c______.txt")
        self.assertEqual(drive.safe_name("notes. "), "notes")
        self.assertEqual(drive.safe_name("..."), "_")
        self.assertEqual(drive.safe_name("con.txt"), "_con.txt")
        self.assertEqual(len(drive.safe_name("x" * 400)), 240)


class WalkTest(unittest.TestCase):
    def test_paths_duplicates_and_exports(self):
        service = FakeService({
            "root": [
                item("f1", "Work", drive.FOLDER),
                item("d1", "Report", "application/vnd.google-apps.document"),
                item("d2", "Old.docx", "application/vnd.google-apps.document"),
                item("p2", "photo.JPG", created="2024-02-01T00:00:00Z"),
                item("p1", "photo.jpg", created="2024-01-01T00:00:00Z"),
            ],
            "f1": [item("s1", "Budget", "application/vnd.google-apps.spreadsheet")],
        })
        paths = {i["id"]: p for i, p in drive.walk(service)}
        self.assertEqual(paths["f1"], "Work")
        self.assertEqual(paths["s1"], os.path.join("Work", "Budget.xlsx"))
        self.assertEqual(paths["d1"], "Report.docx")
        self.assertEqual(paths["d2"], "Old.docx")
        # Case-insensitive clash: the older file keeps the plain name.
        self.assertEqual(paths["p1"], "photo.jpg")
        self.assertEqual(paths["p2"], "photo (2).JPG")


    def test_shortcuts_skipped_and_shared_names_reserved(self):
        service = FakeService({
            "root": [
                item("sc", "Link to team folder", drive.SHORTCUT),
                item("f1", "Shared with me", drive.FOLDER),
            ],
        })
        paths = {i["id"]: p for i, p in drive.walk(service)}
        self.assertNotIn("sc", paths)
        self.assertEqual(paths["f1"], "Shared with me (2)")

    def test_shared_items_go_under_their_own_folder(self):
        service = FakeService({
            "sharedWithMe": [item("t", "Team", drive.FOLDER), item("n", "Notes", "application/vnd.google-apps.document")],
            "t": [item("p", "plan.pdf")],
        })
        items = drive.shared_with_me(service)
        paths = {i["id"]: p for i, p in drive.walk_items(service, items, drive.SHARED_WITH_ME)}
        self.assertEqual(paths["n"], os.path.join("Shared with me", "Notes.docx"))
        self.assertEqual(paths["p"], os.path.join("Shared with me", "Team", "plan.pdf"))


class DownloadTest(unittest.TestCase):
    def test_folder_unsupported_and_up_to_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(drive.download(None, item("f", "F", drive.FOLDER), os.path.join(tmp, "F")), "folder")
            self.assertTrue(os.path.isdir(os.path.join(tmp, "F")))

            f = item("a", "a.pdf")
            path = os.path.join(tmp, "a.pdf")
            open(path, "wb").close()
            mtime = 1714979289  # 2024-05-06T07:08:09Z
            os.utime(path, (mtime, mtime))
            self.assertEqual(drive.download(None, f, path), "skipped")

    def test_empty_file_needs_no_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = dict(item("e", "empty.txt"), size="0")
            path = os.path.join(tmp, "sub", "empty.txt")
            self.assertEqual(drive.download(None, f, path), "downloaded")
            self.assertEqual(os.path.getsize(path), 0)
            self.assertFalse(os.path.exists(path + ".part"))


DOC = "application/vnd.google-apps.document"


class LinkTest(unittest.TestCase):
    """Google files that cannot be exported are saved as .url shortcuts instead of failing."""

    def test_form_is_saved_as_link_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            form = item("x", "Survey", "application/vnd.google-apps.form")
            dest = os.path.join(tmp, "Survey")
            self.assertEqual(drive.download(None, form, dest), "linked")
            with open(dest + ".url", encoding="utf-8") as f:
                self.assertIn("URL=https://drive.google.com/open?id=x", f.read())
            # Unchanged since: no network call is made (service is None) and it stays a link.
            self.assertEqual(drive.download(None, form, dest), "linked")

    def test_too_large_export_uses_export_link(self):
        def too_large(*_):
            raise drive.CannotExport

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(drive, "_fetch", too_large), \
                mock.patch.object(drive, "_fetch_export_link", lambda s, i, f, p: f.write(b"docx")):
            dest = os.path.join(tmp, "Big.docx")
            self.assertEqual(drive.download(None, item("b", "Big", DOC), dest), "downloaded")
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), b"docx")

    def test_owner_blocked_errors_are_recognised(self):
        def http_error(reason):
            resp = mock.Mock(status=403, reason="Forbidden")
            return drive.HttpError(resp, b'{"error": {"errors": [{"reason": "%s"}]}}' % reason)

        self.assertTrue(drive._no_file(http_error(b"cannotExportFile")))
        self.assertTrue(drive._no_file(http_error(b"cannotDownloadFile")))
        self.assertTrue(drive._no_file(http_error(b"exportSizeLimitExceeded")))
        self.assertFalse(drive._no_file(http_error(b"rateLimitExceeded")))
        self.assertFalse(drive._no_file(ValueError("x")))

    def test_blocked_uploaded_file_is_saved_as_link(self):
        def blocked(*_):
            raise drive.CannotExport

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(drive, "_fetch", blocked):
            dest = os.path.join(tmp, "slides.pdf")
            self.assertEqual(drive.download(None, item("p", "slides.pdf"), dest), "linked")
            self.assertTrue(os.path.exists(os.path.join(tmp, "slides.url")))

    def test_link_when_both_exports_refuse(self):
        def too_large(*_):
            raise drive.CannotExport

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(drive, "_fetch", too_large), \
                mock.patch.object(drive, "_fetch_export_link", too_large):
            dest = os.path.join(tmp, "Huge.docx")
            self.assertEqual(drive.download(None, item("h", "Huge", DOC), dest), "linked")
            self.assertTrue(os.path.exists(os.path.join(tmp, "Huge.url")))
            self.assertFalse(os.path.exists(dest))
            self.assertFalse(os.path.exists(dest + ".part"))


if __name__ == "__main__":
    unittest.main()
