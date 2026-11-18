import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Broker } from '../src/broker.js';
import { McpController, createMcpServer, type FixtureScope } from '../src/mcp.js';
import type { WorkerRef, ExecutionLimits } from '../src/contracts.js';
import { connectClient } from './fixtures/mcp-client.js';
import { gitScope } from './fixtures/git-scope.js';
import { spawnSync } from 'node:child_process';
import { RequestFailure } from '../src/failures.js';
import { WorkerRequests } from '../src/requests.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PlanSnapshot } from '../src/plan.js';
import type { RepositoryPin } from '../src/git-evidence.js';
import { planControllerFixture } from './fixtures/plan-controller.js';
import { git, commitFile } from './fixtures/serial-git.js';

test('resume_checks_codex_history_git_and_execution_records', async t => {
  const f = await planControllerFixture(t);
  let status = 'inProgress', provider = 'other', threadId = '';
  Object.assign(f.runtime, {
    registration: () => ({ hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job', modelProvider: 'mock' }),
    readHistory: async () => ({ threadId, modelProvider: provider, turns: [{ id: 'saved-turn', status, messages: [] }], nextCursor: null }),
  });
  const source = await f.create('A');
  threadId = source.threadId;
  const { ownerId, ownerEpoch } = source;
  await assert.rejects(f.controller.call('get_worker_history', { runId: 'run', target: source }, { actor: { ownerId, ownerEpoch, threadId }, turnId: 'worker-turn' }), /verified parent/);
  const args = () => ({ ...f.ref(), target: source });
  const resume = (input = args()) => f.controller.call('resume_worker_history', input, f.parent);
  await assert.rejects(resume(), /stop|cleanup/);
  await f.broker.retireWorker('run', source);
  assert.equal((await resume()).reason, 'history_identity_mismatch');
  provider = 'mock';
  threadId = 'other-thread';
  assert.equal((await resume()).reason, 'history_identity_mismatch');
  threadId = source.threadId;
  assert.equal((await resume()).reason, 'history_execution_mismatch');
  status = 'interrupted';
  const { cwd, branch } = f.store.gitAssignment(source.attemptId)!;
  git(cwd, 'switch', '-c', 'drifted');
  await assert.rejects(resume(), /worktree|branch/);
  git(cwd, 'switch', branch);
  const pending = await blockingConsultation(f);
  await assert.rejects(resume(), /consultation/);
  await f.call('answer_consultation', { decisionId: pending.id, close: 'cancelled' });

  const before = f.store.run('run');
  const viewed = await f.controller.call('get_worker_history', { runId: 'run', target: source }, f.parent);
  assert.equal(viewed.history.threadId, source.threadId);
  assert.deepEqual(f.store.run('run'), before);
  assert.equal(f.store.attempts('run').length, 1);
  const confirmed = args();
  const ready = await resume(confirmed);
  assert.equal(ready.state, 'history_handoff_ready');
  assert.deepEqual(await resume(confirmed), ready);
  assert.equal(f.store.planStates('run').A.integrationSha, undefined);
  assert.equal(f.store.planStates('run').A.candidate, undefined);
  assert.equal(f.starts.length, 1);
  status = 'inProgress';
  assert.equal((await resume()).reason, 'history_execution_mismatch');
  await assert.rejects(f.create('A'), /continuation decision/);
  status = 'interrupted';
  assert.equal((await resume()).state, 'history_handoff_ready');
  await f.call('stop_run');
  await f.call('resume_run');
  await assert.rejects(f.create('A'), /checkpoint changed/);
  assert.equal((await resume()).state, 'history_handoff_ready');
  commitFile(cwd, 'a.txt', 'changed after preparation');
  await assert.rejects(f.create('A'), /changed/);
  const refreshed = await resume();
  assert.equal(refreshed.state, 'history_handoff_ready');
  const next = await f.create('A');
  assert.notEqual(next.attemptId, source.attemptId);
  assert.notEqual(next.threadId, source.threadId);
  assert.equal(f.starts[1].cwd, cwd);
  assert.deepEqual(f.starts[1].historySource, { threadId: source.threadId, modelProvider: 'mock' });
  await assert.rejects(resume(), /attempt|cleanup/);
});

test('restart_keeps_pending_decisions_and_unknown_operations', async t => {
  let closed = false;
  const f = await planControllerFixture({ after(fn) { t.after(() => { if (!closed) fn(); }); } });
  const decision = await blockingConsultation(f, 'human');
  const form = (await f.call('answer_consultation', { decisionId: decision.id })).humanDecisionForm.form;
  const unknown = f.ref();
  f.store.prepareOperation(unknown, 'a'.repeat(64));
  f.store.operationState(unknown.operationId, 'sent_unknown');
  // Close and reopen the real writer, then use the newly started controller.
  f.store.close(); closed = true;
  const store = new Store(path.join(f.root, 'state'), f.repository);
  t.after(() => store.close());
  const controller = new McpController(store, new Broker(store, f.runtime), f.runtime, 'run', f.parent.actor, f.scope);
  const inbox = await controller.call('get_decisions', { runId: 'run', pendingOnly: true }, f.parent);
  assert.deepEqual(inbox.decisions.map((item: any) => item.decision.id), [decision.id]);
  assert.equal(store.coordinationDecision('run', decision.id)?.formGeneration, null);
  assert.doesNotMatch(JSON.stringify(inbox), new RegExp(form.formGeneration));
  assert.equal(store.operation(unknown.operationId).state, 'sent_unknown');
  const newParent = { ...f.parent, actor: { ...f.parent.actor, ownerEpoch: 'new-epoch' } };
  const newController = new McpController(store, new Broker(store, f.runtime), f.runtime, 'run', newParent.actor, { ...f.scope, windowBindingId: 'reopened-window' });
  await assert.rejects(newController.call('start_run', { planPath: f.planPath, operationId: 'rebind' }, newParent), /reconciliation/);
  await assert.rejects(controller.call('resume_run', { runId: 'run', operationId: 'resume', expectedRevision: store.run('run').revision }, f.parent), /reconciliation/);
  assert.equal(store.run('run').state, 'needs_reconcile');
  assert.equal(f.starts.length, 0);
});

test('window_lease_restart_does_not_reuse_a_suspended_consultation_form', async t => {
  const f = await planControllerFixture(t);
  const decision = await blockingConsultation(f, 'human');
  const old = (await f.call('answer_consultation', { decisionId: decision.id })).humanDecisionForm.form;
  await f.broker.leaseLost('run');
  await f.call('resume_run');
  await assert.rejects(f.controller.humanResponse({ decision: old, answer: { optionId: 'resume' } }, f.parent), /stale decision form/);
  const inbox = await f.controller.call('get_decisions', { runId: 'run', pendingOnly: true }, f.parent);
  assert.equal(inbox.decisions[0].decision.id, decision.id);
  const fresh = (await f.call('answer_consultation', { decisionId: decision.id })).humanDecisionForm.form;
  assert.notEqual(fresh.formGeneration, old.formGeneration);
  assert.deepEqual(await f.controller.humanResponse({ decision: fresh, answer: { optionId: 'resume' } }, f.parent), { state: 'resolved', decisionId: decision.id });
});

test('chat_discussion_does_not_forge_authorization', async t => {
  const f = await planControllerFixture(t);
  const expectedPlanHash = f.store.plan('run')!.snapshot.planHash;
  const input = { expectedPlanHash, tasks: [{ id: 'A', completion: ['changed'] }], reason: 'The human agreed in chat.', alternatives: ['Keep the current check.'], recommendation: 'Use the replacement.' };
  const change = await f.call('propose_plan_change', input);
  const apply = { decisionId: change.id, expectedPlanHash, proposedPlanHash: change.proposedPlanHash };
  await assert.rejects(f.call('apply_plan_change', { ...apply, humanApproved: true }));
  await assert.rejects(f.call('answer_consultation', { decisionId: change.id, answer: { optionId: 'approve' } }), /recipient/);
  const first = (await f.call('answer_consultation', { decisionId: change.id })).humanDecisionForm.form;
  const current = (await f.call('answer_consultation', { decisionId: change.id })).humanDecisionForm.form;
  await assert.rejects(f.controller.humanResponse({ decision: first, answer: { optionId: 'approve' } }, f.parent));
  await assert.rejects(f.controller.humanResponse({ decision: { ...current, proposalHash: 'f'.repeat(64) }, answer: { optionId: 'approve' } }, f.parent));
  const response = await f.controller.humanResponse({ decision: current, answer: { optionId: 'approve', text: 'Change a different acceptance case.' } }, f.parent) as { state: string };
  assert.equal(response.state, 'superseded');
  await assert.rejects(f.call('apply_plan_change', apply), /agreement/);
  const denial = await f.call('propose_plan_change', input);
  const form = (await f.call('answer_consultation', { decisionId: denial.id })).humanDecisionForm.form;
  await f.controller.humanResponse({ decision: form, answer: { optionId: 'decline' } }, f.parent);
  await assert.rejects(f.call('apply_plan_change', { ...apply, decisionId: denial.id }), /agreement/);
  const cancelled = await f.call('propose_plan_change', input);
  const server = createMcpServer((name, args) => f.controller.call(name, args, f.parent), undefined,
    (ref, answer) => f.controller.humanResponse({ decision: ref, answer }, f.parent));
  const client = new Client({ name: 'simulated-plan-change-UI', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  t.after(async () => { await client.close(); await server.close(); });
  client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
    assert.match(params.message, /"test".*"changed"/);
    return { action: 'accept', content: { optionId: 'approve' } };
  });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(left), server.connect(right)]);
  const available = (await client.listTools()).tools.map(tool => tool.name);
  assert(available.includes('propose_plan_change') && available.includes('apply_plan_change'));
  const responseFromForm = await client.callTool({ name: 'answer_consultation', arguments: { ...f.ref(), decisionId: cancelled.id } });
  assert.deepEqual(responseFromForm.structuredContent, { state: 'resolved', decisionId: cancelled.id });
  assert.doesNotMatch(JSON.stringify(responseFromForm), /formGeneration|humanDecisionForm/);
  assert.equal((await f.call('answer_consultation', { decisionId: cancelled.id, close: 'cancelled' })).state, 'cancelled');
  assert.deepEqual(f.store.coordinationDecision('run', cancelled.id)?.answer, { optionId: 'approve' });
  await assert.rejects(f.call('apply_plan_change', { ...apply, decisionId: cancelled.id }), /agreement/);
  assert.equal(f.store.plan('run')!.snapshot.planHash, expectedPlanHash);
});

