// Run explicitly with an existing, authenticated CLI test home. Exercises setup without opening a model turn.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempDisposableSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { cliPlanChoices, listCliRuns, prepareCliRun, verifyCliArtifacts } from '../../src/cli-setup.js';
import { openCliSession } from '../../src/cli-session.js';
import { relayRequest } from '../../src/protocol.js';
import { serialFixture } from '../fixtures/serial-git.js';

const { values } = parseArgs({ options: {
  codex: { type: 'string' }, sha256: { type: 'string' }, 'auth-home': { type: 'string' }, evidence: { type: 'string' },
  session: { type: 'boolean' }
} });
const realExe = values.codex, authHome = values['auth-home'], evidence = values.evidence;
if (process.platform !== 'win32' || !realExe || !authHome || !evidence ||
    ![realExe, authHome, evidence].every(file => path.isAbsolute(file)) || existsSync(evidence)) {
  throw new Error('Windows・検証用の --codex、--auth-home、新規の --evidence に絶対パスを指定してください。');
}
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const codexHash = hash(realExe);
assert.equal(codexHash, values.sha256?.toLowerCase(), '試験対象の公式CLIのSHA-256を照合できません。');
const configPath = path.join(authHome, 'config.toml');
const configFingerprint = () => existsSync(configPath) ? hash(configPath) : null;
const before = configFingerprint();
using workspace = mkdtempDisposableSync(path.join(tmpdir(), 'meristem-p5-setup-'));
const root = workspace.path;
const fixture = serialFixture(path.join(root, 'git'));
fixture.plan.schema_version = 2;
for (const task of fixture.plan.tasks) Object.assign(task.agent, { permissionProfileId: 'read-only' });
fixture.savePlan();
const plan = path.join(fixture.repository, 'plan.md');
copyFileSync(fixture.planPath, plan);
const repository = realpathSync(fixture.repository);
assert.deepEqual(cliPlanChoices(repository), [plan]);
const registryRoot = path.join(root, 'runs');
const run = prepareCliRun(repository, plan, { realExe, authHome, registryRoot });
verifyCliArtifacts(run);
assert.deepEqual(listCliRuns(repository, registryRoot).map(saved => saved.runId), [run.runId]);
let managedTuiInitialized = false;
let ownedProcessesExited = false;
if (values.session) {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY, '対話型の試験端末が必要です。');
  const control = JSON.parse(readFileSync(run.configPath, 'utf8'));
  const session = await openCliSession(run);
  let processes: number[] = [];
  try {
    const shell = path.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const inspect = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command',
      `$helper = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='MeristemTerminal.exe'");` +
      'if ($helper.Count -ne 1) { exit 1 };' +
      '$tui = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + $helper[0].ProcessId));' +
      'if ($tui.Count -ne 1) { exit 1 };' +
      '@{ helper=[int]$helper[0].ProcessId; pid=[int]$tui[0].ProcessId; path=$tui[0].ExecutablePath } | ConvertTo-Json -Compress'
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(inspect.status, 0, '公式TUIの起動元を確認できません。');
    const terminal = JSON.parse(inspect.stdout);
    assert.equal(path.relative(realExe, terminal.path), '');
    const deadline = Date.now() + 15000;
    do {
      const state = await relayRequest(control.mcp.parentRelay.pipeName, 'relay/status');
      managedTuiInitialized = state.initialized === true && state.managementEnabled === true;
      if (managedTuiInitialized) {
        processes = [...state.jobProcessIds, state.controlHost.pid, terminal.helper, terminal.pid];
        assert.ok(processes.includes(state.ownedPid) && processes.every(pid => Number.isSafeInteger(pid) && pid > 0));
      }
      if (!managedTuiInitialized) await delay(100);
    } while (!managedTuiInitialized && Date.now() < deadline);
    assert.ok(managedTuiInitialized, '公式TUIによるApp Server初期化を照合できません。');
    const state = await session.request('status');
    assert.ok(state.ok && state.run.id === run.runId);
    assert.ok(state.binding == null);
    assert.deepEqual(state.attempts, []);
  } finally { await session.close(); }
  const running = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const stopDeadline = Date.now() + 5000;
  while (processes.some(running) && Date.now() < stopDeadline) await delay(100);
  ownedProcessesExited = processes.every(pid => !running(pid));
  assert.ok(ownedProcessesExited, '公式TUI・起動元・所有App Server・制御ホストの停止を確認できません。');
}
assert.equal(configFingerprint(), before, '通常のCLI設定が変更されました。');
const version = spawnSync(realExe, ['--version'], { env: { ...process.env, CODEX_HOME: authHome },
  encoding: 'utf8', windowsHide: true, timeout: 10000 });
assert.equal(version.status, 0);
const observation = { capturedAt: new Date().toISOString(), stage: 'P5', check: 'official-cli-setup',
  version: version.stdout.trim(), codexHash, planDiscovered: true, runRecovered: true, codexConfigPreserved: true,
  ...(values.session && { managedTuiInitialized, ownedProcessesExited }), parentTurnsSent: 0, workerTurnsSent: 0 };
writeFileSync(evidence, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(observation));
