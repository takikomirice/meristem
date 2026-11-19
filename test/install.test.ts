import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { serialFixture } from './fixtures/serial-git.js';
import ts from 'typescript';
import { install, uninstall } from '../src/install.js';
import { inspectEnvironment, prepareEnvironment, recordBuildCompletion, snapshotBuild, prepareRun } from '../src/development.js';
import { inspectEnvironment as inspectInstallation } from '../src/install.js';

function diagnosticFixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mc11-install space-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const authHome = path.join(root, 'dedicated-auth'), official = path.join(root, 'official');
  mkdirSync(authHome); mkdirSync(official);
  const codexExe = path.join(root, 'codex.exe'), codeExe = path.join(root, 'Code.exe');
  writeFileSync(codexExe, 'selected codex bytes'); writeFileSync(codeExe, 'selected code bytes');
  writeFileSync(path.join(official, 'package.json'), JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: '26.1111.21308' }));
  const secret = 'PRIVATE_AUTH_CONTENT_MUST_NOT_APPEAR';
  writeFileSync(path.join(authHome, 'auth.json'), secret);
  const codexConfig = path.join(authHome, 'config.toml');
  writeFileSync(codexConfig, '[windows]\nsandbox="elevated"\n');
  const settings = path.join(root, 'settings.json'), controlConfig = path.join(root, 'control.json');
  writeFileSync(settings, '{"editor.fontSize":17}');
  writeFileSync(controlConfig, JSON.stringify({ nodeExecutable: process.execPath, nodeSha256: hash(process.execPath),
    runtime: { realExe: codexExe, realSha256: hash(codexExe), authHome } }));
  const spec = { implementationRoot: process.cwd(), realExe: codexExe, nodeExe: process.execPath,
    codexConfig, settings, controlConfig, installDirectory: path.join(root, 'installation') };
  const environment = { implementationRoot: process.cwd(), envRoot: path.join(root, 'environment'), authHome,
    codexExe, nodeExe: process.execPath, codeExe, extensionDirectory: official,
    selectedTools: { codex: { sha256: hash(codexExe), version: '0.169.0-alpha.11.1' },
      node: { sha256: hash(process.execPath), version: process.version }, code: { sha256: hash(codeExe), version: '1.146.0' } } };
  return { root, spec, environment, secret };
}
function treeHashes(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => { const file = path.join(entry.parentPath, entry.name); return [path.relative(root, file), hash(file)]; }));
}

test('diagnostics_do_not_edit_normal_profile', t => {
  const environmentHash = () => createHash('sha256').update(JSON.stringify({ ...process.env })).digest('hex');
  const f = diagnosticFixture(t), before = treeHashes(f.root), envBefore = environmentHash();
  let executions = 0;
  // Execution is outside the inspection contract, including --version and OS setup.
  for (const name of ['spawnSync', 'spawn', 'execSync', 'execFileSync', 'exec', 'execFile'] as const) {
    t.mock.method(childProcess, name, () => { executions++; throw new Error('diagnostics must not execute tools'); });
  }
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const report = inspectInstallation(f.spec, f.environment);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.tools.find((tool: any) => tool.name === 'codex'), {
    name: 'codex', path: f.spec.realExe, version: '0.169.0-alpha.11.1', sha256: hash(f.spec.realExe) });
  assert.equal(report.tools.find(tool => tool.name === 'codex_extension')!.version, '26.1111.21308');
  assert(report.warnings.some((message: string) => message.includes('authentication_present')));
  assert(report.warnings.some((message: string) => message.includes('sandbox_elevated')));
  assert(!JSON.stringify(report).includes(f.secret));
  assert.deepEqual(treeHashes(f.root), before); assert.equal(environmentHash(), envBefore); assert.equal(executions, 0);
  assert(!existsSync(f.spec.installDirectory));
});

