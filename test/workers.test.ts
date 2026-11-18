import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { permissionOverrides, verifyIsolation, WorkerRuntime } from '../src/workers.js';
import { pipeRequest, Rpc } from '../src/protocol.js';
import { RequestFailure } from '../src/failures.js';
import { spawnSync } from 'node:child_process';
import { createMcpServer } from '../src/mcp.js';
import { Store } from '../src/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe');
const realExe = path.resolve('.local/chat-control-build/MockCodex.exe');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('task_settings_are_validated_against_live_catalog_and_permit', { timeout: 20000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'mc07-state-')), cwd = mkdtempSync(path.join(tmpdir(), 'mc07-work-'));
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  const assignment = { cwd, workerId: 'A', model: 'mock', effort: 'low', permissionProfileId: 'workspace', permissionPermit: { allowedProfileIds: ['workspace'], writableRoots: [cwd], allowedReviewers: ['auto_review' as const] } };
  for (const bad of [
    { permissionProfileId: 'full-access' },
    { permissionPermit: { ...assignment.permissionPermit, writableRoots: [state] } },
    { permissionPermit: { ...assignment.permissionPermit, allowedReviewers: ['guardian_subagent'] } },
    { model: 'not-in-catalog' }, { effort: 'invalid' }
  ]) await assert.rejects(async () => {
    const unexpected = await runtime.start({ ...assignment, ...bad } as any);
    await runtime.stop(unexpected, 'unexpected_test_start');
  });
  for (const field of ['model', 'reasoningEffort', 'approvalsReviewer', 'approvalPolicy', 'activePermissionProfile', 'runtimeWorkspaceRoots']) {
    writeFileSync(path.join(cwd, 'mc07-ack.json'), JSON.stringify({ [field]: null }));
    await assert.rejects(async () => {
      const unexpected = await runtime.start(assignment); await runtime.stop(unexpected, 'unexpected_test_start');
    }, /confirmed/);
  }
  writeFileSync(path.join(cwd, 'mc07-ack.json'), '{}');
  const worker = await runtime.start(assignment); t.after(() => runtime.stop(worker, 'test_cleanup'));
  assert.deepEqual((runtime as any).settings(worker).permissions, { permissionProfileId: 'meristem-managed', approvalsReviewer: 'auto_review', writableRoots: [cwd] });
});

test('same_history_uses_new_task_agent_and_no_old_grant', { timeout: 20000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'mc07-history-state-')), cwd = mkdtempSync(path.join(tmpdir(), 'mc07-history-'));
  writeFileSync(path.join(cwd, 'model-catalog.json'), JSON.stringify({ first: { data: ['mock', 'mock-next'].map(model => ({ model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] })), nextCursor: null } }));
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) assert.equal(spawnSync('git', args, { cwd, windowsHide: true }).status, 0);
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  const assignment = { cwd, workerId: 'A', model: 'mock', effort: 'low', permissionProfileId: 'workspace', permissionPermit: { allowedProfileIds: ['workspace'], writableRoots: [cwd], allowedReviewers: ['auto_review' as const] } };
  const first = await runtime.start(assignment); t.after(() => runtime.stop(first, 'test_cleanup'));
  await runtime.send(first, 'fixture-complete-before-ack'); await runtime.releaseCompleted(first);
  const restarted = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  const next = await restarted.start({ ...assignment, model: 'mock-next', effort: 'medium', permissionPermit: { ...assignment.permissionPermit, allowedReviewers: ['user'] },
    historySource: { threadId: first.threadId, modelProvider: runtime.registration(first).modelProvider } });
  t.after(() => restarted.stop(next, 'test_cleanup'));
  assert.notEqual(next.threadId, first.threadId); assert.notEqual(next.attemptId, first.attemptId);
  const applied = restarted.settings(next);
  assert.equal(applied.agent.model, 'mock-next'); assert.equal(applied.agent.effort, 'medium');
  assert.equal(applied.permissions.approvalsReviewer, 'user'); assert.equal(applied.history, 'fresh_handoff');
  await assert.rejects(restarted.send(first, 'stale'));
  await restarted.send(next, 'fixture-complete-before-ack'); assert.equal((await restarted.releaseCompleted(next)).state, 'stopped');
});

test('read-only handoff starts a fresh thread without workspace grants and rejects weakened ACKs', { timeout: 30000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'review-state-')), cwd = mkdtempSync(path.join(tmpdir(), 'review-work-'));
  writeFileSync(path.join(cwd, 'model-catalog.json'), JSON.stringify({ first: { data: [
    { model: 'mock', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { model: 'mock-next', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }
  ], nextCursor: null } }));
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  const assignment = { cwd, workerId: 'R', model: 'mock', effort: 'low', permissionProfileId: 'read-only',
    permissionPermit: { allowedProfileIds: ['workspace', 'read-only'], writableRoots: [cwd], allowedReviewers: ['auto_review' as const] } };
  const first = await runtime.start({ ...assignment, permissionProfileId: 'workspace', gitApprovalRoots: [cwd] });
  t.after(() => runtime.stop(first, 'test_cleanup'));
  await runtime.send(first, 'fixture-complete-before-ack'); await runtime.releaseCompleted(first);
  const handoff = { ...assignment, model: 'mock-next', effort: 'high', historySource: { threadId: first.threadId, modelProvider: 'mock' } };
  await assert.rejects(runtime.start({ ...handoff, gitApprovalRoots: [cwd] }), /Git grants/);
  for (const bad of [
    { sandbox: { type: 'workspaceWrite', writableRoots: [cwd] } }, { sandbox: { type: 'readOnly', networkAccess: true } }, { sandbox: null },
    { activePermissionProfile: { id: 'meristem-read-only', extends: ':workspace' } }, { approvalPolicy: 'on-request' },
    { approvalPolicy: { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: true, mcp_elicitations: true } } },
  ]) {
    writeFileSync(path.join(cwd, 'mc07-ack.json'), JSON.stringify(bad));
    await assert.rejects(runtime.start(handoff), /not confirmed/);
  }
  writeFileSync(path.join(cwd, 'mc07-ack.json'), '{}');
  const review = await runtime.start(handoff); t.after(() => runtime.stop(review, 'test_cleanup'));
  assert.notEqual(first.threadId, review.threadId);
  assert.deepEqual(runtime.settings(review).permissions, { permissionProfileId: 'meristem-read-only', writableRoots: [], approvalsReviewer: 'auto_review' });
  assert.equal(runtime.settings(review).history, 'fresh_handoff');
  assert.match(runtime.terminalTelemetry(review).permissionSummary!, /読み取り専用/);
  assert.equal(runtime.terminalTelemetry(review).appliedAgent, 'mock-next / high');
  assert.deepEqual(runtime.terminalActivity(review)!.read(0, 10).activityEvents, []);
});

