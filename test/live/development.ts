// Development operations are explicit. Importing this CLI has no live effects.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localPath } from '../../src/install.js';
import { fileHash } from '../../src/plan.js';
import { inspectEnvironment, prepareEnvironment, recordBuildCompletion, snapshotBuild, prepareRun, selectRefresh,
  startDevelopmentRun, statusDevelopmentRun, stopDevelopmentRun, restoreDevelopmentRun, refreshDevelopmentRun,
  acquireDevelopmentAuthOperation, type DevelopmentEnvironment, type DevelopmentDriver, type DevelopmentRun,
  type DevelopmentScenario } from '../../src/development.js';
import { developmentDriver } from './development-session.js';

export async function developmentCommand(args: string[], implementationRoot = path.resolve('.'), driver?: DevelopmentDriver): Promise<any> {
  const action = args[0];
  const flags = new Map<string, string[]>();
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (key === '--live') { if (flags.has(key)) throw new Error('duplicate --live'); flags.set(key, []); continue; }
    if (!['--input', '--environment', '--snapshot', '--build-root', '--scenario', '--session', '--change', '--test', '--probe-id', '--sandbox', '--timeout-ms'].includes(key)
      || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid development option');
    if (key !== '--test' && flags.has(key)) throw new Error('duplicate development option');
    flags.set(key, [...(flags.get(key) ?? []), args[++i]]);
  }
  const required = (key: string) => { const value = flags.get(key)?.[0]; if (!value) throw new Error(`explicit ${key} required`); return value; };
  const readJson = (file: string) => { if (!path.isAbsolute(file)) throw new Error('explicit absolute file required'); localPath(file); return JSON.parse(readFileSync(file, 'utf8')); };
  if (action === 'refresh') {
    const refresh = selectRefresh(required('--change'));
    if (refresh === 'tests_only') {
      const files = flags.get('--test') ?? [];
      if (!files.length) throw new Error('explicit related --test required');
      const testRoot = path.join(implementationRoot, 'dist/test'); localPath(testRoot);
      for (const file of files) {
        const relative = path.relative(testRoot, file);
        if (!path.isAbsolute(file) || relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.test.js')) throw new Error('related test must be inside dist/test');
        localPath(file);
      }
      await new Promise<void>((resolve, reject) => {
        const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ['--test', ...files], { cwd: implementationRoot, env, stdio: 'inherit', windowsHide: true });
        child.once('error', () => reject(new Error('related tests failed to start')));
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('related tests failed')));
      });
      return { action: refresh, phase: 'tested' };
    }
    if (refresh === 'fresh_acceptance') return { action: refresh, phase: 'not_run', runner: 'dist/test/live/acceptance.js' };
  }
  if (action === 'inspect') return inspectEnvironment(readJson(required('--input')));
  if (!['prepare', 'start', 'status', 'stop', 'refresh', 'restore', 'sandbox-probe', 'cycle'].includes(action)) throw new Error('usage: development inspect|prepare|start|status|stop|refresh|restore|sandbox-probe|cycle');
  if (!['prepare', 'status'].includes(action) && !flags.has('--live')) throw new Error('explicit --live required for lifecycle changes');
  let environment: DevelopmentEnvironment;
  if (action === 'prepare' && flags.has('--input')) {
    const input = readJson(required('--input'));
    environment = prepareEnvironment(input, inspectEnvironment(input));
  } else {
    const root = required('--environment');
    if (!path.isAbsolute(root)) throw new Error('explicit absolute environment required');
    const file = path.join(root, 'environment.json'); localPath(file);
    const raw = readFileSync(file, 'utf8'); environment = { ...JSON.parse(raw), manifestHash: fileHash(raw) };
    if (environment.envRoot !== root) throw new Error('environment binding changed');
  }
  if (action === 'prepare') {
    const scenario = flags.has('--scenario') ? readJson(required('--scenario')) : undefined;
    if (!flags.has('--scenario')) {
      if (flags.has('--snapshot')) throw new Error('scenario required with snapshot');
      return flags.has('--build-root') ? snapshotBuild(environment, recordBuildCompletion(required('--build-root'))) : environment;
    }
    if (flags.has('--snapshot') === flags.has('--build-root')) throw new Error('choose snapshot or completed build root');
    const snapshot = flags.has('--snapshot') ? readJson(required('--snapshot'))
      : snapshotBuild(environment, recordBuildCompletion(required('--build-root')));
    return prepareRun(environment, snapshot, scenario);
  }
  if (action === 'sandbox-probe') {
    const sandbox = required('--sandbox'), id = required('--probe-id'), timeoutMs = Number(flags.get('--timeout-ms')?.[0] ?? 30000);
    if (!['elevated', 'mxc'].includes(sandbox)) throw new Error('explicit elevated or mxc sandbox required');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('invalid probe id');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error('finite timeout 1000..30000 required');
    return sandboxProbe(environment, id, sandbox, timeoutMs);
  }
  if (action === 'cycle') {
    const scenario = readJson(required('--scenario')) as DevelopmentScenario;
    if ((scenario.approvedMaxTurns ?? 0) !== 0 || (scenario.maxInstructions ?? 0) !== 0) throw new Error('cycle requires zero model budget');
    const start = Date.now(), steps: Array<{ action: string; phase: string; elapsedMs: number }> = [];
    let time = start;
    const record = (action: string, phase: string) => { const now = Date.now(); steps.push({ action, phase, elapsedMs: now - time }); time = now; };
    const run = prepareRun(environment, readJson(required('--snapshot')), scenario);
    record('prepare', 'prepared');
    const output = path.join(path.dirname(run.sessionFile), 'cycle.json');
    const result = { source: driver ? 'fixture' : 'live', phase: 'unknown', cleanupPhase: 'unknown', limitedCheck: 'unconfirmed', run, steps, elapsedMs: 0,
      modelTurnsSent: 0, explicitSetupCalls: 0, sandboxSetupCalls: 'unconfirmed', uacPrompts: 'unconfirmed', humanOperations: 'unconfirmed', windowRestarts: 'unconfirmed' };
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    const effects = driver ?? developmentDriver(environment);
    try {
      const started = await startDevelopmentRun(environment, run, effects); record('start', started.phase);
      const status = await statusDevelopmentRun(environment, run, effects); record('status', status.phase);
      if (started.phase === 'running' && status.phase === 'running') result.limitedCheck = 'observed';
    } catch { record('failure', 'unknown'); }
    // Even a failed launch may have an owned receipt/process. Stop and restore only through the existing checks.
    try {
      const stopped = await stopDevelopmentRun(environment, run, effects); record('stop', stopped.phase);
      if (stopped.phase === 'stopped') {
        const restored = await restoreDevelopmentRun(environment, run, effects); record('restore', restored.phase); result.cleanupPhase = restored.phase;
        if (result.limitedCheck === 'observed') result.phase = restored.phase;
      }
    } catch { record('cleanup_failure', 'unknown'); }
    result.elapsedMs = Date.now() - start;
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); return result;
  }
  const file = required('--session'), run = readJson(file) as DevelopmentRun;
  if (run.sessionFile !== file) throw new Error('session file binding changed');
  const effects = driver ?? developmentDriver(environment);
  if (action === 'status') return statusDevelopmentRun(environment, run, effects);
  if (action === 'start') return { phase: (await startDevelopmentRun(environment, run, effects)).phase, run };
  if (action === 'stop') return stopDevelopmentRun(environment, run, effects);
  if (action === 'restore') return restoreDevelopmentRun(environment, run, effects);
  return refreshDevelopmentRun(environment, run, { change: required('--change'), snapshot: readJson(required('--snapshot')), scenario: readJson(required('--scenario')) }, effects);
}

