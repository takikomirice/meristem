import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Actor, resolveCallContext, sameActor, type ActorRef, type CallerIdentity } from './actors.js';
import { Id, ModelId, Operation, Worker, sameWorker, type Registration, type WorkerRef } from './contracts.js';
import { Broker, PlanControl, type Runtime } from './broker.js';
import { TaskReport, Sha, Checks } from './git-evidence.js';
import { Store } from './store.js';
import { pipeRequest, RpcTransportFailure } from './protocol.js';
import { RequestFailure, RevisionConflict } from './failures.js';
import type { HumanRequest, HumanAction } from './requests.js';

export type FixtureAssignment = { workerId: string; cwd: string; repositoryId: string; branch: string; model: string; effort: string; gitApprovalRoots?: string[] };
export type FixtureScope = { fixture: true; plan?: true; planPath: string; repositoryId: string; repositoryPath: string; branchScope: string[]; windowBindingId: string; maxInstructions?: number; assignments: FixtureAssignment[] };
export interface ManagedRuntime extends Runtime {
  waitForInput?(worker: WorkerRef, text: string, turnId: string): void;
  presentRequest?(worker: WorkerRef, key: string): HumanRequest;
  answerRequest?(worker: WorkerRef, ref: HumanRequest, action: HumanAction, isCurrent: () => boolean): Promise<void>;
  pendingRequests?(): HumanRequest[];
  answerQuestion?(worker: WorkerRef, key: string, answers: Record<string, { answers: string[] }>, isCurrent: () => boolean): Promise<void>;
  start(assignment: { cwd: string; workerId: string; model: string; effort: string; identity: Omit<WorkerRef, 'threadId'>; previous?: WorkerRef; gitApprovalRoots?: string[] }): Promise<WorkerRef>;
  registration(worker: WorkerRef): Pick<Registration, 'hostPid' | 'hostCreated' | 'childPid' | 'childCreated' | 'jobId'>;
}
const schemas = {
  answer_request: Operation.extend({ requestKey: z.string().min(1).max(512), answer: z.record(z.string(), z.object({ answers: z.array(z.string().max(8192)).min(1).max(10) }).strict()).optional() }).strict(),
  start_run: z.object({ planPath: z.string().min(1).max(4096), operationId: Id }).strict(),
  create_worker: Operation.extend({ taskId: Id }).strict(),
  send_instruction: Operation.extend({ taskId: Id, target: Worker, agent: z.object({ model: ModelId, effort: Id }).strict(), text: z.string().min(1).max(65536) }).strict(),
  get_status: z.object({ runId: Id, taskId: Id.optional(), afterEventSeq: z.number().int().nonnegative().optional(), attemptOffset: z.number().int().nonnegative().optional(), reportOffset: z.number().int().nonnegative().optional() }).strict(),
  report: Operation.extend({ taskId: Id, report: z.union([TaskReport, z.object({ summary: z.string().min(1).max(8192), question: z.string().trim().min(1).max(8192).optional(), evidenceRefs: z.array(z.string().max(512)).max(32).optional() }).strict()]) }).strict(),
  record_decision: Operation.extend({ taskId: Id, decision: z.enum(['continue_history', 'new_worker', 'retry_same', 'continue_same', 'handoff_new', 'accept_candidate', 'prepare_integration', 'cancel_integration', 'accept_integration', 'pause', 'finish']), evidenceRefs: z.array(Id).max(32), sourceTaskId: Id.optional(), candidateSha: Sha.optional(), integrationSha: Sha.optional(), inputCandidateShas: z.array(Sha).min(1).max(2).optional(), checks: Checks.optional() }).strict(),
  reconcile_plan: Operation.extend({ expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/), expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  write_progress: Operation.extend({ expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  stop_worker: Operation.extend({ target: Worker }).strict(),
  stop_run: Operation,
  resume_run: Operation
};
export type ToolName = keyof typeof schemas;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class McpController {
  private plan?: PlanControl;
  constructor(private store: Store, private broker: Broker, private runtime: ManagedRuntime, private runId: string, private parent: ActorRef, private scope: FixtureScope) { if (scope.plan) this.plan = new PlanControl(store, runId, () => broker.canWake(runId)); }
  // Only the pinned parent's MCP process can enter this non-tool endpoint.
  async humanResponse(input: unknown, identity: CallerIdentity): Promise<unknown> {
    const args = z.object({ worker: Worker, key: z.string().max(512), payloadHash: z.string().regex(/^[a-f0-9]{64}$/), formGeneration: Id, action: z.enum(['accept', 'decline', 'cancel']) }).strict().parse(input);
    const item = this.runtime.pendingRequests?.().find(r => r.key === args.key);
    const current = () => !!item && this.broker.canReviewRequest(this.runId, item) && this.store.binding(this.runId)?.state === 'consumed' && this.store.binding(this.runId)?.scope_hash === this.scopeHash();
    if (!sameActor(identity.actor, this.parent) || !current() || !this.runtime.answerRequest) throw new Error('human response binding rejected');
    if (!item || !sameWorker(item.worker, args.worker)) throw new Error('stale request');
    this.store.auditHumanRequest(this.runId, { ...item, payloadHash: args.payloadHash, formGeneration: args.formGeneration }, 'response_received', 'parent_mcp', args.action);
    await this.runtime.answerRequest(args.worker, { ...item, payloadHash: args.payloadHash, formGeneration: args.formGeneration }, args.action, current);
    return { state: 'response_sent' };
  }
  private scopeHash(): string {
    if (this.plan) {
      if (this.scope.fixture !== true || this.scope.assignments.length) throw new Error('plan scope cannot contain fixture assignments');
      this.plan.open(this.scope.planPath, this.scope.repositoryPath, this.scope.branchScope);
      this.plan.git().assertRepository();
      return hash({ ...this.scope, planPath: realpathSync(this.scope.planPath), planHash: this.store.plan(this.runId)!.bindingHash, pin: this.store.plan(this.runId)!.pin });
    }
    if (this.scope.fixture !== true || !path.isAbsolute(this.scope.planPath) || !this.scope.assignments.length || this.scope.assignments.length > 2 || new Set(this.scope.assignments.map(a => a.workerId)).size !== this.scope.assignments.length) throw new Error('explicit fixture scope required');
    const git = (cwd: string, args: string[]) => {
      const result = spawnSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0) throw new Error('Git scope unavailable'); return result.stdout.trim();
    };
    const common = realpathSync(git(this.scope.repositoryPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toLowerCase();
    for (const a of this.scope.assignments) {
      if (Buffer.byteLength(a.cwd) > 4096 || Buffer.byteLength(a.branch) > 512) throw new Error('fixture path exceeds supported scope');
      if (a.repositoryId !== this.scope.repositoryId || !this.scope.branchScope.includes(a.branch) || ['main', 'master'].includes(a.branch) || realpathSync(git(a.cwd, ['rev-parse', '--show-toplevel'])).toLowerCase() !== realpathSync(a.cwd).toLowerCase() || realpathSync(git(a.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toLowerCase() !== common || git(a.cwd, ['symbolic-ref', '--short', 'HEAD']) !== a.branch) throw new Error('assignment outside Git scope');
    }
    return hash({ ...this.scope, planPath: realpathSync(this.scope.planPath), planHash: createHash('sha256').update(readFileSync(this.scope.planPath)).digest('hex'), assignments: this.scope.assignments.map(a => ({ ...a, cwd: realpathSync(a.cwd) })) });
  }
  authorize(bindingId: string): void {
    const binding = this.store.binding(this.runId);
    if (!binding || binding.id !== bindingId || binding.scope_hash !== this.scopeHash() || !sameActor(JSON.parse(binding.parent), this.parent)) throw new Error('binding scope mismatch');
    this.store.confirmBinding(bindingId);
  }
  async call(name: string, input: unknown, identity: CallerIdentity): Promise<any> {
    if (!Object.hasOwn(schemas, name)) throw new Error('unsupported tool');
    const args = schemas[name as ToolName].parse(input) as any;
    Actor.parse(identity.actor); Id.parse(identity.turnId);
    if (name === 'start_run') {
      if (!sameActor(identity.actor, this.parent)) throw new Error('only verified parent can request binding');
      if (realpathSync(args.planPath) !== realpathSync(this.scope.planPath)) throw new Error('plan outside fixture scope');
      const scopeHash = this.scopeHash(); let binding = this.store.binding(this.runId);
      const scopeRecord = { ...this.scope, planHash: this.plan ? this.store.plan(this.runId)!.bindingHash : createHash('sha256').update(readFileSync(this.scope.planPath)).digest('hex') };
      if (binding && (binding.scope_hash !== scopeHash || !sameActor(JSON.parse(binding.parent), identity.actor))) {
        const { windowBindingId: _oldWindow, ...oldScope } = JSON.parse(binding.scope);
        const { windowBindingId: _newWindow, ...newScope } = scopeRecord;
        if (hash(oldScope) !== hash(newScope)) throw new Error('rebind scope changed');
        this.store.replaceBinding(randomUUID(), this.runId, args.operationId, this.parent, scopeHash, scopeRecord);
        binding = this.store.binding(this.runId);
      }
      if (!binding) {
        this.store.requestBinding(randomUUID(), this.runId, args.operationId, this.parent, scopeHash, scopeRecord);
        binding = this.store.binding(this.runId);
      }
      if (binding.operation_id !== args.operationId || binding.scope_hash !== scopeHash || !sameActor(JSON.parse(binding.parent), identity.actor)) throw new Error('binding scope or operation mismatch');
      if (binding.state === 'confirmed') this.store.consumeBinding(binding.id);
      return { runId: this.runId, bindingId: binding.id, state: binding.state === 'pending' ? 'awaiting_authorization' : this.store.run(this.runId).state };
    }
    if (args.runId !== this.runId) throw new Error('run binding mismatch');
    const binding = this.store.binding(this.runId);
    if (!binding || binding.state !== 'consumed') throw new Error('human permit required');
    if (!sameActor(JSON.parse(binding.parent), this.parent)) throw new Error('run parent changed');
    let scopeValid = false;
    try { scopeValid = binding.scope_hash === this.scopeHash(); } catch { /* allow observation and safety stops when Git scope drifts */ }
    if (!scopeValid && !['get_status', 'report', 'stop_run', 'stop_worker'].includes(name)) throw new Error('run scope changed');
    if (this.plan && !(name === 'record_decision' && args.decision === 'pause') && !['get_status', 'report', 'stop_run', 'stop_worker', 'reconcile_plan', 'write_progress'].includes(name)) this.plan.assertCurrent();
    const registrations = this.store.attempts(this.runId).map(row => ({ row, reg: JSON.parse(row.registration) as Registration }));
    const context = resolveCallContext(identity, { runId: this.runId, parent: this.parent, workers: registrations.filter(({ row }) => !['completed', 'stopped', 'unknown'].includes(row.state)).map(({ reg }) => reg.worker) });
    if (context.role === 'worker' && !['get_status', 'report'].includes(name)) throw new Error('worker cannot control or accept results');
    const own = registrations.find(({ reg }) => sameActor(reg.worker, identity.actor));
    if (context.role === 'worker' && args.taskId && args.taskId !== own?.reg.taskId) throw new Error('worker cannot access peer');
    if (name === 'get_status') {
      const selected = registrations.filter(({ reg }) => (context.role === 'parent' || reg.worker.attemptId === own?.reg.worker.attemptId) && (!args.taskId || args.taskId === reg.taskId));
      const offset = args.attemptOffset ?? 0, reportOffset = args.reportOffset ?? 0;
      const events = this.store.events(this.runId, args.afterEventSeq ?? 0, 100);
      if (context.role === 'parent' && events.length) this.store.wakeProgress(this.runId, 'read_seq', Number(events.at(-1)!.seq));
      const reports: Record<string, unknown>[] = []; let reportBytes = 0;
      for (const report of this.store.reports(this.runId, context.role === 'worker' ? own!.reg.worker.attemptId : undefined, reportOffset)) {
        const bytes = Buffer.byteLength(JSON.stringify(report)); if (reports.length && reportBytes + bytes > 80000) break;
        reports.push(report); reportBytes += bytes;
      }
      return { ...(this.plan && context.role === 'parent' ? { plan: await this.plan.status() } : {}), requests: this.runtime.pendingRequests?.().filter(r => context.role === 'parent' || r.worker.attemptId === own?.reg.worker.attemptId) ?? [], run: this.store.run(this.runId), scopeValid, attempts: selected.slice(offset, offset + 4).map(({ row, reg }) => ({ state: row.state, worker: reg.worker, taskId: reg.taskId, cwd: reg.cwd, branch: reg.branch, agent: { model: reg.model, effort: reg.effort }, ...(this.plan ? { git: this.store.gitAssignment(reg.worker.attemptId) } : {}), stopResult: row.stop_result ? JSON.parse(row.stop_result) : null })), nextAttemptOffset: selected.length > offset + 4 ? offset + 4 : null, reports, nextReportOffset: this.store.reportCount(this.runId, context.role === 'worker' ? own!.reg.worker.attemptId : undefined) > reportOffset + reports.length ? reportOffset + reports.length : null, events: this.store.events(this.runId, args.afterEventSeq ?? 0, 100) };
    }
    if (name === 'report' && context.role !== 'worker') throw new Error('only main worker can report');
    if (name === 'report' && Buffer.byteLength(JSON.stringify(args.report)) > 60000) throw new Error('report exceeds byte limit');
    if (name === 'report' && this.plan) this.plan.validateReport(args.taskId, own!.reg.worker, args.report);
    const ref = Operation.parse({ operationId: args.operationId, runId: args.runId, expectedRevision: args.expectedRevision });
    if (name === 'send_instruction') {
      const target = registrations.find(({ reg }) => reg.worker.attemptId === args.target.attemptId);
      if (!target || target.reg.taskId !== args.taskId) throw new Error('task target mismatch');
      if (this.plan) {
        const task = this.store.plan(this.runId)!.snapshot.plan.tasks.find(t => t.id === args.taskId);
        if (!task || task.agent.model !== args.agent.model || task.agent.effort !== args.agent.effort || ['completed', 'stopped', 'unknown'].includes(target.row.state)) {
          // Recorded operations remain observable; this never sends to the old attempt again.
          let previous; try { previous = this.store.operation(args.operationId); } catch { /* new instruction */ }
          if (!previous) throw new Error('plan agent or current attempt mismatch');
        }
      }
      if (this.scope.maxInstructions !== undefined) this.store.reserveInstruction(ref, this.scope.maxInstructions);
      return this.broker.dispatch({ kind: 'send', ref, worker: args.target, text: args.text, agent: args.agent });
    }
    // Presenting human consent must not invalidate the revision of the suspended tool call.
    const prepared = this.store.prepareOperation(ref, hash({ name, args, actor: identity.actor }), !(name === 'answer_request' && args.answer === undefined));
    if (!prepared.fresh) return prepared.operation.result ? JSON.parse(prepared.operation.result) : { state: prepared.operation.state };
    const humanRequest = name === 'answer_request' && args.answer === undefined ? this.runtime.pendingRequests?.().find(r => r.key === args.requestKey) : undefined;
    if (!['stop_run', 'stop_worker', 'resume_run', 'report'].includes(name) && !this.broker.canWake(this.runId) && !(humanRequest && this.broker.canReviewRequest(this.runId, humanRequest))) {
      this.store.operationResult(args.operationId, 'cancelled', { state: 'cancelled' }); throw new Error('run is stopped');
    }
    let result: any;
    if (name === 'create_worker') {
      let assignment = this.scope.assignments.find(a => a.workerId === args.taskId);
      let previous = registrations.filter(({ reg }) => reg.taskId === args.taskId).at(-1);
      let reuse = this.store.historyDecision(this.runId, args.taskId) === 'continue_history';
      const attemptId = randomUUID();
      if (this.plan) {
        try {
          this.plan.git().approvalRoots();
          const allocated = this.plan.reserveAssignment(args.taskId, attemptId);
          const gitApprovalRoots = this.plan.git().approvalRoots(allocated.assignment);
          assignment = { workerId: allocated.workerId, cwd: allocated.assignment.cwd, branch: allocated.assignment.branch, repositoryId: this.scope.repositoryId, ...allocated.agent, gitApprovalRoots };
          reuse = !!allocated.previous;
          if (reuse) previous = registrations.find(({ row }) => row.id === allocated.previous!.attemptId);
        } catch (error) { this.store.operationResult(args.operationId, 'cancelled', { state: 'cancelled' }); throw error; }
      }
      if (!assignment) { this.store.operationResult(args.operationId, 'cancelled', { state: 'cancelled' }); throw new Error('task outside fixture scope'); }
      if (registrations.some(({ row, reg }) => reg.taskId === args.taskId && !['completed', 'stopped'].includes(row.state)) || registrations.filter(({ row }) => !['completed', 'stopped'].includes(row.state)).length >= 2 || (reuse && previous?.row.state !== 'completed')) {
        this.store.operationResult(args.operationId, 'cancelled', { state: 'cancelled' }); throw new Error('attempt cleanup or completion is unresolved');
      }
      if (registrations.some(({ reg }) => reg.taskId === args.taskId) && !this.store.reserveCorrection(this.runId, args.taskId)) {
        this.store.operationResult(args.operationId, 'cancelled', { state: 'correction_limit' });
        await this.broker.stopRun(this.runId, 'correction_limit');
        this.store.appendEvent({ runId: this.runId, kind: 'correction_limit' }); throw new Error('correction limit exhausted');
      }
      const identity = { workerId: assignment.workerId, attemptId, ownerId: randomUUID(), ownerEpoch: randomUUID() };
      const pending = { ...identity, threadId: 'pending' };
      const reg: Registration = { ...assignment, runId: this.runId, taskId: args.taskId, assignmentId: randomUUID(), worker: pending, hostPid: 0, hostCreated: 'unconfirmed', childPid: 0, childCreated: 'unconfirmed', jobId: 'unconfirmed', binding: { windowBindingId: this.scope.windowBindingId, terminalId: randomUUID(), worker: pending } };
      let started: WorkerRef | undefined;
      try {
        this.store.reserve(reg); this.store.operationState(args.operationId, 'sent_unknown');
        started = await this.runtime.start({ ...assignment, identity, ...(reuse ? { previous: previous!.reg.worker } : {}) });
        this.store.register({ ...reg, ...this.runtime.registration(started), worker: started, binding: { ...reg.binding, worker: started } });
        this.store.attemptState(started, 'idle');
        this.store.historyDecision(this.runId, args.taskId, 'new_worker'); result = started;
      } catch (error) {
        // Fixed diagnostic labels only; preserve unknown delivery and never expose provider text.
        const known = ['agent is not in catalog', 'managed permission profile not confirmed', 'root thread identity or provider mismatch', 'requested model or provider not confirmed', 'managed MCP catalog unavailable', 'worker identity unavailable', 'MCP entry identity mismatch'];
        const reasons = ['thread_runtime_unavailable', 'mcp_startup_pending', 'experimental_api_required', 'permission_default_required', 'mcp_inventory_failed'];
        const creationFailure = error instanceof RequestFailure ? (reasons.includes(error.reason ?? '') ? error.reason : 'rpc_rejected')
          : error instanceof RpcTransportFailure ? 'rpc_' + error.reason
          : error instanceof Error && known.includes(error.message) ? error.message : 'unclassified';
        try { this.store.operationResult(args.operationId, 'sent_unknown', { state: 'sent_unknown', creationFailure }); }
        catch { /* Optional diagnostics must never prevent the existing stop/cleanup path. */ }
        await this.broker.stopRun(this.runId, 'creation_failed'); if (started) await this.runtime.stop(started, 'registration_failed'); throw error;
      }
    } else if (name === 'answer_request') {
      const item = this.runtime.pendingRequests?.().find(r => r.key === args.requestKey);
      if (!item) throw new Error('unknown request');
      if (item.kind !== 'question') {
        if (args.answer !== undefined) throw new Error('model cannot supply human approval');
        result = { state: item.state === 'unsupported' ? 'unsupported' : 'waiting_approval', route: 'human_modal', requestKey: item.key };
        if (item.state === 'pending' && this.runtime.presentRequest) {
          const form = this.runtime.presentRequest(item.worker, item.key);
          this.store.auditHumanRequest(this.runId, form, 'presentation_prepared', 'parent_mcp');
          // The wire-only form is never stored in operation results or returned to a model.
          this.store.operationResult(args.operationId, 'settled', result);
          return form.state === 'pending' ? { ...result, humanForm: form } : result;
        }
      } else {
        if (!args.answer || !this.runtime.answerQuestion) throw new Error('question answer required');
        if (item.delivery === 'next_turn' && this.scope.maxInstructions !== undefined) this.store.reserveInstruction(ref, this.scope.maxInstructions);
        this.store.operationState(args.operationId, 'sent_unknown');
        try { await this.runtime.answerQuestion(item.worker, item.key, args.answer, () => this.broker.canWake(this.runId)); }
        catch (error) { if (error instanceof RequestFailure && error.delivery === 'not_sent') this.store.operationResult(args.operationId, 'cancelled', { state: 'not_sent' }); throw error; }
        result = { state: 'response_sent' };
      }
    } else if (name === 'report') {
      if (args.report.question) {
        if (!this.runtime.waitForInput) throw new Error('followup questions unsupported');
        this.runtime.waitForInput(own!.reg.worker, args.report.question, identity.turnId);
      }
      this.store.transaction(() => { this.store.saveReport(args, own!.reg.worker, identity.turnId, args.report); this.broker.report(this.runId, own!.reg.worker); this.store.operationResult(args.operationId, 'settled', { state: 'report_saved' }); });
      return { state: 'report_saved' };
    } else if (name === 'record_decision') {
      if (this.plan) {
        try {
          result = await this.plan.decide(args, identity.turnId);
          if (args.decision === 'pause') await this.broker.stopRun(this.runId, 'parent_pause');
          return result;
        } catch (error) { this.store.operationResult(args.operationId, 'cancelled', { state: 'cancelled' }); throw error; }
      } else {
        if (!this.scope.assignments.some(a => a.workerId === args.taskId) || !['continue_history', 'new_worker'].includes(args.decision)) throw new Error('unknown task or unavailable plan decision');
        this.store.historyDecision(this.runId, args.taskId, args.decision); result = { state: 'decision_recorded', decision: args.decision, evidenceRefs: args.evidenceRefs };
      }
    } else if (name === 'reconcile_plan' || name === 'write_progress') {
      if (!this.plan) throw new Error('plan is not enabled');
      try {
        if (name === 'reconcile_plan') this.plan.reconcile(args.expectedFileHash, args.expectedPlanHash);
        else await this.plan.project(args.expectedFileHash);
        result = { state: name === 'reconcile_plan' ? 'plan_reconciled' : 'progress_written' };
      } catch (error) { this.store.operationResult(args.operationId, 'cancelled', { state: 'cancelled' }); throw error; }
    } else if (name === 'stop_worker') {
      const target = registrations.find(({ reg }) => JSON.stringify(reg.worker) === JSON.stringify(args.target));
      if (!target) throw new Error('stale worker binding'); result = await this.broker.closeTerminal(this.runId, target.reg.binding);
    } else if (name === 'stop_run') result = await this.broker.stopRun(this.runId);
    else if (name === 'resume_run') { await this.broker.resumeRun(this.runId); result = this.store.run(this.runId); }
    this.store.operationResult(args.operationId, 'settled', result ?? null); return result;
  }
}
export function createMcpServer(invoke: (name: string, args: unknown, metadata: unknown) => Promise<any>, humanResponse?: (ref: HumanRequest, action: HumanAction, metadata: unknown) => Promise<unknown>): McpServer {
  const server = new McpServer({ name: 'meristem-chat-control', version: '0.0.0' });
  for (const [name, schema] of Object.entries(schemas)) server.registerTool(name, {
    description: name === 'record_decision' ? 'Record parent decisions. Plan mode separates candidate acceptance from checked integration acceptance; only integration releases dependencies.' : `Fixture-scoped ${name}; caller identity comes from native ownership and Codex metadata.`,
    inputSchema: schema,
    annotations: { readOnlyHint: name === 'get_status', openWorldHint: false }
  }, async (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<CallToolResult> => {
    try {
      let value = await invoke(name, args, extra._meta);
      if (value?.humanForm) {
        const { humanForm, ...status } = value; value = status;
        if (humanResponse && server.server.getClientCapabilities()?.elicitation?.form) {
          try {
            const message = `担当 ${humanForm.worker.workerId} の承認要求\n\n${humanForm.detail}\n\n作業場所: ${humanForm.cwd}\n\n照合情報（通常は確認不要）\nThread: ${humanForm.worker.threadId}\nAttempt: ${humanForm.worker.attemptId}\nTurn: ${humanForm.turnId}\nRequest: ${humanForm.requestId}\nSHA-256: ${humanForm.payloadHash}\nForm: ${humanForm.formGeneration}`.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
            const response = await server.server.elicitInput({ mode: 'form', message, requestedSchema: { type: 'object', properties: {} } }, { timeout: 120000, signal: extra.signal, relatedRequestId: extra.requestId });
            if (!extra.signal.aborted) value = await humanResponse(humanForm, response.action, extra._meta);
          } catch { /* Timeout, disconnect and unsupported clients leave the original request pending. */ }
        }
      }
      const result = Array.isArray(value) ? { results: value } : value;
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof RevisionConflict ? JSON.stringify({ error: 'stale_revision', delivery: 'not_applied' }) : 'Request rejected; verify caller, scope, revision and recorded delivery before retrying.' }] }; }
  });
  return server;
}
export async function serveMcp(pipeName: string): Promise<void> {
  const server = createMcpServer(async (name, args, metadata) => {
    const result = await pipeRequest(pipeName, { method: 'mcp', name, args, metadata }, name === 'create_worker' ? 125000 : 25000);
    if (!result.ok) { if (result.error === 'stale_revision') throw new RevisionConflict(); throw new Error('control rejected'); } return result.value;
  }, async (ref, action, metadata) => {
    const result = await pipeRequest(pipeName, { method: 'mcp_human_response', metadata, args: { worker: ref.worker, key: ref.key, payloadHash: ref.payloadHash, formGeneration: ref.formGeneration, action } });
    if (!result.ok) throw new Error('human response rejected'); return result.value;
  });
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--pipe') throw new Error('explicit control pipe required');
  await serveMcp(process.argv[3]);
}
