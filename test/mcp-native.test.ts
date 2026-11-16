import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeRequest, relayRequest } from '../src/protocol.js';
import { gitScope } from './fixtures/git-scope.js';

test('native_owned_parent_MCP_permit_worker_report_and_unknown_peer_boundary', { timeout: 75000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cc02-native-')), state = path.join(root, 'state');
  const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const realExe = path.resolve('.local/chat-control-build/MockCodex.exe'), hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe'), control = path.resolve('.local/chat-control-build/MeristemControl.exe');
  const relay = path.join(root, 'CodexRelay.exe'); copyFileSync(path.resolve('.local/chat-control-build/CodexRelay.exe'), relay);
  const pipeName = `meristem-cc01-control-${randomUUID()}`, parentPipe = `meristem-cc00-${randomUUID()}`, configPath = path.join(root, 'config.json'), entryPoint = path.resolve('dist/src/cli.js'), mcpEntry = path.resolve('dist/src/mcp.js'), planPath = path.join(root, 'plan.md');
  writeFileSync(planPath, 'CC-02 native fixture');
  const scopeGit = gitScope(root), assignments = scopeGit.assignments;
  const config = { stateDirectory: state, repository: process.cwd(), runId: 'run', pipeName, nodeExecutable: process.execPath, nodeSha256: sha(process.execPath), entryPoint, entrySha256: sha(entryPoint), runtime: { hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: root, fixture: true }, assignments: [], mcp: { wake: { model: 'mock', effort: 'low', maxTurns: 12 }, parentRelay: { pipeName: parentPipe, threadId: 'P' }, entryPoint: mcpEntry, entrySha256: sha(mcpEntry), scope: { fixture: true, planPath, repositoryId: 'repo', ...scopeGit } } };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(relay + '.json', JSON.stringify({ realExecutable: realExe, realSha256: sha(realExe), pipeName: parentPipe, allowedCwds: [root], testProfile: 'CC-00R-CC02-fixture', controlHost: { executable: control, sha256: sha(control), configPath, configSha256: sha(configPath), parentThreadId: 'P' } }));
  const child = spawn(relay, ['app-server'], { cwd: root, windowsHide: true, stdio: 'pipe' });
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
  const pending = await call('start_run', { planPath, operationId: 'start' }); assert.equal(pending.structuredContent.state, 'awaiting_authorization');
  const selfAuthorize = path.join(root, 'self-authorize.json'), selfOutput = selfAuthorize + '.result';
  writeFileSync(selfAuthorize, JSON.stringify({ pipeName, direct: { ...discovery, method: 'authorize', bindingId: pending.structuredContent.bindingId }, output: selfOutput }));
  await ui('fixture/mcp', { executable: process.execPath, helper: path.resolve('dist/test/fixtures/native-mcp-client.js'), file: selfAuthorize });
  assert.equal(JSON.parse(readFileSync(selfOutput, 'utf8')).ok, false);
  const authorized = spawnSync(process.execPath, ['dist/src/cli.js', 'authorize', '--run', 'run', '--state', state, '--binding', pending.structuredContent.bindingId], { cwd: process.cwd(), input: pending.structuredContent.bindingId + '\n', windowsHide: true, encoding: 'utf8' });
  assert.equal(authorized.status, 0, authorized.stderr);
  assert.equal((await call('start_run', { planPath, operationId: 'start' })).structuredContent.state, 'active');
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
  const answered = await call('answer_request', { operationId: 'review-B', runId: 'run', expectedRevision: await revision(), requestKey: waiting.key }, metadata, false, 'accept');
  assert.equal(answered.structuredContent.state, 'response_sent', 'formal elicitation must traverse the real native gateway');
  assert.equal(JSON.parse(readFileSync(path.join(assignments[1].cwd, 'approval-response.json'), 'utf8')).result.action, 'accept');
  assert.equal((await call('get_status', { runId: 'run' })).structuredContent.requests.length, 0);
  const stopped: any = await request('stop'); assert.equal(stopped.run.state, 'stopped');
});
