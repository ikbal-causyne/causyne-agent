# Causyne Agent installer for Windows PowerShell.
# Usage: irm https://causyne.com/install.ps1 | iex
$ErrorActionPreference = 'Stop'

$Package = '@causyne/agent@latest'
$InstallRoot = Join-Path $HOME '.causyne\installation'
$BinDir = Join-Path $HOME '.local\bin'
$MinimumNodeMajor = 24

function Get-NodeMajor {
    try { return [int]((& node --version).TrimStart('v').Split('.')[0]) } catch { return 0 }
}

function Install-NodeIfNeeded {
    if ((Get-NodeMajor) -ge $MinimumNodeMajor) { return }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Node.js 24 or newer is required. Install it from https://nodejs.org and run this installer again.'
    }
    Write-Host "  Installing Node.js LTS with Windows Package Manager..."
    & winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    if ((Get-NodeMajor) -lt $MinimumNodeMajor) { throw 'Node.js 24 or newer was not available after installation.' }
}

function Register-CausynePath {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $BinDir) {
        $next = (@($parts) + $BinDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $next, 'User')
    }
    if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$BinDir;$env:Path" }
}

Write-Host ''
Write-Host '  Causyne Agent installer'
Write-Host '  Detected Windows.'
Install-NodeIfNeeded

New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
Write-Host '  Installing Causyne Agent from the public npm registry...'
& npm.cmd install --global --prefix $InstallRoot $Package --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

$Wrapper = @"
@echo off
set "CAUSYNE_INSTALL_ROOT=%USERPROFILE%\.causyne\installation"
set "CAUSYNE_NPM_COMMAND=npm.cmd"
node "%USERPROFILE%\.causyne\installation\node_modules\@causyne\agent\bin\causyne.js" %*
"@
Set-Content -Path (Join-Path $BinDir 'causyne.cmd') -Value $Wrapper -Encoding Ascii
Set-Content -Path (Join-Path $BinDir 'causyne-agent.cmd') -Value $Wrapper -Encoding Ascii
Register-CausynePath

$Version = & (Join-Path $BinDir 'causyne.cmd') --version
Write-Host ''
Write-Host "  Causyne Agent $Version installed."
Write-Host '  Open a new terminal, move to your project, and run: causyne'
Write-Host '  The first run opens the foreground local CLI menu.'
Write-Host ''
