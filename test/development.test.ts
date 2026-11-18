import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileHash } from '../src/plan.js';
import * as development from '../src/development.js';
import { inspectEnvironment, type EnvironmentInput } from '../src/development.js';
import { developmentCommand } from './live/development.js';
import { developmentDriver } from './live/development-session.js';
import { EventEmitter } from 'node:events';

test('dedicated_vscode_launch_does_not_hide_its_normal_close_window', { skip: process.platform !== 'win32' }, async t => {
  const previousHook = process.env.VSCODE_IPC_HOOK, previousPid = process.env.VSCODE_PID;
  process.env.VSCODE_IPC_HOOK = 'foreign-parent-binding'; process.env.VSCODE_PID = '999999';
  t.after(() => {
    if (previousHook === undefined) delete process.env.VSCODE_IPC_HOOK; else process.env.VSCODE_IPC_HOOK = previousHook;
    if (previousPid === undefined) delete process.env.VSCODE_PID; else process.env.VSCODE_PID = previousPid;
  });
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  const session = JSON.parse(readFileSync(run.sessionFile, 'utf8'));
  let launchOptions: any;
  t.mock.method(childProcess, 'spawn', (_exe: string, _args: string[], options: any) => {
    launchOptions = options;
    const child = Object.assign(new EventEmitter(), { pid: 123, unref() {} });
    queueMicrotask(() => child.emit('spawn')); return child;
  });
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout: JSON.stringify({ pid: 123, created: 'owned', executable: f.input.codeExe }) }));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await developmentDriver(f.env).launch(session);
  assert.equal(launchOptions.windowsHide, false, 'the dedicated interactive window must be available for normal close');
  assert.equal(launchOptions.env.CODEX_HOME, f.input.authHome);
  assert.equal(launchOptions.env.VSCODE_IPC_HOOK, undefined);
  assert.equal(launchOptions.env.VSCODE_PID, undefined);
});