test('codex_update_requires_compatibility_validation', t => {
  const f = diagnosticFixture(t);
  writeFileSync(f.spec.realExe, 'updated codex bytes');
  const before = treeHashes(f.root), report = inspectInstallation(f.spec, f.environment);
  assert(report.blockers.some((message: string) => message.includes('codex_hash_mismatch')));
  assert(report.blockers.some((message: string) => message.includes('hashだけ')));
  assert.equal(report.tools.find(tool => tool.name === 'codex')!.version, null);
  assert.deepEqual(treeHashes(f.root), before);
});

test('partial_install_diagnostics_report_missing_tools_and_never_infer_official_extension', () => {
  const report = inspectInstallation({ nodeExe: process.execPath, helperExtension: process.cwd() });
  assert(report.blockers.length > 0);
  assert.deepEqual(report.tools.find((tool: any) => tool.name === 'codex'), { name: 'codex', path: null, version: null, sha256: null });
  assert.deepEqual(report.tools.find((tool: any) => tool.name === 'codex_extension'), { name: 'codex_extension', path: null, version: null, sha256: null });
  assert.equal(report.tools.find(tool => tool.name === 'node')!.version, process.version);
});

test('install_diagnostics_check_requested_settings_config_and_selection', t => {
  const f = diagnosticFixture(t);
  const otherHome = path.join(f.root, 'other'); mkdirSync(otherHome);
  const other = path.join(otherHome, 'config.toml'); writeFileSync(other, '[windows]\nsandbox="mxc"\n');
  const report = inspectInstallation({ ...f.spec, codexConfig: other }, f.environment);
  assert(report.blockers.some((message: string) => message.includes('control_binding_mismatch')));
  assert(report.warnings.some((message: string) => message.includes('sandbox_mxc')));
  writeFileSync(f.spec.settings, '{"chatgpt.cliExecutable":"missing.exe"}');
  assert(inspectInstallation(f.spec, f.environment).blockers.some((message: string) => message.includes('settings_invalid')));
  const invalid = inspectInstallation({ ...f.spec, realExe: 'relative.exe' }, f.environment);
  assert(invalid.blockers.length > 0);
});

test('install_diagnostics_accept_snapshot_inside_dedicated_environment', t => {
  const f = diagnosticFixture(t), snapshot = path.join(f.environment.envRoot, 'snapshots', 'build');
  mkdirSync(snapshot, { recursive: true });
  const report = inspectInstallation({ ...f.spec, implementationRoot: snapshot }, f.environment);
  assert.deepEqual(report.blockers, [], 'DE implementation checkout and installer snapshot are different roots');
});

test('documented_diagnostics_run_in_windows_powershell', { skip: process.platform !== 'win32' }, t => {
  const f = diagnosticFixture(t), request = path.join(f.root, 'install-request.json'), environment = path.join(f.root, 'input.json');
  writeFileSync(request, JSON.stringify(f.spec)); writeFileSync(environment, JSON.stringify(f.environment));
  const before = treeHashes(f.root);
  for (const language of ['ja', 'en']) {
    const doc = readFileSync(`docs/releases/INSTALL.${language}.md`, 'utf8');
    const block = [...doc.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map(match => match[1]).find(text => text.includes('inspectEnvironment'))!;
    let index = 0;
    const script = block.replace(/'<[^>]+>'/g, () => '$env:' + ['MC11_NODE', 'MC11_REQUEST', 'MC11_ENVIRONMENT'][index++]);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, MC11_NODE: process.execPath, MC11_REQUEST: request, MC11_ENVIRONMENT: environment } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout); assert.deepEqual(report.blockers, []);
    assert(!result.stdout.includes(f.secret));
  }
  assert.deepEqual(treeHashes(f.root), before);
});

