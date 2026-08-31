param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$rootPath = (Resolve-Path -LiteralPath $Root).Path
$batch = Join-Path $rootPath 'start-rpgmap.bat'
if (-not (Test-Path -LiteralPath $batch -PathType Leaf)) {
  throw "Packaged launcher is missing: $batch"
}

function Clear-RpgMapSmokeState {
  Remove-Item -LiteralPath (Join-Path $rootPath 'map\world.json'), (Join-Path $rootPath 'map\users.json') -Force -ErrorAction SilentlyContinue
  foreach ($relative in @('map\backups', 'map\uploads')) {
    $directory = Join-Path $rootPath $relative
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
    Get-ChildItem -LiteralPath $directory -File -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    }
  }
}

Clear-RpgMapSmokeState

# Reserve an ephemeral loopback port instead of assuming 30000 is free on the
# hosted Windows image. The listener is released immediately before launch.
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
$listener.Stop()

$env:RPGMAP_NO_BROWSER = '1'
$env:RPGMAP_NO_PAUSE = '1'
$env:PORT = [string]$port
$env:RPGMAP_WORLD_ID = "ci-$([Guid]::NewGuid().ToString('N'))"

$logRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$stdout = Join-Path $logRoot "rpgmap-smoke-$PID.stdout.log"
$stderr = Join-Path $logRoot "rpgmap-smoke-$PID.stderr.log"
$serverPidFile = Join-Path $logRoot "rpgmap-smoke-$PID.server.pid"
$env:RPGMAP_SMOKE_PID_FILE = $serverPidFile
Remove-Item -LiteralPath $stdout, $stderr, $serverPidFile -Force -ErrorAction SilentlyContinue

Write-Host "[smoke] root: $rootPath"
Write-Host "[smoke] port: $port"
$processArgs = @{
  FilePath = 'cmd.exe'
  ArgumentList = @('/D', '/S', '/C', 'start-rpgmap.bat')
  WorkingDirectory = $rootPath
  PassThru = $true
  WindowStyle = 'Hidden'
  RedirectStandardOutput = $stdout
  RedirectStandardError = $stderr
}
$launcher = Start-Process @processArgs

function Show-RpgMapSmokeLogs {
  Write-Host '--- RPGmap launcher stdout ---'
  if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue | Write-Host }
  else { Write-Host '(no stdout log)' }
  Write-Host '--- RPGmap launcher stderr ---'
  if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue | Write-Host }
  else { Write-Host '(no stderr log)' }
  Write-Host '--- end RPGmap launcher logs ---'
}

try {
  $health = $null
  $lastRequestError = $null
  $browserAttempted = $false
  $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(5, $TimeoutSeconds))
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($launcher.HasExited) { break }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
      if (
        $health.status -eq 'ok' -and
        $health.app -eq 'RPGmap' -and
        $health.multiplayer.enabled -eq $true -and
        $health.multiplayer.publicMode -eq $false
      ) {
        Write-Host "[smoke] /api/health passed on port $port"
        $launcherOutput = if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Raw } else { '' }
        $secretMatch = [regex]::Match($launcherOutput, 'GM Secret\s+:\s+([A-Fa-f0-9]+)')
        if (-not $secretMatch.Success) { throw 'Packaged launcher did not publish a GM Secret for smoke.' }
        $smokeGmSecret = $secretMatch.Groups[1].Value
        $joinMatch = [regex]::Match($launcherOutput, 'Join Code\s+:\s+(\d{6})')
        if (-not $joinMatch.Success) { throw 'Packaged launcher did not publish a Join Code for smoke.' }
        $smokeJoinCode = $joinMatch.Groups[1].Value
        $hostUrl = "http://127.0.0.1:$port/#rpgmap-host=1&gmSecret=$smokeGmSecret"
        Write-Host '[smoke] opening World Manager and Lanzhou Runtime in Edge'
        $browserAttempted = $true
        & node (Join-Path $PSScriptRoot 'browser-smoke.mjs') $hostUrl ($TimeoutSeconds * 1000)
        if ($LASTEXITCODE -ne 0) { throw 'Packaged Edge browser smoke failed.' }
        Write-Host '[smoke] World Manager and Lanzhou Runtime passed'
        Write-Host '[smoke] validating LAN identity, projection, vision and fog authority'
        & node (Join-Path $PSScriptRoot 'lan-vision-smoke.mjs') "http://127.0.0.1:$port" $smokeGmSecret $smokeJoinCode
        if ($LASTEXITCODE -ne 0) { throw 'Packaged LAN vision smoke failed.' }
        & node (Join-Path $PSScriptRoot 'browser-smoke.mjs') $hostUrl ($TimeoutSeconds * 1000) fog
        if ($LASTEXITCODE -ne 0) { throw 'Packaged Fog Canvas browser smoke failed.' }
        Write-Host '[smoke] LAN projection and Fog Canvas passed'
        return
      }
    } catch {
      if ($browserAttempted) { throw }
      $lastRequestError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 250
  }

  Show-RpgMapSmokeLogs
  if ($launcher.HasExited) {
    throw "Packaged launcher exited before /api/health became ready (exit code $($launcher.ExitCode))."
  }
  $detail = if ($lastRequestError) { " Last health error: $lastRequestError" } else { '' }
  throw "Packaged server did not pass /api/health within $TimeoutSeconds seconds on port $port.$detail"
} finally {
  if (Test-Path -LiteralPath $serverPidFile) {
    $serverPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $serverPidFile -Raw).Trim(), [ref]$serverPid)) {
      Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
    }
  }
  if ($launcher -and -not $launcher.HasExited) {
    Wait-Process -Id $launcher.Id -Timeout 5 -ErrorAction SilentlyContinue
    $launcher.Refresh()
    if (-not $launcher.HasExited) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $stdout, $stderr, $serverPidFile -Force -ErrorAction SilentlyContinue
  Clear-RpgMapSmokeState
}