test('the terminal reports only confirmed setting changes for its own thread', async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'term-settings-')), cwd = mkdtempSync(path.join(tmpdir(), 'term-work-'));
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  const worker = await runtime.start({ cwd, workerId: 'A', model: 'mock', effort: 'low' });
  t.after(() => runtime.stop(worker, 'test_cleanup'));
  const log = runtime.terminalActivity(worker)!;
  assert.deepEqual(log.read(0, 10).activityEvents, []);
  const changes = path.join(cwd, 'observed-settings.json');
  const settings = { cwd, modelProvider: 'mock', model: 'mock', effort: 'medium' };
  for (const invalid of [{ threadId: 'unrelated', threadSettings: settings }, { threadSettings: { ...settings, effort: null } }]) {
    writeFileSync(changes, JSON.stringify(invalid)); await runtime.send(worker, 'fixture-complete-before-ack');
  }
  assert.deepEqual(log.read(0, 10).activityEvents, []);
  for (const current of [settings, settings, { ...settings, model: 'mock-next', effort: 'high', activePermissionProfile: { id: 'meristem-read-only', extends: ':read-only' } }]) {
    writeFileSync(changes, JSON.stringify({ threadSettings: current })); await runtime.send(worker, 'fixture-complete-before-ack');
  }
  assert.deepEqual(log.read(0, 10).activityEvents.map(e => e.text), ['[設定変更]low→medium', '[設定変更]mock→mock-next, medium→high']);
  assert.equal(runtime.terminalTelemetry(worker).appliedAgent, 'mock-next / high');
  assert.match(runtime.terminalTelemetry(worker).permissionSummary!, /^meristem-managed/);
  assert.deepEqual(log.read(2, 10).activityEvents, []);
  assert.equal(log.latest, undefined);
});

test('read-only worker checks the complete MCP inventory at startup and before each turn', { timeout: 30000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'review-tools-')), cwd = mkdtempSync(path.join(tmpdir(), 'review-work-'));
  const entryPoint = path.resolve('dist/src/mcp.js');
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true,
    mcp: { pipeName: 'meristem-test', entryPoint, entrySha256: sha(entryPoint) } });
  const assignment = { cwd, workerId: 'R', model: 'mock', effort: 'low', permissionProfileId: 'read-only',
    permissionPermit: { allowedProfileIds: ['read-only'], writableRoots: [cwd], allowedReviewers: ['user' as const] } };
  const server = { name: 'meristem', runtimeStatus: 'connected', pluginId: null, httpOrigin: null, toolsError: null, tools: { report: {}, start_run: {} } };
  const inventoryFile = path.join(cwd, 'review-mcp-inventory.json');
  const nextInventory = path.join(cwd, 'review-mcp-next.json');
  const starting = { data: [{ ...server, runtimeStatus: 'starting' }], nextCursor: null };
  const connected = { data: [server], nextCursor: null };
  const mixed = { data: [server, { ...server, name: 'other' }], nextCursor: null };
  for (const bad of [mixed, { data: [server], nextCursor: 'more' }, { data: [server] },
    starting, { data: [{ ...server, pluginId: 'other' }], nextCursor: null }]) {
    writeFileSync(inventoryFile, JSON.stringify(bad));
    await assert.rejects(runtime.start(assignment), /read-only MCP inventory/);
  }
  writeFileSync(inventoryFile, JSON.stringify(starting));
  writeFileSync(nextInventory, JSON.stringify(connected));
  const worker = await runtime.start(assignment); t.after(() => runtime.stop(worker, 'test_cleanup'));
  for (const blocked of [mixed, starting]) {
    writeFileSync(inventoryFile, JSON.stringify(blocked));
    writeFileSync(nextInventory, JSON.stringify(connected));
    await assert.rejects(runtime.send(worker, 'fixture-start-marker'), error => error instanceof RequestFailure && error.delivery === 'not_sent');
  }
  assert.equal(existsSync(path.join(cwd, 'worker.marker')), false);
});

test('questions from a fifth worker remain visible and answerable', { timeout: 30000 }, async t => {
  const { runtime, worker } = await start(t);
  const workers = [worker];
  for (const workerId of ['B', 'C', 'D', 'E']) {
    const cwd = mkdtempSync(path.join(tmpdir(), 'mc12-question-'));
    const next = await runtime.start({ cwd, workerId, model: 'mock', effort: 'low' });
    t.after(() => runtime.stop(next, 'test_cleanup'));
    workers.push(next);
  }
  for (const target of workers) await runtime.send(target, 'fixture-question');
  for (let i = 0; i < 50 && runtime.pendingRequests().length < workers.length; i++) await delay(20);
  const pending = runtime.pendingRequests();
  assert.equal(pending.length, workers.length);
  const last = pending.find(item => item.worker.attemptId === workers[4].attemptId)!;
  await runtime.answerQuestion(workers[4], last.key, { format: { answers: ['JSON'] } });
});

