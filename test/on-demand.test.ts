import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectFile, InspectError } from '../src/on-demand.js';
import type { RuntimeConfig } from '../src/workers.js';

const native = path.resolve(process.env.MERISTEM_TEST_NATIVE_DIR ?? '.local/chat-control-build');
const hostExe = path.join(native, 'CodexWorkerHost.exe'), realExe = path.join(native, 'MockCodex.exe');
const hash = (exe: string) => createHash('sha256').update(readFileSync(exe)).digest('hex');
const fixtureConfig = { hostExe, realExe, hostSha256: hash(hostExe), realSha256: hash(realExe), fixture: true, managedProfile: true };
const agent = { model: 'mock', effort: 'low' };
function repo(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'meristem inspect '));
  t.after(() => rmSync(root, {recursive:true, force:true, maxRetries:5, retryDelay:100}));
  assert.equal(spawnSync('git', ['init', '-q'], {cwd: root, windowsHide:true}).status, 0);
  mkdirSync(path.join(root, 'inspect-fixture'));
  const authHome = mkdtempSync(path.join(tmpdir(), 'inspect-auth-'));
  t.after(() => rmSync(authHome, {recursive:true, force:true}));
  const config = (_: string, stateDirectory: string): RuntimeConfig => ({...fixtureConfig, stateDirectory, authHome});
  function inspect(file: string, options: {signal?:AbortSignal; timeoutMs?:number} = {}) {
    return inspectFile(file, {cwd:root, config, agent, ...options});
  }
  return {root, inspect, config};
}
const errorCode = (code: string) => (error: unknown) => error instanceof InspectError && error.code === code;
type Identity = {pid:number; created:string};
type Evidence = { app:Identity; descendant:Identity; thread:string; turn:string; sends:number; deniedAuthHome:boolean };
async function evidence(root: string, file: string): Promise<Evidence> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { return JSON.parse(readFileSync(path.join(root, 'inspect-fixture', file + '.processes'), 'utf8')); }
    catch { await delay(50); }
  }
  throw new Error('fixture did not record its processes');
}
function alive(identity: Identity) {
  const result = spawnSync(hostExe, ['--identity', String(identity.pid)], {encoding:'utf8', windowsHide:true});
  return result.status === 0 && result.stdout.trim() === identity.created;
}
async function assertStopped(record: Evidence) {
  for (let i = 0; i < 50 && (alive(record.app) || alive(record.descendant)); i++) await delay(100);
  assert.equal(alive(record.app), false);
  assert.equal(alive(record.descendant), false);
}