test('sandbox_probe_is_explicit_bounded_and_never_weakens_policy', async t => {
  const base = fixture(t), f = { ...base, env: development.prepareEnvironment(base.input, inspectEnvironment(base.input)) };
  const config = path.join(f.input.authHome, 'config.toml');
  const before = readFileSync(config), calls: any[] = [];
  t.mock.method(childProcess, 'spawnSync', (exe: string, args: string[], options: any) => {
    calls.push({ exe, args, options });
    return { status: null, signal: 'SIGTERM', error: Object.assign(new Error(secret), { code: 'ETIMEDOUT' }), stdout: secret, stderr: secret };
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const args = ['sandbox-probe', '--environment', f.env.envRoot, '--probe-id', 'bounded', '--sandbox', 'elevated', '--timeout-ms', '1000'];
  await assert.rejects(developmentCommand(args), /live/); assert.equal(calls.length, 0);
  for (const timeout of ['0', 'NaN', 'Infinity', '30001']) {
    await assert.rejects(developmentCommand([...args.slice(0, -1), timeout, '--live']), /timeout/);
  }
  const result = await developmentCommand([...args, '--live']);
  assert.equal(calls.length, 1); assert.equal(calls[0].exe, f.input.codexExe);
  assert.equal(calls[0].options.timeout, 1000); assert.equal(calls[0].options.env.CODEX_HOME, f.input.authHome);
  assert(calls[0].args.includes('--include-managed-config'));
  assert(calls[0].args.includes('windows.sandbox="elevated"'));
  assert(calls[0].args.includes('features.prefer_mxc=false'));
  assert(calls[0].args.some((a: string) => a.includes('filesystem=') && a.includes('="deny"')));
  assert(!calls[0].args.some((a: string) => /unelevated|danger-full-access|setup/.test(a)));
  assert.equal(result.phase, 'unknown'); assert.equal(result.failure, 'timeout'); assert.equal(result.modelTurnsSent, 0);
  assert.equal(result.ownedProcessesStopped, 'unconfirmed');
  assert.equal(result.authLeaseHash, fileHash(readFileSync(path.join(f.input.authHome, '.meristem-development-lease.json'))));
  assert(!JSON.stringify(result).includes(secret)); assert.deepEqual(readFileSync(config), before);
  await assert.rejects(developmentCommand([...args, '--live']), /lease|exist|reserved/);
  assert.equal(calls.length, 1);
});

test('sandbox_probe_preserves_config_and_reserves_each_attempt_without_automatic_fallback', async t => {
  const base = fixture(t), f = { ...base, env: development.prepareEnvironment(base.input, inspectEnvironment(base.input)) };
  const before = tree(f.input.authHome);
  let calls = 0;
  t.mock.method(childProcess, 'spawnSync', () => { calls++; return { status: 0, signal: null, stdout: '', stderr: '' }; });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const args = ['sandbox-probe', '--environment', f.env.envRoot, '--probe-id', 'once', '--sandbox', 'mxc', '--live'];
  const result = await developmentCommand(args);
  assert.equal(result.phase, 'observed'); assert.equal(result.managedReadDenied, 'observed');
  assert.equal(result.uacPrompts, 'unconfirmed'); assert.equal(result.explicitSetupCalls, 0);
  assert.deepEqual(tree(f.input.authHome), before);
  await assert.rejects(developmentCommand(args), /exist|reserved/); assert.equal(calls, 1);
  writeFileSync(f.input.codexExe, 'changed executable');
  await assert.rejects(developmentCommand([...args.slice(0, 4), 'other', ...args.slice(5)]), /identity|blocker|changed/);
  assert.equal(calls, 1);
});

test('cycle_records_two_runs_in_one_environment_and_keeps_unknown_observations_explicit', async t => {
  const f = lifecycleFixture(t), scenarioFile = path.join(f.root, 'scenario.json'), snapshotFile = path.join(f.root, 'snapshot.json');
  writeFileSync(scenarioFile, JSON.stringify(f.scenarioInput)); writeFileSync(snapshotFile, JSON.stringify(f.snapshot));
  const before = tree(f.input.authHome), ids: string[] = [];
  const args = ['cycle', '--environment', f.env.envRoot, '--snapshot', snapshotFile, '--scenario', scenarioFile, '--live'];
  for (let i = 0; i < 2; i++) {
    const result = await developmentCommand(args, undefined, f.driver);
    assert.equal(result.phase, 'restored'); assert.equal(result.source, 'fixture'); ids.push(result.run.id);
    assert.equal(result.modelTurnsSent, 0); assert.equal(result.explicitSetupCalls, 0);
    assert.equal(result.uacPrompts, 'unconfirmed'); assert.equal(result.humanOperations, 'unconfirmed');
    assert.equal(result.windowRestarts, 'unconfirmed'); assert(result.elapsedMs >= 0);
    assert.deepEqual(result.steps.map((s: any) => s.action), ['prepare', 'start', 'status', 'stop', 'restore']);
    assert.deepEqual(tree(f.input.authHome), before);
    assert.deepEqual(JSON.parse(readFileSync(path.join(path.dirname(result.run.sessionFile), 'cycle.json'), 'utf8')), result);
  }
  assert.notEqual(ids[0], ids[1]); assert.equal(f.launches(), 2);
  writeFileSync(scenarioFile, JSON.stringify({ ...f.scenarioInput, approvedMaxTurns: 1 }));
  await assert.rejects(developmentCommand(args, undefined, f.driver), /zero/); assert.equal(f.launches(), 2);
});

test('cycle_stops_after_unknown_exit_without_restoring_or_starting_a_second_run', async t => {
  const f = lifecycleFixture(t), scenarioFile = path.join(f.root, 'scenario.json'), snapshotFile = path.join(f.root, 'snapshot.json');
  writeFileSync(scenarioFile, JSON.stringify(f.scenarioInput)); writeFileSync(snapshotFile, JSON.stringify(f.snapshot));
  const driver = { ...f.driver, async stop() { return 'unknown' as const; } };
  const result = await developmentCommand(['cycle', '--environment', f.env.envRoot, '--snapshot', snapshotFile, '--scenario', scenarioFile, '--live'], undefined, driver);
  assert.equal(result.phase, 'unknown'); assert.equal(result.steps.at(-1).action, 'stop');
  await assert.rejects(developmentCommand(['cycle', '--environment', f.env.envRoot, '--snapshot', snapshotFile, '--scenario', scenarioFile, '--live'], undefined, driver), /lease/);
  assert.equal(f.launches(), 1);
});

test('cycle_does_not_report_success_when_prelaunch_failed_but_cleanup_succeeded', async t => {
  const f = lifecycleFixture(t), scenarioFile = path.join(f.root, 'scenario.json'), snapshotFile = path.join(f.root, 'snapshot.json');
  writeFileSync(scenarioFile, JSON.stringify(f.scenarioInput)); writeFileSync(snapshotFile, JSON.stringify(f.snapshot));
  let idleCalls = 0;
  const driver = { ...f.driver, async assertIdle(s: development.DevelopmentSession) { if (!idleCalls++) throw new Error(secret); return f.driver.assertIdle(s); } };
  const result = await developmentCommand(['cycle', '--environment', f.env.envRoot, '--snapshot', snapshotFile, '--scenario', scenarioFile, '--live'], undefined, driver);
  assert.equal(result.phase, 'unknown'); assert.equal(result.cleanupPhase, 'restored');
  assert.equal(result.limitedCheck, 'unconfirmed'); assert.equal(f.launches(), 0);
  assert(!JSON.stringify(result).includes(secret));
});

test('logic_refresh_runs_tests_without_vscode', async t => {
  const f = fixture(t), before = tree(f.input.authHome);
  const file = path.join(f.input.implementationRoot, 'dist/test/related.test.js');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(path.join(f.root, 'tested'))}, 'ran');`);
  const result = await developmentCommand(['refresh', '--change', 'logic', '--test', file], f.input.implementationRoot);
  assert.equal(result.action, 'tests_only'); assert.equal(readFileSync(path.join(f.root, 'tested'), 'utf8'), 'ran');
  assert.deepEqual(tree(f.input.authHome), before);
  assert.equal(readFileSync(f.launchLog, 'utf8'), '');
  writeFileSync(file, 'process.exit(3)');
  await assert.rejects(developmentCommand(['refresh', '--change', 'logic', '--test', file], f.input.implementationRoot), /test/);
});

test('extension_refresh_stops_owned_run_before_reload_when_required', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  const original = tree(f.snapshot.root), events: string[] = [];
  f.put('extension/dist/src/extension.js', 'export const refreshed = true;');
  const next = development.snapshotBuild(f.env, development.recordBuildCompletion(f.input.implementationRoot));
  const driver = { ...f.driver,
    async stop(s: development.DevelopmentSession, p: development.DevelopmentProcess) { events.push('stop'); return f.driver.stop(s, p); },
    async launch(s: development.DevelopmentSession) {
      assert.equal((await development.statusDevelopmentRun(f.env, run, f.driver)).phase, 'restored');
      assert.notEqual(s.id, run.id); assert.equal(s.snapshot.id, next.id);
      events.push('reload_new_host'); return f.driver.launch(s);
    } };
  const result = await development.refreshDevelopmentRun(f.env, run, { change: 'extension', snapshot: next, scenario: f.scenarioInput }, driver);
  assert.equal(result.action, 'reload_window'); assert.deepEqual(events, ['stop', 'reload_new_host']);
  assert.equal(result.phase, 'running'); assert.deepEqual(tree(f.snapshot.root), original);
  await assert.rejects(development.startDevelopmentRun(f.env, run, driver), /already/);
  await development.stopDevelopmentRun(f.env, result.run, f.driver);
  await development.restoreDevelopmentRun(f.env, result.run, f.driver);
});

test('runtime_refresh_uses_new_snapshot_after_confirmed_stop', async t => {
  for (const change of ['runtime', 'launch', 'unrecognized']) {
    const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
    await development.startDevelopmentRun(f.env, run, f.driver);
    f.put('dist/src/cli.js', 'export const next = true;');
    const snapshot = development.snapshotBuild(f.env, development.recordBuildCompletion(f.input.implementationRoot));
    const result = await development.refreshDevelopmentRun(f.env, run, { change, snapshot, scenario: f.scenarioInput }, f.driver);
    assert.equal(result.action, 'restart_session'); assert.equal(result.phase, 'running');
    assert.notEqual(result.run.id, run.id); assert.notEqual(result.run.stateDirectory, run.stateDirectory);
    assert.equal(result.run.snapshot.id, snapshot.id);
    assert.equal(JSON.parse(readFileSync(result.run.sessionFile, 'utf8')).approvedMaxTurns, 0);
    assert(!fs.existsSync(path.join(run.stateDirectory, 'control.sqlite')));
    await development.stopDevelopmentRun(f.env, result.run, f.driver);
    await development.restoreDevelopmentRun(f.env, result.run, f.driver);
  }
});

test('refresh_unknown_stop_and_duplicate_delivery_never_launch', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  const snapshot = development.snapshotBuild(f.env, development.recordBuildCompletion(f.input.implementationRoot));
  f.setState('unknown');
  const options = { change: 'runtime', snapshot, scenario: f.scenarioInput };
  const result = await development.refreshDevelopmentRun(f.env, run, options, f.driver);
  assert.equal(result.phase, 'unknown'); assert.equal(f.launches(), 1);
  assert.equal(readdirSync(path.join(f.env.envRoot, 'runs')).length, 1);
  await assert.rejects(development.refreshDevelopmentRun(f.env, run, options, f.driver), /refresh|already|exist/);
  assert.equal(f.launches(), 1);
});

test('refresh_rechecks_official_selection_snapshot_and_live_gate_before_stopping', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  const snapshot = development.snapshotBuild(f.env, development.recordBuildCompletion(f.input.implementationRoot));
  const snapshotFile = path.join(f.root, 'next.json'), scenarioFile = path.join(f.root, 'scenario.json');
  writeFileSync(snapshotFile, JSON.stringify(snapshot)); writeFileSync(scenarioFile, JSON.stringify(f.scenarioInput));
  const args = ['refresh', '--change', 'runtime', '--environment', f.env.envRoot, '--session', run.sessionFile,
    '--snapshot', snapshotFile, '--scenario', scenarioFile];
  await assert.rejects(developmentCommand(args, f.input.implementationRoot, f.driver), /live/);
  const exe = f.input.codeExe, bytes = readFileSync(exe);
  writeFileSync(exe, 'unapproved-new-version');
  await assert.rejects(development.refreshDevelopmentRun(f.env, run, { change: 'runtime', snapshot, scenario: f.scenarioInput }, f.driver), /identity/);
  writeFileSync(exe, bytes);
  writeFileSync(path.join(snapshot.root, 'dist/src/cli.js'), 'corrupt');
  await assert.rejects(development.refreshDevelopmentRun(f.env, run, { change: 'runtime', snapshot, scenario: f.scenarioInput }, f.driver), /identity|snapshot/);
  assert.equal((await development.statusDevelopmentRun(f.env, run, f.driver)).phase, 'running');
  assert.equal(f.launches(), 1);
  await development.stopDevelopmentRun(f.env, run, f.driver); await development.restoreDevelopmentRun(f.env, run, f.driver);
});

test('acceptance_refresh_requires_independent_acceptance_without_touching_live_run', async () => {
  assert.deepEqual(await developmentCommand(['refresh', '--change', 'acceptance']),
    { action: 'fresh_acceptance', phase: 'not_run', runner: 'dist/test/live/acceptance.js' });
});

test('development_cli_prepares_inspects_and_runs_explicit_lifecycle_with_new_snapshot', async t => {
  const f = lifecycleFixture(t), inputFile = path.join(f.root, 'input.json'), scenarioFile = path.join(f.root, 'scenario.json');
  writeFileSync(inputFile, JSON.stringify(f.input)); writeFileSync(scenarioFile, JSON.stringify(f.scenarioInput));
  const before = tree(f.root);
  assert((await developmentCommand(['inspect', '--input', inputFile])).diagnostics);
  assert.deepEqual(tree(f.root), before);
  const run = await developmentCommand(['prepare', '--environment', f.env.envRoot, '--build-root', f.input.implementationRoot, '--scenario', scenarioFile]);
  const args = ['--environment', f.env.envRoot, '--session', run.sessionFile];
  await assert.rejects(developmentCommand(['start', ...args], undefined, f.driver), /live/);
  assert.equal((await developmentCommand(['status', ...args], undefined, f.driver)).phase, 'prepared');
  await developmentCommand(['start', ...args, '--live'], undefined, f.driver);
  // A completed build may be snapshotted while the old immutable snapshot is in use.
  const next = await developmentCommand(['prepare', '--environment', f.env.envRoot, '--build-root', f.input.implementationRoot]);
  assert(next.id && next.manifestHash); assert.notEqual(next.id, run.snapshot.id);
  const nextFile = path.join(f.root, 'snapshot.json'); writeFileSync(nextFile, JSON.stringify(next));
  const result = await developmentCommand(['refresh', ...args, '--change', 'runtime', '--snapshot', nextFile, '--scenario', scenarioFile, '--live'], undefined, f.driver);
  assert.equal(result.phase, 'running'); assert.notEqual(result.run.id, run.id);
  const successor = ['--environment', f.env.envRoot, '--session', result.run.sessionFile];
  assert.equal((await developmentCommand(['status', ...args], undefined, f.driver)).phase, 'restored');
  await developmentCommand(['stop', ...successor, '--live'], undefined, f.driver);
  assert.equal((await developmentCommand(['restore', ...successor, '--live'], undefined, f.driver)).phase, 'restored');
  assert.equal(f.launches(), 2);
});

test('refresh_reserves_once_and_records_successor_before_unknown_launch', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  const snapshot = development.snapshotBuild(f.env, development.recordBuildCompletion(f.input.implementationRoot));
  let release!: () => void, sends = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const driver = { ...f.driver,
    async stop(s: development.DevelopmentSession, p: development.DevelopmentProcess) { await waiting; return f.driver.stop(s, p); },
    async launch() { sends++; throw new Error('delivery unknown'); } };
  const options = { change: 'runtime', snapshot, scenario: f.scenarioInput };
  const pending = development.refreshDevelopmentRun(f.env, run, options, driver);
  await assert.rejects(development.refreshDevelopmentRun(f.env, run, options, driver), /exist|refresh/);
  const rejected = assert.rejects(pending, /ownership retained/); release(); await rejected;
  const next = JSON.parse(readFileSync(path.join(path.dirname(run.sessionFile), 'refresh-result.json'), 'utf8')).run;
  assert.notEqual(next.id, run.id);
  assert.equal((await development.statusDevelopmentRun(f.env, next, f.driver)).phase, 'unknown');
  await assert.rejects(development.refreshDevelopmentRun(f.env, run, options, driver));
  assert.equal(sends, 1);
});

test('refresh_rejects_incompatible_scenario_before_stopping_and_preserves_old_database', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  mkdirSync(run.stateDirectory); const db = path.join(run.stateDirectory, 'control.sqlite'); writeFileSync(db, 'old schema and evidence');
  const snapshot = development.snapshotBuild(f.env, development.recordBuildCompletion(f.input.implementationRoot));
  await assert.rejects(development.refreshDevelopmentRun(f.env, run, { change: 'runtime', snapshot,
    scenario: { ...f.scenarioInput, kind: 'parallel' } }, f.driver), /scenario/);
  assert.equal((await development.statusDevelopmentRun(f.env, run, f.driver)).phase, 'running');
  const result = await development.refreshDevelopmentRun(f.env, run, { change: 'runtime', snapshot, scenario: f.scenarioInput }, f.driver);
  assert.equal(readFileSync(db, 'utf8'), 'old schema and evidence');
  assert(!fs.existsSync(path.join(result.run.stateDirectory, 'control.sqlite')));
  await development.stopDevelopmentRun(f.env, result.run, f.driver); await development.restoreDevelopmentRun(f.env, result.run, f.driver);
});

function lifecycleFixture(t: test.TestContext) {
  const f = buildFixture(t);
  f.input.nodeExe = process.execPath;
  f.input.codexExe = path.resolve('.local/chat-control-build/MockCodex.exe');
  delete f.input.settingsFile;
  f.input.selectedTools!.node = { sha256: fileHash(readFileSync(process.execPath)), version: process.version };
  f.input.selectedTools!.codex = { sha256: fileHash(readFileSync(f.input.codexExe)), version: 'fixture' };
  const env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
  const snapshot = development.snapshotBuild(env, development.recordBuildCompletion(f.input.implementationRoot));
  const input = scenario(f);
  let state: 'running' | 'stopped' | 'unknown' = 'stopped', launches = 0;
  const driver: development.DevelopmentDriver = {
    async assertIdle() { assert.equal(state, 'stopped'); },
    async launch() { launches++; state = 'running'; return { pid: 123, created: 'fixture-creation', executable: f.input.codeExe }; },
    async status() { return state; },
    async stop() { return state === 'unknown' ? 'unknown' : (state = 'stopped'); },
  };
  return { ...f, env, snapshot, scenarioInput: input, driver, launches: () => launches, setState: (next: typeof state) => { state = next; } };
}

test('environment_reuse_preserves_auth_and_profile', async t => {
  assert.equal(typeof development.startDevelopmentRun, 'function');
  const f = lifecycleFixture(t), auth = tree(f.input.authHome);
  const settings = path.join(f.env.profileDirectory, 'User/settings.json');
  writeFileSync(settings, '{"editor.fontSize":19,"chatgpt.cliExecutable":"user.exe"}');
  let previous: development.DevelopmentRun | undefined;
  for (let i = 0; i < 2; i++) {
    const env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
    const run = development.prepareRun(env, f.snapshot, f.scenarioInput);
    assert.notEqual(run.id, previous?.id);
    await development.startDevelopmentRun(env, run, f.driver);
    assert.equal((await development.statusDevelopmentRun(env, run, f.driver)).phase, 'running');
    await development.stopDevelopmentRun(env, run, f.driver);
    assert.equal((await development.restoreDevelopmentRun(env, run, f.driver)).phase, 'restored');
    assert.deepEqual(tree(f.input.authHome), auth);
    const restored = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(restored['editor.fontSize'], 19); assert.equal(restored['chatgpt.cliExecutable'], 'user.exe');
    previous = run;
  }
  assert.equal(f.launches(), 2); assert.equal(readFileSync(f.launchLog, 'utf8'), '');
});

test('concurrent_environment_use_is_rejected', async t => {
  assert.equal(typeof development.startDevelopmentRun, 'function');
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  const before = tree(f.env.envRoot), auth = tree(f.env.authHome);
  await assert.rejects(development.startDevelopmentRun(f.env, run, f.driver), /lease|already/);
  assert.throws(() => development.acquireDevelopmentAuthOperation(f.env.authHome), /lease/);
  assert.throws(() => development.prepareRun(f.env, f.snapshot, f.scenarioInput), /lease/);
  assert.throws(() => development.prepareEnvironment(f.input, inspectEnvironment(f.input)), /lease/);
  const other = { ...f.input, envRoot: path.join(f.root, 'other-env') };
  assert.throws(() => development.prepareEnvironment(other, inspectEnvironment(other)), /lease/);
  assert.deepEqual(tree(f.env.envRoot), before); assert.deepEqual(tree(f.env.authHome), auth);
  await development.stopDevelopmentRun(f.env, run, f.driver);
  await development.restoreDevelopmentRun(f.env, run, f.driver);
});

test('restore_preserves_later_user_edits', async t => {
  assert.equal(typeof development.startDevelopmentRun, 'function');
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  f.setState('unknown');
  assert.equal((await development.stopDevelopmentRun(f.env, run, f.driver)).phase, 'unknown');
  await assert.rejects(development.restoreDevelopmentRun(f.env, run, f.driver), /stop|unknown/);
  assert.throws(() => development.prepareRun(f.env, f.snapshot, f.scenarioInput), /lease/);
  f.setState('running');
  await development.stopDevelopmentRun(f.env, run, f.driver);
  const settings = path.join(f.env.profileDirectory, 'User/settings.json');
  writeFileSync(settings, '{"chatgpt.cliExecutable":"later.exe","editor.fontSize":27}');
  const config = path.join(f.env.authHome, 'config.toml');
  writeFileSync(config, readFileSync(config, 'utf8') + '\n[user]\nvalue="later"\n');
  await development.restoreDevelopmentRun(f.env, run, f.driver);
  assert.equal(readFileSync(settings, 'utf8'), '{"chatgpt.cliExecutable":"later.exe","editor.fontSize":27}');
  assert(readFileSync(config, 'utf8').endsWith('[user]\nvalue="later"\n'));
  assert(!readFileSync(config, 'utf8').includes('[mcp_servers.meristem]'));
  assert.equal((await development.restoreDevelopmentRun(f.env, run, f.driver)).phase, 'restored');
});

test('unknown_launch_is_never_resent_and_keeps_both_leases', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  const driver = { ...f.driver, async launch(): Promise<development.DevelopmentProcess> { throw new Error('delivery unknown'); } };
  await assert.rejects(development.startDevelopmentRun(f.env, run, driver), /ownership retained/);
  assert.equal((await development.stopDevelopmentRun(f.env, run, driver)).phase, 'unknown');
  await assert.rejects(development.restoreDevelopmentRun(f.env, run, driver), /unknown/);
  await assert.rejects(development.startDevelopmentRun(f.env, run, driver), /already/);
  assert.throws(() => development.prepareRun(f.env, f.snapshot, f.scenarioInput), /lease/);
});

test('edited_mcp_receipt_and_reopened_profile_never_release_ownership', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  await development.stopDevelopmentRun(f.env, run, f.driver);
  f.setState('running');
  await assert.rejects(development.restoreDevelopmentRun(f.env, run, f.driver));
  f.setState('stopped');
  const config = path.join(f.env.authHome, 'config.toml');
  const installed = readFileSync(config, 'utf8');
  writeFileSync(config, installed.replace('"--pipe"', '"--edited"'));
  await assert.rejects(development.restoreDevelopmentRun(f.env, run, f.driver), /MCP.*lease/);
  assert(readFileSync(config, 'utf8').includes('"--edited"'));
  assert.throws(() => development.prepareRun(f.env, f.snapshot, f.scenarioInput), /lease/);
  const receipt = path.join(path.dirname(run.sessionFile), 'installation/installation.json');
  writeFileSync(receipt, readFileSync(receipt, 'utf8') + ' ');
  const auth = readFileSync(config, 'utf8');
  await assert.rejects(development.restoreDevelopmentRun(f.env, run, f.driver), /identity/);
  assert.equal(readFileSync(config, 'utf8'), auth);
});

test('simultaneous_cli_stop_is_rejected_and_status_is_read_only', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  const before = tree(f.root);
  await development.statusDevelopmentRun(f.env, run, f.driver);
  assert.deepEqual(tree(f.root), before);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const stopping = development.stopDevelopmentRun(f.env, run, { ...f.driver, async stop(s, p) { await waiting; return f.driver.stop(s, p); } });
  await assert.rejects(development.stopDevelopmentRun(f.env, run, f.driver), /lease/);
  release(); assert.equal((await stopping).phase, 'stopped');
  await development.restoreDevelopmentRun(f.env, run, f.driver);
});

test('restore_retry_releases_only_its_own_remaining_lease_after_partial_release', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  await development.stopDevelopmentRun(f.env, run, f.driver);
  const leaseFile = path.join(f.env.authHome, '.meristem-development-lease.json');
  const ownLease = readFileSync(leaseFile, 'utf8');
  await development.restoreDevelopmentRun(f.env, run, f.driver);
  writeFileSync(leaseFile, ownLease); // Crash after the restored record, before the auth lease unlink.
  await development.restoreDevelopmentRun(f.env, run, f.driver);
  assert.equal(fs.existsSync(leaseFile), false);
  writeFileSync(leaseFile, '{"token":"another-owner"}');
  await development.restoreDevelopmentRun(f.env, run, f.driver);
  assert.equal(readFileSync(leaseFile, 'utf8'), '{"token":"another-owner"}');
});

test('preexisting_installation_receipt_is_never_adopted_by_failed_start', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  const directory = path.join(path.dirname(run.sessionFile), 'installation'); mkdirSync(directory);
  const receipt = path.join(directory, 'installation.json'); writeFileSync(receipt, '{"foreign":true}');
  const before = tree(f.env.authHome);
  await assert.rejects(development.startDevelopmentRun(f.env, run, { ...f.driver, async assertIdle() { throw new Error('busy'); } }));
  assert.equal(fs.existsSync(path.join(path.dirname(run.sessionFile), 'lifecycle.json')), false);
  assert.equal(readFileSync(receipt, 'utf8'), '{"foreign":true}');
  assert.deepEqual(tree(f.env.authHome), before);
});

test('stop_retry_keeps_confirmed_stop_and_still_allows_restore', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  await development.startDevelopmentRun(f.env, run, f.driver);
  await development.stopDevelopmentRun(f.env, run, f.driver);
  assert.equal((await development.statusDevelopmentRun(f.env, run, { ...f.driver, async status() { return 'unknown'; } })).phase, 'stopped');
  assert.equal((await development.stopDevelopmentRun(f.env, run, { ...f.driver, async stop() { return 'unknown'; } })).phase, 'stopped');
  await development.restoreDevelopmentRun(f.env, run, f.driver);
});

test('unrecorded_partial_install_receipt_keeps_lease_and_never_claims_restored', async t => {
  const f = lifecycleFixture(t), run = development.prepareRun(f.env, f.snapshot, f.scenarioInput);
  const authFile = path.join(f.env.authHome, 'config.toml'), auth = readFileSync(authFile, 'utf8');
  await development.startDevelopmentRun(f.env, run, f.driver);
  const file = path.join(path.dirname(run.sessionFile), 'lifecycle.json'), state = JSON.parse(readFileSync(file, 'utf8'));
  delete state.receipt; delete state.receiptHash; delete state.process;
  state.phase = 'prepared'; state.launchAttempted = false;
  writeFileSync(file, JSON.stringify(state)); writeFileSync(authFile, auth); f.setState('stopped');
  await development.stopDevelopmentRun(f.env, run, f.driver);
  await assert.rejects(development.restoreDevelopmentRun(f.env, run, f.driver), /receipt|unknown/);
  assert.throws(() => development.prepareRun(f.env, f.snapshot, f.scenarioInput), /lease/);
});

test('windows_process_lifecycle_checks_creation_and_preserves_foreign_process', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'meristem-de03-process-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'wait.js'); writeFileSync(script, 'setInterval(() => {}, 1000);');
  const launch = async (profile: string) => {
    const child = childProcess.spawn(process.execPath, [script, '--user-data-dir', profile], { windowsHide: true, stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); return child;
  };
  const profile = path.join(root, '専用 profile'), own = await launch(profile), other = await launch(path.join(root, 'other'));
  const check = (action: string, created = '') => childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/development-process.ps1'),
    '-Action', action, '-RequestJson', JSON.stringify({ pid: own.pid, created, executable: process.execPath, profile })], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
  const identified = check('identify'); assert.equal(identified.status, 0, identified.stderr);
  const identity = JSON.parse(identified.stdout);
  assert.notEqual(check('stop', 'wrong-created').status, 0);
  assert.equal(check('status', identity.created).status, 0);
  assert.notEqual(check('stop', identity.created).status, 0, 'a process without a window cannot be forcibly killed');
  assert.equal(check('status', identity.created).status, 0);
  process.kill(other.pid!, 0);
});

const secret = 'PRIVATE-token-cookie-model-and-log';
function forbidLaunches(t: test.TestContext) {
  const calls: string[] = [];
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    t.mock.method(childProcess, method, () => { calls.push(method); throw new Error('unexpected process launch'); });
  }
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'meristem-de01-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const implementationRoot = path.join(root, 'implementation'), envRoot = path.join(root, 'environment');
  const authHome = path.join(root, 'auth'), extensionDirectory = path.join(root, 'official-extension');
  for (const dir of [implementationRoot, envRoot, authHome, extensionDirectory]) mkdirSync(dir);
  const launchLog = path.join(root, 'launches'); writeFileSync(launchLog, '');
  // Real executable scripts leave a marker even for --version, setup or probes.
  const executable = process.platform === 'win32'
    ? `@echo off\r\necho launched>>"${launchLog}"\r\necho ${secret}\r\n`
    : `#!/bin/sh\nprintf launched >> '${launchLog}'\nprintf '${secret}'\n`;
  const files = ['codex', 'node', 'code'].map(name => {
    const file = path.join(root, name + (process.platform === 'win32' ? '.cmd' : ''));
    writeFileSync(file, executable + (process.platform === 'win32' ? `rem ${name}\r\n` : `# ${name}\n`)); chmodSync(file, 0o700); return file;
  });
  const settingsFile = path.join(envRoot, 'settings.json');
  writeFileSync(settingsFile, `{// ${secret}\n"chatgpt.cliExecutable": ${JSON.stringify(files[0])},}`);
  writeFileSync(path.join(authHome, 'auth.json'), JSON.stringify({ token: secret }));
  writeFileSync(path.join(authHome, 'config.toml'), `# ${secret}\n[windows]\nsandbox = "elevated"\n`);
  writeFileSync(path.join(extensionDirectory, 'package.json'), JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: '26.1111.21308', private: secret }));
  const input: EnvironmentInput = { implementationRoot, envRoot, authHome, extensionDirectory,
    codexExe: files[0], nodeExe: files[1], codeExe: files[2], settingsFile,
    selectedTools: {
      codex: { sha256: fileHash(readFileSync(files[0])), version: '0.169.0-alpha.11.1' },
      node: { sha256: fileHash(readFileSync(files[1])), version: '24.22.1' },
      code: { sha256: fileHash(readFileSync(files[2])), version: '1.106.0' },
    },
  };
  return { root, input, launchLog };
}
function tree(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true }).map(String).sort().map(name => {
    const file = path.join(root, name); return [name, statSync(file).isDirectory() ? 'directory' : readFileSync(file).toString('hex')];
  }));
}

