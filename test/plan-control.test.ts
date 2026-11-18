import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { planControllerFixture } from './fixtures/plan-controller.js';
import { git, checks } from './fixtures/serial-git.js';
import { Store } from '../src/store.js';
import { readPlan } from '../src/plan.js';

test('task_permission_profile_is_checked_before_git_allocation', async t => {
  const f = await planControllerFixture(t, f => {
    Object.assign(f.plan, { schema_version: 2 });
    for (const task of f.plan.tasks) Object.assign(task.agent, { permissionProfileId: 'full-access' });
  });
  const before = git(f.repository, 'worktree', 'list');
  await assert.rejects(f.create('A'), /permission profile/);
  assert.equal(f.starts.length, 0); assert.equal(f.store.attempts('run').length, 0);
  assert.equal(git(f.repository, 'worktree', 'list'), before);
});

test('legacy_plan_uses_scoped_workspace_permissions_and_records_task_agent', async t => {
  const f = await planControllerFixture(t), worker = await f.create('A');
  assert.equal(f.starts[0].permissionProfileId, 'workspace');
  assert.deepEqual(f.starts[0].permissionPermit, { allowedProfileIds: ['workspace'], writableRoots: [f.trees], allowedReviewers: ['user'] });
  assert.equal(worker.workerId, 'A');
});

test('worker_receives_exact_linked_gitdir_as_formal_approval_target', async t => {
  const f = await planControllerFixture(t), worker = await f.create('A');
  const assignment = f.store.gitAssignment(worker.attemptId)!;
  assert(f.starts[0].gitApprovalRoots.includes(git(assignment.cwd, 'rev-parse', '--absolute-git-dir').replaceAll('/', path.sep)));
});

test('plan_edit_freezes_dispatch_until_the_approved_document_is_restored', async t => {
  const f = await planControllerFixture(t); const original = readFileSync(f.planPath, 'utf8');
  f.plan.tasks[1].completion = ['another']; f.savePlan();
  await assert.rejects(f.create('A')); const changed = await f.status(); assert.equal(changed.plan.frozen, true);
  assert.deepEqual(f.store.plan('run')!.snapshot.plan.tasks[1].completion, ['test']);
  await assert.rejects(f.call('reconcile_plan', { expectedFileHash: changed.plan.fileHash, expectedPlanHash: changed.plan.observedPlanHash }), /approved plan/);
  writeFileSync(f.planPath, original.replace('notes', 'changed notes'));
  const changedProse = await f.status();
  await assert.rejects(f.call('reconcile_plan', { expectedFileHash: changedProse.plan.fileHash, expectedPlanHash: changedProse.plan.observedPlanHash }), /approved plan/);
  writeFileSync(f.planPath, original);
  const restored = await f.status();
  await f.call('reconcile_plan', { expectedFileHash: restored.plan.fileHash, expectedPlanHash: restored.plan.observedPlanHash });
  assert.equal((await f.create('A')).workerId, 'A');
});

