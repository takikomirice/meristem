import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { pipeRequest, relayRequest } from '../src/protocol.js';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
export async function launchControl(t: { after(fn: () => Promise<void>): void }, forgePeer = false, parentRelay = false, complete = false) {
  const base = mkdtempSync(path.join(tmpdir(), 'cc01-control-')), state = path.join(base, 'state');
  const hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe'), realExe = path.resolve('.local/chat-control-build/MockCodex.exe');
  const assignments = ['A', 'B'].map(workerId => ({ workerId, cwd: mkdtempSync(path.join(tmpdir(), 'cc01-cwd-')), model: 'mock', effort: 'low', branch: 'fixture', repositoryId: 'repo' }));
  assignments.forEach(a => writeFileSync(path.join(a.cwd, 'uncommitted.txt'), 'keep'));
  if (complete) assignments.forEach(a => writeFileSync(path.join(a.cwd, 'complete-turn'), 'fixture'));
  const entryPoint = path.resolve('dist/src/cli.js'), configPath = path.join(base, 'config.json');
  const config = { stateDirectory: state, repository: process.cwd(), runId: 'run', pipeName: `meristem-cc01-control-${randomUUID()}`, nodeExecutable: process.execPath, nodeSha256: sha(process.execPath), entryPoint, entrySha256: sha(entryPoint), runtime: { stateDirectory: state, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: base, fixture: true }, assignments };
  if (forgePeer) writeFileSync(path.join(assignments[0].cwd, 'peer-pipe.txt'), config.pipeName);
  writeFileSync(configPath, JSON.stringify(config));
  let executable = path.resolve('.local/chat-control-build/MeristemControl.exe'), args = ['--config', configPath];
  if (parentRelay) {
    const relay = path.join(base, 'CodexRelay.exe'); copyFileSync(path.resolve('.local/chat-control-build/CodexRelay.exe'), relay);
    writeFileSync(relay + '.json', JSON.stringify({ realExecutable: realExe, realSha256: sha(realExe), pipeName: `meristem-cc00-${randomUUID()}`, allowedCwds: [base], testProfile: 'CC-00R-parent-fixture', controlHost: { executable, sha256: sha(executable), configPath, configSha256: sha(configPath), parentThreadId: 'parent-thread' } }));
    executable = relay; args = ['app-server'];
  }
  const child = spawn(executable, args, { windowsHide: true, stdio: 'pipe' });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => { child.stdin.end(); for (let i = 0; i < 100 && child.exitCode === null; i++) await delay(50); if (child.exitCode === null && !child.signalCode) child.kill(); });
  for (let i = 0; i < 150 && !existsSync(path.join(state, 'discovery.json')); i++) { if (child.exitCode !== null) throw new Error(`control exited: ${errors}`); await delay(50); }
  assert(existsSync(path.join(state, 'discovery.json')), errors);
  const discovery = JSON.parse(readFileSync(path.join(state, 'discovery.json'), 'utf8'));
  return { child, state, assignments, discovery, configPath, output: () => output, async request(method: string, extra = {}) { try { return await pipeRequest(discovery.pipeName, { ...discovery, method, ...extra }); } catch (error) { throw new Error(`${String(error)}; host exit=${child.exitCode}/${child.signalCode}; ${errors}`); } } };
}
test('local_status_and_stop_use_native_gateway_and_persist_cleanup', { timeout: 20000 }, async t => {
  const f = await launchControl(t);
  const status = await f.request('status'); assert.equal((status.run as any).state, 'active');
  const cli = spawnSync(process.execPath, ['dist/src/cli.js', 'status', '--run', 'run', '--state', f.state], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0); assert.equal(JSON.parse(cli.stdout).attempts.length, 2);
  const stop = await f.request('stop'); assert.equal((stop.run as any).state, 'stopped');
  assert((stop.results as any[]).every(r => r.state === 'stopped'));
  for (const a of f.assignments) assert.equal(readFileSync(path.join(a.cwd, 'uncommitted.txt'), 'utf8'), 'keep');
});