test('inspect_does_not_start_sandbox_model_or_uac', t => {
  const f = fixture(t), before = tree(f.root), launches = forbidLaunches(t);
  const report = inspectEnvironment(f.input);
  assert.deepEqual(tree(f.root), before, 'every fixture file and directory must remain unchanged');
  assert.equal(readFileSync(f.launchLog, 'utf8'), '');
  assert.deepEqual(launches, [], 'no subprocess API may be called, including failed attempts');
  assert(!JSON.stringify(report).includes(secret));
  assert(!report.diagnostics.some(d => d.severity === 'blocker'), JSON.stringify(report));
  assert(report.diagnostics.some(d => d.code === 'sandbox_elevated'));
  assert(report.diagnostics.some(d => d.code === 'authentication_present'));
  assert(report.diagnostics.some(d => d.code === 'run_state_unknown'));
  assert.equal(report.tools.find(tool => tool.name === 'codex')?.path, f.input.codexExe);
});

test('inspect_reports_selected_executable_mismatch', t => {
  const f = fixture(t), originalPath = process.env.PATH;
  const other = path.join(f.root, 'path-bin'); mkdirSync(other);
  writeFileSync(path.join(other, process.platform === 'win32' ? 'codex.cmd' : 'codex'), 'different version');
  process.env.PATH = other; t.after(() => { process.env.PATH = originalPath; });
  const inputBefore = JSON.stringify(f.input);
  let report = inspectEnvironment(f.input);
  assert(report.diagnostics.some(d => d.code === 'path_codex_differs' && d.severity === 'warning'));
  assert.equal(report.tools.find(tool => tool.name === 'codex')?.path, f.input.codexExe);
  writeFileSync(f.input.codexExe, 'updated without approval');
  report = inspectEnvironment(f.input);
  assert(report.diagnostics.some(d => d.code === 'codex_hash_mismatch' && d.severity === 'blocker'));
  assert.equal(report.tools.find(tool => tool.name === 'codex')?.version, null);
  rmSync(f.input.codexExe);
  assert(inspectEnvironment(f.input).diagnostics.some(d => d.code === 'codex_unavailable' && d.severity === 'blocker'));
  assert.equal(JSON.stringify(f.input), inputBefore);
});

