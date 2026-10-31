# Mr. Chartist API Bridge: shared helpers for the Windows scripts (install.ps1, launch-windows.ps1, start-windows.bat).
# Dot-source it, then call Initialize-McbNode -AppDir <folder>. That uses the Node.js already on this computer when it
# is version 22 or newer; otherwise it downloads a private Node.js 22 LTS from nodejs.org into <folder>\runtime, checks
# it against the SHA-256 list nodejs.org publishes and puts it first on PATH for this window only. No admin rights.
# Must run on Windows PowerShell 5.1 and PowerShell 7: no ??, no ternary, no && or ||. Keep this file ASCII
# (5.1 reads files without a byte-order mark as ANSI). Defines functions only; running it does nothing else.

function Test-McbWindows {
  # $IsWindows exists only on PowerShell 6+; Windows PowerShell 5.1 only ever runs on Windows.
  if ($PSVersionTable.PSVersion.Major -lt 6) { return $true }
  return [bool]$IsWindows
}

function Join-McbPath {
  # Join-Path with any number of parts (5.1 has no -AdditionalChildPath).
  $p = [string]$args[0]
  for ($i = 1; $i -lt $args.Count; $i++) { $p = Join-Path $p ([string]$args[$i]) }
  return $p
}

function Get-McbFullPath([string]$Path) {
  # An absolute path, resolved against the PowerShell location (.NET calls use the process folder instead).
  return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

function Write-McbNote([string]$Text) { Write-Host "      $Text" }

function Get-McbUserDir {
  # Where the Bridge keeps settings and data when it is installed: the same rule as userBridgeDir() in
  # server/bridge/core/config.mjs (MCB_HOME, else %APPDATA%\MrChartist\Bridge, else ~/.mc-bridge).
  if ($env:MCB_HOME) { return (Get-McbFullPath $env:MCB_HOME) }
  if ((Test-McbWindows) -and $env:APPDATA) { return (Join-McbPath $env:APPDATA 'MrChartist' 'Bridge') }
  $h = $env:HOME
  if (-not $h) { $h = $env:USERPROFILE }
  return (Join-Path $h '.mc-bridge')
}

function Enable-McbTls12 {
  # Windows PowerShell 5.1 may still default to TLS 1.0, which nodejs.org and GitHub refuse.
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }
}

function Invoke-McbDownload {
  param([Parameter(Mandatory = $true)][string]$Uri, [Parameter(Mandatory = $true)][string]$OutFile, [string]$What = 'a file')
  Enable-McbTls12
  # The progress bar makes Invoke-WebRequest many times slower on 5.1.
  $ProgressPreference = 'SilentlyContinue'
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

function Expand-McbZip([string]$ZipPath, [string]$Destination) {
  # ZipFile is much faster than Expand-Archive on 5.1 (Node.js is thousands of small files).
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    [System.IO.Compression.ZipFile]::ExtractToDirectory((Get-McbFullPath $ZipPath), (Get-McbFullPath $Destination))
  } catch {
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    $ProgressPreference = 'SilentlyContinue'
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
  }
}

