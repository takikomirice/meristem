param(
    [Parameter(Mandatory=$true)][ValidateSet('CC-01','CC-02')][string]$Case,
    [switch]$Live,
    [Parameter(Mandatory=$true)][string]$RealExe,
    [Parameter(Mandatory=$true)][string]$AuthHome,
    [Parameter(Mandatory=$true)][string]$Evidence
)
$ErrorActionPreference = 'Stop'
if (-not $Live) { throw 'Explicit -Live is required' }
foreach ($value in @($RealExe, $AuthHome, $Evidence)) { if (-not [IO.Path]::IsPathRooted($value)) { throw 'Absolute paths are required' } }
if (Test-Path -LiteralPath $Evidence) { throw 'Evidence destination must be unused' }
$runner = if ($Case -eq 'CC-01') { '..\dist\test\live\cc01.js' } else { '..\dist\test\live\cc02.js' }
& node (Join-Path $PSScriptRoot $runner) --real-exe $RealExe --auth-home $AuthHome --evidence $Evidence
if ($LASTEXITCODE -ne 0) { throw "$Case live preflight did not pass; inspect evidence" }