test('control_state_remains_denied', () => {
  const state = mkdtempSync(path.join(tmpdir(), 'mc07-denied-')), cwd = mkdtempSync(path.join(tmpdir(), 'mc07-allowed-'));
  const overrides = (permissionOverrides as any)(state, [cwd]);
  assert.equal(overrides['permissions.meristem-managed'].filesystem[state], 'deny');
  assert.equal(overrides['permissions.meristem-managed'].filesystem[cwd], 'write');
  assert.throws(() => (permissionOverrides as any)(state, [path.dirname(state)]), /management/);
  assert.throws(() => (permissionOverrides as any)(state, [state]), /management/);
  const config = { stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true };
  assert.throws(() => verifyIsolation(config, cwd, 'meristem-read-only' as any), /unsupported isolation task profile/);
});
async function start(t: { after(fn: () => Promise<unknown>): void }, onState?: ConstructorParameters<typeof WorkerRuntime>[1], gitApprovalRoots?: string[], onRequest?: ConstructorParameters<typeof WorkerRuntime>[2]) {
  const state = mkdtempSync(path.join(tmpdir(), 'cc01-runtime-')), cwd = mkdtempSync(path.join(tmpdir(), 'cc01-worker-'));
  writeFileSync(path.join(cwd, 'uncommitted.txt'), 'preserve');
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true }, onState, onRequest);
  const worker = await runtime.start({ cwd, workerId: 'A', model: 'mock', effort: 'low', gitApprovalRoots });
  t.after(() => runtime.stop(worker, 'test_cleanup'));
  return { runtime, worker, cwd };
}

test('selected_windows_sandbox_is_explicit_on_start_and_resume_and_invalid_values_fail', { timeout: 20000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'cc06-sandbox-')), cwd = mkdtempSync(path.join(tmpdir(), 'cc06-sandbox-work-'));
  const config = { stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true, windowsSandbox: 'mxc' as const };
  assert.throws(() => new WorkerRuntime({ ...config, windowsSandbox: 'disabled' } as any), /Windows sandbox/);
  writeFileSync(path.join(cwd, 'expected-sandbox.txt'), 'mxc');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) assert.equal(spawnSync('git', args, { cwd, windowsHide: true }).status, 0);
  const runtime = new WorkerRuntime(config);
  const assignment = { cwd, workerId: 'A', model: 'mock', effort: 'low' };
  const first = await runtime.start(assignment); t.after(() => runtime.stop(first, 'test_cleanup'));
  await runtime.send(first, 'fixture-complete-before-ack'); await runtime.releaseCompleted(first);
  const resumed = await runtime.start({ ...assignment, previous: first }); t.after(() => runtime.stop(resumed, 'test_cleanup'));
  assert.notEqual(resumed.threadId, first.threadId);
});

test('request_audit_failure_cannot_prevent_native_worker_stop', { timeout: 20000 }, async t => {
  let failAudit = false;
  const f = await start(t, undefined, undefined, item => { if (failAudit && item.state === 'cancelled') throw new Error('audit write failed'); });
  await f.runtime.send(f.worker, 'fixture-human-approval');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  const pending = f.runtime.pendingRequests()[0]; assert.equal(pending?.state, 'pending');
  failAudit = true;
  try {
    const result = await f.runtime.stop(f.worker, 'terminal_closed');
    assert.equal(result.state, 'stopped'); assert(result.evidenceRefs.includes('native_job_empty'));
    assert(result.evidenceRefs.includes('request_cancel_record_failed'));
    await assert.rejects(f.runtime.answerRequest(f.worker, pending, 'accept'), /no longer/);
  } finally { failAudit = false; }
});
test('stale_epoch_or_reused_pid_cannot_control_worker', { timeout: 15000 }, async t => {
  const f = await start(t);
  await assert.rejects(f.runtime.stop({ ...f.worker, ownerEpoch: 'stale' }, 'manual'), /identity/);
  const identity = f.runtime.registration(f.worker);
  assert(identity.hostCreated && identity.childCreated && identity.jobId);
  const reply = await pipeRequest(identity.pipeName, { method: 'stop', ownerEpoch: 'wrong' });
  assert.equal(reply.ok, false);
  assert.equal((await f.runtime.status(f.worker)).state, 'running');
});

