@echo off
REM Channel splitter launcher. Examples:
REM   run.bat --list
REM   run.bat --left "Bob" --right "JBL"
REM   run.bat --test --left "Bob" --right "JBL"
cd /d "%~dp0"
python splitter.py %*
