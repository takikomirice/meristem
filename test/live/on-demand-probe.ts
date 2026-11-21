import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cliRepository } from '../../src/cli-setup.js';
import type { AgentChoice } from '../../src/contracts.js';
import { readOnlyAssignment } from '../../src/on-demand.js';
import { inspectAgent, onDemandRuntime } from '../../src/on-demand-setup.js';
import { WorkerRuntime, type RuntimeConfig } from '../../src/workers.js';

type Confirmation = 'confirmed' | 'unconfirmed';
type ProbeReport = {
  status: 'passed' | 'failed';
  fixture: boolean;
  turnsSent: 0;
  executable: Confirmation;
  cliChatgptLogin: Confirmation;
  chatgptAccount: Confirmation;
  filesystemIsolation: Confirmation | 'fixture_skipped';
  isolationJobStopped?: true;
  readOnlyThread: Confirmation;
  shutdown: Confirmation;
  failedAt?: string;
  sandboxExit?: string;
  sandboxFailure?: string;
  hostSha256?: string;
  codexSha256?: string;
  processes?: Pick<ReturnType<WorkerRuntime['registration']>, 'hostPid' | 'hostCreated' | 'childPid' | 'childCreated' | 'jobId'>;
};

// Keep the zero-send path independent of inspect's send/wait loop. Report only measured
// checks and bounded failure labels. Raw RPC errors can contain account or path data.
export async function zeroSendProbe(repository: string, config: RuntimeConfig, agent: AgentChoice): Promise<ProbeReport> {
  const report: ProbeReport = { status: 'failed', fixture: config.fixture, turnsSent: 0, executable: 'unconfirmed', cliChatgptLogin: 'unconfirmed',
    chatgptAccount: 'unconfirmed', filesystemIsolation: config.fixture ? 'fixture_skipped' : 'unconfirmed',
    readOnlyThread: 'unconfirmed', shutdown: 'unconfirmed', failedAt: 'executable_identity' };
  try {
    if (!config.managedProfile || config.mcp) { report.failedAt = 'runtime_configuration'; return report; }
    const runtime = new WorkerRuntime(config);
    report.executable = 'confirmed';
    report.hostSha256 = config.hostSha256;
    report.codexSha256 = config.realSha256;
    report.failedAt = 'cli_login_status';
    const login = spawnSync(config.realExe, ['login', 'status'], { cwd: repository, windowsHide: true, timeout: 10000,
      env: { ...process.env, CODEX_HOME: config.authHome }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (login.status !== 0 || !/^Logged in (?:using|with) ChatGPT\s*$/im.test(login.stdout + '\n' + login.stderr)) return report;
    report.cliChatgptLogin = 'confirmed';
    report.failedAt = 'worker_start';
    const worker = await runtime.start(readOnlyAssignment(repository, agent), { watchCallingShell: true,
      onPreflightCheck(check) {
        if (check === 'read_only_isolation') {
          report.filesystemIsolation = 'confirmed';
          report.isolationJobStopped = true;
        }
        if (check === 'chatgpt_account') report.chatgptAccount = 'confirmed';
      } });
    try {
      report.readOnlyThread = 'confirmed';
      const { hostPid, hostCreated, childPid, childCreated, jobId } = runtime.registration(worker);
      report.processes = { hostPid, hostCreated, childPid, childCreated, jobId };
    } finally {
      report.failedAt = 'worker_shutdown';
      const stop = await runtime.stop(worker, 'zero_send_probe');
      if (stop.state === 'stopped') report.shutdown = 'confirmed';
    }
    if (report.shutdown === 'confirmed' && report.chatgptAccount === 'confirmed' && report.filesystemIsolation !== 'unconfirmed') {
      report.status = 'passed';
      delete report.failedAt;
    } else if (report.shutdown === 'confirmed') {
      report.failedAt = 'preflight_confirmation';
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const isolation = /^child control-state isolation not confirmed \(exit (-?\d+|unknown)(?:, ([A-Z0-9_]+|process_rejected))?\)$/.exec(message);
    if (isolation) {
      report.failedAt = 'read_only_isolation';
      report.sandboxExit = isolation[1];
      if (isolation[2]) report.sandboxFailure = isolation[2];
      // The one-shot native probe returns these codes only after StopAndConfirm.
      else if (['1', '41', '42', '43', '44', '45', '124'].includes(isolation[1])) report.isolationJobStopped = true;
    }
    if (message === 'sandbox probe cleanup unconfirmed') report.failedAt = 'isolation_shutdown';
    if (message === 'ChatGPT のサブスクリプション認証を確認できません。') report.failedAt = 'chatgpt_account';
  }
  return report;
}

async function main(args: string[]) {
  const [mode, marker, code] = args;
  if (args.length === 3 && mode === 'echo' && /^[a-zA-Z0-9_-]{1,64}$/.test(marker) && (code === '0' || code === '7')) {
    const repositoryId = createHash('sha256').update(cliRepository().toLowerCase()).digest('hex');
    console.log(JSON.stringify({ marker, receipt: randomUUID(), repositoryId, exitCode: Number(code) }));
    return Number(code);
  }
  if (args.length !== 1 || mode !== 'worker') {
    console.error('Usage: on-demand-probe.js echo <marker> <0|7> | worker');
    return 2;
  }
  const repository = cliRepository();
  const state = mkdtempSync(path.join(tmpdir(), 'meristem-probe-state-'));
  let report: ProbeReport | { status: 'failed'; failedAt: string; turnsSent: 0 };
  try {
    report = await zeroSendProbe(repository, onDemandRuntime(repository, state), inspectAgent);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    const failedAt = ['official_extension_unavailable', 'invalid_auth_home', 'runtime_overlaps_repository'].includes(reason)
      ? reason : 'runtime_discovery';
    report = { status: 'failed', failedAt, turnsSent: 0 };
  } finally {
    try { rmSync(state, { recursive: true, force: true }); }
    catch { report = { status: 'failed', failedAt: 'state_cleanup', turnsSent: 0 }; }
  }
  console.log(JSON.stringify(report));
  return report.status === 'passed' ? 0 : 1;
}

if (import.meta.main) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch { console.log(JSON.stringify({ status: 'failed', failedAt: 'repository_or_temp_directory', turnsSent: 0 })); process.exitCode = 1; }
}
