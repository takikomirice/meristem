import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { DecisionService } from '../src/decisions.js';
import type { OperationRef } from '../src/contracts.js';
import type { PlanSnapshot } from '../src/plan.js';
import type { RepositoryPin } from '../src/git-evidence.js';
import { WorkerRequests } from '../src/requests.js';
import { elicitDecision } from '../src/requests.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'mc01-'));
  const store = new Store(directory, process.cwd());
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  t.after(close);
  store.createRun('run'); store.createRun('other');
  store.savePlan('run', { planHash: 'a'.repeat(64), plan: { tasks: [{ id: 'A' }] } } as PlanSnapshot, {} as RepositoryPin);
  const contexts = new Map<object, OperationRef>();
  const service = new DecisionService(store, () => {}, context => contexts.get(context as object));
  let sequence = 0;
  const ref = (): OperationRef => ({ runId: 'run', operationId: `op-${sequence++}`, expectedRevision: store.run('run').revision });
  const human = () => { const context = {}; contexts.set(context, ref()); return context; };
  const input = { taskIds: ['A'], blockingTaskIds: ['A'], kind: 'consultation' as const, recipient: 'human' as const, planHash: 'a'.repeat(64), question: '方針を選択', options: [{ id: 'yes', label: 'はい', description: '続行' }], allowFreeText: true };
  return { store, service, ref, human, input, contexts, directory, close };
}

test('decision_resolution_is_current_and_once_only', t => {
  const f = fixture(t), decision = f.service.propose(f.ref(), f.input);
  const form = f.service.present(f.ref(), decision.id);
  for (const field of ['planHash', 'proposalHash', 'formGeneration'] as const) {
    assert.throws(() => f.service.resolveHuman({ ...form, [field]: 'b'.repeat(64) }, { optionId: 'yes' }, f.human()));
  }
  const foreign = {}; f.contexts.set(foreign, { ...f.ref(), runId: 'other', expectedRevision: 0 });
  assert.throws(() => f.service.resolveHuman(form, { optionId: 'yes' }, foreign));
  assert.throws(() => f.service.resolveHuman(form, { optionId: 'yes' }, { humanApproved: true }));
  assert.throws(() => f.service.resolveCoordinator(f.ref(), decision.id, { optionId: 'yes' }));
  assert.throws(() => f.service.resolveHuman(form, { optionId: 'missing' }, f.human()));
  const context = f.human();
  const result = f.service.resolveHuman(form, { optionId: 'yes' }, context);
  assert.equal(result.state, 'resolved');
  const revision = f.store.run('run').revision;
  assert.deepEqual(f.service.resolveHuman(form, { optionId: 'yes' }, context), result);
  assert.equal(f.store.run('run').revision, revision);
  assert.throws(() => f.service.resolveHuman(form, { text: 'changed' }, context));
  assert.throws(() => f.service.resolveHuman(form, { optionId: 'yes' }, f.human()));
  assert.deepEqual(f.store.coordinationDecision('run', decision.id)?.answer, { optionId: 'yes' });
});

test('forms_rotate_and_plan_changes_cancel_authority_without_losing_decisions', t => {
  const f = fixture(t), decision = f.service.propose(f.ref(), f.input);
  const first = f.service.present(f.ref(), decision.id), second = f.service.present(f.ref(), decision.id);
  assert.notEqual(first.formGeneration, second.formGeneration);
  assert.throws(() => f.service.resolveHuman(first, { text: 'stale' }, f.human()));
  f.store.freezePlan('run');
  assert.throws(() => f.service.resolveHuman(second, { text: 'stale' }, f.human()));
  assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'pending');
});

test('coordination_mutations_rollback_and_terminal_states_do_not_reopen', t => {
  const f = fixture(t), ref = f.ref();
  assert.throws(() => f.service.propose(ref, { ...f.input, taskIds: ['missing'], blockingTaskIds: [] }));
  assert.equal(f.store.run('run').revision, 0);
  assert.throws(() => f.store.operation(ref.operationId));
  const decision = f.service.propose(ref, { ...f.input, recipient: 'coordinator' });
  assert.equal(f.service.resolveCoordinator(f.ref(), decision.id, { text: '続行' }).state, 'resolved');
  assert.throws(() => f.service.close(f.ref(), decision.id, 'cancelled'));
  const pending = f.service.propose(f.ref(), f.input);
  assert.equal(f.service.close(f.ref(), pending.id, 'superseded').state, 'superseded');
  assert.throws(() => f.service.present(f.ref(), pending.id));
});

