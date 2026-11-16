param([Parameter(Mandatory=$true)][string]$NodeExe, [Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($NodeExe) -or -not [IO.Path]::IsPathRooted($ConfigPath)) { throw 'Explicit absolute Node and receipt paths required' }
& $NodeExe (Join-Path (Split-Path -Parent $PSScriptRoot) 'dist/src/install.js') uninstall $ConfigPath
exit $LASTEXITCODE