test('permission_permit_is_run_bound_and_not_a_coordinator_tool_argument', async t => {
  const f = fixture(t); await f.activate();
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('injected-permit'), taskId: 'A', permissionPermit: { allowedProfileIds: ['full-access'], writableRoots: [f.scope.repositoryPath], allowedReviewers: ['user'] } }, f.parent));
  assert.equal(f.starts(), 0);
  Object.assign(f.scope, { permissionPermit: { allowedProfileIds: ['workspace'], writableRoots: [f.scope.repositoryPath], allowedReviewers: ['auto_review'] } });
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('changed-permit'), taskId: 'A' }, f.parent));
  assert.equal(f.starts(), 0);
});

const proposal = { taskIds: ['A'], blockingTaskIds: [], kind: 'consultation', recipient: 'coordinator', planHash: 'a'.repeat(64), question: '既定範囲で続けてよいか', options: [{ id: 'yes', label: '続行', description: '既定仕様のまま進める' }], allowFreeText: true };

const parallelCoordination = (t: Parameters<typeof planControllerFixture>[0]) => planControllerFixture(t, f => {
  f.plan.run.max_parallel = 2; f.plan.tasks[1].depends_on = [];
  f.plan.tasks.push({ ...f.plan.tasks[0], id: 'C', scope: ['c.txt'], depends_on: [] });
});
async function blockingConsultation(f: Awaited<ReturnType<typeof parallelCoordination>>, recipient = 'coordinator') {
  return f.call('propose_decision', { proposal: { ...proposal, recipient, blockingTaskIds: ['A'], planHash: f.store.plan('run')!.snapshot.planHash,
    options: [{ id: 'resume', label: '現在の計画で再開', description: '権限・仕様を追加せず続行' }, { id: 'deny', label: '保留を続ける', description: '再開しない' }] } });
}

test('consultation_answer_does_not_resume_before_safe_parking', async t => {
  const f = await parallelCoordination(t), a = await f.create('A'), b = await f.create('B'), decision = await blockingConsultation(f);
  let finish!: (value: any) => void, started!: () => void, stops = 0;
  const entered = new Promise<void>(resolve => started = resolve);
  t.mock.method(f.runtime, 'stop', async () => { stops++; started(); return new Promise(resolve => finish = resolve); });
  const args = { ...f.ref(), taskId: 'A', decisionId: decision.id };
  const holding = f.controller.call('hold_task', args, f.parent);
  await Promise.race([entered, holding.then(() => { throw new Error('parking did not start'); })]);
  const duplicate = f.controller.call('hold_task', args, f.parent);
  await f.call('answer_consultation', { decisionId: decision.id, answer: { optionId: 'resume' } });
  assert.deepEqual(f.store.taskHolds('run', 'A'), []);
  await assert.rejects(f.call('resume_task', { taskId: 'A', resolvedDecisionId: decision.id }));
  await assert.rejects(f.create('C'));
  assert.equal(f.store.attempts('run').filter(row => !['completed', 'stopped'].includes(row.state)).length, 2);
  finish({ worker: a, state: 'stopped', evidenceRefs: ['confirmed'] });
  assert.equal((await holding).releasedExecutionSlot, true); assert.deepEqual(await duplicate, await holding); assert.equal(stops, 1);
  assert.equal(f.store.attempts('run').find(row => row.id === b.attemptId)!.state, 'idle');
  const resume = { ...f.ref(), taskId: 'A', resolvedDecisionId: decision.id };
  assert.equal((await f.controller.call('resume_task', resume, f.parent)).state, 'resume_ready');
  const next = await f.create('A'); assert.notEqual(next.attemptId, a.attemptId);
  const revision = f.store.run('run').revision;
  assert.deepEqual(await f.controller.call('hold_task', args, f.parent), await holding);
  assert.equal((await f.controller.call('resume_task', resume, f.parent)).state, 'resume_ready');
  assert.equal(stops, 1); assert.equal(f.store.run('run').revision, revision);
  assert.equal(f.store.planStates('run').A.attemptId, next.attemptId);
});

test('cancelled_or_superseded_consultation_never_resumes_held_work', async t => {
  for (const outcome of ['cancelled', 'superseded', 'deny', 'amended'] as const) {
    const f = await parallelCoordination(t), a = await f.create('A'), decision = await blockingConsultation(f, 'human');
    const dirty = path.join(f.store.gitAssignment(a.attemptId)!.cwd, 'draft.txt'); writeFileSync(dirty, 'preserve');
    await f.call('hold_task', { taskId: 'A', decisionId: decision.id });
    if (outcome === 'cancelled' || outcome === 'superseded') await f.call('answer_consultation', { decisionId: decision.id, close: outcome });
    else {
      const shown = await f.call('answer_consultation', { decisionId: decision.id });
      await f.controller.humanResponse({ decision: shown.humanDecisionForm.form, answer: outcome === 'deny' ? { optionId: 'deny' } : { optionId: 'resume', text: 'revised plan required' } }, f.parent);
    }
    assert.deepEqual(f.store.taskHolds('run', 'A'), []);
    await assert.rejects(f.call('resume_task', { taskId: 'A', resolvedDecisionId: decision.id }));
    await assert.rejects(f.create('A')); assert.equal(f.store.planStates('run').A.state, 'held');
    assert.equal(readFileSync(dirty, 'utf8'), 'preserve');
    const other = await blockingConsultation(f); assert.equal(f.store.coordinationDecision('run', other.id)!.decision.state, 'pending');
    f.plan.tasks[0].completion = ['new-plan']; f.savePlan();
    await assert.rejects(f.call('resume_task', { taskId: 'A', resolvedDecisionId: decision.id }));
    assert.equal(readFileSync(dirty, 'utf8'), 'preserve'); assert.equal(f.store.coordinationDecision('run', other.id)!.decision.state, 'pending');
  }
});