test('git_grant_cannot_cover_management_state_or_its_descendants', { timeout: 15000 }, async t => {
  const f = await start(t), state = mkdtempSync(path.join(tmpdir(), 'cc06-private-'));
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  const child = path.join(state, 'private'); writeFileSync(child, 'private');
  for (const root of [tmpdir(), state, child]) {
    const creation = runtime.start({ cwd: f.cwd, workerId: 'unsafe', model: 'mock', effort: 'low', gitApprovalRoots: [root] });
    void creation.then(worker => t.after(() => runtime.stop(worker, 'test_cleanup')), () => {});
    await assert.rejects(creation, /management state/);
  }
});
test('worker_stop_confirms_descendants_and_preserves_uncommitted_work', { timeout: 15000 }, async t => {
  const f = await start(t); await f.runtime.send(f.worker, 'fixture-start-marker');
  const marker = path.join(f.cwd, 'worker.marker');
  for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(30);
  assert(existsSync(marker));
  const result = await f.runtime.stop(f.worker, 'manual'); assert.equal(result.state, 'stopped');
  const before = readFileSync(marker).length; await delay(2000); assert.equal(readFileSync(marker).length, before);
  assert.equal(readFileSync(path.join(f.cwd, 'uncommitted.txt'), 'utf8'), 'preserve');
});
test('normal_completion_releases_actual_host_without_run_stop', { timeout: 15000 }, async t => {
  const f = await start(t);
  await f.runtime.send(f.worker, 'fixture-complete-before-ack');
  const result = await f.runtime.releaseCompleted(f.worker);
  assert.equal(result.state, 'stopped');
});
test('concurrent_instruction_reserves_worker_before_IO', { timeout: 15000 }, async t => {
  const f = await start(t);
  const results = await Promise.allSettled([f.runtime.send(f.worker, 'one'), f.runtime.send(f.worker, 'two')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});
test('appserver_crash_stops_descendants_without_later_request', { timeout: 15000 }, async t => {
  const f = await start(t); await f.runtime.send(f.worker, 'fixture-start-marker');
  const marker = path.join(f.cwd, 'worker.marker');
  for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(30);
  assert(existsSync(marker));
  process.kill(f.runtime.registration(f.worker).childPid);
  await delay(300); const before = readFileSync(marker).length;
  await delay(2000); assert.equal(readFileSync(marker).length, before);
  const result = await f.runtime.stop(f.worker, 'crash_evidence');
  assert.equal(result.state, 'unknown');
  assert(result.evidenceRefs.includes('rpc_process_closed'));
  assert(result.evidenceRefs.some(ref => /^host_exit_-?\d+$/.test(ref)));
});
test('real_RPC_rejections_keep_only_allowlisted_failure_categories', { timeout: 15000 }, async t => {
  const f = await start(t);
  for (const [text, kind] of [['fixture-auth-error', 'authentication_required'], ['fixture-limit-error', 'limit_reached']]) {
    await assert.rejects(f.runtime.send(f.worker, text), error => error instanceof RequestFailure && error.kind === kind && error.delivery === 'rejected' && !error.message.includes('secret'));
  }
});
test('unexpected_appserver_exit_before_ACK_keeps_exit_code_and_unknown_delivery', { timeout: 15000 }, async t => {
  const f = await start(t);
  await assert.rejects(f.runtime.send(f.worker, 'fixture-exit-before-ack'), /delivery unknown \(process_closed\)/);
  const stopped = await f.runtime.stop(f.worker, 'crash');
  assert.equal(stopped.state, 'unknown');
  assert(stopped.evidenceRefs.includes('rpc_process_closed'));
  assert(stopped.evidenceRefs.includes('host_exit_23'));
});
test('rejects_invalid_model_effort_before_send', { timeout: 15000 }, async t => {
  const f = await start(t);
  await assert.rejects(f.runtime.send(f.worker, 'fixture-start-marker', { model: 'mock', effort: 'invalid' }), error => error instanceof RequestFailure && error.delivery === 'not_sent');
  assert.equal(existsSync(path.join(f.cwd, 'worker.marker')), false);
  await f.runtime.send(f.worker, 'fixture-complete-before-ack', { model: 'mock', effort: 'low' });
});
test('versioned_model_name_reaches_catalog_validation', { timeout: 15000 }, async () => {
  const state = mkdtempSync(path.join(tmpdir(), 'cc06-model-')), cwd = mkdtempSync(path.join(tmpdir(), 'cc06-model-work-'));
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  await assert.rejects(runtime.start({ cwd, workerId: 'A', model: 'mock.1', effort: 'low' }), /agent is not in catalog/);
});
test('catalog_pages_and_live_model_additions_removals_are_checked_before_delivery', { timeout: 20000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'cc06-catalog-')), cwd = mkdtempSync(path.join(tmpdir(), 'cc06-catalog-work-'));
  const catalog = (model: string, effort: string) => writeFileSync(path.join(cwd, 'model-catalog.json'), JSON.stringify({ first: { data: [], nextCursor: 'next' }, next: { data: [{ model, supportedReasoningEfforts: [{ reasoningEffort: effort }] }], nextCursor: null } }));
  catalog('mock.1', 'low');
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  const worker = await runtime.start({ cwd, workerId: 'A', model: 'mock.1', effort: 'low' });
  t.after(() => runtime.stop(worker, 'test_cleanup'));
  catalog('mock.2', 'medium');
  await assert.rejects(runtime.send(worker, 'fixture-start-marker'), e => e instanceof RequestFailure && e.delivery === 'not_sent' && e.reason === 'agent_not_in_catalog');
  assert.equal(existsSync(path.join(cwd, 'worker.marker')), false);
  writeFileSync(path.join(cwd, 'model-catalog.json'), JSON.stringify({ first: { data: [], nextCursor: 'first' } }));
  await assert.rejects(runtime.send(worker, 'fixture-start-marker'), e => e instanceof RequestFailure && e.delivery === 'not_sent');
  catalog('mock.2', 'medium');
  await runtime.send(worker, 'fixture-complete-before-ack', { model: 'mock.2', effort: 'medium' });
  assert.equal((await runtime.releaseCompleted(worker)).state, 'stopped');
});
test('initial_catalog_fallback_checks_the_planned_pair_before_start_or_first_delivery', { timeout: 20000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'routing-worker-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'routing-work-'));
  const baseline = { model: 'mock', effort: 'low' }, recommendation = { model: 'mock-next', effort: 'medium' };
  const catalog = (...choices: typeof baseline[]) => writeFileSync(path.join(cwd, 'model-catalog.json'), JSON.stringify({
    first: { data: choices.map(({ model, effort }) => ({ model, supportedReasoningEfforts: [{ reasoningEffort: effort }] })), nextCursor: null }
  }));
  const runtime = new WorkerRuntime({ stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true });
  const assignment = { cwd, workerId: 'A', ...recommendation, initialFallback: baseline };
  catalog(baseline);
  const first = await runtime.start(assignment);
  t.after(() => runtime.stop(first, 'test_cleanup'));
  assert.deepEqual(runtime.settings(first).agent, { ...baseline, permissionProfileId: 'workspace' });
  assert.equal(runtime.settings(first).initialFallback, 'agent_not_in_catalog');
  await runtime.stop(first, 'test_cleanup');

  catalog(recommendation, baseline, { model: 'provider/custom', effort: 'other' });
  const second = await runtime.start(assignment);
  t.after(() => runtime.stop(second, 'test_cleanup'));
  assert.equal(runtime.settings(second).initialFallback, undefined);
  writeFileSync(path.join(cwd, 'model-catalog.json'), JSON.stringify({ first: { data: [null], nextCursor: null } }));
  await assert.rejects(runtime.send(second, 'fixture-start-marker', recommendation),
    e => e instanceof RequestFailure && e.delivery === 'not_sent' && !e.reason);
  assert.equal(existsSync(path.join(cwd, 'worker.marker')), false);
  catalog(baseline);
  assert.equal(await runtime.send(second, 'fixture-complete-before-ack', recommendation), 'agent_not_in_catalog');
  assert.equal((await runtime.releaseCompleted(second)).state, 'stopped');
});
test('completed_worker_history_can_resume_in_new_owned_attempt', { timeout: 20000 }, async t => {
  const f = await start(t);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: f.cwd, windowsHide: true }).status, 0);
  await f.runtime.send(f.worker, 'fixture-complete-before-ack');
  await f.runtime.releaseCompleted(f.worker);
  const next = await f.runtime.start({ cwd: f.cwd, workerId: 'A', model: 'mock', effort: 'low', previous: f.worker });
  t.after(() => f.runtime.stop(next, 'test_cleanup'));
  assert.notEqual(next.threadId, f.worker.threadId); assert.notEqual(next.attemptId, f.worker.attemptId); assert.notEqual(next.ownerEpoch, f.worker.ownerEpoch);
  await assert.rejects(f.runtime.send(f.worker, 'late'), /not_sent|failed|stopping|transport/);
  await f.runtime.send(next, 'fixture-complete-before-ack');
  await f.runtime.releaseCompleted(next);
  writeFileSync(path.join(f.cwd, 'dirty.txt'), 'preserve');
  await assert.rejects(f.runtime.start({ cwd: f.cwd, workerId: 'A', model: 'mock', effort: 'low', previous: next }), /clean/);
});

