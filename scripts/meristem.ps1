param(
    [ValidateSet('help', 'setup', 'start', 'resume', 'status', 'usage', 'inspect', 'run')]
    [string]$Action = 'help',
    [string]$RelativePath
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'node/node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    if (Test-Path -LiteralPath (Join-Path $root 'release-manifest.json')) { throw 'Packaged node/node.exe is missing.' }
    $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
$entry = Join-Path $root 'dist/src/cli.js'
if ($Action -in @('inspect', 'run')) {
    if (-not $RelativePath -or $args.Count) { throw 'Supply one repository-relative file.' }
    & $node $entry $Action $RelativePath
} else {
    & $node $entry terminal $Action
}
exit $LASTEXITCODE