test('holds_approvals_revisions_and_pending_decisions_survive_restart', t => {
  const f = fixture(t);
  const pending = f.service.propose(f.ref(), f.input);
  f.store.saveTaskHold('run', { taskId: 'A', decisionId: pending.id, releasedExecutionSlot: false });
  f.service.present(f.ref(), pending.id);
  const approval = f.service.propose(f.ref(), { ...f.input, kind: 'parallelism', requestedMaximum: 4, options: [{ id: 'approve', label: 'Approve', description: 'Four workers' }] });
  assert.throws(() => f.store.saveParallelismApproval('run', approval.id, 4));
  f.service.resolveHuman(f.service.present(f.ref(), approval.id), { optionId: 'approve' }, f.human());
  f.store.saveParallelismApproval('run', approval.id, 4);
  assert.throws(() => f.store.saveParallelismApproval('other', approval.id, 4));
  const draft = { ...f.store.plan('run')!.snapshot, planHash: 'b'.repeat(64) };
  const change = f.service.propose(f.ref(), { ...f.input, kind: 'plan_change', proposedPlanHash: draft.planHash, options: [{ id: 'approve', label: 'Approve', description: 'Apply the displayed change' }] }, draft);
  assert.throws(() => f.store.saveCoordinationRevision('run', change.id, draft.planHash));
  f.service.resolveHuman(f.service.present(f.ref(), change.id), { optionId: 'approve' }, f.human());
  assert.throws(() => f.store.saveCoordinationRevision('run', change.id, 'c'.repeat(64)));
  f.store.saveCoordinationRevision('run', change.id, draft.planHash);
  f.close();
  const reopened = new Store(f.directory, process.cwd());
  try {
    assert.equal(reopened.coordinationDecision('run', pending.id)?.decision.state, 'pending');
    assert.equal(reopened.coordinationDecision('run', pending.id)?.formGeneration, null);
    assert.deepEqual(reopened.taskHolds('run', 'A'), [{ taskId: 'A', decisionId: pending.id, releasedExecutionSlot: false }]);
    assert.deepEqual(reopened.parallelismApproval('run'), { decisionId: approval.id, maximum: 4 });
    assert.deepEqual(reopened.coordinationRevision('run', change.id), { previousPlanHash: 'a'.repeat(64), proposedPlanHash: 'b'.repeat(64) });
    assert.equal(reopened.coordinationDecisions('run', '', 1).length, 1);
    assert.throws(() => reopened.coordinationDecisions('run', '', 101));
  } finally { reopened.close(); }
});

test('trusted_human_verifier_receives_exact_form_and_answer', t => {
  const f = fixture(t), decision = f.service.propose(f.ref(), f.input);
  const form = f.service.present(f.ref(), decision.id), answer = { optionId: 'yes' };
  const context = {}, ref = f.ref();
  const service = new DecisionService(f.store, () => {}, (...args: unknown[]) => {
    assert.deepEqual(args, [context, form, answer]);
    return ref;
  });
  assert.equal(service.resolveHuman(form, answer, context).state, 'resolved');
});

test('consultation_does_not_resolve_permission_rpc', t => {
  const f = fixture(t);
  const worker = { ownerId: 'owner', ownerEpoch: 'epoch', threadId: 'thread', workerId: 'A', attemptId: 'attempt' };
  const requests = new WorkerRequests(worker, f.directory, () => {}, [f.directory]);
  const permission = requests.add({ id: 'permission', method: 'item/permissions/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', cwd: f.directory, permissions: { network: null, fileSystem: { read: null, write: [f.directory] } } } }, 'turn');
  assert.equal(permission.state, 'pending');
  const before = requests.list();
  const decision = f.service.propose(f.ref(), { ...f.input, recipient: 'coordinator', blockingTaskIds: [] });
  f.service.resolveCoordinator(f.ref(), decision.id, { text: '既定の範囲で続行' });
  assert.deepEqual(requests.list(), before);
  assert.equal(requests.blocking, true);
  assert.throws(() => requests.answerQuestion(permission.key, { reply: { answers: ['続行'] } }, () => assert.fail('permission RPC must remain unresolved')));
});

test('coordinator_cannot_answer_human_decision', t => {
  const f = fixture(t);
  for (const kind of ['consultation', 'parallelism', 'plan_change'] as const) {
    const decision = f.service.propose(f.ref(), { ...f.input, kind, ...(kind === 'parallelism' ? { requestedMaximum: 4, options: [{ id: 'approve', label: 'Approve', description: 'Four workers' }] } : {}) });
    assert.throws(() => f.service.resolveCoordinator(f.ref(), decision.id, { optionId: 'yes' }), /recipient/);
    assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'pending');
    if (kind !== 'consultation') assert.throws(() => f.service.propose(f.ref(), { ...f.input, kind, recipient: 'coordinator', ...(kind === 'parallelism' ? { requestedMaximum: 4, options: [{ id: 'approve', label: 'Approve', description: 'Four workers' }] } : {}) }), /human/);
  }
});

