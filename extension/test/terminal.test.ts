import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { openWorkerTerminal, sanitize, publishWorkerEvent, stopWorkerTerminal, disposeWorkerTerminal, showWorkerTerminalDetails } from '../src/terminal';
import type { ControlConnection, WorkerRef } from '../src/control-client';
import { connect } from '../src/control-client';
import * as controlClient from '../src/control-client';
import * as managedClient from '../src/managed-client';
import { createServer, Socket } from 'node:net';
import { reviewWorkerRequest } from '../src/approval';

const extensionWorkspace = { workspaceFolders: [], registerTextDocumentContentProvider() { return { dispose() {} }; } };

// Exercise the real renderer; only VS Code and the control transport are fixtures.
function terminalFixture(connection: ControlConnection, worker: WorkerRef, extra: object = {}) {
  let pty!: import('vscode').Pseudoterminal, name = '', disposed = 0;
  const output: string[] = [], names: string[] = [];
  const api = { window: { createTerminal(options: { pty: import('vscode').Pseudoterminal; name: string }) {
    pty = options.pty; name = options.name;
    return { show() {}, dispose() { disposed++; pty.close?.(); } };
  } } } as unknown as typeof import('vscode');
  const terminal = openWorkerTerminal(api, connection, { worker, attemptId: worker.attemptId ?? 'attempt', ...extra });
  pty.onDidWrite(value => output.push(value));
  pty.onDidChangeName?.(value => names.push(value));
  return { terminal, pty, output, names, name, get disposed() { return disposed; } };
}
const nextDraw = async () => { for (let i = 0; i < 15; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('one terminal groups adjacent matching activities and omits a repeated activity summary', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = { id: 'B', pipeName: 'fixture', cwd: 'work', branch: 'b', agent: 'mock', state: 'running', attemptId: 'current' };
  const presentation = { displayName: 'B', taskId: 'B', activity: '待機', activitySource: 'tool' as const, lastActivityAt: new Date().toISOString(), decisionIds: [] };
  let events: { worker: typeof worker; text: string; source: 'tool'; seq: number }[] = [];
  const fixture = terminalFixture({
    async readEvents(lastSeq) { return { events: [], lastSeq, activityEvents: events }; },
    async getStatus() { return { ...worker, presentation }; },
    async stop() { return { ok: true, state: 'stopped' }; }, dispose() {}
  }, worker, { managed: true });
  t.after(() => disposeWorkerTerminal(fixture.terminal));
  fixture.pty.open(undefined); await nextDraw();
  const before = fixture.output.length;
  presentation.activity = 'コマンドを実行中';
  presentation.lastActivityAt = '2026-11-18T11:37:12.978Z';
  events = [1, 2, 3].map(seq => ({ seq, worker, source: 'tool', text: presentation.activity }));
  events.push({ seq: 4, worker: { ...worker, attemptId: 'other' }, source: 'tool', text: '別の担当' });
  t.mock.timers.tick(500); await nextDraw();
  t.mock.timers.tick(500); await nextDraw();
  assert.equal(fixture.output.slice(before).join(''), '最終活動: 2026-11-18T11:37:12.978Z\r\n[ツール] コマンドを実行中（3件）\r\n');
});

test('a managed terminal prints its assignment once and then only changed fields', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = { id: 'B', pipeName: 'fixture', cwd: 'work', branch: 'b', agent: 'model / medium', state: 'idle' };
  const status = { ...worker, permissionSummary: 'meristem-managed（割り当て先への書き込み、承認: auto_review）', lastResult: '情報なし', taskState: 'assigned', connection: 'connected' as 'connected' | 'unknown',
    presentation: { displayName: '比較担当', taskId: 'B', activity: '情報なし', activitySource: null, decisionIds: [], lastActivityAt: null } };
  const fixture = terminalFixture({ async readEvents(seq) { return { events: seq ? [] : [{ seq: 1, worker, text: '担当を登録しました' }], lastSeq: 1 }; }, async getStatus() { return status; },
    async stop() { return { ok: true, state: 'stopped' }; }, dispose() {} }, worker, { managed: true });
  t.after(() => disposeWorkerTerminal(fixture.terminal));
  fixture.pty.open(undefined); await nextDraw();
  assert.equal(fixture.output.join(''), '比較担当 · タスク B · 指示待ち\r\nモデル：model / medium\r\n権限：割り当て先に書き込み可 · 自動レビュー\r\n');
  const before = fixture.output.length;
  status.state = 'running'; status.lastResult = 'Git操作が正常終了しませんでした（終了コード 128）';
  t.mock.timers.tick(500); await nextDraw();
  assert.equal(fixture.output.slice(before).join(''), '状態: 実行中\r\n直近結果: Git操作が正常終了しませんでした（終了コード 128）\r\n');
  status.connection = 'unknown'; t.mock.timers.tick(500); await nextDraw();
  status.connection = 'connected'; t.mock.timers.tick(500); await nextDraw();
  assert.match(fixture.output.join(''), /接続: 不明.*\r\n接続: 接続済み/);
  status.permissionSummary = 'meristem-read-only（読み取り専用、承認: auto_review）';
  const beforeReview = fixture.output.length;
  t.mock.timers.tick(500); await nextDraw();
  assert.equal(fixture.output.slice(beforeReview).join(''), '権限：読み取り専用 · 自動レビュー\r\n');
});

test('authorization header redaction removes the credential as well as the scheme', () => {
  assert.equal(sanitize('Authorization: Bearer credential-never-forwarded next'), '[redacted] next');
  assert.equal(sanitize('Authorization: Basic credential-never-forwarded next'), '[redacted] next');
  assert.equal(sanitize('feature/task-api'), 'feature/task-api');
});