test('plan_change_requires_matching_agreement', async t => {
  const f = await planControllerFixture(t);
  const before = f.store.plan('run')!, original = readFileSync(f.planPath, 'utf8');
  const proposal = { expectedPlanHash: before.snapshot.planHash, tasks: [{ id: 'B', completion: ['revised-check'] }], reason: 'The old check misses an acceptance case.', alternatives: ['Keep the existing check.'], recommendation: 'Replace the old check.' };
  for (const changes of [{ repository: f.trees }, { integration_branch: 'elsewhere' }, { max_parallel: 4 }, { tasks: [{ id: 'B', scope: ['outside.txt'] }] }, { tasks: [{ id: 'B', agent: { model: 'mock', effort: 'low', permissionProfileId: 'full-access' } }] }]) {
    await assert.rejects(f.call('propose_plan_change', { ...proposal, ...changes }));
  }
  const decision = await f.call('propose_plan_change', proposal);
  assert.deepEqual(decision.blockingTaskIds, ['B']);
  const { humanDecisionForm: { form, decision: presented } } = await f.call('answer_consultation', { decisionId: decision.id });
  assert.match(presented.question, /completion.*\["test"\].*\["revised-check"\]/);
  const apply = { decisionId: decision.id, expectedPlanHash: before.snapshot.planHash, proposedPlanHash: decision.proposedPlanHash };
  await assert.rejects(f.call('apply_plan_change', apply), /agreement/);
  await f.controller.humanResponse({ decision: form, answer: { optionId: 'approve' } }, f.parent);
  await assert.rejects(f.call('apply_plan_change', { ...apply, proposedPlanHash: 'f'.repeat(64) }), /agreement/);
  writeFileSync(f.planPath, original.replace('"completion":["test"]', '"completion":["injected"]'));
  await assert.rejects(f.call('apply_plan_change', apply));
  writeFileSync(f.planPath, original);
  const restored = await f.status();
  await f.call('reconcile_plan', { expectedFileHash: restored.plan.fileHash, expectedPlanHash: restored.plan.observedPlanHash });
  await f.call('write_progress', { expectedFileHash: (await f.status()).plan.fileHash });
  const oldProgress = readFileSync(f.planPath, 'utf8').split('<!-- chat-control:plan:end -->')[1];
  const args = { ...f.ref(), ...apply };
  const result = await f.controller.call('apply_plan_change', args, f.parent);
  assert.deepEqual(await f.controller.call('apply_plan_change', args, f.parent), result);
  await assert.rejects(f.call('apply_plan_change', apply));
  await assert.rejects(f.call('answer_consultation', { decisionId: decision.id, close: 'cancelled' }));
  assert.equal(result.state, 'plan_changed');
  assert.equal(f.store.plan('run')!.bindingHash, before.bindingHash);
  assert.deepEqual(f.store.plan('run')!.snapshot.plan.tasks.map(task => task.completion), [['test'], ['revised-check']]);
  assert.deepEqual(f.store.planRevision('run', before.snapshot.planHash)?.plan, before.snapshot.plan);
  assert.deepEqual(f.store.coordinationRevision('run', decision.id), { previousPlanHash: before.snapshot.planHash, proposedPlanHash: decision.proposedPlanHash });
  assert.equal(readFileSync(f.planPath, 'utf8').split('<!-- chat-control:plan:end -->')[1], oldProgress);
  assert.equal((await f.status()).scopeValid, true);
});

test('legacy_snapshot_cannot_pin_unverified_prose_with_an_unchanged_yaml_hash', async t => {
  const f = await planControllerFixture(t);
  const { snapshot: { documentHash: _documentHash, planText: _planText, ...legacy }, pin } = f.store.plan('run')!;
  f.store.savePlan('run', legacy, pin);
  const approved = readFileSync(f.planPath, 'utf8');
  writeFileSync(f.planPath, approved.replace('notes', 'unapproved'));
  const { plan: changed } = await f.status();
  assert.equal(changed.frozen, true);
  assert.equal(changed.observedPlanHash, legacy.planHash);
  await assert.rejects(f.call('reconcile_plan', { expectedFileHash: changed.fileHash, expectedPlanHash: changed.observedPlanHash }), /approved plan/);
  writeFileSync(f.planPath, approved);
  const { plan: restored } = await f.status();
  await f.call('reconcile_plan', { expectedFileHash: restored.fileHash, expectedPlanHash: restored.observedPlanHash });
  assert.equal(f.store.plan('run')!.snapshot.documentHash, readPlan(f.planPath).documentHash);
});

