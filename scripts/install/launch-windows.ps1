# Mr. Chartist API Bridge: the Windows launcher behind start-windows.bat and the "Mr Chartist Bridge" shortcuts.
# Gets Node.js 22 (a private copy in <AppDir>\runtime if needed), installs the Bridge's parts on the first run, runs
# the first setup without questions when there is no bridge.config.json yet, then starts the Bridge and opens the
# dashboard. Run it with: powershell -NoProfile -ExecutionPolicy Bypass -File launch-windows.ps1 [-ConfigDir <folder>]
#   -AppDir     the Bridge folder (default: two folders up from this file)
#   -ConfigDir  where bridge.config.json lives (default: %APPDATA%\MrChartist\Bridge, as for an installed Bridge)
#   -Demo       first setup and start in demo mode (sample prices, no broker needed); MCB_DEMO=1 does the same
#   -NoStart    get everything ready but do not start
#   -Pause      wait for Enter before the window closes (for shortcuts; start-windows.bat pauses by itself)
#   -CliName    how the Bridge should name its command in hints (the installed shortcut passes mc-bridge)
param(
  [string]$AppDir,
  [string]$ConfigDir,
  [switch]$Demo,
  [switch]$NoStart,
  [switch]$Pause,
  [string]$CliName
)

$ErrorActionPreference = 'Stop'
try { $Host.UI.RawUI.WindowTitle = 'Mr. Chartist API Bridge' } catch { }
. (Join-Path $PSScriptRoot 'node-runtime.ps1')

if (-not $AppDir) { $AppDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }
$AppDir = Get-McbFullPath $AppDir
if (-not $ConfigDir) { $ConfigDir = Get-McbUserDir }
$ConfigDir = Get-McbFullPath $ConfigDir
if ($CliName) { $env:MCB_CLI_NAME = $CliName }
if ($env:MCB_DEMO -eq '1' -or $env:MCB_DEMO -eq 'true') { $Demo = $true }

function Wait-McbClose {
  if ($Pause) {
    Write-Host ''
    Read-Host 'Press Enter to close this window' | Out-Null
  }
}

$code = 0
try {
  Write-Host 'Mr. Chartist API Bridge'
  Write-Host ''

  # Files from a downloaded ZIP carry a "came from the internet" mark, which makes Windows ask before every run.
  # Clearing it on the Bridge's own launch files means it asks only the first time.
  if (Test-McbWindows) {
    try {
      Get-ChildItem -LiteralPath $AppDir -Force -File -ErrorAction Stop | Where-Object { $_.Extension -match '^\.(bat|cmd|ps1|command)$' } | Unblock-File -ErrorAction SilentlyContinue
      Get-ChildItem -LiteralPath $PSScriptRoot -Force -File -ErrorAction Stop | Unblock-File -ErrorAction SilentlyContinue
    } catch { }
  }

  if (-not (Test-Path -LiteralPath (Join-McbPath $AppDir 'bin' 'mc-bridge.mjs'))) {
    throw "The Bridge files are missing from $AppDir. Download the Bridge again and unpack the whole ZIP."
  }

  Write-Host 'Checking for Node.js...'
  $node = Initialize-McbNode -AppDir $AppDir

  if (-not (Test-McbPackagesCurrent $AppDir)) {
    Write-Host ''
    Write-Host 'Installing the Bridge (first run or after an update). This takes a minute...'
    Install-McbPackages -AppDir $AppDir -Node $node
  }

  $configFile = Join-Path $ConfigDir 'bridge.config.json'
  if (-not (Test-Path -LiteralPath $configFile)) {
    Write-Host ''
    Write-Host 'First run: setting things up with safe defaults (real trading stays off until you turn it on).'
    Initialize-McbConfig -AppDir $AppDir -ConfigDir $ConfigDir -Node $node -Demo:$Demo | Out-Null
  }

  if ($NoStart) {
    Write-Host ''
    Write-Host 'Everything is ready.'
  } else {
    # This window was opened by a double-click: a short, plain status and no log lines (cli.mjs appWindowLines).
    $env:MCB_APP_WINDOW = '1'
    if (-not $env:MCB_LOG_LEVEL) { $env:MCB_LOG_LEVEL = 'error' }
    Start-McbBridge -AppDir $AppDir -ConfigDir $ConfigDir -Node $node -Demo:$Demo
    $code = $LASTEXITCODE
    Write-Host ''
    if ($code -eq 0) {
      Write-Host 'The Bridge has stopped.'
    } else {
      Write-Host 'The Bridge stopped with a problem. The messages above say what happened.'
      Write-Host 'If another copy of the Bridge is already running, use that one, or close it and try again.'
    }
  }
} catch {
  $code = 1
  Write-Host ''
  Write-Host 'Sorry, something went wrong:' -ForegroundColor Yellow
  Write-Host "  $($_.Exception.Message)"
  Write-Host ''
  Write-Host 'Fix the problem above if you can, then start the Bridge again.'
}
Wait-McbClose
exit $code