test('the Worker terminal prints the confirmed change line once without repeating current settings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = { id: 'A', pipeName: 'fixture', attemptId: 'A1', cwd: 'work', branch: 'b', agent: 'model / medium', state: 'idle' };
  const status = { ...worker, appliedAgent: worker.agent, permissionSummary: 'meristem-managed（割り当て先への書き込み、承認: user）',
    presentation: { displayName: 'A', taskId: 'A', activity: '情報なし', activitySource: null, decisionIds: [], lastActivityAt: null } };
  const activityEvents: { seq: number; worker: typeof worker; source: 'settings'; text: string }[] = [];
  const fixture = terminalFixture({ async readEvents(seq) { return { events: [], lastSeq: seq, activityEvents }; },
    async getStatus() { return status; }, async stop() { return { ok: true, state: 'stopped' }; }, dispose() {} }, worker, { managed: true });
  t.after(() => disposeWorkerTerminal(fixture.terminal));
  fixture.pty.open(undefined); await nextDraw();
  assert.equal(fixture.output.join('').trimEnd().split('\r\n').length, 3);
  const before = fixture.output.length;
  status.appliedAgent = 'model / high';
  activityEvents.push({ seq: 1, worker, source: 'settings', text: '[設定変更]medium→high' },
    { seq: 2, worker: { ...worker, attemptId: 'A2' }, source: 'settings', text: '別の担当' });
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(500); await nextDraw(); }
  assert.equal(fixture.output.slice(before).join(''), '[設定変更]medium→high\r\n');
});

test('running_with_pending_consultation_is_displayed_separately', async () => {
  const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'C:/private/worktree', branch: 'feature/api', agent: 'model / high', state: 'running', actor: 'owner/epoch/thread', attemptId: 'attempt-a' };
  const status = { ...worker, presentation: { displayName: 'API実装', taskId: 'api', activity: 'APIの回帰テスト', activitySource: 'tool' as const, lastActivityAt: new Date().toISOString(), decisionIds: ['decision-1'] },
    permissionSummary: '作業ディレクトリへの書込み', lastResult: '関連テスト12件成功',
    consultations: [{ id: 'decision-1', recipient: 'human' as const, question: 'API仕様を確認', state: 'pending' as const, taskIds: ['api', 'docs'], blockingTaskIds: ['docs'] }] };
  const fixture = terminalFixture({ async readEvents() { return { events: [{ seq: 1, worker, text: 'テスト実行', source: 'tool' as const }, { seq: 2, worker, text: '次は互換性を調査', source: 'worker' as const }], lastSeq: 2 }; }, async getStatus() { return status; }, async stop() { return { ok: true, state: 'stopped' }; }, dispose() {} }, worker);
  fixture.pty.open(undefined); await nextDraw(); fixture.pty.close?.();
  const text = fixture.output.join('');
  for (const expected of ['API実装', 'api', '実行中', 'APIの回帰テスト', '権限：', '作業ディレクトリへの書込み', '人', 'API仕様を確認', '続行範囲: api', '保留範囲: docs', '最終活動', '関連テスト12件成功', '[ツール] テスト実行', '[ワーカー説明] 次は互換性を調査']) assert.ok(text.includes(expected), expected);
  for (const detail of [worker.cwd, worker.actor!, worker.attemptId!]) assert.ok(!text.includes(detail), 'identity and full paths belong in details');
});

test('display_name_never_changes_identity_or_branch', async t => {
  for (const displayName of ['API実装', 'feature/auth-api', '同じ名前']) {
    const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'C:/worktree', branch: 'original', agent: 'mock', state: 'running', actor: 'owner/epoch/thread', attemptId: 'exact-attempt' };
    const original = { ...worker }, presentation = { displayName, taskId: 'task', activity: '実装', activitySource: 'worker' as const, lastActivityAt: null, decisionIds: [] };
    let stops = 0;
    const fixture = terminalFixture({ async readEvents(afterSeq) { return { events: [], lastSeq: afterSeq }; }, async getStatus() { return { ...worker, presentation }; }, async stop(binding) { assert.deepEqual(binding.worker, original); assert.equal(binding.attemptId, 'exact-attempt'); stops++; return { ok: true, state: 'stopped' }; }, dispose() {} }, worker, { presentation: { ...presentation, displayName: '前の担当名' } });
    t.after(() => fixture.pty.close?.()); fixture.pty.open(undefined); await nextDraw();
    assert.ok(fixture.names.includes(displayName));
    showWorkerTerminalDetails(fixture.terminal); await nextDraw();
    const text = fixture.output.join('');
    for (const detail of ['C:/worktree', 'owner/epoch/thread', 'exact-attempt', 'original']) assert.ok(text.includes(detail));
    await stopWorkerTerminal(fixture.terminal); fixture.pty.close?.(); assert.equal(stops, 1); assert.deepEqual(worker, original);
  }
});

test('old_activity_keeps_its_timestamp_and_only_connection_loss_is_flagged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-17T01:02:00Z') });
  const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'running' };
  let failed = false;
  const fixture = terminalFixture({ async readEvents(afterSeq) { return { events: [], lastSeq: afterSeq }; }, async getStatus() { if (failed) throw Error('secret error'); return { ...worker, connection: 'unknown' as const, presentation: { displayName: 'A', taskId: 'task', activity: 'テスト', activitySource: 'worker' as const, lastActivityAt: '2026-11-17T01:00:00Z', decisionIds: ['missing'] } }; }, async stop() { return { ok: false, state: 'unknown' }; }, dispose() {} }, worker);
  t.after(() => fixture.pty.close?.()); fixture.pty.open(undefined); await nextDraw();
  assert.match(fixture.output.join(''), /最終活動: 2026-11-17T01:00:00Z/); assert.doesNotMatch(fixture.output.join(''), /活動更新が古い/); assert.match(fixture.output.join(''), /接続: 不明/); assert.match(fixture.output.join(''), /相談 missing.*詳細未取得/);
  failed = true; t.mock.timers.tick(500); await nextDraw();
  assert.match(fixture.output.join(''), /接続: 不明/); assert.ok(!fixture.output.join('').includes('secret error'));
  await stopWorkerTerminal(fixture.terminal); fixture.pty.close?.();
});

test('terminal_output_stays_sanitized_and_bounded_with_presentation_and_retained_completion', async () => {
  const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'C:/private', branch: 'fixture', agent: 'mock', state: 'completed' };
  const fixture = terminalFixture({ async readEvents() { return { events: [], lastSeq: 0 }; }, async getStatus() { return { ...worker, presentation: { displayName: '安全\u001b]52;c;clipboard\u0007', taskId: 'task', activity: 'api_key=hidden ' + 'あ'.repeat(100000), activitySource: 'worker' as const, lastActivityAt: null, decisionIds: [] } }; }, async stop() { assert.fail('completed must not stop'); }, dispose() {} }, worker);
  fixture.pty.open(undefined); await nextDraw();
  const output = fixture.output.join('');
  assert.equal(fixture.disposed, 0); assert.ok(!output.includes('hidden')); assert.ok(!output.includes('\u001b')); assert.ok(!fixture.names.join('').includes('\u0007'));
  assert.ok(fixture.output.every(value => Buffer.byteLength(value) <= 65536)); assert.match(output, /表示省略/);
  fixture.pty.close?.();
});

