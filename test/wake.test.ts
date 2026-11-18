import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { WakeCoordinator } from '../src/wake.js';
import { DecisionService } from '../src/decisions.js';
import type { PlanSnapshot } from '../src/plan.js';
import type { RepositoryPin } from '../src/git-evidence.js';

test('consultation_changes_coalesce_while_human_input_and_progress_never_steers', async t => {
  const f = fixture(t);
  f.store.savePlan('run', { planHash: 'a'.repeat(64), plan: { tasks: [{ id: 'A' }] } } as PlanSnapshot, {} as RepositoryPin);
  const service = new DecisionService(f.store, () => {}, () => undefined);
  const proposal = { taskIds: ['A'], blockingTaskIds: [], kind: 'consultation' as const, recipient: 'coordinator' as const, planHash: 'a'.repeat(64), question: '相談', options: [], allowFreeText: true };
  service.propose({ runId: 'run', operationId: 'first', expectedRevision: f.store.run('run').revision }, proposal);
  service.propose({ runId: 'run', operationId: 'second', expectedRevision: f.store.run('run').revision }, proposal);
  f.store.appendEvent({ runId: 'run', kind: 'running' });
  assert.equal((await f.wake.monitor('run')).state, 'deferred'); assert.equal(f.sends(), 0);
  f.idle(); assert.equal((await f.wake.monitor('run')).state, 'acked'); assert.equal(f.sends(), 1);
  f.idle(); await f.wake.monitor('run'); assert.equal(f.sends(), 1);
  assert.doesNotMatch(JSON.stringify(f.wire), /相談/);
});

