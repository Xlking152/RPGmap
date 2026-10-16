param(
  [Parameter(Mandatory)][string]$Installer,
  [Parameter(Mandatory)][string]$Map,
  [Parameter(Mandatory)][string]$ExpectedInstallerSha256,
  [Parameter(Mandatory)][string]$ExpectedSourceCommit,
  [Parameter(Mandatory)][string]$PreviousInstaller,
  [Parameter(Mandatory)][string]$PreviousInstallerSha256,
  [Parameter(Mandatory)][string]$PreviousSourceCommit,
  [string]$UnpackedExecutable = '',
  [string]$LegacyDirectory = '',
  [string]$MinimalMap = ''
)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = Join-Path $taskRoot 'artifact'
$installDirectory = [IO.Path]::GetFullPath((Join-Path $artifactRoot 'desktop-install-smoke/program'))
$program = Join-Path $installDirectory 'RPGmap.exe'
$uninstaller = Join-Path $installDirectory 'Uninstall RPGmap.exe'
$dataDirectory = Join-Path $artifactRoot 'desktop-smoke/UserData'
$evidenceDirectory = Join-Path $artifactRoot 'desktop-smoke/evidence'
$registryLeaf = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\44512149-81ce-5f49-845b-bb30cdfa714c'
$uninstallKey = 'HKCU:\' + $registryLeaf
$registryKeys = @($uninstallKey, ('HKLM:\' + $registryLeaf), ('HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\44512149-81ce-5f49-845b-bb30cdfa714c'))
$findings = [Collections.Generic.List[object]]::new()
$previousExpectedSource = $env:RPGMAP_SMOKE_EXPECTED_SOURCE_COMMIT
$testInstallationStarted = $false
$completed = $false
$currentApplicationVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'package.json') -Raw | ConvertFrom-Json).version
$previousApplicationVersion = $null

