@echo off
REM Build a compact standalone ChannelSplitter.exe (~54 MB).
REM Uses an isolated venv with pip (OpenBLAS) numpy/scipy to avoid the huge
REM Intel-MKL DLLs that bloat a system-Python build to ~800 MB.
cd /d "%~dp0"
python -m venv buildenv
buildenv\Scripts\python.exe -m pip install --upgrade pip
buildenv\Scripts\python.exe -m pip install numpy scipy sounddevice soundcard moderngl glfw pywebview pyinstaller
REM v2.0 — premium web UI (pywebview) over the Python audio engine.
buildenv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --windowed ^
  --name ChannelSplitter --version-file version_info.txt ^
  --add-data "app_web;app_web" ^
  --collect-all webview --collect-all clr_loader --hidden-import clr ^
  --collect-binaries sounddevice --collect-all soundcard ^
  --collect-all moderngl --collect-all glcontext --collect-all glfw splitter_app.py
echo.
echo Done -^> dist\ChannelSplitter.exe (web UI 2.0)
pause
