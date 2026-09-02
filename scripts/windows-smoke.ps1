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

function Invoke-RpgMapBrowserSmoke {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url,
    [ValidateSet('bootstrap', 'fog')]
    [string]$Mode = 'bootstrap'
  )

  for ($attempt = 1; $attempt -le 2; $attempt++) {
    if ($Mode -eq 'fog') {
      & node (Join-Path $PSScriptRoot 'browser-smoke.mjs') $Url ($TimeoutSeconds * 1000) fog
    } else {
      & node (Join-Path $PSScriptRoot 'browser-smoke.mjs') $Url ($TimeoutSeconds * 1000)
    }
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -lt 2) {
      Write-Warning "Packaged Edge $Mode smoke failed on attempt $attempt; retrying once with a fresh profile."
      Start-Sleep -Seconds 2
    }
  }

  throw "Packaged Edge $Mode smoke failed after 2 attempts."
}

function Invoke-RpgMapSheetBrowserSmoke {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  for ($attempt = 1; $attempt -le 2; $attempt++) {
    & node (Join-Path $PSScriptRoot 'sheet-browser-smoke.mjs') $Url ([Math]::Max(45000, $TimeoutSeconds * 1000))
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -lt 2) {
      Write-Warning "Packaged Edge Actor-sheet interaction smoke failed on attempt $attempt; retrying once with a fresh profile."
      Start-Sleep -Seconds 2
    }
  }

  throw 'Packaged Edge Actor-sheet interaction smoke failed after 2 attempts.'
}

function Invoke-RpgMapSheetFinalBrowserSmoke {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  for ($attempt = 1; $attempt -le 2; $attempt++) {
    & node (Join-Path $PSScriptRoot 'sheet-browser-final-v2-smoke.mjs') $Url ([Math]::Max(45000, $TimeoutSeconds * 1000))
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -lt 2) {
      Write-Warning "Packaged Edge Character/NPC final smoke failed on attempt $attempt; retrying once with a fresh profile."
      Start-Sleep -Seconds 2
    }
  }

  throw 'Packaged Edge Character/NPC final smoke failed after 2 attempts.'
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
        Invoke-RpgMapBrowserSmoke -Url $hostUrl
        Write-Host '[smoke] World Manager and Lanzhou Runtime passed'
        Write-Host '[smoke] validating live multi-window Actor/Monster sheet interactions'
        Invoke-RpgMapSheetBrowserSmoke -Url $hostUrl
        Write-Host '[smoke] live Actor sheet window isolation, Health, Status and Play/Edit passed'
        Write-Host '[smoke] validating Character/NPC Linked/Unlinked cards and resize persistence'
        Invoke-RpgMapSheetFinalBrowserSmoke -Url $hostUrl
        Write-Host '[smoke] Character/NPC card defaults, linked Health and resize persistence passed'
        Write-Host '[smoke] validating LAN identity, projection, vision and fog authority'
        & node (Join-Path $PSScriptRoot 'lan-vision-smoke.mjs') "http://127.0.0.1:$port" $smokeGmSecret $smokeJoinCode
        if ($LASTEXITCODE -ne 0) { throw 'Packaged LAN vision smoke failed.' }
        Invoke-RpgMapBrowserSmoke -Url $hostUrl -Mode fog
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
