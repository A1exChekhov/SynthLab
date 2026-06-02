@echo off
REM Build a compact standalone ChannelSplitter.exe (~54 MB).
REM Uses an isolated venv with pip (OpenBLAS) numpy/scipy to avoid the huge
REM Intel-MKL DLLs that bloat a system-Python build to ~800 MB.
cd /d "%~dp0"
python -m venv buildenv
buildenv\Scripts\python.exe -m pip install --upgrade pip
buildenv\Scripts\python.exe -m pip install numpy scipy sounddevice soundcard pyinstaller
buildenv\Scripts\python.exe -m PyInstaller --noconfirm --onefile --windowed ^
  --name ChannelSplitter --version-file version_info.txt ^
  --collect-binaries sounddevice --collect-all soundcard splitter_gui.py
echo.
echo Done -^> dist\ChannelSplitter.exe
pause
