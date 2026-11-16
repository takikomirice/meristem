import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Broker } from '../src/broker.js';
import { McpController, createMcpServer, type FixtureScope } from '../src/mcp.js';
import type { WorkerRef } from '../src/contracts.js';
import { connectClient } from './fixtures/mcp-client.js';
import { gitScope } from './fixtures/git-scope.js';
import { spawnSync } from 'node:child_process';
import { RequestFailure } from '../src/failures.js';
import { WorkerRequests } from '../src/requests.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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

function fixture(t: { after(fn: () => void): void }) {
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
  const broker = new Broker(store, runtime), controller = new McpController(store, broker, runtime, 'run', parent.actor, scope);
  const ref = (operationId: string) => ({ runId: 'run', operationId, expectedRevision: store.run('run').revision });
  const activate = async () => {
    const pending: any = await controller.call('start_run', { planPath, operationId: 'start' }, parent);
    controller.authorize(pending.bindingId);
    await controller.call('start_run', { planPath, operationId: 'start' }, parent);
  };
  return { controller, store, scope, parent, runtime, ref, activate, sends: () => sends, starts: () => starts };
}
test('third_correction_stops_run_and_duplicate_decision_does_not_consume_budget', async t => {
  const f = fixture(t); await f.activate();
  for (let i = 0; i < 3; i++) {
    const args = { ...f.ref('create-' + i), taskId: 'A' };
    const worker = await f.controller.call('create_worker', args, f.parent);
    await f.controller.call('create_worker', args, f.parent);
    f.store.saveStop('run', { worker, state: 'stopped', evidenceRefs: [] }, true);
  }
  await assert.rejects(f.controller.call('create_worker', { ...f.ref('third'), taskId: 'A' }, f.parent), /correction/);
  assert.equal(f.store.run('run').state, 'stopped');
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
