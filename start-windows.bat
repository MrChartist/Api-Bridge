@echo off
rem Mr. Chartist API Bridge: double-click to start. First run installs what it needs and runs the setup.
setlocal
cd /d "%~dp0"
title Mr. Chartist API Bridge

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Install the LTS version from https://nodejs.org/ and double-click this file again.
  echo.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo.
  echo This needs Node.js 20 or newer. Install the LTS version from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing the Bridge. This takes a minute...
  call npm ci --omit=dev --no-audit --no-fund || call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Installing failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist "bridge.config.json" (
  echo.
  echo First run: a few questions to set things up. Press Enter to accept a suggestion.
  node bin\mc-bridge.mjs init
  if errorlevel 1 (
    pause
    exit /b 1
  )
  echo.
  echo Copy the admin key above before you continue.
  pause
)

node bin\mc-bridge.mjs start --open
echo.
echo The Bridge has stopped.
pause