function Get-McbNodeArch {
  # Node.js builds for 64-bit Windows: x64 or arm64. $null on 32-bit Windows, which Node.js 22 does not support.
  try {
    $os = [string][System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    if ($os -eq 'X64') { return 'x64' }
    if ($os -eq 'Arm64') { return 'arm64' }
  } catch { }
  # 32-bit PowerShell on 64-bit Windows reports the real machine in PROCESSOR_ARCHITEW6432.
  $a = $env:PROCESSOR_ARCHITEW6432
  if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
  if ($a -eq 'AMD64') { return 'x64' }
  if ($a -eq 'ARM64') { return 'arm64' }
  return $null
}

function Select-McbNodeRelease {
  # The newest Node.js release of one major line that has a build for this computer, from nodejs.org/dist/index.json.
  # Pass the JSON text (-IndexJson) or a saved copy (-IndexPath), so this works offline in tests. Returns e.g. "v22.21.1".
  param([string]$IndexJson, [string]$IndexPath, [int]$Major = 22, [string]$FileKey = 'win-x64-zip')
  if ($IndexPath) { $IndexJson = Get-Content -LiteralPath $IndexPath -Raw }
  if (-not $IndexJson) { throw 'The Node.js release list is empty.' }
  $releases = ConvertFrom-Json -InputObject $IndexJson
  $best = $null
  $bestVersion = $null
  foreach ($r in $releases) {
    $v = [string]$r.version
    if ($v -notmatch '^v(\d+)\.(\d+)\.(\d+)$') { continue }
    if ([int]$Matches[1] -ne $Major) { continue }
    if (@($r.files) -notcontains $FileKey) { continue }
    $parsed = New-Object System.Version ([int]$Matches[1]), ([int]$Matches[2]), ([int]$Matches[3])
    if ($null -eq $bestVersion -or $parsed -gt $bestVersion) {
      $bestVersion = $parsed
      $best = $v
    }
  }
  if (-not $best) { throw "No Node.js $Major release for this computer ($FileKey) was found on nodejs.org." }
  return $best
}

function Get-McbExpectedSha256([string]$ShasumsText, [string]$FileName) {
  # One line of SHASUMS256.txt is "<sha256>  <file name>".
  foreach ($line in ($ShasumsText -split "`r?`n")) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -eq 2 -and $parts[1] -eq $FileName -and $parts[0] -match '^[0-9a-fA-F]{64}$') { return $parts[0].ToLowerInvariant() }
  }
  return $null
}

function Save-McbNodeArchive {
  # Downloads one Node.js release file into -Folder and checks its SHA-256 against nodejs.org's list for that release.
  # Returns the path of the checked file; a file that does not match is deleted and never used.
  param([Parameter(Mandatory = $true)][string]$Version, [Parameter(Mandatory = $true)][string]$FileName,
    [Parameter(Mandatory = $true)][string]$Folder, [string]$BaseUrl = 'https://nodejs.org/dist')
  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  $sumsFile = Join-Path $Folder 'SHASUMS256.txt'
  $archive = Join-Path $Folder $FileName
  Invoke-McbDownload -Uri "$BaseUrl/$Version/SHASUMS256.txt" -OutFile $sumsFile -What 'the Node.js checksum list'
  $expected = Get-McbExpectedSha256 -ShasumsText (Get-Content -LiteralPath $sumsFile -Raw) -FileName $FileName
  if (-not $expected) { throw "nodejs.org does not list a checksum for $FileName, so it was not downloaded." }
  Invoke-McbDownload -Uri "$BaseUrl/$Version/$FileName" -OutFile $archive -What 'Node.js'
  $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    throw 'The Node.js download did not pass its safety check (its checksum does not match nodejs.org), so it was not used. Please try again later.'
  }
  return $archive
}

