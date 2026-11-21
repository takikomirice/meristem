param(
    [Parameter(Mandatory=$true, Position=0)][ValidateSet('inspect', 'run')][string]$Action,
    [Parameter(Mandatory=$true, Position=1)][string]$RelativePath
)
$ErrorActionPreference = 'Stop'
$runtime = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'runtime'
& (Join-Path $runtime 'node/node.exe') (Join-Path $runtime 'dist/src/cli.js') $Action $RelativePath
exit $LASTEXITCODE