test('failed_status_read_does_not_consume_undisplayed_events', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'running' };
  let fail = true;
  const cursors: number[] = [];
  const fixture = terminalFixture({ async readEvents(afterSeq) { cursors.push(afterSeq); return { events: afterSeq === 0 ? [{ seq: 1, worker, text: '保存されたテスト結果' }] : [], lastSeq: 1 }; }, async getStatus() { if (fail) throw Error('unavailable'); return worker; }, async stop() { return { ok: true, state: 'stopped' }; }, dispose() {} }, worker);
  t.after(() => fixture.pty.close?.()); fixture.pty.open(undefined); await nextDraw();
  fail = false; t.mock.timers.tick(500); await nextDraw();
  assert.deepEqual(cursors, [0, 0]); assert.match(fixture.output.join(''), /保存されたテスト結果/);
});

test('completed_terminal_refreshes_pending_consultations_without_stopping_the_worker', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'completed' };
  let decisionState: 'pending' | 'resolved' = 'pending';
  const fixture = terminalFixture({
    async readEvents(afterSeq) { return { events: [], lastSeq: afterSeq }; },
    async getStatus() {
      return { ...worker, presentation: { displayName: '実装担当', taskId: 'task', activity: '終了', activitySource: 'tool', lastActivityAt: null, decisionIds: ['decision'] },
        consultations: [{ id: 'decision', recipient: 'coordinator', question: '結果を確認', state: decisionState, taskIds: ['task'], blockingTaskIds: [] }] };
    },
    async stop() { assert.fail('consultation updates must not stop a completed process'); },
    dispose() {}
  }, worker);
  t.after(() => disposeWorkerTerminal(fixture.terminal));
  fixture.pty.open(undefined); await nextDraw();
  assert.match(fixture.output.join(''), /decision \[pending\]/);
  decisionState = 'resolved'; t.mock.timers.tick(5000); await nextDraw();
  assert.match(fixture.output.join(''), /decision \[resolved\]/);
  assert.equal(fixture.disposed, 0);
});

test('managed_terminal_close_reaches_native_stop_without_waiting_for_display_status', async () => {
  const worker: WorkerRef = { id: 'A', pipeName: 'managed', cwd: '', branch: 'fixture', agent: 'mock', state: 'running' };
  let stops = 0;
  const fixture = terminalFixture({
    async readEvents(afterSeq) { return { events: [], lastSeq: afterSeq }; },
    async getStatus() { assert.fail('closing a managed terminal does not read display status'); },
    async stop() { stops++; return { ok: true, state: 'stopped' }; },
    dispose() {}
  }, worker, { managed: true });
  fixture.pty.close?.(); await nextDraw();
  assert.equal(stops, 1);
});

test('retained_managed_terminal_fetches_consultations_created_after_completion', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const loader = require('node:module'), original = loader._load, commands = new Map<string, () => Promise<void>>();
  const worker: WorkerRef = { id: 'A', pipeName: 'managed', cwd: '', branch: 'fixture', agent: 'mock', state: 'completed' };
  const binding = { worker, attemptId: 'attempt', managed: true as const };
  const output: string[] = [];
  let newConsultation = false, changed = false, pty: import('vscode').Pseudoterminal;
  const connection: ControlConnection = {
    async readEvents(afterSeq) { return { events: [], lastSeq: afterSeq }; },
    async getStatus() {
      return { ...worker, presentation: { displayName: '実装担当', taskId: 'task', activity: '終了', activitySource: 'tool', lastActivityAt: null, decisionIds: newConsultation ? ['follow-up'] : [] },
        consultations: newConsultation ? [{ id: 'follow-up', recipient: 'coordinator', question: '完了後の相談', state: 'resolved', taskIds: ['task'], blockingTaskIds: [] }] : [] };
    },
    async stop() { assert.fail('completed process must remain stopped'); },
    dispose() {}
  };
  const session = { terminals: [{ binding, connection }], async refresh() { const result = changed; changed = false; return result; }, dispose() {} };
  const api = {
    Uri: class {},
    workspace: extensionWorkspace,
    commands: { registerCommand(name: string, handler: () => Promise<void>) { commands.set(name, handler); return { dispose() {} }; } },
    window: {
      async showOpenDialog() { return [{ fsPath: 'discovery' }]; },
      createTerminal(options: { pty: import('vscode').Pseudoterminal }) {
        pty = options.pty;
        pty.onDidWrite(line => output.push(line));
        return { show(preserveFocus?: boolean) { assert.equal(preserveFocus, true, 'automatic tab discovery preserves the parent input focus'); pty.open(undefined); } };
      },
      onDidCloseTerminal() { return { dispose() {} }; }
    }
  };
  t.mock.method(loader, '_load', function(name: string, ...args: unknown[]) { return name === 'vscode' ? api : original.call(loader, name, ...args); });
  t.mock.method(managedClient, 'connectManaged', async () => session as any);
  delete require.cache[require.resolve('../src/extension')]; const extension = require('../src/extension'), subscriptions: { dispose(): void }[] = [];
  extension.activate({ subscriptions });
  t.after(async () => { subscriptions.forEach(item => item.dispose()); await extension.deactivate(); pty?.close?.(); delete require.cache[require.resolve('../src/extension')]; });
  await commands.get('meristem.chatControl.openManaged')!(); await nextDraw();
  assert.match(output.join(''), /完了/); assert.doesNotMatch(output.join(''), /相談: なし/);
  newConsultation = changed = true; t.mock.timers.tick(500); await nextDraw();
  assert.match(output.join(''), /follow-up \[resolved\]/);
});