function Install-McbNodeRuntime {
  # Puts a checked private Node.js 22 into <AppDir>\runtime (node.exe, npm.cmd). Replaces an older private copy.
  param([Parameter(Mandatory = $true)][string]$AppDir, [string]$Arch, [string]$IndexPath, [string]$BaseUrl = 'https://nodejs.org/dist')
  if ($env:MCB_NODE_MIRROR) { $BaseUrl = $env:MCB_NODE_MIRROR.TrimEnd('/') }
  if (-not $Arch) { $Arch = Get-McbNodeArch }
  if (-not $Arch) { throw 'This looks like 32-bit Windows. The Bridge needs 64-bit Windows 10 or 11.' }
  $AppDir = Get-McbFullPath $AppDir
  # Short folder names: some files inside Node.js have long paths and Windows has a 260-character limit.
  $work = Join-Path $AppDir 'rt-dl'
  $unpack = Join-Path $AppDir 'rt-new'
  $runtime = Join-Path $AppDir 'runtime'
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  try {
    if (-not $IndexPath) {
      $IndexPath = Join-Path $work 'index.json'
      Invoke-McbDownload -Uri "$BaseUrl/index.json" -OutFile $IndexPath -What 'the Node.js release list'
    }
    $version = Select-McbNodeRelease -IndexPath $IndexPath -Major 22 -FileKey "win-$Arch-zip"
    $fileName = "node-$version-win-$Arch.zip"
    Write-McbNote "Downloading Node.js $version (about 30 MB, only the first time)..."
    $archive = Save-McbNodeArchive -Version $version -FileName $fileName -Folder $work -BaseUrl $BaseUrl
    Write-McbNote 'Download checked against nodejs.org. Unpacking...'
    Expand-McbZip -ZipPath $archive -Destination $unpack
    $inner = Join-Path $unpack "node-$version-win-$Arch"
    if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe'))) { throw 'The Node.js download did not contain node.exe.' }
    if (Test-Path -LiteralPath $runtime) {
      try { Remove-Item -LiteralPath $runtime -Recurse -Force -ErrorAction Stop }
      catch { throw "Could not replace $runtime because it is in use. Close the Bridge window and try again." }
    }
    Move-Item -LiteralPath $inner -Destination $runtime
    return $runtime
  } finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $unpack) { Remove-Item -LiteralPath $unpack -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Get-McbNodeMajor([string]$NodeExe) {
  # The major version of a node executable, or 0 when it does not run.
  $ErrorActionPreference = 'Continue'
  try { $out = & $NodeExe -p 'process.versions.node' 2>$null } catch { return 0 }
  if ($LASTEXITCODE -ne 0) { return 0 }
  $m = [regex]::Match(([string]($out | Select-Object -First 1)).Trim(), '^(\d+)\.')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return 0
}

function Add-McbPathFront([string]$Dir) {
  # For this window (and the programs it starts) only; nothing is changed for the rest of Windows.
  $sep = [IO.Path]::PathSeparator
  $parts = @($env:PATH -split [regex]::Escape([string]$sep) | Where-Object { $_ -and ($_.TrimEnd('\', '/') -ne $Dir.TrimEnd('\', '/')) })
  $env:PATH = (@($Dir) + $parts) -join $sep
}

function Initialize-McbNode {
  # Makes node and npm 22+ available. Returns @{ Node; Npm; Major; Source } where Source is "system" or "private".
  param([Parameter(Mandatory = $true)][string]$AppDir, [string]$Arch)
  $AppDir = Get-McbFullPath $AppDir
  $onWindows = Test-McbWindows
  $runtime = Join-Path $AppDir 'runtime'
  $found = 0

  $sys = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($sys -and ($sys.Source -notlike "$runtime*")) {
    $found = Get-McbNodeMajor $sys.Source
    if ($found -ge 22) {
      $npm = $null
      if ($onWindows) {
        # npm.cmd, never npm.ps1: Windows blocks .ps1 files by default and PowerShell would pick that one first.
        $npm = Join-Path (Split-Path -Parent $sys.Source) 'npm.cmd'
        if (-not (Test-Path -LiteralPath $npm)) {
          $c = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($c) { $npm = $c.Source } else { $npm = $null }
        }
      } else {
        $c = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { $npm = $c.Source }
      }
      if ($npm) {
        Write-McbNote "Using Node.js $found that is already on this computer."
        return [pscustomobject]@{ Node = $sys.Source; Npm = $npm; Major = $found; Source = 'system' }
      }
    }
  }

  if (-not $onWindows) {
    throw 'Node.js 22 or newer is needed. This script downloads it only on Windows; on macOS or Linux use install.sh, or install Node.js 22 LTS from https://nodejs.org/.'
  }

  $privateNode = Join-Path $runtime 'node.exe'
  if (-not ((Test-Path -LiteralPath $privateNode) -and ((Get-McbNodeMajor $privateNode) -ge 22))) {
    if ($found -gt 0) { Write-McbNote "This computer has Node.js $found, which is too old for the Bridge (it needs 22 or newer)." }
    Write-McbNote 'Getting a private copy of Node.js just for the Bridge. Nothing else on this computer changes.'
    Install-McbNodeRuntime -AppDir $AppDir -Arch $Arch | Out-Null
  }
  $major = Get-McbNodeMajor $privateNode
  if ($major -lt 22) { throw "The Node.js in $runtime does not start. Delete that folder and try again." }
  Add-McbPathFront $runtime
  Write-McbNote "Using the Bridge's own Node.js $major."
  return [pscustomobject]@{ Node = $privateNode; Npm = (Join-Path $runtime 'npm.cmd'); Major = $major; Source = 'private' }
}

function Get-McbLockStamp([string]$AppDir) {
  # The SHA-256 of package-lock.json, written next to node_modules after a good install, so an updated copy reinstalls.
  $lock = Join-Path $AppDir 'package-lock.json'
  if (-not (Test-Path -LiteralPath $lock)) { return 'no-lockfile' }
  return (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash
}

function Test-McbPackagesCurrent([string]$AppDir) {
  $stamp = Join-McbPath $AppDir 'node_modules' '.mcb-installed'
  if (-not (Test-Path -LiteralPath $stamp)) { return $false }
  return ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq (Get-McbLockStamp $AppDir))
}

function Install-McbPackages {
  # npm ci --omit=dev (exactly what package-lock.json says), falling back to npm install. Output goes to the screen.
  param([Parameter(Mandatory = $true)][string]$AppDir, [Parameter(Mandatory = $true)]$Node)
  $AppDir = Get-McbFullPath $AppDir
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $AppDir -ErrorAction Stop
  try {
    & $Node.Npm ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      Write-McbNote 'That did not work; trying once more another way...'
      & $Node.Npm install --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) {
        throw "Installing the Bridge's parts did not work. Check your internet connection and try again. If you use a proxy or a company network, it may block npm."
      }
    }
  } finally { Pop-Location }
  $ErrorActionPreference = 'Stop'
  New-Item -ItemType Directory -Force -Path (Join-Path $AppDir 'node_modules') | Out-Null
  Set-Content -LiteralPath (Join-McbPath $AppDir 'node_modules' '.mcb-installed') -Value (Get-McbLockStamp $AppDir) -Encoding Ascii
}

function Initialize-McbConfig {
  # First setup without questions (mc-bridge init --yes) when <ConfigDir>\bridge.config.json does not exist yet.
  # Returns $true when it created one. Never touches an existing config.
  param([Parameter(Mandatory = $true)][string]$AppDir, [Parameter(Mandatory = $true)][string]$ConfigDir,
    [Parameter(Mandatory = $true)]$Node, [switch]$Demo)
  $ConfigDir = Get-McbFullPath $ConfigDir
  $config = Join-Path $ConfigDir 'bridge.config.json'
  if (Test-Path -LiteralPath $config) { return $false }
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  $cliArgs = @((Join-McbPath (Get-McbFullPath $AppDir) 'bin' 'mc-bridge.mjs'), 'init', '--yes', '--config', $config)
  if ($Demo) { $cliArgs += '--demo' }
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $ConfigDir -ErrorAction Stop
  try {
    & $Node.Node @cliArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The first-time setup did not finish. Read the message above, then try again.' }
  } finally { Pop-Location }
  return $true
}

function Start-McbBridge {
  # Runs the Bridge in this window and opens the dashboard (already signed in). Call it as a statement, not
  # $x = Start-McbBridge, so the Bridge writes straight to the window; afterwards $LASTEXITCODE is its exit code.
  param([Parameter(Mandatory = $true)][string]$AppDir, [Parameter(Mandatory = $true)][string]$ConfigDir,
    [Parameter(Mandatory = $true)]$Node, [switch]$Demo)
  $ConfigDir = Get-McbFullPath $ConfigDir
  $cliArgs = @((Join-McbPath (Get-McbFullPath $AppDir) 'bin' 'mc-bridge.mjs'), 'start', '--open', '--config', (Join-Path $ConfigDir 'bridge.config.json'))
  if ($Demo) { $cliArgs += '--demo' }
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $ConfigDir -ErrorAction Stop
  try {
    & $Node.Node @cliArgs
  } finally { Pop-Location }
}
