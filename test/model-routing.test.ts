import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import path from 'node:path';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import type { WorkerRef } from '../src/contracts.js';
import type { ManagedRuntime } from '../src/mcp.js';
import { McpController } from '../src/mcp.js';
import { Broker } from '../src/broker.js';
import { RequestFailure } from '../src/failures.js';
import { selectNextAgent, recommendInitialAgent, summarizeModelOutcomes, type ModelOutcome } from '../src/model-routing.js';
import { resolveTaskPermissions } from '../src/permissions.js';
import { fileHash, readPlan } from '../src/plan.js';
import { pinRepository } from '../src/git-evidence.js';
import { exportRoutingSummary, loadPlanRoutingSummary, loadRoutingSummary } from '../src/routing-summary.js';
import { Store } from '../src/store.js';
import { planControllerFixture } from './fixtures/plan-controller.js';
import { checks, commitFile, git, serialFixture } from './fixtures/serial-git.js';

type Fixture = Awaited<ReturnType<typeof routingFixture>>;
const modelRouting = { kind: 'implementation', complexity: 'bounded', comparison_key: 'same-checks', pin_initial: true };
const candidates = [{ model: 'mock', effort: 'low' }, { model: 'mock', effort: 'high' }, { model: 'strong', effort: 'high' }];

function sample(agent: typeof candidates[number], id: number, result: ModelOutcome['result'], phase: ModelOutcome['phase'] = 'initial'): ModelOutcome {
  return {
    agent, runId: 'run', taskId: 'A', attemptId: 'attempt-' + id, recordedAt: '2026-11-18T01:00:00.000Z',
    repositoryKey: 'a'.repeat(64), planHash: 'b'.repeat(64), classification: { ...modelRouting, kind: 'implementation', complexity: 'bounded', pin_initial: true },
    requiredChecks: ['test'], result, phase, reason: result === 'accepted' ? 'integrated' : 'required_check_failed', evidenceRefs: []
  };
}

function trials(agent: typeof candidates[number], firstId: number, accepted: number, total = 5, phase: ModelOutcome['phase'] = 'initial') {
  return Array.from({ length: total }, (_, i) => sample(agent, firstId + i, i < accepted ? 'accepted' : 'failed', phase));
}

function seedHistory(f: ReturnType<typeof serialFixture>, directory: string, runId: string, outcomes: ModelOutcome[], options: { active?: boolean; unknownStop?: boolean } = {}) {
  const snapshot = readPlan(f.planPath), pin = pinRepository(snapshot, runId);
  const store = new Store(directory, f.repository);
  try {
    store.createRun(runId);
    store.savePlan(runId, snapshot, pin);
    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome.agent || snapshot.plan.schema_version !== 2) throw new Error('fixture requires a configured agent');
      const task = snapshot.plan.tasks[0];
      const planHash = fileHash(outcome.agent.model + '/' + outcome.agent.effort);
      const historical = { ...snapshot, planHash, plan: { ...snapshot.plan, tasks: [
        { ...task, model_routing: outcome.classification, agent: { ...task.agent, ...outcome.agent } }
      ] } };
      store.savePlanRevision(runId, historical);
      const { attemptId, agent } = outcome;
      const worker = { workerId: 'A', threadId: attemptId, ownerId: 'owner', ownerEpoch: 'epoch', attemptId };
      store.register({ ...agent, runId, taskId: 'A', worker, assignmentId: 'assignment-' + index, cwd: f.trees, branch: 'fixture',
        repositoryId: 'repo', hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job',
        binding: { windowBindingId: 'window', terminalId: 'terminal', worker } });
      store.saveStop(runId, { worker, state: options.unknownStop && index === 0 ? 'unknown' : 'stopped', evidenceRefs: ['cleanup'] }, true);
      const operationId = runId + '-' + index;
      store.prepareOperation({ runId, operationId, expectedRevision: store.run(runId).revision }, fileHash(operationId));
      store.saveDecision(operationId, runId, 'A', 'turn', { modelOutcomes: [{ ...outcome, runId, planHash, repositoryKey: fileHash(pin.commonDir.toLowerCase()) }] });
      store.operationState(operationId, 'settled');
    }
    if (!options.active) store.finishRun(runId);
    return fileHash(pin.commonDir.toLowerCase());
  } finally { store.close(); }
}

function configureHistoryPlan(f: ReturnType<typeof serialFixture>, mode: 'rules' | 'learned') {
  f.plan.schema_version = 2;
  Object.assign(f.plan.run, { worker_model_policy: { mode, candidates } });
  for (const task of f.plan.tasks) {
    Object.assign(task.agent, { permissionProfileId: 'workspace' });
    Object.assign(task, { model_routing: modelRouting });
  }
  f.savePlan();
}

test('routing_history_cannot_promote_a_model_on_recovery_only', () => {
  const outcomes = [...trials(candidates[0], 0, 1), ...trials(candidates[1], 10, 5, 5, 'handoff')];
  assert.equal(recommendInitialAgent(candidates[0], candidates, summarizeModelOutcomes(outcomes)), undefined);
});

