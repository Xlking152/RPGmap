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

function Ensure-RPGmapMapMount {
    $appDir = Join-Path $root 'app'
    $mapsDir = Join-Path $root 'maps'
    $mount = Join-Path $appDir 'maps'

    if (-not (Test-Path $appDir)) { throw 'app\ directory was not found.' }
    if (-not (Test-Path $mapsDir)) { throw 'maps\ directory was not found.' }

    if (Test-Path $mount) {
        $existing = Get-Item -LiteralPath $mount -Force
        if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Remove-Item -LiteralPath $mount -Force
        } else {
            $backupName = 'maps.legacy-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
            $backupPath = Join-Path $appDir $backupName
            Move-Item -LiteralPath $mount -Destination $backupPath
            Write-Host "[Runtime] Existing app\maps was preserved as app\$backupName"
        }
    }

    New-Item -ItemType Junction -Path $mount -Target $mapsDir | Out-Null
    return $mount
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

try {
    $mapMount = Ensure-RPGmapMapMount
} catch {
    Write-Host "[ERROR] Failed to mount maps directory: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    Write-Host 'RPGmap keeps real map files in the package-root maps\ directory.'
    Write-Host 'The runtime creates app\maps as a Windows junction so the game server can serve those files.'
    Write-Host ''
    Read-Host 'Press Enter to close'
    exit 4
}

$startupLog = Join-Path $root 'launcher-startup.log'
@(
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] RPGmap Runtime bootstrap",
    "Node: $node",
    "Launcher: $launcherScript",
    "Maps: $(Join-Path $root 'maps')",
    "MapMount: $mapMount"
) | Set-Content -Path $startupLog -Encoding UTF8

Write-Host "Node      : $node"
Write-Host "Package   : $root"
Write-Host "Maps      : $(Join-Path $root 'maps')"
Write-Host "Map mount : $mapMount -> $(Join-Path $root 'maps')"
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
