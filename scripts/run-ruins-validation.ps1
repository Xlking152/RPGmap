param([ValidatePattern('^[a-z-]+$')][string]$Label = 'ruins-candidate')
$ErrorActionPreference = 'Stop'
$label = $Label
$repoRoot = (Get-Location).Path
$baselineCommit = 'ed7e13baab0f116222333c20431e19ab63b60e37'
$baselineRoot = (Resolve-Path -LiteralPath (Join-Path $repoRoot 'artifact/v254-baseline')).Path
function Assert-VisionBaseline {
  $baselineBranch = git -C $baselineRoot symbolic-ref --quiet --short HEAD
  if ($LASTEXITCODE -ne 1) { throw 'Vision baseline requires a detached HEAD' }
  $baselineHead = git -C $baselineRoot rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $baselineHead.Trim() -ne $baselineCommit) { throw 'Vision baseline must be the released v2.5.4 commit' }
  $baselineStatus = git -C $baselineRoot status --porcelain
  if ($LASTEXITCODE -ne 0 -or $baselineStatus) { throw 'Vision baseline requires a clean checkout' }
}
Assert-VisionBaseline
$finalCommit = (git rev-parse HEAD).Trim()
if ($label -eq 'final-main' -and (git branch --show-current).Trim() -ne 'main') { throw 'Final validation requires main' }
if (git status --porcelain) { throw 'Final validation requires a clean checkout' }
$packageOutput = [IO.Path]::GetFullPath((Join-Path $repoRoot "artifact/$label-candidate"))
$packageRoot = [IO.Path]::GetFullPath((Join-Path $packageOutput 'RPGmap-v2.5.5'))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'artifact')) + [IO.Path]::DirectorySeparatorChar
if (-not $packageRoot.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe package target' }

function Invoke-Check {
  param([string]$Name, [scriptblock]$Action, [string]$Extension = 'log')
  $checkLog = Join-Path $repoRoot "artifact/occlusion-$Name-$label.$Extension"
  Write-Output "[final-main] $Name started"
  & $Action *> $checkLog
  $checkExit = $LASTEXITCODE
  if ($checkExit -ne 0) { Get-Content -LiteralPath $checkLog -Tail 12 | ForEach-Object { $_.Substring(0, [Math]::Min(400, $_.Length)) }; throw "$Name failed with exit $checkExit" }
  Write-Output "[final-main] $Name passed"
}

Invoke-Check 'full-tests' { npm test }
Invoke-Check 'syntax' { node --input-type=module -e "import{execFileSync}from'node:child_process';const files=[...new Set(execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard','--','*.js','*.mjs'],{encoding:'utf8'}).split('\0').filter(Boolean))];for(const f of files)execFileSync(process.execPath,['--check',f],{stdio:'pipe'});console.log(files.length+' modules: syntax passed');" }
Invoke-Check 'audit' { npm audit --registry=https://registry.npmjs.org --json } 'json'
Invoke-Check 'audit-production' { npm audit --registry=https://registry.npmjs.org --omit=dev --json } 'json'
$env:RPGMAP_PACKAGE_DIR = $packageOutput
Invoke-Check 'build' { npm run build }
Invoke-Check 'bundle' { npm run check:bundle }
Invoke-Check 'package' { npm run package:local-server }
Invoke-Check 'verify-package' { node scripts/verify-package.mjs "--root=$packageRoot" "--archive=$packageRoot.zip" "--commit=$finalCommit" }
# User scope: keep multiplayer functionality, defer its performance work.
# Package smoke still checks permissions, durable WAL, reconnect and recovery.
Write-Output '[final-main] vision baseline started'
Assert-VisionBaseline
node scripts/vision-performance-benchmark.mjs "--repo=$baselineRoot" > "artifact/qa/v2.5.4-vision-$label-load.json"
if ($LASTEXITCODE -ne 0) { throw 'Vision baseline failed' }
Assert-VisionBaseline
node scripts/vision-performance-benchmark.mjs > "artifact/qa/v2.5.5-vision-$label-load.json"
if ($LASTEXITCODE -ne 0) { throw 'Vision candidate failed' }
Write-Output '[final-main] vision measurements saved'
$env:RPGMAP_SMOKE_LOCAL_PERFORMANCE = '1'
Remove-Item Env:RPGMAP_SMOKE_HOSTED_FRAME_OBSERVATION -ErrorAction SilentlyContinue
Remove-Item Env:RPGMAP_SMOKE_CPU_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:RPGMAP_SMOKE_FEEDBACK_CPU_PROFILE -ErrorAction SilentlyContinue
Remove-Item Env:RPGMAP_SMOKE_RUINS_CPU_PROFILE -ErrorAction SilentlyContinue
Invoke-Check 'chrome-smoke' { & ./scripts/windows-smoke.ps1 -Root $packageRoot -TimeoutSeconds 30 -Browser chrome -SingleAttempt }
# The wrapper also emits the real LAN destruction/restart payload. The
# assembler binds it to this ZIP and saves it as mandatory lan-vision.json.
node --input-type=module -e "import{readFileSync,writeFileSync}from'node:fs';const payloads=readFileSync('artifact/occlusion-chrome-smoke-$label.log','utf8').split(/\r?\n/).filter(v=>v.startsWith('{')).map(JSON.parse);writeFileSync('artifact/qa/v2.5.5-chrome-smoke-$label.json',JSON.stringify(payloads.at(-1),null,2));"
if ($LASTEXITCODE -ne 0) { throw 'Chrome smoke payload missing' }
Invoke-Check 'raster' { node scripts/vision-mask-raster-check.mjs }
Invoke-Check 'facade-raster' { node scripts/vision-facade-raster-check.mjs }
Invoke-Check 'core' { npm run benchmark }
if ((git rev-parse HEAD).Trim() -ne $finalCommit -or (git status --porcelain)) { throw 'Final main changed during validation' }
Assert-VisionBaseline
Invoke-Check 'assembled-validation' { node scripts/assemble-ruins-validation.mjs $label $(if ($label -eq 'final-main') { 'final-main' } else { 'candidate' }) }
Write-Output "[final-main] all checks passed for $finalCommit"
