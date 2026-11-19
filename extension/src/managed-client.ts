import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect as netConnect, Socket } from 'node:net';
import type { ControlConnection, DisplayEvent, TerminalBinding, WorkerRef, WorkerStatus } from './control-client';

type RegisteredWorker = { ownerId: string; ownerEpoch: string; workerId: string; attemptId: string; threadId: string };
type Registration = { worker: RegisteredWorker; cwd: string; branch: string; model: string; effort: string; taskId: string; displayName?: string; binding: { worker: RegisteredWorker; terminalId: string; windowBindingId: string } };
type ManagedAttempt = Omit<WorkerStatus, 'cwd' | 'branch' | 'agent'> & { registration: Registration };
type Discovery = { pipeName: string; token: string; ownerId: string; ownerEpoch: string; windowBindingId: string; runId: string };
export type HistoryTarget = { worker: RegisteredWorker; taskId: string; branch: string; displayName?: string; state: string };
type HistoryPage = { threadId: string; modelProvider: string; turns: { id: string; status: string; messages: { role: 'user' | 'assistant'; text: string }[] }[]; nextCursor: string | null };
type HistoryUnavailable = { state: 'history_unavailable'; reason: string };
type HistoryRead = HistoryUnavailable | { state: 'history_read'; history: HistoryPage };
type HistoryResume = HistoryUnavailable | { state: 'history_handoff_ready'; taskId: string; sourceThreadId: string; head: string };
type PendingDecision = { id: string; kind: 'consultation' | 'plan_change' | 'parallelism'; recipient: 'coordinator' | 'human'; taskIds: string[]; question: string };
export type HumanRequest = { kind: string; key: string; payloadHash: string; formGeneration: string; worker: RegisteredWorker; cwd: string; turnId: string | null; requestId: string | number; state: string; detail: string };
export type UsageCapacity = {
  requestedMaximum: number; approvedMaximum: number; activeWorkers: number; effectiveMaximum: number; quotaMaximum: number | null;
  reason: string; usageStatus: string; fetchedAt: number | null;
  windows: { usedPercent: number; remainingPercent: number; windowDurationMins: number | null; resetsAt: number | null }[];
};
export type StartPreview = { runId: string; parent: { threadId: string; ownerId: string; ownerEpoch: string }; scopeHash: string;
  tasks?: { count: number; names: string[] };
  scope: { repositoryPath: string; planPath: string; branchScope: string[]; maxInstructions?: number;
    permissionPermit?: { allowedProfileIds: string[]; writableRoots: string[]; allowedReviewers: string[] };
    modelRouting?: { mode: string; candidates: {model: string; effort: string}[]; maxAutomaticChangesPerTask: number;
      tasks: {taskId:string; agent:{model:string; effort:string}}[]; planHash: string; summarySha256?: string };
    planScope: { planVersion: number; integrationBranch: string; gitDestination: string; worktreesRoot: string; requestedMaximum: number; approvedMaximum: number;
      usagePolicy?: {enabled: boolean; threshold: number; lowMaximum: number}; scopedGitSave?: boolean } } };
export type ManagedSession = { terminals: { connection: ControlConnection; binding: TerminalBinding }[]; refresh(): Promise<boolean>; stopRun(): Promise<{ results: { state: string }[]; run: { state: string } }>; requests(): Promise<HumanRequest[]>; answer(item: HumanRequest, action: 'accept' | 'decline' | 'cancel'): Promise<void>;
  readonly pendingStart?: string; readonly approvalKeys: string[]; readonly runState?: string; readonly started: boolean; readonly closed: boolean;
  preview(): Promise<StartPreview>; start(preview: StartPreview): Promise<void>; usage(): Promise<UsageCapacity>;
  historyTargets(offset?: number): Promise<{ targets: HistoryTarget[]; nextOffset: number | null; revision: number }>;
  history(target: RegisteredWorker, cursor?: string): Promise<HistoryRead>;
  prepareHistoryResume(target: RegisteredWorker, expectedRevision: number): Promise<HistoryResume>;
  pendingDecisions(afterDecisionId?: string): Promise<{ decisions: PendingDecision[]; nextAfterId: string | null }>;
  dispose(): void };