test('consultation_hold_answer_resume_keeps_independent_worker_running', async t => {
  const f = await parallelCoordination(t), a = await f.create('A'), b = await f.create('B');
  const decision = await blockingConsultation(f, 'human');
  const child = { actor: { ownerId: b.ownerId, ownerEpoch: b.ownerEpoch, threadId: b.threadId }, turnId: 'turn' };
  for (const [name, args] of [['hold_task', { taskId: 'A', decisionId: decision.id }], ['resume_task', { taskId: 'A', resolvedDecisionId: decision.id }]] as const) await assert.rejects(f.call(name, args, child));
  await f.call('hold_task', { taskId: 'A', decisionId: decision.id });
  await f.call('send_instruction', { taskId: 'B', target: b, agent: { model: 'mock', effort: 'low' }, text: 'continue independently' });
  const server = createMcpServer((name, args) => f.controller.call(name, args, f.parent), undefined,
    (form, answer) => f.controller.humanResponse({ decision: form, answer }, f.parent));
  const client = new Client({ name: 'simulated-hold-answer-UI', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { optionId: 'resume' } }));
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(left), server.connect(right)]);
    assert.equal((await client.callTool({ name: 'answer_consultation', arguments: { ...f.ref(), decisionId: decision.id } })).isError, undefined);
    assert.equal(f.starts.length, 2, 'answer must not start another attempt');
    assert.equal(f.store.planStates('run').A.state, 'held');
    assert((await client.listTools()).tools.some(tool => tool.name === 'hold_task'));
    assert.equal((await client.callTool({ name: 'resume_task', arguments: { ...f.ref(), taskId: 'A', resolvedDecisionId: decision.id } })).isError, undefined);
    const creation = { ...f.ref(), taskId: 'A' }, next = await f.controller.call('create_worker', creation, f.parent);
    assert.deepEqual(await f.controller.call('create_worker', creation, f.parent), next);
    assert.equal(f.starts.length, 3); assert.notEqual(next.attemptId, a.attemptId); assert.notEqual(next.threadId, a.threadId);
    assert.equal(f.store.gitAssignment(next.attemptId)!.cwd, f.store.gitAssignment(a.attemptId)!.cwd);
    await assert.rejects(f.call('send_instruction', { taskId: 'A', target: a, agent: { model: 'mock', effort: 'low' }, text: 'stale' }));
    assert.equal(f.store.attempts('run').find(row => row.id === b.attemptId)!.state, 'running'); assert.equal(f.store.run('run').state, 'active');
  } finally { await client.close(); await server.close(); }
});

test('hold_result_keeps_confirmed_cleanup_if_resume_wins_the_reply_race', async t => {
  const f = await parallelCoordination(t), a = await f.create('A'), decision = await blockingConsultation(f);
  const park = f.broker.parkTask.bind(f.broker);
  let next!: WorkerRef;
  t.mock.method(f.broker, 'parkTask', async (runId: string, worker: WorkerRef) => {
    const result = await park(runId, worker);
    await f.call('answer_consultation', { decisionId: decision.id, answer: { optionId: 'resume' } });
    await f.call('resume_task', { taskId: 'A', resolvedDecisionId: decision.id });
    next = await f.create('A');
    return result;
  });
  const args = { ...f.ref(), taskId: 'A', decisionId: decision.id };
  const result = await f.controller.call('hold_task', args, f.parent);
  assert.equal(result.releasedExecutionSlot, true);
  assert.notEqual(next.attemptId, a.attemptId); assert.equal(f.store.planStates('run').A.attemptId, next.attemptId);
  assert.deepEqual(await f.controller.call('hold_task', args, f.parent), result);
});

test('human_callback_checks_plan_file_before_any_status_refresh', async t => {
  const f = await planControllerFixture(t);
  const decision = await f.call('propose_decision', { proposal: { ...proposal, recipient: 'human', planHash: f.store.plan('run')!.snapshot.planHash } });
  const displayed = await f.call('answer_consultation', { decisionId: decision.id });
  f.plan.tasks[0].completion = ['changed-before-answer']; f.savePlan();
  assert.equal(f.store.plan('run')!.frozen, false, 'no status call has observed the changed file yet');
  await assert.rejects(f.controller.humanResponse({ decision: displayed.humanDecisionForm.form, answer: { optionId: 'yes' } }, f.parent));
  assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'pending');
  assert.equal(f.store.coordinationDecision('run', decision.id)?.answer, null);
});
async function coordinationFixture(t: { after(fn: () => void): void }) {
  const f = fixture(t); await f.activate();
  f.store.savePlan('run', { planHash: proposal.planHash, plan: { run: { max_parallel: 2 }, tasks: [{ id: 'A' }, { id: 'B' }] } } as PlanSnapshot, {} as RepositoryPin);
  return f;
}

test('consultation_tools_enforce_own_task_recipient_and_once_only_events', async t => {
  const f = await coordinationFixture(t);
  const worker = await f.controller.call('create_worker', { ...f.ref('worker'), taskId: 'A' }, f.parent);
  const actor = { actor: { ownerId: worker.ownerId, ownerEpoch: worker.ownerEpoch, threadId: worker.threadId }, turnId: 'turn' };
  const args = { ...f.ref('consultation'), proposal };
  const decision = await f.controller.call('propose_decision', args, actor);
  assert.deepEqual(await f.controller.call('propose_decision', args, actor), decision);
  assert.equal(f.store.events('run', 0, 100).filter(e => e.kind === 'decision_changed').length, 1);
  assert.equal((await f.controller.call('get_status', { runId: 'run' }, f.parent)).attempts[0].state, 'idle');
  await assert.rejects(f.controller.call('propose_decision', { ...f.ref('peer'), proposal: { ...proposal, taskIds: ['B'] } }, actor), /scope|peer/);
  await assert.rejects(f.controller.call('propose_decision', { ...f.ref('empty'), proposal: { ...proposal, taskIds: [] } }, actor), /scope/);
  await assert.rejects(f.controller.call('answer_consultation', { ...f.ref('worker-answer'), decisionId: decision.id, answer: { optionId: 'yes' } }, actor));
  await f.controller.call('answer_consultation', { ...f.ref('parent-answer'), decisionId: decision.id, answer: { optionId: 'yes' } }, f.parent);
  assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'resolved');
});

test('human_consultation_uses_non_tool_callback_and_keeps_peer_running', async t => {
  const f = await coordinationFixture(t);
  const b = await f.controller.call('create_worker', { ...f.ref('B'), taskId: 'B' }, f.parent);
  await f.controller.call('send_instruction', { ...f.ref('send-B'), taskId: 'B', target: b, agent: { model: 'mock', effort: 'low' }, text: 'work independently' }, f.parent);
  const decision = await f.controller.call('propose_decision', { ...f.ref('human'), proposal: { ...proposal, recipient: 'human' } }, f.parent);
  await assert.rejects(f.controller.call('answer_consultation', { ...f.ref('model-answer'), decisionId: decision.id, answer: { optionId: 'yes' } }, f.parent), /recipient/);
  const server = createMcpServer((name, args) => f.controller.call(name, args, f.parent), undefined,
    (form, answer) => f.controller.humanResponse({ decision: form, answer }, f.parent));
  const client = new Client({ name: 'simulated-consultation-UI', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  let shown!: () => void, respond!: (value: any) => void;
  const displayed = new Promise<void>(resolve => shown = resolve), response = new Promise<any>(resolve => respond = resolve);
  client.setRequestHandler(ElicitRequestSchema, async () => { shown(); return response; });
  const [a, c] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(c)]);
    const pending = client.callTool({ name: 'answer_consultation', arguments: { ...f.ref('form'), decisionId: decision.id } });
    await Promise.race([displayed, pending.then(result => { throw new Error(`Form was not displayed: ${JSON.stringify(result)}`); })]);
    assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'pending');
    assert.equal((await f.controller.call('get_status', { runId: 'run' }, f.parent)).attempts[0].state, 'running');
    respond({ action: 'accept', content: { optionId: 'yes' } });
    const result = await pending;
    assert.equal(result.isError, undefined);
    assert.doesNotMatch(JSON.stringify(result), /formGeneration|humanDecisionForm/);
    assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'resolved');
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert(tools.includes('get_decisions')); assert(!tools.includes('human_response'));
  } finally { respond({ action: 'cancel' }); await client.close(); await server.close(); }
});

