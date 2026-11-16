import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

test('VSIX includes license and notices, excludes private state, and never overwrites an artifact', () => {
  mkdirSync('.local', { recursive: true });
  const output = path.join(mkdtempSync(path.resolve('.local/package-test-')), 'license package.vsix');
  const args = ['-NoProfile', '-File', 'scripts/package-extension.ps1', '-OutputPath', output];
  const packed = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr + packed.stdout);
  const inspect = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($env:MERISTEM_TEST_VSIX)
    try {
      $files = @{}
      foreach ($entry in $zip.Entries) {
        $reader = New-Object IO.StreamReader($entry.Open())
        try { $files[$entry.FullName] = $reader.ReadToEnd() } finally { $reader.Dispose() }
      }
      $files | ConvertTo-Json -Depth 3 -Compress
    } finally { $zip.Dispose() }
  `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MERISTEM_TEST_VSIX: output } });
  assert.equal(inspect.status, 0, inspect.stderr);
  const files = JSON.parse(inspect.stdout);
  assert.equal(typeof files['extension/LICENSE.txt'], 'string', 'VSIX must contain the complete project license');
  assert.equal(files['extension/LICENSE.txt'], readFileSync('LICENSE', 'utf8'));
  assert.equal(files['extension/THIRD_PARTY_NOTICES.md'], readFileSync('THIRD_PARTY_NOTICES.md', 'utf8'));
  assert.equal(JSON.parse(files['extension/package.json']).license, 'MIT');
  assert.match(files['extension.vsixmanifest'], /<License>extension\/LICENSE\.txt<\/License>/);
  assert.match(files['extension.vsixmanifest'], /Type="Microsoft\.VisualStudio\.Services\.Content\.License" Path="extension\/LICENSE\.txt"/);
  assert.match(files['[Content_Types].xml'], /Extension="txt" ContentType="text\/plain"/);
  assert.match(files['[Content_Types].xml'], /Extension="md" ContentType="text\/markdown"/);
  for (const entry of Object.keys(files)) {
    assert.match(entry, /^(?:extension\.vsixmanifest|\[Content_Types\]\.xml|extension\/(?:package\.json|LICENSE\.txt|THIRD_PARTY_NOTICES\.md|dist\/src\/[^/]+\.js))$/);
  }
  const bytes = readFileSync(output);
  const repeated = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
  assert.notEqual(repeated.status, 0);
  assert.deepEqual(readFileSync(output), bytes);
});

test('release ZIP runs with its own Node and locked dependencies and contains no developer state', () => {
  mkdirSync('.local', { recursive: true });
  const root = mkdtempSync(path.resolve('.local/release package test-'));
  const license = path.join(root, 'node-license.txt'), checksums = path.join(root, 'node-shasums.txt');
  // This private test artifact uses a fixture notice; published packages use the official versioned Node notice.
  writeFileSync(license, 'Node.js packaging fixture notice; not a redistributable release.\n');
  writeFileSync(checksums, createHash('sha256').update(readFileSync(process.execPath)).digest('hex') + '  win-x64/node.exe\n');
  const invalidChecksums = path.join(root, 'wrong-shasums.txt');
  writeFileSync(invalidChecksums, '0'.repeat(64) + '  win-x64/node.exe\n');
  const rejectedOutput = path.join(root, 'rejected');
  const rejected = spawnSync('powershell.exe', ['-NoProfile', '-File', 'scripts/package-release.ps1', '-OutputDirectory', rejectedOutput, '-NodeExe', process.execPath, '-NodeLicensePath', license, '-NodeChecksumsPath', invalidChecksums], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(rejected.status, 0); assert(!existsSync(rejectedOutput), 'checksum rejection must precede artifact creation');
  const output = path.join(root, 'artifacts');
  const packed = spawnSync('powershell.exe', ['-NoProfile', '-File', 'scripts/package-release.ps1', '-OutputDirectory', output, '-NodeExe', process.execPath, '-NodeLicensePath', license, '-NodeChecksumsPath', checksums], { encoding: 'utf8', windowsHide: true, timeout: 180000 });
  assert.equal(packed.status, 0, packed.stderr + packed.stdout);
  const result = JSON.parse(packed.stdout);
  const extracted = path.join(root, 'extracted');
  const unpack = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:MERISTEM_TEST_ARCHIVE, $env:MERISTEM_TEST_UNPACK)'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MERISTEM_TEST_ARCHIVE: result.zip, MERISTEM_TEST_UNPACK: extracted } });
  assert.equal(unpack.status, 0, unpack.stderr);
  const payload = path.join(extracted, result.name);
  assert(readFileSync(path.join(payload, 'README.md'), 'utf8').includes('[English](README.en.md)'));
  assert(readFileSync(path.join(payload, 'README.en.md'), 'utf8').includes('[日本語](README.md)'));
  assert(readFileSync(path.join(payload, 'README.md'), 'utf8').includes('[MIT License](LICENSE)'));
  const manifest = JSON.parse(readFileSync(path.join(payload, 'release-manifest.json'), 'utf8'));
  const native = Object.keys(manifest.files).filter(file => file.startsWith('.local/')).sort();
  assert.deepEqual(native, ['.local/chat-control-build/CodexRelay.exe', '.local/chat-control-build/CodexWorkerHost.exe', '.local/chat-control-build/MeristemControl.exe']);
  assert(!Object.keys(manifest.files).some(file => /^(?:\.git\/|test\/|src\/)|(?:^|\/)(?:auth\.json|control\.sqlite|installation\.json|debug\.log)$/.test(file)));
  assert.equal(readFileSync(path.join(payload, 'node/LICENSE.txt'), 'utf8'), readFileSync(license, 'utf8'));
  for (const file of ['node/node.exe', 'node/LICENSE.txt', 'dist/src/install.js', 'extension/package.json', 'node_modules/typescript/LICENSE.txt', 'node_modules/typescript/ThirdPartyNoticeText.txt']) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(payload, file))).digest('hex'), manifest.files[file]);
  }
  const smoke = spawnSync(path.join(payload, 'node/node.exe'), ['--input-type=module', '-e', "await Promise.all(['install','cli','mcp'].map(name => import('./dist/src/' + name + '.js'))); const {Store}=await import('./dist/src/store.js'); const store=new Store(process.env.MERISTEM_TEST_STATE,process.cwd()); store.close(); console.log('runtime-ready')"], { cwd: payload, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', MERISTEM_TEST_STATE: path.join(root, 'state') } });
  assert.equal(smoke.status, 0, smoke.stderr); assert.match(smoke.stdout, /runtime-ready/);
  const repeated = spawnSync('powershell.exe', ['-NoProfile', '-File', 'scripts/package-release.ps1', '-OutputDirectory', output, '-NodeExe', process.execPath, '-NodeLicensePath', license, '-NodeChecksumsPath', checksums], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(repeated.status, 0);
});

test('release packaging rejects junction ancestors before reading inputs or creating output', () => {
  mkdirSync('.local', { recursive: true });
  const root = mkdtempSync(path.resolve('.local/release-junction-test-'));
  const inputs = path.join(root, 'inputs'), alias = path.join(root, 'alias');
  mkdirSync(inputs); symlinkSync(inputs, alias, 'junction');
  writeFileSync(path.join(inputs, 'license.txt'), 'private fixture notice');
  writeFileSync(path.join(inputs, 'shasums.txt'), '0'.repeat(64) + '  win-x64/node.exe\n');
  for (const viaInput of [true, false]) {
    const output = viaInput ? path.join(root, 'output') : path.join(alias, 'output');
    const license = path.join(viaInput ? alias : inputs, 'license.txt');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-File', 'scripts/package-release.ps1', '-OutputDirectory', output, '-NodeExe', process.execPath, '-NodeLicensePath', license, '-NodeChecksumsPath', path.join(inputs, 'shasums.txt')], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /reparse/i); assert(!existsSync(output));
  }
  const recursiveOutput = path.resolve('migrations', path.basename(root));
  const recursive = spawnSync('powershell.exe', ['-NoProfile', '-File', 'scripts/package-release.ps1', '-OutputDirectory', recursiveOutput, '-NodeExe', process.execPath, '-NodeLicensePath', path.join(inputs, 'license.txt'), '-NodeChecksumsPath', path.join(inputs, 'shasums.txt')], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(recursive.status, 0); assert.match(recursive.stderr, /recursive inputs/i); assert(!existsSync(recursiveOutput));
});
