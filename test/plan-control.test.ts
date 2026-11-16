import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { planControllerFixture } from './fixtures/plan-controller.js';
import { git, checks } from './fixtures/serial-git.js';
import { Store } from '../src/store.js';

test('worker_receives_exact_linked_gitdir_as_formal_approval_target', async t => {
  const f = await planControllerFixture(t), worker = await f.create('A');
  const assignment = f.store.gitAssignment(worker.attemptId)!;
  assert(f.starts[0].gitApprovalRoots.includes(git(assignment.cwd, 'rev-parse', '--absolute-git-dir').replaceAll('/', path.sep)));
});

test('plan_edit_freezes_new_dispatch_and_keeps_snapshot_until_parent_reconciles', async t => {
  const f = await planControllerFixture(t); const original = readFileSync(f.planPath, 'utf8');
  f.plan.tasks[1].completion = ['another']; f.savePlan();
  await assert.rejects(f.create('A')); const changed = await f.status(); assert.equal(changed.plan.frozen, true);
  assert.deepEqual(f.store.plan('run')!.snapshot.plan.tasks[1].completion, ['test']);
  await f.call('reconcile_plan', { expectedFileHash: changed.plan.fileHash, expectedPlanHash: changed.plan.observedPlanHash });
  assert.deepEqual(f.store.plan('run')!.snapshot.plan.tasks[1].completion, ['another']);
  writeFileSync(f.planPath, original); await assert.rejects(f.create('A'));
});
test('report_cleanup_candidate_and_integration_are_separate_gates', async t => {
  const f = await planControllerFixture(t), a = await f.create('A'), result = await f.complete('A', a, 'one', false);
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] }));
  f.store.completedTurn(a, 'other-turn'); await f.broker.releaseCompleted('run', a);
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] }));
  f.store.completedTurn(a, 'turn');
  assert.equal((await f.status()).plan.tasks.A.state, 'candidate_ready');
  await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  await assert.rejects(f.create('B'));
  const pin = f.store.plan('run')!.pin; git(pin.integrationCwd, 'merge', '--ff-only', result.sha);
  await f.call('record_decision', { taskId: 'A', decision: 'accept_integration', integrationSha: result.sha, checks, evidenceRefs: [] });
  const b = await f.create('B'); assert.equal(f.store.gitAssignment(b.attemptId)!.baseSha, result.sha); assert.notEqual(a.threadId, b.threadId);
});
test('history_reuse_requires_cleanup_current_cwd_and_git_head_at_controller_boundary', async t => {
  const f = await planControllerFixture(t), a = await f.create('A'); const result = await f.complete('A', a);
  await f.call('record_decision', { taskId: 'A', decision: 'retry_same', evidenceRefs: [] });
  writeFileSync(path.join(result.assignment.cwd, 'dirty.txt'), 'preserve'); await assert.rejects(f.create('A')); assert.equal(f.starts.length, 1);
  assert.equal(readFileSync(path.join(result.assignment.cwd, 'dirty.txt'), 'utf8'), 'preserve');
});
test('candidate_is_rechecked_after_report_and_before_integration', async t => {
  const f = await planControllerFixture(t), a = await f.create('A'), result = await f.complete('A', a);
  await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  writeFileSync(path.join(result.assignment.cwd, 'a.txt'), 'later');
  git(f.store.plan('run')!.pin.integrationCwd, 'merge', '--ff-only', result.sha);
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_integration', integrationSha: result.sha, checks, evidenceRefs: [] }));
  await assert.rejects(f.create('B'));
});
test('structured_report_identity_and_unresolved_requests_cannot_be_accepted', async t => {
  const f = await planControllerFixture(t), a = await f.create('A'), result = await f.complete('A', a, 'one', false);
  await assert.rejects(f.call('report', { taskId: 'A', report: { ...result.report, worker_id: 'other' } }, { actor: a, turnId: 'turn' }));
  f.store.completedTurn(a, 'turn'); await f.broker.releaseCompleted('run', a);
  f.store.saveRequest('run', { key: 'pending', worker: a, cwd: result.assignment.cwd, turnId: 'turn', requestId: 1, kind: 'question', payloadHash: 'a'.repeat(64), formGeneration: 'form', state: 'replied', detail: '', expiresAt: null });
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] }));
});

