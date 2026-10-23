"""downD: download everything in your Google Drive to your computer."""
import json
import os
import sys
import threading

import webview

import drive

BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
# Set DOWND_DEV_URL=http://localhost:5173 to work on the UI with Vite's hot reload.
UI = os.environ.get("DOWND_DEV_URL") or os.path.join(BASE, "ui", "dist", "index.html")
RECENT = 8  # files listed in the activity feed
# The last finished run and its folder, so the dashboard shows real numbers when the app reopens.
LAST_RUN = os.path.join(drive.APP_DIR, "last_run.json")
FAILED_REPORT = "downD-failed.txt"


def load_last_run():
    try:
        with open(LAST_RUN, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def long_path(folder):
    # The \\?\ prefix lifts Windows' 260-character path limit; deep Drive folders hit it.
    return "\\\\?\\" + os.path.abspath(folder)


class Api:
    """Methods here are callable from the page as window.pywebview.api.<name>().

    pywebview exposes every public attribute to JavaScript, so internal state is underscore-prefixed.
    """

    def __init__(self):
        self._window = None
        self._service = None
        self._stop = threading.Event()
        self._job = None
        self._dest = load_last_run().get("dest") or os.path.join(os.path.expanduser("~"), "Downloads", "Google Drive")
        self._state = {}

    # --- called from the page ------------------------------------------------
    # pywebview runs each call on its own thread, so calls other than the download job use drive.clone().

    def init(self):
        """Reconnect with the saved login, if any."""
        self._service = drive.login(interactive=False)
        return self._account()

    def login(self):
        self._service = drive.login(interactive=True)
        return self._account()

    def logout(self):
        self.stop()
        drive.logout()
        if os.path.exists(LAST_RUN):
            os.remove(LAST_RUN)  # those numbers belong to the account that just left
        self._service = None
        self._state = {}
        return self._account()

    def choose_folder(self):
        picked = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=self._dest)
        if picked:
            self._dest = os.path.normpath(picked[0])
        return self._dest

    def folders(self):
        """Top-level folders of My Drive, for the folder cards."""
        service = drive.clone(self._service)
        return [{"id": f["id"], "name": f["name"], "modifiedTime": f["modifiedTime"]}
                for f in drive.list_children(service, "root") if f["mimeType"] == drive.FOLDER]

    def shared(self):
        """Folders shared with this account and its shared drives, for their cards."""
        service = drive.clone(self._service)
        items = [f for f in drive.shared_with_me(service) if f["mimeType"] != drive.SHORTCUT]
        folders = [{"id": f["id"], "name": f["name"], "modifiedTime": f["modifiedTime"],
                    "sharedBy": (f.get("sharingUser") or {}).get("displayName")}
                   for f in items if f["mimeType"] == drive.FOLDER]
        return {"folders": folders, "files": len(items) - len(folders),
                "drives": [{"id": d["id"], "name": d["name"]} for d in drive.shared_drives(service)]}

    def open_folder(self, parts=None):
        """Open the download folder, or a folder inside it given as path parts, in Explorer."""
        path = os.path.join(self._dest, *[drive.safe_name(p) for p in parts or []])
        if os.path.isdir(path):  # only ever a folder: os.startfile would run a file
            os.startfile(path)
            return True
        return False

    def start(self, include_shared=False):
        self._launch(self._run, self._dest, bool(include_shared))

    def retry(self, ids=None):
        """Download failed files again: all of them, or only the given file ids."""
        self._launch(self._retry, set(ids) if ids else None)

    def stop(self):
        self._stop.set()

    def count(self, include_shared=False):
        """How many files a download would cover, for the My Drive tile."""
        if not self._service:
            return None
        files = set()
        for item, _ in self._sources(drive.clone(self._service), include_shared):
            if item["mimeType"] != drive.FOLDER:
                files.add(item["id"])
        return len(files)

    # --- internals ------------------------------------------------------------

    def _account(self):
        account = drive.profile(drive.clone(self._service)) if self._service else None
        last_job = load_last_run().get("job") if account else None
        return {"account": account, "dest": self._dest, "lastJob": last_job}

    def _launch(self, target, *args):
        """Run a download job on a background thread; one at a time."""
        if not self._service or (self._job and self._job.is_alive()):
            return
        self._stop.clear()

        def job():
            try:
                target(*args)
            except Exception as e:
                self._emit(phase="error", message=drive.reason(e), current=None)

        self._job = threading.Thread(target=job, daemon=True)
        self._job.start()

    def _emit(self, **changes):
        """Merge changes into the job state and push the whole snapshot to the page."""
        self._state.update(changes)
        if changes.get("phase") in ("done", "stopped", "error"):
            os.makedirs(drive.APP_DIR, exist_ok=True)
            with open(LAST_RUN, "w", encoding="utf-8") as f:
                json.dump({"dest": self._dest, "job": self._state}, f)
        self._window.evaluate_js(
            f"window.dispatchEvent(new CustomEvent('downd', {{detail: {json.dumps(self._state)}}}))")

    @staticmethod
    def _sources(service, include_shared):
        """Everything to download: My Drive, then optionally shared items and shared drives."""
        yield from drive.walk(service)
        if not include_shared:
            return
        yield from drive.walk_items(service, drive.shared_with_me(service), drive.SHARED_WITH_ME)
        used = set()
        for shared in drive.shared_drives(service):
            name = drive.unique(drive.safe_name(shared["name"]), used)
            yield from drive.walk(service, shared["id"], os.path.join(drive.SHARED_DRIVES, name))

    @staticmethod
    def _card_key(rel):
        """The folder card a file counts towards: its top folder, or the folder inside a shared section."""
        parts = rel.split(os.sep)
        depth = 2 if parts[0] in (drive.SHARED_WITH_ME, drive.SHARED_DRIVES) else 1
        return os.sep.join(parts[:depth]) if len(parts) > depth else None

    def _run(self, dest, include_shared):
        self._state = {}
        self._emit(phase="scanning", message="Scanning your Drive…", dest=dest, found=0, files=0, total=0,
                   index=0, counts={"downloaded": 0, "skipped": 0, "linked": 0, "failed": 0}, current=None, recent=[],
                   failedFiles=[], folderCounts={})

        items, folder_counts, files, seen = [], {}, 0, set()
        for item, rel in self._sources(self._service, include_shared):
            if self._stop.is_set():
                return self._emit(phase="stopped", message="Stopped.")
            # A shared item already added to My Drive (or reachable twice) is downloaded once.
            if item["id"] in seen:
                continue
            seen.add(item["id"])
            items.append((item, rel))
            if item["mimeType"] != drive.FOLDER:
                files += 1
                key = self._card_key(rel)
                if key:
                    folder_counts[key] = folder_counts.get(key, 0) + 1
            if len(items) % 100 == 0:
                self._emit(found=len(items), files=files)
        self._emit(phase="downloading", message="Downloading…", found=len(items), files=files, total=len(items),
                   folderCounts=folder_counts)
        self._download(items, dest)

    def _retry(self, ids):
        if not self._state:
            self._state = load_last_run().get("job") or {}  # retrying right after the app reopened
        failed = self._state.get("failedFiles", [])
        todo = [f for f in failed if ids is None or f["item"]["id"] in ids]
        if not todo:
            return
        counts = self._state["counts"]
        counts["failed"] -= len(todo)  # _download counts each one again, as downloaded or failed
        self._emit(phase="downloading", message=f"Retrying {len(todo)} failed file(s)…", total=len(todo),
                   index=0, counts=counts, failedFiles=[f for f in failed if f not in todo])
        self._download([(f["item"], f["path"]) for f in todo], self._state.get("dest", self._dest))

    def _download(self, items, dest):
        root = long_path(dest)
        counts, recent, failed = self._state["counts"], self._state["recent"], self._state["failedFiles"]
        for i, (item, rel) in enumerate(items, 1):
            if self._stop.is_set():
                break
            entry = {"name": os.path.basename(rel), "path": rel, "mimeType": item["mimeType"],
                     "size": int(item.get("size", 0)), "modifiedTime": item["modifiedTime"]}
            self._emit(index=i, current=dict(entry, progress=0))
            try:
                result = drive.download(self._service, item, os.path.join(root, rel),
                                        lambda p: self._emit(current=dict(entry, progress=p)))
                if result == "folder":
                    continue
                counts[result] = counts.get(result, 0) + 1  # runs saved before "linked" existed lack the key
            except Exception as e:
                result = "failed"
                counts["failed"] += 1
                entry["error"] = drive.reason(e)
                # The raw Drive item is kept so the file can be retried, even after the app restarts.
                failed.append(dict(entry, item=item))
            if result != "skipped":
                recent = [dict(entry, result=result)] + recent[:RECENT - 1]
            self._emit(counts=counts, recent=recent, failedFiles=failed)
        self._finish(root, counts, failed)

    def _finish(self, root, counts, failed):
        report = os.path.join(root, FAILED_REPORT)
        if failed:
            os.makedirs(root, exist_ok=True)
            with open(report, "w", encoding="utf-8") as f:
                f.write("".join(f"{x['path']}: {x['error']}\n" for x in failed))
        elif os.path.exists(report):
            os.remove(report)  # every failure was fixed by a retry
        message = (f"{counts['downloaded']} downloaded, {counts['skipped']} already up to date, "
                   f"{counts.get('linked', 0)} saved as link, {counts['failed']} failed.")
        if failed:
            message += f" Failed files are listed in {FAILED_REPORT}."
        self._emit(phase="stopped" if self._stop.is_set() else "done", message=message, current=None)


if __name__ == "__main__":
    api = Api()
    api._window = webview.create_window("downD", UI, js_api=api, width=1280, height=820, min_size=(1024, 680))
    webview.start()
