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
        Write-Host '[smoke] opening World Manager and Lanzhou Runtime in Edge'
        $browserAttempted = $true
        & node (Join-Path $PSScriptRoot 'browser-smoke.mjs') "http://127.0.0.1:$port/" ($TimeoutSeconds * 1000)
        if ($LASTEXITCODE -ne 0) { throw 'Packaged Edge browser smoke failed.' }
        Write-Host '[smoke] World Manager and Lanzhou Runtime passed'
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
}
