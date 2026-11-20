import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';
import { Broker } from './broker.js';
import { HistorySelection, readSavedWorkerHistory, WorkerRuntime, type RuntimeConfig } from './workers.js';
import { pipeRequest, relayRequest } from './protocol.js';
import { Actor, callerMetadata, resolveCallerIdentity, sameActor, type ActorRef, type VerifiedPeer } from './actors.js';
import { HistoryResume, McpController, type FixtureScope } from './mcp.js';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Binding, Hash, Id, ParentRelay, sameWorker, ExecutionLimits, type Registration, type ControlEvent } from './contracts.js';
import { displayEvent, terminalText } from './terminal-events.js';
import { z } from 'zod';
import { Worker } from './contracts.js';
import { WakeCoordinator } from './wake.js';
import { UsagePolicy, UsageReader, expiresAt, ttl, unavailable, readOfficialUsage } from './usage.js';
import { RevisionConflict } from './failures.js';
import { parseArgs } from 'node:util';
import { exportRoutingSummary, loadPlanRoutingSummary } from './routing-summary.js';
import { fileHash, readPlan } from './plan.js';

type WakeConfig = { model: string; effort: string; maxTurns?: number | null; verifiedEntryPoint?: 'cli' | 'vscode' };
type Config = { ideTerminal?: true; stateDirectory: string; repository: string; runId: string; pipeName: string; runtime: RuntimeConfig; usagePolicy?: UsagePolicy; executionLimits?: Partial<ExecutionLimits>; assignments: { workerId: string; cwd: string; model: string; effort: string; branch: string; repositoryId: string }[]; mcp?: { wake?: WakeConfig; parentRelay: ParentRelay; scope: Omit<FixtureScope, 'windowBindingId'>; entryPoint: string; entrySha256: string } };
type Discovery = { pipeName: string; token: string; ownerId: string; ownerEpoch: string; windowBindingId: string; runId: string };
function tokenMatches(left: unknown, right: string): boolean { return typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right)); }
export async function serve(configPath: string): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;
  const limits = ExecutionLimits.parse(config.executionLimits ?? {});
  const legacyWake = ExecutionLimits.parse({ maxWakeTurns: config.mcp?.wake?.maxTurns }).maxWakeTurns;
  if (legacyWake !== null) limits.maxWakeTurns = limits.maxWakeTurns === null ? legacyWake : Math.min(limits.maxWakeTurns, legacyWake);
  Id.parse(config.runId);
  const relayConfig = config.mcp && ParentRelay.parse(config.mcp.parentRelay);
  const dynamic = !!relayConfig && 'mode' in relayConfig;
  const fixedThread = relayConfig && 'threadId' in relayConfig ? relayConfig.threadId : undefined;
  const wakeConfig = !dynamic || config.mcp?.wake?.verifiedEntryPoint === (relayConfig.sessionKind ?? 'vscode') ? config.mcp?.wake : undefined;
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
  broker = new Broker(store, runtime, wakeConfig ? async blocked => {
    if (boundActor) await relayRequest(config.mcp!.parentRelay.pipeName, blocked ? 'relay/wake-block' : 'relay/wake-resume', boundActor);
  } : undefined, limits);
  let existing = false; try { store.run(config.runId); existing = true; } catch { store.createRun(config.runId, config.mcp?.scope.plan ? UsagePolicy.parse(config.usagePolicy ?? {}) : undefined); }
  let mcp: McpController | undefined;
  let sessionServerPid: number | undefined;
  let sessionLauncherEndpoint = false;
  let relayOwner: Pick<ActorRef, 'ownerId' | 'ownerEpoch'> | undefined;
  let boundActor: ActorRef | undefined;
  let leasedPeer: string | undefined, leaseId: string | undefined, controllerLease: string | undefined;
  function controllerFor(actor: ActorRef) {
    if (!config.mcp || !relayOwner || actor.ownerId !== relayOwner.ownerId || actor.ownerEpoch !== relayOwner.ownerEpoch) throw new Error('parent owner changed');
    if (boundActor && !sameActor(boundActor, actor)) throw new Error('another conversation owns this run');
    const saved = store.binding(config.runId);
    if (dynamic && saved && Actor.parse(JSON.parse(saved.parent)).threadId !== actor.threadId) throw new Error('saved parent thread mismatch');
    if (dynamic && !leaseId) throw new Error('session control lease required');
    if (mcp && (!dynamic || controllerLease === leaseId)) return mcp;
    return new McpController(store, broker, runtime, config.runId, actor, {
      ...config.mcp.scope, windowBindingId: discovery.windowBindingId,
      ...(relayConfig && 'mode' in relayConfig ? { parentSessionKind: relayConfig.sessionKind ?? 'vscode' } : {}),
      ...(routingHistory ? { modelRoutingSummary: routingHistory.reference } : {})
    }, routingHistory, dynamic ? leaseId : undefined);
  }
  if (config.mcp) {
    let parent;
    for (let i = 0; i < 30; i++) { try { parent = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/status'); break; } catch { await delay(100); } }
    if (!parent?.managementEnabled) throw new Error('verified parent owner unavailable');
    if (dynamic) {
      sessionServerPid = z.number().int().positive().parse(parent.ownedPid);
      sessionLauncherEndpoint = parent.cliTransport === 'launcher-websocket';
    }
    relayOwner = { ownerId: Id.parse(parent.ownerId), ownerEpoch: Id.parse(parent.ownerEpoch) };
    if (fixedThread) {
      boundActor = { ...relayOwner, threadId: fixedThread };
      mcp = controllerFor(boundActor);
    }
  }
  let usageTimer: NodeJS.Timeout | undefined, usageReader: UsageReader | undefined, usageClosing = false;
  let syncUsage: (() => Promise<void>) | undefined;
  if (config.mcp && store.usageRecord(config.runId)) {
    const pipe = config.mcp.parentRelay.pipeName, runId = config.runId;
    const context = async () => {
      const ctx = await relayRequest(pipe,'relay/usage-context');
      if (ctx.ownerId !== relayOwner?.ownerId || ctx.ownerEpoch !== relayOwner?.ownerEpoch ||
          !Number.isSafeInteger(ctx.usageSequence) || !Number.isSafeInteger(ctx.accountGeneration) ||
          typeof ctx.authHome !== 'string' || realpathSync(ctx.authHome).toLowerCase() !== realpathSync(config.runtime.authHome).toLowerCase()) throw new Error('usage context mismatch');
      return ctx;
    };
    let nextRead = 0, lastSequence = -1, lastAccountGeneration = -1;
    const read = () => readOfficialUsage(context, (method, params) => relayRequest(pipe, method, params),
      () => runtime.readWorkerUsage(), before => {
        lastSequence = before.usageSequence;
        lastAccountGeneration = before.accountGeneration;
      });
    usageReader = new UsageReader(read, value => {
      if (usageClosing) return;
      store.saveUsage(runId,value);
      const expiry = expiresAt(value);
      nextRead = value.status === 'ok' && expiry > Date.now() ? expiry : Date.now()+ttl;
      if (mcp && store.binding(runId)?.state === 'consumed') mcp.checkUsageWaiting();
    });
    const reader = usageReader;
    let checking: Promise<void> | undefined;
    const poll = async () => {
      if (usageClosing || store.run(runId).state !== 'active') return;
      if (Date.now() < nextRead) {
        try {
          const ctx = await context();
          if (ctx.usageSequence === lastSequence) return;
          lastSequence = ctx.usageSequence;
          const previous = store.usageRecord(runId)?.state?.latest;
          if (previous && lastAccountGeneration === ctx.accountGeneration) store.saveUsage(runId,{...previous,status:'stale'});
          else store.saveUsage(runId,unavailable('account_mismatch'));
        } catch {
          if (!usageClosing) store.saveUsage(runId,unavailable('account_mismatch'));
          return;
        }
        reader.invalidate();
      }
      await reader.refresh();
    };
    syncUsage = () => checking ??= poll().finally(() => { checking = undefined; });
    usageTimer = setInterval(() => { void syncUsage!().catch(() => {}); },2000);
    void syncUsage().catch(() => {});
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
  function connectedParent(runId: string, parent: ActorRef) {
    if (!leasedPeer || (dynamic && (!leaseId || leaseId !== controllerLease)) || !broker.canWake(runId)) return false;
    const binding = store.binding(runId);
    return binding?.state === 'consumed' && sameActor(JSON.parse(binding.parent), parent);
  }
  let monitoring: Promise<unknown> | undefined;
  if (wakeConfig) wakeTimer = setInterval(() => {
    const parent = boundActor;
    if (monitoring || !parent || !connectedParent(config.runId, parent)) return;
    wake ??= new WakeCoordinator(store, parent, {model:wakeConfig.model, effort:wakeConfig.effort},
      (method, params) => relayRequest(config.mcp!.parentRelay.pipeName, method, { ...params, ...(dynamic && {ownedPid:sessionServerPid}) }),
      (runId, reason) => broker.stopRun(runId, reason), runId => broker.executionLimits(runId).maxWakeTurns,
      runId => connectedParent(runId, parent));
    monitoring = wake.monitor(config.runId, dynamic).catch(() => broker.stopRun(config.runId, 'wake_monitor_failed')).finally(() => { monitoring = undefined; });
  }, 500);
  const snapshot = (offset = 0, attemptId?: string, registrationOnly = false) => store.terminalSnapshot(config.runId, offset, attemptId, { registrationOnly, telemetry: worker => runtime.terminalTelemetry(worker) });
  function disconnectOwner() {
    // A clean CLI shutdown already fenced delivery and collected every Worker exit.
    if (relayConfig && 'mode' in relayConfig && relayConfig.sessionKind === 'cli' && store.run(config.runId).state === 'stopped'
      && store.attempts(config.runId).every(row => row.state === 'stopped' || row.state === 'completed')) return;
    return broker.leaseLost(config.runId);
  }
  async function handle(envelope: any): Promise<unknown> {
    if (envelope.internalMethod === 'parent_stop' && (!dynamic || boundActor && envelope.request?.threadId === boundActor.threadId)) return { ok: true, results: await broker.stopRun(config.runId, 'parent_ui_stop') };
    const request = envelope.request;
    if (['mcp', 'mcp_human_response'].includes(request?.method) && config.mcp) {
      const observedLease = leaseId;
      const metadata = request.metadata, { threadId, turnId } = callerMetadata(metadata);
      const peer: VerifiedPeer = { pid: envelope.peer?.pid, created: envelope.peer?.created };
      const proof = envelope.peer?.inBrokerJob === true ? await runtime.resolvePeer(peer, threadId, turnId) : await relayRequest(config.mcp.parentRelay.pipeName, 'relay/verify-peer', { peerPid: peer.pid, peerCreated: peer.created, threadId, turnId });
      const identity = resolveCallerIdentity(metadata, peer, proof);
      if (dynamic && envelope.peer?.inBrokerJob !== true && observedLease !== leaseId) throw new Error('control session changed');
      if (dynamic && request.method === 'mcp' && request.name === 'start_run') {
        if (envelope.peer?.inBrokerJob !== false) throw new Error('worker cannot start a run');
        const candidate = controllerFor(identity.actor);
        const value = await candidate.call('start_run', request.args, identity);
        if (!observedLease || observedLease !== leaseId) throw new Error('control session changed');
        mcp = candidate; boundActor = identity.actor; controllerLease = observedLease;
        return { ok: true, value };
      }
      if (!mcp) throw new Error('parent has not started this run');
      if (dynamic && envelope.peer?.inBrokerJob !== true && (!leaseId || controllerLease !== leaseId)
        && !['get_status', 'stop_run'].includes(request.name)) throw new Error('session must be rebound');
      if (request.name === 'create_worker' && boundActor && sameActor(identity.actor,boundActor)) await syncUsage?.();
      if (dynamic && request.name === 'create_worker' && observedLease !== leaseId) throw new Error('control session changed');
      return { ok: true, value: request.method === 'mcp_human_response' ? await mcp.humanResponse(request.args, identity) : await mcp.call(request.name, request.args, identity) };
    }
    if (!request || request.runId !== config.runId || request.ownerId !== discovery.ownerId || request.ownerEpoch !== discovery.ownerEpoch || !tokenMatches(request.token, discovery.token) || envelope.peer?.inBrokerJob !== false) return { ok: false, error: 'binding_rejected' };
    const peerKey = `${envelope.peer.pid}:${envelope.peer.created}`;
    const cliSession = relayConfig && 'mode' in relayConfig && relayConfig.sessionKind === 'cli';
    const currentLease = () => !!leaseId && leasedPeer === peerKey && request.leaseId === leaseId && request.windowBindingId === discovery.windowBindingId;
    if (cliSession && ['close_terminal', 'retire_worker', 'rename_worker', 'resume_worker_history'].includes(request.method)) throw new Error('VS Code terminal control is unavailable for CLI runs');
    if (envelope.internalMethod === 'lease_lost') {
      if (leasedPeer === peerKey) { leasedPeer = undefined; leaseId = undefined; await disconnectOwner(); }
      return { ok: true };
    }
    if (dynamic && config.mcp && ['lease', 'stop', 'preview_parent_start', 'start_parent', 'resume_parent'].includes(request.method)) {
      const ownership = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/owns-peer', { peerPid: envelope.peer.pid, peerCreated: envelope.peer.created });
      if (ownership.verified !== true || ownership.owned !== false) throw new Error('human control peer required');
      if (request.method !== 'stop' && ownership.launcher !== true) throw new Error('start must come from the UI that owns the relay');
      if (cliSession && request.method === 'stop' && (!currentLease() || ownership.launcher !== true)) throw new Error('current CLI session required');
    }
    if (dynamic && config.mcp && ['preview_parent_start', 'start_parent', 'resume_parent'].includes(request.method)) {
      const actor = Actor.parse(request.parent);
      if (cliSession && sessionLauncherEndpoint) {
        const firstCaller = store.binding(config.runId);
        if (!firstCaller || Actor.parse(JSON.parse(firstCaller.parent)).threadId !== actor.threadId) throw new Error('await the first verified CLI start request');
      }
      const status = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/status');
      if (leasedPeer !== peerKey || !leaseId || request.leaseId !== leaseId || request.windowBindingId !== discovery.windowBindingId
        || !status.managementEnabled || status.ownerId !== actor.ownerId || status.ownerEpoch !== actor.ownerEpoch
        || (config.ideTerminal && status.terminalThreadId !== actor.threadId)
        || !Array.isArray(status.observedThreads) || !status.observedThreads.includes(actor.threadId)) throw new Error('start needs a current owned conversation and control lease');
      const candidate = controllerFor(actor);
      const run = store.run(config.runId);
      if (request.method === 'preview_parent_start') {
        const preview = candidate.startPreview();
        const tasks = store.plan(config.runId)?.snapshot.plan.tasks;
        return { ok: true, ...preview, state: run.state, stopGeneration: run.stop_generation,
          ...(tasks && { tasks: { count: tasks.length, names: tasks.slice(0, 3).map(task => ('display_name' in task && task.display_name) || task.id) } }) };
      }
      const operation = Id.parse(request.operationId), scopeHash = Hash.parse(request.scopeHash);
      if (request.method === 'resume_parent' && request.stopGeneration !== run.stop_generation) throw new Error('stop generation changed');
      const result = request.method === 'resume_parent' ? await candidate.resumeFromControl(operation, scopeHash) : candidate.startFromControl(operation, scopeHash);
      if (!currentLease()) throw new Error('control session changed');
      mcp = candidate; boundActor = actor; controllerLease = leaseId;
      return { ok: true, ...result };
    }
    if (request.method === 'lease') {
      if (relayConfig && 'mode' in relayConfig && request.sessionKind !== (relayConfig.sessionKind ?? 'vscode')) throw new Error('wrong control session');
      if (envelope.internalMethod === 'terminal_server') {
        if (dynamic && config.ideTerminal === true && request.sessionKind === 'vscode') return {ok:true,sessionServerPid:envelope.peer.pid};
        return dynamic && request.sessionKind === 'cli' ? { ok: true, sessionServerPid, sessionLauncherEndpoint } : { ok: false };
      }
      if (request.windowBindingId !== discovery.windowBindingId || leasedPeer) return { ok: false, error: 'window_already_bound' };
      leasedPeer = peerKey;
      leaseId = randomUUID();
      // No work or permit exists to resume if the previous session disappeared before its first start.
      if (dynamic && !store.binding(config.runId) && store.run(config.runId).state === 'needs_reconcile' && !store.attempts(config.runId).length) {
        try { await broker.resumeRun(config.runId); }
        catch (error) { leasedPeer = undefined; leaseId = undefined; throw error; }
      }
      return dynamic ? { ok: true, leaseId } : { ok: true };
    }
    if (request.method === 'usage') { await usageReader?.refresh(); return {ok:true,capacity:store.capacity(config.runId)}; }
    if (request.method === 'status' && request.pendingDecisions === true) {
      const afterId = Id.optional().parse(request.afterDecisionId);
      const rows = store.coordinationDecisions(config.runId, afterId, 5, true);
      const decisions = rows.slice(0, 4).map(({ id, kind, recipient, taskIds, question }) => ({ id, kind, recipient, taskIds, question: terminalText(question, 2048) }));
      return { ok: true, decisions, nextAfterId: rows.length > decisions.length ? decisions.at(-1)!.id : null };
    }
    if (request.method === 'status') {
      const status = snapshot(request.attemptOffset, request.attemptId, request.registrationOnly === true);
      if (request.registrationOnly === true && !request.attemptOffset && leasedPeer === peerKey && request.windowBindingId === discovery.windowBindingId) {
        const pendingApprovalKeys = runtime.pendingRequests().filter(item => item.state === 'pending' && item.kind !== 'question').slice(0, 32).map(item => item.key);
        if (config.ideTerminal && request.terminalParent === true && request.leaseId === leaseId && leaseId && !status.binding && config.mcp) {
          const relay = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/status');
          if (relay.managementEnabled && relay.terminalThreadId && relayOwner?.ownerId === relay.ownerId && relayOwner?.ownerEpoch === relay.ownerEpoch) {
            return { ...status, pendingApprovalKeys, terminalParent: Actor.parse({...relayOwner, threadId: relay.terminalThreadId}) };
          }
        }
        return { ...status, pendingApprovalKeys };
      }
      return status;
    }
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
    if (['present_decision', 'answer_decision'].includes(request.method)) {
      if (!cliSession || !config.mcp || !mcp || !currentLease() || controllerLease !== leaseId) throw new Error('current CLI owner required');
      const ownership = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/owns-peer', { peerPid: envelope.peer.pid, peerCreated: envelope.peer.created });
      if (!currentLease() || controllerLease !== leaseId || ownership.verified !== true || ownership.owned !== false || ownership.launcher !== true) throw new Error('human CLI control required');
      if (request.method === 'present_decision') return { ok: true, ...mcp.presentControlDecision(Id.parse(request.decisionId)) };
      return { ok: true, ...mcp.resolveControlDecision(request.form, request.answer) };
    }
    if ((request.method === 'requests' || request.method === 'answer_request') && mcp && config.mcp) {
      if (leasedPeer !== peerKey || request.windowBindingId !== discovery.windowBindingId) throw new Error('human window lease required');
      const ownership = await relayRequest(config.mcp.parentRelay.pipeName, 'relay/owns-peer', { peerPid: envelope.peer.pid, peerCreated: envelope.peer.created });
      if (ownership.verified !== true || ownership.owned !== false) throw new Error('model cannot answer human request');
      if (cliSession) {
        if (!currentLease() || controllerLease !== leaseId || ownership.launcher !== true) throw new Error('current CLI owner required');
        mcp.assertControlScope();
      }
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
      if (dynamic && (ownership.launcher !== true || leasedPeer !== peerKey || !leaseId || controllerLease !== leaseId
        || request.leaseId !== leaseId || request.windowBindingId !== discovery.windowBindingId)) throw new Error('current session lease required');
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
  const close = async () => { if (closing) return; closing = true; usageClosing = true; if (usageTimer) clearInterval(usageTimer); if (wakeTimer) clearInterval(wakeTimer); await disconnectOwner(); await monitoring; store.close(); };
  process.stdin.once('end', () => { void close(); });
}
export async function main(args: string[]): Promise<void> {
  if (args[0] === 'terminal') {
    const { terminalMain } = await import('./cli-parent.js');
    await terminalMain(args.slice(1));
    return;
  }
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
  if (!historyCommand && !['status', 'usage', 'stop', 'authorize'].includes(args[0])) throw new Error('usage: usage|status|stop|authorize|history|resume-history --run <id> [--state <directory>] [--attempt <id>]');
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
      const scopeHash = Hash.parse(binding.scope_hash);
      console.error(JSON.stringify({ bindingId, parent: JSON.parse(binding.parent), scope, ...(scopeHash ? { scopeHash } : {}) }, null, 2));
      const readline = createInterface({ input: process.stdin, output: process.stderr });
      const prompt = scope.modelRouting ? '親・計画と許可するモデル候補・対象・最大切り替え回数・集計hashを確認し、許可するbinding IDを入力: '
        : '上記の親・計画hash・repo・branch・作業場所を確認し、許可するbinding IDを入力: ';
      try { if ((await readline.question(prompt)).trim() !== bindingId) throw new Error('authorization declined'); }
      finally { readline.close(); }
      const result = await pipeRequest(discovery.pipeName, { ...discovery, method: 'authorize', bindingId, ...(scopeHash ? { scopeHash } : {}) });
      if (!result.ok) throw new Error('authorization rejected'); console.log(JSON.stringify(result)); return;
    }
    const result = await pipeRequest(discovery.pipeName, { ...discovery, method: args[0], ...(pendingDecisions ? { pendingDecisions, afterDecisionId: Id.optional().parse(option('--after-id')) } : {}) }, args[0] === 'usage' ? 50000 : 10000);
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
    if (historyCommand || pendingDecisions || args[0] === 'usage') throw error;
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
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  console.error(process.argv[2] === 'terminal' && error instanceof Error ? terminalText(error.message, 1000) : 'control command failed; inspect local state and reconcile');
  process.exitCode = 1;
});