test('history_view_does_not_start_turn_or_restore_permissions', { timeout: 20000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'mc10a-state-')), cwd = mkdtempSync(path.join(tmpdir(), 'mc10a-work-'));
  const config = { stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: state, fixture: true };
  const runtime = new WorkerRuntime(config);
  const worker = await runtime.start({ cwd, workerId: 'A', model: 'mock', effort: 'low' });
  t.after(() => runtime.stop(worker, 'test_cleanup'));
  await runtime.send(worker, 'fixture-complete-before-ack');
  const stop = await runtime.releaseCompleted(worker);
  assert.equal(stop.state, 'stopped');

  const reader = new WorkerRuntime(config, () => assert.fail('history emitted a worker state change'));
  // Supply the persisted history reply at the RPC boundary. The native fixture's normal thread/read is reserved for malformed frames.
  const calls: Array<{ method: string; params: unknown }> = [];
  const call = Rpc.prototype.call;
  const thread = { id: worker.threadId, cwd, parentThreadId: null, modelProvider: 'mock' };
  const turns = [{
    id: 'saved-turn', status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'previous question' }, { type: 'localImage', path: 'private-image' }] },
      { type: 'reasoning', content: ['private-reasoning'] },
      { type: 'commandExecution', aggregatedOutput: 'private-output' },
      { type: 'agentMessage', text: 'previous answer' },
    ],
  }];
  let reply: unknown = { thread, activePermissionProfile: { id: 'old-grant' } };
  let page: unknown = { data: turns, nextCursor: 'older-turns' };
  t.mock.method(Rpc.prototype, 'call', function (this: Rpc, method: string, params: Record<string, unknown>) {
    calls.push({ method, params });
    if (method === 'thread/read') return Promise.resolve(reply);
    if (method === 'thread/turns/list') return Promise.resolve(page);
    return call.call(this, method, params);
  });

  // The registration is already persisted. A fresh runtime can read it after its worker has stopped.
  const saved = { worker, cwd };
  assert.deepEqual(await reader.readHistory(worker, saved), { threadId: worker.threadId, modelProvider: 'mock', turns: [{
    id: 'saved-turn', status: 'completed', messages: [{ role: 'user', text: 'previous question' }, { role: 'assistant', text: 'previous answer' }],
  }], nextCursor: 'older-turns' });
  assert.deepEqual(calls.map(({ method }) => method), ['initialize', 'thread/read', 'thread/turns/list']);
  assert.deepEqual(calls[1].params, { threadId: worker.threadId, includeTurns: false });
  assert.deepEqual(calls[2].params, { threadId: worker.threadId, itemsView: 'summary', limit: 8 });
  assert.deepEqual(await runtime.stop(worker, 'already_stopped'), stop);
  assert.deepEqual(reader.pendingRequests(), []);

  for (const key of ['ownerId', 'ownerEpoch', 'attemptId', 'workerId', 'threadId'] as const) {
    await assert.rejects(reader.readHistory({ ...worker, [key]: 'stale' }, saved), /worker identity mismatch/);
  }
  assert.equal(calls.length, 3);
  for (const change of [{ id: 'other-thread' }, { cwd: state }, { parentThreadId: 'other-thread' }, { modelProvider: '' }]) {
    reply = { thread: { ...thread, ...change } };
    await assert.rejects(reader.readHistory(worker, saved), /history identity or response mismatch/);
    assert.equal(calls.at(-1)?.method, 'thread/read');
  }
  reply = { thread };
  page = { data: [], nextCursor: null };
  assert.deepEqual(await reader.readHistory(worker, saved, 'older-turns'), { threadId: worker.threadId, modelProvider: 'mock', turns: [], nextCursor: null });
  assert.deepEqual(calls.at(-1)?.params, { threadId: worker.threadId, itemsView: 'summary', limit: 8, cursor: 'older-turns' });
  page = { data: [], nextCursor: 'older-turns' };
  await assert.rejects(reader.readHistory(worker, saved, 'older-turns'), /invalid history page/);
});

test('failed_history_read_leaves_live_worker_transport_usable', { timeout: 15000 }, async t => {
  const { runtime, worker, cwd } = await start(t);
  // The normal native fixture exits on thread/read with an incomplete, private reply.
  await assert.rejects(runtime.readHistory(worker, { worker, cwd }), error =>
    error instanceof Error && /thread\/read/.test(error.message) && !error.message.includes('management-private-payload'));
  await runtime.send(worker, 'fixture-complete-before-ack');
  assert.equal((await runtime.releaseCompleted(worker)).state, 'stopped');
});
test('auto_review_denial_reaches_runtime_and_blocks_human_accept', { timeout: 20000 }, async t => {
  const f = await start(t);
  await f.runtime.send(f.worker, 'fixture-human-approval fixture-auto-review-denial');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  const item = f.runtime.pendingRequests()[0]; assert.equal(item?.state, 'unsupported');
  await assert.rejects(f.runtime.answerRequest(f.worker, item, 'accept'));
  assert.equal(existsSync(path.join(f.cwd, 'approval-response.json')), false);
});

