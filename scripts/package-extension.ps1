param(
    [string]$OutputPath = $env:MERISTEM_VSIX_OUTPUT,
    [string]$NodeExe = $env:MERISTEM_NODE_EXE,
    [string]$NodeLicensePath = $env:MERISTEM_NODE_LICENSE,
    [string]$NodeChecksumsPath = $env:MERISTEM_NODE_CHECKSUMS
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source }
if (-not $NodeLicensePath -or -not $NodeChecksumsPath) { throw 'Supply the matching official Node LICENSE and SHASUMS256.txt with -NodeLicensePath and -NodeChecksumsPath or MERISTEM_NODE_LICENSE and MERISTEM_NODE_CHECKSUMS.' }
if (-not $OutputPath) {
    $version = (Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $root 'extension/package.json') | ConvertFrom-Json).version
    $OutputPath = Join-Path $root ('.local/meristem-chat-control-' + $version + '.vsix')
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw 'Use a new VSIX output path' }
$stage = Join-Path ([IO.Path]::GetTempPath()) ('meristem-vsix-' + [guid]::NewGuid().ToString('N'))
try {
    & (Join-Path $PSScriptRoot 'package-release.ps1') -OutputDirectory $stage -NodeExe $NodeExe -NodeLicensePath $NodeLicensePath -NodeChecksumsPath $NodeChecksumsPath -VsixPath $OutputPath
} finally {
    if (Test-Path -LiteralPath $stage) {
        $resolved = (Resolve-Path -LiteralPath $stage).Path
        if ($resolved -ne $stage -or (Split-Path -Parent $resolved) -ne [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Unexpected staging directory' }
        Remove-Item -LiteralPath $resolved -Force -Recurse
    }
}
