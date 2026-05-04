@echo off
chcp 65001 >nul

echo Остановка старого сервера на порту 9000 (если есть)...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr "LISTENING" ^| findstr ":9000"') do taskkill /f /pid %%a 2>nul

echo Запуск сервера Синтезатора...
cd /d "%~dp0synth-app"

npm run dev -- --open