test('decision_pages_are_bounded_and_worker_cannot_read_peer_answers', async t => {
  const f = await coordinationFixture(t);
  const worker = await f.controller.call('create_worker', { ...f.ref('A'), taskId: 'A' }, f.parent);
  for (let i = 0; i < 5; i++) await f.controller.call('propose_decision', { ...f.ref(`page-${i}`), proposal: { ...proposal, taskIds: i % 2 ? ['B'] : ['A'], question: 'x'.repeat(4096) } }, f.parent);
  let afterId: string | undefined, found = 0;
  do {
    const page = await f.controller.call('get_decisions', { runId: 'run', afterId, limit: 2 }, { actor: { ownerId: worker.ownerId, ownerEpoch: worker.ownerEpoch, threadId: worker.threadId }, turnId: 'turn' });
    assert(Buffer.byteLength(JSON.stringify(page)) < 90000);
    for (const item of page.decisions) { assert.deepEqual(item.decision.taskIds, ['A']); assert.equal(item.answer, null); found++; }
    assert.doesNotMatch(JSON.stringify(page), /formGeneration/);
    afterId = page.nextAfterId ?? undefined;
  } while (afterId);
  assert.equal(found, 3);
  await assert.rejects(f.controller.call('get_decisions', { runId: 'run', limit: 101 }, f.parent));
});

test('decision_forms_reject_old_generation_cancellation_plan_drift_and_worker_callbacks', async t => {
  const f = await coordinationFixture(t);
  const decision = await f.controller.call('propose_decision', { ...f.ref('human'), proposal: { ...proposal, recipient: 'human' } }, f.parent);
  const first = await f.controller.call('answer_consultation', { ...f.ref('first-form'), decisionId: decision.id }, f.parent);
  const second = await f.controller.call('answer_consultation', { ...f.ref('second-form'), decisionId: decision.id }, f.parent);
  await assert.rejects(f.controller.humanResponse({ decision: first.humanDecisionForm.form, answer: { optionId: 'yes' } }, f.parent));
  await assert.rejects(f.controller.humanResponse({ decision: second.humanDecisionForm.form, answer: { optionId: 'yes' } }, { actor: { ...f.parent.actor, ownerEpoch: 'forged' }, turnId: 'turn' }));
  await f.controller.call('answer_consultation', { ...f.ref('cancel'), decisionId: decision.id, close: 'cancelled' }, f.parent);
  await assert.rejects(f.controller.humanResponse({ decision: second.humanDecisionForm.form, answer: { optionId: 'yes' } }, f.parent));
  const other = await f.controller.call('propose_decision', { ...f.ref('other'), proposal: { ...proposal, recipient: 'human' } }, f.parent);
  const form = await f.controller.call('answer_consultation', { ...f.ref('old-plan'), decisionId: other.id }, f.parent);
  f.store.savePlan('run', { planHash: 'b'.repeat(64), plan: { run: { max_parallel: 2 }, tasks: [{ id: 'A' }] } } as PlanSnapshot, {} as RepositoryPin);
  await assert.rejects(f.controller.humanResponse({ decision: form.humanDecisionForm.form, answer: { optionId: 'yes' } }, f.parent));
  writeFileSync(f.scope.planPath, 'changed plan');
  assert.equal((await f.controller.call('answer_consultation', { ...f.ref('close-stale'), decisionId: other.id, close: 'superseded' }, f.parent)).state, 'superseded');
});

test('decision_callback_replay_and_presentation_retry_never_repeat_mutation_or_form', async t => {
  const f = await coordinationFixture(t);
  const decision = await f.controller.call('propose_decision', { ...f.ref('human'), proposal: { ...proposal, recipient: 'human' } }, f.parent);
  const args = { ...f.ref('display'), decisionId: decision.id };
  const shown = await f.controller.call('answer_consultation', args, f.parent);
  assert.equal((await f.controller.call('answer_consultation', args, f.parent)).humanDecisionForm, undefined);
  const callback = { decision: shown.humanDecisionForm.form, answer: { optionId: 'yes' } };
  const result = await f.controller.humanResponse(callback, f.parent), revision = f.store.run('run').revision;
  assert.deepEqual(await f.controller.humanResponse(callback, f.parent), result);
  assert.equal(f.store.run('run').revision, revision);
  await assert.rejects(f.controller.humanResponse({ ...callback, answer: { text: 'changed' } }, f.parent));
  const changes = f.store.events('run', 0, 100).filter(event => event.kind === 'decision_changed');
  assert.deepEqual(changes.map(event => event.transition), ['decision_proposed', 'decision_answered']);
});

test('multibyte_decision_and_answer_pages_respect_wire_byte_budget', async t => {
  const f = await coordinationFixture(t);
  for (let i = 0; i < 4; i++) {
    const decision = await f.controller.call('propose_decision', { ...f.ref(`large-${i}`), proposal: { ...proposal, question: 'あ'.repeat(2730), options: Array.from({ length: 4 }, (_, j) => ({ id: `choice-${j}`, label: '選択肢', description: 'x'.repeat(4096) })) } }, f.parent);
    await f.controller.call('answer_consultation', { ...f.ref(`answer-${i}`), decisionId: decision.id, answer: { text: 'い'.repeat(5460) } }, f.parent);
  }
  let afterId: string | undefined, found = 0;
  do {
    const page = await f.controller.call('get_decisions', { runId: 'run', afterId }, f.parent);
    assert(Buffer.byteLength(JSON.stringify(page)) < 81000);
    assert(page.decisions.length > 0 && page.decisions.length < 4);
    found += page.decisions.length; afterId = page.nextAfterId ?? undefined;
  } while (afterId);
  assert.equal(found, 4);
});

test('formal_elicitation_delivers_human_choice_without_exposing_response_tool', async () => {
  const item = { key: 'key', payloadHash: 'hash', formGeneration: 'generation', cwd: 'fixture', worker: { workerId: 'A', attemptId: 'attempt', threadId: 'thread' }, requestId: 7, turnId: 'turn', detail: 'scope: report only' };
  const replies: unknown[] = [];
  const server = createMcpServer(async () => ({ state: 'waiting_approval', humanForm: item }), async (ref, action) => { replies.push({ ref, action }); return { state: 'response_sent' }; });
  const client = new Client({ name: 'human-client', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    const text = request.params.message;
    assert.match(text, /^担当 A/); assert.match(text, /hash/);
    assert(text.indexOf('report only') < text.indexOf('照合情報'));
    assert.doesNotMatch(text, /"workerId"/);
    return { action: 'accept', content: {} };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(b), client.connect(a)]);
    const result = await client.callTool({ name: 'answer_request', arguments: { runId: 'run', operationId: 'op', expectedRevision: 0, requestKey: 'key' } });
    assert.equal(result.isError, undefined); assert.equal(replies.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /humanForm|generation/);
    assert(!(await client.listTools()).tools.some(t => t.name === 'human_response'));
  } finally { await client.close(); await server.close(); }
});

