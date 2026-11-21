import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { zeroSendProbe } from './live/on-demand-probe.js';

function temporary(t: TestContext, prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const script = fileURLToPath(new URL('./live/on-demand-probe.js', import.meta.url));
function echo(cwd: string, ...args: string[]) {
  return new Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }>(resolve => {
    execFile(process.execPath, [script, 'echo', ...args], { cwd, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test('separate calls in one Git repository return their own receipt and actual exit code', async t => {
  const cwd = temporary(t, 'meristem probe A B ');
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd }).status, 0);
  const [a, b, invalid] = await Promise.all([echo(cwd, 'A-91', '0'), echo(cwd, 'B-44', '7'), echo(cwd, 'bad\nline', '0')]);
  const first = JSON.parse(a.stdout), second = JSON.parse(b.stdout);
  assert.deepEqual([a.code, b.code, first.exitCode, second.exitCode], [0, 7, 0, 7]);
  assert.deepEqual([first.marker, second.marker], ['A-91', 'B-44']);
  assert.match(first.receipt, /^[0-9a-f-]{36}$/);
  assert.match(second.receipt, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.receipt, second.receipt);
  assert.match(first.repositoryId, /^[0-9a-f]{64}$/);
  assert.equal(first.repositoryId, second.repositoryId);
  assert.equal(invalid.code, 2);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /bad\nline/);
});

test('native fixture verifies account and read-only acknowledgement, sends zero turns and confirms Job shutdown', async t => {
  const cwd = temporary(t, 'meristem zero send '), stateDirectory = temporary(t, 'meristem probe state ');
  const native = path.resolve(process.env.MERISTEM_TEST_NATIVE_DIR ?? '.local/chat-control-build');
  const hostExe = path.join(native, 'CodexWorkerHost.exe');
  const realExe = path.join(native, 'MockCodex.exe');
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const config = { stateDirectory, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe),
    authHome: stateDirectory, fixture: true, managedProfile: true };
  writeFileSync(path.join(cwd, 'history-fixture.json'), '{}');
  const agent = { model: 'mock', effort: 'low' };
  const result = await zeroSendProbe(cwd, config, agent);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.executable, 'confirmed');
  assert.equal(result.cliChatgptLogin, 'confirmed');
  assert.equal(result.chatgptAccount, 'confirmed');
  assert.equal(result.filesystemIsolation, 'fixture_skipped');
  assert.equal(result.readOnlyThread, 'confirmed');
  assert.equal(result.shutdown, 'confirmed');
  assert.ok(result.processes?.hostPid && result.processes.childPid && result.processes.jobId);
  const methods = () => readFileSync(path.join(cwd, 'history-fixture-methods.txt'), 'utf8').trim().split(/\r?\n/);
  assert.ok(methods().includes('account/read') && methods().includes('thread/start'));
  assert.deepEqual(methods().filter(m => m === 'turn/start'), []);
  for (const [pid, created] of [[result.processes.hostPid, result.processes.hostCreated], [result.processes.childPid, result.processes.childCreated]]) {
    const identity = spawnSync(hostExe, ['--identity', String(pid)], { encoding: 'utf8', windowsHide: true });
    assert.ok(identity.status !== 0 || identity.stdout.trim() !== created);
  }
  writeFileSync(path.join(cwd, 'ordinary-api-key'), '');
  const failed = await zeroSendProbe(cwd, config, agent);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failedAt, 'chatgpt_account');
  assert.equal(failed.cliChatgptLogin, 'confirmed');
  assert.equal(failed.chatgptAccount, 'unconfirmed');
  assert.equal(failed.readOnlyThread, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(failed), /fixture@example|fixture-user/);
  assert.deepEqual(methods().filter(m => m === 'turn/start'), []);
});
