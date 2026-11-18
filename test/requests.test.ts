import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkerRequests } from '../src/requests.js';
import { decisionForm, elicitDecision } from '../src/requests.js';
import type { Decision } from '../src/contracts.js';
import { mkdtempSync, mkdirSync, renameSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMcpServer } from '../src/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const worker = { ownerId: 'owner', ownerEpoch: 'epoch', threadId: 'thread', workerId: 'A', attemptId: 'attempt' };

test('auto_review_denial_is_not_parent_overridable', () => {
  for (const before of [true, false]) {
    const inbox = new WorkerRequests(worker, process.cwd());
    const message = { id: 'approval', method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', serverName: 'meristem', mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'report' } } };
    const deny = () => (inbox as any).autoReviewCompleted({ threadId: 'thread', turnId: 'turn', targetItemId: 'item', review: { status: 'denied' } });
    if (before) deny();
    const item = inbox.add(message, 'turn');
    if (!before) deny();
    assert.equal(inbox.list()[0].state, 'unsupported');
    let sent = false;
    assert.throws(() => inbox.answer(item, 'accept', () => { sent = true; })); assert.equal(sent, false);
  }
});

test('human_only_consent_stays_human_only', () => {
  const inbox = new WorkerRequests(worker, process.cwd());
  const item = inbox.add({ id: 'consent', method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: 'turn', itemId: 'consent', mode: 'openai/userVerification' } }, 'turn');
  assert.equal(item.kind, 'authentication'); assert.equal(item.state, 'unsupported');
  assert.throws(() => inbox.answer(item, 'accept', () => assert.fail('must not send consent')));
});

test('auto_review_denial_blocks_real_MCP_forms_without_item_id_and_null_targets', () => {
  for (const before of [true, false]) for (const targetItemId of ['tool-call', null]) {
    const inbox = new WorkerRequests(worker, process.cwd());
    const form = { id: 'real-mcp', method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: 'turn', serverName: 'meristem', mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'report' } } };
    const deny = () => inbox.autoReviewCompleted({ threadId: 'thread', turnId: 'turn', targetItemId, review: { status: 'denied' }, action: { type: 'mcpToolCall', server: 'meristem', toolName: 'report', connectorId: null, connectorName: null, toolTitle: null } });
    if (before) deny();
    const item = inbox.add(form, 'turn');
    if (!before) deny();
    assert.equal(inbox.list()[0].state, 'unsupported');
    assert.throws(() => inbox.answer(item, 'accept', () => assert.fail('must not override denial')));
  }
});
const request = () => ({ id: 7, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: 'turn', serverName: 'meristem', mode: 'form', message: 'Report approval', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'meristem', tool_name: 'report', tool_params: { report: { summary: 'A token' } } } } });
const question = () => ({ id: 'question-7', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'choice', header: 'Choice', question: 'Which format?', isOther: true, isSecret: false, options: [{ label: 'JSON', description: 'Structured' }] }] } });

const consultation: Decision = { id: 'consultation', runId: 'run', taskIds: ['A'], blockingTaskIds: [], kind: 'consultation', recipient: 'human', planHash: 'a'.repeat(64), proposalHash: 'b'.repeat(64), state: 'pending', question: '形式を選択', options: [{ id: 'json', label: 'JSON', description: '互換性を維持' }, { id: 'text', label: 'Text', description: '読みやすい形式' }], allowFreeText: true };

test('consultation_form_preserves_choices_and_explains_revision_semantics', () => {
  const build = decisionForm;
  const form = build(consultation);
  assert.equal(form.mode, 'form');
  assert.match(form.message, /形式を選択/); assert.match(form.message, /JSON.*互換性/);
  assert.deepEqual((form.requestedSchema.properties.optionId as { enum: string[] }).enum, ['json', 'text']);
  assert.match(form.requestedSchema.properties.text.title ?? '', /修正案/);
  assert.match(form.message, /未承認/);
  assert.deepEqual(form.requestedSchema.required, []);
  const fixed = build({ ...consultation, allowFreeText: false });
  assert.equal(fixed.requestedSchema.properties.text, undefined);
  assert.deepEqual(fixed.requestedSchema.required, ['optionId']);
  const open = build({ ...consultation, options: [] });
  assert.equal(open.requestedSchema.properties.optionId, undefined);
  assert.match(open.requestedSchema.properties.text.title ?? '', /回答/);
  assert.deepEqual(open.requestedSchema.required, ['text']);
  for (const change of [{ recipient: 'coordinator' as const }, { state: 'resolved' as const }, { options: [], allowFreeText: false }]) assert.throws(() => build({ ...consultation, ...change }));
});

