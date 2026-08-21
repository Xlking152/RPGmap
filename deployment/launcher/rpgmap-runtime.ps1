$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {}

try { $Host.UI.RawUI.WindowTitle = 'RPGmap Runtime' } catch {}

$launcherDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $launcherDir
$launcherScript = Join-Path $launcherDir 'launcher.mjs'

function Find-RPGmapNode {
    $portableNode = Join-Path $root 'tools\node\node.exe'
    if (Test-Path $portableNode) { return $portableNode }

    $rootNode = Join-Path $root 'node.exe'
    if (Test-Path $rootNode) { return $rootNode }

    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

Clear-Host
Write-Host '============================================================'
Write-Host '                    RPGmap Runtime'
Write-Host '============================================================'
Write-Host '  This window hosts the RPGmap Web Launcher.'
Write-Host '  Keep it open while using RPGmap; it can be minimized.'
Write-Host '  GM controls remain in the browser Launcher.'
Write-Host '============================================================'
Write-Host ''

if (-not (Test-Path $launcherScript)) {
    Write-Host '[ERROR] launcher\launcher.mjs was not found.' -ForegroundColor Red
    Write-Host 'Please fully extract the RPGmap ZIP before starting it.'
    Write-Host ''
    Read-Host 'Press Enter to close'
    exit 2
}

$node = Find-RPGmapNode
if (-not $node) {
    Write-Host '[ERROR] Node.js was not found.' -ForegroundColor Red
    Write-Host 'RPGmap requires Node.js 20.19+ or 22.12+.'
    Write-Host ''
    Write-Host 'Install Node.js, then run RPGmap.bat again.'
    Write-Host ''
    Read-Host 'Press Enter to close'
    exit 1
}

$startupLog = Join-Path $root 'launcher-startup.log'
@(
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] RPGmap Runtime bootstrap",
    "Node: $node",
    "Launcher: $launcherScript"
) | Set-Content -Path $startupLog -Encoding UTF8

Write-Host "Node      : $node"
Write-Host "Package   : $root"
Write-Host "Start info: $startupLog"
Write-Host ''
Write-Host 'Starting Web Launcher...'
Write-Host ''

Push-Location $root
try {
    & $node $launcherScript
    $exitCode = $LASTEXITCODE
} catch {
    Write-Host ''
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 3
} finally {
    Pop-Location
}

if ($null -eq $exitCode) { $exitCode = 0 }
if ($exitCode -ne 0) {
    Write-Host ''
    Write-Host "[ERROR] RPGmap Launcher stopped unexpectedly. Exit code: $exitCode" -ForegroundColor Red
    Write-Host 'You can also test manually from the RPGmap folder:'
    Write-Host '  node launcher\launcher.mjs'
    Write-Host ''
    Read-Host 'Press Enter to close'
}

exit $exitCode
