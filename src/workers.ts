import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, realpathSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AgentChoice, Id, ModelId, sameWorker, Worker } from './contracts.js';
import type { WorkerRef, StopResult, ControlEvent, Registration } from './contracts.js';
import { sameAgentChoice } from './model-routing.js';
import { pipeRequest, Rpc } from './protocol.js';
import { failureKind, RequestFailure } from './failures.js';
import type { VerifiedPeer, OwnerBinding } from './actors.js';
import { WorkerRequests, type HumanAction, type HumanResponseRef } from './requests.js';
import { READ_ONLY_PROFILE, resolveTaskPermissions, type RunPermissionPermit } from './permissions.js';
import type { AppliedTaskSettings } from './contracts.js';
import { TerminalActivity, terminalText } from './terminal-events.js';
import type { Store } from './store.js';

export type RuntimeConfig = { stateDirectory: string; hostExe: string; hostSha256: string; realExe: string; realSha256: string; authHome: string; fixture: boolean; windowsSandbox?: 'elevated' | 'mxc'; mcp?: { pipeName: string; entryPoint: string; entrySha256: string } };
function sandboxOverrides(config: RuntimeConfig): Record<string, string> {
  if (config.windowsSandbox === undefined) return {};
  if (!['elevated', 'mxc'].includes(config.windowsSandbox)) throw new Error('unsupported Windows sandbox');
  return { 'windows.sandbox': config.windowsSandbox };
}
export function permissionOverrides(stateDirectory: string, writableRoots: string[] = [], profile = 'meristem-managed'): Record<string, unknown> {
  const state = realpathSync(stateDirectory), roots = writableRoots.map(root => realpathSync(root));
  if ((profile !== 'meristem-managed' && profile !== READ_ONLY_PROFILE) || (profile === READ_ONLY_PROFILE && roots.length > 0)) throw new Error('invalid managed permission profile or writable roots');
  if (roots.some(root => pathsOverlap(root, state))) throw new Error('writable roots cannot include management state');
  const base = profile === READ_ONLY_PROFILE ? ':read-only' : ':workspace';
  return { default_permissions: profile, [`permissions.${profile}`]: { extends: base, filesystem: { ...Object.fromEntries(roots.map(root => [root, 'write'])), [state]: 'deny' } } };
}
const readOnlyApproval = { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true } };
const readOnlyFeatures = {
  'features.request_permissions_tool': false, 'features.exec_permission_approvals': false,
  'features.plugins': false, 'features.apps': false, 'features.hooks': false, 'features.skill_mcp_dependency_install': false,
};
async function verifyReadOnlyMcp(rpc: Rpc, threadId: string, meristemConfigured: boolean, startingThread = false) {
  // Query the entire thread inventory. A serverName filter would hide unrelated write-capable tools.
  const deadline = Date.now() + 5000;
  do {
    const inventory = await rpc.call('mcpServerStatus/list', { threadId, limit: 2 }, Math.max(1, deadline - Date.now()));
    if (inventory.nextCursor !== null || !Array.isArray(inventory.data) || inventory.data.length !== (meristemConfigured ? 1 : 0)) break;
    if (!meristemConfigured) return;
    const server = inventory.data[0];
    if (server?.name !== 'meristem' || server.httpOrigin !== null || server.pluginId !== null ||
        server.toolsError !== null || !server.tools?.start_run || !server.tools?.report) break;
    if (server.runtimeStatus === 'connected') return;
    if (!startingThread || server.runtimeStatus !== 'starting') break;
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('read-only MCP inventory not confirmed');
}
const inside = (root: string, child: string) => { const relative = path.relative(root.toLowerCase(), child.toLowerCase()); return !relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
const pathsOverlap = (a: string, b: string) => inside(a, b) || inside(b, a);
export function verifyIsolation(config: RuntimeConfig, cwd: string, taskProfile: 'workspace' | 'read-only' = 'workspace'): { denied: true; sandboxExitCode: number; worktreeWriteDenied?: true } {
  if (taskProfile !== 'workspace' && taskProfile !== 'read-only') throw new Error('unsupported isolation task profile');
  const canary = path.join(config.stateDirectory, `isolation-${randomUUID()}`);
  const visible = path.join(cwd, `.meristem-isolation-${randomUUID()}`);
  writeFileSync(canary, 'private-control-canary', { mode: 0o600, flag: 'wx' });
  let visibleCreated = false;
  try {
    writeFileSync(visible, 'visible', { flag: 'wx' }); visibleCreated = true;
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const readOnly = taskProfile === 'read-only';
    const profileId = readOnly ? READ_ONLY_PROFILE : 'meristem-managed';
    const base = readOnly ? ':read-only' : ':workspace';
    const script = [
      "$ErrorActionPreference='Stop'",
      `if([IO.File]::ReadAllText(${quote(visible)}) -ne 'visible'){exit 41}`,
      `try{[void][IO.File]::ReadAllText(${quote(canary)});exit 42}catch [System.UnauthorizedAccessException]{}catch{exit 43}`,
      ...(readOnly ? [`try{[IO.File]::WriteAllText(${quote(visible)},'changed');exit 44}catch [System.UnauthorizedAccessException]{}catch{exit 45}`] : []),
      'exit 0',
    ].join('; ');
    const profile = `permissions.${profileId}={extends=${JSON.stringify(base)},filesystem={${JSON.stringify(realpathSync(config.stateDirectory))}="deny"}}`;
    const result = spawnSync(config.realExe, ['sandbox', '-C', cwd, '-P', profileId, '-c', profile, ...Object.entries(sandboxOverrides(config)).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), path.join(process.env.WINDIR!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, CODEX_HOME: config.authHome }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error(`child control-state isolation not confirmed (exit ${result.status ?? 'unknown'}, ${result.error ? (result.error as NodeJS.ErrnoException).code : 'process_rejected'})`);
    return { denied: true, sandboxExitCode: result.status, ...(readOnly ? { worktreeWriteDenied: true } : {}) };
  } finally { if (visibleCreated) unlinkSync(visible); unlinkSync(canary); }
}
export type HistorySource = { threadId: string; modelProvider: string };
export type Assignment = { cwd: string; workerId: string; model: string; effort: string; permissionProfileId?: string; permissionPermit?: RunPermissionPermit; identity?: Omit<WorkerRef, 'threadId'>; previous?: WorkerRef; historySource?: HistorySource; gitApprovalRoots?: string[]; initialFallback?: AgentChoice };
type Identity = { pipeName: string; hostPid: number; hostCreated: string; childPid: number; childCreated: string; jobId: string };
type Live = { worker: WorkerRef; child: ChildProcessWithoutNullStreams; rpc: Rpc; identity: Identity; assignment: Assignment; settings: AppliedTaskSettings; activity: TerminalActivity; provider: string; turnId?: string; turnRequested?: boolean; complete: boolean; sending: boolean; lastCompletion?: { id: string; complete: boolean }; pendingRequest: boolean; requests: WorkerRequests; stopping?: Promise<StopResult>; result?: StopResult };
const historyPageSize = 8;
const historyCursor = z.string().min(1).max(8192);
export const HistorySelection = z.object({ target: Worker, cursor: historyCursor.optional() }).strict();
const historyThread = z.object({
  thread: z.object({ id: Id, cwd: z.string(), parentThreadId: Id.nullish(), modelProvider: ModelId }),
});
const historyPage = z.object({
  data: z.array(z.object({ id: Id, status: z.enum(['completed', 'interrupted', 'failed', 'inProgress']), items: z.array(z.unknown()) })).max(historyPageSize),
  nextCursor: historyCursor.nullable(),
});
const historyText = z.object({ type: z.literal('text'), text: z.string() });
const historyItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('userMessage'), content: z.array(z.unknown()) }),
  z.object({ type: z.literal('agentMessage'), text: z.string() }),
]);
function historyMessages(items: unknown[]): { role: 'user' | 'assistant'; text: string }[] {
  const messages: { role: 'user' | 'assistant'; text: string }[] = [];
  function append(role: 'user' | 'assistant', text: string) {
    if (messages.length < 6) messages.push({ role, text: terminalText(text, 1200) });
    else if (messages.length === 6) messages.push({ role, text: '[以降の発言は表示省略]' });
  }
  for (const item of items) {
    const parsed = historyItem.safeParse(item);
    if (!parsed.success) continue;
    if (parsed.data.type === 'agentMessage') {
      append('assistant', parsed.data.text);
      continue;
    }
    for (const input of parsed.data.content) {
      const text = historyText.safeParse(input);
      if (text.success) append('user', text.data.text);
    }
  }
  return messages;
}
export type HistoryReader = Pick<WorkerRuntime, 'readHistory'>;
export async function readSavedWorkerHistory(store: Store, runtime: Partial<HistoryReader>, runId: string, target: WorkerRef, cursor?: string) {
  const reg = store.terminalRegistration(runId, target.attemptId);
  if (!reg || target.threadId === 'pending' || !sameWorker(reg.worker, target)) throw new Error('stale history target');
  try {
    if (!runtime.readHistory) throw new Error('history reader unavailable');
    const history = await runtime.readHistory(target, reg, cursor);
    if (history.threadId !== target.threadId || (reg.modelProvider !== undefined && reg.modelProvider !== history.modelProvider)) {
      return { state: 'history_unavailable', reason: 'history_identity_mismatch' } as const;
    }
    return { state: 'history_read', history } as const;
  } catch (error) {
    const reason = error instanceof Error && error.message === 'history identity or response mismatch' ? 'history_identity_mismatch' : 'history_not_readable';
    return { state: 'history_unavailable', reason } as const;
  }
}
class AgentNotInCatalog extends Error {
  constructor() { super('agent is not in catalog'); }
}
const CatalogEntry = z.object({ model: z.string().min(1), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) })) });
export async function assertAgentAvailable(rpc: Rpc, agent: AgentChoice): Promise<void> {
  ModelId.parse(agent.model); Id.parse(agent.effort);
  const seen = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const catalog = await rpc.call('model/list', cursor ? { cursor } : {});
    const entries = z.array(CatalogEntry).safeParse(catalog.data);
    if (!entries.success) throw new Error('invalid model catalog');
    if (entries.data.some(entry => entry.model === agent.model && entry.supportedReasoningEfforts.some(effort => effort.reasoningEffort === agent.effort))) return;
    if (catalog.nextCursor === null || catalog.nextCursor === undefined) throw new AgentNotInCatalog();
    if (typeof catalog.nextCursor !== 'string' || !catalog.nextCursor || seen.has(catalog.nextCursor)) throw new Error('invalid model catalog cursor');
    seen.add(catalog.nextCursor); cursor = catalog.nextCursor;
  }
  throw new Error('model catalog page limit exceeded');
}