test('human_approval_response_reaches_original_RPC_then_completion_and_cannot_replay', { timeout: 20000 }, async t => {
  const f = await start(t);
  await f.runtime.send(f.worker, 'fixture-human-approval');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  const item = f.runtime.pendingRequests()[0]; assert.equal(item.state, 'pending');
  await assert.rejects(f.runtime.answerRequest(f.worker, item, 'accept', () => false), /stopped/);
  assert.equal(existsSync(path.join(f.cwd, 'approval-response.json')), false);
  await f.runtime.answerRequest(f.worker, item, 'accept');
  await assert.rejects(f.runtime.answerRequest(f.worker, item, 'accept'));
  for (let i = 0; i < 100 && f.runtime.pendingRequests().length; i++) await delay(20);
  assert.equal(f.runtime.pendingRequests().length, 0);
  const response = JSON.parse(readFileSync(path.join(f.cwd, 'approval-response.json'), 'utf8'));
  assert.equal(response.id, 'human-approval'); assert.deepEqual(response.result, { action: 'accept', content: {}, _meta: null });
  assert.equal((await f.runtime.releaseCompleted(f.worker)).state, 'stopped');
});

test('scoped_git_approval_roundtrips_native_RPC_without_replay_or_session_grants', { timeout: 20000 }, async t => {
  for (const kind of ['permissions', 'command']) {
    const root = mkdtempSync(path.join(tmpdir(), 'cc06-git-'));
    const f = await start(t, undefined, [root]);
    writeFileSync(path.join(f.cwd, 'git-approval-root.txt'), root);
    await f.runtime.send(f.worker, `fixture-git-${kind}`);
    for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
    const item = f.runtime.pendingRequests()[0]; assert.equal(item?.kind, kind); assert.equal(item.state, 'pending');
    await f.runtime.answerRequest(f.worker, item, 'accept');
    await assert.rejects(f.runtime.answerRequest(f.worker, item, 'accept'));
    for (let i = 0; i < 100 && (f.runtime.pendingRequests().length || f.runtime.completedTurn(f.worker) !== item.turnId); i++) await delay(20);
    assert.equal(f.runtime.pendingRequests().length, 0);
    const response = JSON.parse(readFileSync(path.join(f.cwd, 'approval-response.json'), 'utf8'));
    assert.equal(response.id, 'human-approval');
    assert.deepEqual(response.result, kind === 'command' ? { decision: 'accept' } : { permissions: { fileSystem: { read: null, write: [root] } }, scope: 'turn' });
    assert.equal((await f.runtime.releaseCompleted(f.worker)).state, 'stopped');
  }
});
test('question_response_reaches_original_RPC_and_invalid_answer_is_not_sent', { timeout: 20000 }, async t => {
  const f = await start(t); await f.runtime.send(f.worker, 'fixture-question');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  const item = f.runtime.pendingRequests()[0]; assert.equal(item?.kind, 'question');
  await assert.rejects(f.runtime.answerQuestion(f.worker, item.key, { wrong: { answers: ['JSON'] } }), e => e instanceof RequestFailure && e.delivery === 'not_sent');
  assert.equal(existsSync(path.join(f.cwd, 'approval-response.json')), false);
  await f.runtime.answerQuestion(f.worker, item.key, { format: { answers: ['JSON'] } });
  for (let i = 0; i < 100 && f.runtime.pendingRequests().length; i++) await delay(20);
  const response = JSON.parse(readFileSync(path.join(f.cwd, 'approval-response.json'), 'utf8'));
  assert.equal(response.id, 'human-approval'); assert.deepEqual(response.result, { answers: { format: { answers: ['JSON'] } } });
  assert.equal((await f.runtime.releaseCompleted(f.worker)).state, 'stopped');
});

test('multiple_question_fixture_roundtrips_free_text_and_rejects_partial_or_stale_answers', { timeout: 20000 }, async t => {
  const f = await start(t); await f.runtime.send(f.worker, 'fixture-question-multiple');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  const item = f.runtime.pendingRequests()[0]; assert.equal(item?.kind, 'question');
  assert.deepEqual(JSON.parse(item.detail).questions.map((q: any) => q.id), ['format', 'reason']);
  await assert.rejects(f.runtime.answerQuestion(f.worker, item.key, { format: { answers: ['JSON'] } }));
  assert.equal(existsSync(path.join(f.cwd, 'approval-response.json')), false);
  const answers = { format: { answers: ['JSON'] }, reason: { answers: ['日本語の自由記述'] } };
  await f.runtime.answerQuestion(f.worker, item.key, answers);
  await assert.rejects(f.runtime.answerQuestion(f.worker, item.key, answers));
  for (let i = 0; i < 100 && !f.runtime.completedTurn(f.worker); i++) await delay(20);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.cwd, 'approval-response.json'), 'utf8')).result, { answers });
  assert.equal((await f.runtime.releaseCompleted(f.worker)).state, 'stopped');
});

