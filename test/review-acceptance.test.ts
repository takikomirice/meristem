import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { planControllerFixture } from './fixtures/plan-controller.js';
import { checks, commitFile, git } from './fixtures/serial-git.js';
import { resolveTaskPermissions } from '../src/permissions.js';
import type { WorkerRef } from '../src/contracts.js';

async function reviewFixture(t: TestContext, mixed = false) {
  const f = await planControllerFixture(t, (fixture, scope) => {
    fixture.plan.schema_version = 2;
    if (!mixed) fixture.plan.tasks.splice(1);
    for (const task of fixture.plan.tasks) Object.assign(task.agent, { permissionProfileId: task.id === 'A' ? 'read-only' : 'workspace' });
    fixture.plan.tasks[0].completion = ['review'];
    Object.assign(fixture.plan.run, { worker_model_policy: { mode: 'rules', candidates: [{ model: 'mock', effort: 'low' }, { model: 'second', effort: 'high' }] } });
    Object.assign(fixture.plan.tasks[0], { model_routing: { kind: 'investigation', complexity: 'bounded', comparison_key: 'check-file', pin_initial: true } });
    scope!.permissionPermit = { allowedProfileIds: ['read-only', 'workspace'], writableRoots: [fixture.trees], allowedReviewers: ['user'] };
  }, undefined, async (controller, pending) => controller.authorize(pending.bindingId, pending.modelRouting.scopeHash));
  Object.assign(f.runtime, { settings(worker: WorkerRef) {
    const a = f.starts.find(item => item.identity.attemptId === worker.attemptId);
    const agent = { model: a.model, effort: a.effort, permissionProfileId: a.permissionProfileId };
    return { agent, history: 'new', permissions: resolveTaskPermissions(agent, a.permissionPermit) };
  } });
  const instructions: string[] = [];
  f.runtime.send = async (_worker, text) => { instructions.push(text); };
  const a = await f.create('A'), assignment = f.store.gitAssignment(a.attemptId)!;
  const base = assignment.baseSha, branch = assignment.branch;
  const check = { ...checks[0], name: 'review', command: 'git show HEAD:original.txt', checked_sha: base };
  const report = { task_id: 'A', worker_id: a.workerId, attempt_id: a.attemptId, actor_id: a.threadId, status: 'completed', base_sha: base,
    candidate_sha: null, branch, push_result: { status: 'not_attempted', remote: 'origin', branch }, summary: 'Reviewed original.txt at the assigned revision.', checks: [check], remaining: [] };
  const submit = (operationId: string, patch = {}, turnId = 'turn') => f.call('report', { taskId: 'A', operationId, report: { ...report, ...patch } }, { actor: a, turnId });
  const send = () => f.call('send_instruction', { taskId: 'A', target: a, agent: { model: 'mock', effort: 'low' }, text: 'Review original.txt and report the evidence.' });
  const accept = (reportRef: string, extra = {}) => f.call('record_decision', { taskId: 'A', decision: 'accept_review', integrationSha: base, evidenceRefs: [reportRef], ...extra });
  const close = async () => { f.store.completedTurn(a, 'turn'); await f.broker.releaseCompleted('run', a); };
  return { ...f, a, assignment, base, check, report, submit, send, accept, close, instructions };
}

test('only the parent can adopt a completed read-only report and finish at the original SHA', async t => {
  const f = await reviewFixture(t);
  await f.send();
  for (const required of ['candidate_sha', 'checked_sha', 'review', 'Review original.txt and report the evidence.']) assert(f.instructions[0].includes(required));
  await f.submit('draft', { summary: 'Preliminary findings.' });
  await f.submit('final');
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_review', integrationSha: f.base, evidenceRefs: ['final'] }, { actor: f.a, turnId: 'turn' }), /worker cannot control/);
  await assert.rejects(f.accept('final'));
  await f.close();
  const status = await f.status();
  assert.equal(status.plan.tasks.A.state, 'review_ready');
  assert.equal(status.plan.tasks.A.reportRef, 'final');
  assert.equal(status.reports.find((row: any) => row.reportRef === status.plan.tasks.A.reportRef).report.summary, f.report.summary);
  assert.equal(status.plan.tasks.A.reviewedSha, f.base);
  assert.equal(status.plan.tasks.A.candidateSha, undefined);
  await assert.rejects(f.accept('draft'));
  await assert.rejects(f.accept('final', { integrationSha: 'a'.repeat(40) }));
  await assert.rejects(f.accept('final', { candidateSha: f.base }));
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: f.base, evidenceRefs: ['final'] }));
  const saveDecision = f.store.saveDecision.bind(f.store);
  f.store.saveDecision = () => { throw new Error('audit unavailable'); };
  await assert.rejects(f.accept('final'), /audit unavailable/);
  assert.equal(f.store.planStates('run').A.reviewEvidence, undefined);
  f.store.saveDecision = saveDecision;
  await f.accept('final', { operationId: 'parent-adoption' });
  assert.deepEqual(f.store.planStates('run').A.reviewEvidence, { reportRef: 'final', reviewedSha: f.base, acceptedByParentTurnId: f.parent.turnId });
  const [outcome] = f.store.modelOutcomes('run', 'A');
  assert.equal(outcome.reason, 'review_accepted'); assert.equal(outcome.result, 'accepted');
  assert.deepEqual(outcome.evidenceRefs, ['final', 'parent-adoption']); assert.equal(outcome.integrationSha, f.base);
  await assert.rejects(f.accept('final'));
  await f.call('write_progress', { expectedFileHash: status.plan.fileHash });
  assert(readFileSync(f.planPath, 'utf8').includes('A: integrated ' + f.base + ' final'));
  const dirty = path.join(status.plan.integrationCwd, 'unexpected.txt');
  writeFileSync(dirty, 'preserve');
  const finish = () => f.call('record_decision', { taskId: 'A', decision: 'finish', evidenceRefs: [] });
  await assert.rejects(finish()); unlinkSync(dirty);
  await finish(); assert.equal(f.store.run('run').state, 'completed');
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/source');
});

