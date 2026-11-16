import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { WakeCoordinator } from '../src/wake.js';

const parent = { ownerId: 'parent', ownerEpoch: 'epoch', threadId: 'P' };
function fixture(t: { after(fn: () => void): void }) {
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
  });
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
  const f = fixture(t);
  for (let i = 0; i < 13; i++) { f.idle(); f.wake.enqueueWake('run', f.event()); await f.wake.deliverWakeIfIdle('run'); }
  assert.equal(f.sends(), 12); assert.equal(f.store.run('run').state, 'stopped');
  assert.equal(f.store.wakeCursor('run').read_seq, 0);
  assert.equal(f.store.events('run', 0, 100).at(-1)?.kind, 'wake_limit');
});
