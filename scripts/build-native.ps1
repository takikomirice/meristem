param(
    [string]$OutputDirectory = '.local/chat-control-build',
    [switch]$WithFixtures
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputPath = if ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory)) }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework x64 compiler is required' }
[void][IO.Directory]::CreateDirectory($outputPath)
$sources = @('Program.cs', 'StdioRelay.cs', 'LocalPipe.cs', 'ProcessTree.cs', 'McpPeer.cs') | ForEach-Object { Join-Path $repoRoot "native\$_" }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll "/out:$outputPath\CodexRelay.exe" @sources
if ($LASTEXITCODE -ne 0) { throw 'Relay compilation failed' }
if ($WithFixtures) {
    & $compiler /nologo /target:exe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll "/out:$outputPath\MockCodex.exe" (Join-Path $repoRoot 'test\fixtures\MockCodex.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed' }
    & $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$outputPath\ProcessTreeProbe.exe" (Join-Path $repoRoot 'test\fixtures\ProcessTreeProbe.cs') (Join-Path $repoRoot 'native\ProcessTree.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Suspended process fixture compilation failed' }
}
& $compiler /nologo /target:exe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll /reference:System.Security.dll "/out:$outputPath\CodexWorkerHost.exe" (Join-Path $repoRoot 'native\WorkerProgram.cs') (Join-Path $repoRoot 'native\WorkerHost.cs') @sources /main:WorkerProgram
if ($LASTEXITCODE -ne 0) { throw 'Worker host compilation failed' }
Write-Output "Built native executables in $outputPath"
& $compiler /nologo /target:exe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll /reference:System.Security.dll "/out:$outputPath\MeristemControl.exe" (Join-Path $repoRoot 'native\ControlProgram.cs') @sources /main:ControlProgram
if ($LASTEXITCODE -ne 0) { throw 'Control host compilation failed' }
