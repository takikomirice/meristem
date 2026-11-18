// Explicit DE-03 lifecycle path. Default CC acceptance runners remain unchanged.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileHash } from '../../src/plan.js';
import { localPath } from '../../src/install.js';
import { pipeRequest } from '../../src/protocol.js';
import { inspectEnvironment, prepareEnvironment, prepareRun, startDevelopmentRun, statusDevelopmentRun,
  stopDevelopmentRun, restoreDevelopmentRun, type DevelopmentDriver, type DevelopmentProcess,
  type DevelopmentSession, type DevelopmentEnvironment, type DevelopmentRun } from '../../src/development.js';

function processCheck(action: string, session: DevelopmentSession, owner?: DevelopmentProcess) {
  if (process.platform !== 'win32') throw new Error('Windows development lifecycle required');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/development-process.ps1'),
    '-Action', action, '-RequestJson', JSON.stringify({ ...owner, executable: session.codeExe, profile: session.profile })], { encoding: 'utf8', windowsHide: true, timeout: 45000 });
  if (result.status !== 0) throw new Error('development process identity or exit unconfirmed');
  return JSON.parse(result.stdout.trim());
}
function confirmedDatabaseStop(session: DevelopmentSession) {
  const file = path.join(session.stateDirectory, 'control.sqlite'); localPath(file);
  if (!existsSync(file)) return true; // Only used after the full owned process tree exited.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT state,stop_result FROM attempts WHERE run_id=?').all(session.id);
    return rows.every(row => ['completed', 'stopped'].includes(String(row.state)) && row.stop_result && JSON.parse(String(row.stop_result)).state === 'stopped');
  } finally { db.close(); }
}
export function developmentDriver(environment: DevelopmentEnvironment): DevelopmentDriver {
  return {
    async assertIdle(session) { processCheck('idle', session); },
    async launch(session) {
      const link = path.join(session.extensions, path.basename(environment.input.extensionDirectory));
      if (existsSync(link)) {
        if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== realpathSync(environment.input.extensionDirectory)) throw new Error('official extension reference changed');
      } else symlinkSync(environment.input.extensionDirectory, link, 'junction');
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: session.authHome };
      for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|ELECTRON_RUN_AS_NODE|CODEX_THREAD_ID|CODEX_TURN_ID|^VSCODE_|^CHROME_CRASHPAD_PIPE_NAME$/i.test(key)) delete env[key];
      const child = spawn(session.codeExe, ['--user-data-dir', session.profile, '--extensions-dir', session.extensions,
        '--extensionDevelopmentPath', path.join(session.snapshot.root, 'extension'), '--new-window', session.cwd],
      // This is the explicit interactive development host. SW_HIDE also hides
      // Electron's window, leaving CloseMainWindow unavailable for safe shutdown.
      { env, windowsHide: false, stdio: 'ignore', detached: true });
      // Record spawn errors and an attempted delivery; never retry the launch.
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      return processCheck('identify', session, { pid: child.pid!, created: '', executable: session.codeExe });
    },
    async status(session, owner) {
      try { return processCheck('status', session, owner).state === 'running' ? 'running' : 'unknown'; } catch { return 'unknown'; }
    },
    async stop(session, owner) {
      // Check the recorded launcher before contacting any live broker or terminating processes.
      try { if (processCheck('status', session, owner).state !== 'running') return 'unknown'; } catch { return 'unknown'; }
      // The existing gateway checks token, owner epoch and the worker/native creation identity.
      const discovery = path.join(session.stateDirectory, 'discovery.json');
      if (existsSync(discovery)) {
        localPath(discovery); const binding = JSON.parse(readFileSync(discovery, 'utf8'));
        if (binding.runId !== session.id || binding.pipeName !== session.pipeName) return 'unknown';
        try {
          const result = await pipeRequest(session.pipeName, { ...binding, method: 'stop' });
          if (result.ok !== true || (result.results as any[])?.some(row => row.state !== 'stopped')) return 'unknown';
        } catch { return 'unknown'; }
      }
      try {
        if (processCheck('stop', session, owner).state !== 'stopped') return 'unknown';
        return confirmedDatabaseStop(session) ? 'stopped' : 'unknown';
      } catch { return 'unknown'; }
    },
  };
}
export async function developmentSession(args: string[]) {
  const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const envRoot = arg('--environment');
  if (!envRoot || !path.isAbsolute(envRoot)) throw new Error('explicit absolute --environment required');
  localPath(envRoot);
  const raw = readFileSync(path.join(envRoot, 'environment.json'), 'utf8');
  const environment = { ...JSON.parse(raw), manifestHash: fileHash(raw) } as DevelopmentEnvironment;
  if (environment.envRoot !== envRoot) throw new Error('environment root binding changed');
  if (args[0] === 'prepare') {
    const snapshotFile = arg('--snapshot'), scenarioFile = arg('--scenario');
    if (!snapshotFile || !scenarioFile) throw new Error('explicit snapshot and scenario JSON required');
    const env = prepareEnvironment(environment.input, inspectEnvironment(environment.input));
    return prepareRun(env, JSON.parse(readFileSync(snapshotFile, 'utf8')), JSON.parse(readFileSync(scenarioFile, 'utf8')));
  }
  const sessionFile = arg('--session');
  if (!sessionFile || !path.isAbsolute(sessionFile)) throw new Error('explicit session file required');
  localPath(sessionFile); const run = JSON.parse(readFileSync(sessionFile, 'utf8')) as DevelopmentRun;
  if (run.sessionFile !== sessionFile) throw new Error('session file binding changed');
  const driver = developmentDriver(environment);
  if (args[0] === 'status') return statusDevelopmentRun(environment, run, driver);
  if (!args.includes('--live')) throw new Error('explicit --live required for lifecycle changes');
  if (args[0] === 'launch') return { phase: (await startDevelopmentRun(environment, run, driver)).phase };
  if (args[0] === 'stop') return stopDevelopmentRun(environment, run, driver);
  if (args[0] === 'cleanup') return restoreDevelopmentRun(environment, run, driver);
  throw new Error('development lifecycle: prepare|launch|status|stop|cleanup');
}
