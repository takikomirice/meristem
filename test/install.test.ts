import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { serialFixture } from './fixtures/serial-git.js';
import ts from 'typescript';

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
test('uninstall_preserves_new_user_value', () => {
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