test('same_display_names_route_events_and_stop_to_exact_attempt_only', async t => {
  const fixtures = ['old', 'new'].map(attemptId => {
    const worker: WorkerRef = { id: 'A', pipeName: 'shared', cwd: 'fixture', branch: 'fixed', agent: 'mock', state: 'running', actor: 'owner/epoch/thread', attemptId };
    const presentation = { displayName: '同じ名前', taskId: 'task', activity: '実装', activitySource: 'worker' as const, lastActivityAt: null, decisionIds: [] };
    let stopped = '';
    const fixture = terminalFixture({ async readEvents(afterSeq) { return { events: [], lastSeq: afterSeq }; }, async getStatus() { return { ...worker, presentation }; }, async stop(binding) { stopped = binding.attemptId; return { ok: true, state: 'stopped' }; }, dispose() {} }, worker);
    t.after(() => disposeWorkerTerminal(fixture.terminal));
    return { fixture, worker, get stopped() { return stopped; } };
  });
  fixtures.forEach(({ fixture }) => fixture.pty.open(undefined)); await nextDraw();
  publishWorkerEvent({ seq: 1, worker: fixtures[1].worker, text: 'new-only', source: 'tool' }); await nextDraw();
  assert.ok(!fixtures[0].fixture.output.join('').includes('new-only')); assert.match(fixtures[1].fixture.output.join(''), /new-only/);
  await stopWorkerTerminal(fixtures[1].fixture.terminal);
  assert.equal(fixtures[0].stopped, ''); assert.equal(fixtures[1].stopped, 'new');
});

test('status_refresh_ages_activity_without_repeating_unchanged_output_or_holding_resolved_consultations', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-17T01:00:59Z') });
  const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'running' };
  const fixture = terminalFixture({ async readEvents(afterSeq) { return { events: [], lastSeq: afterSeq }; }, async getStatus() { return { ...worker, presentation: { displayName: 'A', taskId: 'task', activity: 'テスト', activitySource: 'tool' as const, lastActivityAt: '2026-11-17T01:00:00Z', decisionIds: ['resolved'] }, consultations: [{ id: 'resolved', state: 'resolved' as const, recipient: 'coordinator' as const, question: '回答済み', taskIds: ['task'], blockingTaskIds: ['task'] }] }; }, async stop() { return { ok: true, state: 'stopped' }; }, dispose() {} }, worker);
  t.after(() => disposeWorkerTerminal(fixture.terminal)); fixture.pty.open(undefined); await nextDraw();
  const before = fixture.output.length;
  t.mock.timers.tick(500); await nextDraw(); assert.equal(fixture.output.length, before);
  t.mock.timers.tick(500); await nextDraw(); assert.match(fixture.output.join(''), /最終活動: 2026-11-17T01:00:00Z/); assert.doesNotMatch(fixture.output.join(''), /活動更新が古い/);
  assert.ok(!fixture.output.join('').includes('保留範囲: task'));
});

test('event_flood_cannot_hide_latest_status_or_confirmed_stop', async t => {
  const worker: WorkerRef = { id: 'A', pipeName: 'flood', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'running' };
  const fixture = terminalFixture({ async readEvents() { return { events: Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, worker, text: 'x'.repeat(65534) + '\n' })), lastSeq: 100 }; }, async getStatus() { return worker; }, async stop() { return { ok: true, state: 'stopped' }; }, dispose() {} }, worker);
  t.after(() => disposeWorkerTerminal(fixture.terminal)); fixture.pty.open(undefined); await nextDraw();
  assert.ok(fixture.output.some(line => line.includes(' · 実行中')), 'event overflow must retain the latest status');
  // Published events can arrive during an explicit stop as well as a poll.
  for (let seq = 101; seq <= 200; seq++) publishWorkerEvent({ seq, worker, text: 'y'.repeat(65534) + '\n' });
  await stopWorkerTerminal(fixture.terminal);
  for (let seq = 201; seq <= 300; seq++) publishWorkerEvent({ seq, worker, text: 'z'.repeat(65534) + '\n' });
  await nextDraw(); assert.ok(fixture.output.some(line => line.includes('停止済み')), 'event overflow must retain confirmed stop');
  assert.ok(fixture.output.every(value => Buffer.byteLength(value) <= 65536));
});

test('long_consultation_questions_keep_scopes_last_activity_and_result_visible', async () => {
  const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'completed' };
  const consultations = Array.from({ length: 20 }, (_, i) => ({ id: `decision-${i}`, recipient: 'human' as const, question: '長い相談'.repeat(512), state: 'pending' as const, taskIds: ['continue', 'held'], blockingTaskIds: ['held'] }));
  const fixture = terminalFixture({ async readEvents() { return { events: [], lastSeq: 0 }; }, async getStatus() { return { ...worker, lastResult: '20件成功', presentation: { displayName: '担当', taskId: 'task', activity: 'API検証', activitySource: 'tool' as const, lastActivityAt: '2026-11-17T01:00:00Z', decisionIds: consultations.map(item => item.id) }, consultations }; }, async stop() { assert.fail('completed'); }, dispose() {} }, worker);
  fixture.pty.open(undefined); await nextDraw(); fixture.pty.close?.();
  const text = fixture.output.join('');
  for (const expected of ['20件成功', '最終活動', 'decision-19', '続行範囲: continue', '保留範囲: held']) assert.ok(text.includes(expected), expected);
  assert.ok(text.includes('表示省略'), 'long reasons have explicit bounded previews');
  assert.ok(fixture.output.every(value => Buffer.byteLength(value) <= 65536));
});

