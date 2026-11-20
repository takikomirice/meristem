import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { availablePipe, pipeRequest, relayRequest, Rpc } from '../src/protocol.js';
import { fileHash } from '../src/plan.js';
import { gitScope } from './fixtures/git-scope.js';

type Scope = ReturnType<typeof gitScope>;
async function until<T>(read: () => T | Promise<T>, accepted: (value: T) => boolean, message: string) {
  const end = Date.now() + 12000;
  do {
    const value = await read();
    if (accepted(value)) return value;
    await delay(50);
  } while (Date.now() < end);
  throw new Error(message);
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

// Exercise the native CLI lease under the existing MockCodex-owned loopback endpoint.
// The product launcher separately verifies a human terminal before allowing its control requests.
async function nativeRun(t: TestContext, root: string, scope: Scope, index: number, wakeTrial = false) {
  const assignment = scope.assignments[index], taskId = assignment.workerId, runId = 'run-' + taskId;
  const dir = path.join(root, runId); mkdirSync(dir);
  const build = path.resolve('.local/chat-control-build');
  const sha = (file: string) => fileHash(readFileSync(file));
  const realExe = path.join(build, 'MockCodex.exe'), hostExe = path.join(build, 'CodexWorkerHost.exe'), control = path.join(build, 'MeristemControl.exe');
  const relay = path.join(dir, 'CodexRelay.exe'); copyFileSync(path.join(build,'CodexRelay.exe'), relay);
  const stateDirectory = path.join(dir, 'state'), planPath = path.join(dir, 'plan.md'), configPath = path.join(dir, 'control.json');
  const pipeName = 'meristem-cc01-control-' + randomUUID(), parentPipe = 'meristem-cc00-' + randomUUID();
  const entryPoint = path.resolve('dist/src/cli.js'), mcpEntry = path.resolve('dist/src/mcp.js');
  writeFileSync(planPath, 'Fixture for ' + runId);
  const config = { runId, repository: scope.repositoryPath, pipeName, stateDirectory, nodeExecutable: process.execPath, nodeSha256: sha(process.execPath),
    entryPoint, entrySha256: sha(entryPoint), runtime: { hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: dir, fixture: true }, assignments: [],
    mcp: { ...(wakeTrial && { wake: { model:'mock', effort:'low', verifiedEntryPoint:'cli' } }),
      parentRelay: { pipeName: parentPipe, mode: 'verified-start', sessionKind: 'cli' }, entryPoint: mcpEntry, entrySha256: sha(mcpEntry),
      scope: { ...scope, assignments: [assignment], repositoryId: 'repo', fixture: true, planPath } } };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(relay + '.json', JSON.stringify({ realExecutable: realExe, realSha256: sha(realExe), pipeName: parentPipe, allowedCwds: [scope.repositoryPath],
    testProfile: 'CC-00R-CC02-fixture', controlHost: { executable: control, sha256: sha(control), configPath, configSha256: sha(configPath), parentMode: 'verified-start' } }));
  const child = spawn(relay, ['app-server'], { cwd: scope.repositoryPath, env: { ...process.env, CODEX_HOME: dir }, windowsHide: true, stdio: 'pipe' });
  const ui = new Rpc(child, () => {});
  t.after(async () => { ui.close(); if (child.exitCode === null && !child.signalCode) { await Promise.race([once(child,'close'), delay(3000, undefined, { ref: false })]); if (child.exitCode === null && !child.signalCode) child.kill(); } });
  const file = path.join(stateDirectory, 'discovery.json');
  await until(() => existsSync(file), Boolean, 'native control did not start');
  const discovery = JSON.parse(readFileSync(file, 'utf8'));
  const controlRequest = async (method: string, input = {}): Promise<Record<string, any>> => pipeRequest(pipeName, { ...discovery, method, ...input });
  const status = () => controlRequest('status');
  await ui.call('initialize', { clientInfo: { name:'fixture', version:'0' } }); ui.notify('initialized');
  const threadId = 'parent-' + taskId;
  await ui.call('thread/resume', { threadId });
  const owner = await relayRequest(parentPipe, 'relay/status');
  const parent = { ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, threadId };
  async function connect() {
    const { port } = await ui.call('fixture/terminal-listener', {});
    const tui = spawn(realExe, ['--remote', 'ws://127.0.0.1:' + port, '--remote-auth-token-env', 'TEST_ONLY'], { cwd: scope.repositoryPath, windowsHide: true, stdio:'pipe' });
    t.after(() => { if (tui.exitCode === null && !tui.signalCode) tui.kill(); });
    await once(tui.stdout, 'data');
    const birth = spawnSync('powershell.exe', ['-NoProfile','-Command', '(Get-Process -Id ' + tui.pid + ').StartTime.ToUniversalTime().ToFileTimeUtc()'], { encoding:'utf8', windowsHide:true });
    assert.equal(birth.status, 0);
    const socket = await availablePipe(pipeName);
    t.after(() => socket.destroy());
    socket.write(JSON.stringify({ ...discovery, method:'lease', sessionKind:'cli', terminal:{ pid:tui.pid, created:birth.stdout.trim() } }) + '\n');
    const lease = JSON.parse(String((await once(socket,'data'))[0]));
    assert.equal(lease.ok, true);
    return { tui, socket, leaseId:lease.leaseId };
  }
  const terminal = await connect(), input = { parent, leaseId: terminal.leaseId };
  const preview = await controlRequest('preview_parent_start', input);
  assert.equal((await controlRequest('start_parent', { ...input, scopeHash: preview.scopeHash, operationId:'human-start' })).state, 'active');
  const parentTurn = (await ui.call('turn/start', { threadId, input:wakeTrial ? [{type:'text',text:'fixture-parallel-completion'}] : [] })).turn.id;
  async function tool(name: string, args: object, thread = threadId, turnId = parentTurn) {
    const requestFile = path.join(dir, randomUUID() + '.json'), output = requestFile + '.result';
    writeFileSync(requestFile, JSON.stringify({ entryPoint:mcpEntry, pipeName, name, args, metadata:{ 'x-codex-turn-metadata':{ thread_id:thread, turn_id:turnId } }, output }));
    await ui.call('fixture/mcp',{ executable:process.execPath, helper:path.resolve('dist/test/fixtures/native-mcp-client.js'), file:requestFile }, 30000);
    return JSON.parse(readFileSync(output,'utf8'));
  }
  const create = await tool('create_worker', { runId, taskId, expectedRevision:(await status()).run.revision, operationId:'create' });
  assert(!create.isError, JSON.stringify(create));
  const worker = create.structuredContent;
  const row = (await status()).attempts[0], { childPid, hostPid } = row.registration;
  assert(alive(childPid) && alive(hostPid));
  return { taskId, runId, dir, assignment, mcpEntry, pipeName, parentPipe, ui, parent, parentTurn, controlRequest, status, tool, connect, terminal, worker, childPid, hostPid };
}

for (const scenario of ['deliver', 'switch', 'disconnect', 'stop'] as const) {
  test('managed report wake after confirmed cleanup: ' + scenario, { timeout:60000 }, async t => {
    const root = mkdtempSync(path.join(tmpdir(), 'meristem-wake-')), scope = gitScope(root);
    const f = await nativeRun(t, root, scope, 0, true);
    const before = (await f.status()).run.revision;
    writeFileSync(path.join(f.assignment.cwd, 'mcp-report.json'), JSON.stringify({ nodeExecutable:process.execPath, entryPoint:f.mcpEntry,
      pipeName:f.pipeName, name:'report', args:{ operationId:'report', runId:f.runId, expectedRevision:before+1, taskId:f.taskId,
        report:{summary:'private worker text'} }, output:path.join(f.dir,'report-result') }));
    const sent = await f.tool('send_instruction',{ operationId:'send', runId:f.runId, expectedRevision:before, taskId:f.taskId,
      target:f.worker, agent:{model:'mock', effort:'low'}, text:'fixture-mcp-report fixture-complete-before-ack' });
    assert(!sent.isError, JSON.stringify(sent));
    await until(f.status, state => state.attempts[0].state === 'completed', 'worker cleanup missing');
    const relay = () => relayRequest(f.parentPipe, 'relay/status');
    const starts = async () => (await relay()).events.filter((e: any) => e.method === 'turn/start/acked').map((e: any) => e.threadId);
    await until(relay, state => state.wakePeerAccepted > 0, 'managed broker did not probe pending report');
    assert.deepEqual(await starts(), [f.parent.threadId]);
    if (scenario === 'switch') await f.ui.call('thread/resume', {threadId:'unrelated'});
    if (scenario === 'disconnect') {
      f.terminal.socket.destroy();
      await until(f.status, state => state.run.state === 'needs_reconcile', 'disconnect did not fence wake');
    }
    if (scenario === 'stop') assert.equal((await f.controlRequest('stop', {leaseId:f.terminal.leaseId})).ok, true);
    writeFileSync(path.join(scope.repositoryPath, 'complete-turn'), '');
    await until(relay, state => !state.activeTurns[f.parent.threadId], 'parent remained busy');
    const expected = [f.parent.threadId];
    if (scenario === 'deliver') {
      // A missing catalog and a busy resumed thread are both observable before writing.
      await delay(1100);
      assert.deepEqual(await starts(), expected);
      await f.ui.call('fixture/thread-status', { threadId:f.parent.threadId, type:'active' });
      await f.ui.call('model/list', {});
      await delay(1100);
      assert.deepEqual(await starts(), expected);
      await f.ui.call('fixture/thread-status', { threadId:f.parent.threadId, type:'idle' });
      expected.push(f.parent.threadId);
      await until(starts, threads => threads.length === 2, 'idle parent did not receive report');
    }
    await delay(1100);
    assert.deepEqual(await starts(), expected);
  });
}

test('two native CLI leases keep worker reports, interrupt, terminal loss and explicit resume in their originating run', { timeout:110000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'meristem-cli-native-')), scope = gitScope(root);
  const a = await nativeRun(t, root, scope, 0), b = await nativeRun(t, root, scope, 1);
  const before = (await a.status()).run.revision;
  writeFileSync(path.join(a.assignment.cwd, 'mcp-report.json'), JSON.stringify({ nodeExecutable:process.execPath, entryPoint:a.mcpEntry, pipeName:a.pipeName,
    name:'report', args:{ operationId:'report', runId:a.runId, expectedRevision:before+1, taskId:a.taskId, report:{summary:'only run A'} }, output:path.join(a.dir,'report-result') }));
  const send = await a.tool('send_instruction',{ operationId:'send', runId:a.runId, expectedRevision:before, taskId:a.taskId, target:a.worker,
    agent:{model:'mock', effort:'low'}, text:'fixture-mcp-report' });
  assert(!send.isError, JSON.stringify(send));
  const reports = async (f: typeof a) => (await f.tool('get_status',{runId:f.runId})).structuredContent.reports;
  assert.deepEqual((await reports(a)).map((r: any) => r.report.summary), ['only run A']);
  assert.deepEqual(await reports(b), []);
  await a.ui.call('thread/resume', { threadId:'other' });
  const turn = (await a.ui.call('turn/start', { threadId:'other',input:[] })).turn.id;
  const foreignStop = await a.tool('stop_run', { runId:a.runId, operationId:'wrong-thread', expectedRevision:(await a.status()).run.revision }, 'other', turn);
  assert.equal(foreignStop.isError, true);
  await a.ui.call('turn/interrupt',{threadId:'other',turnId:turn});
  assert.equal((await a.controlRequest('stop',{ leaseId:b.terminal.leaseId })).ok, false);
  assert.equal((await a.status()).run.state,'active');
  await a.ui.call('turn/interrupt',{threadId:a.parent.threadId,turnId:a.parentTurn});
  const stopped = await until(a.status, s => s.attempts[0].state === 'stopped', 'interrupt did not stop worker A');
  assert.equal(stopped.run.state,'stopped');
  assert(stopped.attempts[0].stopResult.evidenceRefs.includes('native_job_empty'));
  assert(!alive(a.childPid) && !alive(a.hostPid));
  assert(alive(a.terminal.tui.pid!), 'turn interruption leaves the TUI open');
  assert.equal((await b.status()).run.state,'active'); assert(alive(b.childPid) && alive(b.hostPid));

  b.terminal.tui.kill();
  const lost = await until(b.status, s => s.attempts[0].state === 'stopped', 'terminal loss did not stop worker B');
  assert.equal(lost.run.state,'needs_reconcile');
  assert(lost.attempts[0].stopResult.evidenceRefs.includes('native_job_empty'));
  assert(!alive(b.childPid) && !alive(b.hostPid));
  const { leaseId } = await b.connect(), input = {parent:b.parent, leaseId};
  const shown = await b.controlRequest('preview_parent_start', input);
  assert.equal(shown.state,'needs_reconcile');
  assert.equal((await b.controlRequest('resume_parent',{ ...input, operationId:'resume', scopeHash:shown.scopeHash, stopGeneration:shown.stopGeneration })).state,'active');
  assert.equal((await b.status()).attempts.length,1); assert.equal((await b.status()).attempts[0].state,'stopped');
  assert.equal((await a.status()).run.state,'stopped');
  const released = once(a.terminal.socket, 'close');
  a.terminal.tui.kill();
  await released;
  const afterExit = await a.status();
  assert.equal(afterExit.run.state, 'stopped', 'disconnect preserves an acknowledged stop');
  assert.equal(afterExit.run.stop_generation, stopped.run.stop_generation);
});
