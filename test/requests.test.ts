import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkerRequests } from '../src/requests.js';
import { mkdtempSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const worker = { ownerId: 'owner', ownerEpoch: 'epoch', threadId: 'thread', workerId: 'A', attemptId: 'attempt' };
const request = () => ({ id: 7, method: 'mcpServer/elicitation/request', params: { threadId: 'thread', turnId: 'turn', serverName: 'meristem', mode: 'form', message: 'Report approval', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'meristem', tool_name: 'report', tool_params: { report: { summary: 'A token' } } } } });
const question = () => ({ id: 'question-7', method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{ id: 'choice', header: 'Choice', question: 'Which format?', isSecret: false, options: [{ label: 'JSON', description: 'Structured' }] }] } });

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