test('consultations_exceeding_summary_budget_have_an_explicit_omission_count', async () => {
  const worker: WorkerRef = { id: 'A', pipeName: 'fixture', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'completed' };
  const taskIds = Array.from({ length: 128 }, (_, i) => `task${i}_` + 'x'.repeat(100));
  const consultations = Array.from({ length: 128 }, (_, i) => ({ id: `decision-${i}`, recipient: 'human' as const, question: '相談'.repeat(1024), state: 'pending' as const, taskIds, blockingTaskIds: taskIds.slice(64) }));
  const fixture = terminalFixture({ async readEvents() { return { events: [], lastSeq: 0 }; }, async getStatus() { return { ...worker, lastResult: '最終結果', presentation: { displayName: '担当', taskId: 'task', activity: '検証', activitySource: 'tool' as const, lastActivityAt: null, decisionIds: consultations.map(item => item.id) }, consultations }; }, async stop() { assert.fail('completed'); }, dispose() {} }, worker);
  fixture.pty.open(undefined); await nextDraw(); fixture.pty.close?.();
  const text = fixture.output.join('');
  assert.match(text, /\[\d+ consultations omitted\]/); assert.match(text, /最終結果/);
  assert.ok(!text.includes('oversized event omitted'), 'structured fields must fit the summary cap');
  assert.ok(fixture.output.every(value => Buffer.byteLength(value) <= 65536));
});
test('retire_current_worker_and_stop_run_are_distinct_commands_and_keep_logs', async t => {
  const loader = require('node:module'), original = loader._load, commands = new Map<string, () => Promise<void>>();
  let retires = 0, stops = 0, allStops = 0, disposed = 0;
  const worker = { id: 'A', pipeName: 'managed', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'running' };
  const binding = { worker, attemptId: 'attempt' }, terminal = { show() {}, dispose() { disposed++; } };
  const connection = { async readEvents() { return { events: [], lastSeq: 0 }; }, async getStatus() { return worker; },
    async stop() { stops++; return { ok: true, state: 'stopped' }; },
    async retire(target: unknown) { assert.equal(target, binding); retires++; return { ok: true, state: 'stopped' }; }, dispose() {} };
  const session = { terminals: [{ binding, connection }], async refresh() {}, async stopRun() { allStops++; return { run: {state: 'stopped'}, results: [{ state: 'stopped' }] }; }, dispose() {} };
  const api = { Uri: class {}, workspace: extensionWorkspace, commands: { registerCommand(name: string, handler: () => Promise<void>) { commands.set(name, handler); return { dispose() {} }; } },
    window: { activeTerminal: terminal, async showOpenDialog() { return [{ fsPath: 'discovery' }]; }, createTerminal() { return terminal; }, onDidCloseTerminal() { return { dispose() {} }; }, async showInformationMessage(message: string) { assert.equal(message, '実行を停止しました。'); }, async showErrorMessage() { assert.fail('unexpected error'); } } };
  t.mock.method(loader, '_load', function(name: string, ...args: unknown[]) { return name === 'vscode' ? api : original.call(loader, name, ...args); });
  t.mock.method(managedClient, 'connectManaged', async () => session as any);
  delete require.cache[require.resolve('../src/extension')]; const extension = require('../src/extension'), subscriptions: { dispose(): void }[] = [];
  extension.activate({ subscriptions });
  t.after(async () => { subscriptions.forEach(item => item.dispose()); await extension.deactivate(); delete require.cache[require.resolve('../src/extension')]; });
  await commands.get('meristem.chatControl.openManaged')!();
  await commands.get('meristem.chatControl.retireWorker')!();
  assert.equal(retires, 1); assert.equal(stops, 0); assert.equal(disposed, 0);
  await commands.get('meristem.chatControl.stopRun')!(); assert.equal(allStops, 1); assert.equal(disposed, 0);
});
test('approval_modal_requires_explicit_human_choice_and_preserves_request_binding', async () => {
  const item = { key: 'key', payloadHash: 'hash', formGeneration: 'generation', worker: { workerId: 'A', attemptId: 'attempt', threadId: 'thread', ownerId: 'owner', ownerEpoch: 'epoch' }, cwd: 'C:\\fixture', turnId: 'turn', requestId: 7, state: 'pending', detail: 'Exact parameters' };
  for (const kind of ['elicitation', 'command', 'permissions']) for (const choice of ['dismiss', 'accept', 'decline', 'cancel']) {
    const request = { ...item, kind };
    const replies: unknown[] = [];
    const session = { requests: async () => [request], answer: async (request: unknown, action: string) => replies.push({ request, action }) } as unknown as import('../src/managed-client').ManagedSession;
    const api = { window: {
      showQuickPick: async (items: any[]) => items[0],
      showInformationMessage: async (_message: string, options: any, ...buttons: unknown[]) => {
        if (!options?.modal) return;
        assert.ok(options.detail.includes('Thread: thread')); assert.ok(options.detail.includes('Request: 7')); assert.ok(options.detail.includes('Exact parameters'));
        assert.match(_message, /担当 A/);
        assert.ok(options.detail.indexOf('Exact parameters') < options.detail.indexOf('照合情報'));
        assert.equal((buttons[0] as { title: string }).title, kind === 'permissions' ? 'このターンだけ許可' : '今回だけ許可');
        return choice === 'dismiss' ? undefined : buttons[['accept', 'decline', 'cancel'].indexOf(choice)];
      }
    } } as unknown as typeof import('vscode');
    await reviewWorkerRequest(api, session);
    assert.deepEqual(replies, choice === 'dismiss' ? [] : [{ request, action: choice }]);
  }
});
test('explicit_stop_close_and_programmatic_dispose_do_not_duplicate_stop', async () => {
  for (const programmatic of [false, true]) {
    let pty: import('vscode').Pseudoterminal | undefined, stops = 0;
    const worker: WorkerRef = { id: 'A', pipeName: 'meristem-cc00r-dedup', cwd: 'fixture', branch: 'fixture', agent: 'mock', state: 'waiting_approval' };
    const connection: ControlConnection = { async readEvents(seq) { return { events: [], lastSeq: seq }; }, async getStatus() { return worker; }, async stop() { stops++; await new Promise(resolve => setTimeout(resolve, 10)); return { ok: true, state: 'stopped' }; }, dispose() {} };
    const api = { window: { createTerminal(options: { pty: import('vscode').Pseudoterminal }) { pty = options.pty; return { show() {}, dispose() { pty!.close?.(); } }; } } } as unknown as typeof import('vscode');
    const terminal = openWorkerTerminal(api, connection, { worker, attemptId: 'attempt' });
    if (programmatic) disposeWorkerTerminal(terminal);
    else { const pending = stopWorkerTerminal(terminal); pty!.close?.(); pty!.close?.(); await pending; }
    await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(stops, programmatic ? 0 : 1);
  }
});

test('control_response_eof_and_oversize_reject_without_hanging',async t=>{
  const pipeName=`meristem-cc00r-response-${process.pid}`;
  const sockets=new Set<Socket>();let oversized=false;
  const servers=Array.from({length:16},(_,slot)=>createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
    socket.once('data',()=>socket.end(oversized?'x'.repeat(262145):'{"state":'));
  }).listen('\\\\.\\pipe\\'+pipeName+'-'+slot));
  t.after(async()=>{for(const socket of sockets)socket.destroy();await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
  await Promise.all(servers.map(server=>new Promise<void>(resolve=>{if(server.listening)resolve();else server.once('listening',resolve);} )));
  const worker:WorkerRef={id:'A',pipeName,cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'running'};
  const connection=await connect({fixture:true,pipeName,worker,attemptId:'response'});
  for(const big of [false,true]){
    oversized=big;
    await assert.rejects(Promise.race([connection.getStatus(worker),new Promise((_,reject)=>setTimeout(()=>reject(Error('response hung')),500))]),big?/response too large/:/closed before response/);
  }
});

