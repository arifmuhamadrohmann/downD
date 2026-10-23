"""Google Drive access for downD: login, walk My Drive, download files."""
import os
import re
import sys
from datetime import datetime

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import AuthorizedSession, Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
APP_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "downD")
TOKEN = os.path.join(APP_DIR, "token.json")
FOLDER = "application/vnd.google-apps.folder"
SHORTCUT = "application/vnd.google-apps.shortcut"

# Google Workspace files have no bytes of their own; they are exported to these formats.
# Other Workspace types (Forms, Sites, My Maps, shortcuts) cannot be downloaded through the API.
EXPORTS = {
    "application/vnd.google-apps.document": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
    "application/vnd.google-apps.spreadsheet": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"),
    "application/vnd.google-apps.presentation": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"),
    "application/vnd.google-apps.drawing": ("image/png", ".png"),
    "application/vnd.google-apps.jam": ("application/pdf", ".pdf"),
    "application/vnd.google-apps.script": ("application/vnd.google-apps.script+json", ".json"),
}

_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def client_secret_path():
    # A client_secret.json the user puts in %APPDATA%\downD wins over the one bundled in the release build.
    own = os.path.join(APP_DIR, "client_secret.json")
    if os.path.exists(own):
        return own
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "client_secret.json")


def login(interactive=True):
    """Return a Drive service, or None when not interactive and no saved login works."""
    creds = Credentials.from_authorized_user_file(TOKEN, SCOPES) if os.path.exists(TOKEN) else None
    if creds and not creds.valid and creds.refresh_token:
        try:
            creds.refresh(Request())
        except RefreshError:
            creds = None  # revoked, or expired (Testing-mode tokens last 7 days): log in again
        # Other errors (no network) propagate, so a flaky connection does not look like a logout.
    if not creds or not creds.valid:
        if not interactive:
            return None
        secret = client_secret_path()
        if not os.path.exists(secret):
            raise FileNotFoundError(f"client_secret.json not found. See README, or put it in {APP_DIR}")
        creds = InstalledAppFlow.from_client_secrets_file(secret, SCOPES).run_local_server(
            port=0, timeout_seconds=300, success_message="downD is connected. You can close this tab.")
    os.makedirs(APP_DIR, exist_ok=True)
    with open(TOKEN, "w", encoding="utf-8") as f:
        f.write(creds.to_json())
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def clone(service):
    """A second Drive service on the same login. googleapiclient services are not thread-safe."""
    return build("drive", "v3", credentials=service._http.credentials, cache_discovery=False)


def logout():
    if os.path.exists(TOKEN):
        os.remove(TOKEN)


def profile(service):
    """Account name, email, photo URL and storage use in bytes (limit is None for unlimited plans)."""
    about = service.about().get(
        fields="user(displayName, emailAddress, photoLink), storageQuota(usage, limit)").execute(num_retries=5)
    user, quota = about["user"], about.get("storageQuota", {})
    return {"name": user.get("displayName") or user["emailAddress"], "email": user["emailAddress"],
            "photo": user.get("photoLink"), "usage": int(quota.get("usage", 0)),
            "limit": int(quota["limit"]) if "limit" in quota else None}


def reason(error):
    if isinstance(error, HttpError):
        return error.reason or str(error)
    return str(error) or type(error).__name__


def safe_name(name):
    """Make a Drive name valid as a Windows file name."""
    name = _BAD_CHARS.sub("_", name).rstrip(" .") or "_"
    if name.split(".")[0].upper() in _RESERVED:
        name = "_" + name
    return name[:240]  # leaves room for " (n)" under the 255-char NTFS limit


def unique(name, used):
    """Drive allows duplicate names in one folder; Windows does not (case-insensitively)."""
    stem, ext = os.path.splitext(name)
    candidate, n = name, 2
    while candidate.lower() in used:
        candidate, n = f"{stem} ({n}){ext}", n + 1
    used.add(candidate.lower())
    return candidate


def _list_files(service, **query):
    items, page = [], None
    while True:
        resp = service.files().list(
            fields="nextPageToken, files(id, name, mimeType, size, modifiedTime, createdTime, sharingUser(displayName))",
            pageSize=1000, pageToken=page, supportsAllDrives=True, **query).execute(num_retries=5)
        items += resp.get("files", [])
        page = resp.get("nextPageToken")
        if not page:
            # Oldest first, so " (2)" suffixes stay on the same files when new ones are added later.
            return sorted(items, key=lambda f: (f.get("createdTime", ""), f["id"]))


def list_children(service, folder_id):
    # allDrives, so folders inside shared drives list their contents too.
    return _list_files(service, q=f"'{folder_id}' in parents and trashed = false",
                       corpora="allDrives", includeItemsFromAllDrives=True)


def shared_with_me(service):
    """Files and folders other people shared with this account."""
    return _list_files(service, q="sharedWithMe = true and trashed = false")


def shared_drives(service):
    drives, page = [], None
    while True:
        resp = service.drives().list(fields="nextPageToken, drives(id, name)", pageSize=100,
                                     pageToken=page).execute(num_retries=5)
        drives += resp.get("drives", [])
        page = resp.get("nextPageToken")
        if not page:
            return drives