test('elicitation_timeout_keeps_source_pending', async () => {
  let replied = false;
  const server = createMcpServer(async () => ({ state: 'waiting_approval', humanForm: { detail: 'approval' } }), async () => { replied = true; });
  const client = await connectClient(server); // No elicitation capability.
  try {
    const result = await client.callTool({ name: 'answer_request', arguments: { runId: 'run', operationId: 'op', expectedRevision: 0, requestKey: 'key' } });
    assert.equal(replied, false); assert.match(JSON.stringify(result), /waiting_approval/); assert.doesNotMatch(JSON.stringify(result), /humanForm/);
  } finally { await client.close(); await server.close(); }
});
test('human_endpoint_checks_parent_hash_generation_scope_and_once_only', async t => {
  const f = fixture(t); await f.activate();
  const audit: { phase: string; route: string; action?: string }[] = [];
  const recordAudit = f.store.auditHumanRequest.bind(f.store);
  f.store.auditHumanRequest = (run, item, phase, route, action) => { recordAudit(run, item, phase, route, action); audit.push({ phase, route, action }); };
  const worker = await f.controller.call('create_worker', { ...f.ref('create'), taskId: 'A' }, f.parent);
  const inbox = new WorkerRequests(worker, f.scope.assignments[0].cwd);
  const item = inbox.add({ id: 7, method: 'mcpServer/elicitation/request', params: { threadId: worker.threadId, turnId: 'turn', serverName: 'meristem', mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'report' } } }, 'turn');
  let sent = 0;
  const runtime = { ...f.runtime, pendingRequests: () => inbox.list(), presentRequest: (_w: WorkerRef, key: string) => inbox.present(key), async answerRequest(_w: WorkerRef, ref: any, action: any, current: () => boolean) { assert(current()); inbox.answer(ref, action, () => sent++); } };
  const controller = new McpController(f.store, new Broker(f.store, runtime), runtime, 'run', f.parent.actor, f.scope);
  const pendingReport = { ...f.ref('approved-report'), taskId: 'A', report: { summary: 'approved original report' } };
  const result = await controller.call('answer_request', { ...f.ref('review'), requestKey: item.key }, f.parent);
  assert(result.humanForm); assert.doesNotMatch(f.store.operation('review').result!, /humanForm|formGeneration/);
  assert.deepEqual(audit, [{ phase: 'presentation_prepared', route: 'parent_mcp', action: undefined }]);
  const response = { worker, key: item.key, payloadHash: item.payloadHash, formGeneration: result.humanForm.formGeneration, action: 'accept' };
  await assert.rejects(controller.humanResponse(response, { actor: worker, turnId: 'turn' }));
  await assert.rejects(controller.humanResponse({ ...response, payloadHash: 'f'.repeat(64) }, f.parent));
  const traced = f.store.auditHumanRequest;
  f.store.auditHumanRequest = () => { throw new Error('audit unavailable'); };
  await assert.rejects(controller.humanResponse(response, f.parent), /audit unavailable/);
  assert.equal(sent, 0, 'do not send an approval whose response route cannot be recorded');
  f.store.auditHumanRequest = traced;
  await controller.humanResponse(response, f.parent);
  assert.deepEqual(audit.at(-1), { phase: 'response_received', route: 'parent_mcp', action: 'accept' });
  await assert.rejects(controller.humanResponse(response, f.parent)); assert.equal(sent, 1);
  await controller.call('report', pendingReport, { actor: { ownerId: worker.ownerId, ownerEpoch: worker.ownerEpoch, threadId: worker.threadId }, turnId: 'turn' });
  assert.equal(f.store.reportCount('run', worker.attemptId), 1, 'presenting approval must not invalidate the original report revision');
});

test('parent_answers_question_and_cannot_approve_human_request', async t => {
  const f = fixture(t); await f.activate();
  const worker = await f.controller.call('create_worker', { ...f.ref('create'), taskId: 'A' }, f.parent);
  const inbox = new WorkerRequests(worker, f.scope.assignments[0].cwd);
  const question = inbox.add({ id: 9, method: 'item/tool/requestUserInput', params: { threadId: worker.threadId, turnId: 'turn', itemId: 'q', questions: [{ id: 'format', question: 'Format?' }] } }, 'turn');
  let sent = 0;
  const runtime = { ...f.runtime, pendingRequests: () => inbox.list(), async answerQuestion(_worker: WorkerRef, key: string, answer: any, current: () => boolean) { assert(current()); inbox.answerQuestion(key, answer, (id, result) => { assert.equal(id, 9); assert.deepEqual(result, { answers: { format: { answers: ['JSON'] } } }); sent++; }); } };
  const controller = new McpController(f.store, new Broker(f.store, runtime), runtime, 'run', f.parent.actor, f.scope);
  const status = await controller.call('get_status', { runId: 'run' }, f.parent);
  assert.equal(status.requests[0].key, question.key);
  const args = { ...f.ref('answer'), requestKey: question.key, answer: { format: { answers: ['JSON'] } } };
  await controller.call('answer_request', args, f.parent); await controller.call('answer_request', args, f.parent); assert.equal(sent, 1);
  runtime.answerQuestion = async () => { throw new RequestFailure('failed', 'not_sent'); };
  await assert.rejects(controller.call('answer_request', { ...args, ...f.ref('not-sent') }, f.parent));
  assert.equal(f.store.operation('not-sent').state, 'cancelled');
  const human = inbox.add({ id: 10, method: 'item/commandExecution/requestApproval', params: { threadId: worker.threadId, turnId: 'turn' } }, 'turn');
  await assert.rejects(controller.call('answer_request', { ...f.ref('approve'), requestKey: human.key, answer: { decision: { answers: ['accept'] } } }, f.parent), /model cannot/);
  const child = { actor: worker, turnId: 'turn' };
  await assert.rejects(controller.call('answer_request', { ...f.ref('child-answer'), requestKey: question.key, answer: args.answer }, child));
});

test('closing_one_tab_allows_only_surviving_turn_MCP_consent_until_full_stop', async t => {
  const f = fixture(t); await f.activate();
  const a = await f.controller.call('create_worker', { ...f.ref('a'), taskId: 'A' }, f.parent);
  const b = await f.controller.call('create_worker', { ...f.ref('b'), taskId: 'B' }, f.parent);
  f.store.attemptState(a, 'running'); f.store.attemptState(b, 'running');
  const inboxes = [a, b].map((w, i) => new WorkerRequests(w, f.scope.assignments[i].cwd, () => {}, [f.scope.assignments[i].cwd]));
  const add = (i: number, id: number) => inboxes[i].add({ id, method: 'mcpServer/elicitation/request', params: { threadId: [a, b][i].threadId, turnId: 'turn', serverName: 'meristem', mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'report' } } }, 'turn');
  const stopped = add(0, 1), surviving = add(1, 1); let sent = 0;
  const runtime = { ...f.runtime, pendingRequests: () => inboxes.flatMap(i => i.list()), presentRequest: (w: WorkerRef, key: string) => inboxes[w.workerId === 'A' ? 0 : 1].present(key), async answerRequest(w: WorkerRef, ref: any, action: any, current: () => boolean) { assert(current()); inboxes[w.workerId === 'A' ? 0 : 1].answer(ref, action, () => sent++); } };
  const broker = new Broker(f.store, runtime), controller = new McpController(f.store, broker, runtime, 'run', f.parent.actor, f.scope);
  await broker.closeTerminal('run', JSON.parse(f.store.attempts('run').find(r => r.id === a.attemptId)!.registration).binding);
  assert.equal(broker.canWake('run'), false);
  await assert.rejects(broker.resumeRun('run'));
  assert.equal(broker.canReviewRequest('run', surviving), true, 'rejected resume preserves the surviving turn');
  assert.equal(new Broker(f.store, runtime).canReviewRequest('run', surviving), false, 'restart never restores consent authority');
  await assert.rejects(controller.call('answer_request', { ...f.ref('closed-form'), requestKey: stopped.key }, f.parent));
  const git = inboxes[1].add({ id: 2, method: 'item/permissions/requestApproval', params: { threadId: b.threadId, turnId: 'turn', itemId: 'git', cwd: f.scope.assignments[1].cwd, permissions: { network: null, fileSystem: { read: null, write: [f.scope.assignments[1].cwd] } } } }, 'turn');
  assert.equal(git.state, 'pending');
  await assert.rejects(controller.call('answer_request', { ...f.ref('git-form'), requestKey: git.key }, f.parent));
  const form = await controller.call('answer_request', { ...f.ref('surviving-form'), requestKey: surviving.key }, f.parent);
  await controller.humanResponse({ worker: b, key: surviving.key, payloadHash: surviving.payloadHash, formGeneration: form.humanForm.formGeneration, action: 'accept' }, f.parent);
  assert.equal(sent, 1);
  await controller.call('report', { ...f.ref('surviving-report'), taskId: 'B', report: { summary: 'current turn completed' } }, { actor: { ownerId: b.ownerId, ownerEpoch: b.ownerEpoch, threadId: b.threadId }, turnId: 'turn' });
  assert.equal(f.store.reportCount('run', b.attemptId), 1);
  const late = add(1, 3), lateForm = await controller.call('answer_request', { ...f.ref('late-form'), requestKey: late.key }, f.parent);
  await broker.stopRun('run');
  await assert.rejects(controller.humanResponse({ worker: b, key: late.key, payloadHash: late.payloadHash, formGeneration: lateForm.humanForm.formGeneration, action: 'accept' }, f.parent));
  assert.equal(sent, 1);
});