test('routing_history_requires_comparable_first_attempts', () => {
  const [baseline, upgrade, other] = candidates;
  const first = trials(baseline, 0, 3), next = trials(upgrade, 20, 4);
  const pick = (more: ModelOutcome[]) => recommendInitialAgent(baseline, candidates, summarizeModelOutcomes([...first, ...more]));
  assert.deepEqual(pick(next), upgrade);
  assert.deepEqual(pick([...next, ...trials(other, 40, 4)]), upgrade);
  assert.deepEqual(pick([...next, ...trials(other, 40, 5)]), other);
  assert.equal(pick(trials(upgrade, 20, 3)), undefined);
  assert.equal(pick(next.slice(0, 4)), undefined);
  assert.equal(pick([]), undefined);
  assert.equal(pick(trials(upgrade, 20, 7, 9)), undefined);
  assert.equal(pick([...next.slice(0, 4), { ...next[4], requiredChecks: ['other'] }]), undefined);
});

test('model_switch_uses_the_next_exact_pair_and_does_not_wrap', () => {
  assert.deepEqual(selectNextAgent(candidates, candidates[0]), candidates[1]);
  assert.deepEqual(selectNextAgent(candidates, candidates[1]), candidates[2]);
  assert.equal(selectNextAgent(candidates, candidates[2]), undefined);
  assert.equal(selectNextAgent(candidates, { model: 'mock', effort: 'other' }), undefined);
});

