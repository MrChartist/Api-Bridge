# Mr. Chartist API Bridge: one-line installer for Windows 10 and 11. No admin rights needed.
#
#   Install or update (paste into PowerShell and press Enter):
#     irm https://raw.githubusercontent.com/MrChartist/api-bridge/master/install.ps1 | iex
#   Uninstall (your settings and data are kept unless you also ask to delete them):
#     & ([scriptblock]::Create((irm https://raw.githubusercontent.com/MrChartist/api-bridge/master/install.ps1))) -Uninstall
#   If you downloaded this file instead, Windows blocks running it directly; run it like this (this run only):
#     powershell -ExecutionPolicy Bypass -File install.ps1            (add -Uninstall, -NoStart, -Demo as needed)
#
# What it does: downloads the Bridge into %LOCALAPPDATA%\MrChartist\Bridge\app, uses the Node.js 22+ already on this
# computer or downloads a private, checksum-verified copy into app\runtime, installs the Bridge's parts, adds
# "Mr Chartist Bridge" to the Start menu and Desktop and an mc-bridge command, runs the first setup with safe defaults
# and starts the Bridge with the dashboard open. Running it again updates in place; settings and data in
# %APPDATA%\MrChartist\Bridge are never touched by an update.
#
# Options as environment variables (set them before the irm line, e.g. $env:MCB_NO_START = '1'), or switches with -File:
#   MCB_UNINSTALL=1  -Uninstall  remove the Bridge, its shortcuts and its PATH entry (keeps settings and data)
#   MCB_PURGE=1      -Purge      with uninstall: also offer to delete settings and data (asks you to type DELETE)
#   MCB_NO_START=1   -NoStart    install or update but do not start the Bridge
#   MCB_DEMO=1       -Demo       first setup and start in demo mode (sample prices, no broker needed)
#   MCB_SOURCE       -Source     where the code comes from: a folder, a .zip file or a .zip URL (default: GitHub)
#   MCB_REF          -Ref        GitHub branch or tag to download (default: master)
#   MCB_INSTALL_DIR              install folder (default %LOCALAPPDATA%\MrChartist\Bridge)
#   MCB_HOME                     settings and data folder (default %APPDATA%\MrChartist\Bridge; the Bridge reads it too)
#
# Works on Windows PowerShell 5.1 and PowerShell 7. Everything is inside one function that runs on the last line, so
# a download that stops halfway runs nothing. Keep this file ASCII.