test('approved_change_updates_only_affected_tasks', async t => {
  const f = await planControllerFixture(t, fixture => {
    fixture.plan.run.max_parallel = 2;
    fixture.plan.tasks.push({ ...fixture.plan.tasks[0], id: 'C', scope: ['c.txt'] });
  });
  const oldA = await f.create('A'), c = await f.create('C');
  const oldAssignment = f.store.gitAssignment(oldA.attemptId)!;
  const oldReport = await f.complete('A', oldA, 'old requirements', false);
  const dirty = path.join(oldAssignment.cwd, 'unfinished.txt');
  writeFileSync(dirty, 'preserve');
  const expectedPlanHash = f.store.plan('run')!.snapshot.planHash;
  const stale = await f.call('propose_decision', { proposal: { kind: 'consultation', recipient: 'human', taskIds: ['C'], blockingTaskIds: [], planHash: expectedPlanHash, question: 'Is C ready?', options: [{ id: 'yes', label: 'Yes', description: 'Continue' }], allowFreeText: false } });
  const oldForm = (await f.call('answer_consultation', { decisionId: stale.id })).humanDecisionForm.form;
  const change = await f.call('propose_plan_change', { expectedPlanHash, tasks: [{ id: 'A', completion: ['revised-check'] }], reason: 'A needs another check.', alternatives: ['Keep the current evidence.'], recommendation: 'Run the revised check.' });
  assert.deepEqual(change.blockingTaskIds, ['A', 'B']);
  const form = (await f.call('answer_consultation', { decisionId: change.id })).humanDecisionForm.form;
  await f.controller.humanResponse({ decision: form, answer: { optionId: 'approve' } }, f.parent);
  const apply = { decisionId: change.id, expectedPlanHash, proposedPlanHash: change.proposedPlanHash };
  await assert.rejects(f.call('send_instruction', { taskId: 'A', target: oldA, agent: { model: 'mock', effort: 'low' }, text: 'old task' }), /held or stale/);
  await assert.rejects(f.call('apply_plan_change', apply), /parked/);
  await f.call('hold_task', { taskId: 'A', decisionId: change.id });
  const cBefore = f.store.planStates('run').C;
  await f.call('apply_plan_change', apply);
  assert.deepEqual(f.store.planStates('run').C, cBefore);
  assert.equal(f.store.attempts('run').find(row => row.id === c.attemptId)?.state, 'idle');
  assert.equal(f.store.coordinationDecision('run', stale.id)?.decision.state, 'superseded');
  await assert.rejects(f.controller.humanResponse({ decision: oldForm, answer: { optionId: 'yes' } }, f.parent));
  await assert.rejects(f.call('report', { taskId: 'A', report: oldReport.report }, { actor: oldA, turnId: 'turn' }));
  await assert.rejects(f.create('A'));
  await f.call('resume_task', { taskId: 'A', resolvedDecisionId: change.id });
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: oldReport.sha, evidenceRefs: [] }));
  const newA = await f.create('A');
  assert.notEqual(newA.attemptId, oldA.attemptId);
  assert.notEqual(f.store.gitAssignment(newA.attemptId)!.cwd, oldAssignment.cwd);
  assert.equal(readFileSync(dirty, 'utf8'), 'preserve');
  let delivered = '';
  f.runtime.send = async (_worker, text) => { delivered = text; };
  await f.call('send_instruction', { taskId: 'A', target: newA, agent: { model: 'mock', effort: 'low' }, text: 'Implement A.' });
  assert.match(delivered, /"completion":\["revised-check"\]/);
  assert.match(delivered, /Implement A\./);
  const cResult = await f.complete('C', c);
  await f.call('record_decision', { taskId: 'C', decision: 'accept_candidate', candidateSha: cResult.sha, evidenceRefs: [] });
  assert.equal((await f.status()).plan.tasks.C.state, 'candidate_accepted');
  const updated = await f.complete('A', newA, 'new requirements', true, 'revised-turn', checks.map(check => ({ ...check, name: 'revised-check' })));
  await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: updated.sha, evidenceRefs: [] });
});

