@echo off
REM Zumi launcher — double-click to start the desktop buddy
cd /d "%~dp0"

if not exist "node_modules\electron" (
  echo Installing dependencies (first run)...
  call npm.cmd install
)

echo Starting Zumi...
call "%~dp0node_modules\.bin\electron.cmd" .