test('setup_failure_is_reported_without_retry_loop', t => {
  const f = fixture(t), launches = forbidLaunches(t);
  f.input.failures = [{ kind: 'logon', errorCode: 1909 }, { kind: 'setup' }, { kind: 'timeout' }];
  const report = inspectEnvironment(f.input);
  for (const code of ['logon_1909', 'setup_failed', 'operation_timeout']) {
    assert(report.diagnostics.some(d => d.code === code && d.severity === 'blocker'));
  }
  assert.equal(readFileSync(f.launchLog, 'utf8'), '', 'no setup, retry or fallback');
  assert.deepEqual(launches, []);
});

test('inspect_does_not_claim_sandbox_selection_for_duplicate_or_unsupported_toml', t => {
  const f = fixture(t), config = path.join(f.input.authHome, 'config.toml');
  for (const raw of ['[windows]\nsandbox = "elevated"\n[windows]\nsandbox = "mxc"\n',
    '[windows]\nsandbox = "elevated"\nsandbox = "mxc"\n',
    '[windows]\nsandbox = "unsupported"\n', `# ${secret}\nwindows.sandbox = "elevated"\n`]) {
    writeFileSync(config, raw);
    const report = inspectEnvironment(f.input);
    assert(report.diagnostics.some(d => d.code === 'sandbox_unknown'), raw);
    assert(!report.diagnostics.some(d => d.code === 'sandbox_elevated' || d.code === 'sandbox_mxc'));
  }
  for (const raw of ["note = '''\n[windows]\nsandbox = \"elevated\"\n'''\n",
    '[windows]\nsandbox = "elevated"\n"sandbox" = "mxc"\n',
    '[windows]\nsandbox = "elevated"\n["windows"]\nsandbox = "mxc"\n']) {
    writeFileSync(config, raw);
    assert(inspectEnvironment(f.input).diagnostics.some(d => d.code === 'sandbox_unknown'));
  }
});

