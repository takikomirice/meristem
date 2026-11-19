import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

test('VSIX includes license and notices, excludes private state, and never overwrites an artifact', () => {
  mkdirSync('.local', { recursive: true });
  const output = path.join(mkdtempSync(path.resolve('.local/package-test-')), 'license package.vsix');
  const args = ['-NoProfile', '-File', 'scripts/package-extension.ps1', '-OutputPath', output];
  const packed = spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr + packed.stdout);
  const inspect = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
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
  assert.equal(files['extension/dist/src/terminal.js'], readFileSync('extension/dist/src/terminal.js', 'utf8'), 'inspection must preserve Japanese display text');
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

test('release ZIP runs with its own Node and locked dependencies and contains no developer state', async () => {
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
  assert.deepEqual(native, ['.local/chat-control-build/CodexRelay.exe', '.local/chat-control-build/CodexWorkerHost.exe', '.local/chat-control-build/MeristemControl.exe', '.local/chat-control-build/MeristemTerminal.exe']);
  assert(!Object.keys(manifest.files).some(file => /^(?:\.git\/|test\/|src\/)|(?:^|\/)(?:auth\.json|control\.sqlite|installation\.json|debug\.log)$/.test(file)));
  assert.equal(readFileSync(path.join(payload, 'node/LICENSE.txt'), 'utf8'), readFileSync(license, 'utf8'));
  const cliHelp = spawnSync('powershell.exe', ['-NoProfile', '-File', path.join(payload, 'scripts/meristem.ps1'), 'help'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(cliHelp.status, 0, cliHelp.stderr);
  assert.match(cliHelp.stdout, /\bstart\b/); assert.match(cliHelp.stdout, /\bresume\b/);
  for (const file of ['node/node.exe', 'node/LICENSE.txt', 'dist/src/install.js', 'scripts/install.ps1', 'scripts/uninstall.ps1', 'extension/package.json', 'node_modules/typescript/LICENSE.txt', 'node_modules/typescript/ThirdPartyNoticeText.txt']) {
    assert.equal(sha256(path.join(payload, file)), manifest.files[file]);
  }
  const smoke = spawnSync(path.join(payload, 'node/node.exe'), ['--input-type=module', '-e', "await Promise.all(['install','cli','mcp'].map(name => import('./dist/src/' + name + '.js'))); const {Store}=await import('./dist/src/store.js'); const store=new Store(process.env.MERISTEM_TEST_STATE,process.cwd()); store.close(); console.log('runtime-ready')"], { cwd: payload, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', MERISTEM_TEST_STATE: path.join(root, 'state') } });
  assert.equal(smoke.status, 0, smoke.stderr); assert.match(smoke.stdout, /runtime-ready/);
  const { serialFixture } = await import('../dist/test/fixtures/serial-git.js');
  const fixture = serialFixture(path.join(root, 'fixture repo'));
  const plan = { ...fixture.plan, schema_version: 2,
    tasks: fixture.plan.tasks.map(task => ({ ...task, agent: { ...task.agent, permissionProfileId: 'workspace' } })) };
  writeFileSync(fixture.planPath, readFileSync(fixture.planPath, 'utf8').replace(JSON.stringify(fixture.plan), JSON.stringify(plan)));
  const environmentRoot = path.join(root, '専用 環境'), authHome = path.join(root, 'fixture auth');
  const settings = path.join(environmentRoot, 'profile', 'User', 'settings.json');
  const extensionDirectory = path.join(environmentRoot, 'extensions', 'openai.chatgpt');
  mkdirSync(path.dirname(settings), { recursive: true }); mkdirSync(extensionDirectory, { recursive: true }); mkdirSync(authHome);
  const original = '{"editor.fontSize":21}', originalToml = '[windows]\nsandbox="elevated"\n';
  const codexConfig = path.join(authHome, 'config.toml');
  writeFileSync(settings, original); writeFileSync(codexConfig, originalToml);
  writeFileSync(path.join(extensionDirectory, 'package.json'), '{"publisher":"openai","name":"chatgpt","version":"1.2.3"}');
  const nodeExe = path.join(payload, 'node/node.exe'), realExe = path.resolve('.local/chat-control-build/MockCodex.exe');
  const request = { implementationRoot: payload, realExe, nodeExe, helperExtension: path.join(payload, 'extension'), settings, codexConfig,
    controlConfig: path.join(environmentRoot, 'control.json'), installDirectory: path.join(environmentRoot, 'installation'), parentCwd: fixture.repository,
    prepare: { environmentRoot, stateDirectory: path.join(environmentRoot, 'state'), parentThreadId: 'packaged-parent',
      planPath: fixture.planPath, repositoryPath: fixture.repository, repositoryId: 'fixture-repo', branchScope: ['cc05-integration'],
      coordinator: { model: 'mock', effort: 'low' } } };
  const requestPath = path.join(root, 'prepare.json'), selectionPath = path.join(root, 'selection.json'), installPath = path.join(root, 'install.json');
  writeFileSync(requestPath, JSON.stringify(request));
  writeFileSync(selectionPath, JSON.stringify({ codeExe: nodeExe, extensionDirectory, selectedTools: {
    code: { sha256: sha256(nodeExe), version: '1.2.3' }, node: { sha256: sha256(nodeExe), version: process.version },
    codex: { sha256: sha256(realExe), version: '0.0.0' } } }));
  const script = (name, ...args) => {
    const run = spawnSync('powershell.exe', ['-NoProfile', '-File', path.join(payload, 'scripts', name + '.ps1'), ...args],
      { cwd: payload, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    return JSON.parse(run.stdout);
  };
  const prepared = spawnSync('powershell.exe', ['-NoProfile', '-Command', `
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $prepared = & '.\\scripts\\install.ps1' -Prepare -ConfigPath $env:MERISTEM_TEST_REQUEST -EnvironmentPath $env:MERISTEM_TEST_SELECTION
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $prepared | Set-Content -LiteralPath $env:MERISTEM_TEST_INSTALL -Encoding UTF8
  `], { cwd: payload, encoding: 'utf8', windowsHide: true, env: { ...process.env, MERISTEM_TEST_REQUEST: requestPath,
    MERISTEM_TEST_SELECTION: selectionPath, MERISTEM_TEST_INSTALL: installPath } });
  assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
  const control = JSON.parse(readFileSync(request.controlConfig, 'utf8'));
  assert.equal(control.nodeExecutable, nodeExe);
  assert.equal(control.mcp.parentRelay.threadId, 'packaged-parent');
  assert.deepEqual(control.executionLimits, { maxWakeTurns: null, maxCorrectionsPerTask: null });
  assert.deepEqual(control.mcp.scope.permissionPermit, { allowedProfileIds: ['workspace'], writableRoots: [fixture.trees], allowedReviewers: ['user'] });
  assert.equal(readFileSync(settings, 'utf8'), original);
  assert.equal(readFileSync(codexConfig, 'utf8'), originalToml);
  const installed = script('install', '-ConfigPath', installPath);
  assert.equal(installed.automaticStart, false);
  assert.equal(script('uninstall', '-ReceiptPath', installed.receipt).state, 'restored');
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), JSON.parse(original));
  assert.equal(readFileSync(codexConfig, 'utf8'), originalToml);
  assert(!existsSync(request.prepare.stateDirectory));
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
