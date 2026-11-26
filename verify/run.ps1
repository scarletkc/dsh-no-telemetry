# Runs verify.mjs with the Electron runtime bundled in DeepSeek Harness.
# Usage: powershell -ExecutionPolicy Bypass -File verify\run.ps1
$ErrorActionPreference = 'Stop'
$resources = if ($env:DSH_APP_RESOURCES) { $env:DSH_APP_RESOURCES } else { Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources' }
$exe = Join-Path $resources '..\DeepSeek Harness.exe'
if (-not (Test-Path $exe)) { throw "DeepSeek Harness not found at $exe; set DSH_APP_RESOURCES" }
$env:ELECTRON_RUN_AS_NODE = '1'
Write-Host 'Running; this takes about a minute...'
# DeepSeek Harness.exe is a GUI-subsystem program: called directly from a
# console, PowerShell neither waits for it nor shows its output. Piping its
# output forces PowerShell to wait and stream every line. stderr lines must
# not become terminating errors, hence 'Continue' for this call.
$ErrorActionPreference = 'Continue'
& $exe (Join-Path $PSScriptRoot 'verify.mjs') 2>&1 | ForEach-Object { "$_" }
exit $LASTEXITCODE