function routingFixture(t: TestContext, options: {
  parallel?: boolean; confirmed?: boolean; rules?: boolean; failLaunch?: boolean; unconfirmedSwitch?: boolean;
  reuseSiblingThread?: boolean; removeCandidateBeforeDelivery?: boolean;
  mode?: 'learned' | 'rules'; useHistory?: boolean; pin?: boolean; catalogFallback?: 'startup' | 'delivery';
  limit?: number; approve?: Parameters<typeof planControllerFixture>[3];
  onStart?: (assignment: Parameters<ManagedRuntime['start']>[0]) => Promise<void>
} = {}) {
  const agents = new Map<string, Parameters<ManagedRuntime['start']>[0]>();
  const deliveries: WorkerRef[] = [];
  const cleanup: Array<() => void> = [];
  const close = () => { for (const dispose of cleanup.splice(0)) dispose(); };
  t.after(close);
  const runtime: ManagedRuntime = {
    async start(assignment) {
      const sibling = options.reuseSiblingThread && assignment.effort === 'high'
        ? [...agents.values()].find(worker => worker.workerId === 'B')?.identity?.attemptId : undefined;
      const worker = { ...assignment.identity!, threadId: sibling ?? assignment.identity!.attemptId };
      agents.set(worker.attemptId, assignment);
      await options.onStart?.(assignment);
      if (options.failLaunch && assignment.effort === 'high') throw new Error('agent is not in catalog');
      return worker;
    },
    registration: () => ({ hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job' }),
    ...(options.confirmed === false ? {} : {
      settings(worker: WorkerRef) {
        const { model, effort, permissionProfileId, permissionPermit, initialFallback, cwd } = agents.get(worker.attemptId)!;
        const fallback = options.catalogFallback === 'startup' && initialFallback;
        const agent = { model, effort: options.unconfirmedSwitch && effort === 'high' ? 'low' : effort, ...(fallback || {}), permissionProfileId: permissionProfileId! };
        const permissions = resolveTaskPermissions(agent, permissionPermit!);
        return { agent, permissions: { ...permissions, writableRoots: [cwd] }, history: 'new' as const, ...(fallback ? { initialFallback: 'agent_not_in_catalog' as const } : {}) };
      }
    }),
    async send(worker) {
      if (options.removeCandidateBeforeDelivery && agents.get(worker.attemptId)?.effort === 'high') {
        throw new RequestFailure('failed', 'not_sent', undefined, undefined, 'agent_not_in_catalog');
      }
      deliveries.push(worker);
      if (options.catalogFallback === 'delivery' && agents.get(worker.attemptId)?.initialFallback) return 'agent_not_in_catalog' as const;
    },
    async stop(worker) { return { worker, state: 'stopped', evidenceRefs: ['cleanup'] }; },
    async releaseCompleted(worker) { return { worker, state: 'stopped', evidenceRefs: ['cleanup'] }; }
  };
  return planControllerFixture({ after: dispose => cleanup.push(dispose) }, f => {
    f.plan.schema_version = 2;
    if (options.rules || options.mode) Object.assign(f.plan.run, { worker_model_policy: { mode: options.mode ?? 'rules', candidates } });
    if (options.limit !== undefined) Object.assign(f.plan.run, { execution_limits: { maxCorrectionsPerTask: options.limit } });
    if (options.parallel) f.plan.run.max_parallel = 2;
    for (const task of f.plan.tasks) {
      Object.assign(task.agent, { permissionProfileId: 'workspace' });
      const { pin_initial, ...unpinned } = modelRouting;
      Object.assign(task, { model_routing: options.mode && !options.pin ? unpinned : modelRouting });
      if (options.parallel) task.depends_on = [];
    }
    if (options.useHistory) f.plan.tasks[1].completion = ['different-check'];
  }, runtime, options.approve ?? (options.rules || options.mode ? async (controller, pending) => {
    Reflect.apply(controller.authorize, controller, [pending.bindingId, pending.modelRouting?.scopeHash]);
  } : undefined), options.useHistory ? f => {
    const state = path.join(f.root, 'historical-state'), summary = path.join(f.root, 'history.json');
    const currentPlan = readFileSync(f.planPath);
    configureHistoryPlan(f, 'rules');
    seedHistory(f, state, 'historical', [...trials(candidates[0], 0, 3), ...trials(candidates[1], 10, 4)]);
    writeFileSync(f.planPath, currentPlan);
    const bytes = exportRoutingSummary([state]);
    writeFileSync(summary, bytes);
    return loadPlanRoutingSummary({ path: summary, sha256: fileHash(bytes) }, readPlan(f.planPath), 'run', state);
  } : undefined).then(f => ({ ...f, agents, deliveries, close }));
}

async function reportFailure(f: Fixture, worker: WorkerRef, result: 'failed' | 'not_run' = 'failed', reportId = 'failed_report') {
  const assignment = f.store.gitAssignment(worker.attemptId)!;
  await f.call('report', {
    operationId: reportId, taskId: 'A',
    report: {
      task_id: 'A', worker_id: worker.workerId, attempt_id: worker.attemptId, actor_id: worker.threadId,
      status: 'failed', base_sha: assignment.baseSha, candidate_sha: null, branch: assignment.branch,
      push_result: { status: 'not_attempted', remote: 'origin', branch: assignment.branch },
      summary: 'fixture failure', checks: [{ ...checks[0], result, exit_code: result === 'failed' ? 1 : null }], remaining: []
    }
  }, { actor: worker, turnId: 'failed_turn' });
  f.store.completedTurn(worker, 'failed_turn');
  await f.broker.releaseCompleted('run', worker);
}

test('status retains the acknowledged settings for a routed worker', async t => {
  const f = await routingFixture(t, { rules: true });
  const worker = await f.create('A');
  const expected = { agent: { ...candidates[0], permissionProfileId: 'workspace' }, history: 'new',
    permissions: { permissionProfileId: 'meristem-managed', approvalsReviewer: 'user', writableRoots: [f.store.gitAssignment(worker.attemptId)!.cwd] } };
  assert.deepEqual((await f.status()).attempts[0].settings, expected);
  assert.deepEqual(f.store.terminalRegistration('run', worker.attemptId)?.settings, expected);
});

function assessment(f: Fixture, worker: WorkerRef, overrides: object = {}) {
  return f.call('record_decision', {
    operationId: 'reassign', taskId: 'A', decision: 'handoff_new', evidenceRefs: ['failed_report'],
    modelAssessment: { attemptId: worker.attemptId, reason: 'required_check_failed', checkName: 'test' },
    ...overrides
  });
}

async function routingStatus(f: Fixture, taskId = 'A') {
  return (await f.controller.call('get_status', { runId: 'run', taskId }, f.parent)).modelRouting;
}

test('routing_summary_import_is_bounded_and_repository_pinned', () => {
  const f = serialFixture();
  configureHistoryPlan(f, 'rules');
  const one = path.join(f.root, 'one'), two = path.join(f.root, 'two'), active = path.join(f.root, 'active'), unknown = path.join(f.root, 'unknown');
  const repo = seedHistory(f, one, 'older', trials(candidates[0], 1000, 204, 204));
  seedHistory(f, two, 'newer', trials(candidates[1], 2000, 5));
  seedHistory(f, active, 'active', trials(candidates[0], 3000, 1, 1), { active: true });
  seedHistory(f, unknown, 'unknown', trials(candidates[0], 4000, 1, 1), { unknownStop: true });
  const dbFile = path.join(one, 'control.sqlite');
  const before = fileHash(readFileSync(dbFile));
  const artifact = path.join(f.root, 'routing.json');
  const command = spawnSync(process.execPath, ['dist/src/cli.js', 'routing-summary', '--state', one, '--state', two, '--state', active, '--state', unknown, '--out', artifact], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(command.status, 0, command.stderr);
  assert.equal(fileHash(readFileSync(dbFile)), before);
  const bytes = readFileSync(artifact), original = JSON.parse(bytes.toString('utf8'));
  assert.equal(original.samples.length, 200);
  assert.deepEqual(original.samples.slice(0, 5).map((row: any) => [row.runId, row.attemptId]), [2000, 2001, 2002, 2003, 2004].map(id => ['newer', 'attempt-' + id]));
  assert.ok(original.samples.slice(5).every((row: any) => row.runId === 'older'));
  assert.deepEqual(exportRoutingSummary([two, one, two]), bytes);
  const reference = JSON.parse(command.stdout);
  const imported = loadPlanRoutingSummary(reference, readPlan(f.planPath), 'next', active);
  assert.equal(imported.stats.reduce((total, row) => total + row.initialEvaluated, 0), 200);
  assert.equal(original.summary[0].usageTokens.unmeasured, 5);
  assert.throws(() => loadRoutingSummary(reference, 'b'.repeat(64), []), /repository mismatch/);
  assert.throws(() => loadRoutingSummary(reference, repo, [f.root]), /protected root/);
  assert.throws(() => loadRoutingSummary({ ...reference, sha256: 'c'.repeat(64) }, repo, []), /hash mismatch/);
  const altered = (value: Buffer | string) => {
    writeFileSync(artifact, value);
    return () => loadRoutingSummary({ path: artifact, sha256: fileHash(value) }, repo, []);
  };
  assert.throws(altered(JSON.stringify({ ...original, samples: [original.samples[0], original.samples[0]] })), /duplicate/);
  assert.throws(altered(JSON.stringify({ ...original, samples: [...original.samples, original.samples[0]] })), /200/);
  assert.throws(altered(JSON.stringify({ ...original, summary: [] })), /totals mismatch/);
  assert.throws(altered('{'), SyntaxError);
  assert.throws(altered(Buffer.alloc(512 * 1024 + 1)), /byte limit/);
  const other = serialFixture();
  configureHistoryPlan(other, 'rules');
  const otherState = path.join(other.root, 'state');
  seedHistory(other, otherState, 'other', trials(candidates[0], 0, 1, 1));
  assert.throws(() => exportRoutingSummary([one, otherState]), /repository mismatch/);
  const unrated = path.join(f.root, 'unrated');
  seedHistory(f, unrated, 'unrated', [sample(candidates[2], 1, 'unrated', 'handoff')]);
  const [row] = JSON.parse(exportRoutingSummary([unrated]).toString()).summary;
  assert.equal(row.handoffCount, 1);
  assert.equal(row.handoffEvaluated, 0);
  assert.deepEqual(row.durationMs, { total: null, unmeasured: 1 });
});

test('initial_learning_requires_the_imported_scope_and_respects_mode_and_pin', async t => {
  for (const [mode, useHistory, pin, reason, expected] of [
    ['learned', true, false, 'learned', candidates[1]],
    ['rules', true, false, 'rules_advisory', candidates[0]],
    ['learned', true, true, 'pinned', candidates[0]],
    ['learned', false, false, 'summary_not_configured', candidates[0]]
  ] as const) {
    let initialPermit: any;
    const f = await routingFixture(t, { mode, useHistory, pin, approve: async (controller, pending) => {
      initialPermit = pending.modelRouting;
      assert.throws(() => controller.authorize(pending.bindingId, 'a'.repeat(64)), /scope mismatch/);
      controller.authorize(pending.bindingId, initialPermit.scopeHash);
    } });
    assert.equal(initialPermit.summarySha256, f.scope.modelRoutingSummary?.sha256);
    const predicted = (await routingStatus(f)).initialRecommendation;
    assert.equal(predicted.reason, reason);
    assert.deepEqual(predicted.selected, expected);
    if (useHistory && !pin) {
      assert.equal((await routingStatus(f, 'B')).initialRecommendation.reason, 'insufficient_evidence');
    }
    const worker = await f.create('A');
    const created = f.agents.get(worker.attemptId)!;
    assert.deepEqual({ model: created.model, effort: created.effort }, expected);
    await assert.rejects(f.call('send_instruction', { taskId: 'A', target: worker, text: 'wrong setting', agent: expected === candidates[0] ? candidates[1] : candidates[0] }), /plan agent/);
    assert.equal((await f.call('send_instruction', { taskId: 'A', target: worker, text: 'fixture', agent: expected })).state, 'acked');
    assert.equal(f.deliveries.length, 1);
  }
});

test('initial_learning_falls_back_only_for_the_known_catalog_absence', async t => {
  for (const catalogFallback of ['startup', 'delivery'] as const) {
    const f = await routingFixture(t, { mode: 'learned', useHistory: true, catalogFallback });
    const worker = await f.create('A');
    const first = (await routingStatus(f)).initialRecommendation;
    assert.deepEqual(first.selected, catalogFallback === 'startup' ? candidates[0] : candidates[1]);
    const instruction = { ...f.ref(), taskId: 'A', target: worker, text: 'fixture', agent: first.selected, operationId: 'instruction' };
    assert.equal((await f.call('send_instruction', instruction)).state, 'acked');
    assert.equal((await f.call('send_instruction', instruction)).state, 'acked');
    assert.equal(f.deliveries.length, 1);
    const current = (await routingStatus(f)).initialRecommendation;
    assert.deepEqual(current.selected, candidates[0]);
    assert.equal(current.reason, 'agent_not_in_catalog');
  }
});

test('routing_is_opt_in_and_bound_to_the_human_permit', async t => {
  await assert.rejects(routingFixture(t, { rules: true, limit: 1, async approve(controller, pending, fixture) {
    const preview = pending.modelRouting;
    assert.deepEqual(preview.candidates, candidates);
    assert.deepEqual(preview.tasks, ['A', 'B'].map(taskId => ({ taskId, agent: candidates[0] })));
    assert.equal(preview.maxAutomaticChangesPerTask, 1);
    assert.equal(preview.planHash, readPlan(fixture.planPath).planHash);
    const confirm = (scopeHash?: string) => Reflect.apply(controller.authorize, controller, [pending.bindingId, scopeHash]);
    assert.throws(() => confirm(), /scope/);
    assert.throws(() => confirm('a'.repeat(64)), /scope/);
    confirm(preview.scopeHash);
    const policy = { mode: 'rules', candidates: [candidates[0], candidates[2]] };
    Object.assign(fixture.plan.run, { worker_model_policy: policy });
    fixture.savePlan();
    assert.throws(() => confirm(preview.scopeHash), /plan/);
  } }), /plan changed/);
});

test('routing_reserves_the_choice_before_worker_start', async t => {
  let launchEntered!: () => void;
  let releaseLaunch!: () => void;
  const entered = new Promise<void>(resolve => { launchEntered = resolve; });
  const released = new Promise<void>(resolve => { releaseLaunch = resolve; });
  const f = await routingFixture(t, { rules: true, onStart: async assignment => { if (assignment.effort === 'high') { launchEntered(); await released; } } });
  const first = await f.create('A');
  await reportFailure(f, first);
  const decision = { ...f.ref(), taskId: 'A', decision: 'handoff_new', evidenceRefs: ['failed_report'],
    modelAssessment: { attemptId: first.attemptId, reason: 'required_check_failed', checkName: 'test' } };
  await f.controller.call('record_decision', decision, f.parent);
  await f.controller.call('record_decision', decision, f.parent);
  const prepared = (await routingStatus(f)).nextAssignment;
  assert.deepEqual(prepared.agent, candidates[1]);
  assert.equal(prepared.previousAttemptId, first.attemptId);
  assert.deepEqual(prepared.evidenceRefs, ['failed_report']);
  assert.equal(f.agents.size, 1);
  const createArgs = { ...f.ref(), taskId: 'A' };
  const launch = f.controller.call('create_worker', createArgs, f.parent);
  try {
    await Promise.race([entered, launch.then(() => assert.fail('launch did not use reserved switch'))]);
    const reserved = f.store.attempts('run').at(-1)!;
    assert.equal(reserved.state, 'starting');
    assert.equal(JSON.parse(reserved.registration).effort, 'high');
    await assert.rejects(f.create('A'));
    assert.equal(f.agents.size, 2);
  } finally { releaseLaunch(); }
  const next = await launch;
  assert.deepEqual(await f.controller.call('create_worker', createArgs, f.parent), next);
  assert.equal((await routingStatus(f)).nextAssignment.attemptId, next.attemptId);
  await assert.rejects(f.call('send_instruction', { taskId: 'A', target: next, agent: candidates[0], text: 'wrong effort' }));
  await assert.rejects(f.call('send_instruction', { taskId: 'B', target: next, agent: candidates[1], text: 'wrong task' }));
  await assert.rejects(f.call('send_instruction', { taskId: 'A', target: first, agent: candidates[1], text: 'old attempt' }));
  const args = { ...f.ref(), taskId: 'A', target: next, agent: candidates[1], text: 'retry' };
  assert.equal((await f.controller.call('send_instruction', args, f.parent)).state, 'acked');
  assert.equal((await f.controller.call('send_instruction', args, f.parent)).state, 'acked');
  assert.deepEqual(f.deliveries, [next]);
});

test('routing_preserves_stop_and_approval_fences', async t => {
  const f = await routingFixture(t, { rules: true });
  const first = await f.create('A');
  await reportFailure(f, first);
  const unknown = f.ref();
  f.store.prepareOperation(unknown, 'a'.repeat(64));
  f.store.operationState(unknown.operationId, 'sent_unknown');
  await assert.rejects(assessment(f, first, { operationId: 'unknown_delivery' }));
  f.store.operationResult(unknown.operationId, 'cancelled', null);
  await assessment(f, first);
  const question = {
    key: 'question', worker: first, cwd: f.store.gitAssignment(first.attemptId)!.cwd,
    turnId: 'failed_turn', requestId: 1, kind: 'question' as const,
    payloadHash: 'b'.repeat(64), formGeneration: 'form', detail: '', expiresAt: null
  };
  f.store.saveRequest('run', { ...question, state: 'pending' });
  await assert.rejects(f.create('A'));
  f.store.saveRequest('run', { ...question, state: 'cancelled' });
  const previousPlan = f.store.plan('run')!;
  f.plan.tasks[1].agent.effort = 'high';
  f.savePlan();
  f.store.savePlan('run', readPlan(f.planPath), previousPlan.pin);
  assert.equal((await routingStatus(f)).nextAssignment, undefined);
  await assert.rejects(f.create('A'));
  assert.equal(f.agents.size, 1);
  f.plan.tasks[1].agent.effort = 'low';
  f.savePlan();
  f.store.savePlan('run', readPlan(f.planPath), previousPlan.pin);
  assert((await routingStatus(f)).nextAssignment);
  f.close();
  const restored = new Store(path.join(f.root, 'state'), f.repository);
  try {
    assert.equal(restored.run('run').state, 'needs_reconcile');
    const coordinator = new McpController(restored, new Broker(restored, f.runtime), f.runtime, 'run', f.parent.actor, f.scope);
    const ref = (operationId: string) => ({ runId: 'run', operationId, expectedRevision: restored.run('run').revision });
    await coordinator.call('resume_run', ref('resume'), f.parent);
    await assert.rejects(coordinator.call('create_worker', { ...ref('new_create'), taskId: 'A' }, f.parent), /model switch checkpoint changed/);
    assert.equal(f.agents.size, 1);
  }
  finally { restored.close(); }
});

test('model_switch_does_not_inherit_history_grants', async t => {
  const f = await routingFixture(t, { rules: true });
  const first = await f.create('A');
  await reportFailure(f, first);
  const old = f.store.gitAssignment(first.attemptId)!;
  writeFileSync(path.join(old.cwd, 'a.txt'), 'uncommitted');
  await assert.rejects(assessment(f, first, { operationId: 'dirty_handoff' }));
  unlinkSync(path.join(old.cwd, 'a.txt'));
  await assessment(f, first);
  const next = await f.create('A'), assigned = f.agents.get(next.attemptId)!;
  assert.notEqual(next.threadId, first.threadId);
  assert.notEqual(assigned.cwd, old.cwd);
  assert.equal(assigned.previous, undefined);
  assert.equal(assigned.historySource, undefined);
  assert.equal(assigned.permissionProfileId, 'workspace');
});

test('model_switch_rejects_a_clean_source_head_changed_after_the_decision', async t => {
  const f = await routingFixture(t, { rules: true });
  const first = await f.create('A');
  await reportFailure(f, first);
  await assessment(f, first);
  const source = f.store.gitAssignment(first.attemptId)!;
  const head = commitFile(source.cwd, 'a.txt', 'different clean source');
  assert.notEqual(head, source.baseSha);
  await assert.rejects(f.create('A'), /model switch source HEAD changed/);
  assert.equal(f.agents.size, 1);
});

test('model_switch_rejects_a_thread_already_registered_to_a_sibling', async t => {
  const f = await routingFixture(t, { rules: true, parallel: true, reuseSiblingThread: true });
  await f.create('B');
  const first = await f.create('A');
  await reportFailure(f, first);
  await assessment(f, first);
  await assert.rejects(f.create('A'), /fresh thread/);
  assert.match((await routingStatus(f)).creationFailure, /fresh thread/);
  assert.deepEqual(f.deliveries, []);
});

test('a_candidate_removed_before_delivery_reports_the_rejection_without_fallback', async t => {
  const f = await routingFixture(t, { rules: true, removeCandidateBeforeDelivery: true });
  const first = await f.create('A');
  await reportFailure(f, first);
  await assessment(f, first);
  const next = await f.create('A');
  const args = { ...f.ref(), taskId: 'A', target: next, agent: candidates[1], text: 'retry' };
  const cancelled = { state: 'cancelled', deliveryFailure: 'agent_not_in_catalog' };
  assert.deepEqual(await f.controller.call('send_instruction', args, f.parent), cancelled);
  assert.deepEqual(await f.controller.call('send_instruction', args, f.parent), cancelled);
  assert.equal(f.store.run('run').state, 'stopped');
  await assert.rejects(f.create('A'));
  assert.equal(f.agents.size, 2);
  assert.deepEqual(f.deliveries, []);
});

test('an_unavailable_or_unconfirmed_switch_cannot_fall_through_to_another_model', async t => {
  for (const options of [{ failLaunch: true }, { unconfirmedSwitch: true }]) {
    const f = await routingFixture(t, { rules: true, ...options });
    const first = await f.create('A');
    await reportFailure(f, first);
    await assessment(f, first);
    await assert.rejects(f.create('A'));
    await assert.rejects(f.create('A'));
    const status = await routingStatus(f);
    assert.match(status.creationFailure, options.failLaunch ? /catalog/ : /settings/);
    assert.equal(f.agents.size, 2);
    assert.equal(f.deliveries.length, 0);
  }
});

test('routing_stops_at_the_correction_limit_without_restarting_the_baseline', async t => {
  const f = await routingFixture(t, { rules: true, limit: 1 });
  const first = await f.create('A');
  await reportFailure(f, first);
  await assessment(f, first);
  const last = await f.create('A');
  await reportFailure(f, last, 'failed', 'second_report');
  await assessment(f, last, { operationId: 'limit_handoff', evidenceRefs: ['second_report'] });
  assert.equal((await routingStatus(f)).nextAssignment, undefined);
  await assert.rejects(f.create('A'));
  assert.equal(f.agents.size, 2);
});

test('routing_outcomes_are_attributed_once_to_the_verified_attempt', async t => {
  const f = await routingFixture(t);
  const first = await f.create('A');
  await reportFailure(f, first);
  assert.deepEqual((await routingStatus(f)).assessmentEvidence, { attemptId: first.attemptId, reportRef: 'failed_report' });
  const originalRevision = f.ref().expectedRevision;
  const decision = await assessment(f, first, { expectedRevision: originalRevision });
  assert.deepEqual(await assessment(f, first, { expectedRevision: originalRevision }), decision);
  assert.equal(f.agents.size, 1);
  assert.equal(f.deliveries.length, 0);
  await assert.rejects(assessment(f, first, { operationId: 'new_assessment' }));
  const next = await f.create('A');
  assert.equal(f.agents.get(next.attemptId)!.model, 'mock');
  assert.equal(f.agents.get(next.attemptId)!.effort, 'low');
  const candidate = await f.complete('A', next);
  await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: candidate.sha, evidenceRefs: [] });
  assert.deepEqual((await routingStatus(f)).outcomes.map((outcome: any) => outcome.result), ['failed']);
  git(f.store.plan('run')!.pin.integrationCwd, 'merge', '--ff-only', candidate.sha);
  const integrate = {
    ...f.ref(), operationId: 'integrate', taskId: 'A', decision: 'accept_integration',
    integrationSha: candidate.sha, checks: checks.map(check => ({ ...check, checked_sha: candidate.sha })), evidenceRefs: []
  };
  const accepted = await f.controller.call('record_decision', integrate, f.parent);
  assert.deepEqual(await f.controller.call('record_decision', integrate, f.parent), accepted);
  const status = await routingStatus(f);
  assert.deepEqual(status.outcomes.map((outcome: any) => [outcome.attemptId, outcome.phase, outcome.result]), [
    [next.attemptId, 'handoff', 'accepted'], [first.attemptId, 'initial', 'failed']
  ]);
  assert.equal(status.outcomes[0].integrationSha, candidate.sha);
  assert.deepEqual(status.outcomes[0].classification, modelRouting);
  assert.deepEqual(status.outcomes[0].requiredChecks, ['test']);
  assert.deepEqual(status.outcomes[1].evidenceRefs, ['failed_report']);
  assert.equal(status.summary[0].initialAccepted, 0);
  assert.equal(status.summary[0].initialEvaluated, 1);
  assert.equal(status.summary[0].handoffAccepted, 1);
  assert.equal(status.summary[0].completed, 1);
  await f.broker.stopRun('run');
  const archive = JSON.parse(exportRoutingSummary([path.join(f.root, 'state')]).toString());
  assert.equal(archive.samples.length, 2);
  assert.equal(archive.summary[0].initialEvaluated, 1);
  assert.equal(archive.summary[0].handoffCount, 1);
  f.close();
  const restored = new Store(path.join(f.root, 'state'), f.repository);
  try {
    assert.deepEqual(restored.modelOutcomes('run', 'A'), status.outcomes);
  } finally { restored.close(); }
});

test('model_assessment_requires_the_current_attempt_and_real_failed_evidence', async t => {
  const f = await routingFixture(t);
  const worker = await f.create('A');
  await assert.rejects(assessment(f, worker, { operationId: 'still_active' }));
  await reportFailure(f, worker, 'not_run');
  await assert.rejects(assessment(f, worker, { operationId: 'fake_worker', modelAssessment: { attemptId: 'other', reason: 'required_check_failed', checkName: 'test' } }));
  await assert.rejects(assessment(f, worker, { operationId: 'unrelated_report', evidenceRefs: ['unrelated'] }));
  await assert.rejects(assessment(f, worker, { operationId: 'not_executed' }));
  await assert.rejects(assessment(f, worker, { operationId: 'outside_decision', decision: 'pause' }));
  assert.deepEqual((await routingStatus(f)).outcomes, []);
  await assessment(f, worker, { operationId: 'environment', evidenceRefs: [], modelAssessment: { attemptId: worker.attemptId, reason: 'environment' } });
  const status = await routingStatus(f);
  assert.equal(status.outcomes[0].result, 'excluded');
  assert.equal(status.summary[0].initialEvaluated, 0);
});

test('unconfirmed_model_settings_are_never_used_in_performance_totals', async t => {
  const f = await routingFixture(t, { confirmed: false });
  const worker = await f.create('A');
  await reportFailure(f, worker);
  await assessment(f, worker);
  const status = await routingStatus(f);
  assert.equal(status.outcomes[0].agent, null);
  assert.equal(status.outcomes[0].result, 'unrated');
  assert.deepEqual(status.summary, []);
});

test('unresolved_delivery_or_requests_and_old_plan_versions_cannot_be_assessed', async t => {
  const f = await routingFixture(t);
  const worker = await f.create('A');
  await reportFailure(f, worker);
  const unknown = f.ref();
  f.store.prepareOperation(unknown, 'a'.repeat(64));
  f.store.operationState(unknown.operationId, 'sent_unknown');
  await assert.rejects(assessment(f, worker, { operationId: 'unknown_delivery' }), /resolved delivery/);
  f.store.operationResult(unknown.operationId, 'cancelled', null);

  const request = {
    key: 'question', worker, cwd: f.store.gitAssignment(worker.attemptId)!.cwd,
    turnId: 'failed_turn', requestId: 1, kind: 'question' as const,
    payloadHash: 'b'.repeat(64), formGeneration: 'form', detail: '', expiresAt: null
  };
  f.store.saveRequest('run', { ...request, state: 'pending' });
  await assert.rejects(assessment(f, worker, { operationId: 'unresolved_question' }), /resolved delivery/);
  f.store.saveRequest('run', { ...request, state: 'cancelled' });

  const original = f.store.plan('run')!;
  f.plan.tasks[1].agent.effort = 'medium';
  f.savePlan();
  f.store.savePlan('run', readPlan(f.planPath), original.pin);
  await assert.rejects(assessment(f, worker, { operationId: 'old_assignment' }), /assigned plan version/);
  assert.deepEqual((await routingStatus(f)).outcomes, []);
});

test('parallel_integration_records_each_accepted_attempt_under_its_own_task', async t => {
  const f = await routingFixture(t, { parallel: true });
  const a = await f.create('A'), b = await f.create('B');
  const first = await f.complete('A', a), second = await f.complete('B', b);
  for (const [taskId, candidateSha] of [['A', first.sha], ['B', second.sha]]) {
    await f.call('record_decision', { taskId, decision: 'accept_candidate', candidateSha, evidenceRefs: [] });
  }
  const cwd = f.store.plan('run')!.pin.integrationCwd;
  await f.call('record_decision', { taskId: 'A', decision: 'prepare_integration', inputCandidateShas: [first.sha, second.sha], evidenceRefs: [] });
  git(cwd, 'merge', '--no-edit', first.sha, second.sha);
  const integrationSha = git(cwd, 'rev-parse', 'HEAD');
  await f.call('record_decision', {
    taskId: 'A', decision: 'accept_integration', integrationSha, evidenceRefs: [],
    checks: [...checks, { ...checks[0], name: 'integration' }].map(check => ({ ...check, checked_sha: integrationSha }))
  });
  for (const [taskId, worker] of [['A', a], ['B', b]] as const) {
    const status = await routingStatus(f, taskId);
    assert.equal(status.outcomes.length, 1);
    assert.equal(status.outcomes[0].attemptId, worker.attemptId);
    assert.equal(status.outcomes[0].phase, 'initial');
    assert.equal(status.outcomes[0].integrationSha, integrationSha);
    assert.equal(status.summary[0].initialAccepted, 1);
  }
});

test('serial_integration_is_credited_only_with_checks_at_the_final_sha', async t => {
  const f = await routingFixture(t);
  for (const taskId of ['A', 'B']) {
    const worker = await f.create(taskId);
    const candidate = await f.complete(taskId, worker);
    await f.call('record_decision', { taskId, decision: 'accept_candidate', candidateSha: candidate.sha, evidenceRefs: [] });
    git(f.store.plan('run')!.pin.integrationCwd, 'merge', '--ff-only', candidate.sha);
    const reportedChecks = taskId === 'A' ? [{ ...checks[0], checked_sha: candidate.assignment.baseSha }] : checks;
    await f.call('record_decision', {
      taskId, decision: 'accept_integration', integrationSha: candidate.sha, checks: reportedChecks, evidenceRefs: []
    });
    assert.equal(f.store.planStates('run')[taskId].integrationSha, candidate.sha);
    const status = await routingStatus(f, taskId);
    assert.equal(status.outcomes[0].result, 'unrated');
    assert.deepEqual(status.summary, []);
  }
});

test('integration_does_not_score_a_stale_plan_or_unresolved_delivery', async t => {
  const f = await routingFixture(t);
  for (const taskId of ['A', 'B']) {
    const worker = await f.create(taskId);
    const candidate = await f.complete(taskId, worker);
    await f.call('record_decision', { taskId, decision: 'accept_candidate', candidateSha: candidate.sha, evidenceRefs: [] });
    const plan = f.store.plan('run')!;
    if (taskId === 'A') {
      f.plan.tasks[1].agent.effort = 'medium';
      f.savePlan();
      f.store.savePlan('run', readPlan(f.planPath), plan.pin);
    } else {
      const unresolved = f.ref();
      f.store.prepareOperation(unresolved, 'c'.repeat(64));
      f.store.operationState(unresolved.operationId, 'sent_unknown');
    }
    git(plan.pin.integrationCwd, 'merge', '--ff-only', candidate.sha);
    await f.call('record_decision', {
      taskId, decision: 'accept_integration', integrationSha: candidate.sha,
      checks: checks.map(check => ({ ...check, checked_sha: candidate.sha })), evidenceRefs: []
    });
    assert.equal(f.store.planStates('run')[taskId].integrationSha, candidate.sha);
    assert.deepEqual((await routingStatus(f, taskId)).outcomes, []);
  }
});