function parentIdentity(pid: number): Identity {
  const parent = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId`], {encoding:'utf8', windowsHide:true});
  assert.equal(parent.status, 0);
  const parentPid = Number(parent.stdout.trim());
  const identity = spawnSync(hostExe, ['--identity', String(parentPid)], {encoding:'utf8', windowsHide:true});
  assert.equal(identity.status, 0);
  return {pid:parentPid, created:identity.stdout.trim()};
}

test('rejects invalid or external target before runtime discovery', async t => {
  const {root} = repo(t), outside = mkdtempSync(path.join(tmpdir(), 'inspect outside '));
  t.after(() => rmSync(outside, {recursive:true, force:true}));
  writeFileSync(path.join(outside, 'other'), 'external');
  symlinkSync(outside, path.join(root, 'alias'), 'junction');
  for (const file of ['missing', path.relative(root, path.join(outside,'other')), 'alias/other', 'inspect-fixture', path.join(outside,'other')]) {
    let called = 0;
    await assert.rejects(inspectFile(file, {cwd:root, config:() => { called++; throw new Error('unexpected discovery'); }}), errorCode('invalid_file'));
    assert.equal(called, 0);
  }
});

test('returns only one final answer for the acknowledged attempt and stops the whole Job', async t => {
  const {root, config} = repo(t), token = randomUUID(), states: string[] = [];
  writeFileSync(path.join(root,'one.txt'), token + ' api_key=secret-fixture');
  const result = await inspectFile('one.txt', {cwd:root, config, agent, display: () => state => states.push(state)});
  assert.deepEqual(result, {status:'completed', file:'one.txt', summary:token + ' [redacted]'});
  assert.deepEqual(states, ['starting', 'running', 'completed']);
  const record = await evidence(root, 'one.txt');
  assert.equal(record.sends, 1);
  assert.equal(record.deniedAuthHome, true);
  await assertStopped(record);
});

test('CLI core distinguishes unverified sandbox isolation before starting or sending a turn', async t => {
  const {root, config} = repo(t), states: string[] = [];
  writeFileSync(path.join(root,'one.txt'),'value');
  writeFileSync(path.join(root,'inspect-fixture','sandbox.readable-control'),'');
  await assert.rejects(inspectFile('one.txt', {cwd:root, agent, display: () => state => states.push(state),
    config:(repository, state) => ({...config(repository, state), fixture:false})}), errorCode('isolation_unverified'));
  assert.equal(existsSync(path.join(root,'inspect-fixture','one.txt.processes')), false);
  assert.deepEqual(states, ['starting','failed']);
});

test('rejects foreign results, ambiguous final messages, waits and unknown sends without retrying', async t => {
  const {root, inspect} = repo(t);
  for (const [scenario, code] of [['foreign','result_unavailable'],['duplicate','result_unavailable'],['ack-mismatch','result_unavailable'],
    ['approval','worker_blocked'],['question','worker_blocked'],['status-wait','worker_blocked'],['lost','delivery_unknown'],['malformed','delivery_unknown']]) {
    const file = scenario + '.txt';
    writeFileSync(path.join(root,file), 'private answer');
    await assert.rejects(inspect(file), error => {
      assert.ok(errorCode(code)(error));
      if (scenario === 'lost') assert.equal((error as InspectError).cleanupUnconfirmed, false);
      return true;
    });
    const record = await evidence(root,file);
    assert.equal(record.sends, 1);
    await assertStopped(record);
  }
});

test('cancelling A leaves B running in the same repository and each descendant stops', async t => {
  const {root, inspect} = repo(t), controller = new AbortController();
  for (const file of ['hold-A.txt','hold-B.txt']) writeFileSync(path.join(root,file), file + ' result');
  const a = assert.rejects(inspect('hold-A.txt', {signal:controller.signal}), errorCode('cancelled'));
  const b = inspect('hold-B.txt');
  const [aJob,bJob] = await Promise.all(['hold-A.txt','hold-B.txt'].map(file => evidence(root,file)));
  assert.notEqual(aJob.thread,bJob.thread);
  controller.abort(); await a;
  await assertStopped(aJob);
  assert.ok(alive(bJob.app) && alive(bJob.descendant));
  writeFileSync(path.join(root,'inspect-fixture','hold-B.txt.finish'), '');
  assert.equal((await b).summary, 'hold-B.txt result');
  await assertStopped(bJob);
});

test('deadline interrupts one active turn and cleans up descendants', async t => {
  const {root, inspect} = repo(t);
  writeFileSync(path.join(root,'hold-timeout.txt'),'value');
  await assert.rejects(inspect('hold-timeout.txt', {timeoutMs:8000}), errorCode('timeout'));
  await assertStopped(await evidence(root,'hold-timeout.txt'));
});

test('cancellation also reports missing Job-empty proof if the registered host is forcibly terminated', async t => {
  const {root, inspect} = repo(t), controller = new AbortController();
  writeFileSync(path.join(root,'hold-unconfirmed.txt'),'value');
  const stopped = assert.rejects(inspect('hold-unconfirmed.txt', {signal:controller.signal}), error => {
    assert.ok(error instanceof InspectError);
    assert.equal(error.code, 'cancelled');
    assert.equal(error.cleanupUnconfirmed, true);
    return true;
  });
  const record = await evidence(root, 'hold-unconfirmed.txt');
  const host = parentIdentity(record.app.pid);
  assert.ok(alive(host));
  process.kill(host.pid); controller.abort(); await stopped;
  await assertStopped(record);
});

for (const phase of ['turn', 'sandbox']) test('force-closing the launching PowerShell releases the ' + phase + ' Job and all descendants', async t => {
  const {root} = repo(t);
  writeFileSync(path.join(root,'hold-shell.txt'), 'value');
  if (phase === 'sandbox') writeFileSync(path.join(root,'inspect-fixture','hold-sandbox'), '');
  const code = `
    import {inspectFile} from ${JSON.stringify(new URL('../src/on-demand.js',import.meta.url).href)};
    try { await inspectFile('hold-shell.txt',{cwd:process.cwd(),agent:${JSON.stringify(agent)},config:(_, stateDirectory)=>({... ${JSON.stringify(fixtureConfig)}, fixture:${phase !== 'sandbox'}, stateDirectory,authHome:stateDirectory})}); }
    catch { process.exitCode=1; }
  `;
  const entry = path.join(root,'runner.mjs');
  writeFileSync(entry, code);
  const shell = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command','& $env:MERISTEM_TEST_NODE $env:MERISTEM_TEST_ENTRY'], {
    cwd:root, env:{...process.env, MERISTEM_TEST_NODE:process.execPath, MERISTEM_TEST_ENTRY:entry}, windowsHide:true, stdio:'ignore'
  });
  t.after(() => { if (shell.exitCode === null && !shell.signalCode) shell.kill(); });
  const job = await evidence(root,phase === 'sandbox' ? 'sandbox' : 'hold-shell.txt');
  const host = parentIdentity(job.app.pid), cli = parentIdentity(host.pid);
  shell.kill(); await assertStopped(job);
  for (let i = 0; i < 50 && (alive(host) || alive(cli)); i++) await delay(100);
  assert.equal(alive(host), false);
  assert.equal(alive(cli), false);
  assert.equal(existsSync(path.join(root,'inspect-fixture','hold-shell.txt.finish')),false);
  if (phase === 'sandbox') assert.equal(existsSync(path.join(root,'inspect-fixture','hold-shell.txt.processes')),false);
});