const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture() {
  const f = serialFixture(), root = process.cwd(), state = path.join(f.root, 'install');
  const realExe = path.join(root, '.local/chat-control-build/MockCodex.exe');
  const settings = path.join(f.root, 'settings.json'), codexConfig = path.join(f.root, 'config.toml');
  writeFileSync(settings, '{\n  // preserve this comment\n  "editor.fontSize": 17,\n  "chatgpt.cliExecutable": "old.exe",\n}\n');
  writeFileSync(codexConfig, '# private settings stay here\nmodel = "my-model"\n');
  const config = { stateDirectory: path.join(f.root, 'run-state'), repository: f.repository, runId: 'cc07', pipeName: 'meristem-cc01-control-cc07', nodeExecutable: process.execPath, nodeSha256: hash(process.execPath), entryPoint: path.join(root, 'dist/src/cli.js'), entrySha256: hash(path.join(root, 'dist/src/cli.js')), runtime: { hostExe: path.join(root, '.local/chat-control-build/CodexWorkerHost.exe'), hostSha256: hash(path.join(root, '.local/chat-control-build/CodexWorkerHost.exe')), realExe, realSha256: hash(realExe), authHome: f.root, fixture: false }, assignments: [], mcp: { parentRelay: { pipeName: 'meristem-cc00-cc07', threadId: 'parent' }, entryPoint: path.join(root, 'dist/src/mcp.js'), entrySha256: hash(path.join(root, 'dist/src/mcp.js')), scope: { fixture: true, plan: true, planPath: f.planPath, repositoryId: 'repo', repositoryPath: f.repository, branchScope: ['cc05-integration'], assignments: [] } } };
  const controlConfig = path.join(f.root, 'control.json'); writeFileSync(controlConfig, JSON.stringify(config));
  const spec = { implementationRoot: root, realExe, nodeExe: process.execPath, helperExtension: path.join(root, 'extension'), settings, codexConfig, controlConfig, installDirectory: state, parentCwd: f.repository };
  const request = path.join(f.root, 'install.json'); writeFileSync(request, JSON.stringify(spec));
  const run = (action = 'install') => spawnSync('powershell.exe', ['-NoProfile', '-File', path.join(root, `scripts/${action}.ps1`), '-NodeExe', process.execPath, '-ConfigPath', action === 'install' ? request : path.join(state, 'installation.json')], { encoding: 'utf8', windowsHide: true });
  return { ...f, spec, settings, codexConfig, state, request, config, run };
}
test('install_preserves_unrelated_settings', () => {
  const f = fixture(), original = readFileSync(f.settings, 'utf8'), auth = readFileSync(f.codexConfig, 'utf8');
  const installed = f.run(); assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  assert(readFileSync(f.settings, 'utf8').includes('// preserve this comment'));
  assert(readFileSync(f.settings, 'utf8').includes('"editor.fontSize": 17'));
  assert(readFileSync(f.codexConfig, 'utf8').startsWith(auth));
  const manifest = readFileSync(path.join(f.state, 'installation.json'), 'utf8');
  assert(!manifest.includes('my-model'), 'unrelated config must not be backed up');
  assert.equal(f.run('uninstall').status, 0);
  assert.equal(readFileSync(f.settings, 'utf8'), original);
  assert.equal(readFileSync(f.codexConfig, 'utf8'), auth);
});
test('uninstall_preserves_later_user_changes', () => {
  const f = fixture(); assert.equal(f.run().status, 0);
  writeFileSync(f.settings, '{"chatgpt.cliExecutable":"user-new.exe","editor.fontSize":23}');
  const userConfig = readFileSync(f.codexConfig, 'utf8').replace('"--pipe"', '"--changed"'); writeFileSync(f.codexConfig, userConfig);
  const result = f.run('uninstall'); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.settings, 'utf8'), '{"chatgpt.cliExecutable":"user-new.exe","editor.fontSize":23}');
  assert.equal(readFileSync(f.codexConfig, 'utf8'), userConfig);
  assert(existsSync(path.join(f.state, 'CodexRelay.exe')), 'keep retained user references usable');
});
test('install_rejects_changed_binary_and_existing_mcp_without_settings_mutation', () => {
  const f = fixture(), original = readFileSync(f.settings, 'utf8');
  f.config.runtime.realSha256 = '0'.repeat(64); writeFileSync(f.spec.controlConfig, JSON.stringify(f.config));
  assert.notEqual(f.run().status, 0); assert.equal(readFileSync(f.settings, 'utf8'), original);
  f.config.runtime.realSha256 = hash(f.spec.realExe); writeFileSync(f.spec.controlConfig, JSON.stringify(f.config));
  writeFileSync(f.codexConfig, '[mcp_servers."meristem"]\ncommand="user-command"\n');
  assert.notEqual(f.run().status, 0); assert.equal(readFileSync(f.settings, 'utf8'), original);
});
test('profile_copy_and_absent_key_restore_preserve_later_user_settings', () => {
  const f = fixture(), source = f.settings, target = path.join(f.root, 'profile', 'User', 'settings.json');
  writeFileSync(source, '{"editor.fontSize":17}');
  writeFileSync(f.request, JSON.stringify({ ...f.spec, settings: target, sourceSettings: source }));
  assert.equal(f.run().status, 0);
  writeFileSync(target, readFileSync(target, 'utf8').replace('17', '24'));
  assert.equal(f.run('uninstall').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { 'editor.fontSize': 24 });
  assert.equal(readFileSync(source, 'utf8'), '{"editor.fontSize":17}');
});
test('uninstall_retains_mcp_section_when_user_appends_a_key', () => {
  const f = fixture(); assert.equal(f.run().status, 0);
  const changed = readFileSync(f.codexConfig, 'utf8') + 'startup_timeout_sec = 90\n'; writeFileSync(f.codexConfig, changed);
  assert.equal(f.run('uninstall').status, 0);
  assert.equal(readFileSync(f.codexConfig, 'utf8'), changed);
});
test('uninstall_removes_inserted_key_comma_across_user_comment', () => {
  const f = fixture(); writeFileSync(f.settings, '{"editor.fontSize":17}');
  assert.equal(f.run().status, 0);
  const installed = readFileSync(f.settings, 'utf8').replace(',"editor', ' /* user comment */,"editor');
  assert(installed.includes('/* user comment */')); writeFileSync(f.settings, installed);
  assert.equal(f.run('uninstall').status, 0);
  const restored = readFileSync(f.settings, 'utf8'), parsed = ts.parseConfigFileTextToJson('settings.json', restored);
  assert.equal(parsed.error, undefined); assert.deepEqual(parsed.config, { 'editor.fontSize': 17 });
  assert(restored.includes('/* user comment */'));
});
test('install_rejects_dotted_mcp_namespace_before_writing', () => {
  const f = fixture(), settings = readFileSync(f.settings, 'utf8');
  const original = 'mcp_servers.meristem.command = "existing-command"\n'; writeFileSync(f.codexConfig, original);
  assert.notEqual(f.run().status, 0);
  assert.equal(readFileSync(f.codexConfig, 'utf8'), original); assert.equal(readFileSync(f.settings, 'utf8'), settings);
});
test('install_preserves_unrelated_project_table_named_meristem', () => {
  const f = fixture(), original = "[projects.'C:/work/meristem']\ntrust_level = \"trusted\"\n";
  writeFileSync(f.codexConfig, original);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.run('uninstall').status, 0); assert.equal(readFileSync(f.codexConfig, 'utf8'), original);
});
test('install_rejects_escaped_existing_mcp_namespace', () => {
  const f = fixture(), original = '[mcp_servers."meri\\u0073tem"]\ncommand="user-command"\n';
  writeFileSync(f.codexConfig, original);
  assert.notEqual(f.run().status, 0); assert.equal(readFileSync(f.codexConfig, 'utf8'), original);
});

