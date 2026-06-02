@echo off
REM Launch the Channel Splitter GUI (no console window).
cd /d "%~dp0"
start "" pythonw splitter_gui.py