test('a review requires the acknowledged assignment, completed turn, nonblank evidence and two clean pinned heads', async t => {
  const f = await reviewFixture(t);
  await f.submit('before-send');
  await f.send();
  await f.close();
  await assert.rejects(f.accept('before-send'));
  await assert.rejects(f.submit('late-report'));
  const valid = f.report;
  // Simulate historical records at rest to check the independent adoption gate.
  const saveHistorical = (operationId: string, patch = {}, turn = 'turn') => {
    const ref = { ...f.ref(), operationId };
    f.store.prepareOperation(ref, 'b'.repeat(64));
    f.store.saveReport(ref, f.a, turn, { ...valid, ...patch });
    f.store.operationResult(operationId, 'settled', { state: 'report_saved' });
  };
  for (const [index, patch] of [
    { status: 'failed' }, { summary: ' ' }, { candidate_sha: f.base }, { remaining: ['finding requires action'] },
    { push_result: { ...valid.push_result, status: 'pushed' } }, { checks: [] },
    { checks: [{ ...f.check, checked_sha: undefined }] }, { checks: [{ ...f.check, evidence_refs: [' '] }] },
    { checks: [{ ...f.check, result: 'failed', exit_code: 1 }] }
  ].entries()) {
    const operationId = 'invalid-' + index;
    saveHistorical(operationId, patch);
    await assert.rejects(f.accept(operationId));
  }
  saveHistorical('wrong-turn', {}, 'other');
  await assert.rejects(f.accept('wrong-turn'));
  saveHistorical('valid');
  const attempts = f.store.attempts.bind(f.store);
  f.store.attempts = runId => attempts(runId).map(row => {
    const reg = JSON.parse(row.registration);
    reg.settings.permissions.permissionProfileId = 'meristem-managed';
    return { ...row, registration: JSON.stringify(reg) };
  });
  await assert.rejects(f.accept('valid'), /read-only settings/);
  f.store.attempts = attempts;
  const reviewState = f.store.planStates('run').A;
  f.store.savePlanState('run', 'A', { ...reviewState, reviewPlanHash: 'f'.repeat(64) });
  await assert.rejects(f.accept('valid')); f.store.savePlanState('run', 'A', reviewState);
  const pending = f.ref();
  f.store.prepareOperation(pending, 'c'.repeat(64)); f.store.operationState(pending.operationId, 'sent_unknown');
  await assert.rejects(f.accept('valid')); f.store.operationState(pending.operationId, 'cancelled');
  f.store.saveStop('run', { worker: f.a, state: 'stopped', evidenceRefs: [] }, true);
  await assert.rejects(f.accept('valid')); await f.close();
  const dirty = path.join(f.assignment.cwd, 'unexpected.txt');
  writeFileSync(dirty, 'preserve'); await assert.rejects(f.accept('valid')); unlinkSync(dirty);
  const integration = f.store.plan('run')!.pin.integrationCwd;
  commitFile(integration, 'new.txt', 'new base'); await assert.rejects(f.accept('valid'));
  assert.equal(f.store.planStates('run').A.state, 'assigned');
});

test('report-only acceptance releases dependencies and retains SHA-bound requirements at the next code integration', async t => {
  const f = await reviewFixture(t, true);
  await f.send(); await f.submit('review-report'); await f.close();
  await assert.rejects(f.create('B'));
  await f.accept('review-report');
  const b = await f.create('B'), result = await f.complete('B', b);
  assert.equal(result.assignment.baseSha, f.base);
  await assert.rejects(f.call('record_decision', { taskId: 'B', decision: 'accept_review', integrationSha: f.base, evidenceRefs: ['review-report'] }));
  await f.call('record_decision', { taskId: 'B', decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  git(f.store.plan('run')!.pin.integrationCwd, 'merge', '--ff-only', result.sha);
  const integrate = (check: typeof f.check) => f.call('record_decision', { taskId: 'B', decision: 'accept_integration', integrationSha: result.sha, checks: [...checks, check], evidenceRefs: [] });
  await assert.rejects(integrate(f.check), /new integration SHA/);
  await integrate({ ...f.check, checked_sha: result.sha });
  assert.equal((await f.status()).plan.tasks.A.reviewedSha, f.base);
  await f.call('record_decision', { taskId: 'B', decision: 'finish', evidenceRefs: [] });
  assert.equal(f.store.run('run').state, 'completed');
});
