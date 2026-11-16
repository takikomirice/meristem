param([Parameter(Mandatory=$true)][string]$NodeExe, [Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($NodeExe) -or -not [IO.Path]::IsPathRooted($ConfigPath)) { throw 'Explicit absolute Node and config paths required' }
$entry = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist/src/install.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Run npm ci and npm run build first' }
& $NodeExe $entry install $ConfigPath
exit $LASTEXITCODE