test('multiple_decisions_keep_answers_separate', t => {
  const f = fixture(t);
  const first = f.service.propose(f.ref(), f.input), second = f.service.propose(f.ref(), { ...f.input, question: '別の相談' });
  const a = f.service.present(f.ref(), first.id), b = f.service.present(f.ref(), second.id);
  assert.throws(() => f.service.resolveHuman({ ...a, decisionId: second.id }, { optionId: 'yes' }, f.human()), /stale/);
  f.service.resolveHuman(b, { optionId: 'yes' }, f.human());
  assert.equal(f.store.coordinationDecision('run', first.id)?.answer, null);
  assert.equal(f.store.coordinationDecision('run', first.id)?.decision.state, 'pending');
  assert.equal(f.service.resolveHuman(a, { optionId: 'yes' }, f.human()).id, first.id);
  assert.equal(f.store.coordinationDecisions('other').length, 0);
});

test('stale_answer_after_plan_change_is_not_applied', t => {
  const f = fixture(t), decision = f.service.propose(f.ref(), f.input), form = f.service.present(f.ref(), decision.id);
  f.store.savePlan('run', { planHash: 'b'.repeat(64), plan: { tasks: [{ id: 'A' }] } } as PlanSnapshot, {} as RepositoryPin);
  const revision = f.store.run('run').revision;
  assert.throws(() => f.service.resolveHuman(form, { optionId: 'yes' }, f.human()), /stale/);
  assert.equal(f.store.run('run').revision, revision);
  assert.equal(f.store.coordinationDecision('run', decision.id)?.answer, null);
});

test('free_text_revision_creates_pending_proposal_without_approving_original', t => {
  const f = fixture(t);
  for (const optionId of [undefined, 'yes']) {
    const decision = f.service.propose(f.ref(), f.input), form = f.service.present(f.ref(), decision.id);
    const answer = { ...(optionId ? { optionId } : {}), text: 'この修正案を再確認' }, context = f.human();
    const proposed = f.service.resolveHuman(form, answer, context);
    assert.notEqual(proposed.id, decision.id);
    assert.notEqual(proposed.proposalHash, decision.proposalHash);
    assert.equal(proposed.question, answer.text);
    assert.equal(proposed.state, 'pending');
    assert.equal(proposed.planHash, decision.planHash);
    assert.deepEqual(proposed.blockingTaskIds, decision.blockingTaskIds);
    assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'superseded');
    assert.deepEqual(f.store.coordinationDecision('run', decision.id)?.answer, answer);
    assert.throws(() => f.store.saveParallelismApproval('run', proposed.id, 4));
    assert.deepEqual(f.service.resolveHuman(form, answer, context), proposed, 'retry creates no second proposal');
    assert.throws(() => f.service.resolveHuman(form, { optionId: 'yes' }, f.human()));
    const confirmation = f.service.present(f.ref(), proposed.id);
    assert.equal(f.service.resolveHuman(confirmation, { optionId: 'yes' }, f.human()).state, 'resolved');
  }
});

test('open_consultation_accepts_free_text_and_revision_validation_rolls_back', t => {
  const f = fixture(t), open = f.service.propose(f.ref(), { ...f.input, options: [] });
  assert.equal(f.service.resolveHuman(f.service.present(f.ref(), open.id), { text: '情報への回答' }, f.human()).state, 'resolved');
  const decision = f.service.propose(f.ref(), f.input), form = f.service.present(f.ref(), decision.id), revision = f.store.run('run').revision;
  assert.throws(() => f.service.resolveHuman(form, { text: 'x'.repeat(4097) }, f.human()));
  assert.equal(f.store.run('run').revision, revision);
  assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'pending');
  assert.equal(f.store.coordinationDecision('run', decision.id)?.answer, null);
});

