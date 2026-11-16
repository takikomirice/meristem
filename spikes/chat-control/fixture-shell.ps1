$ErrorActionPreference = 'Stop'
$shellProcess = Get-Process -Id $PID
$script = Join-Path $PSScriptRoot 'fixture-ticker.ps1'
$leaf = Start-Process -FilePath $shellProcess.Path -ArgumentList @('-NoProfile', '-File', ('"' + $script + '"')) -WindowStyle Hidden -PassThru
@{ shell = $PID; shellCreated = $shellProcess.StartTime.ToUniversalTime().ToString('o'); grandchild = $leaf.Id; grandchildCreated = $leaf.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'processes.json') -Encoding UTF8
Write-Output 'CC00R_SHELL_STARTED'
$deadline = [DateTime]::UtcNow.AddSeconds(600)
while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'stop'))) {
    [IO.File]::AppendAllText((Join-Path $PSScriptRoot 'shell.marker'), '.')
    Start-Sleep -Milliseconds 500
}
