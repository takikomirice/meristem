$ErrorActionPreference = 'Stop'
$deadline = [DateTime]::UtcNow.AddSeconds(600)
while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'stop'))) {
    [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'grandchild.marker'), '.')
    Start-Sleep -Milliseconds 500
}
