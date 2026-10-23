@echo off
rem Builds dist\downD.exe. Run inside the activated .venv (see README).
rem   build.bat              bundles client_secret.json, so users can log in right away
rem   build.bat --no-secret  leaves it out; users put their own in %APPDATA%\downD (public releases)
set SECRET=--add-data client_secret.json;.
if /i "%~1"=="--no-secret" set SECRET=
if defined SECRET if not exist client_secret.json (echo client_secret.json is missing. See README, or use --no-secret. & exit /b 1)

call npm --prefix ui ci || exit /b 1
call npm --prefix ui run build || exit /b 1

rem shortcut: PyInstaller's googleapiclient hook bundles every API description (~38 MB exe); drop the unused ones with a custom hook if size matters.
pyinstaller --noconfirm --onefile --windowed --name downD %SECRET% --add-data "ui\dist;ui\dist" app.py
