# Causyne Agent installer for Windows PowerShell.
# Usage: irm https://causyne.com/install.ps1 | iex
$ErrorActionPreference = 'Stop'

if (($PSVersionTable.PSVersion.Major -ge 6) -and ($IsMacOS -or $IsLinux)) {
    Write-Host '  Detected Unix environment in PowerShell; delegating to Unix installer...'
    & bash -c 'curl -fsSL https://causyne.com/install.sh | bash'
    return
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {}

$Package = '@causyne/agent@latest'
$InstallRoot = Join-Path $HOME '.causyne\installation'
$RuntimeRoot = Join-Path $HOME '.causyne\runtime'
$BinDir = Join-Path $HOME '.local\bin'
$MinimumNodeMajor = 24

function Get-NodeMajor {
    param([string]$NodeExe = 'node')
    try {
        $ver = (& $NodeExe --version 2>$null)
        if (-not $ver) { return 0 }
        return [int]($ver.Trim().TrimStart('v').Split('.')[0])
    } catch {
        return 0
    }
}

function Find-ExistingNode {
    $privateNode = Join-Path $RuntimeRoot 'node\node.exe'
    if ((Test-Path $privateNode) -and ((Get-NodeMajor $privateNode) -ge $MinimumNodeMajor)) {
        $privateDir = Split-Path -Parent $privateNode
        $env:Path = "$privateDir;$env:Path"
        return $true
    }
    if ((Get-NodeMajor 'node') -ge $MinimumNodeMajor) {
        return $true
    }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    if ($env:NVM_SYMLINK) {
        $candidates += (Join-Path $env:NVM_SYMLINK 'node.exe')
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate) -and ((Get-NodeMajor $candidate) -ge $MinimumNodeMajor)) {
            $dir = Split-Path -Parent $candidate
            $env:Path = "$dir;$env:Path"
            return $true
        }
    }
    return $false
}

function Install-PrivateNode {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
    $distBase = "https://nodejs.org/dist/latest-v$MinimumNodeMajor.x"
    Write-Host "  Node.js $MinimumNodeMajor+ was not found; installing a private runtime (win-$arch)..."

    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("causyne-node-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        $shasumsText = [string](Invoke-RestMethod -Uri "$distBase/SHASUMS256.txt" -UseBasicParsing)
        $pattern = "([0-9a-fA-F]{64})\s+(node-v$MinimumNodeMajor\.[0-9]+\.[0-9]+-win-$arch\.zip)"
        $match = [regex]::Match($shasumsText, $pattern)
        if (-not $match.Success) {
            throw "Could not resolve a compatible Node.js archive for win-$arch."
        }
        $expectedHash = $match.Groups[1].Value.ToLowerInvariant()
        $archiveName = $match.Groups[2].Value
        $zipPath = Join-Path $tempDir $archiveName

        Invoke-WebRequest -Uri "$distBase/$archiveName" -OutFile $zipPath -UseBasicParsing
        $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw 'Node.js checksum verification failed.'
        }

        $extractDir = Join-Path $tempDir 'extracted'
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
        $folderName = [System.IO.Path]::GetFileNameWithoutExtension($archiveName)
        $extractedNode = Join-Path $extractDir $folderName

        New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
        $targetNode = Join-Path $RuntimeRoot 'node'
        if (Test-Path $targetNode) {
            Remove-Item -Path $targetNode -Recurse -Force
        }
        Move-Item -Path $extractedNode -Destination $targetNode -Force
        $env:Path = "$targetNode;$env:Path"
    } finally {
        $ProgressPreference = $prevProgress
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Install-NodeIfNeeded {
    if (Find-ExistingNode) { return }
    try {
        Install-PrivateNode
        if ((Get-NodeMajor 'node') -ge $MinimumNodeMajor) { return }
    } catch {
        Write-Host "  Private runtime download fallback: $($_.Exception.Message)"
    }
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host '  Installing Node.js with Windows Package Manager...'
        & winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements --silent
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    }
    if (-not (Find-ExistingNode)) {
        throw "Node.js $MinimumNodeMajor or newer is required. Install it from https://nodejs.org and run this installer again."
    }
}