test('read_only_observers_do_not_terminate_native_gateway', { timeout: 30000 }, async t => {
  const f = await launchControl(t, false, false, true);
  for (let i = 0; i < 100; i++) {
    const results = await Promise.all([f.request('status'), f.request('events', { afterSeq: 0, limit: 100 }), f.request('status')]);
    assert(results.every(result => result.ok === true));
  }
  assert.equal(f.child.exitCode, null);
  assert.equal(((await f.request('status')).run as any).state, 'active');
});

test('parent_status_distinguishes_owned_control_exit_and_rejected_wake_peer', { timeout: 20000 }, async t => {
  const f = await launchControl(t, false, true);
  const config = JSON.parse(readFileSync(path.join(path.dirname(f.configPath), 'CodexRelay.exe.json'), 'utf8'));
  const before = await relayRequest(config.pipeName, 'relay/status');
  assert.equal(before.controlHost.exited, false);
  assert.equal(before.controlHost.exitCode, null);
  await assert.rejects(relayRequest(config.pipeName, 'relay/wake-state', {}), /parent proof unavailable/);
  const rejected = await relayRequest(config.pipeName, 'relay/status');
  assert.equal(rejected.wakePeerRejected, 1);
  assert.equal(rejected.wakePeerAccepted, 0);
  process.kill(before.controlHost.pid);
  let after;
  for (let i = 0; i < 100; i++) { after = await relayRequest(config.pipeName, 'relay/status'); if (after.controlHost.exited) break; await delay(25); }
  assert.equal(after.controlHost.exited, true);
  assert.equal(typeof after.controlHost.exitCode, 'number');
  assert.equal(f.child.exitCode, null);
});
test('native_lease_disconnect_stops_all_workers', { timeout: 20000 }, async t => {
  const f = await launchControl(t);
  const socket = net.connect(`\\\\.\\pipe\\${f.discovery.pipeName}-15`);
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.once('connect', () => socket.write(JSON.stringify({ ...f.discovery, method: 'lease' }) + '\n')); socket.once('data', chunk => { assert.equal(JSON.parse(chunk.toString()).ok, true); resolve(); }); });
  socket.destroy();
  let status: any;
  for (let i = 0; i < 200; i++) { status = await f.request('status'); if (status.attempts.every((a: any) => a.state === 'stopped')) break; await delay(50); }
  assert.equal(status.run.state, 'needs_reconcile'); assert(status.attempts.every((a: any) => a.state === 'stopped'));
});
test('forged_owner_epoch_is_rejected_by_control_gateway', { timeout: 15000 }, async t => {
  const f = await launchControl(t), rejected = await f.request('stop', { ownerEpoch: 'old' });
  assert.equal(rejected.ok, false); assert.equal(((await f.request('status')).run as any).state, 'active');
});
test('forged_worker_peer_cannot_control_parent', { timeout: 15000 }, async t => {
  const f = await launchControl(t, true);
  const result = JSON.parse(readFileSync(path.join(f.assignments[0].cwd, 'peer-result.json'), 'utf8'));
  assert.equal(result.error, 'worker_peer_denied');
  assert.equal(((await f.request('status')).run as any).state, 'active');
});
test('broker_death_restart_keeps_unknown_and_does_not_relaunch_work', { timeout: 20000 }, async t => {
  const f = await launchControl(t);
  for (let i = 0; i < 100 && !f.assignments.every(a => existsSync(path.join(a.cwd, 'worker.marker'))); i++) await delay(30);
  assert(f.assignments.every(a => existsSync(path.join(a.cwd, 'worker.marker'))));
  f.child.kill();
  for (let i = 0; i < 100 && f.child.exitCode === null && f.child.signalCode === null; i++) await delay(50);
  await delay(300);
  const markers = f.assignments.map(a => path.join(a.cwd, 'worker.marker')), before = markers.map(p => readFileSync(p).length);
  await delay(2000); assert.deepEqual(markers.map(p => readFileSync(p).length), before);
  const offline = spawnSync(process.execPath, ['dist/src/cli.js', 'status', '--run', 'run', '--state', f.state], { encoding: 'utf8', windowsHide: true });
  assert.equal(offline.status, 2); assert.equal(JSON.parse(offline.stdout).state, 'needs_reconcile');
  const restarted = spawn(path.resolve('.local/chat-control-build/MeristemControl.exe'), ['--config', f.configPath], { windowsHide: true, stdio: 'pipe' }); restarted.stdout.resume(); restarted.stderr.resume();
  t.after(async () => { restarted.stdin.end(); for (let i = 0; i < 100 && restarted.exitCode === null; i++) await delay(50); if (restarted.exitCode === null && !restarted.signalCode) restarted.kill(); });
  let discovery: any;
  for (let i = 0; i < 100; i++) { discovery = JSON.parse(readFileSync(path.join(f.state, 'discovery.json'), 'utf8')); if (discovery.ownerEpoch !== f.discovery.ownerEpoch) break; await delay(50); }
  assert.notEqual(discovery.ownerEpoch, f.discovery.ownerEpoch);
  const status: any = await pipeRequest(discovery.pipeName, { ...discovery, method: 'status' });
  assert.equal(status.run.state, 'needs_reconcile'); assert(status.attempts.every((a: any) => a.state === 'unknown'));
  assert.deepEqual(markers.map(p => readFileSync(p).length), before);
  assert.equal((await f.request('stop')).ok, false);
});
test('parent_UI_stop_is_bound_and_parent_normal_transport_survives', { timeout: 20000 }, async t => {
  const f = await launchControl(t, false, true);
  f.child.stdin.write(JSON.stringify({ id: 1, method: 'turn/interrupt', params: { threadId: 'unrelated', turnId: 'turn' } }) + '\n');
  await delay(100); assert.equal(((await f.request('status')).run as any).state, 'active');
  f.child.stdin.write(JSON.stringify({ id: 2, method: 'turn/interrupt', params: { threadId: 'parent-thread', turnId: 'turn' } }) + '\n');
  let status: any;
  for (let i = 0; i < 200; i++) { status = await f.request('status'); if (status.attempts.every((a: any) => a.state === 'stopped')) break; await delay(50); }
  assert.equal(status.run.state, 'stopped'); assert(status.attempts.every((a: any) => a.state === 'stopped'));
  f.child.stdin.write('{"id":3,"method":"echo","params":{"text":"parent-still-usable"}}\n');
  for (let i = 0; i < 100 && !f.output().includes('parent-still-usable'); i++) await delay(30);
  assert(f.output().includes('parent-still-usable'));
});
test('managed_terminal_adapter_closes_one_tab_then_window_lease_stops_peer', { timeout: 20000 }, async t => {
  const f = await launchControl(t);
  const require = createRequire(import.meta.url);
  const { connectManaged } = require('../../extension/dist/src/managed-client.js');
  const session = await connectManaged(path.join(f.state, 'discovery.json')); t.after(async () => session.dispose());
  assert.equal(session.terminals.length, 2);
  const a = session.terminals[0];
  await assert.rejects(a.connection.stop({ ...a.binding, attemptId: 'old' }), /stale/);
  assert.equal((await a.connection.stop(a.binding)).state, 'stopped');
  const status: any = await f.request('status'); assert.equal(status.run.state, 'stopped'); assert.equal(status.attempts[1].state, 'running');
  session.dispose();
  let final: any;
  for (let i = 0; i < 200; i++) { final = await f.request('status'); if (final.attempts.every((item: any) => item.state === 'stopped')) break; await delay(50); }
  assert(final.attempts.every((item: any) => item.state === 'stopped'));
});
test('actual_completion_cleanup_leaves_run_active_and_closed_tab_is_display_only', { timeout: 15000 }, async t => {
  const f = await launchControl(t, false, false, true);
  let status: any;
  for (let i = 0; i < 100; i++) { status = await f.request('status'); if (status.attempts.every((a: any) => a.state === 'completed')) break; await delay(50); }
  assert(status.attempts.every((a: any) => a.state === 'completed')); assert.equal(status.run.state, 'active');
  await f.request('close_terminal', { binding: status.attempts[0].registration.binding });
  assert.equal(((await f.request('status')).run as any).state, 'active');
});
test('registration_failure_cleans_unregistered_worker_and_exits', { timeout: 20000 }, async t => {
  const f = await launchControl(t); f.child.stdin.end();
  for (let i = 0; i < 100 && f.child.exitCode === null; i++) await delay(50);
  assert.notEqual(f.child.exitCode, null);
  const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
  config.stateDirectory = path.join(path.dirname(f.state), 'duplicate-state'); config.runtime.stateDirectory = config.stateDirectory;
  config.assignments[1].cwd = config.assignments[0].cwd;
  writeFileSync(f.configPath, JSON.stringify(config));
  const host = spawn(path.resolve('.local/chat-control-build/MeristemControl.exe'), ['--config', f.configPath], { windowsHide: true, stdio: 'pipe' }); host.stdout.resume(); host.stderr.resume();
  t.after(async () => { host.stdin.end(); if (host.exitCode === null && !host.signalCode) host.kill(); });
  for (let i = 0; i < 240 && host.exitCode === null; i++) await delay(50);
  assert.notEqual(host.exitCode, null, 'failed startup must not leave an unregistered host alive');
  assert.equal(existsSync(path.join(config.stateDirectory, 'discovery.json')), false);
  const marker = path.join(config.assignments[0].cwd, 'worker.marker'), before = readFileSync(marker).length;
  await delay(2000); assert.equal(readFileSync(marker).length, before);
});
test('unexpected_worker_host_exit_is_persisted_and_blocks_wake', { timeout: 15000 }, async t => {
  const f = await launchControl(t), before: any = await f.request('status');
  process.kill(before.attempts[0].registration.hostPid);
  let status: any;
  for (let i = 0; i < 150; i++) { status = await f.request('status'); if (status.run.state === 'stopped' && status.attempts[0].state === 'unknown') break; await delay(50); }
  assert.equal(status.run.state, 'stopped'); assert.equal(status.attempts[0].state, 'unknown');
});
test('stalled_native_peers_release_all_slots_for_human_stop', { timeout: 20000 }, async t => {
  const f = await launchControl(t);
  const sockets = Array.from({ length: 16 }, (_, index) => net.connect(`\\\\.\\pipe\\${f.discovery.pipeName}-${index}`));
  for (const socket of sockets) socket.on('error', () => {});
  t.after(async () => { for (const socket of sockets) socket.destroy(); });
  await Promise.all(sockets.map(socket => new Promise<void>(resolve => socket.once('connect', () => { socket.write('{'); resolve(); }))));
  await delay(2200);
  const stopped: any = await f.request('stop'); assert.equal(stopped.run.state, 'stopped');
});

test('peers_holding_connections_after_reply_do_not_crash_gateway', { timeout: 20000 }, async t => {
  const f = await launchControl(t, false, false, true);
  const sockets = Array.from({ length: 16 }, (_, index) => net.connect(`\\\\.\\pipe\\${f.discovery.pipeName}-${index}`));
  t.after(async () => { for (const socket of sockets) socket.destroy(); });
  await Promise.all(sockets.map(socket => new Promise<void>((resolve, reject) => {
    let buffer = '';
    socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ ...f.discovery, method: 'status' }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      try { assert.equal(JSON.parse(buffer.split('\n')[0]).ok, true); resolve(); } catch (error) { reject(error); }
      // Deliberately retain the connection after consuming the full response.
    });
  })));
  await delay(2200);
  assert.equal(f.child.exitCode, null, 'late pipe completion must not access a disposed wait handle');
  const stopped: any = await f.request('stop'); assert.equal(stopped.run.state, 'stopped');
});