function Assert-Acceptance([bool]$Condition, [string]$Description) {
  if (-not $Condition) { throw $Description }
  $findings.Add(@{ test = $Description; passed = $true })
}
function Assert-NoOtherDesktop {
  if (@(Get-Process -Name RPGmap -ErrorAction SilentlyContinue).Count) { throw 'An existing RPGmap process must remain untouched. Close it normally before running the isolated acceptance.' }
}
function Assert-OwnedDirectory {
  if (-not $installDirectory.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test installation target.' }
  foreach ($directory in @($artifactRoot, (Join-Path $artifactRoot 'desktop-install-smoke'), $installDirectory)) {
    if ((Test-Path -LiteralPath $directory) -and ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The acceptance program directory cannot follow a junction or symlink.' }
  }
}
function Assert-FileHash([string]$File, [string]$Expected) {
  if ($Expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'A frozen SHA-256 is required.' }
  if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $Expected) { throw 'Installer bytes differ from the supplied frozen SHA-256.' }
}
function Install-IntoTestDirectory([string]$File) {
  Assert-NoOtherDesktop
  Assert-OwnedDirectory
  $process = Start-Process -FilePath $File -ArgumentList @('/S', ('/D=' + $installDirectory)) -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $program)) { throw 'NSIS could not install the frozen candidate into the test directory.' }
  $script:testInstallationStarted = $true
}
function Remove-OwnedInstallation {
  Assert-NoOtherDesktop
  Assert-OwnedDirectory
  if (Test-Path -LiteralPath $uninstallKey) {
    $registration = Get-ItemProperty -LiteralPath $uninstallKey
    if ($registration.InstallLocation -and [IO.Path]::GetFullPath($registration.InstallLocation).TrimEnd('\') -ne $installDirectory.TrimEnd('\')) {
      throw 'Refusing cleanup: the current registry entry belongs to another installation.'
    }
    $registeredUninstaller = $null
    $uninstallCommand = [string]$registration.UninstallString
    if ($uninstallCommand -match '^"([^"]+)"(?:\s|$)') { $registeredUninstaller = $Matches[1] }
    elseif ($uninstallCommand -match '^(.+?\.exe)(?:\s|$)') { $registeredUninstaller = $Matches[1] }
    if (-not $registeredUninstaller -or [IO.Path]::GetFullPath($registeredUninstaller) -ne $uninstaller) {
      throw 'Refusing cleanup: the registered uninstaller does not belong to the verified test directory.'
    }
  }
  if (Test-Path -LiteralPath $uninstaller) {
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'The test uninstaller did not finish normally.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (((Test-Path -LiteralPath $program) -or (Test-Path -LiteralPath $uninstallKey)) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
  }
  if ((Test-Path -LiteralPath $program) -or (Test-Path -LiteralPath $uninstallKey)) { throw 'Temporary test installation registration was not cleared.' }
  $script:testInstallationStarted = $false
}
function Invoke-BrowserAcceptance([string]$Executable, [string]$Commit, [string[]]$ExtraArguments) {
  $env:RPGMAP_SMOKE_EXPECTED_SOURCE_COMMIT = $Commit
  $arguments = @('scripts/desktop-browser-smoke.mjs', ('--exe=' + $Executable), ('--expected-source=' + $Commit)) + $ExtraArguments
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Frozen executable browser acceptance failed; its failure evidence is preserved.' }
}
function Get-FixtureHashes {
  $hashes = @{}
  foreach ($directory in @((Join-Path $dataDirectory 'worlds'), (Join-Path $dataDirectory 'packages'))) {
    Get-ChildItem -LiteralPath $directory -Recurse -File | ForEach-Object {
      $relative = [IO.Path]::GetRelativePath($dataDirectory, $_.FullName)
      $hashes[$relative] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }
  }
  $catalogFile = Join-Path $dataDirectory 'config/catalog.json'
  $hashes['config/catalog.json'] = (Get-FileHash -LiteralPath $catalogFile -Algorithm SHA256).Hash
  return $hashes
}
function Assert-FixtureHashes([hashtable]$Before) {
  $after = Get-FixtureHashes
  if ($Before.Count -ne $after.Count) { throw 'Cross-version installer changed the fixture file set.' }
  foreach ($file in $Before.Keys) { if ($after[$file] -ne $Before[$file]) { throw 'Cross-version installer changed a World, permissions, package or catalogue file.' } }
}

Push-Location $taskRoot
try {
  Assert-OwnedDirectory
  foreach ($key in $registryKeys) { if (Test-Path -LiteralPath $key) { throw 'An RPGmap installation is already registered. This driver never replaces an existing user installation.' } }
  Assert-NoOtherDesktop
  $Installer = (Resolve-Path -LiteralPath $Installer).Path
  $Map = (Resolve-Path -LiteralPath $Map).Path
  $PreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstaller).Path
  if (-not $UnpackedExecutable) { $UnpackedExecutable = Join-Path $artifactRoot 'desktop/win-unpacked/RPGmap.exe' }
  $UnpackedExecutable = (Resolve-Path -LiteralPath $UnpackedExecutable).Path
  if ($ExpectedSourceCommit -notmatch '^[0-9a-fA-F]{40}$' -or $PreviousSourceCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'A full frozen source commit is required.' }
  Assert-FileHash $Installer $ExpectedInstallerSha256
  Assert-FileHash $PreviousInstaller $PreviousInstallerSha256
  New-Item -ItemType Directory -Path $evidenceDirectory -Force | Out-Null

  Install-IntoTestDirectory $PreviousInstaller
  $previousApplicationVersion = (Get-Content -LiteralPath (Join-Path $installDirectory 'resources/INSTALL-MANIFEST.json') -Raw | ConvertFrom-Json).version
  Invoke-BrowserAcceptance $program $PreviousSourceCommit @(('--map=' + $Map), '--prepare-upgrade-fixture')
  $fixtureHashes = Get-FixtureHashes
  $catalog = Get-Content -LiteralPath (Join-Path $dataDirectory 'config/catalog.json') -Raw | ConvertFrom-Json
  $fixtureUsersFile = Join-Path $dataDirectory ('worlds/' + $catalog.activeWorldId + '/users.json')
  $fixtureUsers = (Get-Content -LiteralPath $fixtureUsersFile -Raw | ConvertFrom-Json).users
  if (-not $fixtureUsers.Count) { throw 'The historical fixture must contain an approved Player identity.' }
  Install-IntoTestDirectory $Installer
  Assert-FixtureHashes $fixtureHashes
  Assert-Acceptance $true "Actual $previousApplicationVersion to $currentApplicationVersion installer upgrade preserves World, WAL, Player permissions, packages and catalogue bytes before the new runtime opens"
  Invoke-BrowserAcceptance $program $ExpectedSourceCommit @('--reuse-data', '--exercise-input', '--screenshots')
  $recoveredUsers = (Get-Content -LiteralPath $fixtureUsersFile -Raw | ConvertFrom-Json).users
  foreach ($user in $fixtureUsers) {
    $recovered = @($recoveredUsers | Where-Object { $_.id -eq $user.id })
    if ($recovered.Count -ne 1 -or ($recovered[0] | ConvertTo-Json -Depth 32 -Compress) -ne ($user | ConvertTo-Json -Depth 32 -Compress)) { throw 'An existing approved Player identity changed after RC.2 restart and first drag.' }
  }
  Assert-Acceptance $true "$currentApplicationVersion performs a real first Token drag and normal restart after cross-version upgrade while retaining the existing Player identity"
  Remove-OwnedInstallation

  $env:RPGMAP_SMOKE_EXPECTED_SOURCE_COMMIT = $ExpectedSourceCommit
  & (Join-Path $PSScriptRoot 'desktop-installer-smoke.ps1') -Installer $Installer -Map $Map
  Assert-Acceptance $true "$currentApplicationVersion clean installation, active update with normal shutdown, program cleanup, UserData preservation and uninstall/reinstall complete"
  if ($LegacyDirectory) {
    $legacyArguments = @(('--map=' + $Map), ('--legacy-directory=' + $LegacyDirectory), '--screenshots')
    if ($MinimalMap) { $legacyArguments += '--scene-audit'; $legacyArguments += ('--minimal-map=' + $MinimalMap) }
    Invoke-BrowserAcceptance $UnpackedExecutable $ExpectedSourceCommit $legacyArguments
    Assert-Acceptance $true 'Actual old data is copied through the formal import API into temporary UserData and the source inventory remains unchanged'
  }
  Assert-FileHash $Installer $ExpectedInstallerSha256
  Assert-NoOtherDesktop
  foreach ($key in $registryKeys) { if (Test-Path -LiteralPath $key) { throw 'Acceptance left an installation registered.' } }
  $completed = $true
} catch {
  $findings.Add(@{ test = 'Sequential frozen release acceptance'; passed = $false; error = $_.Exception.Message })
  throw
} finally {
  if ($testInstallationStarted -or (Test-Path -LiteralPath $uninstallKey)) {
    try { Remove-OwnedInstallation; $findings.Add(@{ test = 'Failed run cleans up only its own registered test installation without killing a running app'; passed = $true }) }
    catch { $findings.Add(@{ test = 'Test cleanup blocked to preserve another installation or a running app'; passed = $false; error = $_.Exception.Message }) }
  }
  if (Test-Path -LiteralPath $evidenceDirectory) {
    @{ outcome = $(if ($completed) { 'passed' } else { 'failed' }); at = [DateTime]::UtcNow.ToString('o');
      expectedSourceCommit = $ExpectedSourceCommit; version = $currentApplicationVersion; previousVersion = $previousApplicationVersion; installer = $Installer; installerSha256 = $ExpectedInstallerSha256.ToLowerInvariant();
      previousSourceCommit = $PreviousSourceCommit; previousInstallerSha256 = $PreviousInstallerSha256.ToLowerInvariant();
      findings = $findings; limitations = @('Executed on a development Windows host, not a clean Windows VM.', 'NSIS extraction interruption and rollback were not executed.', 'Native file chooser selection is not automated.', 'Private legacy UserData is stored only in temporary artifact/desktop-smoke/UserData and must not be distributed.')
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidenceDirectory 'desktop-release-acceptance.json') -Encoding utf8
  }
  $env:RPGMAP_SMOKE_EXPECTED_SOURCE_COMMIT = $previousExpectedSource
  Pop-Location
}