test('inspect_preserves_existing_relay_binding_without_claiming_relay_authorization', t => {
  const f = fixture(t), relay = path.join(f.root, 'CodexRelay.exe');
  writeFileSync(relay, 'relay fixture bytes');
  writeFileSync(relay + '.json', JSON.stringify({ realExecutable: f.input.codexExe,
    realSha256: f.input.selectedTools!.codex!.sha256, secret }));
  writeFileSync(f.input.settingsFile!, JSON.stringify({ 'chatgpt.cliExecutable': relay }));
  let report = inspectEnvironment(f.input);
  assert(!report.diagnostics.some(d => d.code === 'settings_binding_mismatch'));
  assert(report.diagnostics.some(d => d.code === 'settings_relay_unverified' && d.severity === 'warning'));
  assert(!JSON.stringify(report).includes(secret));
  writeFileSync(relay + '.json', JSON.stringify({ realExecutable: f.input.codexExe, realSha256: '0'.repeat(64) }));
  report = inspectEnvironment(f.input);
  assert(report.diagnostics.some(d => d.code === 'settings_binding_mismatch' && d.severity === 'blocker'));
});

test('inspect_blocks_missing_selection_unsafe_roots_and_invalid_metadata_without_leaks', t => {
  const f = fixture(t);
  delete f.input.selectedTools;
  f.input.envRoot = path.join(f.input.implementationRoot, 'nested');
  writeFileSync(path.join(f.input.extensionDirectory, 'package.json'), secret);
  writeFileSync(f.input.settingsFile!, secret);
  const report = inspectEnvironment(f.input);
  for (const code of ['codex_selection_missing', 'environment_overlap', 'extension_invalid', 'settings_invalid']) {
    assert(report.diagnostics.some(d => d.code === code && d.severity === 'blocker'), code);
  }
  assert(!JSON.stringify(report).includes(secret));
});