test('cancelled_or_silent_form_remains_unapproved', { timeout: 10000 }, async t => {
  for (const action of ['cancel', 'decline', 'silent', 'disconnect', 'accept', 'revision'] as const) await t.test(action, async t => {
    const f = fixture(t), decision = f.service.propose(f.ref(), f.input), form = f.service.present(f.ref(), decision.id);
    const server = new McpServer({ name: 'mc03a-fixture', version: '0' });
    const client = new Client({ name: 'simulated-person-not-live-evidence', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    let shown!: () => void, respond!: (answer: ElicitResult) => void;
    const displayed = new Promise<void>(resolve => shown = resolve), response = new Promise<ElicitResult>(resolve => respond = resolve);
    client.setRequestHandler(ElicitRequestSchema, async request => {
      assert.equal(request.params.mode, 'form');
      if (request.params.mode === 'form') assert.deepEqual(request.params.requestedSchema.properties.optionId, { type: 'string', title: '選択', enum: ['yes'] });
      shown(); return response;
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(a), server.connect(b)]);
      const pending = elicitDecision(decision, request => server.server.elicitInput(request, { timeout: action === 'silent' ? 100 : 2000 }));
      await displayed;
      assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'pending');
      if (action === 'disconnect') await client.close();
      else if (action !== 'silent') respond({ action: action === 'revision' || action === 'accept' ? 'accept' : action, content: action === 'revision' ? { text: '新しい修正案' } : { optionId: 'yes' } });
      const answer = await pending;
      const result = answer ? f.service.resolveHuman(form, answer, f.human()) : undefined;
      if (action === 'accept') assert.equal(result?.state, 'resolved');
      else if (action === 'revision') { assert.equal(result?.state, 'pending'); assert.notEqual(result?.id, decision.id); }
      else {
        assert.equal(result, undefined);
        assert.equal(f.store.coordinationDecision('run', decision.id)?.decision.state, 'pending');
        assert.equal(f.store.coordinationDecision('run', decision.id)?.answer, null);
      }
      assert.equal(f.store.parallelismApproval('run'), undefined);
    } finally { respond({ action: 'cancel' }); await client.close(); await server.close(); }
  });
});

test('restart_and_terminal_decisions_reject_delayed_human_forms', t => {
  const f = fixture(t), decision = f.service.propose(f.ref(), f.input), form = f.service.present(f.ref(), decision.id);
  f.close();
  const reopened = new Store(f.directory, process.cwd());
  try {
    reopened.resumeRun('run');
    let sequence = 0;
    const ref = () => ({ runId: 'run', operationId: `after-restart-${sequence++}`, expectedRevision: reopened.run('run').revision });
    const service = new DecisionService(reopened, () => {}, () => ref());
    assert.throws(() => service.resolveHuman(form, { optionId: 'yes' }, {}), /stale/);
    assert.equal(reopened.coordinationDecision('run', decision.id)?.decision.state, 'pending');
    const fresh = service.present(ref(), decision.id);
    service.close(ref(), decision.id, 'cancelled');
    assert.throws(() => service.resolveHuman(fresh, { optionId: 'yes' }, {}), /not pending/);
  } finally { reopened.close(); }
});

test('parallelism_payload_is_bound_to_the_hash_and_grants_only_the_approved_maximum', t => {
  const f = fixture(t);
  const input = { ...f.input, kind: 'parallelism' as const, requestedMaximum: 4, options: [{ id: 'approve', label: 'Approve', description: 'Four workers' }, { id: 'deny', label: 'Deny', description: 'Keep two' }] };
  for (const requestedMaximum of [undefined, 0, -1, 1.5, 129, NaN]) assert.throws(() => f.service.propose(f.ref(), { ...input, requestedMaximum }));
  const first = f.service.propose(f.ref(), input), form = f.service.present(f.ref(), first.id);
  const second = f.service.propose(f.ref(), { ...input, requestedMaximum: 3 });
  assert.notEqual(first.proposalHash, second.proposalHash);
  assert.throws(() => f.service.resolveHuman({ ...form, decisionId: second.id }, { optionId: 'approve' }, f.human()));
  assert.throws(() => f.service.resolveHuman(form, { optionId: 'approve' }, f.human()));
  f.service.resolveHuman(f.service.present(f.ref(), second.id), { optionId: 'approve' }, f.human());
  assert.equal(f.store.effectiveParallelLimit('run'), 3);
  assert.throws(() => f.store.saveParallelismApproval('run', first.id, 5));
  assert.equal(f.store.effectiveParallelLimit('other'), 2);
  const denied = f.service.propose(f.ref(), input);
  f.service.resolveHuman(f.service.present(f.ref(), denied.id), { optionId: 'deny' }, f.human());
  assert.equal(f.store.effectiveParallelLimit('run'), 3);
  f.store.freezePlan('run'); assert.equal(f.store.effectiveParallelLimit('run'), 2);
});

test('new_parallelism_proposal_invalidates_old_pending_answer', t => {
  const f = fixture(t), proposal = { ...f.input, kind: 'parallelism' as const, requestedMaximum: 4, options: [{ id: 'approve', label: 'Approve', description: 'Ceiling' }] };
  const first = f.service.propose(f.ref(), proposal), form = f.service.present(f.ref(), first.id);
  f.service.propose(f.ref(), { ...proposal, requestedMaximum: 3 });
  assert.throws(() => f.service.resolveHuman(form, { optionId: 'approve' }, f.human()));
  assert.equal(f.store.effectiveParallelLimit('run'), 2);
});
