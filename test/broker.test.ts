import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Broker } from '../src/broker.js';
import { RequestFailure } from '../src/failures.js';
import type { Registration, WorkerRef, StopResult } from '../src/contracts.js';

function fixture(t: { after(fn: () => void): void }) {
  const store = new Store(mkdtempSync(path.join(tmpdir(), 'cc01-broker-')), process.cwd());
  t.after(() => store.close()); store.createRun('run');
  const registrations: Registration[] = ['A', 'B'].map(id => ({
    worker: { workerId: id, attemptId: id, threadId: id, ownerId: id, ownerEpoch: 'epoch' },
    runId: 'run', taskId: id, assignmentId: id, repositoryId: 'repo',
    cwd: mkdtempSync(path.join(tmpdir(), 'cc01-work-')), branch: 'fixture', model: 'mock', effort: 'low',
    hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: id,
    binding: { windowBindingId: 'window', terminalId: id, worker: { workerId: id, attemptId: id, threadId: id, ownerId: id, ownerEpoch: 'epoch' } }
  }));
  registrations.forEach(reg => store.register(reg));
  const stopped: string[] = []; let sends = 0, unknown = false, rejection: RequestFailure | undefined;
  const runtime = {
    async send(_worker: WorkerRef, _text: string) { sends++; throw rejection ?? new Error('ack lost'); },
    async stop(worker: WorkerRef): Promise<StopResult> { assert.notEqual(store.run('run').state, 'active'); stopped.push(worker.workerId); return { worker, state: unknown ? 'unknown' : 'stopped', evidenceRefs: ['fixture_observation'] }; },
    async releaseCompleted(worker: WorkerRef): Promise<StopResult> { return { worker, state: 'stopped', evidenceRefs: ['fixture_observation'] }; }
  };
  const broker = new Broker(store, runtime);
  return { store, broker, registrations, stopped, sends: () => sends, unknown: () => { unknown = true; }, reject: (error: RequestFailure) => { rejection = error; } };
}
test('ack_loss_is_unknown_without_resend', async t => {
  const f = fixture(t), worker = f.registrations[0].worker;
  const command = { kind: 'send' as const, ref: { runId: 'run', operationId: 'send', expectedRevision: 0 }, worker, text: 'instruction' };
  assert.equal((await f.broker.dispatch(command)).state, 'sent_unknown');
  assert.equal((await f.broker.dispatch(command)).state, 'sent_unknown');
  assert.equal(f.sends(), 1);
});
test('manual_tab_close_keeps_existing_stop_semantics', async t => {
  const f = fixture(t); await f.broker.closeTerminal('run', f.registrations[0].binding);
  assert.deepEqual(f.stopped, ['A']); assert.equal(f.broker.canWake('run'), false);
  await assert.rejects(f.broker.dispatch({ kind: 'send', ref: { runId: 'run', operationId: 'send', expectedRevision: f.store.run('run').revision }, worker: f.registrations[1].worker, text: 'new' }), /stopped/);
  f.broker.report('run', f.registrations[1].worker);
  assert.equal(f.store.events('run', 0, 100).at(-1)?.kind, 'report_saved');
});

test('retirement_and_stop_run_share_one_identity_bound_stop_and_keep_slots_until_confirmed', async t => {
  const f = fixture(t), worker = f.registrations[0].worker;
  let confirm!: (result: StopResult) => void, entered!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), stopped: string[] = [];
  const broker = new Broker(f.store, {
    async send() { assert.fail('retiring worker received instruction'); },
    async releaseCompleted(target) { return { worker: target, state: 'stopped', evidenceRefs: [] }; },
    async stop(target) { stopped.push(target.workerId); if (target.workerId === 'A') { entered(); return new Promise<StopResult>(resolve => confirm = resolve); } return { worker: target, state: 'stopped', evidenceRefs: [] }; }
  });
  const retiring = broker.retireWorker('run', worker);
  await started;
  assert.equal(f.store.attempts('run')[0].state, 'stopping');
  await assert.rejects(broker.dispatch({ kind: 'send', ref: { runId: 'run', operationId: 'during-retire', expectedRevision: f.store.run('run').revision }, worker, text: 'no' }));
  const all = broker.stopRun('run'), duplicate = broker.retireWorker('run', worker);
  confirm({ worker, state: 'stopped', evidenceRefs: ['confirmed'] });
  await Promise.all([retiring, all, duplicate]); assert.deepEqual(stopped.sort(), ['A', 'B']);
  assert.equal(f.store.run('run').state, 'stopped');
});

test('retirement_unknown_stops_run_and_stale_identity_cannot_stop_peer', async t => {
  const f = fixture(t), worker = f.registrations[0].worker, stopped: string[] = [];
  const broker = new Broker(f.store, {
    async send() {}, async releaseCompleted(target) { return { worker: target, state: 'stopped', evidenceRefs: [] }; },
    async stop(target) { stopped.push(target.workerId); return { worker: target, state: target.workerId === 'A' ? 'unknown' : 'stopped', evidenceRefs: [] }; }
  });
  await assert.rejects(broker.retireWorker('run', { ...worker, ownerEpoch: 'old' }), /binding/);
  assert.equal((await broker.retireWorker('run', worker)).state, 'unknown');
  assert.equal(broker.canWake('run'), false); assert(stopped.includes('B'));
  assert.throws(() => f.store.resumeRun('run'), /reconcil|cleanup/);
});