test('inspect_checks_control_bindings_and_keeps_process_exit_unconfirmed', t => {
  const f = fixture(t), controlConfig = path.join(f.root, 'control.json'), sessionFile = path.join(f.root, 'session.json');
  f.input.controlConfig = controlConfig; f.input.sessionFiles = [sessionFile];
  writeFileSync(controlConfig, JSON.stringify({ nodeExecutable: f.input.nodeExe, nodeSha256: f.input.selectedTools!.node!.sha256,
    runtime: { realExe: f.input.codeExe, realSha256: f.input.selectedTools!.codex!.sha256, authHome: f.input.authHome, secret } }));
  writeFileSync(sessionFile, JSON.stringify({ launchPid: process.pid, phase: 'restored', secret }));
  const report = inspectEnvironment(f.input);
  assert(report.diagnostics.some(d => d.code === 'control_binding_mismatch' && d.severity === 'blocker'));
  assert(report.diagnostics.some(d => d.code === 'run_process_present'));
  assert(report.diagnostics.some(d => d.code === 'run_state_unknown'));
  assert(!JSON.stringify(report).includes(secret));
});

function buildFixture(t: test.TestContext) {
  const f = fixture(t), root = f.input.implementationRoot;
  const put = (relative: string, bytes: string) => {
    const file = path.join(root, relative); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes);
  };
  for (const name of ['cli', 'mcp', 'install']) put(`dist/src/${name}.js`, 'export {};\n');
  for (const name of ['CodexRelay', 'CodexWorkerHost', 'MeristemControl']) put(`.local/chat-control-build/${name}.exe`, name);
  put('package.json', JSON.stringify({ type: 'module', version: '0.1.0', dependencies: { yaml: '2.8.2' } }));
  put('package-lock.json', JSON.stringify({ packages: { '': { version: '0.1.0' }, 'node_modules/yaml': { version: '2.8.2' } } }));
  put('node_modules/yaml/package.json', JSON.stringify({ version: '2.8.2' }));
  put('node_modules/yaml/index.js', 'export {};');
  put('extension/package.json', JSON.stringify({ publisher: 'meristem-local', name: 'meristem-chat-control-fixture', main: './dist/src/extension.js' }));
  put('extension/dist/src/extension.js', 'export {};');
  put('migrations/001-control.sql', '-- fixture');
  put('.local/private-auth.json', secret);
  put('dist/test/private.js', secret);
  // Exercise generated absolute paths with both non-ASCII characters and spaces.
  f.input.envRoot = path.join(f.root, '専用 環境');
  return { ...f, put };
}
function scenario(f: ReturnType<typeof buildFixture>) {
  const repositoryPath = path.join(f.root, '試験 repo'), worktrees = path.join(f.root, 'trees');
  mkdirSync(repositoryPath); mkdirSync(worktrees);
  const planPath = path.join(f.root, 'plan.md');
  writeFileSync(planPath, `<!-- chat-control:plan:start -->\n${JSON.stringify({ schema_version: 1,
    run: { repository: repositoryPath, worktrees_root: worktrees, integration_branch: 'de-integration', max_parallel: 1 },
    tasks: [{ id: 'A', depends_on: [], scope: ['a.txt'], conflicts_with: [], agent: { model: 'mock', effort: 'low' }, completion: ['test'] }] })}\n<!-- chat-control:plan:end -->\n<!-- chat-control:progress:start -->\n<!-- chat-control:progress:end -->\n`);
  return { kind: 'serial' as const, planPath, repositoryPath, parentCwd: repositoryPath, parentThreadId: 'explicit-parent',
    repositoryId: 'fixture-repo', branchScope: ['de-integration'], agent: { model: 'mock', effort: 'low' } };
}

