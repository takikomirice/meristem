import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerRuntime } from '../src/workers.js';
import { pipeRequest } from '../src/protocol.js';
import { RequestFailure } from '../src/failures.js';
import { spawnSync } from 'node:child_process';

const hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe');
const realExe = path.resolve('.local/chat-control-build/MockCodex.exe');
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
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
  assert.equal(resumed.threadId, first.threadId);
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
  await assert.rejects(runtime.send(worker, 'fixture-start-marker'), e => e instanceof RequestFailure && e.delivery === 'not_sent');
  assert.equal(existsSync(path.join(cwd, 'worker.marker')), false);
  writeFileSync(path.join(cwd, 'model-catalog.json'), JSON.stringify({ first: { data: [], nextCursor: 'first' } }));
  await assert.rejects(runtime.send(worker, 'fixture-start-marker'), e => e instanceof RequestFailure && e.delivery === 'not_sent');
  catalog('mock.2', 'medium');
  await runtime.send(worker, 'fixture-complete-before-ack', { model: 'mock.2', effort: 'medium' });
  assert.equal((await runtime.releaseCompleted(worker)).state, 'stopped');
});
test('completed_worker_history_can_resume_in_new_owned_attempt', { timeout: 20000 }, async t => {
  const f = await start(t);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: f.cwd, windowsHide: true }).status, 0);
  await f.runtime.send(f.worker, 'fixture-complete-before-ack');
  await f.runtime.releaseCompleted(f.worker);
  const next = await f.runtime.start({ cwd: f.cwd, workerId: 'A', model: 'mock', effort: 'low', previous: f.worker });
  t.after(() => f.runtime.stop(next, 'test_cleanup'));
  assert.equal(next.threadId, f.worker.threadId); assert.notEqual(next.attemptId, f.worker.attemptId); assert.notEqual(next.ownerEpoch, f.worker.ownerEpoch);
  await assert.rejects(f.runtime.send(f.worker, 'late'), /not_sent|failed|stopping|transport/);
  await f.runtime.send(next, 'fixture-complete-before-ack');
  await f.runtime.releaseCompleted(next);
  writeFileSync(path.join(f.cwd, 'dirty.txt'), 'preserve');
  await assert.rejects(f.runtime.start({ cwd: f.cwd, workerId: 'A', model: 'mock', effort: 'low', previous: next }), /clean/);
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