test('late_normal_completion_does_not_turn_retired_work_into_completed_task', async t => {
  const f = fixture(t), worker = f.registrations[0].worker;
  let finish!: (result: StopResult) => void, entered!: () => void;
  const started = new Promise<void>(resolve => entered = resolve);
  const broker = new Broker(f.store, {
    async send() {},
    async releaseCompleted() { entered(); return new Promise<StopResult>(resolve => finish = resolve); },
    async stop(target) { return { worker: target, state: 'stopped', evidenceRefs: ['confirmed'] }; }
  });
  const completion = broker.releaseCompleted('run', worker); await started;
  await broker.retireWorker('run', worker);
  finish({ worker, state: 'stopped', evidenceRefs: ['normal_cleanup'] }); await completion;
  assert.equal(f.store.attempts('run')[0].state, 'stopped');
  assert.equal(f.store.run('run').state, 'active');
  assert.equal(f.store.attempts('run')[1].state, 'running');
  await broker.retireWorker('run', worker);
  assert.equal(f.store.attempts('run')[0].state, 'stopped');
});
test('parent_ui_stop_and_stop_run_stop_all_owned_workers', async t => {
  const f = fixture(t); await f.broker.stopRun('run'); assert.deepEqual(f.stopped.sort(), ['A', 'B']);
  assert.equal(f.store.run('run').state, 'stopped');
});
test('stopped_run_ignores_late_reports', async t => {
  const f = fixture(t); await f.broker.stopRun('run'); f.broker.report('run', f.registrations[0].worker);
  assert.equal(f.store.events('run', 0, 100).at(-1)?.kind, 'late_report'); assert.equal(f.broker.canWake('run'), false);
});
test('late_stop_does_not_kill_new_attempt', async t => {
  const f = fixture(t), binding = structuredClone(f.registrations[0].binding); binding.worker.ownerEpoch = 'old';
  await assert.rejects(f.broker.closeTerminal('run', binding), /binding/); assert.deepEqual(f.stopped, []);
});
test('completed_release_does_not_stop_run', async t => {
  const f = fixture(t); await f.broker.releaseCompleted('run', f.registrations[0].worker);
  assert.equal(f.store.run('run').state, 'active');
  await f.broker.closeTerminal('run', f.registrations[0].binding); assert.equal(f.store.run('run').state, 'active');
});
test('unknown_cleanup_blocks_worktree_reuse', async t => {
  const f = fixture(t); f.unknown(); await f.broker.stopRun('run'); f.store.createRun('next');
  const reg = structuredClone(f.registrations[0]); reg.runId = 'next';
  assert.throws(() => f.store.register(reg), /unresolved cleanup/);
});
test('lease_loss_stops_run_and_all_workers', async t => {
  const f = fixture(t); await f.broker.leaseLost('run');
  assert.equal(f.store.run('run').state, 'needs_reconcile'); assert.deepEqual(f.stopped.sort(), ['A', 'B']);
});
test('parent_fence_failure_still_stops_children', async t => {
  const f = fixture(t), stopped: string[] = [];
  const broker = new Broker(f.store, {
    async send() {}, async releaseCompleted(worker) { return { worker, state: 'stopped', evidenceRefs: [] }; },
    async stop(worker) { stopped.push(worker.workerId); return { worker, state: 'stopped', evidenceRefs: [] }; }
  }, async () => { throw Error('parent pipe unavailable'); });
  await broker.stopRun('run'); assert.deepEqual(stopped, ['A', 'B']); assert.equal(f.store.run('run').state, 'needs_reconcile');
});
test('known_auth_limit_and_local_rejections_are_not_ack_loss', async t => {
  for (const kind of ['authentication_required', 'limit_reached', 'failed'] as const) {
    const f = fixture(t); f.reject(new RequestFailure(kind, 'rejected'));
    const result = await f.broker.dispatch({ kind: 'send', ref: { runId: 'run', operationId: 'send', expectedRevision: 0 }, worker: f.registrations[0].worker, text: 'instruction' });
    assert.equal(result.state, 'settled'); assert.equal(f.store.events('run', 0, 100).at(-1)?.kind, kind);
  }
});
test('reserved_start_blocks_worktree_reuse_even_before_native_registration', t => {
  const f = fixture(t), pending = structuredClone(f.registrations[0]);
  pending.worker = { ...pending.worker, workerId: 'C', attemptId: 'C', threadId: 'pending' }; pending.binding.worker = pending.worker;
  pending.assignmentId = 'C'; pending.taskId = 'C'; pending.cwd = mkdtempSync(path.join(tmpdir(), 'cc01-pending-')); pending.hostPid = 0; pending.childPid = 0;
  assert.throws(() => f.store.reserve(pending), /capacity/);
  f.store.saveStop('run', { worker: f.registrations[1].worker, state: 'stopped', evidenceRefs: ['confirmed'] });
  f.store.reserve(pending); f.store.createRun('next');
  const registrationEvents = () => f.store.events('run', 0, 100).filter(event => event.attempt_id === 'C' && event.kind === 'registered');
  assert.equal(registrationEvents().length, 0);
  const next = structuredClone(pending); next.runId = 'next'; next.worker.attemptId = 'D'; next.assignmentId = 'D';
  assert.throws(() => f.store.register(next), /unresolved cleanup/);
  const started = { ...pending.worker, threadId: 'thread-C' };
  f.store.register({ ...pending, worker: started, binding: { ...pending.binding, worker: started }, hostPid: 3, childPid: 4 });
  assert.equal(registrationEvents().length, 1);
});
