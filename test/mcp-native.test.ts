import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeRequest, relayRequest } from '../src/protocol.js';
import { gitScope } from './fixtures/git-scope.js';
import { serialFixture } from './fixtures/serial-git.js';

for (const mode of ['legacy', 'adaptive', 'verified-start', 'control-start', 'terminal-exit', 'sidebar']) test(mode === 'sidebar' ? 'sidebar_client_accepts_only_the_verified_pending_start' : mode === 'terminal-exit' ? 'terminal_exit_fences_live_launcher_lease' : mode === 'control-start' ? 'owned_control_lease_starts_only_displayed_parent_and_scope' : mode === 'verified-start' ? 'verified_first_caller_and_single_human_start' : mode === 'adaptive' ? 'native_authorize_displays_and_confirms_the_bound_model_policy'
  : 'native_owned_parent_MCP_permit_worker_report_and_unknown_peer_boundary', { timeout: 75000 }, async t => {
  const adaptive = mode === 'adaptive', dynamic = !['adaptive', 'legacy'].includes(mode);
  const root = mkdtempSync(path.join(tmpdir(), 'cc02-native-')), state = path.join(root, 'state');
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const realExe = path.resolve('.local/chat-control-build/MockCodex.exe'), hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe'), control = path.resolve('.local/chat-control-build/MeristemControl.exe');
  const relay = path.join(root, 'CodexRelay.exe'); copyFileSync(path.resolve('.local/chat-control-build/CodexRelay.exe'), relay);
  const pipeName = `meristem-cc01-control-${randomUUID()}`, parentPipe = `meristem-cc00-${randomUUID()}`, configPath = path.join(root, 'config.json'), entryPoint = path.resolve('dist/src/cli.js'), mcpEntry = path.resolve('dist/src/mcp.js'), planPath = path.join(root, 'plan.md');
  const choices = [{ model: 'mock', effort: 'low' }, { model: 'mock', effort: 'high' }];
  let scopeGit;
  if (adaptive || mode === 'sidebar') {
    const f = serialFixture(root);
    f.plan.schema_version = 2;
    Object.assign(f.plan.run, { worker_model_policy: { mode: 'rules', candidates: choices } });
    for (const task of f.plan.tasks) Object.assign(task.agent, { permissionProfileId: 'workspace' });
    Object.assign(f.plan.tasks[0], { model_routing: { kind: 'implementation', complexity: 'bounded' } });
    f.savePlan();
    scopeGit = { plan: true, assignments: [], repositoryPath: f.repository, branchScope: [f.plan.run.integration_branch] };
  } else {
    writeFileSync(planPath, 'CC-02 native fixture');
    scopeGit = gitScope(root);
  }
  const assignments = scopeGit.assignments;
  const config = { stateDirectory: state, repository: process.cwd(), runId: 'run', pipeName, nodeExecutable: process.execPath, nodeSha256: sha(process.execPath), entryPoint, entrySha256: sha(entryPoint), runtime: { hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: root, fixture: true }, assignments: [], mcp: { wake: { model: 'mock', effort: 'low', maxTurns: 12 }, parentRelay: { pipeName: parentPipe, ...(dynamic ? { mode: 'verified-start', sessionKind: mode === 'terminal-exit' ? 'cli' : 'vscode' } : { threadId: 'P' }) }, entryPoint: mcpEntry, entrySha256: sha(mcpEntry), scope: { fixture: true, planPath, repositoryId: 'repo', ...scopeGit } } };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(relay + '.json', JSON.stringify({ realExecutable: realExe, realSha256: sha(realExe), pipeName: parentPipe, allowedCwds: [root], testProfile: 'CC-00R-CC02-fixture', controlHost: { executable: control, sha256: sha(control), configPath, configSha256: sha(configPath), ...(dynamic ? { parentMode: 'verified-start' } : { parentThreadId: 'P' }) } }));
  const child = spawn(relay, ['app-server'], { cwd: root, env:{...process.env,CODEX_HOME:root}, windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  t.after(async () => { child.stdin.end(); for (let i = 0; i < 100 && child.exitCode === null; i++) await delay(50); if (child.exitCode === null && !child.signalCode) child.kill(); });
  for (let i = 0; i < 150 && !existsSync(path.join(state, 'discovery.json')); i++) { if (child.exitCode !== null) assert.fail(stderr); await delay(40); }
  assert(existsSync(path.join(state, 'discovery.json')), stderr);
  const discovery = JSON.parse(readFileSync(path.join(state, 'discovery.json'), 'utf8'));
  await assert.rejects(relayRequest(parentPipe, 'relay/wake-block', { threadId: 'P' }), /proof unavailable/);
  const request = (method: string, params = {}) => pipeRequest(pipeName, { ...discovery, method, ...params });
  let sequence = 0;
  async function ui(method: string, params: object) {
    const id = ++sequence; child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    for (let i = 0; i < 900; i++) { const reply = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === id); if (reply) return reply.result; await delay(20); }
    throw new Error(`fixture UI timeout: ${stderr}`);
  }
  await ui('initialize', { clientInfo: { name: 'fixture', version: '0' } }); child.stdin.write('{"method":"initialized"}\n');
  for (let i = 0; i < 20; i++) assert.equal((await relayRequest(parentPipe, 'relay/status')).managementEnabled, true);
  if (dynamic) await ui('thread/resume', { threadId: 'P' });
  async function acquireLease(terminal?: {pid: number; created: string}) {
    const lease = net.connect('\\\\.\\pipe\\' + pipeName + '-15');
    t.after(() => lease.destroy());
    await once(lease, 'connect');
    lease.write(JSON.stringify({ ...discovery, method: 'lease', sessionKind: terminal ? 'cli' : 'vscode', terminal }) + '\n');
    const accepted = JSON.parse(String((await once(lease, 'data'))[0]));
    assert.equal(accepted.ok, true);
    return { socket: lease, id: accepted.leaseId };
  }
  if (mode === 'terminal-exit') {
    async function openTui(port: number) {
      const tui = spawn(realExe, ['--remote', 'ws://127.0.0.1:' + port, '--remote-auth-token-env', 'TEST_ONLY'], { cwd: root, stdio: 'pipe', windowsHide: true });
      t.after(() => { if (tui.exitCode === null) tui.kill(); });
      await once(tui.stdout, 'data');
      const pid = tui.pid!;
      const birth = spawnSync('powershell.exe', ['-NoProfile', '-Command', "(Get-Process -Id " + pid + ").StartTime.ToUniversalTime().ToFileTimeUtc()"], { encoding: 'utf8', windowsHide: true });
      assert.equal(birth.status, 0);
      return { tui, identity: {pid, created: birth.stdout.trim()} };
    }
    async function connectedTui() {
      const { port } = await ui('fixture/terminal-listener', {});
      const { tui, identity } = await openTui(port);
      return { tui, lease: await acquireLease(identity) };
    }
    const unrelated = net.createServer(socket => socket.resume()).listen(0, '127.0.0.1');
    t.after(() => unrelated.close());
    await once(unrelated, 'listening');
    const address = unrelated.address(); assert(address && typeof address !== 'string');
    const wrong = await openTui(address.port);
    const rejected = await request('lease', { sessionKind: 'cli', terminal: wrong.identity }).catch(() => ({ok: false}));
    assert.equal(rejected.ok, false);
    wrong.tui.stdin.end();
    assert.equal(((await request('status')).run as any).state, 'active', 'a rejected connection never acquired or lost the lease');
    const first = await connectedTui();
    first.tui.stdin.end();
    for (let i = 0; i < 60 && ((await request('status')).run as any).state === 'active'; i++) await delay(50);
    assert.equal(((await request('status')).run as any).state, 'needs_reconcile', 'TUI exit fences its still-live launcher');
    const second = await connectedTui();
    const owner = await relayRequest(parentPipe, 'relay/status');
    const parent = { ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, threadId: 'P' };
    const input = { parent, leaseId: second.lease.id };
    const preview = await request('preview_parent_start', input);
    assert.equal(preview.ok, true, 'disconnecting before registration must allow a new session to start');
    assert.equal((await request('start_parent', { ...input, scopeHash: preview.scopeHash, operationId: 'reconnected' })).state, 'active');
    second.tui.stdin.end();
    return;
  }
  const { connectManaged } = createRequire(import.meta.url)(path.resolve('extension/dist/src/managed-client.js'));
  const sidebar = mode === 'sidebar' ? await connectManaged(path.join(state, 'discovery.json'), { pipeName, runId: 'run' }) : undefined;
  if (sidebar) t.after(() => sidebar.dispose());
  const acceptedLease = dynamic && !sidebar ? await acquireLease() : undefined;
  if (mode === 'control-start') {
    const owner = await relayRequest(parentPipe, 'relay/status');
    const parent = { ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, threadId: 'P' };
    assert.equal((await request('preview_parent_start', { parent })).ok, false, 'discovery alone cannot attest a start');
    const leaseId = acceptedLease!.id;
    const preview = await request('preview_parent_start', { parent, leaseId });
    assert.equal(preview.ok, true);
    assert.equal((await request('status')).binding, undefined);
    await ui('thread/resume', { threadId: 'other' });
    const start = { parent, leaseId, scopeHash: preview.scopeHash, operationId: 'human-start' };
    assert.equal((await request('start_parent', { ...start, parent: { ...parent, threadId: 'other' } })).ok, false);
    assert.equal((await request('start_parent', { ...start, leaseId: 'obsolete-lease' })).ok, false);
    const started = await request('start_parent', start);
    assert.equal(started.state, 'active');
    assert.equal((await request('start_parent', start)).bindingId, started.bindingId);
    assert.equal(((await request('status')).binding as any).state, 'consumed');
    const receipt = JSON.parse(((await request('status')).binding as any).scope);
    assert.equal(receipt.startSource, 'control_input');
    acceptedLease!.socket.end();
    for (let i=0; i<50 && ((await request('status')).run as any).state==='active'; i++) await delay(50);
    assert.notEqual(((await request('status')).run as any).state, 'active');
    assert.equal((await request('start_parent', start)).ok, false);
    const renewed = await acquireLease();
    const reconnect = { parent, leaseId: renewed.id };
    const displayed = await request('preview_parent_start', reconnect);
    assert.equal(displayed.state, 'needs_reconcile');
    const resume = { ...reconnect, scopeHash: displayed.scopeHash, operationId: 'resume', stopGeneration: displayed.stopGeneration };
    assert.equal((await request('resume_parent', { ...resume, scopeHash: start.scopeHash })).ok, false);
    assert.equal((await request('resume_parent', { ...resume, stopGeneration: -1 })).ok, false);
    assert.equal((await request('resume_parent', resume)).state, 'active');
    return;
  }
  const turn = await ui('turn/start', { threadId: 'P', input: [{ type: 'text', text: 'parent' }] });
  const metadata = { 'x-codex-turn-metadata': { thread_id: 'P', turn_id: turn.turn.id } };
  async function call(name: string, args: object, meta = metadata, descendant = false, humanAction?: string) {
    const file = path.join(root, `${randomUUID()}.json`), output = file + '.result';
    writeFileSync(file, JSON.stringify({ entryPoint: mcpEntry, pipeName, name, args, metadata: meta, output, humanAction, ...(descendant ? { descendant: true } : {}) }));
    await ui('fixture/mcp', { executable: process.execPath, helper: path.resolve('dist/test/fixtures/native-mcp-client.js'), file });
    return JSON.parse(readFileSync(output, 'utf8'));
  }
  const external = await pipeRequest(pipeName, { method: 'mcp', name: 'start_run', args: { planPath, operationId: 'fake' }, metadata }); assert.equal(external.ok, false);
  const spoofFile = path.join(root, 'spoof-parent.json'), spoofOutput = spoofFile + '.result';
  writeFileSync(spoofFile, JSON.stringify({ pipeName, direct: { method: 'mcp', name: 'start_run', args: { planPath, operationId: 'spoof' }, metadata }, output: spoofOutput }));
  await ui('fixture/mcp', { executable: process.execPath, helper: path.resolve('dist/test/fixtures/native-mcp-client.js'), file: spoofFile });
  assert.equal(JSON.parse(readFileSync(spoofOutput, 'utf8')).ok, false, 'arbitrary App Server helper cannot claim the root MCP identity');
  assert.equal((await call('start_run', { planPath, operationId: 'descendant' }, metadata, true)).isError, true, 'same pinned argv launched by an arbitrary descendant cannot claim MCP identity');
  if (mode === 'sidebar') {
    assert.equal((await call('start_run', { planPath: configPath, operationId: 'wrong-plan' })).isError, true);
    const alternateDriveCase = planPath[0] === planPath[0].toUpperCase() ? planPath[0].toLowerCase() : planPath[0].toUpperCase();
    const first = await call('start_run', { planPath: alternateDriveCase + planPath.slice(1), operationId: 'start' });
    assert.equal(first.structuredContent.state, 'awaiting_authorization');
  }
  const pending = await call('start_run', { ...(mode !== 'sidebar' && {planPath}), operationId: 'start' }); assert.equal(pending.structuredContent.state, 'awaiting_authorization');
  if (sidebar) {
    await sidebar.refresh();
    assert.equal(sidebar.pendingStart, pending.structuredContent.bindingId);
    const preview = await sidebar.preview();
    assert.equal(preview.parent.threadId, 'P');
    assert.equal(preview.scope.planScope.planVersion, 2);
    assert.ok(preview.tasks.count >= 1 && preview.tasks.names.length <= 3);
    await assert.rejects(sidebar.start({ ...preview, scopeHash: '0'.repeat(64) }));
    await sidebar.start(preview);
    await sidebar.refresh();
    assert.equal(sidebar.pendingStart, undefined);
    assert.equal(sidebar.started, true);
    assert.equal((await sidebar.usage()).requestedMaximum, 1);
    assert.equal((await sidebar.stopRun()).run.state, 'stopped');
    return;
  }
  const selfAuthorize = path.join(root, 'self-authorize.json'), selfOutput = selfAuthorize + '.result';
  writeFileSync(selfAuthorize, JSON.stringify({ pipeName, direct: { ...discovery, method: 'authorize', bindingId: pending.structuredContent.bindingId }, output: selfOutput }));
  await ui('fixture/mcp', { executable: process.execPath, helper: path.resolve('dist/test/fixtures/native-mcp-client.js'), file: selfAuthorize });
  assert.equal(JSON.parse(readFileSync(selfOutput, 'utf8')).ok, false);
  if (dynamic) {
    await ui('thread/resume', { threadId: 'other' });
    const peerTurn = await ui('turn/start', { threadId: 'other', input: [] });
    const peerMeta = { 'x-codex-turn-metadata': { thread_id: 'other', turn_id: peerTurn.turn.id } };
    assert.equal((await call('start_run', { planPath, operationId: 'start' }, peerMeta)).isError, true);
    assert.equal((await request('authorize', { bindingId: pending.structuredContent.bindingId, scopeHash: '0'.repeat(64) })).ok, false);
  }
  if (adaptive) {
    const preview = pending.structuredContent.modelRouting;
    assert.deepEqual(preview.candidates, choices);
    assert.deepEqual(preview.tasks, [{ taskId: 'A', agent: choices[0] }]);
    assert.equal(preview.maxAutomaticChangesPerTask, 1);
    const unbound = await request('authorize', { bindingId: pending.structuredContent.bindingId });
    assert.equal(unbound.ok, false, 'the native command must confirm the displayed scope hash with the binding');
  }
  let authorized;
  if (dynamic) {
    const binding = (await request('status')).binding as any;
    assert.equal((await request('authorize', { bindingId: binding.id, scopeHash: binding.scope_hash })).ok, false);
    assert.equal((await request('authorize', { bindingId: binding.id, scopeHash: binding.scope_hash, leaseId: acceptedLease!.id })).ok, true);
  } else {
    authorized = spawnSync(process.execPath, ['dist/src/cli.js', 'authorize', '--run', 'run', '--state', state, '--binding', pending.structuredContent.bindingId], { cwd: process.cwd(), input: pending.structuredContent.bindingId + '\n', windowsHide: true, encoding: 'utf8' });
    assert.equal(authorized.status, 0, authorized.stderr);
  }
  if (dynamic) assert.equal(((await request('status')).binding as any).state, 'consumed', 'human control commits the start before another MCP call');
  assert.equal((await call('start_run', { planPath, operationId: 'start' })).structuredContent.state, 'active');
  if (dynamic) {
    assert.equal(((await request('status')).binding as any).state, 'consumed');
    const replay = await call('start_run', { planPath, operationId: 'retry' });
    assert.equal(replay.structuredContent.bindingId, pending.structuredContent.bindingId);
    const receipt = JSON.parse(((await request('status')).binding as any).scope);
    assert.equal(receipt.startSource, 'permit_confirmation');
    acceptedLease!.socket.end();
    for (let i = 0; i < 50 && ((await request('status')).run as any).state === 'active'; i++) await delay(50);
    assert.equal(((await request('status')).run as any).state, 'needs_reconcile');
    const nextLease = await acquireLease();
    assert.equal((await request('authorize', { bindingId: pending.structuredContent.bindingId })).ok, false);
    const rebound = (await call('start_run', { planPath, operationId: 'new-session' })).structuredContent;
    assert.equal(rebound.state, 'awaiting_authorization');
    assert.notEqual(rebound.bindingId, pending.structuredContent.bindingId);
    const stored = (await request('status')).binding as any;
    assert.equal((await request('authorize', { bindingId: rebound.bindingId, scopeHash: stored.scope_hash, leaseId: nextLease.id })).ok, true);
    const snapshot = await request('status');
    assert.equal((snapshot.run as any).state, 'needs_reconcile');
    assert.equal((snapshot.binding as any).state, 'consumed');
    assert.equal((await call('resume_run', { runId: 'run', operationId: 'resume', expectedRevision: (snapshot.run as any).revision })).isError === true, false);
    assert.equal(((await request('status')).run as any).state, 'active');
    return;
  }
  if (adaptive) {
    const usage = await request('usage');
    assert.equal(usage.ok,true);
    assert.equal((usage.capacity as any).windows[0]?.remainingPercent,20);
    assert.equal((usage.capacity as any).effectiveMaximum,1);
    assert.match(authorized!.stderr, /"maxAutomaticChangesPerTask": 1/);
    assert(authorized!.stderr.includes(pending.structuredContent.modelRouting.scopeHash));
    assert.equal(((await request('status')).binding as any).state, 'consumed');
    return;
  }
  const revision = async () => ((await request('status')).run as any).revision;
  const created = await call('create_worker', { operationId: 'create', runId: 'run', expectedRevision: await revision(), taskId: 'A' });
  assert(!created.isError, JSON.stringify(created)); const worker = created.structuredContent;
  const beforeReport = await revision();
  writeFileSync(path.join(assignments[0].cwd, 'mcp-report.json'), JSON.stringify({ verifySpoofs: true, nodeExecutable: process.execPath, entryPoint: mcpEntry, pipeName, name: 'report', args: { operationId: 'report', runId: 'run', expectedRevision: beforeReport + 1, taskId: 'A', report: { summary: 'owned A report' } }, output: path.join(root, 'worker-report.result') }));
  const sent = await call('send_instruction', { operationId: 'send', runId: 'run', expectedRevision: beforeReport, taskId: 'A', target: worker, agent: { model: 'mock', effort: 'low' }, text: 'fixture-mcp-report' }); assert(!sent.isError, JSON.stringify(sent));
  assert.equal(JSON.parse(readFileSync(path.join(root, 'worker-report.result.helper-spoof'), 'utf8')).ok, false, 'worker helper cannot forge its report identity');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'worker-report.result.descendant-spoof'), 'utf8')).isError, true, 'worker grandchild with identical MCP argv cannot forge its report identity');
  const status = await call('get_status', { runId: 'run' }); assert.equal(status.structuredContent.reports[0].report.summary, 'owned A report');
  const stale = await call('create_worker', { operationId: 'stale-B', runId: 'run', expectedRevision: 0, taskId: 'B' });
  assert.equal(stale.isError, true); assert.match(JSON.stringify(stale), /stale_revision/); assert.match(JSON.stringify(stale), /not_applied/);
  assert.equal((await call('get_status', { runId: 'run' })).structuredContent.attempts.length, 1);
  const mismatch = await call('get_status', { runId: 'run' }, { 'x-codex-turn-metadata': { thread_id: 'other-parent', turn_id: turn.turn.id } }); assert.equal(mismatch.isError, true);
  const b = (await call('create_worker', { operationId: 'create-B', runId: 'run', expectedRevision: await revision(), taskId: 'B' })).structuredContent;
  await call('send_instruction', { operationId: 'send-B', runId: 'run', expectedRevision: await revision(), taskId: 'B', target: b, agent: { model: 'mock', effort: 'low' }, text: 'fixture-human-approval' });
  const waiting = (await call('get_status', { runId: 'run' })).structuredContent.requests[0]; assert(waiting);
  assert.equal((await pipeRequest(pipeName, { method: 'mcp_human_response', metadata, args: { worker: b, key: waiting.key, payloadHash: waiting.payloadHash, formGeneration: waiting.formGeneration, action: 'accept' } })).ok, false, 'an external process cannot impersonate the parent elicitation callback');
  const answered = await call('answer_request', { operationId: 'review-B', runId: 'run', expectedRevision: await revision(), requestKey: waiting.key, answer: { action: { answers: ['decline'] } } }, metadata, false, 'accept');
  assert.equal(answered.structuredContent.state, 'response_sent', 'formal elicitation must traverse the real native gateway');
  assert.equal(JSON.parse(readFileSync(path.join(assignments[1].cwd, 'approval-response.json'), 'utf8')).result.action, 'accept');
  assert.equal((await call('get_status', { runId: 'run' })).structuredContent.requests.length, 0);
  const stopped: any = await request('stop'); assert.equal(stopped.run.state, 'stopped');
});
