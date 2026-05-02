@echo off
chcp 65001 >nul
echo Запуск сервера Синтезатора...
cd /d "%~dp0synth-app"

REM Запускаем Vite сервер и автоматически открываем браузер
npm run dev -- --open
