param(
  [string]$Installer = '',
  [string]$Map = ''
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = Join-Path $taskRoot 'artifact'
$applicationVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
$installDirectory = [IO.Path]::GetFullPath((Join-Path $artifactRoot 'desktop-install-smoke/program'))
if (-not $installDirectory.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test installation directory.' }
if (-not $Installer) { $Installer = Join-Path $artifactRoot ('desktop/RPGmap-Setup-' + $applicationVersion + '.exe') }
if (-not $Map) {
  $mapCandidates = @((Join-Path $artifactRoot 'content-packages/北宋兰州城-1.1.0.rpgmap'), (Join-Path $taskRoot ('release/RPGmap-v' + $applicationVersion + '/Lanzhou-1.1.0.rpgmap')))
  $Map = $mapCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $Map) { throw 'No release map package found. Supply -Map explicitly.' }
}
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$Map = (Resolve-Path -LiteralPath $Map).Path
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\44512149-81ce-5f49-845b-bb30cdfa714c'
if (Test-Path -LiteralPath $uninstallKey) { throw 'An RPGmap installation is already registered. Uninstall the previous test installation first; this test never replaces an existing user installation.' }
$evidenceDirectory = Join-Path $artifactRoot 'desktop-smoke/evidence'
$dataDirectory = Join-Path $artifactRoot 'desktop-smoke/UserData'
$findings = [Collections.Generic.List[object]]::new()
$program = Join-Path $installDirectory 'RPGmap.exe'
$uninstaller = Join-Path $installDirectory 'Uninstall RPGmap.exe'

function Invoke-TestInstaller {
  $process = Start-Process -FilePath $Installer -ArgumentList @('/S', ('/D=' + $installDirectory)) -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $program)) { throw "Installer failed: $($process.ExitCode)" }
}
function Invoke-TestUninstaller {
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Test uninstaller missing.' }
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Uninstaller failed: $($process.ExitCode)" }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ((Test-Path -LiteralPath $program) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if ((Test-Path -LiteralPath $program) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Uninstaller did not remove the registered test program.' }
}
function Assert-Test([bool]$Condition, [string]$Name) {
  if (-not $Condition) { throw $Name }
  $findings.Add(@{ test = $Name; passed = $true })
}

