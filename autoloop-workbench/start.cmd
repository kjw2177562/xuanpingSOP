@echo off
rem Autoloop Workbench - local only (127.0.0.1)
cd /d "%~dp0"
echo Starting Autoloop workbench on http://127.0.0.1:8765 ...
echo Close this window to stop the server.
node server.js
pause