test('terminal display sanitizer strips control sequences and secrets', () => {
  assert.equal(sanitize('\u001b[31mred\u001b[0m Bearer abc123 api_key=secret'), 'red [redacted] [redacted]');
});

test('terminal input never dispatches and a running terminal close stops its bound worker', async () => {
  let pty: import('vscode').Pseudoterminal | undefined, stops=0, reads=0;
  const worker: WorkerRef = { id:'A', pipeName:'meristem-cc00r-fixture', cwd:'C:\\fixture', branch:'fixture', agent:'mock', state:'running' };
  const connection: ControlConnection = {
    async readEvents(afterSeq) { reads++; return { events:[], lastSeq:afterSeq }; },
    async getStatus() { return { cwd:worker.cwd, branch:worker.branch, agent:worker.agent, state:'running' }; },
    async stop(binding) { assert.equal(binding.worker.id,'A'); stops++; return { ok:true,state:'stopped' }; },
    dispose() {}
  };
  const api = { window:{ createTerminal(options: { pty: import('vscode').Pseudoterminal }) { pty=options.pty; return { show() {} }; } } } as unknown as typeof import('vscode');
  openWorkerTerminal(api,connection,{worker,attemptId:'attempt-1',fixture:true});
  pty!.open(undefined);
  pty!.handleInput?.('pasted private input');
  pty!.close?.();
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(stops,1);
  assert.equal(reads,1);
});

test('completed terminal close is display only', async () => {
  let pty: import('vscode').Pseudoterminal | undefined, stops=0;
  const worker: WorkerRef = { id:'A', pipeName:'meristem-cc00r-fixture', cwd:'C:\\fixture', branch:'fixture', agent:'mock', state:'completed' };
  const connection: ControlConnection = {
    async readEvents(afterSeq) { return {events:[],lastSeq:afterSeq}; },
    async getStatus() { return {cwd:worker.cwd,branch:worker.branch,agent:worker.agent,state:'completed'}; },
    async stop() { stops++; return {ok:true,state:'stopped'}; }, dispose() {}
  };
  const api = { window:{ createTerminal(options: { pty: import('vscode').Pseudoterminal }) { pty=options.pty; return {show(){}}; } } } as unknown as typeof import('vscode');
  openWorkerTerminal(api,connection,{worker,attemptId:'attempt-1',fixture:true}); pty!.close?.();
  await new Promise(resolve=>setTimeout(resolve,0)); assert.equal(stops,0);
});

test('stale_terminal_binding_cannot_stop_new_attempt', async () => {
  const worker: WorkerRef={id:'A',pipeName:'meristem-cc00r-stale-binding',cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'running'};
  const connection=await connect({fixture:true,pipeName:worker.pipeName,worker,attemptId:'current-attempt'} as Parameters<typeof connect>[0]);
  await assert.rejects(()=>connection.stop({fixture:true,worker,attemptId:'old-attempt'}),/stale terminal binding/);
});

test('terminal_logs_strip_control_sequences_and_secrets', () => {
  assert.equal(sanitize('safe\u001b]52;c;clipboard\u0007\b\u0000\rsuffix'), 'safesuffix');
  assert.equal(sanitize('safe\u001b]52;c;unfinished'), 'safe');
});

test('large_or_slow_terminal_output_does_not_block_rpc', async () => {
  let pty: import('vscode').Pseudoterminal | undefined, statusRead=false, displayBeforeStatus=false;
  const output: string[]=[];
  const worker: WorkerRef={id:'A',pipeName:'meristem-cc00r-bounds',cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'completed'};
  const connection: ControlConnection={
    async readEvents() { return {events:Array.from({length:20},(_,i)=>({seq:i+1,worker,text:'あ'.repeat(23000)})),lastSeq:20}; },
    async getStatus() { statusRead=true; return worker; },
    async stop() { assert.fail('completed worker must not stop'); }, dispose() {}
  };
  const api={window:{createTerminal(options:{pty:import('vscode').Pseudoterminal,isTransient:boolean}) {assert.equal(options.isTransient,true);pty=options.pty;return {show(){}};}}} as unknown as typeof import('vscode');
  openWorkerTerminal(api,connection,{worker,attemptId:'bounded',fixture:true});
  pty!.onDidWrite(value=>{ if(value.includes('あ')&&!statusRead) displayBeforeStatus=true; output.push(value); });
  pty!.open(undefined);
  await new Promise(resolve=>setTimeout(resolve,100));
  pty!.close?.();
  assert.equal(displayBeforeStatus,false,'display must not delay status RPC');
  assert.ok(output.some(v=>/events omitted/.test(v)),'queue overflow must be visible');
  assert.ok(output.some(v=>v.includes('あ')));
  assert.ok(output.every(v=>Buffer.byteLength(v)<=65536),'each rendered event must fit 64 KiB including omission text');
  assert.ok(output.filter(v=>v.includes('あ')).reduce((n,v)=>n+Buffer.byteLength(v),0)<=1048576);
  assert.ok(!output.join('').includes('\uFFFD'),'UTF-8 truncation must preserve character boundaries');
});

test('hidden_panel_does_not_stop_worker_or_end_polling_after_100_batches', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let pty: import('vscode').Pseudoterminal | undefined, reads=0,stops=0;
  const worker: WorkerRef={id:'A',pipeName:'meristem-cc00r-hidden',cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'running'};
  const connection:ControlConnection={async readEvents(afterSeq,limit){assert.equal(limit,100);reads++;return {events:[],lastSeq:afterSeq};},async getStatus(){return worker;},async stop(){stops++;return {ok:true,state:'stopped'};},dispose(){}};
  const api={window:{createTerminal(options:{pty:import('vscode').Pseudoterminal}){pty=options.pty;return {show(){},hide(){}};}}} as unknown as typeof import('vscode');
  const terminal=openWorkerTerminal(api,connection,{worker,attemptId:'hidden',fixture:true});
  pty!.open(undefined);terminal.hide();
  for(let i=0;i<105;i++){for(let j=0;j<5;j++) await Promise.resolve();t.mock.timers.tick(500);}
  assert.ok(reads>100,'100 is a batch size, not a lifetime limit');assert.equal(stops,0);
  pty!.close?.();await Promise.resolve();await Promise.resolve();assert.equal(stops,1);
});

