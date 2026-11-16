import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { connect } from '../spikes/chat-control/relay-client.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';

const root = path.resolve('.local/chat-control/tests');
mkdirSync(root, { recursive: true });
const build = path.resolve('.local/chat-control-build');

test('wake_diagnostics_distinguish_pending_UI_from_unsupported_queue_without_payloads', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  const threadId = (await c.call('thread/start', { cwd: f.dir })).result.thread.id;
  f.send(990, 'model/list', { cursor: 'hold-for-collision', privateValue: 'must-not-be-recorded' });
  await delay(30);
  const busy = (await c.call('relay/status')).result;
  assert.equal(busy.wakeGate.pendingUiCount, 1);
  assert.deepEqual(busy.wakeGate.pendingUiMethods, ['model/list']);
  assert(!JSON.stringify(busy).includes('must-not-be-recorded'));
  await f.reply(990);
  assert.equal((await c.call('relay/status')).result.wakeGate.pendingUiCount, 0);
  f.send(991, 'turn/queue', { threadId }); await f.reply(991);
  const queued = (await c.call('relay/status')).result;
  assert.deepEqual(queued.wakeGate.unsupportedThreads, [threadId]);
  assert(queued.events.some(e => e.method === 'ui/wake-unsupported' && e.status === 'turn/queue'));
});
test('wake_compare_and_swap_blocks_human_input_active_queue_and_stopped_parent', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  const threadId = (await c.call('thread/start', { cwd: f.dir })).result.thread.id;
  await c.call('model/list');
  const owner = (await c.call('relay/status')).result;
  const actor = { threadId, ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch };
  const idle = (await c.call('relay/wake-state', actor)).result;
  assert.equal(idle?.idle, true);
  const request = { ...actor, stateSeq: idle.stateSeq, operationId: 'wake1', runId: 'run', sourceEventSeq: 1, model: 'mock', effort: 'low' };
  f.send(801, 'turn/start', { threadId, input: [], model: 'mock', effort: 'low' }); await f.reply(801);
  assert.equal((await c.call('relay/wake', request)).result.state, 'deferred');
  f.send(802, 'turn/interrupt', { threadId, turnId: 'human-stop' }); await f.reply(802);
  assert.equal((await c.call('relay/wake-state', actor)).result.supported, false);
});
test('wake_starts_once_without_steering_and_completion_before_ack_remains_idle', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  const threadId = (await c.call('thread/start', { cwd: f.dir })).result.thread.id;
  await c.call('model/list'); writeFileSync(path.join(f.dir, 'complete-turn'), '');
  const owner = (await c.call('relay/status')).result;
  const actor = { threadId, ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch };
  const idle = (await c.call('relay/wake-state', actor)).result;
  assert.equal(idle?.idle, true);
  const request = { ...actor, stateSeq: idle.stateSeq, operationId: 'wake1', runId: 'run', sourceEventSeq: 1, model: 'mock', effort: 'low' };
  assert.equal((await c.call('relay/wake', request)).result.state, 'acked');
  assert.equal((await c.call('relay/wake', request)).result.state, 'deferred');
  assert.equal((await c.call('relay/wake-state', actor)).result.idle, true);
  await c.call('relay/wake-block', { threadId });
  assert.equal((await c.call('relay/wake-state', actor)).result.supported, false);
  await c.call('relay/wake-resume', { threadId });
  assert.equal((await c.call('relay/wake', request)).result.state, 'deferred');
  assert.equal((await c.call('relay/wake-state', actor)).result.idle, true);
  f.send(803, 'turn/queue', { threadId }); await f.reply(803);
  assert.equal((await c.call('relay/wake-state', actor)).result.supported, false);
  assert((await c.call('relay/wake-resume', { threadId })).error);
});
async function until(read, predicate = Boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw Error('Timed out waiting for fixture');
}
async function fixture(t, args = ['app-server'], config = {}) {
  assert(existsSync(path.join(build, 'CodexRelay.exe')), 'Build native relay first');
  const dir = mkdtempSync(path.join(root, '試験 space-'));
  const exe = path.join(dir, '中継 relay.exe'), real = path.join(dir, '本物 mock.exe');
  copyFileSync(path.join(build, 'CodexRelay.exe'), exe);
  copyFileSync(path.join(build, 'MockCodex.exe'), real);
  const pipe = 'meristem-cc00-test-' + randomUUID();
  writeFileSync(exe + '.json', JSON.stringify({ realExecutable: real,
    realSha256: createHash('sha256').update(readFileSync(real)).digest('hex'), pipeName: pipe,
    allowedCwds: [dir], testProfile: 'CC-00-fixture', ...config }));
  const child = spawn(exe, args, { cwd: dir, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  const output = [], errors = [];
  child.stdout.on('data', b => output.push(b)); child.stderr.on('data', b => errors.push(b));
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  const bytes = () => Buffer.concat(output), stderr = () => Buffer.concat(errors).toString();
  const lines = () => bytes().toString().split('\n').filter(Boolean).map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
  t.after(async () => { child.stdin.destroy(); child.kill(); await closed; });
  const send = (id, method, params = {}) => child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  const reply = id => until(() => lines().find(m => m.id === id));
  async function management() {
    await until(() => stderr().includes('pipe-ready'));
    const control = await connect(pipe); t.after(() => control.socket.destroy()); return control;
  }
  async function ready() {
    send(10, 'initialize', { clientInfo: { name: 'fixture', version: '0' }, capabilities: { experimentalApi: false } });
    await reply(10); child.stdin.write('{"method":"initialized"}\n');
    return management();
  }
  return { child, closed, dir, pipe, exe, real, send, reply, bytes, stderr, lines, ready, management };
}

test('preserves_native_argv_and_stdio', { timeout: 20000 }, async t => {
  const args = ['inspect', '', '日本語 space', 'with"quote', 'trailing space\\', '\\"終'];
  const f = await fixture(t, args);
  f.child.stdin.write(Buffer.from('入力\0bytes\r\n'));
  f.child.stdin.end();
  const exit = await f.closed;
  assert.equal(exit.code, 23, f.stderr());
  const line = f.bytes().toString().split('\n')[0];
  assert.deepEqual(JSON.parse(line).argv, args);
  assert(f.bytes().subarray(Buffer.byteLength(line) + 1).equals(Buffer.from('入力\0bytes\r\n')));
  assert.match(f.stderr(), /mock-stderr/);
});

test('unverified_codex_upgrade_disables_management', { timeout: 20000 }, async t => {
  const f = await fixture(t, ['app-server'], { realSha256: '0'.repeat(64) });
  f.send(10, 'initialize', { clientInfo: { name: 'fixture', version: '0' } });
  assert((await f.reply(10)).result, 'ordinary parent transport remains available');
  f.send(11, 'model/list'); assert((await f.reply(11)).result.data);
  await assert.rejects(connect(f.pipe));
  assert.match(f.stderr(), /management disabled/);
});

test('workspace_write_requires_explicit_matching_CC00R_profile', { timeout: 20000 }, async t => {
  const normal=await fixture(t), c=await normal.ready();
  assert((await c.call('thread/start',{cwd:normal.dir,permissions:':workspace'})).error);
  const f=await fixture(t,['app-server'],{testProfile:'CC-00R-fixture',testPermissions:':workspace'}), managed=await f.ready();
  assert((await managed.call('thread/start',{cwd:f.dir,permissions:':danger-full-access'})).error);
  assert((await managed.call('thread/start',{cwd:f.dir,sandbox:'workspace-write'})).error);
  assert((await managed.call('permissionProfile/list',{cwd:path.dirname(f.dir)})).error);
  assert((await managed.call('thread/start',{cwd:f.dir,permissions:':workspace'})).result?.thread?.id);
});
test('routes_only_own_rpc_replies', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  f.send(1, 'model/list');
  const result = await c.call('model/list', {}, 1);
  assert(result.result.data); assert((await f.reply(1)).result.data);
  assert.equal(f.lines().filter(m => m.id === 1).length, 1);
  assert(!f.bytes().includes(Buffer.from('cc00:')));
  f.child.stdin.write('{"id":"cc00:same-shape:1","method":"model/list","params":{}}\n');
  assert((await f.reply('cc00:same-shape:1')).result.data);
});

test('exact_pending_management_id_collision_restores_only_the_UI_reply', {timeout:20000},async t=>{
  const f=await fixture(t),c=await f.ready();
  const epoch=(await c.call('relay/status')).result.ownerEpoch;
  const pending=c.call('model/list',{cursor:'hold-for-collision'});
  await delay(100);
  const exact=`cc00:${epoch}:1`;
  f.send(exact,'echo',{text:'UI collision response'});
  assert((await pending).result.data);
  assert.equal((await f.reply(exact)).result.text,'UI collision response');
  assert.equal(f.lines().filter(m=>m.id===exact).length,1);
  assert(!f.bytes().includes(Buffer.from('supportedReasoningEfforts')));
});

test('changed_malformed_management_envelope_never_leaks_private_payload', {timeout:20000},async t=>{
  const f=await fixture(t),c=await f.ready();
  const reply=await c.call('model/list',{cursor:'changed-envelope'}).catch(error=>({error}));
  await f.closed;assert(reply.error);
  assert(!f.bytes().includes(Buffer.from('management-private-payload')));
});
test('does_not_interleave_partial_jsonl', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  const line = Buffer.from(JSON.stringify({ id: 12, method: 'echo', params: { text: '日本語' } }) + '\n');
  const split = line.indexOf(Buffer.from('日本語')) + 1;
  f.child.stdin.write(line.subarray(0, split));
  const pending = c.call('model/list');
  await delay(60); f.child.stdin.write(line.subarray(split));
  assert.equal((await f.reply(12)).result.text, '日本語');
  assert((await pending).result.data);
});
test('oversized_frame_disables_management_without_blocking_ui', { timeout: 30000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  f.send(13, 'large');
  await until(() => f.bytes().length, n => n > 8 * 1024 * 1024);
  assert.equal((await f.reply(13)).result.length, 8 * 1024 * 1024 + 17);
  const status = await c.call('relay/status');
  assert.equal(status.result.managementEnabled, false);
  assert((await c.call('model/list')).error);
  f.send(14, 'echo', { text: 'UI remains usable' });
  assert.equal((await f.reply(14)).result.text, 'UI remains usable');
});
test('keeps_ui_transport_when_side_channel_fails', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  c.socket.write('{broken\n'); c.socket.destroy();
  f.send(15, 'echo', { text: '正常' }); assert.equal((await f.reply(15)).result.text, '正常');
  const next = await f.management(); assert((await next.call('relay/status')).result.ownerEpoch);
});

