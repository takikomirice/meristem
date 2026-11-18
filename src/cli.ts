import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';
import { Broker } from './broker.js';
import { HistorySelection, readSavedWorkerHistory, WorkerRuntime, type RuntimeConfig } from './workers.js';
import { pipeRequest, relayRequest } from './protocol.js';
import { callerMetadata, resolveCallerIdentity, type VerifiedPeer } from './actors.js';
import { HistoryResume, McpController, type FixtureScope } from './mcp.js';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Binding, Hash, Id, sameWorker, ExecutionLimits, type Registration, type ControlEvent } from './contracts.js';
import { displayEvent, terminalText } from './terminal-events.js';
import { z } from 'zod';
import { Worker } from './contracts.js';
import { WakeCoordinator } from './wake.js';
import { RevisionConflict } from './failures.js';
import { parseArgs } from 'node:util';
import { exportRoutingSummary, loadPlanRoutingSummary } from './routing-summary.js';
import { fileHash, readPlan } from './plan.js';

type Config = { stateDirectory: string; repository: string; runId: string; pipeName: string; runtime: RuntimeConfig; executionLimits?: Partial<ExecutionLimits>; assignments: { workerId: string; cwd: string; model: string; effort: string; branch: string; repositoryId: string }[]; mcp?: { wake?: { model: string; effort: string; maxTurns?: number | null }; parentRelay: { pipeName: string; threadId: string }; scope: Omit<FixtureScope, 'windowBindingId'>; entryPoint: string; entrySha256: string } };
type Discovery = { pipeName: string; token: string; ownerId: string; ownerEpoch: string; windowBindingId: string; runId: string };
function tokenMatches(left: unknown, right: string): boolean { return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
export async function serve(configPath: string): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  const limits = ExecutionLimits.parse(config.executionLimits ?? {});
  const legacyWake = ExecutionLimits.parse({ maxWakeTurns: config.mcp?.wake?.maxTurns }).maxWakeTurns;
  if (legacyWake !== null) limits.maxWakeTurns = limits.maxWakeTurns === null ? legacyWake : Math.min(limits.maxWakeTurns, legacyWake);
  Id.parse(config.runId);
  const scope = config.mcp?.scope;
  const routingHistory = scope?.modelRoutingSummary === undefined ? undefined : (() => {
    if (!scope.plan) throw new Error('routing summary requires a bound plan');
    return loadPlanRoutingSummary(scope.modelRoutingSummary, readPlan(scope.planPath), config.runId, config.runtime.authHome);
  })();
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
  } : undefined, limits);
  let existing = false; try { store.run(config.runId); existing = true; } catch { store.createRun(config.runId); }
  let mcp: McpController | undefined;
  if (config.mcp) {
    let parent: any;
    for (let i = 0; i < 30; i++) { try { parent = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/status'); break; } catch { await delay(100); } }
    if (!parent?.managementEnabled) throw new Error('verified parent owner unavailable');
    mcp = new McpController(store, broker, runtime, config.runId, { ownerId: parent.ownerId, ownerEpoch: parent.ownerEpoch, threadId: config.mcp.parentRelay.threadId }, {
      ...config.mcp.scope, windowBindingId: discovery.windowBindingId,
      ...(routingHistory ? { modelRoutingSummary: routingHistory.reference } : {})
    }, routingHistory);
    if (config.mcp.wake) {
      const actor = { ownerId: parent.ownerId, ownerEpoch: parent.ownerEpoch, threadId: config.mcp.parentRelay.threadId };
      const relay = (method: string, params: Record<string, unknown>) => relayRequest(config.mcp!.parentRelay.pipeName, method, params);
      wake = new WakeCoordinator(store, actor, config.mcp.wake, relay, (runId, reason) => broker.stopRun(runId, reason), runId => broker.executionLimits(runId).maxWakeTurns, runId => broker.canWake(runId));
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
  const snapshot = (offset = 0, attemptId?: string, registrationOnly = false) => store.terminalSnapshot(config.runId, offset, attemptId, { registrationOnly, telemetry: worker => runtime.terminalTelemetry(worker) });
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
    if (request.method === 'status' && request.pendingDecisions === true) {
      const afterId = Id.optional().parse(request.afterDecisionId);
      const rows = store.coordinationDecisions(config.runId, afterId, 5, true);
      const decisions = rows.slice(0, 4).map(({ id, kind, recipient, taskIds, question }) => ({ id, kind, recipient, taskIds, question: terminalText(question, 2048) }));
      return { ok: true, decisions, nextAfterId: rows.length > decisions.length ? decisions.at(-1)!.id : null };
    }
    if (request.method === 'status') return snapshot(request.attemptOffset, request.attemptId, request.registrationOnly === true);
    if (request.method === 'history_targets') {
      return { ok: true, ...store.historyTargets(config.runId, request.offset ?? 0) };
    }
    if (request.method === 'worker_history') {
      const { target, cursor } = HistorySelection.parse(request.selection);
      return { ok: true, result: await readSavedWorkerHistory(store, runtime, config.runId, target, cursor) };
    }
    if (request.method === 'resume_worker_history' && mcp && config.mcp) {
      const hasWindow = () => request.windowLease !== true || leasedPeer === peerKey && request.windowBindingId === discovery.windowBindingId;
      if (!hasWindow()) throw new Error('bound window lease required');
      const ownership = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/owns-peer', { peerPid: envelope.peer.pid, peerCreated: envelope.peer.created });
      if (ownership.verified !== true || ownership.owned !== false) throw new Error('verified human peer required');
      return { ok: true, result: await mcp.prepareHistoryResume(HistoryResume.parse(request.resume), hasWindow) };
    }
    if ((request.method === 'requests' || request.method === 'answer_request') && mcp && config.mcp) {
      if (leasedPeer !== peerKey || request.windowBindingId !== discovery.windowBindingId) throw new Error('human window lease required');
      const ownership = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/owns-peer', { peerPid: envelope.peer.pid, peerCreated: envelope.peer.created });
      if (ownership.verified !== true || ownership.owned !== false) throw new Error('model cannot answer human request');
      if (request.method === 'requests') {
        const offset = z.number().int().nonnegative().parse(request.requestOffset ?? 0), items = runtime.pendingRequests();
        const requests = [];
        for (const item of items.slice(offset, offset + 4)) {
          const form = item.state !== 'pending' || item.kind === 'question' ? item : runtime.presentRequest(item.worker, item.key);
          requests.push(form);
          if (Buffer.byteLength(JSON.stringify(requests)) > 160000) {
            requests.pop(); if (!requests.length) throw new Error('request exceeds frame budget'); break;
          }
          if (form !== item) store.auditHumanRequest(config.runId, form, 'presentation_prepared', 'human_window');
        }
        return { ok: true, requests, nextRequestOffset: items.length > offset + requests.length ? offset + requests.length : null };
      }
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
      mcp.authorize(Id.parse(request.bindingId), Hash.optional().parse(request.scopeHash)); return { ok: true, bindingId: request.bindingId };
    }
    if (request.method === 'stop') return { results: await broker.stopRun(config.runId), ...snapshot(0, undefined, true) };
    if (request.method === 'retire_worker') {
      if (leasedPeer !== peerKey || request.windowBindingId !== discovery.windowBindingId) throw new Error('bound human window lease required');
      const binding = Binding.parse(request.binding), row = store.attempts(config.runId).find(a => a.id === binding.worker.attemptId);
      const reg = row && JSON.parse(row.registration) as Registration | undefined;
      if (!reg || reg.binding.terminalId !== binding.terminalId || reg.binding.windowBindingId !== binding.windowBindingId) throw new Error('stale terminal binding');
      return { ok: true, result: await broker.retireWorker(config.runId, binding.worker) };
    }
    if (request.method === 'rename_worker') {
      if (leasedPeer !== peerKey || request.windowBindingId !== discovery.windowBindingId) throw new Error('bound window lease required');
      if (config.mcp) {
        const ownership = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/owns-peer', { peerPid: envelope.peer.pid, peerCreated: envelope.peer.created });
        if (ownership.verified !== true || ownership.owned !== false || leasedPeer !== peerKey) throw new Error('verified window lease required');
      }
      const displayName = store.renameWorker(config.runId, Worker.parse(request.target), request.displayName);
      return { ok: true, displayName };
    }
    if (request.method === 'close_terminal') return { ok: true, result: await broker.closeTerminal(config.runId, Binding.parse(request.binding)) };
    if (request.method === 'events') {
      const events = store.events(config.runId, request.afterSeq, request.limit, Id.optional().parse(request.attemptId)).map(row => ({ seq: row.seq, attemptId: row.attempt_id, text: displayEvent((row.transition ?? row.kind) as ControlEvent['kind'], row.decisionKind),
        source: row.kind === 'report_saved' || row.kind === 'late_report' ? 'worker' : undefined }));
      let activity = {};
      if (request.afterActivitySeq !== undefined) {
        const cursor = z.number().int().nonnegative().parse(request.afterActivitySeq);
        const reg = store.terminalRegistration(config.runId, request.attemptId);
        if (!reg) throw new Error('attempt unavailable');
        activity = runtime.terminalActivity(reg.worker)?.read(cursor, request.limit) ?? { activityEvents: [], lastActivitySeq: cursor, omittedActivityCount: 0 };
      }
      return { ok: true, events, lastSeq: events.at(-1)?.seq ?? request.afterSeq, ...activity };
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
  if (args[0] === 'routing-summary') {
    const { values } = parseArgs({ args: args.slice(1), options: { state: { type: 'string', multiple: true }, out: { type: 'string' } } });
    const bytes = exportRoutingSummary(values.state ?? []);
    if (values.out) {
      writeFileSync(values.out, bytes, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ path: path.resolve(values.out), sha256: fileHash(bytes) }));
    } else {
      process.stdout.write(bytes);
    }
    return;
  }
  if (args[0] === 'serve' && option('--config')) { await serve(path.resolve(option('--config')!)); return; }
  const runId = Id.parse(option('--run')), directory = option('--state') ?? path.join(process.env.LOCALAPPDATA ?? '', 'Meristem', 'chat-control', runId);
  const historyCommand = args[0] === 'history' || args[0] === 'resume-history';
  const pendingDecisions = args[0] === 'status' && args.includes('--pending-decisions');
  if (!historyCommand && !['status', 'stop', 'authorize'].includes(args[0])) throw new Error('usage: status|stop|authorize|history|resume-history --run <id> [--state <directory>] [--attempt <id>]');
  const discoveryPath = path.join(directory, 'discovery.json');
  try {
    const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8')) as Discovery;
    if (discovery.runId !== runId) throw new Error('run binding mismatch');
    if (historyCommand) {
      const attempt = option('--attempt');
      if (attempt === undefined && args[0] === 'history') {
        const page = await pipeRequest(discovery.pipeName, { ...discovery, method: 'history_targets', offset: Number(option('--offset') ?? 0) });
        if (!page.ok) throw new Error('history targets unavailable');
        console.log(JSON.stringify(page)); return;
      }
      const snapshot = await pipeRequest(discovery.pipeName, { ...discovery, method: 'status', attemptId: Id.parse(attempt), registrationOnly: true });
      const target = Worker.parse((snapshot.attempts as { registration: Registration }[] | undefined)?.[0]?.registration.worker);
      const input = args[0] === 'history'
        ? { method: 'worker_history', selection: HistorySelection.parse({ target, cursor: option('--cursor') }) }
        : { method: 'resume_worker_history', resume: HistoryResume.parse({ target, runId, operationId: randomUUID(), expectedRevision: (snapshot.run as { revision: number }).revision }) };
      const result = await pipeRequest(discovery.pipeName, { ...discovery, ...input }, 20000);
      if (!result.ok) throw new Error('history action rejected');
      console.log(JSON.stringify(result)); return;
    }
    if (args[0] === 'authorize') {
      const bindingId = Id.parse(option('--binding'));
      const snapshot = await pipeRequest(discovery.pipeName, { ...discovery, method: 'status' });
      const binding = snapshot.binding as any;
      if (!snapshot.ok || !binding || binding.id !== bindingId || binding.state !== 'pending') throw new Error('pending binding unavailable');
      const scope = JSON.parse(binding.scope);
      const scopeHash = scope.modelRouting ? Hash.parse(binding.scope_hash) : undefined;
      console.error(JSON.stringify({ bindingId, parent: JSON.parse(binding.parent), scope, ...(scopeHash ? { scopeHash } : {}) }, null, 2));
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      const prompt = scopeHash ? '親・計画と許可するモデル候補・対象・最大切り替え回数・集計hashを確認し、許可するbinding IDを入力: '
        : '上記の親・計画hash・repo・branch・作業場所を確認し、許可するbinding IDを入力: ';
      try { if ((await readline.question(prompt)).trim() !== bindingId) throw new Error('authorization declined'); }
      finally { readline.close(); }
      const result = await pipeRequest(discovery.pipeName, { ...discovery, method: 'authorize', bindingId, ...(scopeHash ? { scopeHash } : {}) });
      if (!result.ok) throw new Error('authorization rejected'); console.log(JSON.stringify(result)); return;
    }
    const result = await pipeRequest(discovery.pipeName, { ...discovery, method: args[0], ...(pendingDecisions ? { pendingDecisions, afterDecisionId: Id.optional().parse(option('--after-id')) } : {}) });
    if (!result.ok) throw new Error('control rejected');
    if (args[0] === 'status') {
      while (result.nextAttemptOffset !== null && result.nextAttemptOffset !== undefined) {
        const page = await pipeRequest(discovery.pipeName, { ...discovery, method: 'status', attemptOffset: result.nextAttemptOffset });
        if (!page.ok) throw new Error('status page rejected');
        (result.attempts as unknown[]).push(...page.attempts as unknown[]); result.nextAttemptOffset = page.nextAttemptOffset;
      }
    }
    console.log(JSON.stringify(result)); return;
  } catch (error) {
    if (historyCommand || pendingDecisions) throw error;
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