test('unknown_stop_result_keeps_polling_until_confirmed',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let pty:import('vscode').Pseudoterminal|undefined,reads=0;
  const worker:WorkerRef={id:'A',pipeName:'meristem-cc00r-unknown-stop',cwd:'C:\\fixture',branch:'fixture',agent:'mock',state:'running'};
  const connection:ControlConnection={async readEvents(afterSeq){reads++;return {events:[],lastSeq:afterSeq};},async getStatus(){return worker;},async stop(){return {ok:false,state:'unknown'};},dispose(){}};
  const api={window:{createTerminal(options:{pty:import('vscode').Pseudoterminal}){pty=options.pty;return {show(){}};}}} as unknown as typeof import('vscode');
  const terminal=openWorkerTerminal(api,connection,{worker,attemptId:'unknown-stop',fixture:true});
  t.after(()=>pty!.close?.());pty!.open(undefined);await Promise.resolve();await Promise.resolve();
  await stopWorkerTerminal(terminal);const before=reads;
  t.mock.timers.tick(500);await Promise.resolve();await Promise.resolve();
  assert.ok(reads>before,'unknown stop must continue reconciliation');
});

test('display_accepts_exact_64KiB_and_1MiB_and_counts_only_overflow',async()=>{
  for(const count of [16,17]){
    let pty:import('vscode').Pseudoterminal|undefined;
    const output:string[]=[],worker:WorkerRef={id:'A',pipeName:'meristem-cc00r-exact',cwd:'fixture',branch:'fixture',agent:'mock',state:'completed'};
    const connection:ControlConnection={async readEvents(){return {events:[],lastSeq:0};},async getStatus(){return worker;},async stop(){assert.fail('completed');},dispose(){}};
    const api={window:{createTerminal(options:{pty:import('vscode').Pseudoterminal}){pty=options.pty;return {show(){}};}}} as unknown as typeof import('vscode');
    openWorkerTerminal(api,connection,{worker,attemptId:'boundary',fixture:true});pty!.onDidWrite(v=>output.push(v));pty!.open(undefined);
    await nextDraw(); output.length=0;
    for(let i=0;i<count;i++)publishWorkerEvent({seq:i+1,worker,text:'x'.repeat(65534)+'\n'});
    await new Promise(resolve=>setTimeout(resolve,80));pty!.close?.();
    const logs=output.filter(v=>v.startsWith('x'));assert.equal(logs.length,16);assert.equal(logs.reduce((n,v)=>n+Buffer.byteLength(v),0),1048576);
    assert.ok(logs.every(v=>v.length===65536&&!v.includes('oversized')));
    assert.equal(output.some(v=>v.includes('[1 events omitted;')),count===17);
  }
});

test('explicit_stop_and_extension_deactivation_stop_bound_fixture_workers',async t=>{
  const loader=require('node:module');const original=loader._load;
  const commands=new Map<string,()=>Promise<void>>();let stops=0;
  const terminal={show(){}};
  const api={commands:{registerCommand(name:string,handler:()=>Promise<void>){commands.set(name,handler);return {dispose(){}};}},workspace:extensionWorkspace,window:{activeTerminal:terminal,async showInputBox(){return 'meristem-cc00r-lifecycle';},createTerminal(){return terminal;},onDidCloseTerminal(){return {dispose(){}};},async showErrorMessage(){assert.fail('unexpected error');}}};
  t.mock.method(loader,'_load',function(name:string,...args:unknown[]){return name==='vscode'?api:original.call(loader,name,...args);});
  t.mock.method(controlClient,'connect',async()=>({async readEvents(){return {events:[],lastSeq:0};},async getStatus(){return {cwd:'fixture',branch:'fixture',agent:'mock / low (requested)',state:'running'};},async stop(){stops++;return {ok:true,state:'stopped'};},dispose(){}}));
  const extension=require('../src/extension');extension.activate({subscriptions:[]});
  await commands.get('meristem.chatControl.openFixture')!();
  assert.ok(commands.has('meristem.chatControl.stopFixture'));
  await commands.get('meristem.chatControl.stopFixture')!();assert.equal(stops,1);
  await extension.deactivate();assert.equal(stops,2);
  await extension.deactivate();assert.equal(stops,2);
});

