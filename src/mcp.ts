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
import { Id, ModelAssessment, ModelId, Operation, Worker, sameWorker, type Registration, type WorkerRef } from './contracts.js';
import { Broker, PlanControl, type Runtime } from './broker.js';
import { TaskReport, Sha, Checks } from './git-evidence.js';
import { Store } from './store.js';
import { pipeRequest, RpcTransportFailure } from './protocol.js';
import { RequestFailure, RevisionConflict } from './failures.js';
import type { HumanRequest, HumanAction } from './requests.js';
import { elicitDecision } from './requests.js';
import { PlanChange } from './plan.js';
import { DecisionService, DecisionAnswer } from './decisions.js';
import { Decision, HumanDecisionRef } from './contracts.js';
import { resolveTaskPermissions, type RunPermissionPermit } from './permissions.js';
import type { AppliedTaskSettings } from './contracts.js';
import { HistorySelection, readSavedWorkerHistory, type HistoryReader, type HistorySource } from './workers.js';

export type FixtureAssignment = { workerId: string; cwd: string; repositoryId: string; branch: string; model: string; effort: string; permissionProfileId?: string; permissionPermit?: RunPermissionPermit; gitApprovalRoots?: string[] };
export type FixtureScope = { fixture: true; parentSessionKind?: 'vscode' | 'cli'; plan?: true; planPath: string; repositoryId: string; repositoryPath: string; branchScope: string[]; windowBindingId: string; maxInstructions?: number; permissionPermit?: RunPermissionPermit; modelRoutingSummary?: import('./routing-summary.js').RoutingSummaryReference; assignments: FixtureAssignment[] };
export interface ManagedRuntime extends Runtime, Partial<HistoryReader> {
  waitForInput?(worker: WorkerRef, text: string, turnId: string): void;
  presentRequest?(worker: WorkerRef, key: string): HumanRequest;
  answerRequest?(worker: WorkerRef, ref: HumanRequest, action: HumanAction, isCurrent: () => boolean): Promise<void>;
  pendingRequests?(): HumanRequest[];
  answerQuestion?(worker: WorkerRef, key: string, answers: Record<string, { answers: string[] }>, isCurrent: () => boolean): Promise<void>;
  start(assignment: import('./workers.js').Assignment & { identity: Omit<WorkerRef, 'threadId'> }): Promise<WorkerRef>;
  settings?(worker: WorkerRef): AppliedTaskSettings;
  registration(worker: WorkerRef): Pick<Registration, 'hostPid' | 'hostCreated' | 'childPid' | 'childCreated' | 'jobId' | 'modelProvider'>;
}
export const HistoryResume = Operation.extend({ target: Worker }).strict();
const schemas = {
  propose_decision: Operation.extend({ proposal: z.object({ taskIds: Decision.shape.taskIds, blockingTaskIds: Decision.shape.blockingTaskIds, kind: Decision.shape.kind, recipient: Decision.shape.recipient, planHash: Decision.shape.planHash, question: Decision.shape.question, options: Decision.shape.options, allowFreeText: Decision.shape.allowFreeText, requestedMaximum: Decision.shape.requestedMaximum }).strict() }).strict(),
  answer_consultation: Operation.extend({ decisionId: Id, answer: DecisionAnswer.optional(), close: z.enum(['cancelled', 'superseded']).optional() }).strict().refine(value => !(value.answer && value.close), 'answer and close are exclusive'),
  get_decisions: z.object({ runId: Id, afterId: Id.optional(), limit: z.number().int().min(1).max(4).default(4), pendingOnly: z.boolean().optional() }).strict(),
  hold_task: Operation.extend({ taskId: Id, decisionId: Id, replacesDecisionId: Id.optional() }).strict(),
  resume_task: Operation.extend({ taskId: Id, resolvedDecisionId: Id }).strict(),
  get_worker_history: HistorySelection.extend({ runId: Id }).strict(),
  resume_worker_history: HistoryResume,
  answer_request: Operation.extend({ requestKey: z.string().min(1).max(512), answer: z.record(z.string(), z.object({ answers: z.array(z.string().max(8192)).min(1).max(10) }).strict()).optional() }).strict(),
  start_run: z.object({ planPath: z.string().min(1).max(4096).optional(), operationId: Id }).strict(),
  save_worker_changes: Operation.extend({taskId:Id, target:Worker, expectedHead:Sha, message:z.string().trim().min(1).max(2048)}).strict(),
  create_worker: Operation.extend({ taskId: Id }).strict(),
  send_instruction: Operation.extend({ taskId: Id, target: Worker, agent: z.object({ model: ModelId, effort: Id }).strict(), text: z.string().min(1).max(65536) }).strict(),
  get_status: z.object({ runId: Id, taskId: Id.optional(), afterEventSeq: z.number().int().nonnegative().optional(), attemptOffset: z.number().int().nonnegative().optional(), reportOffset: z.number().int().nonnegative().optional(), requestOffset: z.number().int().nonnegative().optional() }).strict(),
  report: Operation.extend({ taskId: Id, report: z.union([TaskReport, z.object({ summary: z.string().min(1).max(8192), question: z.string().trim().min(1).max(8192).optional(), evidenceRefs: z.array(z.string().max(512)).max(32).optional() }).strict()]) }).strict(),
  record_decision: Operation.extend({ taskId: Id, decision: z.enum(['continue_history', 'new_worker', 'retry_same', 'continue_same', 'handoff_new', 'accept_candidate', 'prepare_integration', 'record_integration_checks', 'cancel_integration', 'accept_integration', 'accept_review', 'pause', 'finish']), evidenceRefs: z.array(Id).max(32), sourceTaskId: Id.optional(), candidateSha: Sha.optional(), integrationSha: Sha.optional(), inputCandidateShas: z.array(Sha).min(1).max(128).optional(), checks: Checks.optional(), modelAssessment: ModelAssessment.optional() }).strict(),
  reconcile_plan: Operation.extend({ expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/), expectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  propose_plan_change: Operation.extend(PlanChange.shape).strict(),
  apply_plan_change: Operation.extend({ decisionId: Id, expectedPlanHash: Decision.shape.planHash, proposedPlanHash: Decision.shape.planHash }).strict(),
  write_progress: Operation.extend({ expectedFileHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  stop_worker: Operation.extend({ target: Worker }).strict(),
  retire_worker: Operation.extend({ target: Worker }).strict(),
  stop_run: Operation,
  resume_run: Operation
};
export type ToolName = keyof typeof schemas;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class McpController {
  private plan?: PlanControl;
  constructor(private store: Store, private broker: Broker, private runtime: ManagedRuntime, private runId: string, private parent: ActorRef, private scope: FixtureScope, private routingHistory?: import('./routing-summary.js').RoutingHistory, private parentSessionId?: string) {
    if (scope.modelRoutingSummary?.sha256 !== routingHistory?.reference.sha256 || scope.modelRoutingSummary?.path !== routingHistory?.reference.path ||
      (routingHistory && !scope.plan)) throw new Error('routing summary scope mismatch');
    if (scope.plan) this.plan = new PlanControl(store, runId, () => broker.canWake(runId), () => broker.executionLimits(runId).maxCorrectionsPerTask, routingHistory);
  }
  // Only the pinned parent's MCP process can enter this non-tool endpoint.
  async humanResponse(input: unknown, identity: CallerIdentity): Promise<unknown> {
    if (input && typeof input === 'object' && Object.hasOwn(input, 'decision')) {
      const args = z.object({ decision: HumanDecisionRef, answer: DecisionAnswer }).strict().parse(input);
      if (!sameActor(identity.actor, this.parent)) throw new Error('human response binding rejected');
      return this.resolveControlDecision(args.decision, args.answer);
    }
    const args = z.object({ worker: Worker, key: z.string().max(512), payloadHash: z.string().regex(/^[a-f0-9]{64}$/), formGeneration: Id, action: z.enum(['accept', 'decline', 'cancel']) }).strict().parse(input);
    const item = this.runtime.pendingRequests?.().find(r => r.key === args.key);
    const current = () => !!item && this.broker.canReviewRequest(this.runId, item) && this.store.binding(this.runId)?.state === 'consumed' && this.store.binding(this.runId)?.scope_hash === this.scopeHash();
    if (!sameActor(identity.actor, this.parent) || !current() || !this.runtime.answerRequest) throw new Error('human response binding rejected');
    if (!item || !sameWorker(item.worker, args.worker)) throw new Error('stale request');
    this.store.auditHumanRequest(this.runId, { ...item, payloadHash: args.payloadHash, formGeneration: args.formGeneration }, 'response_received', 'parent_mcp', args.action);
    await this.runtime.answerRequest(args.worker, { ...item, payloadHash: args.payloadHash, formGeneration: args.formGeneration }, args.action, current);
    return { state: 'response_sent' };
  }
  assertControlScope() {
    const binding = this.store.binding(this.runId);
    if (!this.broker.canWake(this.runId) || binding?.state !== 'consumed' || binding.scope_hash !== this.scopeHash()) throw new Error('human response binding rejected');
    this.plan?.assertCurrent();
  }
  presentControlDecision(decisionId: string) {
    this.assertControlScope();
    const ref = { runId: this.runId, operationId: randomUUID(), expectedRevision: this.store.run(this.runId).revision };
    const service = new DecisionService(this.store, () => this.assertControlScope(), () => undefined);
    const form = service.present(ref, decisionId);
    return { form, decision: this.store.coordinationDecision(this.runId, decisionId)!.decision };
  }
  // Both callers verify the human input channel before entering this non-tool endpoint.
  resolveControlDecision(input: unknown, answer: unknown) {
    this.assertControlScope();
    const form = HumanDecisionRef.parse(input), context = {};
    let expectedRevision = this.store.run(this.runId).revision;
    try { expectedRevision = this.store.operation(form.formGeneration).expected_revision; } catch { /* first response */ }
    const service = new DecisionService(this.store, () => { throw new Error('coordinator endpoint required'); }, verified => verified === context ? { runId: this.runId, operationId: form.formGeneration, expectedRevision } : undefined);
    const result = service.resolveHuman(form, DecisionAnswer.parse(answer), context);
    return { state: result.state, decisionId: result.id };
  }
  private scopeHash(): string {
    return this.diagnoseScope().scopeHash;
  }
  private diagnoseScope() {
    const digest = <T extends {windowBindingId: string}>(scope: T) => {
      if (!this.parentSessionId) return { scopeHash: hash(scope), targetHash: undefined };
      const { windowBindingId, ...target } = scope;
      const targetHash = hash({ runId: this.runId, threadId: this.parent.threadId, target });
      return { targetHash, scopeHash: hash({ targetHash, parent: this.parent, windowBindingId, sessionId: this.parentSessionId }) };
    };
    if (Buffer.byteLength(JSON.stringify(this.scope)) > 60000) throw new Error('scope exceeds frame budget');
    if (this.plan) {
      if (this.scope.fixture !== true || this.scope.assignments.length) throw new Error('plan scope cannot contain fixture assignments');
      this.plan.open(this.scope.planPath, this.scope.repositoryPath, this.scope.branchScope);
      this.plan.git().assertRepository();
      const stored = this.store.plan(this.runId)!;
      if (this.routingHistory && this.routingHistory.repositoryKey !== createHash('sha256').update(stored.pin.commonDir.toLowerCase()).digest('hex')) throw new Error('routing summary repository pin changed');
      const routing = this.modelRoutingPermit();
      const usagePolicy = this.store.usageRecord(this.runId)?.policy;
      return digest({ ...this.scope, ...(usagePolicy && {usagePolicy, scopedGitSave:true}), planPath: realpathSync(this.scope.planPath), planHash: stored.bindingHash, pin: stored.pin, ...(routing ? { modelRouting: routing } : {}) });
    }
    if (this.scope.fixture !== true || !path.isAbsolute(this.scope.planPath) || !this.scope.assignments.length || this.scope.assignments.length > 128 || new Set(this.scope.assignments.map(a => a.workerId)).size !== this.scope.assignments.length) throw new Error('explicit fixture scope required');
    const git = (cwd: string, args: string[]) => {
      const result = spawnSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
      if (result.status !== 0) throw new Error('Git scope unavailable'); return result.stdout.trim();
    };
    const common = realpathSync(git(this.scope.repositoryPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toLowerCase();
    for (const a of this.scope.assignments) {
      if (Buffer.byteLength(a.cwd) > 4096 || Buffer.byteLength(a.branch) > 512) throw new Error('fixture path exceeds supported scope');
      if (a.repositoryId !== this.scope.repositoryId || !this.scope.branchScope.includes(a.branch) || ['main', 'master'].includes(a.branch) || realpathSync(git(a.cwd, ['rev-parse', '--show-toplevel'])).toLowerCase() !== realpathSync(a.cwd).toLowerCase() || realpathSync(git(a.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toLowerCase() !== common || git(a.cwd, ['symbolic-ref', '--short', 'HEAD']) !== a.branch) throw new Error('assignment outside Git scope');
    }
    return digest({ ...this.scope, ...(this.parentSessionId ? { commonDir: common } : {}), planPath: realpathSync(this.scope.planPath), planHash: createHash('sha256').update(readFileSync(this.scope.planPath)).digest('hex'), assignments: this.scope.assignments.map(a => ({ ...a, cwd: realpathSync(a.cwd) })) });
  }
  private modelRoutingPermit() {
    if (!this.plan) return undefined;
    const stored = this.store.plan(this.runId)!;
    const snapshot = stored.bindingHash === stored.snapshot.planHash ? stored.snapshot : this.store.planRevision(this.runId, stored.bindingHash);
    const plan = snapshot?.plan;
    if (plan?.schema_version !== 2 || !plan.run.worker_model_policy) return undefined;
    const policy = plan.run.worker_model_policy;
    const maxCorrections = this.broker.executionLimits(this.runId).maxCorrectionsPerTask;
    return { ...policy, planHash: stored.bindingHash, maxAutomaticChangesPerTask: Math.min(policy.candidates.length - 1, maxCorrections ?? Infinity),
      ...(this.routingHistory ? { summarySha256: this.routingHistory.reference.sha256 } : {}),
      tasks: plan.tasks.filter(task => task.model_routing).map(({ id: taskId, agent: { model, effort } }) => ({ taskId, agent: { model, effort } })) };
  }
  checkUsageWaiting() { this.plan?.checkUsageWaiting(); }
  startPreview() {
    const { scopeHash, targetHash } = this.diagnoseScope();
    if (this.parentSessionId) this.plan?.assertCurrent();
    const routing = this.modelRoutingPermit();
    const stored = this.plan && this.store.plan(this.runId)!;
    const policy = this.store.usageRecord(this.runId)?.policy;
    const planScope = (this.parentSessionId || policy) && stored ? { planVersion: stored.snapshot.plan.schema_version,
      integrationBranch: stored.pin.integrationBranch, gitDestination: stored.pin.pushUrl,
      worktreesRoot: stored.pin.root, ...(policy && {usagePolicy:policy, scopedGitSave:true}), requestedMaximum: stored.snapshot.plan.run.max_parallel,
      approvedMaximum: Math.min(stored.snapshot.plan.run.max_parallel, this.store.effectiveParallelLimit(this.runId)) } : undefined;
    const scope = { ...this.scope, ...(targetHash ? { targetHash } : {}), ...(planScope ? { planScope } : {}), planHash: this.plan ? this.store.plan(this.runId)!.bindingHash : createHash('sha256').update(readFileSync(this.scope.planPath)).digest('hex'),
      ...(routing ? { modelRouting: routing } : {}) };
    return { runId: this.runId, parent: this.parent, scope, scopeHash };
  }

  // This entry is reached through the authenticated control lease, outside the MCP tool dispatcher.
  startFromControl(operationId: string, displayedScopeHash: string) {
    const preview = this.startPreview();
    if (!this.parentSessionId || !this.broker.canWake(this.runId) || preview.scopeHash !== displayedScopeHash) throw new Error('start scope changed or run stopped');
    return this.store.transaction(() => {
      let binding = this.store.binding(this.runId);
      if (!binding) {
        this.store.requestBinding(randomUUID(), this.runId, operationId, this.parent, preview.scopeHash, preview.scope);
        binding = this.store.binding(this.runId);
      }
      if (binding.scope_hash !== preview.scopeHash || !sameActor(JSON.parse(binding.parent), this.parent)) throw new Error('start binding changed');
      if (binding.state !== 'consumed') this.store.commitHumanStart(binding.id, 'control_input');
      return { runId: this.runId, bindingId: binding.id, state: this.store.run(this.runId).state };
    });
  }

  async resumeFromControl(operationId: string, scopeHash: string) {
    const preview = this.startPreview();
    const saved = this.store.binding(this.runId);
    if (!this.parentSessionId || !saved || !preview.scope.targetHash || preview.scopeHash !== scopeHash ||
      JSON.parse(saved.scope).targetHash !== preview.scope.targetHash || JSON.parse(saved.parent).threadId !== this.parent.threadId) throw new Error('saved start scope changed');
    const state = this.store.run(this.runId).state;
    if (state === 'active') return this.startFromControl(operationId, scopeHash);
    if (state !== 'needs_reconcile' && state !== 'stopped') throw new Error('run cannot resume');
    if (saved.scope_hash !== scopeHash || saved.state !== 'consumed') {
      this.store.replaceBinding(randomUUID(), this.runId, operationId, this.parent, scopeHash, preview.scope, true);
    }
    await this.broker.resumeRun(this.runId);
    return { runId: this.runId, bindingId: this.store.binding(this.runId).id, state: this.store.run(this.runId).state };
  }

  authorize(bindingId: string, displayedScopeHash?: string): void {
    const binding = this.store.binding(this.runId);
    if (!binding || binding.id !== bindingId || binding.scope_hash !== this.scopeHash() || !sameActor(JSON.parse(binding.parent), this.parent)) throw new Error('binding scope mismatch');
    if (this.modelRoutingPermit() || this.parentSessionId) {
      if (displayedScopeHash !== binding.scope_hash) throw new Error('model routing approval scope mismatch');
      this.plan?.assertCurrent();
    }
    if (this.parentSessionId) {
      if (!this.broker.canWake(this.runId) && this.store.run(this.runId).state !== 'needs_reconcile') throw new Error('run stopped');
      if (binding.state !== 'consumed') this.store.commitHumanStart(binding.id, 'permit_confirmation');
    } else this.store.confirmBinding(bindingId);
  }
  async prepareHistoryResume(input: z.infer<typeof HistoryResume>, isCurrent = () => true) {
    const { target, ...ref } = HistoryResume.parse(input);
    const plan = this.plan;
    if (!plan || ref.runId !== this.runId) throw new Error('history resume requires a bound plan');
    const assertPermit = () => {
      const binding = this.store.binding(this.runId);
      if (!isCurrent() || !binding || binding.state !== 'consumed' || !sameActor(JSON.parse(binding.parent), this.parent) ||
          binding.scope_hash !== this.scopeHash() || !this.broker.canWake(this.runId)) throw new Error('active and authorized run required');
      return binding.id as string;
    };
    const bindingId = assertPermit();
    const prepared = this.store.prepareOperation(ref, hash({ kind: 'history_resume', target, bindingId }));
    if (!prepared.fresh) return prepared.operation.result ? JSON.parse(prepared.operation.result) : { state: prepared.operation.state };
    try {
      const before = plan.historyCheckpoint(target);
      let reason: string | undefined;
      if (before.modelProvider === undefined) reason = 'history_provider_unrecorded';
      else {
        const read = await readSavedWorkerHistory(this.store, this.runtime, this.runId, target);
        if (read.state === 'history_unavailable') reason = read.reason;
        else {
          const latest = read.history.turns[0];
          if (latest?.status === 'inProgress' || (before.completedTurnId && (latest?.id !== before.completedTurnId || latest.status !== 'completed'))) reason = 'history_execution_mismatch';
        }
      }
      if (assertPermit() !== bindingId) throw new RevisionConflict();
      const run = this.store.run(this.runId);
      if (run.revision !== ref.expectedRevision + 1) throw new RevisionConflict();
      const after = plan.historyCheckpoint(target);
      if (after.assignment.baseSha !== before.assignment.baseSha || after.completedTurnId !== before.completedTurnId) throw new Error('history checkpoint changed during verification');
      const result = reason
        ? { state: 'history_unavailable', reason, handoff: after.state.hold ? 'create_worker_after_resume_task' : 'record_decision:handoff_new' }
        : { state: 'history_handoff_ready', taskId: after.taskId, sourceThreadId: target.threadId, head: after.assignment.baseSha };
      this.store.transaction(() => {
        if (result.state === 'history_handoff_ready') {
          this.store.savePlanState(this.runId, after.taskId, { ...after.state, state: 'pending', dispatch: { mode: 'history', target, head: after.assignment.baseSha, stopGeneration: run.stop_generation } });
        } else if (after.state.dispatch?.mode === 'history') {
          const { dispatch: _invalid, ...state } = after.state;
          this.store.savePlanState(this.runId, after.taskId, { ...state, ...(state.hold ? { dispatch: { mode: 'new' } } : {}) });
        }
        this.store.operationResult(ref.operationId, 'settled', result);
      });
      return result;
    } catch (error) {
      this.store.operationResult(ref.operationId, 'cancelled', { state: 'not_applied' });
      throw error;
    }
  }
  async call(name: string, input: unknown, identity: CallerIdentity): Promise<any> {
    if (!Object.hasOwn(schemas, name)) throw new Error('unsupported tool');
    const args = schemas[name as ToolName].parse(input) as any;
    Actor.parse(identity.actor); Id.parse(identity.turnId);
    if (name === 'start_run') {
      if (!sameActor(identity.actor, this.parent)) throw new Error('only verified parent can request binding');
      const planPath = args.planPath ?? (this.parentSessionId && this.scope.parentSessionKind === 'cli' ? this.scope.planPath : undefined);
      if (!planPath || realpathSync(planPath) !== realpathSync(this.scope.planPath)) throw new Error('plan outside fixture scope');
      const { scopeHash, scope: scopeRecord } = this.startPreview();
      let binding = this.store.binding(this.runId);
      const routing = scopeRecord.modelRouting;
      const modelRouting = routing ? { ...routing, scopeHash } : undefined;
      if (routing && binding?.state !== 'consumed') this.plan!.assertCurrent();
      if (binding && (binding.scope_hash !== scopeHash || !sameActor(JSON.parse(binding.parent), identity.actor))) {
        const { windowBindingId: _oldWindow, startSource: _previousStart, planScope: _oldDisplay, ...oldScope } = JSON.parse(binding.scope);
        const { windowBindingId: _newWindow, planScope: _newDisplay, ...newScope } = scopeRecord;
        if (this.parentSessionId && JSON.parse(binding.parent).threadId !== identity.actor.threadId) throw new Error('another conversation owns this run');
        if (hash(oldScope) !== hash(newScope)) throw new Error('rebind scope changed');
        this.store.replaceBinding(randomUUID(), this.runId, args.operationId, this.parent, scopeHash, scopeRecord);
        binding = this.store.binding(this.runId);
      }
      if (!binding) {
        if (this.parentSessionId && !this.broker.canWake(this.runId)) throw new Error('run stopped before start');
        this.store.requestBinding(randomUUID(), this.runId, args.operationId, this.parent, scopeHash, scopeRecord);
        binding = this.store.binding(this.runId);
      }
      if ((!this.parentSessionId && binding.operation_id !== args.operationId) || binding.scope_hash !== scopeHash || !sameActor(JSON.parse(binding.parent), identity.actor)) throw new Error('binding scope or operation mismatch');
      if (binding.state === 'confirmed') this.store.consumeBinding(binding.id);
      return { runId: this.runId, bindingId: binding.id, state: binding.state === 'pending' ? 'awaiting_authorization' : this.store.run(this.runId).state,
        ...(modelRouting ? { modelRouting } : {}) };
    }
    if (args.runId !== this.runId) throw new Error('run binding mismatch');
    const binding = this.store.binding(this.runId);
    if (!binding || binding.state !== 'consumed') throw new Error('human permit required');
    if (!sameActor(JSON.parse(binding.parent), this.parent)) throw new Error('run parent changed');
    if (name === 'get_worker_history') {
      if (!sameActor(identity.actor, this.parent)) throw new Error('history requires verified parent');
      return readSavedWorkerHistory(this.store, this.runtime, this.runId, args.target, args.cursor);
    }
    let scopeValid = false;
    try { scopeValid = binding.scope_hash === this.scopeHash(); } catch { /* allow observation and safety stops when Git scope drifts */ }
    const closesDecision = name === 'answer_consultation' && args.close !== undefined;
    if (!scopeValid && !closesDecision && !['get_status', 'get_decisions', 'report', 'stop_run', 'stop_worker', 'retire_worker'].includes(name)) throw new Error('run scope changed');
    if (this.plan && !closesDecision && !(name === 'record_decision' && args.decision === 'pause') && !['get_status', 'get_decisions', 'report', 'stop_run', 'stop_worker', 'retire_worker', 'apply_plan_change', 'reconcile_plan', 'write_progress'].includes(name)) this.plan.assertCurrent();
    const registrations = this.store.attempts(this.runId).map(row => ({ row, reg: JSON.parse(row.registration) as Registration }));
    const context = resolveCallContext(identity, { runId: this.runId, parent: this.parent, workers: registrations.filter(({ row }) => !['completed', 'stopped', 'unknown'].includes(row.state)).map(({ reg }) => reg.worker) });
    if (context.role === 'worker' && !['get_status', 'get_decisions', 'propose_decision', 'report'].includes(name)) throw new Error('worker cannot control or accept results');
    const own = registrations.find(({ reg }) => sameActor(reg.worker, identity.actor));
    if (context.role === 'worker' && args.taskId && args.taskId !== own?.reg.taskId) throw new Error('worker cannot access peer');
    if (name === 'resume_worker_history') return this.prepareHistoryResume(args);
    if (name === 'get_decisions') {
      const rows = this.store.coordinationDecisions(this.runId, args.afterId ?? '', args.limit + 1, args.pendingOnly);
      const decisions: { decision: Decision; answer: DecisionAnswer | null }[] = [];
      let bytes = 0, lastId = args.afterId, scanned = 0;
      for (const decision of rows.slice(0, args.limit)) {
        const visible = context.role === 'parent' || decision.taskIds.length > 0 && decision.taskIds.every(id => id === own?.reg.taskId);
        const item = visible ? { decision, answer: this.store.coordinationDecision(this.runId, decision.id)!.answer } : undefined;
        const size = item ? Buffer.byteLength(JSON.stringify(item)) : 0;
        if (decisions.length && bytes + size > 80000) break;
        if (item) { decisions.push(item); bytes += size; }
        lastId = decision.id; scanned++;
      }
      return { decisions, nextAfterId: rows.length > scanned ? lastId : null };
    }
    if (name === 'apply_plan_change') {
      if (!this.plan) throw new Error('plan is not enabled');
      return this.plan.applyChange(Operation.parse({ runId: args.runId, operationId: args.operationId, expectedRevision: args.expectedRevision }), args.decisionId, args.expectedPlanHash, args.proposedPlanHash);
    }
    if (name === 'propose_decision' || name === 'answer_consultation' || name === 'propose_plan_change') {
      if (!this.broker.canWake(this.runId)) throw new Error('run is stopped');
      const service = new DecisionService(this.store, (_ref, taskIds, coordinatorOnly) => {
        if (context.role === 'worker' && (coordinatorOnly || !taskIds.length || taskIds.some(id => id !== own?.reg.taskId))) throw new Error('decision scope rejected');
      }, () => undefined);
      const ref = Operation.parse({ runId: args.runId, operationId: args.operationId, expectedRevision: args.expectedRevision });
      if (name === 'propose_plan_change') {
        if (!this.plan) throw new Error('plan is not enabled');
        const { expectedPlanHash, tasks, reason, alternatives, recommendation } = args;
        const input: PlanChange = { expectedPlanHash, tasks, reason, alternatives, recommendation };
        const { draft, affected, differences } = this.plan.proposeChange(input, this.scope.permissionPermit);
        return service.propose(ref, {
          kind: 'plan_change', recipient: 'human', taskIds: affected, blockingTaskIds: affected,
          planHash: input.expectedPlanHash, proposedPlanHash: draft.planHash,
          question: [
            '工程表の変更を確認してください。',
            `対象: ${affected.join(', ')}`,
            ...differences,
            'リポジトリ、作業範囲、実行上限、統合済みの実績を維持します。',
            `理由: ${input.reason}`,
            ...input.alternatives.map(text => `代替案: ${text}`),
            `推奨案: ${input.recommendation}`
          ].join('\n'),
          options: [{ id: 'approve', label: 'この差分を承認', description: '表示された変更を対象の工程表に適用できます。' }, { id: 'decline', label: '見送る', description: '工程表を現行版のままにします。' }],
          allowFreeText: true
        }, draft);
      }
      if (name === 'propose_decision') return service.propose(ref, args.proposal);
      if (args.close) return service.close(ref, args.decisionId, args.close);
      if (args.answer) return service.resolveCoordinator(ref, args.decisionId, args.answer);
      const status = { state: 'waiting_decision', decisionId: args.decisionId };
      // Retried presentation operations never display or replay an old form.
      try { this.store.operation(args.operationId); service.present(ref, args.decisionId); return status; }
      catch (error) { if (!(error instanceof Error && error.message === 'unknown operation')) throw error; }
      const form = service.present(ref, args.decisionId);
      return { ...status, humanDecisionForm: { form, decision: this.store.coordinationDecision(this.runId, args.decisionId)!.decision } };
    }
    if (name === 'hold_task' || name === 'resume_task') {
      if (!this.plan) throw new Error('plan is not enabled');
      const ref = Operation.parse({ runId: args.runId, operationId: args.operationId, expectedRevision: args.expectedRevision });
      if (name === 'resume_task') return this.plan.resumeTask(ref, args.taskId, args.resolvedDecisionId);
      const hold = this.plan.holdTask(ref, args.taskId, args.decisionId, args.replacesDecisionId);
      const held = this.store.planStates(this.runId)[args.taskId];
      // A retry after resume reads its recorded result; it must never hold the
      // new attempt. While parking is in flight, Broker shares the same stop.
      if (held?.state === 'held' && held.hold?.decisionIds.includes(args.decisionId)) {
        let releasedExecutionSlot = held.hold.releasedExecutionSlot;
        if (!held.hold.releasedExecutionSlot && held.attemptId) {
          const target = registrations.find(({ row }) => row.id === held.attemptId);
          if (!target) throw new Error('held attempt registration unavailable');
          releasedExecutionSlot = (await this.broker.parkTask(this.runId, target.reg.worker)).state === 'stopped';
        }
        const result = { ...hold, releasedExecutionSlot };
        this.store.operationResult(ref.operationId, 'settled', result);
        return { state: 'held', ...result };
      }
      return { state: 'held', ...hold };
    }
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
      const visibleRequests = this.runtime.pendingRequests?.().filter(r => context.role === 'parent' || r.worker.attemptId === own?.reg.worker.attemptId) ?? [];
      const requestOffset = args.requestOffset ?? 0, requests: HumanRequest[] = []; let requestBytes = 0;
      for (const request of visibleRequests.slice(requestOffset)) {
        const bytes = Buffer.byteLength(JSON.stringify(request)); if (requests.length && requestBytes + bytes > 40000) break;
        if (bytes > 80000) throw new Error('request exceeds status byte budget');
        requests.push(request); requestBytes += bytes;
      }
      const result = { capacity:this.store.capacity(this.runId), ...(this.plan && context.role === 'parent' ? { plan: await this.plan.status() } : {}), requests, nextRequestOffset: visibleRequests.length > requestOffset + requests.length ? requestOffset + requests.length : null, run: this.store.run(this.runId), scopeValid, attempts: selected.slice(offset, offset + 4).map(({ row, reg }) => ({ state: row.state, worker: reg.worker, taskId: reg.taskId, cwd: reg.cwd, branch: reg.branch, agent: { model: reg.model, effort: reg.effort }, ...(reg.settings ? { settings: reg.settings } : {}), ...(this.plan ? { git: this.store.gitAssignment(reg.worker.attemptId) } : {}), stopResult: row.stop_result ? JSON.parse(row.stop_result) : null })), nextAttemptOffset: selected.length > offset + 4 ? offset + 4 : null, reports, nextReportOffset: this.store.reportCount(this.runId, context.role === 'worker' ? own!.reg.worker.attemptId : undefined) > reportOffset + reports.length ? reportOffset + reports.length : null, events };
      // The broker's stdout response cap is 200,000 bytes, inside the native
      // transport cap. Bound the combined sections, not only each array.
      const sections = args.reportOffset !== undefined ? [requests, result.attempts, reports]
        : args.requestOffset !== undefined ? [reports, result.attempts, requests] : [reports, requests, result.attempts];
      const modelRouting = context.role === 'parent' && args.taskId ? this.plan?.modelRoutingStatus(args.taskId) : undefined;
      if (modelRouting) {
        Object.assign(result, { modelRouting });
        sections.unshift(modelRouting.outcomes, modelRouting.summary);
      }
      while (Buffer.byteLength(JSON.stringify(result)) > 179000) {
        const section = sections.find(section => section.length);
        if (!section) throw new Error('status metadata exceeds frame budget');
        section.pop();
      }
      result.nextAttemptOffset = selected.length > offset + result.attempts.length ? offset + result.attempts.length : null;
      result.nextReportOffset = this.store.reportCount(this.runId, context.role === 'worker' ? own!.reg.worker.attemptId : undefined) > reportOffset + reports.length ? reportOffset + reports.length : null;
      result.nextRequestOffset = visibleRequests.length > requestOffset + requests.length ? requestOffset + requests.length : null;
      return result;
    }
    if (name === 'report' && context.role !== 'worker') throw new Error('only main worker can report');
    if (name === 'report' && Buffer.byteLength(JSON.stringify(args.report)) > 60000) throw new Error('report exceeds byte limit');
    if (name === 'report' && this.plan) this.plan.validateReport(args.taskId, own!.reg.worker, args.report);
    if (name === 'record_decision' && args.modelAssessment && (!this.plan || !['retry_same', 'handoff_new'].includes(args.decision))) {
      throw new Error('model assessment requires a plan retry or handoff');
    }
    const ref = Operation.parse({ operationId: args.operationId, runId: args.runId, expectedRevision: args.expectedRevision });
    if (name === 'send_instruction') {
      const target = registrations.find(({ reg }) => reg.worker.attemptId === args.target.attemptId);
      if (!target || target.reg.taskId !== args.taskId) throw new Error('task target mismatch');
      if (this.plan) {
        const plan = this.store.plan(this.runId)!.snapshot.plan;
        const task = plan.tasks.find(t => t.id === args.taskId);
        const expected = target.reg.modelRouting?.modelSwitch?.agent ?? target.reg.modelRouting?.initialRecommendation?.selected ?? task?.agent;
        if (!task || !expected || expected.model !== args.agent.model || expected.effort !== args.agent.effort || ['completed', 'stopped', 'unknown'].includes(target.row.state)) {
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
    if (!['stop_run', 'stop_worker', 'retire_worker', 'resume_run', 'report'].includes(name) && !this.broker.canWake(this.runId) && !(humanRequest && this.broker.canReviewRequest(this.runId, humanRequest))) {
      this.store.operationResult(args.operationId, 'cancelled', { state: 'cancelled' }); throw new Error('run is stopped');
    }
    let result: any;
    if (name === 'save_worker_changes') {
      // A Coordinator can save only the current, live, writable assignment from its consumed start permit.
      const plan = this.plan, target = args.target as WorkerRef;
      const assertOwner = () => {
        const row = this.store.attempts(this.runId).find(item=>item.id === target.attemptId);
        const reg: Registration | undefined = row && JSON.parse(row.registration);
        const state = this.store.planStates(this.runId)[args.taskId];
        if (!plan || !this.store.usageRecord(this.runId) || !reg || !sameWorker(reg.worker,target) || reg.taskId !== args.taskId || state?.attemptId !== target.attemptId ||
            state.state !== 'assigned' || !['running','idle','waiting_input','waiting_approval'].includes(row!.state) || !this.broker.canWake(this.runId) ||
            this.store.binding(this.runId)?.state !== 'consumed' || !scopeValid || state.reviewPlanHash || state.hold ||
            reg.settings?.permissions.permissionProfileId === 'read-only') throw new Error('current writable assignment required');
        plan.assertCurrent();
      };
      try {
        assertOwner();
        const assignment = this.store.gitAssignment(target.attemptId);
        const reg = registrations.find(r=>sameWorker(r.reg.worker,target))?.reg;
        if (!assignment || !reg || assignment.cwd !== reg.cwd || assignment.branch !== reg.branch || assignment.taskId !== reg.taskId) throw new Error('Git assignment mismatch');
        result = await plan!.git().saveWorkerChanges(assignment,args.expectedHead,args.message,assertOwner, () => this.store.operationState(args.operationId,'sent_unknown'));
      } catch (error) {
        if (this.store.operation(args.operationId).state === 'prepared') this.store.operationResult(args.operationId,'cancelled',{state:'cancelled'});
        throw error;
      }
    } else if (name === 'create_worker') {
      let assignment = this.scope.assignments.find(a => a.workerId === args.taskId);
      let historySource: HistorySource | undefined;
      let modelRouting: Registration['modelRouting'];
      let previous = registrations.filter(({ reg }) => reg.taskId === args.taskId).at(-1);
      let reuse = this.store.historyDecision(this.runId, args.taskId) === 'continue_history';
      const attemptId = randomUUID();
      const capacity = this.store.capacity(this.runId);
      if (capacity.quotaMaximum !== null && capacity.activeWorkers >= capacity.quotaMaximum && capacity.quotaMaximum < Math.min(capacity.requestedMaximum,capacity.approvedMaximum)) {
        this.store.usageWaiting(this.runId);
        const wait = { state:'waiting_usage', reason:capacity.reason, effectiveMaximum:capacity.effectiveMaximum };
        this.store.operationResult(args.operationId, 'cancelled', wait);
        return wait;
      }
      const correction = registrations.some(({ reg }) => reg.taskId === args.taskId), limit = this.broker.executionLimits(this.runId).maxCorrectionsPerTask;
      if (correction && limit !== null && this.store.correctionCount(this.runId, args.taskId) >= limit) {
        this.store.operationResult(args.operationId, 'cancelled', { state: 'correction_limit' });
        await this.broker.stopRun(this.runId, 'correction_limit');
        this.store.appendEvent({ runId: this.runId, kind: 'correction_limit' }); throw new Error('correction limit exhausted');
      }
      const reserve = () => this.store.transaction(() => {
        if (this.plan) {
          const allocated = this.plan.reserveAssignment(args.taskId, attemptId, this.scope.permissionPermit);
          modelRouting = allocated.modelRouting;
          if (modelRouting && (modelRouting.modelSwitch || modelRouting.initialRecommendation?.reason === 'learned')) {
            modelRouting = { ...modelRouting, creationOperationId: args.operationId };
          }
          const gitApprovalRoots = capacity.policy || allocated.agent.permissionProfileId === 'read-only' ? [] : this.plan.git().approvalRoots(allocated.assignment);
          assignment = { workerId: allocated.workerId, cwd: allocated.assignment.cwd, branch: allocated.assignment.branch, repositoryId: this.scope.repositoryId, ...allocated.agent, permissionPermit: allocated.permissionPermit, gitApprovalRoots };
          reuse = !!allocated.previous;
          historySource = allocated.historySource;
          if (reuse) previous = registrations.find(({ row }) => row.id === allocated.previous!.attemptId);
        }
        if (!assignment) throw new Error('task outside fixture scope');
        assignment = { ...assignment, permissionProfileId: assignment.permissionProfileId ?? 'workspace', permissionPermit: this.scope.permissionPermit ?? assignment.permissionPermit ?? { allowedProfileIds: ['workspace'], writableRoots: [assignment.cwd], allowedReviewers: ['user'] } };
        resolveTaskPermissions({ model: assignment.model, effort: assignment.effort, permissionProfileId: assignment.permissionProfileId! }, assignment.permissionPermit!);
        if (registrations.some(({ row, reg }) => reg.taskId === args.taskId && !['completed', 'stopped'].includes(row.state)) || this.store.attempts(this.runId).filter(row => !['completed', 'stopped'].includes(row.state)).length >= this.store.capacity(this.runId).effectiveMaximum || (reuse && previous?.row.state !== 'completed')) {
          throw new Error('attempt cleanup or completion is unresolved');
        }
        if (correction) this.store.reserveCorrection(this.runId, args.taskId, limit);
        const identity = { workerId: assignment.workerId, attemptId, ownerId: randomUUID(), ownerEpoch: randomUUID() };
        const pending = { ...identity, threadId: 'pending' };
        const reg: Registration = { ...assignment, ...(modelRouting ? { modelRouting } : {}), runId: this.runId, taskId: args.taskId, assignmentId: randomUUID(), worker: pending, hostPid: 0, hostCreated: 'unconfirmed', childPid: 0, childCreated: 'unconfirmed', jobId: 'unconfirmed', binding: { windowBindingId: this.scope.windowBindingId, terminalId: randomUUID(), worker: pending } };
        this.store.reserve(reg);
        return {reg,identity,assignment};
      });
      let reserved: ReturnType<typeof reserve>;
      try { reserved = reserve(); } catch (error) { this.store.operationResult(args.operationId,'cancelled',{state:'cancelled'}); throw error; }
      const {reg,identity} = reserved;
      assignment = reserved.assignment;
      const learned = modelRouting?.initialRecommendation?.reason === 'learned' ? modelRouting.initialRecommendation : undefined;
      let started: WorkerRef | undefined;
      try {
        this.store.operationState(args.operationId, 'sent_unknown');
        started = await this.runtime.start({ ...assignment, identity, ...(reuse ? { previous: previous!.reg.worker } : {}), ...(historySource ? { historySource } : {}), ...(learned ? { initialFallback: learned.planned } : {}) });
        if ((assignment.permissionProfileId === 'read-only' || modelRouting?.modelSwitch || learned) &&
            (started.threadId === 'pending' || this.store.hasRegisteredThread(started.threadId))) {
          throw new Error(assignment.permissionProfileId === 'read-only' ? 'read-only assignment requires a fresh thread' : 'model switch requires a fresh thread');
        }
        const settings = this.runtime.settings?.(started);
        this.store.register({ ...reg, ...this.runtime.registration(started), ...(settings ? { settings } : {}),
          ...(learned && settings?.initialFallback ? learned.planned : {}), worker: started, binding: { ...reg.binding, worker: started } });
        this.store.attemptState(started, 'idle');
        this.store.historyDecision(this.runId, args.taskId, 'new_worker'); result = started;
      } catch (error) {
        // Fixed diagnostic labels only; preserve unknown delivery and never expose provider text.
        const known = ['agent is not in catalog', 'managed permission profile not confirmed', 'read-only sandbox not confirmed', 'read-only MCP inventory not confirmed', 'read-only assignment requires a fresh thread', 'root thread identity or provider mismatch', 'requested model or provider not confirmed', 'managed MCP catalog unavailable', 'worker identity unavailable', 'MCP entry identity mismatch', 'requested task settings not confirmed', 'model switch requires a fresh thread'];
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
    } else if (name === 'retire_worker') result = await this.broker.retireWorker(this.runId, args.target);
    else if (name === 'stop_worker') {
      const target = registrations.find(({ reg }) => JSON.stringify(reg.worker) === JSON.stringify(args.target));
      if (!target) throw new Error('stale worker binding'); result = await this.broker.closeTerminal(this.runId, target.reg.binding);
    } else if (name === 'stop_run') result = await this.broker.stopRun(this.runId);
    else if (name === 'resume_run') { await this.broker.resumeRun(this.runId); result = this.store.run(this.runId); }
    this.store.operationResult(args.operationId, 'settled', result ?? null); return result;
  }
}
export function createMcpServer(invoke: (name: string, args: unknown, metadata: unknown) => Promise<any>, humanResponse?: (ref: HumanRequest, action: HumanAction, metadata: unknown) => Promise<unknown>, humanDecisionResponse?: (ref: HumanDecisionRef, answer: DecisionAnswer, metadata: unknown) => Promise<unknown>): McpServer {
  const server = new McpServer({ name: 'meristem-chat-control', version: '0.0.0' });
  for (const [name, schema] of Object.entries(schemas)) server.registerTool(name, {
    description: name === 'save_worker_changes' ? 'Coordinator only. Commit and push the assigned Worker worktree to its approved branch and destination. Use the exact current target and Git HEAD. No shell command or metadata write access is granted.' : name === 'hold_task' ? 'Park a task for a blocking consultation or plan change. Use replacesDecisionId to replace a stale hold reason. Parent only.'
      : name === 'resume_task' ? 'Validate hold resolutions, applied plan changes and Git, then prepare a task for explicit create_worker and send_instruction. Parent only.'
      : name === 'get_worker_history' ? 'Read a page of official Codex history for a saved attempt. Select the exact WorkerRef from get_status. Parent only.'
      : name === 'resume_worker_history' ? 'Reconcile one stopped attempt against Codex, Git and delivery records and prepare a fresh-thread handoff. Afterwards explicitly create_worker and send_instruction. Parent only.'
      : name === 'propose_plan_change' ? 'Stage a bounded task diff for human review through answer_consultation. Parent only.'
      : name === 'apply_plan_change' ? 'Apply the exact human-approved plan diff after parking affected attempts. Parent only.'
      : name === 'reconcile_plan' ? 'Unfreeze a plan after restoring its approved contents. Parent only.'
      : name === 'retire_worker' ? 'Stop only the exact worker attempt and keep the run active after confirmed cleanup. Does not complete its task or delete its worktree or logs. Parent only.'
      : name === 'record_decision' ? 'Parent only. For code, accept the candidate and then the checked integration. For a read-only review, inspect the saved report and call accept_review with its reportRef in evidenceRefs and the reviewed SHA in integrationSha. Both final decisions release dependencies.' : `Fixture-scoped ${name}; caller identity comes from native ownership and Codex metadata.`,
    inputSchema: schema,
    annotations: { readOnlyHint: ['get_status', 'get_decisions', 'get_worker_history'].includes(name), openWorldHint: false }
  }, async (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>): Promise<CallToolResult> => {
    try {
      let value = await invoke(name, args, extra._meta);
      if (value?.humanDecisionForm) {
        const { humanDecisionForm, ...status } = value; value = status;
        if (humanDecisionResponse && server.server.getClientCapabilities()?.elicitation?.form) {
          const answer = await elicitDecision(humanDecisionForm.decision, request => server.server.elicitInput(request, { timeout: 120000, signal: extra.signal, relatedRequestId: extra.requestId }));
          if (answer && !extra.signal.aborted) value = await humanDecisionResponse(humanDecisionForm.form, answer, extra._meta);
        }
      }
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
    const result = await pipeRequest(pipeName, { method: 'mcp', name, args, metadata }, ['create_worker', 'hold_task', 'save_worker_changes'].includes(name) ? 125000 : 25000);
    if (!result.ok) { if (result.error === 'stale_revision') throw new RevisionConflict(); throw new Error('control rejected'); } return result.value;
  }, async (ref, action, metadata) => {
    const result = await pipeRequest(pipeName, { method: 'mcp_human_response', metadata, args: { worker: ref.worker, key: ref.key, payloadHash: ref.payloadHash, formGeneration: ref.formGeneration, action } });
    if (!result.ok) throw new Error('human response rejected'); return result.value;
  }, async (decision, answer, metadata) => {
    const result = await pipeRequest(pipeName, { method: 'mcp_human_response', metadata, args: { decision, answer } });
    if (!result.ok) throw new Error('human response rejected'); return result.value;
  });
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--pipe') throw new Error('explicit control pipe required');
  await serveMcp(process.argv[3]);
}
