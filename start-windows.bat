@echo off
rem Mr. Chartist API Bridge: double-click to start. The first run gets everything it needs: Node.js (a private copy
rem in .\runtime if this computer has none), the Bridge's parts and a first setup with safe defaults. No admin rights,
rem no questions. Settings stay next to this file in bridge.config.json.
rem If Windows says "Windows protected your PC", click "More info" and then "Run anyway". It appears because this file
rem came from a downloaded ZIP; after the first run Windows does not ask again.
setlocal
cd /d "%~dp0"
title Mr. Chartist API Bridge

rem Opened straight from inside the ZIP? Windows then copies just this one file to a temporary folder.
if not exist "%~dp0package.json" goto notextracted
if not exist "%~dp0scripts\install\launch-windows.ps1" goto notextracted

set "MCB_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%MCB_PS%" set "MCB_PS=powershell.exe"

rem "%~dp0." not "%~dp0": a trailing backslash would swallow the closing quote. Bypass is for this one run only.
"%MCB_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install\launch-windows.ps1" -AppDir "%~dp0." -ConfigDir "%~dp0."
if "%errorlevel%"=="9009" goto nopowershell
echo.
pause
exit /b 0

:notextracted
echo.
echo The Bridge files have not been unpacked yet.
echo Close this window, right-click the downloaded ZIP file, choose "Extract All...", then open the
echo extracted folder and double-click start-windows.bat there.
echo.
pause
exit /b 1

:nopowershell
echo.
echo Windows PowerShell could not be started, and the Bridge needs it to set itself up.
echo It is part of Windows 10 and 11; ask whoever manages this computer whether it has been turned off.
echo.
pause
exit /b 1