test('consultation_form_validates_answers_without_formal_approval_fields', async () => {
  const elicit = elicitDecision;
  assert.deepEqual(await elicit(consultation, async () => ({ action: 'accept', content: { optionId: 'json', text: '' } })), { optionId: 'json' });
  assert.deepEqual(await elicit(consultation, async () => ({ action: 'accept', content: { text: ' 修正案 ' } })), { text: '修正案' });
  const empty: Array<Record<string, string>> = [{}, { text: '  ' }];
  for (const content of empty) assert.equal(await elicit(consultation, async () => ({ action: 'accept', content })), undefined);
  const invalid: Array<Record<string, string | boolean | number>> = [{ optionId: 'missing' }, { optionId: 'json', humanApproved: true }, { text: 'x'.repeat(4097) }, { text: 42 }];
  for (const content of invalid) await assert.rejects(elicit(consultation, async () => ({ action: 'accept', content })));
  await assert.rejects(elicit({ ...consultation, allowFreeText: false }, async () => ({ action: 'accept', content: { optionId: 'json', text: 'override' } })));
});

test('multiple_questions_preserve_options_and_free_text_but_do_not_prove_human_origin', () => {
  const message = question();
  message.params.questions.push({ ...message.params.questions[0], id: 'reason', header: 'Reason', question: 'Why?' });
  const inbox = new WorkerRequests(worker, 'fixture'), item = inbox.add(message, 'turn');
  assert.deepEqual(JSON.parse(item.detail).questions, message.params.questions);
  const answers = { choice: { answers: ['JSON'] }, reason: { answers: ['既存APIとの互換性を維持するため'] } };
  assert.throws(() => inbox.answerQuestion(item.key, { choice: answers.choice }, () => assert.fail('partial response')));
  inbox.answerQuestion(item.key, answers, (id, result) => assert.deepEqual({ id, result }, { id: 'question-7', result: { answers } }));
  // This is the coordinator-answerable route, never a human-consent adapter.
  assert.equal(item.kind, 'question'); assert.equal(inbox.list()[0].state, 'replied');
});

test('consultation_tool_consent_is_scoped_local_call_consent_and_not_a_consultation_answer', () => {
  for (const tool of ['propose_decision', 'get_decisions']) {
    const message = request(); message.params._meta.tool_name = tool;
    const inbox = new WorkerRequests(worker, 'fixture'), item = inbox.add(message, 'turn');
    assert.equal(item.state, 'pending');
    assert.match(item.detail, tool === 'propose_decision' ? /相談を記録/ : /相談.*読み取/);
    const replies: unknown[] = [];
    inbox.answer(item, 'accept', (_id, response) => replies.push(response));
    assert.deepEqual(replies, [{ action: 'accept', content: {}, _meta: null }]);
    assert.equal(inbox.blocking, true, 'only source RPC resolution ends this call consent');
    const external = request(); external.params._meta.tool_name = tool; external.params.serverName = 'other';
    assert.equal(new WorkerRequests(worker, 'fixture').add(external, 'turn').state, 'unsupported');
  }
});

test('nonblocking_question_resolution_invalidates_late_answer_without_granting_permission', () => {
  const message = question(); message.params.isBlocking = false;
  const inbox = new WorkerRequests(worker, 'fixture'), item = inbox.add(message, 'turn');
  // MC-02 characterizes the current conservative behavior; isBlocking support is not assumed.
  assert.equal(inbox.blocking, true);
  inbox.resolved('thread', message.id);
  assert.throws(() => inbox.answerQuestion(item.key, { choice: { answers: ['JSON'] } }, () => assert.fail('late reply')));
});

test('structured_elicitation_and_human_verification_stay_unsupported_without_trusted_adapter', () => {
  for (const mode of ['form', 'openai/form', 'openaiForm', 'openai/userVerification', 'url']) {
    const message: any = request(); message.params.mode = mode; message.params._meta = null;
    message.params.requestedSchema = { type: 'object', properties: { choice: { type: 'string', enum: ['JSON', 'Text'] }, reason: { type: 'string' } }, required: ['choice'] };
    const inbox = new WorkerRequests(worker, 'fixture'), item = inbox.add(message, 'turn');
    assert.equal(item.state, 'unsupported', mode); assert.equal(inbox.blocking, true);
    assert.throws(() => inbox.answer(item, 'accept', () => assert.fail('unsupported consent')));
    assert.throws(() => inbox.answerQuestion(item.key, { choice: { answers: ['JSON'] } }, () => assert.fail('model consent')));
  }
});

