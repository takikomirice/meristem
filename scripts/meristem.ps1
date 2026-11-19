param(
    [ValidateSet('help', 'setup', 'start', 'resume', 'status', 'usage')]
    [string]$Action = 'help'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'node/node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    if (Test-Path -LiteralPath (Join-Path $root 'release-manifest.json')) { throw 'Packaged node/node.exe is missing.' }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
& $node (Join-Path $root 'dist/src/cli.js') terminal $Action
exit $LASTEXITCODE