test('creation_failure_keeps_unknown_delivery_and_only_safe_diagnostic', async t => {
  const f = fixture(t); await f.activate();
  f.runtime.start = async () => { throw new RequestFailure('failed', 'rejected', 'mcpServerStatus/list', -32600, 'mcp_startup_pending'); };
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('failed-start'), taskId: 'A' }, f.parent));
  const operation = f.store.operation('failed-start');
  assert.equal(operation.state, 'sent_unknown');
  assert.equal(JSON.parse(operation.result!).creationFailure, 'mcp_startup_pending');
  assert.equal(f.store.run('run').state, 'stopped');
});

test('creation_failure_does_not_record_arbitrary_error_text', async t => {
  const f = fixture(t); await f.activate();
  f.runtime.start = async () => { throw new Error('secret arbitrary provider output'); };
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('failed-start'), taskId: 'A' }, f.parent));
  assert.deepEqual(JSON.parse(f.store.operation('failed-start').result!), { state: 'sent_unknown', creationFailure: 'unclassified' });
});

test('creation_diagnostic_write_failure_still_stops_run', async t => {
  const f = fixture(t); await f.activate();
  f.runtime.start = async () => { throw new Error('start failed'); };
  f.store.operationResult = () => { throw new Error('diagnostic write failed'); };
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('failed-start'), taskId: 'A' }, f.parent));
  assert.equal(f.store.run('run').state, 'stopped');
  assert.equal(f.store.operation('failed-start').state, 'sent_unknown');
});

function fixture(t: { after(fn: () => void): void }, limits: Partial<ExecutionLimits> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cc02-')), planPath = path.join(root, 'plan.md'); writeFileSync(planPath, 'fixture plan');
  const store = new Store(path.join(root, 'state'), process.cwd()); store.createRun('run'); t.after(() => store.close());
  const parent = { actor: { ownerId: 'parent-owner', ownerEpoch: 'epoch', threadId: 'P' }, turnId: 'p-turn' };
  const scope: FixtureScope = { fixture: true, planPath, repositoryId: 'repo', windowBindingId: 'window', ...gitScope(root) };
  let sends = 0, starts = 0;
  const runtime = {
    async start(assignment: any) { starts++; return { ...assignment.identity, threadId: assignment.previous?.threadId ?? `thread-${starts}` }; },
    registration() { return { hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job' }; },
    async send() { sends++; },
    async stop(worker: WorkerRef) { return { worker, state: 'stopped' as const, evidenceRefs: ['confirmed'] }; },
    async releaseCompleted(worker: WorkerRef) { return { worker, state: 'stopped' as const, evidenceRefs: ['confirmed'] }; }
  };
  const broker = new Broker(store, runtime, undefined, limits), controller = new McpController(store, broker, runtime, 'run', parent.actor, scope);
  const ref = (operationId: string) => ({ runId: 'run', operationId, expectedRevision: store.run('run').revision });
  const activate = async () => {
    const pending: any = await controller.call('start_run', { planPath, operationId: 'start' }, parent);
    controller.authorize(pending.bindingId);
    await controller.call('start_run', { planPath, operationId: 'start' }, parent);
  };
  return { controller, store, scope, parent, runtime, ref, activate, sends: () => sends, starts: () => starts };
}
test('unlimited_default_allows_more_than_two_corrections', async t => {
  const f = fixture(t); await f.activate();
  for (let i = 0; i < 5; i++) {
    const args = { ...f.ref('create-' + i), taskId: 'A' };
    const worker = await f.controller.call('create_worker', args, f.parent);
    await f.controller.call('create_worker', args, f.parent);
    f.store.saveStop('run', { worker, state: 'stopped', evidenceRefs: [] }, true);
  }
  assert.equal(f.starts(), 5); assert.equal(f.store.run('run').state, 'active');
});

test('explicit_correction_budget_reserves_before_start_and_counts_unknown_once', async t => {
  const f = fixture(t, { maxCorrectionsPerTask: 2 }); await f.activate();
  for (let i = 0; i < 2; i++) {
    const args = { ...f.ref('creation-' + i), taskId: 'A' }, worker = await f.controller.call('create_worker', args, f.parent);
    assert.deepEqual(await f.controller.call('create_worker', args, f.parent), worker);
    f.store.saveStop('run', { worker, state: 'stopped', evidenceRefs: [] }, true);
  }
  t.mock.method(f.runtime, 'start', async () => { assert.equal(f.store.correctionCount('run', 'A'), 2); throw new Error('ACK lost'); });
  const unknown = { ...f.ref('unknown-start'), taskId: 'A' };
  await assert.rejects(f.controller.call('create_worker', unknown, f.parent));
  assert.equal((await f.controller.call('create_worker', unknown, f.parent)).state, 'sent_unknown');
  assert.equal(f.store.correctionCount('run', 'A'), 2);
  assert.equal(f.store.run('run').state, 'stopped');
  const limited = fixture(t, { maxCorrectionsPerTask: 2 }); await limited.activate();
  for (let i = 0; i < 3; i++) { const worker = await limited.controller.call('create_worker', { ...limited.ref('creation-' + i), taskId: 'A' }, limited.parent); limited.store.saveStop('run', { worker, state: 'stopped', evidenceRefs: [] }, true); }
  await assert.rejects(limited.controller.call('create_worker', { ...limited.ref('exhausted'), taskId: 'A' }, limited.parent), /correction/);
  assert.equal(limited.starts(), 3); assert.equal(limited.store.run('run').state, 'stopped');
});

test('plan_execution_limits_apply_before_allocation_and_do_not_relax_config_bounds', async t => {
  const f = await planControllerFixture(t, f => {
    Object.assign(f.plan, { schema_version: 2 });
    Object.assign(f.plan.run, { execution_limits: { maxWakeTurns: 3, maxCorrectionsPerTask: 2 } });
    for (const task of f.plan.tasks) Object.assign(task.agent, { permissionProfileId: 'workspace' });
  });
  assert.deepEqual(f.broker.executionLimits('run'), { maxWakeTurns: 3, maxCorrectionsPerTask: 2 });
  const stricter = new Broker(f.store, f.runtime, undefined, { maxWakeTurns: 1, maxCorrectionsPerTask: 1 });
  assert.deepEqual(stricter.executionLimits('run'), { maxWakeTurns: 1, maxCorrectionsPerTask: 1 });
  for (let i = 0; i < 3; i++) {
    const a = await f.create('A'); await f.complete('A', a, 'revision-' + i);
    await f.call('record_decision', { taskId: 'A', decision: 'retry_same', evidenceRefs: [] });
  }
  const before = f.store.planStates('run').A, worktrees = spawnSync('git', ['-C', f.repository, 'worktree', 'list'], { encoding: 'utf8', windowsHide: true }).stdout;
  await assert.rejects(f.create('A'), /correction/);
  assert.deepEqual(f.store.planStates('run').A, before); assert.equal(spawnSync('git', ['-C', f.repository, 'worktree', 'list'], { encoding: 'utf8', windowsHide: true }).stdout, worktrees);
});

test('retire_one_worker_keeps_run_active_and_is_parent_only', async t => {
  const f = await parallelCoordination(t), a = await f.create('A'), b = await f.create('B');
  const dirty = path.join(f.store.gitAssignment(a.attemptId)!.cwd, 'draft.txt'); writeFileSync(dirty, 'preserve');
  const child = { actor: b, turnId: 'worker-turn' };
  await assert.rejects(f.call('retire_worker', { target: a }, child));
  const args = { ...f.ref(), target: a };
  assert.equal((await f.controller.call('retire_worker', args, f.parent)).state, 'stopped');
  assert.equal((await f.controller.call('retire_worker', args, f.parent)).state, 'stopped');
  const status = await f.status();
  assert.equal(status.run.state, 'active'); assert.equal(status.plan.tasks.A.state, 'retired');
  assert(!status.plan.eligible.includes('A')); assert(!status.plan.eligible.includes('B'));
  assert(status.plan.eligible.includes('C')); assert.equal(readFileSync(dirty, 'utf8'), 'preserve');
  assert.equal(f.store.attempts('run').find(row => row.id === b.attemptId)!.state, 'idle');
  await assert.rejects(f.call('send_instruction', { taskId: 'A', target: a, agent: { model: 'mock', effort: 'low' }, text: 'stale' }));
  await f.call('record_decision', { taskId: 'A', decision: 'handoff_new', evidenceRefs: [] });
  const next = await f.create('A'); assert.notEqual(next.attemptId, a.attemptId);
  await f.call('retire_worker', { target: a });
  assert.equal(f.store.attempts('run').find(row => row.id === next.attemptId)!.state, 'idle');
});
test('stop_fence_blocks_new_worker_before_database_stop', async t => {
  const f = fixture(t); await f.activate(); let release!: () => void;
  const broker = new Broker(f.store, f.runtime, () => new Promise<void>(resolve => { release = resolve; }));
  const controller = new McpController(f.store, broker, f.runtime, 'run', f.parent.actor, f.scope);
  const stopping = broker.stopRun('run');
  await assert.rejects(controller.call('create_worker', { ...f.ref('racing-create'), taskId: 'A' }, f.parent), /stopped/);
  assert.equal(f.starts(), 0); release(); await stopping;
});
test('run_permit_is_single_use_and_scope_bound', async t => {
  const f = fixture(t);
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('early'), taskId: 'A' }, f.parent), /permit/);
  await f.activate();
  const binding = f.store.binding('run'); assert.equal(binding.state, 'consumed');
  assert.throws(() => f.controller.authorize(binding.id), /pending/);
  await assert.rejects(f.controller.call('start_run', { planPath: f.scope.planPath, operationId: 'another' }, f.parent), /binding/);
  writeFileSync(f.scope.planPath, 'changed plan');
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('changed'), taskId: 'A' }, f.parent), /scope/);
  assert.equal(f.starts(), 0);
});
test('worker_cannot_control_peer_or_accept_result_or_bootstrap_parent', async t => {
  const f = fixture(t); await f.activate();
  const worker: any = await f.controller.call('create_worker', { ...f.ref('create'), taskId: 'A' }, f.parent);
  assert.equal((await f.controller.call('get_status', { runId: 'run' }, f.parent)).attempts[0].state, 'idle');
  await f.controller.call('send_instruction', { ...f.ref('instruction'), taskId: 'A', target: worker, agent: { model: 'mock', effort: 'low' }, text: 'work' }, f.parent);
  const child = { actor: { ownerId: worker.ownerId, ownerEpoch: worker.ownerEpoch, threadId: worker.threadId }, turnId: 'turn' };
  for (const tool of ['create_worker', 'send_instruction', 'stop_run', 'resume_run', 'record_decision', 'start_run']) {
    await assert.rejects(f.controller.call(tool, { ...f.ref(tool), taskId: 'B' }, child));
  }
  await assert.rejects(f.controller.call('report', { ...f.ref('sub'), taskId: 'A', report: { summary: 'fake' } }, { ...child, actor: { ...child.actor, threadId: 'subagent' } }), /registered/);
  await f.controller.call('report', { ...f.ref('report'), taskId: 'A', report: { summary: 'done' } }, child);
  const status: any = await f.controller.call('get_status', { runId: 'run' }, f.parent);
  assert.equal(status.reports[0].report.summary, 'done'); assert.equal(status.attempts[0].state, 'running');
});
test('unknown_attempt_is_not_replayed_and_cross_repo_or_cross_window_is_rejected', async t => {
  const f = fixture(t); await f.activate();
  f.scope.assignments[0].repositoryId = 'other';
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('cross-repo'), taskId: 'A' }, f.parent), /scope/);
  f.scope.assignments[0].repositoryId = 'repo'; f.scope.windowBindingId = 'other-window';
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('cross-window'), taskId: 'A' }, f.parent), /scope/);
  assert.equal(f.starts(), 0);
});
test('create_and_instruction_retries_use_recorded_results_without_replay', async t => {
  const f = fixture(t); await f.activate();
  const creation = { ...f.ref('create'), taskId: 'A' };
  const worker: any = await f.controller.call('create_worker', creation, f.parent);
  assert.deepEqual(await f.controller.call('create_worker', creation, f.parent), worker); assert.equal(f.starts(), 1);
  const instruction = { ...f.ref('send'), taskId: 'A', target: worker, agent: { model: 'mock.1', effort: 'low' }, text: 'hello' };
  await f.controller.call('send_instruction', instruction, f.parent);
  await f.controller.call('send_instruction', instruction, f.parent); assert.equal(f.sends(), 1);
  await assert.rejects(f.controller.call('send_instruction', { ...instruction, text: 'changed' }, f.parent), /payload/);
  const ref = f.ref('unknown'); f.store.prepareOperation(ref, 'a'.repeat(64)); f.store.operationState(ref.operationId, 'sent_unknown');
  await f.controller.call('stop_run', f.ref('stop'), f.parent);
  await assert.rejects(f.controller.call('resume_run', f.ref('resume'), f.parent), /reconciliation/);
});

