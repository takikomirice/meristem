import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Id, ModelId, sameWorker, Worker } from './contracts.js';
import type { WorkerRef, StopResult, ControlEvent } from './contracts.js';
import { pipeRequest, Rpc } from './protocol.js';
import { failureKind, RequestFailure } from './failures.js';
import type { VerifiedPeer, OwnerBinding } from './actors.js';
import { WorkerRequests, type HumanAction, type HumanResponseRef } from './requests.js';

export type RuntimeConfig = { stateDirectory: string; hostExe: string; hostSha256: string; realExe: string; realSha256: string; authHome: string; fixture: boolean; windowsSandbox?: 'elevated' | 'mxc'; mcp?: { pipeName: string; entryPoint: string; entrySha256: string } };
function sandboxOverrides(config: RuntimeConfig): Record<string, string> {
  if (config.windowsSandbox === undefined) return {};
  if (!['elevated', 'mxc'].includes(config.windowsSandbox)) throw new Error('unsupported Windows sandbox');
  return { 'windows.sandbox': config.windowsSandbox };
}
export function permissionOverrides(stateDirectory: string): Record<string, unknown> {
  return { default_permissions: 'meristem-managed', 'permissions.meristem-managed': { extends: ':workspace', filesystem: { [realpathSync(stateDirectory)]: 'deny' } } };
}
export function verifyIsolation(config: RuntimeConfig, cwd: string): { denied: true; sandboxExitCode: number } {
  const canary = path.join(config.stateDirectory, `isolation-${randomUUID()}`);
  const visible = path.join(cwd, `.meristem-isolation-${randomUUID()}`);
  writeFileSync(canary, 'private-control-canary', { mode: 0o600, flag: 'wx' });
  let visibleCreated = false;
  try {
  writeFileSync(visible, 'visible', { flag: 'wx' }); visibleCreated = true;
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  // Verify the command really ran and could read its workspace before testing denied control state.
  const script = `$ErrorActionPreference='Stop'; if([IO.File]::ReadAllText(${quote(visible)}) -ne 'visible'){exit 41}; try{[void][IO.File]::ReadAllText(${quote(canary)});exit 42}catch [System.UnauthorizedAccessException]{exit 0}catch{exit 43}`;
  const profile = `permissions.meristem-managed={extends=":workspace",filesystem={${JSON.stringify(realpathSync(config.stateDirectory))}="deny"}}`;
  const result = spawnSync(config.realExe, ['sandbox', '-C', cwd, '-P', 'meristem-managed', '-c', profile, ...Object.entries(sandboxOverrides(config)).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), path.join(process.env.WINDIR!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, CODEX_HOME: config.authHome }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`child control-state isolation not confirmed (exit ${result.status ?? 'unknown'}, ${result.error ? (result.error as NodeJS.ErrnoException).code : 'process_rejected'})`);
  return { denied: true, sandboxExitCode: result.status };
  } finally { if (visibleCreated) unlinkSync(visible); unlinkSync(canary); }
}
type Assignment = { cwd: string; workerId: string; model: string; effort: string; identity?: Omit<WorkerRef, 'threadId'>; previous?: WorkerRef; gitApprovalRoots?: string[] };
type Identity = { pipeName: string; hostPid: number; hostCreated: string; childPid: number; childCreated: string; jobId: string };
type Live = { worker: WorkerRef; child: ChildProcessWithoutNullStreams; rpc: Rpc; identity: Identity; assignment: Assignment; provider?: string; turnId?: string; complete: boolean; sending: boolean; lastCompletion?: { id: string; complete: boolean }; pendingRequest: boolean; requests: WorkerRequests; stopping?: Promise<StopResult>; result?: StopResult };
async function assertAgentAvailable(rpc: Rpc, agent: { model: string; effort: string }): Promise<void> {
  ModelId.parse(agent.model); Id.parse(agent.effort);
  const seen = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const catalog = await rpc.call('model/list', cursor ? { cursor } : {});
    if (!Array.isArray(catalog.data)) throw new Error('invalid model catalog');
    if (catalog.data.some((m: any) => m?.model === agent.model && Array.isArray(m.supportedReasoningEfforts) && m.supportedReasoningEfforts.some((e: any) => e?.reasoningEffort === agent.effort))) return;
    if (catalog.nextCursor === null || catalog.nextCursor === undefined) break;
    if (typeof catalog.nextCursor !== 'string' || !catalog.nextCursor || seen.has(catalog.nextCursor)) throw new Error('invalid model catalog cursor');
    seen.add(catalog.nextCursor); cursor = catalog.nextCursor;
  }
  throw new Error('agent is not in catalog');
}
export class WorkerRuntime {
  private live = new Map<string, Live>();
  private brokerCreated: string;
  constructor(private config: RuntimeConfig, private onState: (worker: WorkerRef, kind: ControlEvent['kind']) => void = () => {}, private onRequest: (item: import('./requests.js').HumanRequest) => void = () => {}) {
    sandboxOverrides(config);
    this.config = config = { ...config, realExe: realpathSync(config.realExe), hostExe: realpathSync(config.hostExe) };
    for (const [exe, hash] of [[config.hostExe, config.hostSha256], [config.realExe, config.realSha256]]) {
      if (!path.isAbsolute(exe) || createHash('sha256').update(readFileSync(exe)).digest('hex') !== hash) throw new Error('executable identity mismatch');
    }
    if (config.fixture && path.basename(config.realExe) !== 'MockCodex.exe') throw new Error('fixture requires MockCodex');
    const identity = spawnSync(config.hostExe, ['--identity', String(process.pid)], { encoding: 'utf8', windowsHide: true });
    if (identity.status !== 0 || !/^\d+$/.test(identity.stdout.trim())) throw new Error('broker identity unavailable');
    this.brokerCreated = identity.stdout.trim();
  }
  async start(assignment: Assignment): Promise<WorkerRef> {
    Id.parse(assignment.workerId); ModelId.parse(assignment.model); Id.parse(assignment.effort);
    const cwd = realpathSync(assignment.cwd), state = realpathSync(this.config.stateDirectory);
    const approvalRoots = (assignment.gitApprovalRoots ?? []).map(root => realpathSync(root));
    if (approvalRoots.some(root => state.toLowerCase() === root.toLowerCase() || state.toLowerCase().startsWith(root.toLowerCase() + path.sep) || root.toLowerCase().startsWith(state.toLowerCase() + path.sep))) throw new Error('Git approval cannot include management state');
    let previous: Live | undefined;
    if (assignment.previous) {
      previous = this.get(assignment.previous);
      if (!previous.complete || previous.result?.state !== 'stopped' || previous.pendingRequest || previous.assignment.cwd.toLowerCase() !== cwd.toLowerCase() || previous.worker.workerId !== assignment.workerId) throw new Error('previous attempt is not clean and completed');
      const git = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, windowsHide: true, encoding: 'utf8' });
      if (git.status !== 0 || git.stdout.trim()) throw new Error('history reuse requires a clean Git worktree');
    }
    if (state.toLowerCase() === cwd.toLowerCase() || state.toLowerCase().startsWith(cwd.toLowerCase() + path.sep)) throw new Error('management state must be outside worker cwd');
    if (!this.config.fixture) verifyIsolation(this.config, cwd);
    if (this.config.mcp && createHash('sha256').update(readFileSync(this.config.mcp.entryPoint)).digest('hex') !== this.config.mcp.entrySha256) throw new Error('MCP entry identity mismatch');
    const base = assignment.identity ?? { workerId: assignment.workerId, attemptId: randomUUID(), ownerId: randomUUID(), ownerEpoch: randomUUID() };
    Worker.parse({ ...base, threadId: 'pending' });
    if (base.workerId !== assignment.workerId) throw new Error('assignment identity mismatch');
    const pipeName = `meristem-cc01-worker-${randomUUID()}`, configPath = path.join(state, base.attemptId + '.json');
    writeFileSync(configPath, JSON.stringify({ ...base, brokerPid: process.pid, brokerCreated: this.brokerCreated, realExecutable: this.config.realExe, realSha256: this.config.realSha256, cwd, model: assignment.model, effort: assignment.effort, ...(this.config.mcp ? { mcp: { ...this.config.mcp, nodeExecutable: process.execPath, nodeSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') } } : {}) }), { flag: 'wx' });
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.config.authHome };
    for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key)) delete env[key];
    const child = spawn(this.config.hostExe, ['--mode', 'codex-managed', '--pipe', pipeName, '--exe', this.config.realExe, '--cwd', cwd, '--config', configPath, '--broker-stdin', 'true'], { cwd, env, windowsHide: true, stdio: 'pipe' });
    let entry: Live | undefined;
    const rpc = new Rpc(child, message => {
      if (!entry) return;
      if (message.id !== undefined) {
        entry.pendingRequest = true;
        try { const request = entry.requests.add(message, entry.turnId); this.onState(entry.worker, request.kind === 'question' && request.state === 'pending' ? 'waiting_input' : 'waiting_approval'); } catch { this.onState(entry.worker, 'unknown'); return; }
      }
      else if (message.method === 'serverRequest/resolved') {
        entry.requests.resolved(message.params?.threadId, message.params?.requestId);
        entry.pendingRequest = entry.requests.blocking;
        if (!entry.pendingRequest && !entry.stopping) this.onState(entry.worker, entry.complete ? 'completed' : 'running');
      }
      else if (message.method === 'turn/started' && message.params?.threadId === entry.worker.threadId && typeof message.params?.turn?.id === 'string' && !entry.stopping) {
        entry.turnId = Id.parse(message.params.turn.id); entry.complete = false;
      }
      else if (message.method === 'turn/completed' && message.params?.threadId === entry.worker.threadId && typeof message.params?.turn?.id === 'string') {
        if (message.params.turn.status !== 'completed') entry.requests.cancelTurn(message.params.turn.id);
        entry.pendingRequest = entry.requests.blocking;
        entry.lastCompletion = { id: message.params.turn.id, complete: message.params.turn.status === 'completed' };
        if (entry.turnId === entry.lastCompletion.id && !entry.stopping) {
          entry.complete = entry.lastCompletion.complete;
          if (entry.complete && entry.requests.list().some(r => r.delivery === 'next_turn' && r.state === 'pending')) this.onState(entry.worker, 'waiting_input');
          if (!entry.complete || !entry.pendingRequest) this.onState(entry.worker, entry.complete ? 'completed' : failureKind(message.params.turn.error));
        }
      }
    });
    try {
      await rpc.call('initialize', { clientInfo: { name: 'meristem-cc01', version: '0.0.0' }, capabilities: { experimentalApi: true } }); rpc.notify('initialized');
      await assertAgentAvailable(rpc, assignment);
      const overrides = { ...sandboxOverrides(this.config), ...(this.config.fixture ? {} : permissionOverrides(state)), ...(approvalRoots.length ? { 'features.request_permissions_tool': true, 'features.exec_permission_approvals': true } : {}), ...(this.config.mcp ? { 'mcp_servers.meristem': { command: process.execPath, args: [this.config.mcp.entryPoint, '--pipe', this.config.mcp.pipeName] } } : {}) };
      const thread = await rpc.call(previous ? 'thread/resume' : 'thread/start', { ...(previous ? { threadId: previous.worker.threadId } : { cwd, ephemeral: false }), model: assignment.model, permissions: this.config.fixture ? ':workspace' : 'meristem-managed', ...(Object.keys(overrides).length ? { config: overrides } : {}) });
      if (!this.config.fixture && thread.activePermissionProfile?.id !== 'meristem-managed') throw new Error('managed permission profile not confirmed');
      if (!thread.thread?.id || thread.thread.parentThreadId || thread.thread.cwd?.toLowerCase() !== cwd.toLowerCase() || (previous && (thread.thread.id !== previous.worker.threadId || thread.thread.status?.type !== 'idle' || thread.thread.modelProvider !== previous.provider))) throw new Error('root thread identity or provider mismatch');
      if (thread.model !== assignment.model || typeof thread.thread.modelProvider !== 'string') throw new Error('requested model or provider not confirmed');
      const environments = thread.thread.environments;
      const environmentId = Array.isArray(environments) && environments.length === 1 && environments[0].environmentId === 'local' && typeof environments[0].cwd === 'string' && realpathSync(environments[0].cwd).toLowerCase() === cwd.toLowerCase() ? 'local' : null;
      if (this.config.mcp) {
        const status = await rpc.call('mcpServerStatus/list', { threadId: thread.thread.id, serverName: 'meristem' });
        const server = status.data?.find((server: any) => server.name === 'meristem');
        if (!server || server.toolsError || !server.tools?.start_run || !server.tools?.report) throw new Error('managed MCP catalog unavailable');
      }
      const worker = Worker.parse({ ...base, threadId: thread.thread.id });
      let status: Record<string, unknown> | undefined;
      for (let i = 0; i < 40; i++) { try { status = await pipeRequest(pipeName, { method: 'status', ...base }); if (status.ok) break; } catch {} await delay(50); }
      if (!status?.ok || !status.jobAssigned || status.hostPid !== child.pid) throw new Error('worker identity unavailable');
      const identity = { pipeName, hostPid: Number(status.hostPid), hostCreated: String(status.hostCreated), childPid: Number(status.pid), childCreated: String(status.childCreated), jobId: String(status.jobId) };
      entry = { worker, child, rpc, identity, assignment: { ...assignment, cwd }, provider: thread.thread.modelProvider, complete: false, sending: false, pendingRequest: false, requests: new WorkerRequests(worker, cwd, this.onRequest, approvalRoots, environmentId) };
      child.once('close', () => { if (entry && !entry.stopping && !entry.result) this.onState(entry.worker, 'unknown'); });
      this.live.set(worker.attemptId, entry); return { ...worker };
    } catch (error) {
      rpc.close(); for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(50);
      if (child.exitCode === null && child.signalCode === null) child.kill(); throw error;
    }
  }
  private get(worker: WorkerRef): Live {
    const entry = this.live.get(worker.attemptId); if (!entry || !sameWorker(entry.worker, worker)) throw new Error('worker identity mismatch'); return entry;
  }
  registration(worker: WorkerRef): Identity { return { ...this.get(worker).identity }; }
  completedTurn(worker: WorkerRef): string | undefined { const entry = this.get(worker); return entry.complete ? entry.turnId : undefined; }
  pendingRequests() { return [...this.live.values()].flatMap(entry => entry.requests.list()).slice(0, 4); }
  presentRequest(worker: WorkerRef, key: string) { return this.get(worker).requests.present(key); }
  waitForInput(worker: WorkerRef, text: string, turnId: string): void {
    const entry = this.get(worker);
    if (entry.turnId !== turnId || entry.stopping || entry.complete) throw new Error('question turn mismatch');
    entry.requests.addFollowup(text, turnId); entry.pendingRequest = true; this.onState(worker, 'waiting_input');
  }
  async answerQuestion(worker: WorkerRef, key: string, answers: Record<string, { answers: string[] }>, isCurrent = () => true): Promise<void> {
    let sent = false;
    try {
      const entry = this.get(worker);
      await this.status(worker);
      const item = entry.requests.list().find(r => r.key === key), nextTurn = item?.delivery === 'next_turn';
      if (entry.stopping || entry.result || (nextTurn ? !entry.complete : entry.complete) || !isCurrent()) throw new Error('worker no longer accepts responses');
      if (nextTurn) {
        let text = '';
        entry.requests.answerQuestion(key, answers, (_id, result) => { text = JSON.stringify(result); });
        entry.pendingRequest = false;
        // Original turn has ended. Use the normal turn/start path, never steer or an RPC response.
        sent = true;
        try { await this.send(worker, text); entry.requests.resolved(worker.threadId, item.requestId); }
        catch (error) { if (error instanceof RequestFailure && error.delivery === 'not_sent') { entry.requests.retryFollowup(key); sent = false; } throw error; }
        finally { entry.pendingRequest = entry.requests.blocking; }
        if (entry.complete && !entry.pendingRequest && !entry.stopping) this.onState(worker, 'completed');
        else if (!entry.stopping) this.onState(worker, 'running');
      } else entry.requests.answerQuestion(key, answers, (id, result) => { sent = true; entry.rpc.respond(id, result); });
    } catch (error) { if (!sent) throw new RequestFailure('failed', 'not_sent'); throw error; }
  }
  async answerRequest(worker: WorkerRef, ref: HumanResponseRef, action: HumanAction, isCurrent = () => true): Promise<void> {
    const entry = this.get(worker);
    if (entry.stopping || entry.result || entry.complete) throw new Error('worker no longer accepts responses');
    await this.status(worker);
    if (entry.stopping || entry.result || entry.complete || !isCurrent()) throw new Error('worker stopped during response');
    entry.requests.answer(ref, action, (id, result) => entry.rpc.respond(id, result));
  }
  async resolvePeer(peer: VerifiedPeer, threadId: string, turnId: string): Promise<OwnerBinding | undefined> {
    for (const entry of this.live.values()) {
      if (entry.result || entry.complete || entry.worker.threadId !== threadId || entry.turnId !== turnId) continue;
      const result = await pipeRequest(entry.identity.pipeName, { method: 'verify_peer', ...entry.worker, peerPid: peer.pid, peerCreated: peer.created });
      if (result.ok === true && result.owned === true) return { peer, actor: { ownerId: entry.worker.ownerId, ownerEpoch: entry.worker.ownerEpoch, threadId }, turnId };
    }
    return undefined;
  }
  async status(worker: WorkerRef): Promise<Record<string, unknown>> {
    const entry = this.get(worker);
    const status = await pipeRequest(entry.identity.pipeName, { method: 'status', ...worker });
    if (!status.ok || status.hostPid !== entry.identity.hostPid || status.hostCreated !== entry.identity.hostCreated || status.pid !== entry.identity.childPid || status.childCreated !== entry.identity.childCreated || status.jobId !== entry.identity.jobId) throw new Error('worker process identity mismatch');
    return status;
  }
  async send(worker: WorkerRef, text: string, agent?: { model: string; effort: string }): Promise<void> {
    const entry = this.get(worker);
    if (entry.sending || entry.stopping || entry.pendingRequest || (entry.turnId && !entry.complete)) throw new RequestFailure('failed', 'not_sent');
    entry.sending = true;
    const choice = agent ?? { model: entry.assignment.model, effort: entry.assignment.effort };
    let turnSent = false;
    try {
      await this.status(worker);
      await assertAgentAvailable(entry.rpc, choice);
      if (entry.stopping) throw new Error('worker stopping');
      turnSent = true;
      const result = await entry.rpc.call('turn/start', { threadId: worker.threadId, input: [{ type: 'text', text }], model: choice.model, effort: choice.effort });
      entry.assignment.model = choice.model; entry.assignment.effort = choice.effort;
      entry.turnId = Id.parse(result.turn?.id); entry.complete = entry.lastCompletion?.id === entry.turnId && entry.lastCompletion.complete;
      if (entry.lastCompletion?.id === entry.turnId && !entry.stopping && (!entry.complete || !entry.pendingRequest)) this.onState(entry.worker, entry.complete ? 'completed' : 'failed');
    } catch (error) {
      if (!turnSent) throw new RequestFailure(error instanceof RequestFailure ? error.kind : 'failed', 'not_sent');
      throw error;
    } finally { entry.sending = false; }
  }
  async releaseCompleted(worker: WorkerRef): Promise<StopResult> {
    const entry = this.get(worker); if (!entry.complete || entry.pendingRequest) throw new Error('normal completion not confirmed');
    return this.stop(worker, 'completed');
  }
  async stop(worker: WorkerRef, _reason: string): Promise<StopResult> {
    const entry = this.get(worker);
    if (entry.result) return entry.result;
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      const evidenceRefs: string[] = [];
      // An unavailable request/audit store must never prevent process termination.
      try { entry.requests.cancel(); } catch { evidenceRefs.push('request_cancel_record_failed'); }
      try {
        await this.status(worker);
        if (entry.turnId && !entry.complete) {
          await entry.rpc.call('turn/interrupt', { threadId: worker.threadId, turnId: entry.turnId }, 1000).catch(() => {});
          await delay(3000);
        }
        const stopped = await pipeRequest(entry.identity.pipeName, { method: 'stop', ...worker }, 7000);
        if (stopped.state !== 'stopped' || stopped.jobEmpty !== true) throw new Error('job termination unconfirmed');
        evidenceRefs.push('native_job_empty', 'native_creation_identity');
        entry.rpc.close();
        for (let i = 0; i < 100 && entry.child.exitCode === null && entry.child.signalCode === null; i++) await delay(50);
        if (entry.child.exitCode === null && entry.child.signalCode === null) throw new Error('host termination unconfirmed');
        const marker = path.join(entry.assignment.cwd, 'worker.marker');
        if (this.config.fixture && existsSync(marker)) { const length = readFileSync(marker).length; await delay(2000); if (readFileSync(marker).length !== length) throw new Error('marker still growing'); evidenceRefs.push('marker_stable_2s'); }
        entry.result = { worker, state: 'stopped', evidenceRefs };
      } catch {
        const reason = entry.rpc.failureReason;
        if (reason && reason !== 'owner_closed') evidenceRefs.push(`rpc_${reason}`);
        if (Number.isInteger(entry.child.exitCode)) evidenceRefs.push(`host_exit_${entry.child.exitCode}`);
        entry.rpc.close(); entry.result = { worker, state: 'unknown', evidenceRefs: [...evidenceRefs, 'cleanup_unconfirmed'] };
      }
      return entry.result;
    })();
    return entry.stopping;
  }
}
