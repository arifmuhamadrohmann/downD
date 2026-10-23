# downD

Download everything in your Google Drive to your Windows PC: log in with Google, pick a folder, click **Download all**.

- Keeps your Drive folder structure.
- Converts Google Docs, Sheets and Slides to `.docx`, `.xlsx` and `.pptx` (Drawings to `.png`, Jamboards to `.pdf`, Apps Script to `.json`).
- Run it again any time: files that have not changed are skipped, so an interrupted download picks up where it stopped.
- Read-only access. downD never changes or deletes anything in your Drive, and your files go straight from Google to your PC.

## Using downD

1. Download `downD.exe` from the [Releases](../../releases) page and run it.
2. Click **Login with Google** and allow access in your browser.
3. Choose where to save, then click **Download all**.

While the app is waiting for Google's verification, Google shows a *"Google hasn't verified this app"* screen at login. Click **Advanced → Go to downD** to continue.

### What cannot be downloaded

Google Docs, Sheets and Slides have no file of their own; they can only be exported. The Drive API refuses exports over 10 MB, so for those downD falls back to Drive's own *File → Download* links, which often allow larger files. When Google still offers no file, downD saves a `.url` shortcut with the same name that opens it in your browser, counted under **Saved as link**:

- Google Forms, Sites and My Maps (Google has no download format for them).
- Docs/Sheets/Slides that are too large for both export routes.
- Shared files whose owner turned off downloading, printing and copying for viewers.

Files that could not be saved for any other reason, such as a network error, are listed under **Failed files** with a **Retry** button for each (and **Retry all**), and in `downD-failed.txt` in your download folder.
- Shortcuts are skipped; the file or folder they point to is downloaded where it really lives.

### Shared files

Turn on **Include shared files** to also download everything in "Shared with me" and in your Shared drives. They are saved in their own folders next to your My Drive files:

```
Google Drive\
  (your My Drive folders and files)
  Shared with me\
  Shared drives\<drive name>\
```

An item that is both shared with you and added to your My Drive is downloaded once, in My Drive.

## Use your own Google client (optional)

The shared login has a limit of 100 users until the app is verified. To skip that limit, create your own client (steps 1 to 4 below), download its JSON, and save it as
`%APPDATA%\downD\client_secret.json`. downD uses that file instead of the built-in one.

## Building from source

Needs Python 3.11 or newer and Node.js 20 or newer on Windows. The window is a React + [shadcn/ui](https://ui.shadcn.com/) page in `ui/`, shown with [pywebview](https://pywebview.flowrl.com/) (Microsoft Edge WebView2, built into Windows 10 and 11).

```bat
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt pyinstaller
python -m unittest
npm --prefix ui install
npm --prefix ui run build
python app.py
```

To work on the UI with hot reload, run `npm --prefix ui run dev` and start the app with `set DOWND_DEV_URL=http://localhost:5173` first.

### Create the Google OAuth client

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create a project, and enable the **Google Drive API** (*APIs & Services → Library*).
2. Under *APIs & Services → OAuth consent screen*, set it up as **External**. Add the scope `https://www.googleapis.com/auth/drive.readonly`.
3. While the app is in **Testing**, add your own Google account under *Test users*. Testing-mode logins expire after 7 days; downD then asks you to log in again.
4. Under *Credentials → Create credentials → OAuth client ID*, choose **Desktop app** and download the JSON.
5. Save it as `client_secret.json` next to `app.py`. It is git-ignored; never commit it.

### Build the .exe

```bat
build.bat
```

It builds the UI, then `dist\downD.exe` with the UI and `client_secret.json` built in. Google treats the secret of a desktop client as public, so shipping it in the release is expected.

### Publishing for everyone

To remove the "unverified app" screen and the 100-user limit, set the consent screen to **In production** and submit it for verification. `drive.readonly` is a restricted scope, so Google requires a homepage, a privacy policy, a demo video and a yearly security assessment (CASA).

## Project layout

| File | Purpose |
|---|---|
| `app.py` | Opens the window and exposes `Api` to the page. Runs the Drive work on a background thread and pushes progress to the page. |
| `ui/` | The interface: Vite, React, Tailwind and shadcn/ui. `src/lib/downd.ts` is the bridge to `app.py`. |
| `drive.py` | Login, walking My Drive, file names, downloading. |
| `test_drive.py`, `test_app.py` | Tests for `drive.py` and the download/retry logic in `app.py` (no network needed). |
| `build.bat` | Builds `dist\downD.exe` with PyInstaller. |

## License

MIT