test('generated_configuration_binds_explicit_parent_and_repository', t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const envRoot = path.join(f.root, '専用 環境');
  const settings = path.join(envRoot, 'profile', 'User', 'settings.json');
  const official = path.join(envRoot, 'extensions', 'openai.chatgpt');
  const authHome = path.join(f.root, 'dedicated-auth');
  const realExe = path.join(f.root, 'selected codex.exe'); copyFileSync(f.spec.realExe, realExe);
  mkdirSync(path.dirname(settings), { recursive: true }); mkdirSync(official, { recursive: true }); mkdirSync(authHome);
  writeFileSync(settings, '{}');
  writeFileSync(path.join(official, 'package.json'), '{"publisher":"openai","name":"chatgpt","version":"1.2.3"}');
  const codexConfig = path.join(authHome, 'config.toml'), authFile = path.join(authHome, 'auth.json');
  writeFileSync(codexConfig, '[windows]\nsandbox="elevated"\n'); writeFileSync(authFile, 'private fixture auth');
  const originalPlan = readFileSync(f.planPath, 'utf8');
  const plan = { ...f.plan, schema_version: 2, run: { ...f.plan.run, execution_limits: { maxWakeTurns: 4, maxCorrectionsPerTask: null } },
    tasks: f.plan.tasks.map(task => ({ ...task, agent: { ...task.agent, permissionProfileId: task.id === 'B' ? 'read-only' : 'workspace' } })) };
  const v2 = originalPlan.replace(JSON.stringify(f.plan), JSON.stringify(plan));
  writeFileSync(f.planPath, v2);
  const environmentPath = path.join(f.root, 'environment.json');
  const environment = { envRoot, codeExe: process.execPath, extensionDirectory: official, selectedTools: {
    codex: { sha256: hash(realExe), version: '0.0.0' }, node: { sha256: hash(process.execPath), version: process.version },
    code: { sha256: hash(process.execPath), version: '1.2.3' } } };
  writeFileSync(environmentPath, JSON.stringify(environment));
  const binding = { environmentRoot: envRoot, parentThreadId: 'exact-parent-thread', planPath: f.planPath, repositoryPath: f.repository,
    repositoryId: 'explicit-repo', branchScope: ['cc05-integration'], stateDirectory: path.join(envRoot, 'state'),
    coordinator: { model: 'mock', effort: 'low' }, executionLimits: { maxWakeTurns: null, maxCorrectionsPerTask: 2 },
    permissionPermit: { allowedProfileIds: ['workspace', 'read-only'], writableRoots: [f.trees], allowedReviewers: ['auto_review'] } };
  const request = { ...f.spec, realExe, settings, codexConfig, installDirectory: path.join(envRoot, 'installation'),
    controlConfig: path.join(envRoot, 'control.json'), prepare: binding };
  const invoke = (input: unknown, selection = environment, env = process.env) => {
    writeFileSync(f.request, JSON.stringify(input)); writeFileSync(environmentPath, JSON.stringify(selection));
    return spawnSync('powershell.exe', ['-NoProfile', '-File', 'scripts/install.ps1', '-NodeExe', process.execPath,
      '-ConfigPath', f.request, '-Prepare', '-EnvironmentPath', environmentPath], { encoding: 'utf8', windowsHide: true, env });
  };
  for (const invalid of [
    { ...binding, parentThreadId: '' }, { ...binding, parentSessionKind: 'cli' }, { ...binding, repositoryPath: f.trees }, { ...binding, branchScope: ['source'] },
    { ...binding, executionLimits: { maxWakeTurns: 0, maxCorrectionsPerTask: null } },
    { ...binding, permissionPermit: { ...binding.permissionPermit, allowedProfileIds: ['workspace'] } },
    { ...binding, permissionPermit: { ...binding.permissionPermit, writableRoots: [f.root] } }
  ]) {
    assert.notEqual(invoke({ ...request, prepare: invalid }).status, 0);
    assert(!existsSync(request.controlConfig));
  }
  const drifted = { ...environment, selectedTools: { ...environment.selectedTools, codex: { ...environment.selectedTools.codex, sha256: '0'.repeat(64) } } };
  const changedCodex = invoke(request, drifted);
  assert.notEqual(changedCodex.status, 0); assert.match(changedCodex.stderr, /codex_hash_mismatch/);
  assert.notEqual(invoke({ ...request, parentCwd: f.planPath }).status, 0);
  assert.notEqual(invoke(request, environment, { ...process.env, CODEX_HOME: authHome }).status, 0);
  const repositoryAuth = path.join(f.repository, 'config.toml');
  writeFileSync(repositoryAuth, readFileSync(codexConfig));
  assert.notEqual(invoke({ ...request, codexConfig: repositoryAuth }).status, 0);
  assert(!existsSync(request.controlConfig));
  const { parentThreadId: _pinnedParent, ...sessionBinding } = binding;
  const sessionConfig = path.join(envRoot, 'session-control.json');
  const dynamic = invoke({ ...request, controlConfig: sessionConfig, prepare: { ...sessionBinding, parentSessionKind: 'cli' } });
  assert.equal(dynamic.status, 0, dynamic.stderr);
  const sessionRelay = JSON.parse(readFileSync(sessionConfig, 'utf8')).mcp.parentRelay;
  assert.deepEqual(sessionRelay, { pipeName: sessionRelay.pipeName, mode: 'verified-start', sessionKind: 'cli' });
  const before = treeHashes(envRoot), authBefore = treeHashes(authHome);
  const prepared = invoke(request);
  assert.equal(prepared.status, 0, prepared.stderr);
  const spec = JSON.parse(prepared.stdout), config = JSON.parse(readFileSync(request.controlConfig, 'utf8'));
  assert.equal(spec.controlSha256, hash(request.controlConfig));
  assert.equal(config.mcp.parentRelay.threadId, 'exact-parent-thread');
  assert.equal(config.mcp.scope.planPath, f.planPath);
  assert.equal(config.mcp.scope.repositoryPath, f.repository);
  assert.equal(config.mcp.scope.repositoryId, 'explicit-repo');
  assert.deepEqual(config.mcp.scope.branchScope, ['cc05-integration']);
  assert.deepEqual(config.mcp.scope.permissionPermit, binding.permissionPermit);
  assert.deepEqual(config.executionLimits, binding.executionLimits);
  assert.deepEqual(config.mcp.wake, { model: 'mock', effort: 'low' });
  const { 'control.json': _control, ...after } = treeHashes(envRoot);
  assert.deepEqual(after, before); assert.deepEqual(treeHashes(authHome), authBefore);
  assert.notEqual(invoke(request).status, 0);
  assert.equal(hash(request.controlConfig), spec.controlSha256);
  assert.throws(() => install({ ...spec, settings: f.settings }), /prepared installation targets changed/);
  assert.throws(() => install({ ...spec, parentCwd: authHome }), /prepared installation targets changed/);
  const originalTrees = path.join(f.root, 'original-trees');
  renameSync(f.trees, originalTrees);
  symlinkSync(originalTrees, f.trees, 'junction');
  assert.throws(() => install(spec), /reparse path rejected/);
  renameSync(f.trees, path.join(f.root, 'alias-trees'));
  renameSync(originalTrees, f.trees);

  writeFileSync(request.controlConfig, JSON.stringify({ ...config, executionLimits: { maxWakeTurns: 10 } }));
  assert.throws(() => install(spec), /identity mismatch/);
  writeFileSync(request.controlConfig, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(f.planPath, v2 + '\n'); assert.throws(() => install(spec), /plan.*changed|identity mismatch/);
  writeFileSync(f.planPath, v2);
  writeFileSync(realExe, 'updated Codex bytes');
  assert.throws(() => install(spec), /validate compatibility/);
  copyFileSync(f.spec.realExe, realExe);
  assert(!existsSync(request.installDirectory));
  const { installationTarget: _target, ...manualConfig } = config;
  writeFileSync(f.spec.controlConfig, JSON.stringify({ ...manualConfig, executionLimits: { maxWakeTurns: 2 },
    mcp: { ...config.mcp, wake: { ...config.mcp.wake, maxTurns: 1 } } }));
  assert.throws(() => install({ ...f.spec, realExe, codexConfig }), /conflicting maxWakeTurns/);
  assert(!existsSync(f.spec.installDirectory));
  const installed = install(spec);
  assert.equal(installed.automaticStart, false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(request.installDirectory, 'control.json'), 'utf8')), config);
  assert(!existsSync(binding.stateDirectory), 'installation must not start a run');
  mkdirSync(binding.stateDirectory); writeFileSync(path.join(binding.stateDirectory, 'result'), 'keep run state');
  writeFileSync(path.join(f.repository, 'worker-result'), 'keep Git result');
  const userSettings = '{"chatgpt.cliExecutable":"user-new.exe","editor.fontSize":23}';
  writeFileSync(settings, userSettings);
  const userConfig = readFileSync(codexConfig, 'utf8') + 'startup_timeout_sec = 90\n'; writeFileSync(codexConfig, userConfig);
  const restore = spawnSync('powershell.exe', ['-NoProfile', '-File', 'scripts/uninstall.ps1', '-NodeExe', process.execPath,
    '-ConfigPath', installed.receipt], { encoding: 'utf8', windowsHide: true });
  assert.equal(restore.status, 0, restore.stderr);
  const restored = JSON.parse(restore.stdout);
  assert.equal(restored.state, 'restored'); assert.equal(restored.retained.length, 2);
  assert.equal(readFileSync(settings, 'utf8'), userSettings);
  assert.equal(readFileSync(codexConfig, 'utf8'), userConfig);
  assert.equal(readFileSync(path.join(binding.stateDirectory, 'result'), 'utf8'), 'keep run state');
  assert.equal(readFileSync(path.join(f.repository, 'worker-result'), 'utf8'), 'keep Git result');
  assert.equal(readFileSync(authFile, 'utf8'), 'private fixture auth');
});

