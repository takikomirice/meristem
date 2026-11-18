import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WorkerRequests } from '../src/requests.js';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

export function stateDirectory() { return mkdtempSync(path.join(tmpdir(), 'meristem-cc01-')); }
test('a terminal starts at its own registration and distinguishes later consultations', t => {
  const store = new Store(stateDirectory(), process.cwd()); t.after(() => store.close());
  store.createRun('run');
  store.appendEvent({ runId: 'run', kind: 'decision_proposed' }, 'parallelism');
  store.appendEvent({ runId: 'run', kind: 'registered', attemptId: 'new' });
  store.appendEvent({ runId: 'run', kind: 'running', attemptId: 'peer' });
  store.appendEvent({ runId: 'run', kind: 'decision_proposed' }, 'plan_change');
  const page = store.events('run', 0, 2, 'new');
  assert.deepEqual(page.map(e => e.kind), ['registered', 'decision_changed']);
  assert.equal(page[1].decisionKind, 'plan_change');
  assert.equal(store.events('run', 0, 1)[0].decisionKind, 'parallelism');
  assert.deepEqual(store.events('run', Number(page[1].seq), 2, 'new'), []);
});
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

test('coordination_migration_preserves_v5_state', () => {
  const directory = stateDirectory(), db = new DatabaseSync(path.join(directory, 'control.sqlite'));
  for (const name of ['001-control', '002-mcp', '003-wake', '004-requests', '005-plan']) {
    db.exec(readFileSync(path.join(process.cwd(), 'migrations', `${name}.sql`), 'utf8'));
  }
  db.exec(`INSERT INTO runs(id,state) VALUES('run','completed');
    INSERT INTO tasks VALUES('A','run','completed');
    INSERT INTO assignments VALUES('assignment','A','run');
    INSERT INTO actors VALUES('attempt','owner','epoch','thread');
    INSERT INTO attempts(id,run_id,assignment_id,registration,cwd,state,stop_result) VALUES('attempt','run','assignment','{}','fixture','completed','{"state":"stopped","evidenceRefs":["proof"]}');
    INSERT INTO operations VALUES('report','run','hash',0,'settled','{}');
    INSERT INTO reports VALUES('report','run','attempt','turn','{"summary":"保存済み報告"}');
    INSERT INTO plan_task_state VALUES('run','A','{"state":"candidate_ready","candidate":{"candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}');`);
  const tables = ['reports', 'attempts', 'plan_task_state', 'operations'];
  const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()); db.close();
  for (let pass = 0; pass < 2; pass++) {
    const store = new Store(directory, process.cwd()); store.close();
    const migrated = new DatabaseSync(path.join(directory, 'control.sqlite'));
    assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, 6);
    assert.deepEqual(tables.map(table => migrated.prepare(`SELECT * FROM ${table}`).all()), before);
    migrated.close();
  }
});

test('native_terminal_status_pages_keep_128_workers_inside_existing_frames', t => {
  const store = new Store(stateDirectory(), process.cwd()); t.after(() => store.close()); store.createRun('run');
  const rows = Array.from({ length: 128 }, (_, i) => {
    const worker = { workerId: `T${i}-${'x'.repeat(120)}`, attemptId: `attempt-${i}`, threadId: `thread-${i}`, ownerId: 'owner', ownerEpoch: 'epoch' };
    return { id: worker.attemptId, run_id: 'run', cwd: 'C:/' + '長'.repeat(240), state: 'running', completed_turn_id: null, stop_result: null,
      registration: JSON.stringify({ worker, taskId: worker.workerId, cwd: 'C:/' + '長'.repeat(240), branch: 'b'.repeat(180), model: 'mock', effort: 'low', binding: { worker, windowBindingId: 'window', terminalId: `terminal-${i}` } }) };
  });
  t.mock.method(store, 'displayAttempts', () => rows);
  const found: string[] = []; let offset: number | null = 0;
  do {
    const page: any = (store as any).terminalSnapshot('run', offset);
    assert(Buffer.byteLength(JSON.stringify(page)) < 262144); assert(page.attempts.length <= 4);
    found.push(...page.attempts.map((row: any) => row.registration.worker.attemptId)); offset = page.nextAttemptOffset;
  } while (offset !== null);
  assert.equal(new Set(found).size, 128);
  for (const invalid of [-1, 1.5, NaN]) assert.throws(() => (store as any).terminalSnapshot('run', invalid));
});

test('exact_terminal_status_retains_older_completed_attempts_and_their_names', t => {
  const directory = stateDirectory(), cwd = stateDirectory();
  const store = new Store(directory, process.cwd());
  t.after(() => store.close());
  store.createRun('run');
  for (let index = 0; index < 5; index++) {
    const worker = { workerId: 'A', attemptId: `attempt-${index}`, ownerId: 'owner', ownerEpoch: 'epoch', threadId: `thread-${index}` };
    store.register({ worker, runId: 'run', taskId: 'A', assignmentId: `assignment-${index}`, repositoryId: 'repo', cwd, branch: 'fixture', model: 'mock', effort: 'low',
      hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job',
      binding: { windowBindingId: 'window', terminalId: `terminal-${index}`, worker } });
    if (index === 0) store.renameWorker('run', worker, '初代担当');
    store.saveStop('run', { worker, state: 'stopped', evidenceRefs: ['confirmed'] }, true);
  }
  const list = store.terminalSnapshot('run', 0, undefined, { registrationOnly: true });
  assert.equal(list.attempts.length, 4);
  assert.ok(list.attempts.every(row => row.registration.worker.attemptId !== 'attempt-0' && !row.presentation));
  const retained = store.terminalSnapshot('run', 0, 'attempt-0').attempts[0];
  assert.equal(retained.presentation?.displayName, '初代担当');
  assert.equal(retained.state, 'completed');
  assert.deepEqual(store.terminalSnapshot('run', 0, 'unregistered').attempts, []);
});