test('interrupt_ack_is_not_process_stop', {timeout:20000},async t=>{
  const f=await fixture(t),c=await f.ready(),marker=path.join(f.dir,'interrupt.marker');
  const thread=(await c.call('thread/start',{cwd:f.dir})).result.thread.id;await c.call('model/list');
  const turn=(await c.call('turn/start',{threadId:thread,input:[],model:'mock',effort:'low'})).result.turn.id;
  f.send(61,'spawn',{marker});await f.reply(61);await until(()=>existsSync(marker));
  assert((await c.call('turn/interrupt',{threadId:thread,turnId:turn})).result);
  const before=readFileSync(marker).length;await delay(200);assert(readFileSync(marker).length>before,'RPC ack alone leaves the actual process alive');
  f.child.kill();await f.closed;const stopped=readFileSync(marker).length;await delay(200);assert.equal(readFileSync(marker).length,stopped);
});
test('exits_owned_children_without_killing_control_process', { timeout: 20000 }, async t => {
  const f = await fixture(t); await f.ready();
  const marker = path.join(f.dir, 'ticks');
  const controlMarker = path.join(f.dir, 'control-ticks');
  const control = spawn(f.real, ['ticker', controlMarker], { windowsHide: true, stdio: 'ignore' });
  t.after(() => control.kill());
  f.send(16, 'spawn', { marker }); await f.reply(16);
  await until(() => existsSync(marker) && existsSync(controlMarker));
  f.child.kill(); await f.closed; await delay(150);
  const owned = readFileSync(marker).length, other = readFileSync(controlMarker).length;
  await delay(250);
  assert.equal(readFileSync(marker).length, owned);
  assert(readFileSync(controlMarker).length > other);
});
test('restricts_targets_methods_and_exposes_actual_acl', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  const status = (await c.call('relay/status')).result;
  assert.equal(status.jobAssigned, true); assert.match(status.pipeAcl, /SY/);
  assert(!status.pipeAcl.includes(';;;WD)')); assert(!status.pipeAcl.includes(';;;BU)'));
  assert((await c.call('turn/start', { threadId: 'unregistered', input: [] })).error);
  assert((await c.call('thread/start', { cwd: f.dir, approvalsReviewer: 'user' })).error);
  assert((await c.call('thread/archive', { threadId: 'unregistered' })).error);
  assert((await c.call('thread/start', { cwd: path.dirname(f.dir) })).error);
  const created = (await c.call('thread/start', { cwd: f.dir })).result;
  assert(created.thread.id);
  assert((await c.call('turn/start', { threadId: created.thread.id, input: [], model: 'invalid', effort: 'low' })).error);
  await c.call('model/list');
  assert((await c.call('turn/start', { threadId: created.thread.id, input: [], model: 'mock', effort: 'invalid' })).error);
  const started = await c.call('turn/start', { threadId: created.thread.id, input: [], model: 'mock', effort: 'low' });
  assert(started.result.turn.id);
  assert((await c.call('turn/start', { threadId: created.thread.id, input: [], model: 'mock', effort: 'low' })).error,'busy thread must reject a second start');
  assert((await c.call('turn/interrupt', { threadId: created.thread.id, turnId: 'wrong' })).error);
  assert((await c.call('turn/interrupt', { threadId: created.thread.id, turnId: started.result.turn.id })).result);
});
test('recognizes_the_measured_extension_launch_without_changing_argv', { timeout: 20000 }, async t => {
  const f = await fixture(t, ['-c', 'features.code_mode_host=true', '-c', 'features.windows_sandbox_service=true', 'app-server', '--analytics-default-enabled']);
  const c = await f.ready();
  assert.equal((await c.call('relay/status')).result.initialized, true);
});
test('never_leaks_an_oversized_management_reply_to_the_ui', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  const created = (await c.call('thread/start', { cwd: f.dir })).result;
  const reply = await c.call('thread/read', { threadId: created.thread.id, includeTurns: true });
  assert(reply.error);
  f.send(22, 'echo', { text: 'still working' });
  assert.equal((await f.reply(22)).result.text, 'still working');
  assert(!f.bytes().includes(Buffer.from('management-private-payload')));
});
test('never_leaks_an_unterminated_management_reply_on_eof', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  const created = (await c.call('thread/start', { cwd: f.dir })).result;
  const reply = await c.call('thread/read', { threadId: created.thread.id, includeTurns: false })
    .catch(error => { assert.match(error.message, /outcome unknown/); return { error }; });
  await f.closed;
  assert(reply.error);
  assert(!f.bytes().includes(Buffer.from('management-private-payload')));
  assert(!f.bytes().includes(Buffer.from('cc00:')));
});
test('never_leaks_a_malformed_owned_management_reply', { timeout: 20000 }, async t => {
  const f = await fixture(t), c = await f.ready();
  const created = (await c.call('thread/start', { cwd: f.dir })).result;
  const reply = await c.call('thread/read', { threadId: created.thread.id })
    .catch(error => { assert.match(error.message, /outcome unknown/); return { error }; });
  await f.closed;
  assert(reply.error);
  assert(!f.bytes().includes(Buffer.from('management-private-payload')));
});
test('transport_runner_records_failure_on_early_exit', { timeout: 10000 }, () => {
  const evidence = path.join(root, 'runner-exit.json');
  const result = spawnSync(process.execPath, ['spikes/chat-control/relay-probe.mjs', '--live', '--case', 'transport',
    '--real-exe', path.join(build, 'MockCodex.exe'), '--evidence', evidence],
  { encoding: 'utf8', windowsHide: true, timeout: 6000, env: { ...process.env, CC00_MOCK_INIT: 'exit' } });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(readFileSync(evidence)).result, 'failed');
});
test('transport_runner_records_failure_on_timeout', { timeout: 10000 }, () => {
  const evidence = path.join(root, 'runner-timeout.json');
  const result = spawnSync(process.execPath, ['spikes/chat-control/relay-probe.mjs', '--live', '--case', 'transport',
    '--real-exe', path.join(build, 'MockCodex.exe'), '--evidence', evidence, '--timeout-ms', '700'],
  { encoding: 'utf8', windowsHide: true, timeout: 6000, env: { ...process.env, CC00_MOCK_INIT: 'silent' } });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(readFileSync(evidence)).result, 'failed');
});
test('restore_ui_preserves_unrelated_profile_edits', () => {
  const base = path.resolve('.local/chat-control/CC-00'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'restore-'));
  const profile = path.join(dir, 'profile'); mkdirSync(path.join(profile, 'User'), { recursive: true });
  const file = path.join(profile, 'User', 'settings.json');
  writeFileSync(file, JSON.stringify({ 'chatgpt.cliExecutable': 'fixture.exe', 'window.title': 'user-edited', 'editor.fontSize': 18 }));
  const session = path.join(dir, 'session.json');
  writeFileSync(session, JSON.stringify({ testId: 'CC-00-restore-fixture', root: dir, profile, originalSettings: {},
    installedSettings: { 'chatgpt.cliExecutable': 'fixture.exe', 'window.title': 'test' } }));
  const result = spawnSync(process.execPath, ['spikes/chat-control/relay-probe.mjs', '--live', '--case', 'restore-ui', '--session', session], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(file)), { 'window.title': 'user-edited', 'editor.fontSize': 18 });
});
