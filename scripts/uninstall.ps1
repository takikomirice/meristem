param([string]$NodeExe, [Parameter(Mandatory=$true)][Alias('ReceiptPath')][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $NodeExe) { $NodeExe = Join-Path $root 'node/node.exe' }
if (-not [IO.Path]::IsPathRooted($NodeExe) -or -not [IO.Path]::IsPathRooted($ConfigPath)) { throw 'Explicit absolute Node and receipt paths required' }
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'Bundled Node is missing; specify the selected Node with -NodeExe' }
$entry = Join-Path $root 'dist/src/install.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Compiled installer missing; for source, run npm ci and npm run build first' }
& $NodeExe $entry uninstall $ConfigPath
exit $LASTEXITCODE