function sandboxProbe(environment: DevelopmentEnvironment, id: string, sandbox: string, timeoutMs: number) {
  // Reuse the environment's hash/manifest validation, then reserve shared auth for the entire operation.
  const verified = prepareEnvironment(environment.input, inspectEnvironment(environment.input));
  if (verified.manifestHash !== environment.manifestHash) throw new Error('environment identity changed');
  const release = acquireDevelopmentAuthOperation(environment.authHome);
  let attempted = false, safeToRelease = true;
  try {
    const root = path.join(environment.envRoot, 'probes', id); localPath(root);
    mkdirSync(path.dirname(root), { recursive: true }); mkdirSync(root); // A probe ID is never replayed.
    const cwd = path.join(root, 'work'), state = path.join(root, 'state'); mkdirSync(cwd); mkdirSync(state);
    const visible = path.join(cwd, 'visible'), canary = path.join(state, 'canary');
    writeFileSync(visible, 'visible', { flag: 'wx' }); writeFileSync(canary, 'private-control-canary', { flag: 'wx' });
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    // Same positive-control/deny check as WorkerRuntime.verifyIsolation. No thread or model turn.
    const script = `$ErrorActionPreference='Stop'; if([IO.File]::ReadAllText(${quote(visible)}) -ne 'visible'){exit 41}; try{[void][IO.File]::ReadAllText(${quote(canary)});exit 42}catch [System.UnauthorizedAccessException]{exit 0}catch{exit 43}`;
    const profile = `permissions.meristem-managed={extends=":workspace",filesystem={${JSON.stringify(state)}="deny"}}`;
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: environment.authHome };
    for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key)) delete env[key];
    const result = { phase: 'unknown', sandbox, timeoutMs, environmentId: environment.id,
      authLeaseHash: fileHash(readFileSync(path.join(environment.authHome, '.meristem-development-lease.json'))),
      executableSha256: environment.input.selectedTools!.codex!.sha256,
      launchAttempts: 1, modelTurnsSent: 0, explicitSetupCalls: 0, sandboxSetupCalls: 'unconfirmed', uacPrompts: 'unconfirmed',
      managedReadDenied: 'unconfirmed', ownedProcessesStopped: 'unconfirmed', failure: null as string | null, exitCode: null as number | null, elapsedMs: 0 };
    const output = path.join(root, 'probe.json'); writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    const start = Date.now(); attempted = true; safeToRelease = false;
    try {
      const child = spawnSync(environment.input.codexExe, ['sandbox', '--include-managed-config', '-C', cwd, '-P', 'meristem-managed',
        '-c', profile, '-c', `windows.sandbox=${JSON.stringify(sandbox)}`, '-c', 'features.prefer_mxc=false',
        path.join(process.env.WINDIR!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { cwd, env, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 65536 });
      // Never retain raw stdout/stderr or exception text. A timeout does not prove descendant exit.
      result.elapsedMs = Date.now() - start;
      result.exitCode = child.status;
      if (child.status === 0 && !child.error && !child.signal) {
        result.phase = 'observed'; result.managedReadDenied = 'observed'; safeToRelease = true;
      } else result.failure = (child.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? 'timeout'
        : child.status === 42 ? 'managed_read_allowed' : child.status === 41 ? 'workspace_read_failed' : 'sandbox_failed';
    } catch { result.failure = 'launch_unknown'; result.elapsedMs = Date.now() - start; }
    writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); return result;
  } finally {
    // Preserve ownership after an unknown launch/timeout; never permit another probe/run to race it.
    if (!attempted || safeToRelease) release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void developmentCommand(process.argv.slice(2)).then(result => {
    console.log(JSON.stringify(result)); if (result.phase === 'unknown') process.exitCode = 1;
  }).catch(() => { console.error('Development operation failed; verify explicit inputs and retained lifecycle/refresh records before retrying.'); process.exitCode = 1; });
}