test('generated_snapshot_settings_install_and_restore_with_existing_receipt_contract', t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const envRoot = path.join(f.root, '専用 環境'), authHome = path.join(f.root, 'auth'), official = path.join(f.root, 'official');
  mkdirSync(authHome); mkdirSync(official);
  writeFileSync(path.join(authHome, 'auth.json'), 'private fixture auth');
  writeFileSync(path.join(authHome, 'config.toml'), '# preserve me\n[windows]\nsandbox="elevated"\n');
  writeFileSync(path.join(official, 'package.json'), JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: '1.2.3' }));
  const input = { implementationRoot: process.cwd(), envRoot, authHome, codexExe: f.spec.realExe, nodeExe: process.execPath,
    codeExe: process.execPath, extensionDirectory: official, selectedTools: {
      codex: { sha256: hash(f.spec.realExe), version: '1.2.3' }, node: { sha256: hash(process.execPath), version: process.version },
      code: { sha256: hash(process.execPath), version: '1.2.3' } } };
  const env = prepareEnvironment(input, inspectEnvironment(input));
  const snapshot = snapshotBuild(env, recordBuildCompletion(input.implementationRoot));
  const run = prepareRun(env, snapshot, { kind: 'serial', planPath: f.planPath, repositoryPath: f.repository,
    parentCwd: f.repository, parentThreadId: 'explicit-parent', repositoryId: 'repo', branchScope: ['cc05-integration'],
    agent: { model: 'mock', effort: 'low' } });
  const spec = JSON.parse(readFileSync(run.installSpec, 'utf8'));
  assert.deepEqual(inspectInstallation(spec, input).blockers, []);
  const before = readFileSync(spec.settings, 'utf8'), auth = readFileSync(spec.codexConfig, 'utf8');
  const result = install(spec); assert.equal(result.state, 'installed');
  const receipt = JSON.parse(readFileSync(result.receipt, 'utf8'));
  for (const [file, expected] of Object.entries(receipt.artifacts)) assert.equal(hash(file), expected);
  assert.equal(uninstall(result.receipt).state, 'restored');
  // Removing an inserted key can leave whitespace; retain the original settings values.
  assert.deepEqual(JSON.parse(readFileSync(spec.settings, 'utf8')), JSON.parse(before));
  assert.equal(readFileSync(spec.codexConfig, 'utf8'), auth);
  // The copied runtime resolves its dependencies and migrations outside the checkout.
  const smoke = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const {Store}=await import(process.argv[1]); const s=new Store(process.argv[2],process.argv[3]); s.close();',
    pathToFileURL(path.join(snapshot.root, 'dist/src/store.js')).href,
    path.join(f.root, 'smoke-state'), f.repository], { encoding: 'utf8', windowsHide: true });
  assert.equal(smoke.status, 0, smoke.stderr);
});
