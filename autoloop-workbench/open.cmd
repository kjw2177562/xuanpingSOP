@echo off
rem Autoloop Workbench - start the local server if needed, then open the page in your browser.
cd /d "%~dp0"
netstat -ano | findstr "127.0.0.1:8765" | findstr LISTENING >nul
if errorlevel 1 (
  start "Autoloop Workbench Server" /min node server.js
  timeout /t 2 >nul
)
start "" "http://127.0.0.1:8765/"