test('formal_callback_cancel_decline_close_and_delayed_generation_never_become_acceptance', { timeout: 10000 }, async () => {
  for (const scenario of ['cancel', 'decline', 'close', 'stale'] as const) {
    const inbox = new WorkerRequests(worker, 'fixture'), item = inbox.add(request(), 'turn');
    const sent: unknown[] = [];
    let displayed!: () => void, respond!: (value: any) => void;
    const shown = new Promise<void>(resolve => displayed = resolve), response = new Promise<any>(resolve => respond = resolve);
    const server = createMcpServer(async () => ({ state: 'waiting_approval', humanForm: item }), async (ref, action) => {
      inbox.answer(ref, action, (_id, result) => sent.push(result)); return { state: 'response_sent' };
    });
    const client = new Client({ name: 'mc02-simulated-UI', version: '0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, async () => { displayed(); return response; });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      const pending = client.callTool({ name: 'answer_request', arguments: { runId: 'run', operationId: 'op', expectedRevision: 0, requestKey: item.key } }).catch(() => undefined);
      await shown; assert.equal(sent.length, 0); assert.equal(inbox.list()[0].state, 'pending');
      if (scenario === 'close') await client.close();
      if (scenario === 'stale') inbox.present(item.key);
      respond({ action: scenario === 'stale' ? 'accept' : scenario === 'decline' ? 'decline' : 'cancel' });
      await pending;
      if (scenario === 'cancel' || scenario === 'decline') assert.deepEqual(sent, [{ action: scenario, content: null, _meta: null }]);
      else { assert.deepEqual(sent, []); assert.equal(inbox.list()[0].state, 'pending'); }
      assert.equal(inbox.blocking, true, 'only source resolution releases a request');
    } finally { respond({ action: 'cancel' }); await client.close(); await server.close(); }
  }
});

test('live_UI_probe_binds_structured_callback_and_records_no_free_text_body', { timeout: 10000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mc02-ui-'));
  const client = new Client({ name: 'fixture-ui', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    assert.equal(request.params.mode, 'form');
    if (request.params.mode !== 'form') throw new Error('wrong mode');
    assert.deepEqual(Object.keys(request.params.requestedSchema.properties), ['format', 'reason']);
    return { action: 'accept', content: { format: 'JSON', reason: 'private-free-text' } };
  });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/test/live/approval-roundtrip.js'), 'ui-probe', '--fixture', '--root', root], stderr: 'pipe' }));
    const result = await client.callTool({ name: 'mc02_questions', arguments: {} });
    assert.equal(result.isError, undefined);
    const evidence = JSON.parse(readFileSync(path.join(root, 'ui-request-1.json'), 'utf8'));
    assert.equal(evidence.source, 'fixture'); assert.equal(evidence.state, 'response_received');
    assert.equal(evidence.action, 'accept'); assert.equal(evidence.format, 'JSON');
    assert.equal(evidence.freeTextPresent, true); assert.match(evidence.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(typeof evidence.formGeneration, 'string');
    assert.equal(typeof evidence.toolRequestId, 'number');
    assert.deepEqual(evidence.client, { name: 'fixture-ui', version: '0' });
    assert.doesNotMatch(JSON.stringify(evidence), /private-free-text/);
  } finally { await client.close(); }
});

function gitApproval(kind: 'command' | 'permissions') {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cc06-approval-')), root = path.join(cwd, 'git-metadata'); mkdirSync(root);
  const permissions = { network: null, fileSystem: { read: null, write: [root] } };
  const params = { threadId: 'thread', turnId: 'turn', itemId: 'git-item', startedAtMs: 1, environmentId: null, cwd, reason: 'Commit to assigned Git branch', ...(kind === 'command' ? { kind: 'command', command: 'git commit -m change', additionalPermissions: permissions, availableDecisions: ['accept', 'decline', 'cancel'] } : { permissions }) };
  return { cwd, root, permissions, message: { id: 'git-approval', method: kind === 'command' ? 'item/commandExecution/requestApproval' : 'item/permissions/requestApproval', params } };
}

test('approval_detail_explains_scope_duration_and_requester_reason_without_protocol_JSON', () => {
  for (const kind of ['command', 'permissions'] as const) {
    const f = gitApproval(kind);
    (f.permissions.fileSystem as any).entries = [{ path: { type: 'path', path: f.root }, access: 'write' }];
    const item = new WorkerRequests(worker, f.cwd, () => {}, [f.root]).add(f.message, 'turn');
    assert.match(item.detail, /Git管理領域へのアクセス/);
    assert.match(item.detail, /依頼理由（担当の説明）: Commit to assigned Git branch/);
    assert.match(item.detail, kind === 'permissions' ? /有効期間: このターンの終了まで/ : /有効期間: 今回のコマンド1回/);
    assert.match(item.detail, /書き込み対象/);
    assert.equal(item.detail.split(f.root).length - 1, 1, 'duplicate wire representations must not duplicate paths');
    assert.doesNotMatch(item.detail, /"threadId"|"entries"|"environmentId"/);
    if (kind === 'command') assert.match(item.detail, /実行コマンド:\ngit commit -m change/);
  }
  const message = request();
  const report = new WorkerRequests(worker, 'fixture').add(message, 'turn');
  assert.match(report.detail, /作業結果を親へ報告/); assert.match(report.detail, /今回の要求1回/);
  assert.match(report.detail, /報告内容（担当の説明）: A token/);
  message.params._meta.tool_name = 'get_status';
  const status = new WorkerRequests(worker, 'fixture').add(message, 'turn');
  assert.match(status.detail, /作業状況を取得/); assert.doesNotMatch(status.detail, /A token/);
});

test('formal_git_approval_uses_original_id_and_only_requested_pinned_roots', () => {
  for (const kind of ['command', 'permissions'] as const) for (const action of ['accept', 'decline', 'cancel'] as const) {
    const f = gitApproval(kind), inbox = new WorkerRequests(worker, f.cwd, () => {}, [f.root]);
    const item = inbox.add(f.message, 'turn'); assert.equal(item.state, 'pending');
    const expected = kind === 'command' ? { decision: action } : { permissions: action === 'accept' ? { fileSystem: f.permissions.fileSystem } : {}, scope: 'turn' };
    inbox.answer(item, action, (id, response) => assert.deepEqual({ id, response }, { id: 'git-approval', response: expected }));
    assert.equal(inbox.blocking, true); assert.throws(() => inbox.answer(item, action, () => assert.fail('duplicate')));
    inbox.resolved('thread', 'git-approval'); assert.equal(inbox.blocking, false);
  }
});

test('git_approval_never_grants_unknown_roots_network_session_or_stdin', () => {
  for (const kind of ['command', 'permissions'] as const) for (const mutation of ['no_roots', 'outside', 'network', 'special', 'thread', 'turn', 'cwd', 'stdin', 'session_only', 'network_context', 'network_amendment']) {
    const f = gitApproval(kind), p: any = f.message.params;
    if (mutation === 'outside') f.permissions.fileSystem.write = [tmpdir()];
    if (mutation === 'network') (f.permissions as any).network = { enabled: true };
    if (mutation === 'special') (f.permissions.fileSystem as any).entries = [{ path: { type: 'special', value: 'root' }, access: 'write' }];
    if (mutation === 'thread') p.threadId = 'other';
    if (mutation === 'turn') p.turnId = 'old';
    if (mutation === 'cwd') p.cwd = tmpdir();
    if (kind === 'permissions' && ['stdin', 'session_only', 'network_context', 'network_amendment'].includes(mutation)) continue;
    if (mutation === 'stdin') p.kind = 'writeStdin';
    if (mutation === 'session_only') p.availableDecisions = ['acceptForSession'];
    if (mutation === 'network_context') p.networkApprovalContext = { host: 'external.invalid', protocol: 'https' };
    if (mutation === 'network_amendment') p.proposedNetworkPolicyAmendments = [{ host: 'external.invalid', action: 'allow' }];
    const inbox = new WorkerRequests(worker, f.cwd, () => {}, mutation === 'no_roots' ? [] : [f.root]), item = inbox.add(f.message, 'turn');
    assert.equal(item.state, 'unsupported', mutation); assert.throws(() => inbox.answer(item, 'accept', () => assert.fail('must not send')));
  }
});

test('git_approval_root_replacement_cannot_change_human_grant', () => {
  const f = gitApproval('permissions'), inbox = new WorkerRequests(worker, f.cwd, () => {}, [f.root]);
  const item = inbox.add(f.message, 'turn'), outside = mkdtempSync(path.join(tmpdir(), 'cc06-outside-'));
  renameSync(f.root, f.root + '-original'); symlinkSync(outside, f.root, 'junction');
  let sent = false;
  assert.throws(() => inbox.answer(item, 'accept', () => { sent = true; }));
  assert.equal(sent, false);
});

test('formal_git_approval_expires_with_form_generation_and_turn', () => {
  const f = gitApproval('command'), inbox = new WorkerRequests(worker, f.cwd, () => {}, [f.root]);
  const old = inbox.add(f.message, 'turn'), fresh = inbox.present(old.key);
  assert.throws(() => inbox.answer(old, 'accept', () => {}));
  assert.throws(() => inbox.answer({ ...fresh, payloadHash: 'changed' }, 'accept', () => {}));
  inbox.cancelTurn('turn'); assert.throws(() => inbox.answer(fresh, 'accept', () => {}));
});

test('git_approval_matches_observed_local_environment_only', () => {
  for (const kind of ['command', 'permissions'] as const) {
    const f = gitApproval(kind);
    (f.message.params as any).environmentId = 'local';
    const inbox = new WorkerRequests(worker, f.cwd, () => {}, [f.root], 'local');
    const item = inbox.add(f.message, 'turn'); assert.equal(item.state, 'pending');
    inbox.answer(item, 'accept', () => {});
    const unknown = new WorkerRequests(worker, f.cwd, () => {}, [f.root]);
    assert.equal(unknown.add(f.message, 'turn').state, 'unsupported');
    (f.message.params as any).environmentId = 'remote';
    assert.equal(new WorkerRequests(worker, f.cwd, () => {}, [f.root], 'local').add(f.message, 'turn').state, 'unsupported');
  }
});
test('answers_original_question_id', () => {
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), item = inbox.add(question(), 'turn');
  assert.equal(item.kind, 'question'); assert.equal(item.state, 'pending');
  const answer = { choice: { answers: ['JSON'] } };
  inbox.answerQuestion(item.key, answer, (id, result) => assert.deepEqual({ id, result }, { id: 'question-7', result: { answers: answer } }));
  assert.equal(inbox.blocking, true);
  assert.throws(() => inbox.answerQuestion(item.key, answer, () => {}));
});
test('model_cannot_supply_human_approval', () => {
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), item = inbox.add(request(), 'turn');
  assert.throws(() => inbox.answerQuestion(item.key, { accept: { answers: ['yes'] } }, () => {}));
});
test('stale_or_duplicate_form_cannot_resolve_request', () => {
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), old = inbox.add(request(), 'turn');
  const fresh = inbox.present(old.key);
  assert.throws(() => inbox.answer(old, 'accept', () => {}));
  inbox.answer(fresh, 'accept', () => {});
  assert.throws(() => inbox.answer(fresh, 'accept', () => {}));
});
test('connector_consent_is_not_plain_question', () => {
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), r: any = question();
  r.params._meta = { connector_id: 'external' };
  const item = inbox.add(r, 'turn'); assert.equal(item.kind, 'connector'); assert.equal(item.state, 'unsupported');
});
test('mcp_timeout_keeps_source_pending', () => {
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), item = inbox.add(request(), 'turn');
  inbox.present(item.key); inbox.present(item.key);
  assert.equal(inbox.list()[0].state, 'pending'); assert.equal(inbox.blocking, true);
});
test('expired_form_remains_visible_without_blocking_other_forms', () => {
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), r: any = request(); r.params.autoResolutionMs = 0;
  const expired = inbox.add(r, 'turn');
  assert.equal(inbox.present(expired.key).state, 'unsupported');
  assert.equal(inbox.blocking, true);
});
test('expired_interrupted_and_invalid_questions_do_not_send', () => {
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), r = question(), item = inbox.add(r, 'turn');
  assert.throws(() => inbox.answerQuestion(item.key, { other: { answers: ['JSON'] } }, () => {}));
  inbox.cancelTurn('turn'); assert.throws(() => inbox.answerQuestion(item.key, { choice: { answers: ['JSON'] } }, () => {}));
  const expired: any = question(); expired.id = 'expired'; expired.params.autoResolutionMs = 0;
  const x = inbox.add(expired, 'turn'); assert.throws(() => inbox.answerQuestion(x.key, { choice: { answers: ['JSON'] } }, () => {}));
});
test('approval_is_bound_to_request_hash', () => {
  const inbox = new WorkerRequests(worker, 'D:\\fixture'); const item = inbox.add(request(), 'turn');
  assert.equal(item.state, 'pending'); const sent: unknown[] = [];
  assert.throws(() => inbox.answer({ ...item, payloadHash: 'wrong' }, 'accept', (id, result) => sent.push({ id, result })));
  inbox.answer(item, 'accept', (id, result) => sent.push({ id, result }));
  assert.deepEqual(sent, [{ id: 7, result: { action: 'accept', content: {}, _meta: null } }]);
  assert.equal(inbox.blocking, true); assert.throws(() => inbox.answer(item, 'accept', () => {}));
  inbox.resolved('other', 7); assert.equal(inbox.blocking, true);
  inbox.resolved('thread', 7); assert.equal(inbox.blocking, false);
});
test('unsupported_approval_APIs_remain_pending_without_manufactured_decision', () => {
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'tool/requestUserInput', 'account/login', 'future/request']) {
    const inbox = new WorkerRequests(worker, 'fixture');
    const item = inbox.add({ id: 8, method, params: { threadId: 'thread', turnId: null } }, 'turn');
    assert.equal(item.state, 'unsupported'); assert.equal(inbox.blocking, true);
    assert.throws(() => inbox.answer(item, 'accept', () => assert.fail('must not send')));
  }
});
test('natural_question_is_answered_as_next_turn_not_original_RPC', () => {
  const inbox = new WorkerRequests(worker, 'fixture');
  const item = inbox.addFollowup('Which format?', 'turn');
  assert.equal(item.delivery, 'next_turn');
  let answer: unknown;
  inbox.answerQuestion(item.key, { reply: { answers: ['JSON'] } }, (_id, result) => answer = result);
  assert.deepEqual(answer, { answers: { reply: { answers: ['JSON'] } } });
});
test('unanswerable_followup_is_rejected_before_registration', () => {
  const inbox = new WorkerRequests(worker, 'fixture');
  assert.throws(() => inbox.addFollowup('あ'.repeat(8192), 'turn'));
  assert.equal(inbox.blocking, false); assert.equal(inbox.list().length, 0);
});
test('stopped_stale_changed_or_unsupported_requests_cannot_be_approved', () => {
  for (const change of [(r: any) => r.params.turnId = null, (r: any) => r.params.serverName = 'external', (r: any) => r.params.mode = 'openai/userVerification', (r: any) => r.params._meta.tool_name = 'shell', (r: any) => r.params.requestedSchema.properties = { token: { type: 'string' } }]) {
    const inbox = new WorkerRequests(worker, 'D:\\fixture'), r = request(); change(r);
    const item = inbox.add(r, 'turn'); assert.equal(item.state, 'unsupported'); assert.throws(() => inbox.answer(item, 'accept', () => {}));
  }
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), item = inbox.add(request(), 'turn');
  inbox.cancel(); assert.throws(() => inbox.answer(item, 'accept', () => {}));
});
test('decline_cancel_unknown_delivery_and_request_id_reuse_are_not_replayed', () => {
  for (const action of ['decline', 'cancel'] as const) {
    const inbox = new WorkerRequests(worker, 'D:\\fixture'), item = inbox.add(request(), 'turn');
    inbox.answer(item, action, (_id, result) => assert.deepEqual(result, { action, content: null, _meta: null }));
    assert.equal(inbox.list()[0].state, 'replied');
  }
  const inbox = new WorkerRequests(worker, 'D:\\fixture'), item = inbox.add(request(), 'turn');
  assert.throws(() => inbox.answer(item, 'accept', () => { throw new Error('transport lost'); }));
  assert.throws(() => inbox.answer(item, 'accept', () => {}));
  assert.throws(() => inbox.add(request(), 'turn'));
});
test('local_MCP_consent_does_not_require_connector_metadata', () => {
  const r: any = request(); delete r.params._meta.connector_id;
  const inbox = new WorkerRequests(worker, 'D:\\fixture');
  assert.equal(inbox.add(r, 'turn').state, 'pending');
  r.params._meta.connector_id = 'external'; r.id++;
  assert.equal(inbox.add(r, 'turn').state, 'unsupported');
});
test('unsupported_requests_expose_bounded_shape_without_argument_values', () => {
  const r: any = request(); r.params.mode = 'url'; r.params._meta.tool_params.secret = 'never-display';
  const item = new WorkerRequests(worker, 'D:\\fixture').add(r, 'turn');
  assert.equal(item.state, 'unsupported'); assert.match(item.detail, /mcpServer\/elicitation\/request/);
  assert.match(item.detail, /url/); assert.doesNotMatch(item.detail, /never-display/);
});