test('generated_paths_and_hashes_match_snapshot', t => {
  const f = buildFixture(t), authBefore = tree(f.input.authHome), launches = forbidLaunches(t);
  assert.equal(typeof development.prepareEnvironment, 'function', 'DE-02 environment preparation is required');
  const env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
  const completed = development.recordBuildCompletion(f.input.implementationRoot);
  const snapshot = development.snapshotBuild(env, completed, 'build-日本語');
  const run = development.prepareRun(env, snapshot, scenario(f));
  const config = JSON.parse(readFileSync(run.controlConfig, 'utf8'));
  for (const [file, sha] of [[config.entryPoint, config.entrySha256], [config.mcp.entryPoint, config.mcp.entrySha256],
    [config.runtime.hostExe, config.runtime.hostSha256]]) {
    assert.equal(fileHash(readFileSync(file)), sha); assert(file.startsWith(snapshot.root + path.sep));
  }
  const spec = JSON.parse(readFileSync(run.installSpec, 'utf8'));
  assert.equal(spec.implementationRoot, snapshot.root);
  assert.equal(spec.helperExtension, path.join(snapshot.root, 'extension'));
  assert.equal(spec.codexConfig, path.join(f.input.authHome, 'config.toml'));
  assert.equal(config.runtime.realExe, f.input.codexExe);
  assert.equal(config.nodeExecutable, f.input.nodeExe);
  assert.equal(readFileSync(path.join(snapshot.root, 'node_modules/yaml/index.js'), 'utf8'), 'export {};');
  assert(!JSON.stringify(tree(snapshot.root)).includes(secret));
  assert.deepEqual(tree(f.input.authHome), authBefore); assert.deepEqual(launches, []);
  assert.equal(readFileSync(f.launchLog, 'utf8'), '');
});

test('snapshot_never_overwrites_live_build', t => {
  const f = buildFixture(t), env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
  const completed = development.recordBuildCompletion(f.input.implementationRoot);
  const first = development.snapshotBuild(env, completed, 'build-one'), before = tree(first.root);
  development.prepareRun(env, first, scenario(f));
  f.put('dist/src/cli.js', 'export const changed = true;');
  assert.throws(() => development.snapshotBuild(env, completed, 'build-two'), /changed|completion/);
  const next = development.recordBuildCompletion(f.input.implementationRoot);
  assert.throws(() => development.snapshotBuild(env, next, 'build-one'), /exist|new/);
  for (const id of ['../escape', '..', 'a/b', 'a\\b', 'C:escape']) {
    assert.throws(() => development.snapshotBuild(env, next, id), /ID|id/);
  }
  const second = development.snapshotBuild(env, next, 'build-two');
  assert.notEqual(first.root, second.root); assert.deepEqual(tree(first.root), before);
  writeFileSync(path.join(second.root, 'dist/src/mcp.js'), 'corrupted');
  assert.throws(() => development.prepareRun(env, second, scenarioForExisting(f)), /snapshot|identity|changed/);
});
function scenarioForExisting(f: ReturnType<typeof buildFixture>) {
  return { kind: 'serial' as const, planPath: path.join(f.root, 'plan.md'), repositoryPath: path.join(f.root, '試験 repo'),
    parentCwd: path.join(f.root, '試験 repo'), parentThreadId: 'another-parent', repositoryId: 'fixture-repo',
    branchScope: ['de-integration'], agent: { model: 'mock', effort: 'low' } };
}