# Top-level names downD saves shared items under; a My Drive folder with the same name gets " (2)".
SHARED_WITH_ME = "Shared with me"
SHARED_DRIVES = "Shared drives"


def walk(service, folder_id="root", rel=""):
    """Yield (item, relative_path) for every folder and file under folder_id."""
    used = {SHARED_WITH_ME.lower(), SHARED_DRIVES.lower()} if folder_id == "root" and not rel else set()
    yield from walk_items(service, list_children(service, folder_id), rel, used)


def walk_items(service, items, rel="", used=None):
    """Yield (item, relative_path) for items and, for folders, everything inside them."""
    used = set() if used is None else used
    for item in items:
        # A shortcut only points at a file or folder that is downloaded where it really lives.
        if item["mimeType"] == SHORTCUT:
            continue
        name = item["name"]
        ext = EXPORTS.get(item["mimeType"], (None, ""))[1]
        if ext and not name.lower().endswith(ext):
            name += ext
        path = os.path.join(rel, unique(safe_name(name), used))
        yield item, path
        if item["mimeType"] == FOLDER:
            yield from walk(service, item["id"], path)


class CannotExport(Exception):
    """Google offers no file for this one: over the API's 10 MB export limit, or the owner turned off downloads."""


# Drive API error reasons that no retry can fix; the file is saved as a link instead.
_NO_FILE_REASONS = (b"exportSizeLimitExceeded", b"cannotExportFile", b"cannotDownloadFile")


def _no_file(error):
    return isinstance(error, HttpError) and any(r in (error.content or b"") for r in _NO_FILE_REASONS)


def _same_time(path, mtime):
    return os.path.exists(path) and int(os.path.getmtime(path)) == int(mtime)


def download(service, item, dest, on_progress=lambda fraction: None):
    """Save one item at dest. Returns "folder", "skipped", "downloaded" or "linked"; raises on failure.

    "linked" means Google offers no file for it, so a .url shortcut that opens it in the browser was saved.
    """
    mime = item["mimeType"]
    if mime == FOLDER:
        os.makedirs(dest, exist_ok=True)
        return "folder"

    # The local copy gets Drive's modified time, so an unchanged file is skipped on the next run.
    mtime = datetime.fromisoformat(item["modifiedTime"].replace("Z", "+00:00")).timestamp()
    if _same_time(dest, mtime):
        return "skipped"
    link = os.path.splitext(dest)[0] + ".url"
    if _same_time(link, mtime):
        return "linked"  # Google had no file for it last time, and it has not changed since

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if mime.startswith("application/vnd.google-apps.") and mime not in EXPORTS:
        return _save_link(item, link, mtime)  # Forms, Sites, My Maps: Google has no download for them
    try:
        _save(dest, mtime, lambda f: _fetch(service, item, f, on_progress))
    except CannotExport:
        if mime not in EXPORTS:  # an uploaded file whose owner turned off downloads
            return _save_link(item, link, mtime)
        try:
            # Drive's own "File > Download" links often export files the API refuses as too large.
            _save(dest, mtime, lambda f: _fetch_export_link(service, item, f, on_progress))
        except CannotExport:
            return _save_link(item, link, mtime)
    return "downloaded"


def _save(dest, mtime, write):
    part = dest + ".part"  # an interrupted download never looks like a finished file
    try:
        with open(part, "wb") as f:
            write(f)
        os.replace(part, dest)
    finally:
        if os.path.exists(part):
            os.remove(part)
    os.utime(dest, (mtime, mtime))


def _fetch(service, item, f, on_progress):
    if item.get("size") == "0":
        return
    mime = item["mimeType"]
    if mime in EXPORTS:
        request = service.files().export_media(fileId=item["id"], mimeType=EXPORTS[mime][0])
    else:
        request = service.files().get_media(fileId=item["id"], supportsAllDrives=True)
    downloader = MediaIoBaseDownload(f, request, chunksize=10 * 1024 * 1024)
    done = False
    while not done:
        try:
            status, done = downloader.next_chunk(num_retries=5)
        except HttpError as e:
            if _no_file(e):
                raise CannotExport from e
            raise
        on_progress(status.progress() if status and status.total_size else 0)


def _fetch_export_link(service, item, f, on_progress):
    try:
        links = service.files().get(fileId=item["id"], fields="exportLinks",
                                    supportsAllDrives=True).execute(num_retries=5).get("exportLinks") or {}
    except HttpError as e:
        if _no_file(e):
            raise CannotExport from e
        raise
    url = links.get(EXPORTS[item["mimeType"]][0])
    if not url:
        raise CannotExport
    with AuthorizedSession(service._http.credentials).get(url, stream=True, timeout=120) as resp:
        if 400 <= resp.status_code < 500:
            raise CannotExport
        resp.raise_for_status()  # a server error stays a failure that can be retried
        total, done = int(resp.headers.get("Content-Length") or 0), 0
        for chunk in resp.iter_content(1024 * 1024):
            f.write(chunk)
            done += len(chunk)
            on_progress(done / total if total else 0)


def _save_link(item, link, mtime):
    with open(link, "w", encoding="utf-8") as f:
        f.write(f"[InternetShortcut]\nURL=https://drive.google.com/open?id={item['id']}\n")
    os.utime(link, (mtime, mtime))
    return "linked"