Push-Location $taskRoot
try {
  New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null
  Remove-Item -LiteralPath (Join-Path $evidenceDirectory 'installer-smoke.json') -Force -ErrorAction SilentlyContinue
  Invoke-TestInstaller
  Assert-Test $true 'NSIS silent installation into the isolated program directory'
  $browserArguments = @('scripts/desktop-browser-smoke.mjs', ('--exe=' + $program), ('--map=' + $Map), ('--installer=' + $Installer))
  & node @browserArguments
  if ($LASTEXITCODE -ne 0) { throw 'Installed desktop browser smoke failed.' }
  $catalog = Get-Content -LiteralPath (Join-Path $dataDirectory 'config/catalog.json') -Raw | ConvertFrom-Json
  $worldFile = Join-Path $dataDirectory ('worlds/' + $catalog.activeWorldId + '/world.json')
  if (-not (Test-Path -LiteralPath $worldFile)) { throw 'The created World was not persisted.' }
  $worldHash = (Get-FileHash -LiteralPath $worldFile -Algorithm SHA256).Hash
  $usersFile = Join-Path $dataDirectory ('worlds/' + $catalog.activeWorldId + '/users.json')
  if (-not (Test-Path -LiteralPath $usersFile)) { throw 'The approved Player permissions were not persisted.' }
  $users = Get-Content -LiteralPath $usersFile -Raw | ConvertFrom-Json
  if (-not $users.users.Count) { throw 'The permissions fixture does not contain a Player.' }
  $usersHash = (Get-FileHash -LiteralPath $usersFile -Algorithm SHA256).Hash
  $contentHashes = @{}
  Get-ChildItem -LiteralPath (Join-Path $dataDirectory 'packages') -Recurse -File | ForEach-Object { $contentHashes[$_.FullName] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
  $canary = Join-Path $installDirectory 'resources/app/assets/obsolete-program-canary.js'
  [IO.File]::WriteAllText($canary, 'old program file owned by the test manifest')
  [IO.File]::AppendAllText((Join-Path $installDirectory 'resources/PROGRAM-FILES.txt'), "resources\app\assets\obsolete-program-canary.js`r`n")
  $userNote = Join-Path $installDirectory 'KEEP-USER-NOTE.txt'
  [IO.File]::WriteAllText($userNote, 'Unmanaged file must survive update and uninstall.')
  $recoveryRoot = Join-Path $env:LOCALAPPDATA 'RPGmap/ProgramRecovery'
  $previousRecovery = @(Get-ChildItem -LiteralPath $recoveryRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object Name)
  Invoke-TestInstaller
  Assert-Test (-not (Test-Path -LiteralPath $canary)) 'Same-version update removes obsolete manifest-owned files'
  Assert-Test (Test-Path -LiteralPath $userNote) 'Same-version update preserves unmanaged program-directory files'
  Assert-Test ((Get-FileHash -LiteralPath $worldFile -Algorithm SHA256).Hash -eq $worldHash) 'Same-version update preserves World bytes'
  Assert-Test ((Get-FileHash -LiteralPath $usersFile -Algorithm SHA256).Hash -eq $usersHash) 'Same-version update preserves approved Player permissions'
  foreach ($file in $contentHashes.Keys) { if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $contentHashes[$file]) { throw 'Installed content was changed by program update.' } }
  Assert-Test $true 'Same-version update preserves every installed content file hash'
  $newRecovery = @(Get-ChildItem -LiteralPath $recoveryRoot -Directory | Where-Object { $_.Name -notin $previousRecovery })
  Assert-Test ([bool]($newRecovery | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'resources/app/assets/obsolete-program-canary.js') })) 'Update makes a complete previous-program recovery copy before removal'
  Invoke-TestUninstaller
  Assert-Test (Test-Path -LiteralPath $userNote) 'Uninstall preserves unmanaged files'
  Assert-Test ((Get-FileHash -LiteralPath $worldFile -Algorithm SHA256).Hash -eq $worldHash) 'Uninstall preserves user World bytes'
  Assert-Test ((Get-FileHash -LiteralPath $usersFile -Algorithm SHA256).Hash -eq $usersHash) 'Uninstall preserves approved Player permissions'
  Invoke-TestInstaller
  & node scripts/desktop-browser-smoke.mjs ('--exe=' + $program) --reuse-data
  if ($LASTEXITCODE -ne 0) { throw 'Reinstalled desktop did not recover existing content.' }
  Assert-Test $true 'Reinstalled desktop reads the same installed map and active World'
  Assert-Test ((Get-FileHash -LiteralPath $usersFile -Algorithm SHA256).Hash -eq $usersHash) 'Reinstalled desktop preserves the same approved Player identities'
  Invoke-TestUninstaller
  Assert-Test $true 'Final test uninstall clears the temporary application registration'
  $record = @{ outcome = 'passed'; at = [DateTime]::UtcNow.ToString('o'); installer = $Installer; installerSha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant(); installDirectory = $installDirectory; dataDirectory = $dataDirectory; findings = $findings; limitations = @('Executed on the development Windows host, not a clean Windows VM.', 'Update uses the same application version; this is not a cross-version upgrade test.', 'An interrupted NSIS extraction and automatic program rollback were not tested.', 'System Node.js is used only to drive the test; the installed application runs its bundled Electron runtime.') }
  $record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'installer-smoke.json') -Encoding utf8
  $findings | ConvertTo-Json -Depth 5
} catch {
  @{ outcome = 'failed'; at = [DateTime]::UtcNow.ToString('o'); installer = $Installer; installerSha256 = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant(); findings = $findings; error = $_.Exception.Message } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'installer-smoke.json') -Encoding utf8
  throw
} finally { Pop-Location }
