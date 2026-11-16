import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WorkerRequests } from '../src/requests.js';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

export function stateDirectory() { return mkdtempSync(path.join(tmpdir(), 'meristem-cc01-')); }
test('deduplicates_operations_and_rejects_changed_payload', t => {
  const store = new Store(stateDirectory(), process.cwd()); t.after(() => store.close());
  store.createRun('run');
  const ref = { operationId: 'op', runId: 'run', expectedRevision: 0 };
  assert.equal(store.prepareOperation(ref, 'a'.repeat(64)).fresh, true);
  assert.equal(store.prepareOperation(ref, 'a'.repeat(64)).fresh, false);
  assert.throws(() => store.prepareOperation(ref, 'b'.repeat(64)), /payload/);
  assert.throws(() => store.prepareOperation({ ...ref, operationId: 'other' }, 'a'.repeat(64)), /revision/);
  assert.equal(store.run('run').revision, 1);
});
test('request_audit_survives_restart_without_payload_or_reusable_forms', () => {
  const dir = stateDirectory(); let store = new Store(dir, process.cwd()); store.createRun('run');
  const worker = { workerId: 'A', attemptId: 'attempt', ownerId: 'owner', ownerEpoch: 'epoch', threadId: 'thread' };
  store.register({ worker, runId: 'run', taskId: 'A', assignmentId: 'assignment', repositoryId: 'repo', cwd: mkdtempSync(path.join(tmpdir(), 'cc04-work-')), branch: 'fixture', model: 'mock', effort: 'low', hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job', binding: { windowBindingId: 'window', terminalId: 'terminal', worker } });
  const inbox = new WorkerRequests(worker, 'fixture', item => store.saveRequest('run', item));
  store.prepareOperation({ operationId: 'question-report', runId: 'run', expectedRevision: 0 }, 'b'.repeat(64));
  store.saveReport({ operationId: 'question-report', runId: 'run', expectedRevision: 0 }, worker, 'turn', { summary: 'Need input', question: 'Which format?' });
  assert.equal(store.hasFinalReport('run', worker.attemptId), false);
  store.prepareOperation({ operationId: 'final-report', runId: 'run', expectedRevision: 1 }, 'c'.repeat(64));
  store.saveReport({ operationId: 'final-report', runId: 'run', expectedRevision: 1 }, worker, 'turn', { summary: 'Done' });
  store.completedTurn(worker, 'next-turn'); assert.equal(store.hasFinalReport('run', worker.attemptId), false);
  store.completedTurn(worker, 'turn'); assert.equal(store.hasFinalReport('run', worker.attemptId), true);
  const item = inbox.add({ id: 5, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{ id: 'q', question: 'secret body' }] } }, 'turn');
  assert.equal(store.requests('run')[0].state, 'pending'); store.close();
  store = new Store(dir, process.cwd());
  try { assert.equal(store.requests('run')[0].state, 'cancelled'); assert.equal(store.requests('run')[0].key, item.key); assert.doesNotMatch(JSON.stringify(store.requests('run')), /secret body/); }
  finally { store.close(); }
});

test('human_request_trace_preserves_transitions_and_routes_without_payload', t => {
  const dir = stateDirectory(), store = new Store(dir, process.cwd()); t.after(() => store.close());
  store.createRun('run');
  const worker = { workerId: 'B', attemptId: 'attempt', ownerId: 'owner', ownerEpoch: 'epoch', threadId: 'thread' };
  store.register({ worker, runId: 'run', taskId: 'B', assignmentId: 'assignment', repositoryId: 'repo', cwd: mkdtempSync(path.join(tmpdir(), 'cc04-work-')), branch: 'fixture', model: 'mock', effort: 'low', hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job', binding: { windowBindingId: 'window', terminalId: 'terminal', worker } });
  const inbox = new WorkerRequests(worker, 'fixture', item => store.saveRequest('run', item));
  const item = inbox.add({ id: 2, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: 'turn', serverName: 'meristem', mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'report', tool_params: { report: { summary: 'private report body' } } } } }, 'turn');
  const form = inbox.present(item.key);
  store.auditHumanRequest('run', form, 'response_received', 'parent_mcp', 'accept');
  inbox.answer(form, 'accept', () => {}); inbox.resolved('thread', 2);
  const text = readFileSync(path.join(dir, 'human-requests.jsonl'), 'utf8');
  const trace = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(trace.map(row => row.phase), ['pending', 'pending', 'response_received', 'replied', 'resolved']);
  assert.equal(trace[2].route, 'parent_mcp'); assert.equal(trace[2].action, 'accept');
  assert.equal(trace[0].formGeneration, item.formGeneration); assert.equal(trace[1].formGeneration, form.formGeneration);
  assert(trace.every(row => row.requestKey === item.key && row.worker.attemptId === 'attempt' && row.payloadHash === item.payloadHash && Number.isSafeInteger(row.at)));
  assert.doesNotMatch(text, /private report body|tool_params|detail/);
});
test('restart_preserves_unknown_without_resend_and_requires_reconciliation', () => {
  const dir = stateDirectory(); let store = new Store(dir, process.cwd());
  store.createRun('run');
  store.prepareOperation({ operationId: 'op', runId: 'run', expectedRevision: 0 }, 'a'.repeat(64));
  store.operationState('op', 'sent_unknown'); store.close();
  store = new Store(dir, process.cwd());
  try {
    assert.equal(store.run('run').state, 'needs_reconcile');
    assert.equal(store.operation('op').state, 'sent_unknown');
    assert.equal(store.prepareOperation({ operationId: 'op', runId: 'run', expectedRevision: 0 }, 'a'.repeat(64)).fresh, false);
  } finally { store.close(); }
});
test('unknown_schema_and_second_writer_are_rejected', () => {
  const dir = stateDirectory(), first = new Store(dir, process.cwd());
  assert.throws(() => new Store(dir, process.cwd()), /writer/); first.close();
  const db = new DatabaseSync(path.join(dir, 'control.sqlite')); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new Store(dir, process.cwd()), /schema/);
});
test('auth_payload_is_not_persisted_or_rendered', t => {
  const dir = stateDirectory(), store = new Store(dir, process.cwd()); t.after(() => store.close());
  store.createRun('run');
  assert.throws(() => store.appendEvent({ runId: 'run', kind: 'authentication', payload: 'Bearer secret-value' } as never));
  store.appendEvent({ runId: 'run', kind: 'waiting_approval' });
  assert.equal(JSON.stringify(store.events('run', 0, 100)).includes('secret-value'), false);
  assert.equal(readFileSync(path.join(dir, 'control.sqlite')).includes(Buffer.from('secret-value')), false);
});
test('management_state_cannot_be_created_inside_worktree', () => {
  assert.throws(() => new Store(path.join(process.cwd(), '.local', 'unsafe-state'), process.cwd()), /outside/);
});
