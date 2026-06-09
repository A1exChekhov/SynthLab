@echo off
REM Build a compact standalone ChannelSplitter.exe (~54 MB).
REM Uses an isolated venv with pip (OpenBLAS) numpy/scipy to avoid the huge
REM Intel-MKL DLLs that bloat a system-Python build to ~800 MB.
cd /d "%~dp0"
python -m venv buildenv
buildenv\Scripts\python.exe -m pip install --upgrade pip
buildenv\Scripts\python.exe -m pip install numpy scipy sounddevice soundcard moderngl glfw pywebview winsdk pystray pillow miniaudio pyinstaller
REM ── ГЕЙТ: прогон self-test перед сборкой. Если упал — НЕ собираем (ловим регрессии). ──
buildenv\Scripts\python.exe selftest.py
if errorlevel 1 ( echo. & echo SELFTEST FAILED — build aborted. & exit /b 1 )
REM v2.2 — premium web UI (pywebview) + tray + mini player + radio + ru/en.
buildenv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --windowed ^
  --name ChannelSplitter --version-file version_info.txt ^
  --add-data "app_web;app_web" ^
  --collect-all webview --collect-all clr_loader --hidden-import clr --collect-all winsdk ^
  --collect-binaries sounddevice --collect-all soundcard ^
  --collect-all moderngl --collect-all glcontext --collect-all glfw ^
  --collect-all pystray --collect-all PIL --collect-all miniaudio splitter_app.py
echo.
echo Done -^> dist\ChannelSplitter.exe (web UI 2.0)
pause