test('approved_plan_revision_recovers_from_partial_file_and_database_update', async t => {
  const f = await planControllerFixture(t);
  const expectedPlanHash = f.store.plan('run')!.snapshot.planHash;
  const change = await f.call('propose_plan_change', { expectedPlanHash, tasks: [{ id: 'B', completion: ['different'] }], reason: 'Adjust the acceptance check.', alternatives: ['Keep the existing check.'], recommendation: 'Use the new check.' });
  const form = (await f.call('answer_consultation', { decisionId: change.id })).humanDecisionForm.form;
  await f.controller.humanResponse({ decision: form, answer: { optionId: 'approve' } }, f.parent);
  const args = { ...f.ref(), decisionId: change.id, expectedPlanHash, proposedPlanHash: change.proposedPlanHash };
  const operationResult = f.store.operationResult.bind(f.store);
  f.store.operationResult = (id, state, result) => {
    if (id === args.operationId) throw new Error('audit failure after file write');
    operationResult(id, state, result);
  };
  await assert.rejects(f.controller.call('apply_plan_change', args, f.parent), /audit failure/);
  assert.equal(readPlan(f.planPath).planHash, change.proposedPlanHash);
  assert.equal(f.store.plan('run')!.snapshot.planHash, expectedPlanHash);
  assert.equal(f.store.planStates('run').B, undefined);
  assert.equal(f.store.coordinationRevision('run', change.id), undefined);
  assert.equal((await f.status()).plan.frozen, true);
  await assert.rejects(f.create('A'));
  f.store.operationResult = operationResult;
  assert.equal((await f.controller.call('apply_plan_change', args, f.parent)).state, 'plan_changed');
  assert.equal((await f.status()).plan.frozen, false);
});

test('a_new_human_consultation_can_replace_an_old_hold_reason', async t => {
  const f = await planControllerFixture(t, fixture => { fixture.plan.tasks[1].depends_on = []; });
  const oldA = await f.create('A'), expectedPlanHash = f.store.plan('run')!.snapshot.planHash;
  const proposal = { kind: 'consultation', recipient: 'human', taskIds: ['A'], blockingTaskIds: ['A'], planHash: expectedPlanHash, question: 'Continue A?', options: [{ id: 'resume', label: 'Resume', description: 'Continue' }], allowFreeText: false };
  const consultation = await f.call('propose_decision', { proposal });
  const change = await f.call('propose_plan_change', { expectedPlanHash, tasks: [{ id: 'B', completion: ['different'] }], reason: 'B needs a different check.', alternatives: ['Keep the old check.'], recommendation: 'Change it.' });
  const form = (await f.call('answer_consultation', { decisionId: change.id })).humanDecisionForm.form;
  await f.controller.humanResponse({ decision: form, answer: { optionId: 'approve' } }, f.parent);
  await f.call('apply_plan_change', { decisionId: change.id, expectedPlanHash, proposedPlanHash: change.proposedPlanHash });
  assert.equal(f.store.attempts('run').find(row => row.id === oldA.attemptId)?.state, 'idle');
  assert.equal((await f.status()).plan.tasks.A.blockedByDecision, true);
  await assert.rejects(f.call('send_instruction', { taskId: 'A', target: oldA, agent: { model: 'mock', effort: 'low' }, text: 'Continue without approval.' }), /held or stale/);
  await assert.rejects(f.call('resume_task', { taskId: 'A', resolvedDecisionId: consultation.id }));
  const tooWeak = await f.call('propose_decision', { proposal: { ...proposal, recipient: 'coordinator', planHash: change.proposedPlanHash } });
  await assert.rejects(f.call('hold_task', { taskId: 'A', decisionId: tooWeak.id, replacesDecisionId: consultation.id }), /cannot replace/);
  await f.call('answer_consultation', { decisionId: tooWeak.id, close: 'cancelled' });
  const replacement = await f.call('propose_decision', { proposal: { ...proposal, planHash: change.proposedPlanHash } });
  await f.call('hold_task', { taskId: 'A', decisionId: replacement.id, replacesDecisionId: consultation.id });
  const newForm = (await f.call('answer_consultation', { decisionId: replacement.id })).humanDecisionForm.form;
  await f.controller.humanResponse({ decision: newForm, answer: { optionId: 'resume' } }, f.parent);
  await f.call('resume_task', { taskId: 'A', resolvedDecisionId: replacement.id });
  const a = await f.create('A');
  assert.equal(f.store.gitAssignment(a.attemptId)!.cwd, f.store.gitAssignment(oldA.attemptId)!.cwd);
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
