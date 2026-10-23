@echo off
rem Builds dist\downD.exe. Run inside the activated .venv, with client_secret.json next to this file (see README).
if not exist client_secret.json (echo client_secret.json is missing. See README. & exit /b 1)

call npm --prefix ui ci || exit /b 1
call npm --prefix ui run build || exit /b 1

rem shortcut: PyInstaller's googleapiclient hook bundles every API description (~38 MB exe); drop the unused ones with a custom hook if size matters.
pyinstaller --noconfirm --onefile --windowed --name downD --add-data "client_secret.json;." ^
  --add-data "ui\dist;ui\dist" app.py