test('stale_parallel_report_is_distinguished_from_unknown_rejection_and_can_refresh_revision', async t => {
  const f = fixture(t); await f.activate();
  const a = await f.controller.call('create_worker', { ...f.ref('a'), taskId: 'A' }, f.parent);
  const b = await f.controller.call('create_worker', { ...f.ref('b'), taskId: 'B' }, f.parent);
  const identity = (w: WorkerRef) => ({ actor: { ownerId: w.ownerId, ownerEpoch: w.ownerEpoch, threadId: w.threadId }, turnId: 'turn' });
  const stale = { ...f.ref('b-report'), taskId: 'B', report: { summary: 'B done' } };
  await f.controller.call('report', { ...f.ref('a-report'), taskId: 'A', report: { summary: 'A done' } }, identity(a));
  const server = createMcpServer((name, args) => f.controller.call(name, args, identity(b)));
  const client = await connectClient(server); t.after(async () => { await client.close(); await server.close(); });
  const rejected = await client.callTool({ name: 'report', arguments: stale });
  assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected), /stale_revision/); assert.match(JSON.stringify(rejected), /not_applied/);
  assert.equal(f.store.reportCount('run', b.attemptId), 0); assert.throws(() => f.store.operation('b-report'));
  const saved = await client.callTool({ name: 'report', arguments: { ...stale, ...f.ref('b-report-refreshed') } });
  assert.equal(saved.isError, undefined); assert.equal(f.store.reportCount('run', b.attemptId), 1);
});
test('official_MCP_metadata_and_strict_arguments_cannot_supply_role', async t => {
  const f = fixture(t);
  const server = createMcpServer(async (name, args, metadata) => {
    if ((metadata as any)?.['x-codex-turn-metadata']?.thread_id !== 'P' || (metadata as any)?.['x-codex-turn-metadata']?.turn_id !== 'p-turn') throw new Error('identity');
    return f.controller.call(name, args, f.parent);
  });
  const client = await connectClient(server); t.after(() => { void client.close(); });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert(names.includes('answer_request'));
  const args = { planPath: f.scope.planPath, operationId: 'start' };
  assert.equal((await client.callTool({ name: 'start_run', arguments: args })).isError, true);
  assert.equal((await client.callTool({ name: 'start_run', arguments: { ...args, role: 'parent' }, _meta: { 'x-codex-turn-metadata': { thread_id: 'P', turn_id: 'p-turn' } } })).isError, true);
  const result = await client.callTool({ name: 'start_run', arguments: args, _meta: { 'x-codex-turn-metadata': { thread_id: 'P', turn_id: 'p-turn' } } });
  assert.equal((result.structuredContent as any).state, 'awaiting_authorization');
});
test('restart_requires_new_human_binding_before_explicit_resume', async t => {
  const f = fixture(t); await f.activate(); const old = f.store.binding('run').id;
  f.store.stopRun('run', true);
  const parent = { ...f.parent, actor: { ...f.parent.actor, ownerEpoch: 'new-epoch' } }, scope = { ...f.scope, windowBindingId: 'new-window' };
  const controller = new McpController(f.store, new Broker(f.store, f.runtime), f.runtime, 'run', parent.actor, scope);
  const input = { planPath: scope.planPath, operationId: 'rebind' };
  const pending: any = await controller.call('start_run', input, parent);
  assert.notEqual(pending.bindingId, old); assert.equal(pending.state, 'awaiting_authorization');
  await assert.rejects(controller.call('resume_run', f.ref('too-early'), parent), /permit/);
  controller.authorize(pending.bindingId); await controller.call('start_run', input, parent);
  await controller.call('resume_run', f.ref('resume'), parent); assert.equal(f.store.run('run').state, 'active');
  assert.throws(() => controller.authorize(old), /binding/);
});
test('status_paginates_valid_reports_without_losing_saved_records', async t => {
  const f = fixture(t); await f.activate(); const worker: any = await f.controller.call('create_worker', { ...f.ref('create'), taskId: 'A' }, f.parent);
  const child = { actor: { ownerId: worker.ownerId, ownerEpoch: worker.ownerEpoch, threadId: worker.threadId }, turnId: 'turn' };
  for (let i = 0; i < 34; i++) await f.controller.call('report', { ...f.ref(`report-${i}`), taskId: 'A', report: { summary: 'x'.repeat(8000) } }, child);
  let count = 0, offset: number | null = 0;
  do {
    const status = await f.controller.call('get_status', { runId: 'run', reportOffset: offset }, f.parent);
    assert(Buffer.byteLength(JSON.stringify(status)) < 200000); count += status.reports.length; offset = status.nextReportOffset;
  } while (offset !== null);
  assert.equal(count, 34);
});
test('actual_branch_drift_blocks_delivery_but_preserves_status_and_stop', async t => {
  const f = fixture(t); await f.activate();
  assert.equal(spawnSync('git', ['switch', '-c', 'unexpected'], { cwd: f.scope.assignments[0].cwd, windowsHide: true }).status, 0);
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('create'), taskId: 'A' }, f.parent), /scope/);
  assert.equal((await f.controller.call('get_status', { runId: 'run' }, f.parent)).scopeValid, false);
  await f.controller.call('stop_run', f.ref('stop'), f.parent); assert.equal(f.store.run('run').state, 'stopped');
});
test('instruction_budget_is_durable_and_retry_does_not_consume_another_slot', async t => {
  const f = fixture(t); f.scope.maxInstructions = 1; await f.activate();
  const worker: any = await f.controller.call('create_worker', { ...f.ref('create'), taskId: 'A' }, f.parent);
  const instruction = { ...f.ref('send'), taskId: 'A', target: worker, agent: { model: 'mock', effort: 'low' }, text: 'one' };
  await f.controller.call('send_instruction', instruction, f.parent); await f.controller.call('send_instruction', instruction, f.parent);
  await assert.rejects(f.controller.call('send_instruction', { ...instruction, ...f.ref('two') }, f.parent), /budget/); assert.equal(f.sends(), 1);
});
test('multibyte_report_pages_remain_retrievable_within_native_byte_limit', async t => {
  const f = fixture(t); await f.activate(); const worker: any = await f.controller.call('create_worker', { ...f.ref('create'), taskId: 'A' }, f.parent);
  const child = { actor: { ownerId: worker.ownerId, ownerEpoch: worker.ownerEpoch, threadId: worker.threadId }, turnId: 'turn' };
  for (let i = 0; i < 4; i++) await f.controller.call('report', { ...f.ref(`report-${i}`), taskId: 'A', report: { summary: 'あ'.repeat(8192), evidenceRefs: Array(32).fill('あ'.repeat(330)) } }, child);
  let offset: number | null = 0, count = 0;
  do { const result = await f.controller.call('get_status', { runId: 'run', reportOffset: offset }, f.parent); assert(Buffer.byteLength(JSON.stringify(result)) < 200000); count += result.reports.length; offset = result.nextReportOffset; } while (offset !== null);
  assert.equal(count, 4);
});
test('terminal_snapshot_keeps_old_live_attempt_when_peer_has_many_completed_attempts', async t => {
  const f = fixture(t); await f.activate();
  const a: any = await f.controller.call('create_worker', { ...f.ref('A'), taskId: 'A' }, f.parent);
  const b: any = await f.controller.call('create_worker', { ...f.ref('B'), taskId: 'B' }, f.parent);
  const registration = JSON.parse(f.store.attempts('run').find(row => row.id === b.attemptId)!.registration);
  await new Broker(f.store, f.runtime).releaseCompleted('run', b);
  // Historical rows can predate the correction limit; the display must retain live attempts.
  for (let i = 0; i < 5; i++) {
    const worker = { ...b, attemptId: `old-B-${i}` };
    f.store.register({ ...registration, assignmentId: `old-assignment-${i}`, worker, binding: { ...registration.binding, worker } });
    f.store.saveStop('run', { worker, state: 'stopped', evidenceRefs: [] }, true);
  }
  const visible = f.store.displayAttempts('run'); assert(visible.some(row => row.id === a.attemptId)); assert.equal(visible.length, 4);
});

