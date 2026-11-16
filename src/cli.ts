import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';
import { Broker } from './broker.js';
import { WorkerRuntime, type RuntimeConfig } from './workers.js';
import { pipeRequest, relayRequest } from './protocol.js';
import { callerMetadata, resolveCallerIdentity, type VerifiedPeer } from './actors.js';
import { McpController, type FixtureScope } from './mcp.js';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Binding, Id, sameWorker, type Registration, type ControlEvent } from './contracts.js';
import { displayEvent } from './terminal-events.js';
import { z } from 'zod';
import { Worker } from './contracts.js';
import { WakeCoordinator } from './wake.js';
import { RevisionConflict } from './failures.js';

type Config = { stateDirectory: string; repository: string; runId: string; pipeName: string; runtime: RuntimeConfig; assignments: { workerId: string; cwd: string; model: string; effort: string; branch: string; repositoryId: string }[]; mcp?: { wake?: { model: string; effort: string; maxTurns: number }; parentRelay: { pipeName: string; threadId: string }; scope: Omit<FixtureScope, 'windowBindingId'>; entryPoint: string; entrySha256: string } };
type Discovery = { pipeName: string; token: string; ownerId: string; ownerEpoch: string; windowBindingId: string; runId: string };
function tokenMatches(left: unknown, right: string): boolean { return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
export async function serve(configPath: string): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  Id.parse(config.runId);
  const store = new Store(config.stateDirectory, config.repository);
  const discovery: Discovery = { pipeName: config.pipeName, token: randomUUID() + randomUUID(), ownerId: randomUUID(), ownerEpoch: randomUUID(), windowBindingId: randomUUID(), runId: config.runId };
  let broker: Broker, wake: WakeCoordinator | undefined, wakeTimer: NodeJS.Timeout | undefined;
  const settling = new Set<string>();
  const runtime = new WorkerRuntime({ ...config.runtime, stateDirectory: config.stateDirectory, ...(config.mcp ? { mcp: { pipeName: config.pipeName, entryPoint: config.mcp.entryPoint, entrySha256: config.mcp.entrySha256 } } : {}) }, (worker, kind) => {
    if (!store.attempts(config.runId).some(a => a.id === worker.attemptId)) return;
    store.appendEvent({ runId: config.runId, attemptId: worker.attemptId, kind: kind === 'completed' ? 'turn_completed' : kind });
    if (kind === 'waiting_approval' || kind === 'waiting_input' || kind === 'running') store.attemptState(worker, kind);
    if (kind === 'completed' && !settling.has(worker.attemptId)) {
      const turnId = runtime.completedTurn(worker); if (turnId) store.completedTurn(worker, turnId);
      settling.add(worker.attemptId);
      void broker.releaseCompleted(config.runId, worker).then(result => {
        if (result.state === 'stopped' && !store.hasFinalReport(config.runId, worker.attemptId)) store.appendEvent({ runId: config.runId, attemptId: worker.attemptId, kind: 'failed' });
      });
    }
    if (['failed', 'authentication_required', 'limit_reached'].includes(kind) && !settling.has(worker.attemptId)) {
      settling.add(worker.attemptId);
      void runtime.stop(worker, 'failed').then(result => store.saveStop(config.runId, result));
    }
    if (kind === 'unknown') void broker.stopRun(config.runId, 'worker_exit');
  }, item => store.saveRequest(config.runId, item));
  broker = new Broker(store, runtime, config.mcp?.wake ? async blocked => {
    await relayRequest(config.mcp!.parentRelay.pipeName, blocked ? 'relay/wake-block' : 'relay/wake-resume', { threadId: config.mcp!.parentRelay.threadId });
  } : undefined);
  let existing = false; try { store.run(config.runId); existing = true; } catch { store.createRun(config.runId); }
  let mcp: McpController | undefined;
  if (config.mcp) {
    let parent: any;
    for (let i = 0; i < 30; i++) { try { parent = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/status'); break; } catch { await delay(100); } }
    if (!parent?.managementEnabled) throw new Error('verified parent owner unavailable');
    mcp = new McpController(store, broker, runtime, config.runId, { ownerId: parent.ownerId, ownerEpoch: parent.ownerEpoch, threadId: config.mcp.parentRelay.threadId }, { ...config.mcp.scope, windowBindingId: discovery.windowBindingId });
    if (config.mcp.wake) {
      const actor = { ownerId: parent.ownerId, ownerEpoch: parent.ownerEpoch, threadId: config.mcp.parentRelay.threadId };
      const relay = (method: string, params: Record<string, unknown>) => relayRequest(config.mcp!.parentRelay.pipeName, method, params);
      wake = new WakeCoordinator(store, actor, config.mcp.wake, relay, (runId, reason) => broker.stopRun(runId, reason), config.mcp.wake.maxTurns, runId => broker.canWake(runId));
    }
  }
  if (!existing && !config.mcp) {
    if (config.assignments.length > 2) throw new Error('initial worker limit exceeded');
    let unregistered: import('./contracts.js').WorkerRef | undefined;
    try {
      for (const assignment of config.assignments) {
        const identity = { workerId: assignment.workerId, attemptId: randomUUID(), ownerId: randomUUID(), ownerEpoch: randomUUID() };
        const pending = { ...identity, threadId: 'pending' };
        const registration: Registration = { worker: pending, hostPid: 0, hostCreated: 'unconfirmed', childPid: 0, childCreated: 'unconfirmed', jobId: 'unconfirmed', runId: config.runId, taskId: assignment.workerId, assignmentId: randomUUID(), cwd: assignment.cwd, repositoryId: assignment.repositoryId, branch: assignment.branch, model: assignment.model, effort: assignment.effort, binding: { worker: pending, terminalId: randomUUID(), windowBindingId: discovery.windowBindingId } };
        const startRef = { runId: config.runId, operationId: randomUUID(), expectedRevision: store.run(config.runId).revision };
        store.prepareOperation(startRef, createHash('sha256').update(JSON.stringify({ identity, cwd: assignment.cwd })).digest('hex'));
        store.reserve(registration);
        store.operationState(startRef.operationId, 'sent_unknown');
        const worker = await runtime.start({ ...assignment, identity });
        unregistered = worker;
        store.register({ ...registration, ...runtime.registration(worker), worker, binding: { ...registration.binding, worker } });
        store.operationState(startRef.operationId, 'settled');
        unregistered = undefined;
        // Only the adjacent deterministic MockCodex fixture can start a turn here.
        // Real parent instruction delivery is added at the authenticated CC-02 boundary.
        if (config.runtime.fixture) await broker.dispatch({ kind: 'send', ref: { runId: config.runId, operationId: randomUUID(), expectedRevision: store.run(config.runId).revision }, worker, text: 'fixture-start-marker' });
      }
    } catch {
      await broker.stopRun(config.runId, 'startup_failed');
      if (unregistered) await runtime.stop(unregistered, 'registration_failed');
      store.close(); throw new Error('worker startup failed');
    }
  }
  writeFileSync(path.join(config.stateDirectory, 'discovery.json'), JSON.stringify(discovery), { mode: 0o600 });
  let leasedPeer: string | undefined;
  if (wake) wakeTimer = setInterval(() => {
    if (leasedPeer && store.binding(config.runId)?.state === 'consumed') void wake!.monitor(config.runId).catch(() => { void broker.stopRun(config.runId, 'wake_monitor_failed'); });
  }, 500);
  const snapshot = () => {
    return { ok: true, run: store.run(config.runId), binding: store.binding(config.runId), attempts: store.displayAttempts(config.runId).map(row => ({ state: row.state, registration: JSON.parse(row.registration), stopResult: row.stop_result ? JSON.parse(row.stop_result) : null })) };
  };
  async function handle(envelope: any): Promise<unknown> {
    if (envelope.internalMethod === 'parent_stop') return { ok: true, results: await broker.stopRun(config.runId, 'parent_ui_stop') };
    const request = envelope.request;
    if (['mcp', 'mcp_human_response'].includes(request?.method) && mcp && config.mcp) {
      const metadata = request.metadata, { threadId, turnId } = callerMetadata(metadata);
      const peer: VerifiedPeer = { pid: envelope.peer?.pid, created: envelope.peer?.created };
      const proof = envelope.peer?.inBrokerJob === true ? await runtime.resolvePeer(peer, threadId, turnId) : await relayRequest(config.mcp.parentRelay.pipeName, 'relay/verify-peer', { peerPid: peer.pid, peerCreated: peer.created, threadId, turnId });
      const identity = resolveCallerIdentity(metadata, peer, proof);
      return { ok: true, value: request.method === 'mcp_human_response' ? await mcp.humanResponse(request.args, identity) : await mcp.call(request.name, request.args, identity) };
    }
    if (!request || request.runId !== config.runId || request.ownerId !== discovery.ownerId || request.ownerEpoch !== discovery.ownerEpoch || !tokenMatches(request.token, discovery.token) || envelope.peer?.inBrokerJob !== false) return { ok: false, error: 'binding_rejected' };
    const peerKey = `${envelope.peer.pid}:${envelope.peer.created}`;
    if (envelope.internalMethod === 'lease_lost') {
      if (leasedPeer === peerKey) { leasedPeer = undefined; await broker.leaseLost(config.runId); }
      return { ok: true };
    }
    if (request.method === 'lease') {
      if (request.windowBindingId !== discovery.windowBindingId || leasedPeer) return { ok: false, error: 'window_already_bound' };
      leasedPeer = peerKey; return { ok: true };
    }
    if (request.method === 'status') return snapshot();
    if ((request.method === 'requests' || request.method === 'answer_request') && mcp && config.mcp) {
      if (leasedPeer !== peerKey || request.windowBindingId !== discovery.windowBindingId) throw new Error('human window lease required');
      const ownership = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/owns-peer', { peerPid: envelope.peer.pid, peerCreated: envelope.peer.created });
      if (ownership.verified !== true || ownership.owned !== false) throw new Error('model cannot answer human request');
      if (request.method === 'requests') return { ok: true, requests: runtime.pendingRequests().map(item => {
        if (item.state !== 'pending' || item.kind === 'question') return item;
        const form = runtime.presentRequest(item.worker, item.key);
        store.auditHumanRequest(config.runId, form, 'presentation_prepared', 'human_window');
        return form;
      }) };
      const answer = z.object({ worker: Worker, key: z.string().max(512), payloadHash: z.string().regex(/^[a-f0-9]{64}$/), formGeneration: Id, action: z.enum(['accept', 'decline', 'cancel']) }).strict().parse(request.answer);
      const item = runtime.pendingRequests().find(r => r.key === answer.key && sameWorker(r.worker, answer.worker));
      const current = () => !!item && broker.canReviewRequest(config.runId, item) && leasedPeer === peerKey;
      if (!current()) throw new Error('run stopped or human window lost');
      store.auditHumanRequest(config.runId, { ...item!, payloadHash: answer.payloadHash, formGeneration: answer.formGeneration }, 'response_received', 'human_window', answer.action);
      await runtime.answerRequest(answer.worker, answer, answer.action, current);
      return { ok: true, state: 'response_sent' };
    }
    if (request.method === 'authorize' && mcp && config.mcp) {
      const ownership = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/owns-peer', { peerPid: envelope.peer.pid, peerCreated: envelope.peer.created });
      if (ownership.verified !== true || ownership.owned !== false) throw new Error('parent cannot confirm human permit');
      mcp.authorize(Id.parse(request.bindingId)); return { ok: true, bindingId: request.bindingId };
    }
    if (request.method === 'stop') return { results: await broker.stopRun(config.runId), ...snapshot() };
    if (request.method === 'close_terminal') return { ok: true, result: await broker.closeTerminal(config.runId, Binding.parse(request.binding)) };
    if (request.method === 'events') {
      const events = store.events(config.runId, request.afterSeq, request.limit).map(row => ({ seq: row.seq, attemptId: row.attempt_id, text: displayEvent(row.kind as ControlEvent['kind']) }));
      return { ok: true, events, lastSeq: events.at(-1)?.seq ?? request.afterSeq };
    }
    return { ok: false, error: 'unsupported_method' };
  }
  let buffer = Buffer.alloc(0), closing = false;
  process.stdin.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 262144) { process.exitCode = 1; process.stdin.destroy(); return; }
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      const frame = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      let envelope: any; try { envelope = JSON.parse(frame.toString('utf8')); } catch { continue; }
      void handle(envelope).then(result => {
        const frame = JSON.stringify({ id: envelope.id, result });
        process.stdout.write((Buffer.byteLength(frame) > 200000 ? JSON.stringify({ id: envelope.id, result: { ok: false, error: 'response_limit' } }) : frame) + '\n');
      }).catch(error => process.stdout.write(JSON.stringify({ id: envelope.id, result: { ok: false, error: error instanceof RevisionConflict ? 'stale_revision' : 'control_rejected' } }) + '\n'));
    }
  });
  const close = async () => { if (closing) return; closing = true; if (wakeTimer) clearInterval(wakeTimer); await broker.leaseLost(config.runId); store.close(); };
  process.stdin.once('end', () => { void close(); });
}
export async function main(args: string[]): Promise<void> {
  const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args[0] === 'serve' && option('--config')) { await serve(path.resolve(option('--config')!)); return; }
  const runId = Id.parse(option('--run')), directory = option('--state') ?? path.join(process.env.LOCALAPPDATA ?? '', 'Meristem', 'chat-control', runId);
  if (!['status', 'stop', 'authorize'].includes(args[0])) throw new Error('usage: status|stop|authorize --run <id> [--state <directory>] [--binding <id>]');
  const discoveryPath = path.join(directory, 'discovery.json');
  try {
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as Discovery;
    if (discovery.runId !== runId) throw new Error('run binding mismatch');
    if (args[0] === 'authorize') {
      const bindingId = Id.parse(option('--binding'));
      const snapshot = await pipeRequest(discovery.pipeName, { ...discovery, method: 'status' });
      const binding = snapshot.binding as any;
      if (!snapshot.ok || !binding || binding.id !== bindingId || binding.state !== 'pending') throw new Error('pending binding unavailable');
      console.error(JSON.stringify({ bindingId, parent: JSON.parse(binding.parent), scope: JSON.parse(binding.scope) }, null, 2));
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      try { if ((await readline.question('上記の親・計画hash・repo・branch・作業場所を確認し、許可するbinding IDを入力: ')).trim() !== bindingId) throw new Error('authorization declined'); }
      finally { readline.close(); }
      const result = await pipeRequest(discovery.pipeName, { ...discovery, method: 'authorize', bindingId });
      if (!result.ok) throw new Error('authorization rejected'); console.log(JSON.stringify(result)); return;
    }
    const result = await pipeRequest(discovery.pipeName, { ...discovery, method: args[0] });
    if (!result.ok) throw new Error('control rejected');
    console.log(JSON.stringify(result)); return;
  } catch {
    // Read-only fallback never steals the writer lease, reconnects to an old PID, or claims a stop.
    if (!existsSync(path.join(directory, 'control.sqlite'))) throw new Error('run state unavailable');
    const db = new DatabaseSync(path.join(directory, 'control.sqlite'), { readOnly: true });
    try {
      const run = db.prepare('SELECT id,state,revision,stop_generation FROM runs WHERE id=?').get(runId);
      const attempts = db.prepare('SELECT id,state FROM attempts WHERE run_id=?').all(runId);
      console.log(JSON.stringify({ ok: false, live: false, state: 'needs_reconcile', recordedRun: run, attempts, stop: 'unknown' })); process.exitCode = 2;
    } finally { db.close(); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => { console.error('control command failed; inspect local state and reconcile'); process.exitCode = 1; });