function Register-CausynePath {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $BinDir) {
        $next = (@($parts) + $BinDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $next, 'User')
        Write-Host "  Added $BinDir to User PATH."
    }
    if (($env:Path -split ';') -notcontains $BinDir) {
        $env:Path = "$BinDir;$env:Path"
    }
}

Write-Host ''
Write-Host '  Causyne Agent installer'
Write-Host '  Detected Windows.'
Install-NodeIfNeeded

$ActiveNodeDir = Split-Path -Parent (Get-Command node).Source

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
Write-Host '  Installing Causyne Agent from the public npm registry...'

$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& npm.cmd install --global --prefix $InstallRoot $Package --ignore-scripts --no-audit --no-fund
$npmExit = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($npmExit -ne 0) {
    throw "npm install failed with exit code $npmExit"
}

$CmdWrapper = @"
@echo off
setlocal
if exist "%USERPROFILE%\.causyne\runtime\node\node.exe" (
  set "PATH=%USERPROFILE%\.causyne\runtime\node;%PATH%"
) else if exist "$ActiveNodeDir\node.exe" (
  set "PATH=$ActiveNodeDir;%PATH%"
)
set "CAUSYNE_INSTALL_ROOT=%USERPROFILE%\.causyne\installation"
set "CAUSYNE_NPM_COMMAND=npm.cmd"
if exist "%USERPROFILE%\.causyne\installation\node_modules\@causyne\agent\bin\causyne.js" (
  node "%USERPROFILE%\.causyne\installation\node_modules\@causyne\agent\bin\causyne.js" %*
) else (
  node "%USERPROFILE%\.causyne\installation\lib\node_modules\@causyne\agent\bin\causyne.js" %*
)
"@
foreach ($wrapperName in @('causyne.cmd', 'causyne-agent.cmd', 'causyne', 'causyne-agent')) {
    $wrapperPath = Join-Path $BinDir $wrapperName
    if (Test-Path $wrapperPath) {
        Remove-Item -Path $wrapperPath -Force -ErrorAction SilentlyContinue
    }
}
Set-Content -Path (Join-Path $BinDir 'causyne.cmd') -Value $CmdWrapper -Encoding Ascii
Set-Content -Path (Join-Path $BinDir 'causyne-agent.cmd') -Value $CmdWrapper -Encoding Ascii

$ShWrapper = @"
#!/bin/sh
INSTALL_ROOT="`$HOME/.causyne/installation"
if [ -f "`$HOME/.causyne/runtime/node/node.exe" ]; then
  export PATH="`$HOME/.causyne/runtime/node:`$PATH"
fi
export CAUSYNE_INSTALL_ROOT="`$INSTALL_ROOT"
export CAUSYNE_NPM_COMMAND="npm.cmd"
if [ -f "`$INSTALL_ROOT/node_modules/@causyne/agent/bin/causyne.js" ]; then
  exec node "`$INSTALL_ROOT/node_modules/@causyne/agent/bin/causyne.js" "`$@"
else
  exec node "`$INSTALL_ROOT/lib/node_modules/@causyne/agent/bin/causyne.js" "`$@"
fi
"@ -replace "`r`n", "`n"
[System.IO.File]::WriteAllText((Join-Path $BinDir 'causyne'), $ShWrapper, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $BinDir 'causyne-agent'), $ShWrapper, (New-Object System.Text.UTF8Encoding($false)))

Register-CausynePath

$Version = & (Join-Path $BinDir 'causyne.cmd') --version
Write-Host ''
Write-Host "  Causyne Agent $Version installed."
Write-Host '  Run `causyne` in your project directory to start.'
Write-Host '  The first run opens the foreground local CLI menu.'
Write-Host ''