test('many_worker_requests_remain_paged_within_status_frame_limit', async t => {
  const f = fixture(t); await f.activate();
  Object.assign(f.runtime, { pendingRequests: () => Array.from({ length: 128 }, (_, i) => ({ key: `request-${i}`, detail: '長'.repeat(4000), worker: { attemptId: `attempt-${i}` } })) });
  let offset: number | null = 0, count = 0;
  do {
    const page: any = await f.controller.call('get_status', { runId: 'run', requestOffset: offset }, f.parent);
    assert(Buffer.byteLength(JSON.stringify(page)) < 262144); assert(page.requests.length > 0);
    count += page.requests.length; offset = page.nextRequestOffset;
  } while (offset !== null);
  assert.equal(count, 128);
});

test('combined_status_pages_fit_the_broker_response_budget_and_each_cursor_can_progress', async t => {
  const f = fixture(t); await f.activate();
  const worker = { workerId: 'A', attemptId: 'a', ownerId: 'owner', ownerEpoch: 'epoch', threadId: 'thread' };
  t.mock.method(f.store, 'attempts', () => Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, run_id: 'run', cwd: 'x', state: 'running', completed_turn_id: null, stop_result: null,
    registration: JSON.stringify({ worker: { ...worker, attemptId: `a${i}` }, taskId: 'A', cwd: 'x'.repeat(4096), branch: 'b'.repeat(512), model: 'm'.repeat(128), effort: 'low' }) })));
  t.mock.method(f.store, 'reports', () => [{ payload: 'x'.repeat(59000) }]);
  t.mock.method(f.store, 'reportCount', () => 1);
  t.mock.method(f.store, 'events', () => Array.from({ length: 100 }, (_, seq) => ({ seq, kind: 'k'.repeat(128), attempt_id: 'a'.repeat(128) })));
  Object.assign(f.runtime, { pendingRequests: () => [{ key: 'request', detail: 'x'.repeat(79000), worker }] });
  const initial = await f.controller.call('get_status', { runId: 'run' }, f.parent);
  assert(Buffer.byteLength(JSON.stringify(initial)) < 180000);
  const reports = await f.controller.call('get_status', { runId: 'run', reportOffset: 0 }, f.parent);
  assert.equal(reports.reports.length, 1); assert(Buffer.byteLength(JSON.stringify(reports)) < 180000);
  const requests = await f.controller.call('get_status', { runId: 'run', requestOffset: 0 }, f.parent);
  assert.equal(requests.requests.length, 1); assert(Buffer.byteLength(JSON.stringify(requests)) < 180000);
});
