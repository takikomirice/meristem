[CmdletBinding(DefaultParameterSetName='Install')]
param(
    [Parameter(Position=0)][string]$NodeExe,
    [Parameter(Mandatory=$true, Position=1)][string]$ConfigPath,
    [Parameter(Mandatory=$true, ParameterSetName='Prepare')][switch]$Prepare,
    [Parameter(Mandatory=$true, ParameterSetName='Prepare')][string]$EnvironmentPath
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $NodeExe) { $NodeExe = Join-Path $root 'node/node.exe' }
if (-not [IO.Path]::IsPathRooted($NodeExe) -or -not [IO.Path]::IsPathRooted($ConfigPath)) { throw 'Explicit absolute Node and config paths required' }
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw 'Bundled Node is missing; specify the selected Node with -NodeExe' }
$entry = Join-Path $root 'dist/src/install.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Compiled installer missing; for source, run npm ci and npm run build first' }
if ($Prepare) {
    if (-not [IO.Path]::IsPathRooted($EnvironmentPath)) { throw 'Explicit absolute environment selection path required' }
    & $NodeExe $entry prepare $ConfigPath $EnvironmentPath
} else {
    & $NodeExe $entry install $ConfigPath
}
exit $LASTEXITCODE