test('plan_snapshot_and_git_assignments_survive_restart_without_dispatch', async () => {
  const cleanup: (() => void)[] = [], f = await planControllerFixture({ after(fn) { cleanup.push(fn); } });
  const a = await f.create('A'), before = f.store.gitAssignment(a.attemptId); cleanup[0]();
  const restored = new Store(path.join(f.root, 'state'), f.repository);
  try {
    assert.equal(restored.run('run').state, 'needs_reconcile'); assert.equal(restored.attempts('run')[0].state, 'unknown');
    assert.deepEqual(restored.gitAssignment(a.attemptId), before); assert.equal(restored.plan('run')!.snapshot.plan.tasks[0].id, 'A');
    assert.equal(git(before!.cwd, 'branch', '--show-current'), before!.branch);
  } finally { restored.close(); }
});

test('plan_worker_cannot_decide_and_duplicate_parent_decision_is_not_replayed', async t => {
  const f = await planControllerFixture(t), a = await f.create('A'), result = await f.complete('A', a, 'one', false);
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] }, { actor: a, turnId: 'turn' }));
  f.store.completedTurn(a, 'turn'); await f.broker.releaseCompleted('run', a);
  const args = { ...f.ref(), taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] };
  const first = await f.controller.call('record_decision', args, f.parent);
  assert.deepEqual(await f.controller.call('record_decision', args, f.parent), first);
  assert.equal(f.store.planStates('run').A.state, 'candidate_accepted');
});

test('decision_audit_failure_cannot_release_dependencies', async t => {
  const f = await planControllerFixture(t), a = await f.create('A'), result = await f.complete('A', a);
  await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  git(f.store.plan('run')!.pin.integrationCwd, 'merge', '--ff-only', result.sha);
  f.store.saveDecision = () => { throw new Error('audit unavailable'); };
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_integration', integrationSha: result.sha, checks, evidenceRefs: [] }));
  assert.equal(f.store.planStates('run').A.state, 'candidate_accepted'); await assert.rejects(f.create('B'));
});

test('plan_delivery_rejects_agent_drift_and_completed_attempt', async t => {
  const f = await planControllerFixture(t), a = await f.create('A');
  await assert.rejects(f.call('send_instruction', { taskId: 'A', target: a, text: 'work', agent: { model: 'other', effort: 'low' } }));
  await f.complete('A', a);
  await assert.rejects(f.call('send_instruction', { taskId: 'A', target: a, text: 'stale', agent: { model: 'mock', effort: 'low' } }));
});

test('stop_fence_wins_over_candidate_verification', async t => {
  const f = await planControllerFixture(t), a = await f.create('A'), result = await f.complete('A', a);
  const acceptance = f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  const stopped = f.broker.stopRun('run');
  await assert.rejects(acceptance); await stopped;
  assert.notEqual(f.store.planStates('run').A.state, 'candidate_accepted');
});

test('plan_status_does_not_overflow_native_response_with_historical_checks', async t => {
  const f = await planControllerFixture(t), plan = f.store.plan('run')!;
  // Seed valid historical evidence as a long serial run would leave in SQLite.
  const largeChecks = Array.from({ length: 5 }, (_, i) => ({ name: `check${i}`, command: 'x'.repeat(2048), result: 'passed' as const, exit_code: 0, evidence_refs: Array(16).fill('x'.repeat(512)) }));
  for (let i = 0; i < 6; i++) f.store.savePlanState('run', `history${i}`, { state: 'integrated', integrationSha: plan.pin.initialSha, candidate: { candidateSha: plan.pin.initialSha, baseSha: plan.pin.initialSha, branch: 'fixture', checks: largeChecks, remote: 'origin' }, checks: largeChecks });
  assert(Buffer.byteLength(JSON.stringify(await f.status())) < 200000);
});