test('confirmed_stop_and_published_events_update_the_remaining_terminal',async t=>{
  const loader=require('node:module'),original=loader._load,commands=new Map<string,()=>Promise<void>>(),output:string[]=[];
  let pty:import('vscode').Pseudoterminal|undefined;
  const terminal={show(){}};
  const api={commands:{registerCommand(name:string,handler:()=>Promise<void>){commands.set(name,handler);return {dispose(){}};}},workspace:extensionWorkspace,window:{activeTerminal:terminal,async showInputBox(){return 'meristem-cc00r-state';},createTerminal(options:{pty:import('vscode').Pseudoterminal}){pty=options.pty;return terminal;},onDidCloseTerminal(){return {dispose(){}};},async showErrorMessage(){assert.fail('unexpected error');}}};
  t.mock.method(loader,'_load',function(name:string,...args:unknown[]){return name==='vscode'?api:original.call(loader,name,...args);});
  t.mock.method(controlClient,'connect',async()=>({async readEvents(){return {events:[],lastSeq:0};},async getStatus(){return {cwd:'fixture',branch:'fixture',agent:'mock',state:'running'};},async stop(){return {ok:true,state:'stopped'};},dispose(){}}));
  delete require.cache[require.resolve('../src/extension')];const extension=require('../src/extension');extension.activate({subscriptions:[]});await commands.get('meristem.chatControl.openFixture')!();
  t.after(async()=>{pty?.close?.();await extension.deactivate();});
  let displayed!:()=>void;
  const stoppedDisplayed=new Promise<void>(resolve=>{displayed=resolve;});
  pty!.onDidWrite(text=>{output.push(text);if(text.includes('停止済み'))displayed();});pty!.open(undefined);await Promise.resolve();await Promise.resolve();
  publishWorkerEvent({seq:1,worker:{id:'fixture',pipeName:'meristem-cc00r-state',cwd:'fixture',branch:'fixture',agent:'mock',state:'running'},text:'safe event'});
  await commands.get('meristem.chatControl.stopFixture')!();
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([stoppedDisplayed,new Promise<void>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('stop state was not rendered')),2000);})]);}
  finally{clearTimeout(deadline);}
  await nextDraw(); // Status has priority; recorded events drain afterward.
  assert.ok(output.some(v=>v.includes('停止済み')),'confirmed stop must update the visible state even after the host pipe closes');
  assert.ok(output.some(v=>v==='safe event\r\n'),'published events need their own line');
  pty!.close?.();await extension.deactivate();
});
test('the run entry, usage and progress are available from VS Code', () => {
  const manifest = require('../../package.json');
  assert.ok(!(manifest.activationEvents ?? []).some((event: string) => event === '*' || event === 'onStartupFinished' || event.startsWith('workspaceContains:')), 'ordinary windows should not activate Meristem');
  const commands = manifest.contributes.commands.map((item: { command: string }) => item.command);
  for (const name of ['startRun', 'newTerminalRun', 'usage', 'progress', 'stopRun']) assert.ok(commands.includes('meristem.chatControl.' + name), name);
});
test('start stays in the selected window and skips discovery for missing or cancelled folders', async t => {
  const loader = require('node:module'), original = loader._load, commands = new Map<string, () => Promise<void>>();
  const messages: string[] = [];
  const workspace = { ...extensionWorkspace, isTrusted: true, workspaceFolders: [] as { name: string; uri: { scheme: string; fsPath: string } }[],
    getConfiguration() { assert.fail('a folder must be selected before looking for its relay'); } };
  let picked = 0;
  const api = { workspace, commands: { registerCommand(id: string, handler: () => Promise<void>) { commands.set(id, handler); return { dispose() {} }; } },
    window: { onDidCloseTerminal() { return { dispose() {} }; }, showWarningMessage(message: string) { messages.push(message); },
      showQuickPick(items: {label: string}[]) { picked++; assert.deepEqual(items.map(i => i.label), ['A','B']); return undefined; } } };
  t.mock.method(loader, '_load', function(name: string, ...args: unknown[]) { return name === 'vscode' ? api : original.call(loader, name, ...args); });
  delete require.cache[require.resolve('../src/extension')];
  const extension = require('../src/extension'); extension.activate({ subscriptions: [] });
  t.after(async () => { await extension.deactivate(); delete require.cache[require.resolve('../src/extension')]; });
  const start = commands.get('meristem.chatControl.startRun')!;
  await start(); assert.match(messages[0], /フォルダー/);
  workspace.workspaceFolders = ['A','B'].map(name => ({ name, uri: { scheme: 'file', fsPath: name } }));
  await start(); assert.equal(picked, 1);
});

test('start confirmation shows the bound scope and only submits a current approved preview', async () => {
  const { confirmStart, usageText } = await import('../src/run-window');
  const preview = { runId: 'run', parent: {threadId:'conversation',ownerId:'o',ownerEpoch:'epoch'}, scopeHash:'digest',
    tasks: { count: 3, names: ['資料の確認','変更内容の確認','結果の報告'] },
    scope: {repositoryPath:'repository', planPath:'plan.md', branchScope:['integration'], permissionPermit:{allowedProfileIds:['read-only'], allowedReviewers:['user'], writableRoots:['trees']},
      planScope:{planVersion:2,integrationBranch:'integration',gitDestination:'destination',worktreesRoot:'trees',requestedMaximum:4,approvedMaximum:2}} };
  for (const [clicked, current] of [[false,true],[true,false],[true,true]]) {
    let submissions = 0;
    const api = { window: { showInformationMessage(_message: string, options?: {detail:string}, button?: string) {
      if (options) {
        assert.match(_message, /repository/);
        for (const detail of ['plan.md','資料の確認','最大2人','読み取り','報告']) assert.ok(options.detail.includes(detail), detail);
        assert.doesNotMatch(options.detail, /conversation|allowedProfileIds|コミット|push/);
        assert.equal(button, 'この範囲で開始');
        return clicked ? button : undefined;
      }
    } } } as unknown as typeof import('vscode');
    await confirmStart(api, { start: async (value: unknown) => { assert.equal(value, preview); submissions++; } } as managedClient.ManagedSession,
      preview, () => current);
    assert.equal(submissions, clicked && current ? 1 : 0);
  }
  let page = 0;
  const editing = {...preview, scope:{...preview.scope, permissionPermit:{allowedProfileIds:['workspace'], allowedReviewers:['user'], writableRoots:['trees']}, planScope:{...preview.scope.planScope, scopedGitSave:true,
    gitDestination:'https://name:private-token@example.com/destination.git?key=private-key#private-fragment'}}};
  const detailsApi = {window:{showInformationMessage(title:string, options:{detail:string}, first:string, second?:string) {
    page++;
    assert.doesNotMatch(options.detail, /private-|name:/);
    if (page === 1) {
      assert.match(options.detail, /編集/);
      assert.match(options.detail, /コミット/);
      assert.match(options.detail, /destination/);
      return second;
    }
    if (page === 2) {
      for (const item of ['trees','destination','conversation','integration']) assert.ok(options.detail.includes(item),item);
      return first;
    }
    return undefined;
  }}} as unknown as typeof import('vscode');
  await confirmStart(detailsApi, {start: async()=>assert.fail('viewing details cannot authorize')} as unknown as managedClient.ManagedSession, editing, ()=>true);
  assert.equal(page,3);
  const zero = {...preview, tasks:{count:1, names:['資料\u202e\u2028の確認']}, scope:{...preview.scope,maxInstructions:0}};
  await confirmStart({window:{showInformationMessage(_title:string, options:{detail:string}){
    assert.match(options.detail,/接続と確認のみ/);
    assert.match(options.detail,/指示は0回/);
    assert.doesNotMatch(options.detail,/[\u202e\u2028]/);
  }}} as unknown as typeof import('vscode'), {} as managedClient.ManagedSession, zero, ()=>true);
  const capacity = { windows:[{usedPercent:80,remainingPercent:20,resetsAt:null,windowDurationMins:null}], fetchedAt:null,
    requestedMaximum:128,approvedMaximum:2,effectiveMaximum:1,quotaMaximum:1,activeWorkers:0,reason:'low_remaining',usageStatus:'ok' };
  assert.match(usageText(capacity, true), /使用 80%　残り 20%　リセット 不明/);
  assert.doesNotMatch(usageText(capacity, false), /128/);
});