let slot = 0;
async function availablePipe(pipeName: string): Promise<Socket> {
  for (let attempt = 0; attempt < 16; attempt++) {
    try { return await new Promise<Socket>((resolve, reject) => {
      const socket = netConnect(`\\\\.\\pipe\\${pipeName}-${slot++ % 16}`);
      const failed = (error: Error) => { socket.destroy(); reject(error); };
      socket.once('error', failed); socket.setTimeout(1000, () => failed(new Error('connect timeout')));
      socket.once('connect', () => { socket.removeListener('error', failed); socket.setTimeout(0); resolve(socket); });
    }); } catch { /* only retry before any request bytes are sent */ }
  }
  throw new Error('managed control connection unavailable');
}
export async function connectManaged(discoveryFile: string, expected?: { runId: string; pipeName: string; terminalPid?: number }): Promise<ManagedSession> {
  const discovery = JSON.parse(readFileSync(discoveryFile, 'utf8')) as Discovery;
  if (!/^meristem-cc01-control-[a-zA-Z0-9-]{1,90}$/.test(discovery.pipeName) || !discovery.ownerId || !discovery.ownerEpoch || !discovery.token || !discovery.windowBindingId) throw new Error('explicit managed discovery required');
  if (expected && (discovery.runId !== expected.runId || discovery.pipeName !== expected.pipeName)) throw new Error('discovery does not match the window target');
  const sockets = new Set<Socket>(); let disposed = false;
  async function request(method: string, params: Record<string, unknown> = {}, lease = false): Promise<any> {
    if (disposed) return Promise.reject(new Error('management connection closed'));
    const socket = await availablePipe(discovery.pipeName);
    if (disposed) { socket.destroy(); throw new Error('management connection closed'); }
    return new Promise((resolve, reject) => {
      sockets.add(socket);
      let buffer = Buffer.alloc(0), settled = false;
      const fail = () => { if (!settled) { settled = true; reject(new Error('managed control unavailable')); } socket.destroy(); };
      socket.setTimeout(method === 'usage' ? 50000 : ['worker_history', 'resume_worker_history'].includes(method) ? 20000 : 12000, fail); socket.once('error', fail); socket.once('end', fail);
      socket.once('close', () => { sockets.delete(socket); if (!settled) fail(); if (lease) dispose(); });
      socket.on('data', chunk => {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]); if (buffer.length > 262144) return fail();
        const end = buffer.indexOf(10); if (end < 0) return;
        try {
          const response = JSON.parse(buffer.subarray(0, end).toString('utf8'));
          if (!response.ok) return fail();
          settled = true; resolve(response); if (lease) socket.setTimeout(0); else socket.destroy();
        } catch { fail(); }
      });
      socket.write(JSON.stringify({ ...discovery, method, ...params }) + '\n');
    });
  }
  function dispose() { if (disposed) return; disposed = true; for (const socket of sockets) socket.destroy(); sockets.clear(); }
  try {
    const lease = await request('lease', { sessionKind: 'vscode', ...(expected?.terminalPid && {terminal:{pid:expected.terminalPid}}) }, true);
    if (expected && !lease.leaseId) throw new Error('verified VS Code lease required');
    let pending: { id: string; parent: string } | undefined, runState: string | undefined, started = false, approvalKeys: string[] = [];
    const terminals: ManagedSession['terminals'] = [], known = new Set<string>();
    let lastRevision: number | undefined, terminalProbeAt = 0;
    async function refresh(): Promise<boolean> {
      let offset: number | null = 0;
      let revision: number | undefined;
      do {
      const probeTerminal = !!expected?.terminalPid && offset === 0 && !started && !pending && Date.now() >= terminalProbeAt;
      if (probeTerminal) terminalProbeAt = Date.now() + 2500;
      const status = await request('status', { attemptOffset: offset, registrationOnly: true, ...(probeTerminal && {terminalParent:true, leaseId:lease.leaseId}) });
      if (offset === 0) {
        revision = status.run?.revision;
        runState = status.run?.state;
        started = status.binding?.state === 'consumed';
        if (!lease.leaseId || runState !== 'active' || started) pending = undefined;
        else if (status.binding?.state === 'pending') pending = status.binding;
        else if (expected?.terminalPid && status.terminalParent) pending = {id: status.terminalParent.threadId, parent: JSON.stringify(status.terminalParent)};
        else if (!expected?.terminalPid) pending = undefined;
        approvalKeys = status.pendingApprovalKeys ?? [];
      }
      for (const attempt of status.attempts as ManagedAttempt[]) {
      const registration = attempt.registration;
      if (known.has(registration.worker.attemptId) || registration.worker.threadId === 'pending' || registration.binding.windowBindingId !== discovery.windowBindingId) continue;
      const worker: WorkerRef = { id: registration.worker.workerId, pipeName: discovery.pipeName, cwd: registration.cwd, branch: registration.branch, agent: `${registration.model} / ${registration.effort}`, state: attempt.state, actor: `${registration.worker.ownerId}/${registration.worker.ownerEpoch}/${registration.worker.threadId}`, attemptId: registration.worker.attemptId };
      const binding: TerminalBinding = { worker, attemptId: registration.worker.attemptId, managed: true,
        presentation: { displayName: registration.displayName ?? worker.id, taskId: registration.taskId, activity: '情報なし', activitySource: null, lastActivityAt: null, decisionIds: [] } };
      const isWorker = (target: WorkerRef) => target.id === worker.id && target.pipeName === worker.pipeName && target.actor === worker.actor && target.attemptId === worker.attemptId;
      const connection: ControlConnection = {
        async readEvents(afterSeq, limit, afterActivitySeq = 0) {
          const result = await request('events', { afterSeq, limit, attemptId: binding.attemptId, afterActivitySeq });
          const eventForWorker = (event: Omit<DisplayEvent, 'worker'>): DisplayEvent => ({ seq: event.seq, worker, text: event.text, source: event.source });
          return { events: result.events.filter((event: { attemptId?: string }) => !event.attemptId || event.attemptId === binding.attemptId).map(eventForWorker),
            lastSeq: result.lastSeq, hasMore: result.events.length >= limit, activityEvents: result.activityEvents?.map(eventForWorker),
            lastActivitySeq: result.lastActivitySeq, omittedActivityCount: result.omittedActivityCount };
        },
        async getStatus(target) {
          if (!isWorker(target)) throw new Error('worker binding mismatch');
          const current = await request('status', { attemptId: binding.attemptId }), row = (current.attempts as ManagedAttempt[]).find(a => a.registration.worker.attemptId === binding.attemptId);
          if (!row || JSON.stringify(row.registration.worker) !== JSON.stringify(registration.worker)) throw new Error('stale attempt binding');
          const { state, presentation, consultations, consultationsTruncated, permissionSummary, appliedAgent, lastResult, connection, taskState, slotReleased } = row;
          return { cwd: worker.cwd, branch: worker.branch, agent: `${row.registration.model} / ${row.registration.effort}`, state,
            presentation, consultations, consultationsTruncated, permissionSummary, appliedAgent, lastResult, connection, taskState, slotReleased };
        },
        async stop(target) {
          if (target.attemptId !== binding.attemptId || !isWorker(target.worker)) throw new Error('stale terminal binding');
          const response = await request('close_terminal', { binding: registration.binding });
          return { ok: response.result?.state === 'stopped', state: response.result?.state ?? 'unknown' };
        },
        async retire(target) {
          if (target.attemptId !== binding.attemptId || !isWorker(target.worker)) throw new Error('stale terminal binding');
          const response = await request('retire_worker', { binding: registration.binding });
          return { ok: response.result?.state === 'stopped', state: response.result?.state ?? 'unknown' };
        },
        async rename(target, displayName) {
          if (target.attemptId !== binding.attemptId || !isWorker(target.worker)) throw new Error('stale terminal binding');
          return (await request('rename_worker', { target: registration.worker, displayName })).displayName;
        },
        dispose() { /* the window lease, not an individual tab, owns this session */ }
      };
      known.add(registration.worker.attemptId); terminals.push({ connection, binding });
      }
      offset = status.nextAttemptOffset ?? null;
      } while (offset !== null);
      const changed = lastRevision !== undefined && revision !== lastRevision;
      lastRevision = revision;
      return changed;
    }
    await refresh();
    return { terminals, refresh, dispose,
      get pendingStart() { return pending?.id; }, get approvalKeys() { return approvalKeys; },
      get runState() { return runState; }, get started() { return started; }, get closed() { return disposed; },
      async preview() {
        if (!pending) throw new Error('verified start request required');
        return request('preview_parent_start', { leaseId: lease.leaseId, parent: JSON.parse(pending.parent) });
      },
      async start(preview) {
        if (!pending || preview.runId !== discovery.runId || JSON.parse(pending.parent).threadId !== preview.parent.threadId) throw new Error('start request changed');
        await request('start_parent', { leaseId: lease.leaseId, parent: preview.parent, scopeHash: preview.scopeHash, operationId: randomUUID() });
      },
      async usage() { return (await request('usage')).capacity; },
      async stopRun() { return request('stop'); },
      async historyTargets(offset = 0) { return request('history_targets', { offset }); },
      async history(target, cursor) { return (await request('worker_history', { selection: { target, cursor } })).result; },
      async prepareHistoryResume(target, expectedRevision) {
        return (await request('resume_worker_history', { windowLease: true, resume: { runId: discovery.runId, operationId: randomUUID(), expectedRevision, target } })).result;
      },
      async pendingDecisions(afterDecisionId) { return request('status', { pendingDecisions: true, afterDecisionId }); },
      async requests() {
        const items: HumanRequest[] = []; let offset: number | null = 0;
        do { const page = await request('requests', { requestOffset: offset }); items.push(...page.requests); offset = page.nextRequestOffset ?? null; } while (offset !== null);
        return items;
      },
      async answer(item, action) { await request('answer_request', { answer: { worker: item.worker, key: item.key, payloadHash: item.payloadHash, formGeneration: item.formGeneration, action } }); }
    };
  } catch (error) { dispose(); throw error; }
}