const parent = { ownerId: 'parent', ownerEpoch: 'epoch', threadId: 'P' };
function fixture(t: { after(fn: () => void): void }, limit?: number | null) {
  const store = new Store(mkdtempSync(path.join(tmpdir(), 'cc03-')), process.cwd());
  store.createRun('run'); t.after(() => store.close());
  let active = true, stateSeq = 1, sends = 0, unknown = false, race = false;
  const wire: any[] = [];
  const wake = new WakeCoordinator(store, parent, { model: 'mock', effort: 'low' }, async (method, params) => {
    if (method === 'relay/wake-state') return { ...parent, stateSeq, idle: !active, supported: true };
    if (method === 'relay/wake') {
      if (race) { stateSeq++; active = true; }
      if (active || params.stateSeq !== stateSeq) return { state: 'deferred' };
      sends++; wire.push(params); if (unknown) throw Error('lost ACK');
      active = true; stateSeq++; return { state: 'acked', turnId: 'wake-' + sends };
    }
    throw Error('unexpected method');
  }, undefined, limit);
  const event = () => store.appendEvent({ runId: 'run', kind: 'waiting_input' });
  return { store, wake, event, wire, sends: () => sends, idle: () => { active = false; stateSeq++; }, unknown: () => { unknown = true; }, race: () => { race = true; } };
}
test('report_at_parent_finish_is_not_lost', async t => {
  const f = fixture(t); f.wake.enqueueWake('run', f.event());
  assert.equal((await f.wake.deliverWakeIfIdle('run')).state, 'deferred');
  f.idle(); assert.equal((await f.wake.deliverWakeIfIdle('run')).state, 'acked'); assert.equal(f.sends(), 1);
});
test('parent_read_during_idle_probe_cancels_stale_wake', async t => {
  const f = fixture(t), seq = f.event();
  const wake = new WakeCoordinator(f.store, parent, { model: 'mock', effort: 'low' }, async method => {
    assert.equal(method, 'relay/wake-state'); f.store.wakeProgress('run', 'read_seq', seq);
    return { ...parent, idle: true, supported: true, stateSeq: 1 };
  });
  wake.enqueueWake('run', seq); assert.equal((await wake.deliverWakeIfIdle('run')).state, 'empty');
});
test('duplicate_reports_coalesce', async t => {
  const f = fixture(t), seq = f.event(); f.wake.enqueueWake('run', seq); f.wake.enqueueWake('run', seq); f.wake.enqueueWake('run', f.event());
  f.idle(); await Promise.all([f.wake.deliverWakeIfIdle('run'), f.wake.deliverWakeIfIdle('run')]);
  f.idle(); await f.wake.deliverWakeIfIdle('run'); assert.equal(f.sends(), 1);
  assert.equal(f.wire[0].sourceEventSeq, 2); assert(!JSON.stringify(f.wire).includes('summary'));
});
test('human_input_blocks_stale_idle_wake', async t => {
  const f = fixture(t); f.wake.enqueueWake('run', f.event()); f.idle(); f.race();
  assert.equal((await f.wake.deliverWakeIfIdle('run')).state, 'deferred'); assert.equal(f.sends(), 0);
});
test('active_turn_is_not_steered', async t => {
  const f = fixture(t); f.wake.enqueueWake('run', f.event()); await f.wake.deliverWakeIfIdle('run'); assert.equal(f.sends(), 0);
});
test('wake_unknown_is_not_retried', async t => {
  const f = fixture(t); f.idle(); f.unknown(); f.wake.enqueueWake('run', f.event());
  assert.equal((await f.wake.deliverWakeIfIdle('run')).state, 'sent_unknown');
  f.idle(); await f.wake.deliverWakeIfIdle('run'); assert.equal(f.sends(), 1); assert.equal(f.store.run('run').state, 'stopped');
  assert.throws(() => f.store.resumeRun('run'), /reconciliation/);
});
test('stopped_run_never_wakes', async t => {
  const f = fixture(t); f.wake.enqueueWake('run', f.event()); f.store.stopRun('run'); f.idle();
  await f.wake.deliverWakeIfIdle('run'); assert.equal(f.sends(), 0);
});
test('explicit_resume_does_not_replay_events_received_while_stopped', async t => {
  const f = fixture(t); f.store.stopRun('run'); f.event(); f.store.resumeRun('run'); f.idle();
  await f.wake.monitor('run'); assert.equal(f.sends(), 0);
});
test('idle_monitor_has_zero_model_requests', async t => {
  const f = fixture(t); f.idle();
  for (let i = 0; i < 30; i++) { f.store.appendEvent({ runId: 'run', kind: 'running' }); await f.wake.monitor('run'); }
  assert.equal(f.sends(), 0);
});
test('report_alone_does_not_wake_and_read_events_are_not_delivered_again', async t => {
  const f = fixture(t); f.idle();
  f.store.appendEvent({ runId: 'run', kind: 'report_saved' }); await f.wake.monitor('run'); assert.equal(f.sends(), 0);
  const seq = f.event(); f.store.wakeProgress('run', 'read_seq', seq); await f.wake.monitor('run'); assert.equal(f.sends(), 0);
});
test('saved_report_waits_for_normal_cleanup_before_waking_parent', async t => {
  const f = fixture(t), worker = { workerId: 'A', attemptId: 'A', threadId: 'A', ownerId: 'A', ownerEpoch: 'epoch' };
  f.store.register({ worker, binding: { worker, windowBindingId: 'window', terminalId: 'terminal' }, runId: 'run', taskId: 'A', assignmentId: 'assignment', repositoryId: 'repo', cwd: mkdtempSync(path.join(tmpdir(), 'cc03-work-')), branch: 'fixture', model: 'mock', effort: 'low', hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job' });
  const ref = { operationId: 'report', runId: 'run', expectedRevision: 0 };
  f.store.prepareOperation(ref, 'a'.repeat(64)); f.store.saveReport(ref, worker, 'turn', { summary: 'result data' });
  f.store.appendEvent({ runId: 'run', attemptId: 'A', kind: 'report_saved' });
  f.idle(); await f.wake.monitor('run'); assert.equal(f.sends(), 0);
  f.store.appendEvent({ runId: 'run', attemptId: 'A', kind: 'turn_completed' });
  await f.wake.monitor('run'); assert.equal(f.sends(), 0);
  f.store.saveStop('run', { worker, state: 'stopped', evidenceRefs: ['job_empty'] }, true);
  await f.wake.monitor('run'); assert.equal(f.sends(), 1);
});
test('wake_limit_stops_with_reason_and_read_cursor_is_separate', async t => {
  const f = fixture(t, 12);
  for (let i = 0; i < 13; i++) { f.idle(); f.wake.enqueueWake('run', f.event()); await f.wake.deliverWakeIfIdle('run'); }
  assert.equal(f.sends(), 12); assert.equal(f.store.run('run').state, 'stopped');
  assert.equal(f.store.wakeCursor('run').read_seq, 0);
  assert.equal(f.store.events('run', 0, 100).at(-1)?.kind, 'wake_limit');
});

test('unlimited_default_exceeds_twelve_wakes_and_two_corrections', async t => {
  for (const limit of [undefined, null, 15]) {
    const f = fixture(t, limit);
    for (let i = 0; i < 14; i++) {
      f.idle(); f.wake.enqueueWake('run', f.event());
      assert.equal((await f.wake.deliverWakeIfIdle('run')).state, 'acked');
    }
    assert.equal(f.sends(), 14); assert.equal(f.store.run('run').state, 'active');
  }
});

test('explicit_budget_is_reserved_before_delivery', async t => {
  const f = fixture(t, 3);
  for (let i = 0; i < 2; i++) { f.idle(); f.wake.enqueueWake('run', f.event()); await f.wake.deliverWakeIfIdle('run'); }
  f.idle(); f.unknown(); f.wake.enqueueWake('run', f.event());
  assert.equal((await f.wake.deliverWakeIfIdle('run')).state, 'sent_unknown');
  assert.equal(f.store.wakeCount('run'), 3);
  assert.equal((await f.wake.deliverWakeIfIdle('run')).state, 'stopped'); assert.equal(f.sends(), 3);
  const limited = fixture(t, 3);
  for (let i = 0; i < 4; i++) { limited.idle(); limited.wake.enqueueWake('run', limited.event()); await limited.wake.deliverWakeIfIdle('run'); }
  assert.equal(limited.sends(), 3); assert.equal(limited.store.run('run').state, 'stopped');
  const reserved = fixture(t);
  const wake = new WakeCoordinator(reserved.store, parent, { model: 'mock', effort: 'low' }, async method => {
    if (method === 'relay/wake-state') return { ...parent, idle: true, supported: true, stateSeq: 1 };
    assert.equal(reserved.store.wakeCount('run'), 1); return { state: 'acked', turnId: 'reserved' };
  });
  wake.enqueueWake('run', reserved.event()); assert.equal((await wake.deliverWakeIfIdle('run')).state, 'acked');
  for (const limit of [0, -1, 1.5, NaN]) assert.throws(() => fixture(t, limit), /budget/);
});

test('wake_limit_is_read_after_run_plan_registration', async t => {
  const f = fixture(t); let limit: number | null = null, sends = 0;
  const wake = new WakeCoordinator(f.store, parent, { model: 'mock', effort: 'low' }, async method => method === 'relay/wake-state'
    ? { ...parent, idle: true, supported: true, stateSeq: 1 }
    : (sends++, { state: 'acked', turnId: 'wake-' + sends }), undefined, () => limit);
  limit = 1;
  wake.enqueueWake('run', f.event()); assert.equal((await wake.deliverWakeIfIdle('run')).state, 'acked');
  wake.enqueueWake('run', f.event()); assert.equal((await wake.deliverWakeIfIdle('run')).state, 'stopped'); assert.equal(sends, 1);
});