test('new_run_never_reuses_identity_or_budget', t => {
  const f = buildFixture(t), env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
  const snapshot = development.snapshotBuild(env, development.recordBuildCompletion(f.input.implementationRoot));
  const input = scenario(f), first = development.prepareRun(env, snapshot, { ...input, approvedMaxTurns: 8, maxInstructions: 3 });
  const oldSession = JSON.parse(readFileSync(first.sessionFile, 'utf8'));
  Object.assign(oldSession, { turnsSent: 8, ownerId: 'old-owner', ownerEpoch: 'old-epoch', permit: 'old-permit' });
  writeFileSync(first.sessionFile, JSON.stringify(oldSession));
  const second = development.prepareRun(env, snapshot, input);
  for (const field of ['id', 'stateDirectory', 'sessionFile'] as const) assert.notEqual(first[field], second[field]);
  const a = JSON.parse(readFileSync(first.controlConfig, 'utf8')), b = JSON.parse(readFileSync(second.controlConfig, 'utf8'));
  assert.notEqual(a.pipeName, b.pipeName); assert.notEqual(a.mcp.parentRelay.pipeName, b.mcp.parentRelay.pipeName);
  assert.equal(b.mcp.scope.maxInstructions, 0); assert.equal(b.mcp.wake, undefined);
  const current = JSON.parse(readFileSync(second.sessionFile, 'utf8'));
  assert.equal(current.approvedMaxTurns, 0); assert.equal(current.turnsSent, 0);
  for (const key of ['ownerId', 'ownerEpoch', 'permit', 'attemptId']) assert.equal(current[key], undefined);
  assert.deepEqual(b.assignments, []); assert.deepEqual(b.mcp.scope.assignments, []);
  for (const approvedMaxTurns of [-1, Infinity, 21, 1.5]) assert.throws(() => development.prepareRun(env, snapshot, { ...input, approvedMaxTurns }));
  assert.throws(() => development.prepareRun(env, snapshot, { ...input, approvedMaxTurns: 20, maxInstructions: 0 }), /wake budget/);
  const bounded = development.prepareRun(env, snapshot, { ...input, approvedMaxTurns: 20, maxInstructions: 8 });
  assert.equal(JSON.parse(readFileSync(bounded.controlConfig, 'utf8')).mcp.wake.maxTurns, 12);
});

test('snapshot_rejects_inputs_changed_during_copy_and_never_commits_partial_output', t => {
  const f = buildFixture(t), env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
  const completed = development.recordBuildCompletion(f.input.implementationRoot), copy = fs.copyFileSync;
  let changed = false;
  t.mock.method(fs, 'copyFileSync', (...args: Parameters<typeof fs.copyFileSync>) => {
    copy(...args);
    if (!changed) { changed = true; f.put('dist/src/cli.js', 'changed during copying'); }
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => development.snapshotBuild(env, completed, 'incomplete'), /changed|identity/);
  assert(!fs.existsSync(path.join(env.envRoot, 'snapshots/incomplete/snapshot.json')));
});

test('prepare_rechecks_selections_manifest_and_existing_files_without_overwriting', t => {
  const f = buildFixture(t), report = inspectEnvironment(f.input);
  writeFileSync(f.input.codexExe, 'unapproved update');
  assert.throws(() => development.prepareEnvironment(f.input, report), /blocker/);
  assert(!fs.existsSync(f.input.envRoot));
  f.input.selectedTools!.codex!.sha256 = fileHash(readFileSync(f.input.codexExe));
  const env = development.prepareEnvironment(f.input, inspectEnvironment(f.input)), before = tree(env.envRoot);
  assert.deepEqual(development.prepareEnvironment(f.input, inspectEnvironment(f.input)), env);
  assert.deepEqual(tree(env.envRoot), before);
  writeFileSync(path.join(env.envRoot, 'environment.json'), '{"changed":true}');
  assert.throws(() => development.snapshotBuild(env, development.recordBuildCompletion(f.input.implementationRoot)), /manifest changed/);
  assert.equal(readFileSync(path.join(env.envRoot, 'environment.json'), 'utf8'), '{"changed":true}');
});

test('snapshot_rejects_unsafe_dependency_paths_and_symlink_inputs', t => {
  const f = buildFixture(t);
  f.put('package-lock.json', JSON.stringify({ packages: { '../escape': { version: '1.0.0' } } }));
  assert.throws(() => development.recordBuildCompletion(f.input.implementationRoot), /path rejected/);
  f.put('package-lock.json', JSON.stringify({ packages: { '': { version: '0.1.0' } } }));
  const source = path.join(f.root, 'outside'); mkdirSync(source); writeFileSync(path.join(source, 'secret.js'), secret);
  fs.symlinkSync(source, path.join(f.input.implementationRoot, 'dist/src/outside'), 'junction');
  // Directory links in a JS-only output must also be rejected, not silently ignored.
  assert.throws(() => development.recordBuildCompletion(f.input.implementationRoot), /reparse|path rejected/);
});

test('preparation_pins_official_extension_and_detects_concurrent_generated_config_edits', t => {
  const f = buildFixture(t), report = inspectEnvironment(f.input);
  const pkg = path.join(f.input.extensionDirectory, 'package.json'), original = readFileSync(pkg);
  writeFileSync(pkg, JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: '99.0.0' }));
  assert.throws(() => development.prepareEnvironment(f.input, report), /changed|stale/);
  writeFileSync(pkg, original);
  const env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
  const completed = development.recordBuildCompletion(f.input.implementationRoot);
  writeFileSync(pkg, JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: '99.0.0' }));
  assert.throws(() => development.snapshotBuild(env, completed), /identity|extension/);
  writeFileSync(pkg, original);
  const snapshot = development.snapshotBuild(env, completed), input = scenario(f), write = fs.writeFileSync;
  let edited: string | undefined;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    write(...args);
    if (String(args[0]).endsWith('install.json')) {
      edited = path.join(path.dirname(String(args[0])), 'control.json'); write(edited, 'user edit');
    }
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => development.prepareRun(env, snapshot, input), /identity|changed/);
  assert.equal(readFileSync(edited!, 'utf8'), 'user edit');
  assert(!fs.existsSync(path.join(path.dirname(edited!), 'session.json')));
});

test('prepare_rejects_concurrent_generated_plan_edits_before_session_commit', t => {
  const f = buildFixture(t), env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
  const snapshot = development.snapshotBuild(env, development.recordBuildCompletion(f.input.implementationRoot));
  const input = scenario(f), write = fs.writeFileSync;
  let edited: string | undefined;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    write(...args);
    if (String(args[0]).endsWith('control.json')) {
      edited = path.join(path.dirname(String(args[0])), 'plan.md'); write(edited, 'concurrent user plan');
    }
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => development.prepareRun(env, snapshot, input), /identity|changed/);
  assert.equal(readFileSync(edited!, 'utf8'), 'concurrent user plan');
  assert(!fs.existsSync(path.join(path.dirname(edited!), 'session.json')));
});

test('snapshot_accepts_explicit_separate_completed_output_and_rejects_managed_input', t => {
  const f = buildFixture(t), output = buildFixture(t);
  const env = development.prepareEnvironment(f.input, inspectEnvironment(f.input));
  const snapshot = development.snapshotBuild(env, development.recordBuildCompletion(output.input.implementationRoot));
  assert.equal(readFileSync(path.join(snapshot.root, 'dist/src/cli.js'), 'utf8'), 'export {};\n');
  assert.throws(() => development.snapshotBuild(env, development.recordBuildCompletion(snapshot.root)), /overlap|separate/);
});

test('prepare_environment_rejects_manifest_changed_during_save_and_preserves_user_bytes', t => {
  const f = buildFixture(t), write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
    write(...args);
    if (String(args[0]).endsWith('environment.json')) write(args[0], 'concurrent user manifest');
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => development.prepareEnvironment(f.input, inspectEnvironment(f.input)), /identity|changed/);
  assert.equal(readFileSync(path.join(f.input.envRoot, 'environment.json'), 'utf8'), 'concurrent user manifest');
});
