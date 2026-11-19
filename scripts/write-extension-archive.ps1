param([string]$OutputPath, [string]$PayloadRoot)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $root 'extension'
$package = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $extension 'package.json') -Raw | ConvertFrom-Json
if (-not $OutputPath) { $OutputPath = Join-Path $root ('.local/meristem-chat-control-' + $package.version + '.vsix') }
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $OutputPath) { throw 'Use a new VSIX output path' }
if (-not (Test-Path -LiteralPath (Join-Path $extension 'dist/src/extension.js'))) { throw 'Build the extension first' }
foreach ($document in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $document))) { throw "Required distribution document missing: $document" }
}
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputPath) -Force | Out-Null
$temporary = $OutputPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
$stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew)
$zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
function Add-Text([string]$name, [string]$text) {
    $entry = $zip.CreateEntry($name)
    $writer = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding($false)))
    try { $writer.Write($text) } finally { $writer.Dispose() }
}
try {
try {
    $name = [Security.SecurityElement]::Escape($package.name)
    $publisher = [Security.SecurityElement]::Escape($package.publisher)
    $version = [Security.SecurityElement]::Escape($package.version)
    $engine = [Security.SecurityElement]::Escape($package.engines.vscode)
    Add-Text 'extension.vsixmanifest' @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata><Identity Language="en-US" Id="$name" Version="$version" Publisher="$publisher"/><DisplayName>Meristem Chat Control</DisplayName><Description xml:space="preserve">Local worker terminals and human approval</Description><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engine"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/></Properties><License>extension/LICENSE.txt</License></Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/></Assets>
</PackageManifest>
"@
    Add-Text '[Content_Types].xml' '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="txt" ContentType="text/plain"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $extension 'package.json'), 'extension/package.json') | Out-Null
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root 'LICENSE'), 'extension/LICENSE.txt') | Out-Null
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root 'THIRD_PARTY_NOTICES.md'), 'extension/THIRD_PARTY_NOTICES.md') | Out-Null
    foreach ($file in Get-ChildItem -LiteralPath (Join-Path $extension 'dist/src') -Filter '*.js' -File) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, ('extension/dist/src/' + $file.Name)) | Out-Null
    }
    foreach ($file in Get-ChildItem -LiteralPath $PayloadRoot -Recurse -File -Force) {
        $relative = $file.FullName.Substring($PayloadRoot.Length + 1).Replace('\','/')
        if ($relative -match '^(?:dist/src/|migrations/|node/|node_modules/|\.local/chat-control-build/|package(?:-lock)?\.json$|LICENSE$|THIRD_PARTY_NOTICES\.md$)') {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, ('extension/runtime/' + $relative), [IO.Compression.CompressionLevel]::Fastest) | Out-Null
        }
    }
} finally { $zip.Dispose(); $stream.Dispose() }
[IO.File]::Move($temporary, $OutputPath)

} finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