function Install-McBridge {
  [CmdletBinding()]
  param(
    [switch]$Uninstall,
    [switch]$Purge,
    [switch]$NoStart,
    [switch]$Demo,
    [string]$Source,
    [string]$Ref,
    [switch]$ExitOnFailure
  )
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'

  function Test-McbFlag([string]$Value) { return ($Value -and @('0', 'false', 'no', 'off') -notcontains $Value.ToLowerInvariant()) }
  function Write-McbTitle([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
  function Write-McbStep([int]$N, [int]$Of, [string]$Text) { Write-Host ''; Write-Host "[$N/$Of] $Text" -ForegroundColor Cyan }
  function Write-McbNote([string]$Text) { Write-Host "      $Text" }
  function Join-McbPath {
    $p = [string]$args[0]
    for ($i = 1; $i -lt $args.Count; $i++) { $p = Join-Path $p ([string]$args[$i]) }
    return $p
  }
  function Get-McbFullPath([string]$Path) { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path) }
  function Remove-McbItem([string]$Path) {
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop }
  }

  # Only the helpers in this file are available until the code is downloaded, so it has its own download and unzip.
  function Get-McbFile([string]$Uri, [string]$OutFile, [string]$What) {
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -ErrorAction Stop
        return
      } catch {
        $lastError = $_
        if ($attempt -lt 3) { Start-Sleep -Seconds (2 * $attempt) }
      }
    }
    throw "Could not download $What from $Uri. Check your internet connection and try again. (Details: $($lastError.Exception.Message))"
  }
  function Expand-McbArchive([string]$ZipPath, [string]$Destination) {
    Remove-McbItem $Destination
    try {
      Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
      [System.IO.Compression.ZipFile]::ExtractToDirectory((Get-McbFullPath $ZipPath), (Get-McbFullPath $Destination))
    } catch {
      Remove-McbItem $Destination
      Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
    }
  }
  function Copy-McbFolder([string]$From, [string]$To) {
    # A local checkout: everything except installed parts, git history and local settings or data.
    $skip = @('node_modules', '.git', 'runtime', 'data', 'bridge.config.json', 'coverage', '.cache', 'rt-dl', 'rt-new')
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
      if ($skip -contains $item.Name) { continue }
      Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $To $item.Name) -Recurse -Force
    }
  }
  function Get-McbRunningBridge([string]$AppDir) {
    # node.exe processes started from this install (Windows only; best effort).
    try {
      return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop |
          Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($AppDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    } catch { return @() }
  }
  function Wait-McbBridgeClosed([string]$AppDir) {
    for ($i = 0; $i -lt 5; $i++) {
      $running = Get-McbRunningBridge $AppDir
      if ($running.Count -eq 0) { return }
      Write-Host ''
      Write-Host 'The Bridge is running right now. Close its window (or press Ctrl+C in it) so it can be updated.' -ForegroundColor Yellow
      Read-Host 'Then press Enter here to continue' | Out-Null
    }
    if ((Get-McbRunningBridge $AppDir).Count -gt 0) { throw 'The Bridge is still running. Close its window and run this again.' }
  }
  function Get-McbUserPathParts {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    $value = ''
    if ($key) {
      # DoNotExpandEnvironmentNames keeps entries like %USERPROFILE%\bin as they are.
      $value = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $key.Close()
    }
    return @($value -split ';' | Where-Object { $_ })
  }
  function Set-McbUserPath([string[]]$Parts) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try { $key.SetValue('Path', ($Parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $key.Close() }
    # Setting a user variable through .NET tells Windows that the environment changed, so new windows see the
    # new PATH without signing out (no admin rights or extra code needed).
    try {
      [Environment]::SetEnvironmentVariable('MCB_PATH_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('MCB_PATH_REFRESH', $null, 'User')
    } catch { }
  }
  function Test-McbSamePath([string]$A, [string]$B) {
    return ([Environment]::ExpandEnvironmentVariables($A).TrimEnd('\') -eq [Environment]::ExpandEnvironmentVariables($B).TrimEnd('\'))
  }
  function New-McbShortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Description, [string]$Icon) {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    $lnk.Arguments = $Arguments
    $lnk.WorkingDirectory = $WorkDir
    $lnk.Description = $Description
    if ($Icon -and (Test-Path -LiteralPath $Icon)) { $lnk.IconLocation = "$Icon,0" }
    $lnk.Save()
  }

  $onWindows = $true
  if ($PSVersionTable.PSVersion.Major -ge 6) { $onWindows = [bool]$IsWindows }

  # One-shot switches: clear them from this window so running the installer again later does not repeat them.
  if (Test-McbFlag $env:MCB_UNINSTALL) { $Uninstall = $true }
  if (Test-McbFlag $env:MCB_PURGE) { $Purge = $true }
  Remove-Item Env:MCB_UNINSTALL, Env:MCB_PURGE -ErrorAction SilentlyContinue
  if (Test-McbFlag $env:MCB_NO_START) { $NoStart = $true }
  if (Test-McbFlag $env:MCB_DEMO) { $Demo = $true }
  if (-not $Source) { $Source = $env:MCB_SOURCE }
  if (-not $Ref) { $Ref = $env:MCB_REF }
  $stage = $null
  $restoreCliName = $false
  $oldCliName = $null

  try {
    if ($env:MCB_INSTALL_DIR) {
      $base = Get-McbFullPath $env:MCB_INSTALL_DIR
    } elseif ($onWindows -and $env:LOCALAPPDATA) {
      $base = Join-McbPath $env:LOCALAPPDATA 'MrChartist' 'Bridge'
    } else {
      Write-Host 'This installer is for Windows. On a Mac or Linux, use install.sh instead (see the README).'
      if ($ExitOnFailure) { exit 1 }
      return
    }
    $app = Join-Path $base 'app'
    if ($env:MCB_HOME) {
      $configDir = Get-McbFullPath $env:MCB_HOME
    } elseif ($onWindows -and $env:APPDATA) {
      $configDir = Join-McbPath $env:APPDATA 'MrChartist' 'Bridge'
    } else {
      $h = $env:HOME
      if (-not $h) { $h = $env:USERPROFILE }
      $configDir = Join-Path $h '.mc-bridge'
    }
    $shortcutName = 'Mr Chartist Bridge.lnk'
    $startMenuLink = $null
    $desktopLink = $null
    if ($onWindows) {
      $startMenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) $shortcutName
      $desktopLink = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) $shortcutName
    }

    # ---------------------------------------------------------------- uninstall
    if ($Uninstall) {
      Write-McbTitle 'Removing Mr. Chartist API Bridge'
      if ($onWindows) { Wait-McbBridgeClosed $app }
      foreach ($link in @($startMenuLink, $desktopLink)) {
        if ($link -and (Test-Path -LiteralPath $link)) { Remove-Item -LiteralPath $link -Force; Write-McbNote "Removed shortcut $link" }
      }
      if ($onWindows) {
        $parts = Get-McbUserPathParts
        $kept = @($parts | Where-Object { -not (Test-McbSamePath $_ $app) })
        if ($kept.Count -ne $parts.Count) { Set-McbUserPath $kept; Write-McbNote 'Removed the mc-bridge command from your PATH.' }
      }
      try {
        Remove-McbItem $app
        Remove-McbItem (Join-Path $base 'download')
      } catch {
        throw "Some files in $app are in use. Close the Bridge window (and anything else using it), then run the uninstaller again."
      }
      if ((Test-Path -LiteralPath $base) -and -not (Get-ChildItem -LiteralPath $base -Force)) { Remove-Item -LiteralPath $base -Force }
      Write-McbNote 'The Bridge program has been removed.'

      $masterKey = $null
      $cfgFile = Join-Path $configDir 'bridge.config.json'
      if (Test-Path -LiteralPath $cfgFile) {
        try { $masterKey = [string](Get-Content -LiteralPath $cfgFile -Raw | ConvertFrom-Json).masterKeyFile } catch { }
      }
      Write-Host ''
      if (-not (Test-Path -LiteralPath $configDir)) {
        Write-Host 'Done.'
        return
      }
      Write-Host "Your settings, keys and data are kept in: $configDir"
      if ($masterKey) { Write-Host "and the key that unlocks your saved broker logins is in: $masterKey" }
      Write-Host 'Install the Bridge again later and it picks them up where you left off.'
      if (-not $Purge) {
        Write-Host 'To delete them too, run the uninstaller again with MCB_PURGE=1 (or -Purge).'
        return
      }
      Write-Host ''
      Write-Host 'You asked to delete your settings and data as well. This cannot be undone: saved broker logins,' -ForegroundColor Yellow
      Write-Host 'API keys, practice orders and logs will be gone for good.' -ForegroundColor Yellow
      $answer = ''
      try { $answer = Read-Host 'Type DELETE (in capitals) to delete them, or just press Enter to keep them' } catch { }
      if ($answer -cne 'DELETE') {
        Write-Host 'Kept. Nothing else was deleted.'
        return
      }
      Remove-McbItem $configDir
      if ($masterKey -and (Test-Path -LiteralPath $masterKey)) { Remove-Item -LiteralPath $masterKey -Force }
      Write-Host 'Your settings and data have been deleted.'
      return
    }

    # ---------------------------------------------------------------- install or update
    $total = 6
    $upgrade = Test-Path -LiteralPath (Join-McbPath $app 'bin' 'mc-bridge.mjs')
    Write-McbTitle 'Mr. Chartist API Bridge installer'
    if ($upgrade) { Write-Host 'Updating the Bridge on this computer. Your settings and data stay as they are.' }
    else { Write-Host 'This puts the Bridge on this computer, just for you. No admin rights are needed.' }

    Write-McbStep 1 $total 'Checking this computer'
    if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'This needs Windows PowerShell 5.1 or newer (part of Windows 10 and 11).' }
    if ($onWindows -and -not [Environment]::Is64BitOperatingSystem) { throw 'The Bridge needs 64-bit Windows 10 or 11.' }
    Write-McbNote "Program folder: $app"
    Write-McbNote "Settings and data: $configDir"
    if ($onWindows -and $upgrade) { Wait-McbBridgeClosed $app }

    Write-McbStep 2 $total 'Downloading the Bridge'
    New-Item -ItemType Directory -Force -Path $base | Out-Null
    $stage = Join-Path $base 'download'
    Remove-McbItem $stage
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    $unpacked = Join-Path $stage 'src'
    if (-not $Source) {
      if ($Ref) { $Source = "https://codeload.github.com/MrChartist/api-bridge/zip/$Ref" }
      else { $Source = 'https://codeload.github.com/MrChartist/api-bridge/zip/refs/heads/master' }
    }
    if ($Source -match '^https?://') {
      $zip = Join-Path $stage 'bridge.zip'
      Write-McbNote "From $Source"
      Get-McbFile $Source $zip 'the Bridge'
      Expand-McbArchive $zip $unpacked
    } elseif (Test-Path -LiteralPath $Source -PathType Container) {
      Write-McbNote "Copying from the folder $Source"
      Copy-McbFolder (Get-McbFullPath $Source) $unpacked
    } elseif (Test-Path -LiteralPath $Source -PathType Leaf) {
      Write-McbNote "Unpacking $Source"
      Expand-McbArchive $Source $unpacked
    } else {
      throw "Could not find $Source (MCB_SOURCE). Use a folder, a .zip file or a web address."
    }
    # A GitHub ZIP holds one folder (api-bridge-master); a folder copy has the files directly.
    $root = $unpacked
    if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) {
      $inner = @(Get-ChildItem -LiteralPath $unpacked -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'package.json') })
      if ($inner.Count -eq 1) { $root = $inner[0].FullName }
    }
    foreach ($need in @(@('package.json'), @('bin', 'mc-bridge.mjs'), @('scripts', 'install', 'node-runtime.ps1'))) {
      $p = $root
      foreach ($part in $need) { $p = Join-Path $p $part }
      if (-not (Test-Path -LiteralPath $p)) { throw "The download does not look like the Bridge (missing $($need -join '\')). Try again later." }
    }
    # Replace the program files; keep the private Node.js (and settings or data, should anyone have put them here).
    $keep = @('runtime', 'bridge.config.json', 'data')
    New-Item -ItemType Directory -Force -Path $app | Out-Null
    try {
      Get-ChildItem -LiteralPath $app -Force | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Recurse -Force -ErrorAction Stop
    } catch {
      throw "Some files in $app are in use. Close the Bridge window (and anything else using it), then run this again."
    }
    Get-ChildItem -LiteralPath $root -Force | Where-Object { $keep -notcontains $_.Name } | Move-Item -Destination $app
    Remove-McbItem $stage
    Write-McbNote 'Done.'

    # From here on, the helpers that came with the download do the work. Loaded as text (not run as a file) because
    # Windows may block running .ps1 files; this is the same thing irm | iex does.
    $helpers = Join-McbPath $app 'scripts' 'install' 'node-runtime.ps1'
    . ([scriptblock]::Create((Get-Content -LiteralPath $helpers -Raw)))

    Write-McbStep 3 $total 'Getting Node.js ready'
    $node = Initialize-McbNode -AppDir $app

    Write-McbStep 4 $total "Installing the Bridge's parts (about a minute)"
    Install-McbPackages -AppDir $app -Node $node

    Write-McbStep 5 $total 'Adding shortcuts and the mc-bridge command'
    if ($onWindows) {
      # mc-bridge.cmd: the command line tool. No ( ) blocks, so folders with brackets in their names work.
      $shim = @(
        '@echo off',
        'rem Mr. Chartist API Bridge command line (created by install.ps1). Example: mc-bridge doctor',
        'setlocal',
        'set "MCB_CLI_NAME=mc-bridge"',
        'set "MCB_NODE=node"',
        'if exist "%~dp0runtime\node.exe" set "MCB_NODE=%~dp0runtime\node.exe"',
        '"%MCB_NODE%" "%~dp0bin\mc-bridge.mjs" %*'
      )
      [IO.File]::WriteAllText((Join-Path $app 'mc-bridge.cmd'), (($shim -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)

      $ps = Join-McbPath $env:SystemRoot 'System32' 'WindowsPowerShell' 'v1.0' 'powershell.exe'
      $launcher = Join-McbPath $app 'scripts' 'install' 'launch-windows.ps1'
      $launchArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -Pause -CliName mc-bridge"
      foreach ($link in @($startMenuLink, $desktopLink)) {
        try {
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $link) | Out-Null
          New-McbShortcut $link $ps $launchArgs $app 'Start Mr. Chartist API Bridge and open its dashboard' (Join-Path $app 'scripts\install\icon\mr-chartist-bridge.ico')
          Write-McbNote "Shortcut: $link"
        } catch {
          Write-McbNote "Could not create the shortcut $link ($($_.Exception.Message)). The Bridge works without it."
        }
      }
      try {
        $parts = Get-McbUserPathParts
        if (-not ($parts | Where-Object { Test-McbSamePath $_ $app })) {
          Set-McbUserPath (@($parts) + $app)
          Write-McbNote 'Added the mc-bridge command for new terminal windows.'
        }
      } catch {
        Write-McbNote "Could not add mc-bridge to your PATH ($($_.Exception.Message)). Use $app\mc-bridge.cmd instead."
      }
      if (-not (@($env:PATH -split ';') | Where-Object { Test-McbSamePath $_ $app })) { $env:PATH = "$env:PATH;$app" }
    } else {
      Write-McbNote 'Skipped: shortcuts and PATH are only set up on Windows.'
    }

    Write-McbStep 6 $total 'Setting up'
    # The Bridge words its command hints as "mc-bridge ..." (the command this installer adds). Restored at the end.
    $oldCliName = $env:MCB_CLI_NAME
    $env:MCB_CLI_NAME = 'mc-bridge'
    $restoreCliName = $true
    $created = Initialize-McbConfig -AppDir $app -ConfigDir $configDir -Node $node -Demo:$Demo
    if (-not $created) { Write-McbNote "Keeping your existing settings in $configDir" }

    Write-Host ''
    Write-Host 'All done. The Bridge is installed.' -ForegroundColor Green
    if ($onWindows) { Write-Host 'Next time, start it from "Mr Chartist Bridge" on your Desktop or in the Start menu.' }
    if ($NoStart) {
      Write-Host 'It was not started (MCB_NO_START). Use the shortcut when you are ready.'
      return
    }
    Write-Host ''
    Write-Host 'Starting the Bridge. Your browser will open the dashboard in a moment.'
    Write-Host 'Keep this window open while you use the Bridge. Close it (or press Ctrl+C) to stop the Bridge.'
    Write-Host ''
    Start-McbBridge -AppDir $app -ConfigDir $configDir -Node $node -Demo:$Demo
  } catch {
    Write-Host ''
    Write-Host 'Sorry, the installer stopped:' -ForegroundColor Yellow
    Write-Host "  $($_.Exception.Message)"
    Write-Host ''
    Write-Host 'Nothing in your settings or data was changed. Fix the problem above if you can and run the installer again.'
    Write-Host 'If it keeps failing, open an issue at https://github.com/MrChartist/api-bridge/issues with the message above.'
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    if ($ExitOnFailure) { exit 1 }
  } finally {
    if ($restoreCliName) { $env:MCB_CLI_NAME = $oldCliName }
  }
}

Install-McBridge -ExitOnFailure:([bool]$MyInvocation.MyCommand.Path) @args
