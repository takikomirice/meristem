param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$NodeExe,
    [Parameter(Mandatory=$true)][string]$NodeLicensePath,
    [Parameter(Mandatory=$true)][string]$NodeChecksumsPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Sha256([string]$file) {
    $stream = [IO.File]::OpenRead($file)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Assert-PlainPath([string]$value) {
    $current = [IO.Path]::GetFullPath($value)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path rejected' }
        }
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
$repoRoot = Split-Path -Parent $PSScriptRoot
foreach ($relative in @('', 'package.json', 'package-lock.json', 'extension/package.json', 'dist/src', 'extension/dist/src', '.local/chat-control-build', 'migrations', 'docs/releases', 'node_modules')) {
    Assert-PlainPath (Join-Path $repoRoot $relative)
}
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$helper = Get-Content -LiteralPath (Join-Path $repoRoot 'extension/package.json') -Raw | ConvertFrom-Json
if ($package.version -notmatch '^\d+\.\d+\.\d+$' -or $package.version -ne $helper.version) { throw 'Release versions must match' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
Assert-PlainPath $output
if (Test-Path -LiteralPath $output) { throw 'Use a new release output directory' }
foreach ($recursiveInput in @('node_modules', 'migrations')) {
    $inputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $recursiveInput))
    if ($output.StartsWith($inputRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release output cannot be inside recursive inputs' }
}
foreach ($inputPath in @($NodeExe, $NodeLicensePath, $NodeChecksumsPath)) {
    if (-not [IO.Path]::IsPathRooted($inputPath) -or -not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw 'Explicit absolute Node executable, license and checksum file paths required' }
    Assert-PlainPath $inputPath
}
$nodeVersion = (& $NodeExe --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v\d+\.\d+\.\d+$' -or [version]$nodeVersion.Substring(1) -lt [version]'24.22.1') { throw 'Node 24.22.1 or newer required' }
$platform = (& $NodeExe -p 'process.platform.concat(String.fromCharCode(45),process.arch)').Trim()
if ($LASTEXITCODE -ne 0 -or $platform -ne 'win32-x64') { throw 'Windows x64 Node required' }
# Windows PowerShell 5.1 cannot parse package-lock's empty root key; normalize it with Node's JSON parser.
$lockText = & $NodeExe -e "const p=require(process.argv[1]); console.log(JSON.stringify({version:p.version,rootVersion:p.packages[String()].version,packages:Object.entries(p.packages).filter(e=>e[0]).map(e=>({path:e[0],version:e[1].version}))}));" (Join-Path $repoRoot 'package-lock.json')
if ($LASTEXITCODE -ne 0) { throw 'Dependency lock could not be read' }
$lock = $lockText | ConvertFrom-Json
if ($package.version -ne $lock.version -or $package.version -ne $lock.rootVersion) { throw 'Release versions must match the lockfile' }
$nodeHash = Get-Sha256 $NodeExe
$nodeRecords = @(Get-Content -LiteralPath $NodeChecksumsPath | Where-Object { $_ -match '^[a-f0-9]{64}\s+win-x64/node\.exe$' })
if ($nodeRecords.Count -ne 1 -or $nodeRecords[0].Substring(0,64) -ne $nodeHash) { throw 'Node executable differs from the supplied official checksum' }
$name = 'meristem-v' + $package.version + '-windows-x64'
$payloadRoot = Join-Path $output ('payload/' + $name)
[void][IO.Directory]::CreateDirectory($payloadRoot)
function Copy-PayloadFile([string]$source, [string]$relative) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Required release input missing: $relative" }
    Assert-PlainPath $source
    $target = [IO.Path]::GetFullPath((Join-Path $payloadRoot $relative))
    if (-not $target.StartsWith($payloadRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release path escapes payload' }
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $target))
    [IO.File]::Copy($source, $target, $false)
}
function Copy-PayloadTree([string]$source, [string]$relative) {
    if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Required release directory missing: $relative" }
    Assert-PlainPath $source
    foreach ($item in Get-ChildItem -LiteralPath $source -Force -Recurse) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse-point inputs are not supported' }
        if (-not $item.PSIsContainer) { Copy-PayloadFile $item.FullName ($relative + '/' + $item.FullName.Substring($source.Length + 1)) }
    }
}
foreach ($relative in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'scripts/install.ps1', 'scripts/uninstall.ps1', 'scripts/meristem.ps1', 'extension/package.json')) {
    Copy-PayloadFile (Join-Path $repoRoot $relative) $relative
}
foreach ($guide in @(@('INSTALL.ja.md','README.md'), @('INSTALL.en.md','README.en.md'))) {
    $guideSource = Join-Path $repoRoot ('docs/releases/' + $guide[0])
    Assert-PlainPath $guideSource
    $text = [IO.File]::ReadAllText($guideSource)
    $text = $text.Replace('(INSTALL.ja.md)', '(README.md)').Replace('(INSTALL.en.md)', '(README.en.md)').Replace('(../../LICENSE)', '(LICENSE)').Replace('(../../THIRD_PARTY_NOTICES.md)', '(THIRD_PARTY_NOTICES.md)')
    [IO.File]::WriteAllText((Join-Path $payloadRoot $guide[1]), $text, (New-Object Text.UTF8Encoding($false)))
}
Copy-PayloadFile $NodeExe 'node/node.exe'
Copy-PayloadFile $NodeLicensePath 'node/LICENSE.txt'
foreach ($relative in @('dist/src', 'extension/dist/src')) {
    $files = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot $relative) -Filter '*.js' -File)
    if (-not $files.Count) { throw "Build JavaScript before packaging: $relative" }
    foreach ($file in $files) { Copy-PayloadFile $file.FullName ($relative + '/' + $file.Name) }
}
Copy-PayloadTree (Join-Path $repoRoot 'migrations') 'migrations'
# Only these compiled files enter .local; never copy developer state, fixtures or credentials.
foreach ($exe in @('CodexRelay.exe', 'CodexWorkerHost.exe', 'MeristemControl.exe', 'MeristemTerminal.exe')) {
    $relative = '.local/chat-control-build/' + $exe
    Copy-PayloadFile (Join-Path $repoRoot $relative) $relative
}
$dependencyRoots = @()
foreach ($entry in $lock.packages | Sort-Object path) {
    $relative = $entry.path
    $source = [IO.Path]::GetFullPath((Join-Path $repoRoot $relative))
    $modulesRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'node_modules'))
    if (-not $source.StartsWith($modulesRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Dependency path escapes node_modules' }
    $installed = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
    if ($installed.version -ne $entry.version) { throw "Dependency version drift: $relative" }
    if (-not @(Get-ChildItem -LiteralPath $source -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING)(\.|$)' }).Count) { throw "Dependency license missing: $relative" }
    if (@($dependencyRoots | Where-Object { $relative.StartsWith($_ + '/', [StringComparison]::Ordinal) }).Count) { continue }
    Copy-PayloadTree $source $relative
    $dependencyRoots += $relative
}
$vsix = Join-Path $output ('meristem-chat-control-' + $package.version + '.vsix')
$vsixResult = & powershell.exe -NoProfile -File (Join-Path $repoRoot 'scripts/package-extension.ps1') -OutputPath $vsix
if ($LASTEXITCODE -ne 0) { throw 'Helper extension packaging failed' }
Copy-PayloadFile $vsix ([IO.Path]::GetFileName($vsix))
$sourceCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Source commit unavailable' }
$sourceTree = (& git -C $repoRoot rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Source tree unavailable' }
$sourceDirty = [bool](& git -C $repoRoot status --porcelain --untracked-files=normal)
$hashes = [ordered]@{}
foreach ($file in Get-ChildItem -LiteralPath $payloadRoot -File -Recurse -Force | Sort-Object FullName) {
    $relative = $file.FullName.Substring($payloadRoot.Length + 1).Replace('\','/')
    $hashes[$relative] = Get-Sha256 $file.FullName
}
$manifest = [ordered]@{ version = $package.version; platform = 'windows-x64'; sourceCommit = $sourceCommit; sourceTree = $sourceTree; sourceDirty = $sourceDirty; nodeVersion = $nodeVersion; nodeSha256 = $nodeHash; nodeLicenseSource = ('https://raw.githubusercontent.com/nodejs/node/' + $nodeVersion + '/LICENSE'); files = $hashes }
[IO.File]::WriteAllText((Join-Path $payloadRoot 'release-manifest.json'), (($manifest | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding($false)))
$zip = Join-Path $output ($name + '.zip')
[IO.Compression.ZipFile]::CreateFromDirectory($payloadRoot, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
$sums = @($zip, $vsix) | ForEach-Object { (Get-Sha256 $_) + '  ' + [IO.Path]::GetFileName($_) }
[IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), (($sums -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
[ordered]@{ name = $name; zip = $zip; vsix = $vsix; checksums = (Join-Path $output 'SHA256SUMS.txt'); sourceCommit = $sourceCommit; sourceTree = $sourceTree; sourceDirty = $sourceDirty; files = $hashes.Count } | ConvertTo-Json -Compress