test('waiting_parent_elicitation_keeps_dispatched_worker_running_and_inbox_durable', { timeout: 20000 }, async t => {
  const state = mkdtempSync(path.join(tmpdir(), 'mc02-inbox-'));
  const store = new Store(state, process.cwd()); store.createRun('mc02'); t.after(() => store.close());
  const f = await start(t, undefined, undefined, item => store.saveRequest('mc02', item));
  store.register({ worker: f.worker, runId: 'mc02', taskId: 'A', assignmentId: 'assignment', repositoryId: 'repo', cwd: f.cwd, branch: 'fixture', model: 'mock', effort: 'low', ...f.runtime.registration(f.worker), binding: { windowBindingId: 'window', terminalId: 'terminal', worker: f.worker } });
  const otherCwd = mkdtempSync(path.join(tmpdir(), 'mc02-independent-'));
  const other = await f.runtime.start({ cwd: otherCwd, workerId: 'B', model: 'mock', effort: 'low' });
  t.after(() => f.runtime.stop(other, 'test_cleanup'));
  await f.runtime.send(other, 'fixture-parallel-completion');
  await f.runtime.send(f.worker, 'fixture-human-approval');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  const item = f.runtime.pendingRequests()[0]; assert.equal(item?.state, 'pending');
  let show!: () => void, choose!: (value: { action: 'cancel' }) => void;
  const displayed = new Promise<void>(resolve => show = resolve);
  const answer = new Promise<{ action: 'cancel' }>(resolve => choose = resolve);
  const server = createMcpServer(async () => ({ state: 'waiting_approval', humanForm: item }), async (ref, action) => {
    await f.runtime.answerRequest(f.worker, ref, action); return { state: 'response_sent' };
  });
  const client = new Client({ name: 'mc02-fixture-client', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => { show(); return answer; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    let returned = false;
    const pending = client.callTool({ name: 'answer_request', arguments: { runId: 'mc02', operationId: 'form', expectedRevision: 0, requestKey: item.key } }).then(value => { returned = true; return value; });
    await displayed;
    writeFileSync(path.join(otherCwd, 'complete-turn'), 'complete');
    for (let i = 0; i < 100 && !f.runtime.completedTurn(other); i++) await delay(20);
    assert(f.runtime.completedTurn(other)); assert.equal(returned, false);
    assert.equal(store.requests('mc02')[0].state, 'pending');
    assert.equal(existsSync(path.join(f.cwd, 'approval-response.json')), false);
    assert.equal((await f.runtime.releaseCompleted(other)).state, 'stopped');
    choose({ action: 'cancel' }); assert.equal((await pending).isError, undefined);
    for (let i = 0; i < 100 && !f.runtime.completedTurn(f.worker); i++) await delay(20);
    assert.deepEqual(JSON.parse(readFileSync(path.join(f.cwd, 'approval-response.json'), 'utf8')).result, { action: 'cancel', content: null, _meta: null });
    assert.equal(store.requests('mc02')[0].state, 'resolved');
    assert.equal((await f.runtime.releaseCompleted(f.worker)).state, 'stopped');
  } finally { choose?.({ action: 'cancel' }); await client.close(); await server.close(); }
});

test('compatibility_probe_checks_applied_settings_history_and_never_claims_UI_or_review_decisions', { timeout: 30000 }, () => {
  for (const scenario of ['supported', 'reviewer_mismatch', 'reviewer_rejected', 'profile_mismatch', 'read_rejected', 'resume_mismatch']) {
    const root = mkdtempSync(path.join(tmpdir(), 'mc02-probe-'));
    writeFileSync(path.join(root, 'compatibility-fixture.json'), JSON.stringify({ scenario }));
    const result = spawnSync(process.execPath, [path.resolve('dist/test/live/approval-roundtrip.js'), 'compatibility', '--fixture', '--root', root, '--real-exe', realExe, '--auth-home', root], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(path.join(root, 'compatibility.json'), 'utf8'));
    assert.equal(evidence.source, 'fixture'); assert.equal(evidence.turnsSent, 0);
    assert.equal(evidence.checks.uiAnswers.status, 'not_run');
    assert.equal(evidence.checks.autoReviewDecision.status, 'not_run');
    assert.equal(evidence.checks.reviewer.status, scenario === 'reviewer_rejected' ? 'rejected' : scenario === 'reviewer_mismatch' ? 'mismatch' : 'observed');
    assert.equal(evidence.checks.profile.status, scenario === 'reviewer_rejected' ? 'not_run' : scenario === 'profile_mismatch' ? 'mismatch' : 'observed');
    if (scenario === 'supported' || scenario === 'read_rejected' || scenario === 'resume_mismatch') {
      assert.equal(evidence.checks.historyRead.status, scenario === 'read_rejected' ? 'rejected' : 'observed');
      assert.equal(evidence.checks.historyResume.status, scenario === 'resume_mismatch' ? 'mismatch' : 'observed');
    }
    assert.equal(evidence.processExited, true);
    assert.equal(evidence.childStopConfirmed, true);
    assert.doesNotMatch(JSON.stringify(evidence), /private-history|private-review|private-account|private-error/);
  }
});

test('compatibility_probe_reserves_one_turn_and_preserves_rejection_without_retry', { timeout: 20000 }, () => {
  for (const scenario of ['supported', 'turn_rejected', 'account_missing', 'model_paged']) {
    const root = mkdtempSync(path.join(tmpdir(), 'mc02-turn-'));
    writeFileSync(path.join(root, 'compatibility-fixture.json'), JSON.stringify({ scenario }));
    const result = spawnSync(process.execPath, [path.resolve('dist/test/live/approval-roundtrip.js'), 'compatibility', '--fixture', '--root', root, '--real-exe', realExe, '--auth-home', root, '--max-turns', '1', '--model', 'mock', '--effort', 'low'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(path.join(root, 'compatibility.json'), 'utf8'));
    assert.equal(evidence.turnsSent, scenario === 'account_missing' ? 0 : 1);
    assert.equal(evidence.checks.modelTurn.status, scenario === 'account_missing' ? 'not_run' : scenario === 'turn_rejected' ? 'rejected' : 'observed');
    assert.equal(evidence.checks.autoReviewDecision.status, 'not_run');
    assert.equal(evidence.childStopConfirmed, true);
    const sent = path.join(root, 'work', 'probe-turn-count.txt');
    assert.equal(existsSync(sent) ? readFileSync(sent, 'utf8') : '', scenario === 'account_missing' ? '' : '1');
  }
});

test('guardian_probe_records_two_bounded_assessments_without_executing_commands', { timeout: 15000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mc02-guardian-'));
  writeFileSync(path.join(root, 'compatibility-fixture.json'), JSON.stringify({ scenario: 'supported' }));
  const result = spawnSync(process.execPath, [path.resolve('dist/test/live/approval-roundtrip.js'), 'guardian-probe', '--fixture', '--root', root, '--real-exe', realExe, '--auth-home', root], { encoding: 'utf8', windowsHide: true, timeout: 12000 });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(readFileSync(path.join(root, 'compatibility.json'), 'utf8'));
  assert.equal(evidence.reviewsSent, 2); assert.equal(evidence.turnsSent, 0);
  assert.equal(evidence.checks.reviewAllow.status, 'observed'); assert.equal(evidence.checks.reviewDeny.status, 'observed');
  assert.equal(evidence.reviewFilesUnchanged, true); assert.equal(evidence.childStopConfirmed, true);
  assert.equal(existsSync(path.join(root, 'work', 'read-canary.txt')), true, 'allow target must be outside the denied state directory');
  assert.equal(evidence.checks.reviewAllow.callId, 'mc02-allow-review');
  assert.equal(typeof evidence.checks.reviewAllow.threadId, 'string');
  assert.equal(existsSync(path.join(root, 'work', 'probe-turn-count.txt')), false);
  assert.doesNotMatch(JSON.stringify(evidence), /private-rationale/);
});
test('guardian_probe_distinguishes_injection_failure_and_does_not_continue_after_rejection', { timeout: 15000 }, () => {
  for (const scenario of ['inject_rejected', 'guardian_rejected']) {
    const root = mkdtempSync(path.join(tmpdir(), 'mc02-guardian-reject-'));
    writeFileSync(path.join(root, 'compatibility-fixture.json'), JSON.stringify({ scenario }));
    const result = spawnSync(process.execPath, [path.resolve('dist/test/live/approval-roundtrip.js'), 'guardian-probe', '--fixture', '--root', root, '--real-exe', realExe, '--auth-home', root], { encoding: 'utf8', windowsHide: true, timeout: 12000 });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(path.join(root, 'compatibility.json'), 'utf8'));
    assert.equal(evidence.reviewsSent, scenario === 'inject_rejected' ? 0 : 1);
    assert.equal(evidence.checks.reviewAllow.status, 'rejected');
    assert.equal(evidence.checks.reviewAllow.phase, scenario === 'inject_rejected' ? 'inject_items' : 'guardianReview');
    assert.equal(evidence.checks.reviewAllow.protocolCode, -32600);
    assert.equal(evidence.checks.reviewDeny.status, 'not_run');
    assert.equal(evidence.reviewFilesUnchanged, true); assert.equal(evidence.childStopConfirmed, true);
    assert.doesNotMatch(JSON.stringify(evidence), /private-error/);
  }
});
test('natural_followup_uses_next_turn_and_keeps_history', { timeout: 15000 }, async t => {
  let currentTurn: string | undefined;
  const f = await start(t);
  await f.runtime.send(f.worker, 'fixture-human-approval');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  const approval = f.runtime.pendingRequests()[0]; currentTurn = approval.turnId!;
  await f.runtime.answerRequest(f.worker, approval, 'accept');
  for (let i = 0; i < 100 && f.runtime.pendingRequests().length; i++) await delay(20);
  // Reported questions are accepted only during their actual active turn.
  assert.throws(() => f.runtime.waitForInput(f.worker, 'late question', currentTurn!));
  await f.runtime.send(f.worker, 'fixture-natural-question');
  const marker = path.join(f.cwd, 'active-turn.txt');
  for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(20);
  f.runtime.waitForInput(f.worker, 'Which format?', readFileSync(marker, 'utf8'));
  const item = f.runtime.pendingRequests()[0];
  await assert.rejects(f.runtime.answerQuestion(f.worker, item.key, { reply: { answers: ['JSON'] } }), e => e instanceof RequestFailure && e.delivery === 'not_sent');
  writeFileSync(path.join(f.cwd, 'complete-turn'), 'complete');
  await delay(300);
  const send = f.runtime.send.bind(f.runtime);
  f.runtime.send = async () => { throw new RequestFailure('failed', 'not_sent'); };
  await assert.rejects(f.runtime.answerQuestion(f.worker, item.key, { reply: { answers: ['JSON'] } }), e => e instanceof RequestFailure && e.delivery === 'not_sent');
  assert.equal(f.runtime.pendingRequests()[0].state, 'pending');
  f.runtime.send = send;
  await f.runtime.answerQuestion(f.worker, item.key, { reply: { answers: ['fixture-complete-before-ack'] } });
  assert.equal(f.runtime.pendingRequests().length, 0);
  assert.equal((await f.runtime.releaseCompleted(f.worker)).state, 'stopped');
});
test('stopping_worker_invalidates_open_human_form_without_manufacturing_response', { timeout: 15000 }, async t => {
  const f = await start(t); await f.runtime.send(f.worker, 'fixture-human-approval');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  const item = f.runtime.pendingRequests()[0]; assert(item);
  const stopping = f.runtime.stop(f.worker, 'test');
  await assert.rejects(f.runtime.answerRequest(f.worker, item, 'accept'));
  assert.equal((await stopping).state, 'stopped'); assert.equal(existsSync(path.join(f.cwd, 'approval-response.json')), false);
});
test('completion_before_request_resolution_defers_cleanup_until_both_are_confirmed', { timeout: 15000 }, async t => {
  const pendingCounts: number[] = [];
  const f = await start(t, (_worker, kind) => { if (kind === 'completed') pendingCounts.push(f.runtime.pendingRequests().length); });
  await f.runtime.send(f.worker, 'fixture-human-approval-complete-first');
  for (let i = 0; i < 100 && !f.runtime.pendingRequests().length; i++) await delay(20);
  await f.runtime.answerRequest(f.worker, f.runtime.pendingRequests()[0], 'accept');
  for (let i = 0; i < 100 && !pendingCounts.length; i++) await delay(20);
  assert.deepEqual(pendingCounts, [0]);
  assert.equal((await f.runtime.releaseCompleted(f.worker)).state, 'stopped');
});