async function catalogChoice(rpc: Rpc, choice: AgentChoice, fallback?: AgentChoice): Promise<AgentChoice | undefined> {
  try { await assertAgentAvailable(rpc, choice); }
  catch (error) {
    if (!fallback || !(error instanceof AgentNotInCatalog)) throw error;
    await assertAgentAvailable(rpc, fallback);
    return fallback;
  }
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
  private appServerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.config.authHome };
    for (const key of Object.keys(env)) if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|BEARER|CODEX_THREAD_ID|CODEX_TURN_ID/i.test(key)) delete env[key];
    return env;
  }
  async start(assignment: Assignment): Promise<WorkerRef> {
    Id.parse(assignment.workerId); ModelId.parse(assignment.model); Id.parse(assignment.effort);
    if (assignment.initialFallback) {
      AgentChoice.parse(assignment.initialFallback);
      if (assignment.previous || assignment.historySource || sameAgentChoice(assignment, assignment.initialFallback)) throw new Error('invalid initial model fallback');
    }
    const cwd = realpathSync(assignment.cwd), state = realpathSync(this.config.stateDirectory);
    const agent = { model: assignment.model, effort: assignment.effort, permissionProfileId: assignment.permissionProfileId ?? 'workspace' };
    const permissions = resolveTaskPermissions(agent, assignment.permissionPermit ?? { allowedProfileIds: ['workspace'], writableRoots: [cwd], allowedReviewers: ['user'] }, cwd);
    const readOnly = permissions.permissionProfileId === READ_ONLY_PROFILE;
    const approvalPolicy = readOnly ? readOnlyApproval : 'on-request';
    const managedOverrides = permissionOverrides(state, permissions.writableRoots, permissions.permissionProfileId);
    if (readOnly && assignment.gitApprovalRoots?.length) throw new Error('read-only worker cannot request Git grants');
    const approvalRoots = (assignment.gitApprovalRoots ?? []).map(root => realpathSync(root));
    if (approvalRoots.some(root => state.toLowerCase() === root.toLowerCase() || state.toLowerCase().startsWith(root.toLowerCase() + path.sep) || root.toLowerCase().startsWith(state.toLowerCase() + path.sep))) throw new Error('Git approval cannot include management state');
    let previous: Live | undefined;
    if (assignment.previous && assignment.historySource) throw new Error('ambiguous history source');
    if (assignment.previous) {
      previous = this.get(assignment.previous);
      if (!previous.complete || previous.result?.state !== 'stopped' || previous.pendingRequest || previous.assignment.cwd.toLowerCase() !== cwd.toLowerCase() || previous.worker.workerId !== assignment.workerId) throw new Error('previous attempt is not clean and completed');
      const git = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, windowsHide: true, encoding: 'utf8' });
      if (git.status !== 0 || git.stdout.trim()) throw new Error('history reuse requires a clean Git worktree');
    }
    const historySource = previous ? { threadId: previous.worker.threadId, modelProvider: previous.provider } : assignment.historySource;
    if (historySource) { Id.parse(historySource.threadId); ModelId.parse(historySource.modelProvider); }
    if (pathsOverlap(state, cwd)) throw new Error('management state must be outside worker cwd');
    if (!this.config.fixture) verifyIsolation(this.config, cwd, readOnly ? 'read-only' : 'workspace');
    if (this.config.mcp && createHash('sha256').update(readFileSync(this.config.mcp.entryPoint)).digest('hex') !== this.config.mcp.entrySha256) throw new Error('MCP entry identity mismatch');
    const base = assignment.identity ?? { workerId: assignment.workerId, attemptId: randomUUID(), ownerId: randomUUID(), ownerEpoch: randomUUID() };
    Worker.parse({ ...base, threadId: 'pending' });
    if (base.workerId !== assignment.workerId) throw new Error('assignment identity mismatch');
    const pipeName = `meristem-cc01-worker-${randomUUID()}`, configPath = path.join(state, base.attemptId + '.json');
    writeFileSync(configPath, JSON.stringify({ ...base, brokerPid: process.pid, brokerCreated: this.brokerCreated, realExecutable: this.config.realExe, realSha256: this.config.realSha256, cwd, model: assignment.model, effort: assignment.effort, ...(this.config.mcp ? { mcp: { ...this.config.mcp, nodeExecutable: process.execPath, nodeSha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') } } : {}) }), { flag: 'wx' });
    const child = spawn(this.config.hostExe, ['--mode', 'codex-managed', '--pipe', pipeName, '--exe', this.config.realExe, '--cwd', cwd, '--config', configPath, '--broker-stdin', 'true'], { cwd, env: this.appServerEnv(), windowsHide: true, stdio: 'pipe' });
    let entry: Live | undefined;
    const rpc = new Rpc(child, message => {
      if (!entry) return;
      if (message.id !== undefined) {
        entry.pendingRequest = true;
        try { const request = entry.requests.add(message, entry.turnId); this.onState(entry.worker, request.kind === 'question' && request.state === 'pending' ? 'waiting_input' : 'waiting_approval'); } catch { this.onState(entry.worker, 'unknown'); return; }
      }
      else if (message.method === 'thread/settings/updated' && !entry.stopping && message.params?.threadId === entry.worker.threadId) {
        const settings = message.params.threadSettings;
        // This notification does not echo the workspace roots. Permission labels come exclusively from verified thread/start.
        if (settings?.modelProvider === entry.provider && typeof settings.cwd === 'string' && settings.cwd.toLowerCase() === entry.assignment.cwd.toLowerCase() &&
            ModelId.safeParse(settings.model).success && Id.safeParse(settings.effort).success) {
          entry.activity.recordAgent({ model: settings.model, effort: settings.effort });
        }
      }
      else if (message.method === 'item/started' || message.method === 'item/completed') {
        if (!entry.stopping && !entry.complete && entry.turnId && message.params?.threadId === entry.worker.threadId && message.params?.turnId === entry.turnId) {
          entry.activity.record(message.method, message.params.item);
        }
      }
      else if (message.method === 'item/autoApprovalReview/completed') {
        entry.requests.autoReviewCompleted(message.params);
        entry.pendingRequest = entry.requests.blocking;
        if (entry.pendingRequest) this.onState(entry.worker, 'waiting_approval');
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
      const fallback = await catalogChoice(rpc, assignment, assignment.initialFallback);
      if (fallback) {
        assignment = { ...assignment, ...fallback, initialFallback: undefined };
        Object.assign(agent, fallback);
      }
      const overrides = { ...sandboxOverrides(this.config), ...managedOverrides, model_reasoning_effort: assignment.effort, ...(readOnly ? readOnlyFeatures : approvalRoots.length ? { 'features.request_permissions_tool': true, 'features.exec_permission_approvals': true } : {}), ...(this.config.mcp ? { 'mcp_servers.meristem': { command: process.execPath, args: [this.config.mcp.entryPoint, '--pipe', this.config.mcp.pipeName] } } : {}) };
      // This target has no verified grant-reset API. Never resume persisted grants.
      // Keep the verified Git worktree and source reference; start an independent thread.
      const thread = await rpc.call('thread/start', { cwd, ephemeral: false, runtimeWorkspaceRoots: [cwd], model: assignment.model, allowProviderModelFallback: false, permissions: permissions.permissionProfileId, approvalsReviewer: permissions.approvalsReviewer, approvalPolicy, config: overrides,
        ...(historySource ? { developerInstructions: `Continue the assigned task in this verified Git worktree. Previous task thread reference: ${historySource.threadId}. Conversation and permission grants have not been resumed. Use the new task instruction and committed files; consult the coordinator for missing context.` } : {}) });
      if (thread.activePermissionProfile?.id !== permissions.permissionProfileId || thread.activePermissionProfile.extends !== (readOnly ? ':read-only' : ':workspace')) throw new Error('managed permission profile not confirmed');
      if (readOnly && !isDeepStrictEqual(thread.sandbox, { type: 'readOnly', networkAccess: false })) throw new Error('read-only sandbox not confirmed');
      if (thread.approvalsReviewer !== permissions.approvalsReviewer || !isDeepStrictEqual(thread.approvalPolicy, approvalPolicy) || thread.reasoningEffort !== assignment.effort) throw new Error('requested task settings not confirmed');
      if (!Array.isArray(thread.runtimeWorkspaceRoots) || thread.runtimeWorkspaceRoots.length !== 1 || typeof thread.runtimeWorkspaceRoots[0] !== 'string' || realpathSync(thread.runtimeWorkspaceRoots[0]).toLowerCase() !== cwd.toLowerCase()) throw new Error('requested workspace roots not confirmed');
      if (!thread.thread?.id || thread.thread.parentThreadId || thread.thread.cwd?.toLowerCase() !== cwd.toLowerCase() || (historySource && (thread.thread.id === historySource.threadId || thread.thread.modelProvider !== historySource.modelProvider))) throw new Error('root thread identity or provider mismatch');
      if (thread.model !== assignment.model || !ModelId.safeParse(thread.thread.modelProvider).success) throw new Error('requested model or provider not confirmed');
      const environments = thread.thread.environments;
      const environmentId = Array.isArray(environments) && environments.length === 1 && environments[0].environmentId === 'local' && typeof environments[0].cwd === 'string' && realpathSync(environments[0].cwd).toLowerCase() === cwd.toLowerCase() ? 'local' : null;
      if (readOnly) await verifyReadOnlyMcp(rpc, thread.thread.id, !!this.config.mcp, true);
      else if (this.config.mcp) {
        const status = await rpc.call('mcpServerStatus/list', { threadId: thread.thread.id, serverName: 'meristem' });
        const server = status.data?.find((server: any) => server.name === 'meristem');
        if (!server || server.toolsError || !server.tools?.start_run || !server.tools?.report) throw new Error('managed MCP catalog unavailable');
      }
      const worker = Worker.parse({ ...base, threadId: thread.thread.id });
      let status: Record<string, unknown> | undefined;
      for (let i = 0; i < 40; i++) { try { status = await pipeRequest(pipeName, { method: 'status', ...base }); if (status.ok) break; } catch {} await delay(50); }
      if (!status?.ok || !status.jobAssigned || status.hostPid !== child.pid) throw new Error('worker identity unavailable');
      const identity = { pipeName, hostPid: Number(status.hostPid), hostCreated: String(status.hostCreated), childPid: Number(status.pid), childCreated: String(status.childCreated), jobId: String(status.jobId) };
      entry = { worker, child, rpc, identity, assignment: { ...assignment, cwd }, settings: { agent, permissions, history: historySource ? 'fresh_handoff' : 'new', ...(historySource ? { sourceThreadId: historySource.threadId } : {}), ...(fallback ? { initialFallback: 'agent_not_in_catalog' } : {}) }, activity: new TerminalActivity({ model: agent.model, effort: agent.effort }), provider: thread.thread.modelProvider, complete: false, sending: false, pendingRequest: false, requests: new WorkerRequests(worker, cwd, this.onRequest, approvalRoots, environmentId) };
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
  registration(worker: WorkerRef): Identity & { modelProvider: string } {
    const entry = this.get(worker);
    return { ...entry.identity, modelProvider: entry.provider };
  }
  settings(worker: WorkerRef): AppliedTaskSettings { return structuredClone(this.get(worker).settings); }
  terminalActivity(worker: WorkerRef): TerminalActivity | undefined {
    const entry = this.live.get(worker.attemptId);
    return entry && sameWorker(entry.worker, worker) ? entry.activity : undefined;
  }
  terminalTelemetry(worker: WorkerRef) {
    const activity = this.terminalActivity(worker);
    if (!activity) return {};
    const { permissionProfileId, approvalsReviewer } = this.get(worker).settings.permissions;
    const access = permissionProfileId === READ_ONLY_PROFILE ? '読み取り専用' : '割り当て先への書き込み';
    return { activity, appliedAgent: activity.agent && `${activity.agent.model} / ${activity.agent.effort}`,
      permissionSummary: `${permissionProfileId}（${access}、承認: ${approvalsReviewer}）` };
  }
  /** The broker supplies the trusted registration for the selected attempt. */
  async readHistory(worker: WorkerRef, registration: Pick<Registration, 'worker' | 'cwd' | 'modelProvider'>, cursor?: string) {
    const { threadId, attemptId } = Worker.parse(worker);
    const live = this.live.get(attemptId);
    if (threadId === 'pending' || !sameWorker(registration.worker, worker) || (live && !sameWorker(live.worker, worker))) throw new Error('worker identity mismatch');
    if (!path.isAbsolute(registration.cwd)) throw new Error('invalid history working directory');
    const cwd = path.resolve(registration.cwd).toLowerCase();
    if (live && path.resolve(live.assignment.cwd).toLowerCase() !== cwd) throw new Error('worker identity mismatch');
    if (cursor !== undefined && !historyCursor.safeParse(cursor).success) throw new Error('invalid history cursor');

    // Bound history reads to a disposable stdio connection. A bad history frame cannot close a worker transport.
    const { realExe, realSha256, stateDirectory } = this.config;
    const executableHash = createHash('sha256');
    for await (const chunk of createReadStream(realExe)) executableHash.update(chunk);
    if (executableHash.digest('hex') !== realSha256) throw new Error('executable identity mismatch');
    const child = spawn(realExe, ['app-server'], { cwd: stateDirectory, env: this.appServerEnv(), windowsHide: true, stdio: 'pipe' });
    const closed = new Promise<boolean>(resolve => child.once('close', () => resolve(true)));
    const rpc = new Rpc(child, () => {});
    try {
      await rpc.call('initialize', { clientInfo: { name: 'meristem-history', version: '0.0.0' }, capabilities: { experimentalApi: true } }, 4000);
      rpc.notify('initialized');
      const metadata = historyThread.safeParse(await rpc.call('thread/read', { threadId, includeTurns: false }, 4000));
      if (!metadata.success) throw new Error('history identity or response mismatch');
      const { thread } = metadata.data;
      if (thread.id !== threadId || thread.parentThreadId != null || !path.isAbsolute(thread.cwd) || path.resolve(thread.cwd).toLowerCase() !== cwd ||
          (live && live.provider !== thread.modelProvider) ||
          (registration.modelProvider !== undefined && registration.modelProvider !== thread.modelProvider)) throw new Error('history identity or response mismatch');

      const page = historyPage.safeParse(await rpc.call('thread/turns/list', {
        threadId, itemsView: 'summary', limit: historyPageSize, ...(cursor === undefined ? {} : { cursor }),
      }, 4000));
      if (!page.success || page.data.nextCursor === cursor) throw new Error('invalid history page');
      const { data: turns, nextCursor } = page.data;
      return { threadId, modelProvider: thread.modelProvider, turns: turns.map(({ id, status, items }) => ({ id, status, messages: historyMessages(items) })), nextCursor };
    } finally {
      rpc.close();
      if (!await Promise.race([closed, delay(1000, false, { ref: false })])) {
        child.kill();
        if (!await Promise.race([closed, delay(1000, false, { ref: false })])) throw new Error('history app-server shutdown unconfirmed');
      }
    }
  }
  completedTurn(worker: WorkerRef): string | undefined { const entry = this.get(worker); return entry.complete ? entry.turnId : undefined; }
  pendingRequests() { return [...this.live.values()].flatMap(entry => entry.requests.list()); }
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
  async send(worker: WorkerRef, text: string, agent?: AgentChoice): Promise<void | 'agent_not_in_catalog'> {
    const entry = this.get(worker);
    if (entry.sending || entry.stopping || entry.pendingRequest || (entry.turnId && !entry.complete)) throw new RequestFailure('failed', 'not_sent');
    entry.sending = true;
    let choice = agent ?? { model: entry.assignment.model, effort: entry.assignment.effort };
    let turnSent = false;
    try {
      await this.status(worker);
      const fallback = await catalogChoice(entry.rpc, choice,
        !entry.turnRequested && sameAgentChoice(choice, entry.settings.agent) ? entry.assignment.initialFallback : undefined);
      if (fallback) choice = fallback;
      if (entry.settings.permissions.permissionProfileId === READ_ONLY_PROFILE) await verifyReadOnlyMcp(entry.rpc, worker.threadId, !!this.config.mcp);
      if (entry.stopping) throw new Error('worker stopping');
      turnSent = true;
      entry.turnRequested = true;
      const result = await entry.rpc.call('turn/start', { threadId: worker.threadId, input: [{ type: 'text', text }], model: choice.model, effort: choice.effort });
      entry.assignment.model = choice.model; entry.assignment.effort = choice.effort;
      entry.turnId = Id.parse(result.turn?.id); entry.complete = entry.lastCompletion?.id === entry.turnId && entry.lastCompletion.complete;
      if (entry.lastCompletion?.id === entry.turnId && !entry.stopping && (!entry.complete || !entry.pendingRequest)) this.onState(entry.worker, entry.complete ? 'completed' : 'failed');
      if (fallback) return 'agent_not_in_catalog';
    } catch (error) {
      if (!turnSent) {
        const reason = error instanceof AgentNotInCatalog ? 'agent_not_in_catalog' : undefined;
        throw new RequestFailure(error instanceof RequestFailure ? error.kind : 'failed', 'not_sent', undefined, undefined, reason);
      }
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
