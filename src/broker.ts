import { createHash } from 'node:crypto';
import { Binding, sameWorker, Stop, Worker, ExecutionLimits } from './contracts.js';
import type { AgentChoice, ModelAssessment, OperationRef, Registration, StopResult, TerminalBinding, WorkerRef } from './contracts.js';
import { Store, type Attempt, type PlanTaskState } from './store.js';
import { RequestFailure } from './failures.js';
import { draftPlanChange, readPlan, samePlanProse, eligibleTasks, writePlanRevision, writeProgress, fileHash, taskAgent, type PlanChange, type PlanSnapshot } from './plan.js';
import { READ_ONLY_PROFILE, resolveTaskPermissions, type RunPermissionPermit } from './permissions.js';
import { GitEvidence, pinRepository, TaskReport, Checks, validateChecks, type GitAssignment } from './git-evidence.js';
import { realpathSync } from 'node:fs';
import type { HumanRequest } from './requests.js';
import type { HistorySource } from './workers.js';
import { recommendInitialAgent, requiredChecksHash, sameAgentChoice, selectNextAgent, summarizeModelOutcomes, type InitialRecommendation, type ModelAttempt, type ModelOutcome, type ModelSwitch } from './model-routing.js';
import type { RoutingHistory } from './routing-summary.js';

export interface Runtime {
  send(worker: WorkerRef, text: string, agent?: AgentChoice): Promise<void | 'agent_not_in_catalog'>;
  stop(worker: WorkerRef, reason: string): Promise<StopResult>;
  releaseCompleted(worker: WorkerRef): Promise<StopResult>;
}

// Mechanical plan/Git gates only. The parent chooses work, performs merges and runs checks.
export class PlanControl {
  constructor(private store: Store, private runId: string, private canProceed = () => store.run(runId).state === 'active',
    private correctionLimit?: () => number | null, private routingHistory?: RoutingHistory) {}
  open(planPath: string, repositoryPath: string, branchScope: string[]): void {
    if (!this.store.plan(this.runId)) {
      const snapshot = readPlan(planPath), pin = pinRepository(snapshot, this.runId);
      if (realpathSync(repositoryPath) !== pin.repository || !branchScope.includes(pin.integrationBranch)) throw new Error('plan outside authorized repository or branch scope');
      this.store.savePlan(this.runId, snapshot, pin);
    }
  }
  current() {
    const record = this.store.plan(this.runId); if (!record) throw new Error('plan not registered');
    let observed: PlanSnapshot | undefined;
    try { observed = readPlan(record.snapshot.path); } catch { this.store.freezePlan(this.runId); }
    if (!observed || observed.planHash !== record.snapshot.planHash || !samePlanProse(record.snapshot, observed)) this.store.freezePlan(this.runId);
    return { ...record, frozen: this.store.plan(this.runId)!.frozen, observed };
  }
  assertCurrent(): void { if (this.current().frozen) throw new Error('plan changed; parent reconciliation required'); }
  git(): GitEvidence { const p = this.store.plan(this.runId)!; return new GitEvidence(p.snapshot, p.pin); }
  private integrations(): string[] { return Object.values(this.store.planStates(this.runId)).flatMap(s => s.integrationSha ? [s.integrationSha] : []); }
  private latest(taskId: string) { return this.store.attempts(this.runId).filter(a => (JSON.parse(a.registration) as Registration).taskId === taskId).at(-1); }
  private assignmentStates(): Record<string, PlanTaskState> {
    const states = this.store.planStates(this.runId);
    for (const row of this.store.attempts(this.runId)) {
      const taskId = (JSON.parse(row.registration) as Registration).taskId;
      if (!['completed', 'stopped'].includes(row.state)) states[taskId] = { ...states[taskId], state: row.state };
      else if (states[taskId]?.attemptId === row.id && states[taskId].state === 'assigned') states[taskId] = { ...states[taskId], state: 'awaiting_evidence' };
    }
    for (const taskId of this.store.pendingBlockingTaskIds(this.runId)) states[taskId] = { ...(states[taskId] ?? { state: 'pending' }), blockedByDecision: true };
    return states;
  }
  holdTask(ref: OperationRef, taskId: string, decisionId: string, replacesDecisionId?: string) {
    if (ref.runId !== this.runId) throw new Error('hold run mismatch');
    return this.store.coordinationOperation(ref, fileHash(JSON.stringify(['hold', taskId, decisionId, ...(replacesDecisionId ? [replacesDecisionId] : [])])), () => {
      this.assertCurrent();
      const p = this.current(), states = this.store.planStates(this.runId), state = states[taskId];
      const decision = this.store.coordinationDecision(this.runId, decisionId)?.decision;
      if (!this.canProceed() || !p.snapshot.plan.tasks.some(t => t.id === taskId) || !decision || decision.planHash !== p.snapshot.planHash || !decision.blockingTaskIds.includes(taskId)) throw new Error('current blocking decision required');
      if (state?.integrationSha || Object.values(states).some(s => s.pendingIntegration)) throw new Error('integration reservation is fixed');
      const attempt = this.latest(taskId);
      if (attempt && state?.attemptId !== attempt.id) throw new Error('hold attempt mismatch');
      if (attempt?.state === 'starting') throw new Error('hold requires registered attempt');
      const releasedExecutionSlot = !attempt || this.stoppedAttempt(taskId, attempt.id);
      const heldIds = state?.hold?.decisionIds ?? [];
      if (replacesDecisionId) {
        const replaced = this.store.coordinationDecision(this.runId, replacesDecisionId)?.decision;
        const stillPending = replaced?.state === 'pending' || this.store.planChangeAgreement(this.runId, replacesDecisionId) && !this.store.coordinationRevision(this.runId, replacesDecisionId);
        const hasBlocker = heldIds.includes(replacesDecisionId) || this.store.taskHolds(this.runId, taskId).some(hold => hold.decisionId === replacesDecisionId);
        if (!hasBlocker || !replaced || replacesDecisionId === decisionId || stillPending || (replaced.recipient === 'human' && decision.recipient !== 'human')) throw new Error('cannot replace held decision');
        this.store.releaseTaskHold(this.runId, taskId, replacesDecisionId);
      }
      const decisionIds = [...new Set([...heldIds.filter(id => id !== replacesDecisionId), decisionId])];
      if (decisionIds.length > 128) throw new Error('too many held decisions');
      const hold = { taskId, decisionId, releasedExecutionSlot };
      this.store.saveTaskHold(this.runId, hold);
      this.store.savePlanState(this.runId, taskId, { ...state, state: 'held', hold: { ...state?.hold, decisionIds, planHash: p.snapshot.planHash, releasedExecutionSlot } });
      return hold;
    });
  }
  private stoppedAttempt(taskId: string, attemptId: string): boolean {
    const row = this.latest(taskId);
    if (!row || row.id !== attemptId || !['completed', 'stopped'].includes(row.state) || !row.stop_result) return false;
    const result = JSON.parse(row.stop_result) as StopResult, reg = JSON.parse(row.registration) as Registration;
    return result.state === 'stopped' && sameWorker(result.worker, reg.worker);
  }
  private assertResumable(taskId: string, state: PlanTaskState): GitAssignment | undefined {
    this.assertCurrent(); const p = this.current(), hold = state.hold;
    if (!hold?.releasedExecutionSlot || this.store.pendingBlockingTaskIds(this.runId).has(taskId)) throw new Error('task is not safely parked or consultation unresolved');
    for (const id of hold.decisionIds) {
      const record = this.store.coordinationDecision(this.runId, id);
      if (record?.decision.kind === 'plan_change' && this.store.coordinationRevision(this.runId, id) && this.store.planChangeAgreement(this.runId, id)?.blockingTaskIds.includes(taskId)) continue;
      // Only an explicit unchanged-plan resume choice authorizes continuation.
      // Free text may amend the proposal; it is never an implicit permission.
      if (!record || record.decision.state !== 'resolved' || record.decision.kind !== 'consultation' || record.decision.planHash !== p.snapshot.planHash || !record.decision.blockingTaskIds.includes(taskId) || record.answer?.optionId !== 'resume' || record.answer.text || !record.decision.options.some(option => option.id === 'resume')) throw new Error('consultation does not authorize resume');
    }
    if (!state.attemptId) {
      if (this.latest(taskId)) throw new Error('resume attempt mismatch');
      return;
    }
    const old = this.latest(taskId);
    if (!old || old.id !== state.attemptId || !this.stoppedAttempt(taskId, old.id) || this.store.requests(this.runId).some(r => r.attempt_id === old.id && ['pending', 'unsupported', 'replied'].includes(String(r.state)))) throw new Error('resume cleanup or attempt unresolved');
    const reg = JSON.parse(old.registration) as Registration, managed = this.store.gitAssignment(old.id);
    if (!managed || managed.taskId !== taskId || reg.cwd !== managed.cwd || reg.branch !== managed.branch || this.store.attempts().some(a => a.id !== old.id && !['completed', 'stopped'].includes(a.state) && (a.cwd.toLowerCase() === managed.cwd.toLowerCase() || (JSON.parse(a.registration) as Registration).worker.workerId === reg.worker.workerId))) throw new Error('held worktree or owner changed');
    const dependencies = p.snapshot.plan.tasks.find(task => task.id === taskId)!.depends_on, states = this.store.planStates(this.runId);
    if (dependencies.some(id => states[id]?.state !== 'integrated' || !states[id].integrationSha)) throw new Error('held task dependencies not integrated');
    if (hold.revised) return; // Preserve the old tree and start from accepted integration.
    // A paused task continues its own branch, like an uninterrupted task. Later
    // independent integrations are checked at the integration/final-SHA gates.
    return this.git().reuseWorktree(managed, dependencies.map(id => states[id].integrationSha!));
  }
  resumeTask(ref: OperationRef, taskId: string, resolvedDecisionId: string) {
    if (ref.runId !== this.runId) throw new Error('resume run mismatch');
    return this.store.coordinationOperation(ref, fileHash(JSON.stringify(['resume', taskId, resolvedDecisionId])), () => {
      const state = this.store.planStates(this.runId)[taskId];
      if (!this.canProceed() || state?.state !== 'held' || !state.hold?.decisionIds.includes(resolvedDecisionId)) throw new Error('held decision required');
      this.assertResumable(taskId, state);
      if (this.current().initialized) this.git().integrationBase(this.integrations());
      else this.git().assertRepository();
      this.store.savePlanState(this.runId, taskId, { ...state, state: 'pending', dispatch: { mode: 'new' } });
      return { state: 'resume_ready', taskId, decisionId: resolvedDecisionId };
    });
  }
  historyCheckpoint(target: WorkerRef) {
    this.assertCurrent();
    const row = this.store.attempts(this.runId).find(row => row.id === target.attemptId);
    const registration = row && JSON.parse(row.registration) as Registration;
    if (!registration || target.threadId === 'pending' || !sameWorker(registration.worker, target)) throw new Error('stale history target');
    const { taskId, cwd, branch } = registration, states = this.store.planStates(this.runId), state = states[taskId];
    const plan = this.store.plan(this.runId)!;
    const task = plan.snapshot.plan.tasks.find(task => task.id === taskId);
    const managed = this.store.gitAssignment(target.attemptId);
    if (!task || !managed || managed.taskId !== taskId || managed.attemptId !== target.attemptId || cwd !== managed.cwd || branch !== managed.branch ||
        state?.attemptId !== target.attemptId || this.latest(taskId)?.id !== target.attemptId) throw new Error('history assignment or attempt changed');
    const stop = Stop.safeParse(row.stop_result && JSON.parse(row.stop_result));
    if (!['stopped', 'completed'].includes(row.state) || !stop.success || stop.data.state !== 'stopped' || !stop.data.evidenceRefs.length ||
        !sameWorker(stop.data.worker, target)) throw new Error('history attempt stop unconfirmed');
    if (!this.canProceed() || this.store.operationUnknown(this.runId) || this.store.wakeUnknown(this.runId) ||
        this.store.attempts(this.runId).some(row => row.state === 'unknown') ||
        this.store.requests(this.runId).some(r => r.attempt_id === row.id && ['pending', 'unsupported', 'replied'].includes(String(r.state)))) throw new Error('history delivery or cleanup needs reconciliation');
    if (this.store.pendingBlockingTaskIds(this.runId).has(taskId) || (state.hold && (state.state !== 'pending' || state.hold.revised))) throw new Error('resolve the task consultation or plan change first');
    if (state.candidate || state.integrationSha || Object.values(states).some(state => state.pendingIntegration)) throw new Error('history task has fixed Git evidence');
    if (this.store.attempts().some(other => !['stopped', 'completed'].includes(other.state) && other.cwd.toLowerCase() === cwd.toLowerCase()) ||
        Object.entries(states).some(([id, other]) => id !== taskId && other.hold && other.attemptId && this.store.gitAssignment(other.attemptId)?.cwd.toLowerCase() === cwd.toLowerCase())) throw new Error('history worktree is reserved');
    const dependencies = task.depends_on.map(id => states[id]?.state === 'integrated' && states[id].integrationSha);
    if (dependencies.some(sha => !sha)) throw new Error('history dependencies not integrated');
    this.git().integrationBase(this.integrations());
    const assignment = state.hold ? this.assertResumable(taskId, state)! : this.git().reuseWorktree(managed, dependencies as string[]);
    return { taskId, state, assignment, modelProvider: registration.modelProvider, completedTurnId: row.completed_turn_id };
  }
  private cleanCompletion(attemptId: string): void {
    const row = this.store.attempts(this.runId).find(a => a.id === attemptId);
    if (!row || row.state !== 'completed' || !row.completed_turn_id || !row.stop_result || JSON.parse(row.stop_result).state !== 'stopped' || this.store.requests(this.runId).some(r => r.attempt_id === attemptId && ['pending', 'unsupported', 'replied'].includes(String(r.state)))) throw new Error('attempt cleanup, turn or requests unresolved');
  }
  checkUsageWaiting() {
    const cap = this.store.capacity(this.runId);
    if (!cap.policy || !this.canProceed() || !this.store.plan(this.runId)) return;
    const p = this.current(), states = this.assignmentStates();
    if (p.frozen || Object.values(states).some(s => s.pendingIntegration || s.state === 'unknown')) return;
    if (eligibleTasks(p.snapshot, states, cap.effectiveMaximum).length) this.store.notifyUsageRecovery(this.runId);
    else if (eligibleTasks(p.snapshot, states, cap.approvedMaximum).length && cap.quotaMaximum !== null) this.store.usageWaiting(this.runId);
  }
  reserveAssignment(taskId: string, attemptId: string, permissionPermit?: RunPermissionPermit) {
    this.assertCurrent();
    // Single writer: reserve slots/resources and persist the assignment before runtime I/O.
    return this.store.transaction(() => this.allocate(taskId, attemptId, permissionPermit));
  }
  private assertModelSwitch(taskId: string, modelSwitch: ModelSwitch, snapshot: PlanSnapshot): void {
    const plan = snapshot.plan;
    const policy = plan.schema_version === 2 && plan.tasks.find(task => task.id === taskId)?.model_routing ? plan.run.worker_model_policy : undefined;
    const previous = this.latest(taskId);
    const registration: Registration | undefined = previous ? JSON.parse(previous.registration) : undefined;
    const agent = registration?.modelRouting?.agent;
    const next = policy && agent ? selectNextAgent(policy.candidates, agent) : undefined;
    if (!registration || previous?.id !== modelSwitch.previousAttemptId || modelSwitch.planHash !== snapshot.planHash ||
      modelSwitch.stopGeneration !== this.store.run(this.runId).stop_generation || !next || !sameAgentChoice(next, modelSwitch.agent)) {
      throw new Error('model switch checkpoint changed');
    }
    const { assignment } = this.historyCheckpoint(registration.worker);
    if (assignment.baseSha !== modelSwitch.sourceHead) throw new Error('model switch source HEAD changed');
  }
  private initialRecommendation(taskId: string, snapshot: PlanSnapshot): InitialRecommendation | undefined {
    const plan = snapshot.plan;
    if (plan.schema_version !== 2 || !plan.run.worker_model_policy) return undefined;
    const task = plan.tasks.find(item => item.id === taskId);
    const classification = task?.model_routing;
    if (!task || !classification || task.continuation.mode !== 'new') return undefined;
    const { model, effort } = task.agent;
    const planned = { model, effort };
    const selected = planned;
    if (classification.pin_initial) return { planned, selected, reason: 'pinned' };
    if (!classification.comparison_key) return { planned, selected, reason: 'comparison_key_missing' };
    const history = this.routingHistory;
    if (!history) return { planned, selected, reason: 'summary_not_configured' };
    const checksHash = requiredChecksHash(task.completion);
    const stats = history.stats.filter(row => row.repositoryKey === history.repositoryKey &&
      row.classification.kind === classification.kind && row.classification.complexity === classification.complexity &&
      row.classification.comparison_key === classification.comparison_key && row.requiredChecksHash === checksHash);
    const policy = plan.run.worker_model_policy;
    const recommended = recommendInitialAgent(planned, policy.candidates, stats);
    if (!recommended) return { planned, selected, reason: 'insufficient_evidence' };
    return policy.mode === 'learned'
      ? { planned, selected: recommended, recommended, reason: 'learned' }
      : { planned, selected, recommended, reason: 'rules_advisory' };
  }
  private allocate(taskId: string, attemptId: string, permissionPermit?: RunPermissionPermit) {
    this.assertCurrent(); const p = this.current(), task = p.snapshot.plan.tasks.find(t => t.id === taskId), states = this.store.planStates(this.runId);
    if (!task) throw new Error('unknown task');
    const previous = this.latest(taskId), dispatch = states[taskId]?.dispatch ?? (task.continuation.mode === 'same' ? { mode: 'same' as const, after: task.continuation.after } : task.continuation.mode === 'new' ? { mode: 'new' as const } : undefined);
    if (!dispatch || (previous && !states[taskId]?.dispatch)) throw new Error('parent continuation decision required');
    const modelSwitch = dispatch.mode === 'new' && 'modelSwitch' in dispatch ? dispatch.modelSwitch : undefined;
    if (modelSwitch) this.assertModelSwitch(taskId, modelSwitch, p.snapshot);
    const initialRecommendation = !previous && dispatch.mode === 'new' ? this.initialRecommendation(taskId, p.snapshot) : undefined;
    const agent = { ...taskAgent(task), ...modelSwitch?.agent, ...initialRecommendation?.selected };
    permissionPermit ??= { allowedProfileIds: ['workspace'], writableRoots: [p.snapshot.plan.run.worktrees_root], allowedReviewers: ['user'] };
    resolveTaskPermissions(agent, permissionPermit);
    if (!this.canProceed() || this.store.attempts(this.runId).some(a => a.state === 'unknown') || Object.values(states).some(s => s.pendingIntegration)) throw new Error('dispatch or cleanup unresolved');
    if (!eligibleTasks(p.snapshot, this.assignmentStates(), this.store.capacity(this.runId).effectiveMaximum).includes(taskId)) throw new Error('assignment slots, dependencies or resources unavailable');
    if (states[taskId]?.integrationSha || task.depends_on.some(d => states[d]?.state !== 'integrated')) throw new Error('task dependencies not integrated');
    const git = this.git();
    if (agent.permissionProfileId !== 'read-only') git.approvalRoots();
    if (!p.initialized) { git.initialize(); this.store.initializePlan(this.runId); }
    git.integrationBase(this.integrations());
    let assignment: GitAssignment, source: WorkerRef | undefined, historySource: HistorySource | undefined;
    if (dispatch.mode === 'history') {
      if (dispatch.stopGeneration !== this.store.run(this.runId).stop_generation) throw new Error('history checkpoint changed');
      const current = this.historyCheckpoint(dispatch.target);
      if (current.taskId !== taskId || !current.modelProvider || current.assignment.baseSha !== dispatch.head) throw new Error('history checkpoint changed');
      assignment = { ...current.assignment, attemptId };
      historySource = { threadId: dispatch.target.threadId, modelProvider: current.modelProvider };
    } else if (states[taskId]?.hold) {
      const managed = this.assertResumable(taskId, states[taskId]);
      assignment = managed ? { ...managed, taskId, attemptId } : git.createWorktree(taskId, attemptId, this.integrations());
    } else if (dispatch.mode === 'same') {
      const old = this.latest(dispatch.after ?? taskId); if (!old) throw new Error('history source unavailable');
      this.cleanCompletion(old.id); const reg = JSON.parse(old.registration) as Registration, managed = this.store.gitAssignment(old.id);
      if (!managed || reg.cwd !== managed.cwd || reg.branch !== managed.branch) throw new Error('history cwd changed');
      if (Object.entries(states).some(([id, state]) => id !== taskId && state.hold && state.attemptId && this.store.gitAssignment(state.attemptId)?.cwd.toLowerCase() === managed.cwd.toLowerCase())) throw new Error('history worktree reserved by held task');
      if (this.store.attempts().some(a => !['completed', 'stopped'].includes(a.state) && (a.cwd.toLowerCase() === managed.cwd.toLowerCase() || (JSON.parse(a.registration) as Registration).worker.workerId === reg.worker.workerId))) throw new Error('history worktree or worker is already reserved');
      const report = this.store.latestReport(this.runId, old.id);
      const required = report ? TaskReport.parse(report.report).candidate_sha : null;
      const reused = git.reuseWorktree(managed, [...this.integrations(), ...(required ? [required] : [])], managed.taskId !== taskId);
      assignment = { ...reused, taskId, attemptId }; source = reg.worker;
    } else assignment = git.createWorktree(taskId, attemptId, this.integrations());
    this.store.saveGitAssignment(this.runId, assignment);
    this.store.savePlanState(this.runId, taskId, { state: 'assigned', attemptId, revisionPlanHash: states[taskId]?.revisionPlanHash,
      ...(agent.permissionProfileId === 'read-only' ? { reviewPlanHash: p.snapshot.planHash } : {}) });
    const livePlan = p.snapshot.plan;
    const classification = livePlan.schema_version === 2 ? livePlan.tasks.find(item => item.id === taskId)?.model_routing : undefined;
    const modelRouting: ModelAttempt | undefined = classification && {
      repositoryKey: fileHash(p.pin.commonDir.toLowerCase()),
      planHash: p.snapshot.planHash,
      classification,
      requiredChecks: [...task.completion],
      phase: previous ? 'handoff' : 'initial',
      agent: null,
      ...(modelSwitch ? { modelSwitch } : {}),
      ...(initialRecommendation ? { initialRecommendation } : {})
    };
    return { assignment, previous: source, historySource, agent, permissionPermit, workerId: source?.workerId ?? (dispatch.mode === 'history' ? dispatch.target.workerId : taskId), modelRouting };
  }
  validateReport(taskId: string, worker: WorkerRef, input: unknown): void {
    this.assertCurrent();
    const state = this.store.planStates(this.runId)[taskId];
    if (state?.hold || state?.attemptId !== worker.attemptId) throw new Error('held or stale attempt report');
    if (state.reviewPlanHash && (state.state !== 'assigned' || state.reviewPlanHash !== this.store.plan(this.runId)?.snapshot.planHash)) throw new Error('review attempt or plan is no longer current');
    const { report } = this.assignedReport(taskId, worker, input);
    if (this.store.coordinatorSave(this.runId) && (report.candidate_sha !== null || report.push_result.status !== 'not_attempted' || report.push_result.branch !== report.branch)) throw new Error('Worker must report worktree observations before Coordinator save');
  }
  private assignedReport(taskId: string, worker: WorkerRef, input: unknown) {
    const report = TaskReport.parse(input), assignment = this.store.gitAssignment(worker.attemptId);
    if (!assignment || report.task_id !== taskId || report.worker_id !== worker.workerId || report.attempt_id !== worker.attemptId || report.actor_id !== worker.threadId || assignment.taskId !== taskId || assignment.attemptId !== worker.attemptId || assignment.baseSha !== report.base_sha || assignment.branch !== report.branch || (report.question && report.status !== 'needs_input')) throw new Error('report metadata or assignment mismatch');
    return { report, assignment };
  }
  completedEditReport(taskId: string, worker: WorkerRef, reportRef: string | undefined) {
    const row = this.latest(taskId), state = this.store.planStates(this.runId)[taskId];
    if (!row || row.id !== worker.attemptId || state?.attemptId !== row.id || state.dispatch || state.hold || state.reviewPlanHash ||
        this.store.pendingBlockingTaskIds(this.runId).has(taskId)) throw new Error('current writable assignment required');
    this.cleanCompletion(row.id);
    const reg = JSON.parse(row.registration) as Registration, stop = Stop.parse(JSON.parse(row.stop_result!));
    const saved = this.store.latestReport(this.runId, row.id);
    if (!sameWorker(reg.worker,worker) || !sameWorker(stop.worker,worker) || !stop.evidenceRefs.length ||
        !saved || saved.operationId !== reportRef || saved.turnId !== row.completed_turn_id) throw new Error('completed turn report and confirmed cleanup required');
    const {report, assignment} = this.assignedReport(taskId,worker,saved.report);
    const task = this.store.plan(this.runId)!.snapshot.plan.tasks.find(t => t.id === taskId);
    if (!task || taskAgent(task).permissionProfileId === 'read-only' || reg.cwd !== assignment.cwd || reg.branch !== assignment.branch ||
        report.status !== 'completed' || report.remaining.length || report.question || report.candidate_sha !== null ||
        report.push_result.branch !== assignment.branch || report.push_result.status !== 'not_attempted') throw new Error('completed worktree report required');
    validateChecks(report.checks,task.completion);
    return assignment;
  }
  async candidate(taskId: string, decision?: {evidenceRefs?: string[]; checks?: unknown}) {
    this.assertCurrent();
    if (this.store.planStates(this.runId)[taskId]?.hold || this.store.pendingBlockingTaskIds(this.runId).has(taskId)) throw new Error('held candidate');
    const row = this.latest(taskId); if (!row) throw new Error('no candidate attempt'); this.cleanCompletion(row.id);
    const report = this.store.latestReport(this.runId, row.id), assignment = this.store.gitAssignment(row.id);
    if (!report || !assignment || report.turnId !== row.completed_turn_id) throw new Error('report does not match completed turn');
    let candidate;
    if (this.store.coordinatorSave(this.runId)) {
      const fixed = this.store.planStates(this.runId)[taskId]?.candidate;
      const operation = this.store.savedCandidateOperation(this.runId,row.id);
      const save = operation?.result && JSON.parse(operation.result);
      const refs = decision ? decision.evidenceRefs : [fixed?.reportRef, fixed?.saveRef];
      if (!operation || operation.state !== 'settled' || save?.pushResult !== 'pushed' || save.branch !== assignment.branch ||
          save.reportRef !== report.operationId || refs?.length !== 2 || !refs.includes(report.operationId) || !refs.includes(operation.id)) throw new Error('report and settled save references required');
      this.completedEditReport(taskId,(JSON.parse(row.registration) as Registration).worker,report.operationId);
      const checks = decision ? decision.checks : fixed?.checks;
      candidate = { ...await this.git().verifyCandidate(taskId,report.report,assignment,{candidateSha:save.candidateSha, checks}),
        reportRef:report.operationId, saveRef:operation.id };
    } else candidate = await this.git().verifyCandidate(taskId, report.report, assignment);
    this.assertCurrent();
    if (this.store.planStates(this.runId)[taskId]?.hold || this.store.pendingBlockingTaskIds(this.runId).has(taskId) || this.latest(taskId)?.id !== row.id) throw new Error('candidate attempt changed or held');
    return candidate;
  }
  private review(taskId: string) {
    const p = this.current(), state = this.store.planStates(this.runId)[taskId], task = p.snapshot.plan.tasks.find(t => t.id === taskId);
    const row = this.latest(taskId);
    if (p.frozen || !this.canProceed() || !task || taskAgent(task).permissionProfileId !== 'read-only' || !row ||
        state?.state !== 'assigned' || state.attemptId !== row.id || state.reviewPlanHash !== p.snapshot.planHash || !state.reviewInstructionId ||
        this.store.operationUnknown(this.runId) || this.store.wakeUnknown(this.runId) || this.store.pendingBlockingTaskIds(this.runId).has(taskId)) throw new Error('current read-only assignment and resolved delivery required');
    this.cleanCompletion(row.id);
    const reg = JSON.parse(row.registration) as Registration, stop = Stop.parse(JSON.parse(row.stop_result!));
    if (!sameWorker(stop.worker, reg.worker) || !stop.evidenceRefs.length || reg.settings?.agent.permissionProfileId !== 'read-only' ||
        reg.settings.permissions.permissionProfileId !== READ_ONLY_PROFILE || reg.settings.permissions.writableRoots.length) throw new Error('read-only settings or confirmed cleanup missing');
    const saved = this.store.latestReport(this.runId, row.id);
    if (!saved || saved.turnId !== row.completed_turn_id) throw new Error('review does not match the completed turn');
    const { report, assignment } = this.assignedReport(taskId, reg.worker, saved.report);
    if (assignment.cwd !== reg.cwd || assignment.branch !== reg.branch) throw new Error('review does not match the completed assignment');
    const instruction = this.store.operation(state.reviewInstructionId), reportOp = this.store.operation(saved.operationId);
    if (instruction.run_id !== this.runId || instruction.state !== 'acked' || reportOp.run_id !== this.runId ||
        reportOp.state !== 'settled' || instruction.expected_revision >= reportOp.expected_revision) throw new Error('review must follow the acknowledged instruction');
    const reviewedSha = this.git().verifyReview(report, assignment, task.completion, this.integrations());
    return { reportRef: saved.operationId, reviewedSha };
  }
  async status() {
    const p = this.current(), states = this.store.planStates(this.runId);
    const readyReviews = new Map<string, { reportRef: string; reviewedSha: string }>();
    for (const [taskId, state] of Object.entries(states)) {
      if (state.integrationSha || state.dispatch || state.hold || state.state === 'retired') continue;
      const attempt = this.latest(taskId);
      if (attempt && !['completed', 'stopped'].includes(attempt.state)) { states[taskId] = { ...state, state: attempt.state }; continue; }
      try {
        if (state.reviewPlanHash) {
          readyReviews.set(taskId, this.review(taskId));
          states[taskId] = { ...state, state: 'review_ready' };
          continue;
        }
        const candidate = await this.candidate(taskId);
        if (state.candidate && state.candidate.candidateSha !== candidate.candidateSha) throw new Error('fixed candidate changed');
        states[taskId] = { ...state, state: state.state === 'candidate_accepted' ? state.state : 'candidate_ready', candidate };
      } catch { states[taskId] = { ...state, state: 'awaiting_evidence' }; }
    }
    const blocking = this.store.pendingBlockingTaskIds(this.runId);
    const taskIds = new Set([...Object.keys(states), ...blocking]);
    const summary = Object.fromEntries([...taskIds].map(id => {
      const s = states[id];
      const review = s?.reviewEvidence ?? readyReviews.get(id);
      return [id, { state: s?.state ?? 'pending', attemptId: s?.attemptId, candidateSha: s?.candidate?.candidateSha, integrationSha: s?.integrationSha, ...(review ? { reportRef: review.reportRef, reviewedSha: review.reviewedSha } : {}), ...(s?.hold ? { releasedExecutionSlot: s.hold.releasedExecutionSlot } : {}), ...(blocking.has(id) ? { blockedByDecision: true } : {}) }];
    }));
    const blocked = p.frozen || !this.canProceed() || Object.values(states).some(s => s.pendingIntegration || s.state === 'unknown');
    const capacity = this.store.capacity(this.runId);
    return { ...capacity, planHash: p.snapshot.planHash, observedPlanHash: p.observed?.planHash, fileHash: p.observed?.fileHash, frozen: p.frozen, tasks: summary, eligible: blocked ? [] : eligibleTasks(p.snapshot, this.assignmentStates(), capacity.effectiveMaximum), integrationCwd: p.pin.integrationCwd };
  }
  reconcile(expectedFileHash: string, expectedPlanHash: string): void {
    const p = this.current(), next = p.observed;
    if (!next || next.fileHash !== expectedFileHash || next.planHash !== expectedPlanHash) throw new Error('plan changed during reconciliation');
    if (next.planHash !== p.snapshot.planHash || !samePlanProse(p.snapshot, next)) throw new Error('restore the approved plan before reconciliation');
    this.git().assertRepository(); this.store.savePlan(this.runId, next, p.pin);
  }
  proposeChange(input: PlanChange, permissionPermit?: RunPermissionPermit) {
    const p = this.current();
    if (p.frozen || input.expectedPlanHash !== p.snapshot.planHash || !p.observed || !this.canProceed()) throw new Error('current plan required');
    const change = draftPlanChange(p.observed, input);
    const states = this.store.planStates(this.runId);
    if (change.affected.some(id => states[id]?.integrationSha)) throw new Error('integrated task is immutable');
    permissionPermit ??= { allowedProfileIds: ['workspace'], writableRoots: [p.pin.root], allowedReviewers: ['user'] };
    for (const task of change.draft.plan.tasks.filter(task => input.tasks.some(change => change.id === task.id && change.agent))) resolveTaskPermissions(taskAgent(task), permissionPermit);
    return change;
  }
  applyChange(ref: OperationRef, decisionId: string, expectedPlanHash: string, proposedPlanHash: string) {
    return this.store.coordinationOperation(ref, fileHash(JSON.stringify(['apply_plan_change', decisionId, expectedPlanHash, proposedPlanHash])), () => {
      const p = this.current(), observed = p.observed;
      const agreement = this.store.planChangeAgreement(this.runId, decisionId);
      if (!this.canProceed() || !agreement || agreement.planHash !== expectedPlanHash || p.snapshot.planHash !== expectedPlanHash || agreement.proposedPlanHash !== proposedPlanHash || this.store.coordinationRevision(this.runId, decisionId)) throw new Error('matching human agreement required');
      const draft = this.store.planRevision(this.runId, proposedPlanHash);
      if (!observed || !draft?.planText || proposedPlanHash !== fileHash(draft.planText) || !samePlanProse(draft, observed) || ![expectedPlanHash, proposedPlanHash].includes(observed.planHash)) throw new Error('plan does not match the approved document');
      const recoveringLegacy = p.snapshot.documentHash === undefined && observed.planHash === proposedPlanHash;
      if (!recoveringLegacy && !samePlanProse(p.snapshot, observed)) throw new Error('plan does not match the approved document');
      const states = this.store.planStates(this.runId);
      if (Object.values(states).some(state => state.pendingIntegration)) throw new Error('integration reservation is fixed');
      for (const taskId of agreement.blockingTaskIds) {
        const state = states[taskId], attempt = this.latest(taskId);
        if (state?.integrationSha) throw new Error('integrated task is immutable');
        if (attempt && (state?.attemptId !== attempt.id || !this.stoppedAttempt(taskId, attempt.id) || state.hold && !state.hold.releasedExecutionSlot)) throw new Error('affected attempt must be safely parked before applying');
        const decisionIds = [...new Set([...(state?.hold?.decisionIds ?? []), decisionId])];
        if (decisionIds.length > 128) throw new Error('too many held decisions');
        this.store.savePlanState(this.runId, taskId, { state: 'held', attemptId: attempt?.id, revisionPlanHash: proposedPlanHash, hold: { decisionIds, planHash: proposedPlanHash, releasedExecutionSlot: true, revised: true } });
      }
      if (p.initialized) this.git().integrationBase(this.integrations());
      else this.git().assertRepository();
      this.store.saveCoordinationRevision(this.runId, decisionId, proposedPlanHash);
      this.store.releaseDecisionHolds(this.runId, decisionId);
      this.store.supersedePlanDecisions(this.runId, expectedPlanHash);
      // A failed DB commit after the file replacement leaves the run frozen.
      // Retrying the same approved diff can finish the transaction from these exact bytes.
      const next = observed.planHash === proposedPlanHash ? observed : writePlanRevision(observed, draft.planText);
      this.store.savePlanInTransaction(this.runId, next, p.pin);
      this.store.appendEvent({ runId: this.runId, kind: 'plan_change_applied' });
      return { state: 'plan_changed', decisionId, planHash: proposedPlanHash, affectedTaskIds: agreement.blockingTaskIds };
    });
  }
  modelRoutingStatus(taskId: string) {
    const samples = this.store.modelOutcomes(this.runId, taskId);
    const snapshot = this.store.plan(this.runId)?.snapshot;
    const plan = snapshot?.plan;
    if (!samples.length && !(plan?.schema_version === 2 && plan.tasks.some(task => task.id === taskId && task.model_routing))) return undefined;
    const summary = summarizeModelOutcomes(samples);
    const attempt = this.latest(taskId);
    const saved = attempt?.state === 'completed' ? this.store.latestReport(this.runId, attempt.id) : undefined;
    const report = TaskReport.safeParse(saved?.report);
    const registration: Registration | undefined = attempt ? JSON.parse(attempt.registration) : undefined;
    const reservedInitial = registration?.modelRouting?.initialRecommendation;
    const initialRecommendation = reservedInitial && attempt ? { ...reservedInitial, attemptId: attempt.id } :
      !attempt && snapshot ? this.initialRecommendation(taskId, snapshot) : undefined;
    const dispatch = this.store.planStates(this.runId)[taskId]?.dispatch;
    const reservedSwitch = registration?.modelRouting?.modelSwitch;
    const queuedSwitch = dispatch?.mode === 'new' ? dispatch.modelSwitch : undefined;
    const activeAttempt = attempt && !['completed', 'stopped', 'unknown'].includes(attempt.state);
    const next = queuedSwitch ?? (activeAttempt ? reservedSwitch : undefined);
    const nextAssignment = next && next.planHash === snapshot?.planHash && next.stopGeneration === this.store.run(this.runId).stop_generation
      && this.canProceed() && !this.store.plan(this.runId)?.frozen
      ? { ...next, ...(!queuedSwitch && attempt ? { attemptId: attempt.id } : {}) } : undefined;
    const creationOperationId = registration?.modelRouting?.creationOperationId;
    const creation = creationOperationId ? this.store.operation(creationOperationId).result : null;
    const creationFailure = creation ? JSON.parse(creation).creationFailure as string | undefined : undefined;
    const assessmentEvidence = attempt && saved && saved.turnId === attempt.completed_turn_id && report.success && report.data.status === 'failed'
      && registration?.modelRouting?.planHash === snapshot?.planHash && !samples.some(sample => sample.attemptId === attempt.id)
      ? { attemptId: attempt.id, reportRef: saved.operationId } : undefined;
    return {
      outcomes: samples.slice(0, 4),
      summary: summary.slice(0, 16),
      outcomeCount: samples.length,
      summaryCount: summary.length,
      unrated: samples.filter(sample => sample.result === 'unrated').length,
      ...(initialRecommendation ? { initialRecommendation } : {}),
      ...(nextAssignment ? { nextAssignment } : {}),
      ...(creationFailure ? { creationFailure } : {}),
      ...(assessmentEvidence ? { assessmentEvidence } : {})
    };
  }

  private modelOutcome(attempt: Attempt, details: Pick<ModelOutcome, 'result' | 'reason' | 'evidenceRefs' | 'integrationSha'>): ModelOutcome | undefined {
    const registration = JSON.parse(attempt.registration) as Registration;
    const routing = registration.modelRouting;
    if (!routing) return undefined;
    return {
      ...routing, ...details, result: routing.agent ? details.result : 'unrated',
      runId: this.runId, taskId: registration.taskId, attemptId: attempt.id, recordedAt: new Date().toISOString()
    };
  }

  private assessModelAttempt(taskId: string, planHash: string, assessment: ModelAssessment, evidenceRefs: string[], operationId: string): ModelOutcome {
    const attempt = this.latest(taskId);
    if (!attempt || attempt.id !== assessment.attemptId) throw new Error('model assessment requires current attempt');
    const routing = (JSON.parse(attempt.registration) as Registration).modelRouting;
    if (routing?.planHash !== planHash) throw new Error('model assessment requires the assigned plan version');
    if (this.store.hasModelOutcome(this.runId, attempt.id)) throw new Error('model attempt already evaluated');
    if (this.store.operationUnknown(this.runId) || this.store.wakeUnknown(this.runId) || this.store.pendingBlockingTaskIds(this.runId).has(taskId)
      || !attempt.stop_result || JSON.parse(attempt.stop_result).state !== 'stopped'
      || this.store.requests(this.runId).some(request => request.attempt_id === attempt.id && ['pending', 'unsupported', 'replied'].includes(String(request.state)))) {
      throw new Error('model assessment requires resolved delivery, requests and cleanup');
    }

    const { reason, checkName } = assessment;
    if (reason !== 'required_check_failed' && reason !== 'investigation_stalled') {
      return this.modelOutcome(attempt, { reason, result: 'excluded', evidenceRefs: [operationId] })!;
    }
    this.cleanCompletion(attempt.id);
    const saved = this.store.latestReport(this.runId, attempt.id);
    if (!saved || saved.turnId !== attempt.completed_turn_id || !evidenceRefs.includes(saved.operationId)) throw new Error('model assessment requires the completed turn report reference');
    const report = TaskReport.parse(saved.report);
    if (report.status !== 'failed') throw new Error('model assessment requires a failed report');
    if (reason === 'required_check_failed') {
      const matching = report.checks.filter(check => check.name === checkName);
      if (!checkName || !routing.requiredChecks.includes(checkName) || matching.length !== 1 || matching[0].result !== 'failed'
        || matching[0].exit_code === null || matching[0].exit_code === 0) throw new Error('model assessment requires an executed failed required check');
    }
    return this.modelOutcome(attempt, { reason, result: 'failed', evidenceRefs: [saved.operationId] })!;
  }

  async decide(args: { operationId: string; taskId: string; decision: string; candidateSha?: string; integrationSha?: string; checks?: unknown; sourceTaskId?: string; inputCandidateShas?: string[]; evidenceRefs?: string[]; modelAssessment?: ModelAssessment }, parentTurnId: string) {
    if (args.decision !== 'pause') this.assertCurrent(); const p = this.current(), task = p.snapshot.plan.tasks.find(t => t.id === args.taskId);
    const revision = this.store.run(this.runId).revision;
    const guard = () => { this.assertCurrent(); if (!this.canProceed() || this.store.run(this.runId).revision !== revision) throw new Error('run changed during verification'); };
    if (!task) throw new Error('unknown task');
    const states = this.store.planStates(this.runId), state = states[args.taskId];
    if (state?.hold && args.decision !== 'pause') throw new Error('held task requires consultation resume');
    let nextState: PlanTaskState | undefined, finish = false;
    const updates: Record<string, PlanTaskState> = {};
    const modelOutcomes: ModelOutcome[] = [];
    let modelSwitch: ModelSwitch | undefined;
    let routingBlocked: 'correction_limit' | 'candidate_limit' | 'no_next_candidate' | undefined;
    const pending = Object.values(states).some(s => s.pendingIntegration);
    if (['retry_same', 'continue_same', 'handoff_new'].includes(args.decision)) {
      if (pending || this.store.attempts(this.runId).some(a => (JSON.parse(a.registration) as Registration).taskId === args.taskId && !['completed', 'stopped'].includes(a.state))) throw new Error('attempt or integration still active');
      if (state?.integrationSha) throw new Error('integrated task is immutable');
      const source = args.sourceTaskId ?? args.taskId;
      if (source !== args.taskId && (!task.depends_on.includes(source) || states[source]?.state !== 'integrated')) throw new Error('history source must be integrated dependency');
      if (args.decision !== 'handoff_new') { const old = this.latest(source); if (!old) throw new Error('history source unavailable'); this.cleanCompletion(old.id); }
      const queued = state?.dispatch?.mode === 'new' ? state.dispatch.modelSwitch : undefined;
      const stopGeneration = this.store.run(this.runId).stop_generation;
      if (queued?.planHash === p.snapshot.planHash && queued.stopGeneration === stopGeneration) throw new Error('model switch already pending');
      if (args.modelAssessment) {
        if (source !== args.taskId || !['retry_same', 'handoff_new'].includes(args.decision)) throw new Error('model assessment requires a retry of the same task');
        const outcome = this.assessModelAttempt(args.taskId, p.snapshot.planHash, args.modelAssessment, args.evidenceRefs ?? [], args.operationId);
        modelOutcomes.push(outcome);
        const policy = p.snapshot.plan.schema_version === 2 ? p.snapshot.plan.run.worker_model_policy : undefined;
        if (policy && args.decision === 'handoff_new' && outcome.result === 'failed' && outcome.agent) {
          const agent = selectNextAgent(policy.candidates, outcome.agent);
          const limit = this.correctionLimit ? this.correctionLimit()
            : p.snapshot.plan.schema_version === 2 ? p.snapshot.plan.run.execution_limits?.maxCorrectionsPerTask ?? null : null;
          if (limit !== null && this.store.correctionCount(this.runId, args.taskId) >= limit) routingBlocked = 'correction_limit';
          else if (this.store.modelSwitchCount(this.runId, args.taskId) >= policy.candidates.length - 1) routingBlocked = 'candidate_limit';
          else if (!agent) routingBlocked = 'no_next_candidate';
          else {
            const registration: Registration = JSON.parse(this.latest(args.taskId)!.registration);
            const { assignment } = this.historyCheckpoint(registration.worker);
            modelSwitch = { agent, previousAttemptId: outcome.attemptId, sourceHead: assignment.baseSha, planHash: outcome.planHash,
              stopGeneration, reason: args.modelAssessment.reason, evidenceRefs: outcome.evidenceRefs };
          }
        }
      }
      nextState = routingBlocked ? { ...state, dispatch: undefined } : { ...state, state: 'pending',
        dispatch: args.decision === 'handoff_new' ? { mode: 'new', ...(modelSwitch ? { modelSwitch } : {}) } : { mode: 'same', after: source } };
    } else if (args.decision === 'accept_review') {
      if (pending || state?.integrationSha || state?.candidate || args.evidenceRefs?.length !== 1 || !args.integrationSha ||
          args.candidateSha !== undefined || args.checks !== undefined || args.inputCandidateShas !== undefined ||
          args.sourceTaskId !== undefined || args.modelAssessment !== undefined) throw new Error('accept_review requires only the report reference and reviewed SHA');
    } else if (args.decision === 'accept_candidate') {
      if (pending) throw new Error('integration inputs are fixed');
      if (state?.candidate?.saveRef) throw new Error('saved candidate already accepted');
      const candidate = await this.candidate(args.taskId,args);
      guard();
      if (candidate.candidateSha !== args.candidateSha || state?.integrationSha || (state?.candidate && state.candidate.candidateSha !== candidate.candidateSha)) throw new Error('candidate SHA mismatch or already integrated');
      nextState = { state: 'candidate_accepted', attemptId: this.latest(args.taskId)!.id, candidate, revisionPlanHash: state?.revisionPlanHash };
    } else if (args.decision === 'prepare_integration') {
      const inputs = args.inputCandidateShas;
      if (pending || !inputs?.length || inputs.length > 128 || new Set(inputs).size !== inputs.length || !state?.candidate || !inputs.includes(state.candidate.candidateSha)) throw new Error('invalid integration inputs');
      for (const sha of inputs) {
        const matches = Object.entries(states).filter(([, s]) => s.state === 'candidate_accepted' && s.candidate?.candidateSha === sha);
        if (matches.length !== 1 || (await this.candidate(matches[0][0])).candidateSha !== sha) throw new Error('fixed candidate changed');
        guard();
      }
      for (const s of Object.values(states).filter(s => s.state === 'candidate_accepted' && s.candidate && inputs.includes(s.candidate.candidateSha))) this.git().assertCandidateHead(this.store.gitAssignment(s.attemptId!)!, s.candidate!.candidateSha);
      const baseSha = this.git().integrationBase(this.integrations());
      nextState = { ...state, pendingIntegration: { baseSha, inputCandidateShas: inputs } };
    } else if (args.decision === 'record_integration_checks') {
      const prepared = state?.pendingIntegration;
      if (!prepared || !args.integrationSha || !Array.isArray(args.checks) || !args.checks.length) throw new Error('prepared integration and check batch required');
      if (prepared.checkedSha && prepared.checkedSha !== args.integrationSha) throw new Error('integration check SHA is fixed; cancel and prepare again');
      const verified = this.git().verifyIntegration(state.candidate!.candidateSha, args.integrationSha, Checks.parse(args.checks), [], [...this.integrations(), ...prepared.inputCandidateShas, prepared.baseSha], true);
      const checks = [...(prepared.checks ?? []), ...verified.checks];
      if (checks.length > 4097 || new Set(checks.map(check => check.name)).size !== checks.length) throw new Error('too many or duplicate integration checks');
      nextState = { ...state, pendingIntegration: { ...prepared, checkedSha: args.integrationSha, checks } };
    } else if (args.decision === 'cancel_integration') {
      if (!state?.pendingIntegration) throw new Error('no prepared integration');
      const { pendingIntegration: _pending, ...rest } = state;
      nextState = rest; // Release only the reservation; preserve all Git work for the parent.
    } else if (args.decision === 'accept_integration') {
      if (state?.state !== 'candidate_accepted' || !state.candidate || !args.integrationSha) throw new Error('candidate not accepted');
      const candidate = await this.candidate(args.taskId);
      guard();
      if (candidate.candidateSha !== state.candidate.candidateSha) throw new Error('fixed candidate changed');
      const parallel = p.snapshot.plan.run.max_parallel > 1 || (state.pendingIntegration?.inputCandidateShas.length ?? 1) > 1;
      if (parallel && !state.pendingIntegration) throw new Error('prepare integration before merging');
      const inputs = state.pendingIntegration?.inputCandidateShas ?? [candidate.candidateSha];
      const selected = Object.entries(states).filter(([, s]) => s.state === 'candidate_accepted' && s.candidate && inputs.includes(s.candidate.candidateSha));
      if (selected.length !== inputs.length) throw new Error('integration inputs changed');
      for (const [id, s] of selected) {
        if ((await this.candidate(id)).candidateSha !== s.candidate!.candidateSha) throw new Error('fixed candidate changed');
        guard();
      }
      // No async gap after this pass: later remote reads may have overlapped an edit
      // to an earlier candidate. Recheck every local pin before accepting any task.
      for (const [, s] of selected) this.git().assertCandidateHead(this.store.gitAssignment(s.attemptId!)!, s.candidate!.candidateSha);
      const required = [...new Set(p.snapshot.plan.tasks.filter(t => selected.some(([id]) => id === t.id) || states[t.id]?.state === 'integrated').flatMap(t => t.completion).concat(parallel ? ['integration'] : []))];
      if (state.pendingIntegration?.checkedSha && state.pendingIntegration.checkedSha !== args.integrationSha) throw new Error('integration check SHA is fixed');
      const checks = state.pendingIntegration?.checks ? [...state.pendingIntegration.checks, ...(Array.isArray(args.checks) ? args.checks : [])] : args.checks;
      const evidence = this.git().verifyIntegration(candidate.candidateSha, args.integrationSha, checks, required, [...this.integrations(), ...inputs, ...(state.pendingIntegration ? [state.pendingIntegration.baseSha] : [])], parallel);
      const priorReviewChecks = p.snapshot.plan.tasks.filter(t => {
        const review = states[t.id]?.reviewEvidence;
        return review && review.reviewedSha !== evidence.integrationSha;
      }).flatMap(t => t.completion);
      if (priorReviewChecks.some(name => !evidence.checks.some(check => check.name === name && check.checked_sha === evidence.integrationSha &&
          check.command.trim() && check.evidence_refs.every(ref => ref.trim())))) throw new Error('prior review checks must target the new integration SHA');
      const integrationEvidence = { inputCandidateShas: inputs, resultSha: evidence.integrationSha, checks: evidence.checks, acceptedByParentTurnId: parentTurnId };
      const deliveryUnresolved = this.store.operationUnknown(this.runId) || this.store.wakeUnknown(this.runId);
      const checksAtFinalSha = new Set(evidence.checks.filter(check => check.checked_sha === evidence.integrationSha).map(check => check.name));
      for (const [id, s] of selected) {
        const { pendingIntegration: _pending, ...rest } = s;
        updates[id] = { ...rest, state: 'integrated', ...evidence, integrationEvidence };
        if (deliveryUnresolved) continue;
        const attempt = this.latest(id)!;
        const outcome = this.modelOutcome(attempt, { result: 'accepted', reason: 'integrated', evidenceRefs: [args.operationId], integrationSha: evidence.integrationSha });
        if (outcome?.planHash !== p.snapshot.planHash || this.store.hasModelOutcome(this.runId, attempt.id)) continue;
        modelOutcomes.push(outcome.requiredChecks.every(name => checksAtFinalSha.has(name))
          ? outcome : { ...outcome, result: 'unrated', reason: 'integration_evidence_unconfirmed' });
      }
    } else if (args.decision === 'finish') {
      if (p.snapshot.plan.tasks.some(t => states[t.id]?.state !== 'integrated') || this.store.attempts(this.runId).some(a => !['completed', 'stopped'].includes(a.state))) throw new Error('run is not fully integrated');
      if (Object.values(states).some(s => s.reviewEvidence)) this.git().integrationBase(this.integrations());
      finish = true;
    } else if (args.decision !== 'pause') throw new Error('unsupported plan decision');
    const result = { state: 'decision_recorded', decision: args.decision, acceptedByParentTurnId: parentTurnId, ...(modelSwitch ? { modelSwitch } : {}), ...(routingBlocked ? { routingBlocked } : {}) };
    this.store.transaction(() => {
      if (args.decision === 'accept_review') {
        const review = this.review(args.taskId);
        guard();
        if (review.reportRef !== args.evidenceRefs![0] || review.reviewedSha !== args.integrationSha) throw new Error('review reference or reviewed SHA changed');
        nextState = { ...state, state: 'integrated', integrationSha: review.reviewedSha, reviewEvidence: { ...review, acceptedByParentTurnId: parentTurnId } };
        const attempt = this.latest(args.taskId)!;
        const outcome = this.modelOutcome(attempt, { result: 'accepted', reason: 'review_accepted', evidenceRefs: [review.reportRef, args.operationId], integrationSha: review.reviewedSha });
        if (outcome?.planHash === p.snapshot.planHash && !this.store.hasModelOutcome(this.runId, attempt.id)) modelOutcomes.push(outcome);
      }
      if (nextState) this.store.savePlanState(this.runId, args.taskId, nextState);
      for (const [id, value] of Object.entries(updates)) this.store.savePlanState(this.runId, id, value);
      if (finish) this.store.finishRun(this.runId);
      this.store.saveDecision(args.operationId, this.runId, args.taskId, parentTurnId, { ...args, ...(modelOutcomes.length ? { modelOutcomes } : {}),
        ...(modelSwitch ? { modelSwitch } : {}), ...(routingBlocked ? { routingBlocked } : {}) });
      this.store.operationResult(args.operationId, 'settled', result);
    });
    return result;
  }
  async project(expectedFileHash: string): Promise<void> {
    const p = this.current();
    if (p.snapshot.documentHash === undefined && p.observed && !p.frozen) this.store.savePlan(this.runId, p.observed, p.pin);
    const status = await this.status();
    await writeProgress(p.snapshot.path, expectedFileHash, p.snapshot.plan.tasks.map(t => {
      const s = status.tasks[t.id];
      return [t.id + ':', s?.state ?? 'pending', s?.integrationSha ?? s?.reviewedSha, s?.reportRef].filter(Boolean).join(' ');
    }).join('\n'));
  }
}
export type Command = { kind: 'send'; ref: OperationRef; worker: WorkerRef; text: string; agent?: { model: string; effort: string } };
// Only the trusted local coordinator calls this API. CC-02 adds native/MCP caller correlation;
// no role or parent identity supplied by a model is accepted at the local control endpoint.
export class Broker {
  private stoppingRuns = new Set<string>();
  private survivingTurns = new Map<string, Set<string>>();
  private parking = new Map<string, Promise<StopResult>>();
  private stops = new Map<string, Promise<StopResult>>();
  private retiring = new Set<string>();
  private configuredLimits: ExecutionLimits;
  constructor(readonly store: Store, private readonly runtime: Runtime, private readonly fence?: (blocked: boolean) => Promise<unknown>, limits: Partial<ExecutionLimits> = {}) { this.configuredLimits = ExecutionLimits.parse(limits); }
  executionLimits(runId: string): ExecutionLimits {
    const plan = this.store.plan(runId)?.snapshot.plan;
    const planned = plan?.schema_version === 2 ? plan.run.execution_limits : undefined;
    const minimum = (a: number | null, b?: number | null) => a === null ? b ?? null : b == null ? a : Math.min(a, b);
    return { maxWakeTurns: minimum(this.configuredLimits.maxWakeTurns, planned?.maxWakeTurns), maxCorrectionsPerTask: minimum(this.configuredLimits.maxCorrectionsPerTask, planned?.maxCorrectionsPerTask) };
  }
  private attempt(runId: string, worker: WorkerRef) {
    Worker.parse(worker);
    const row = this.store.attempts(runId).find(a => a.id === worker.attemptId);
    if (!row || !sameWorker((JSON.parse(row.registration) as Registration).worker, worker)) throw new Error('stale worker binding');
    return row;
  }
  async dispatch(command: Command): Promise<{ state: string; deliveryFailure?: 'agent_not_in_catalog' }> {
    const worker = Worker.parse(command.worker);
    if (command.kind !== 'send' || typeof command.text !== 'string' || !command.text.length || Buffer.byteLength(command.text) > 65536) throw new Error('invalid instruction');
    const row = this.attempt(command.ref.runId, worker), reg = JSON.parse(row.registration) as Registration;
    const state = this.store.planStates(command.ref.runId)[reg.taskId];
    const payloadHash = createHash('sha256').update(JSON.stringify({ kind: command.kind, worker, text: command.text, agent: command.agent })).digest('hex');
    // Inspect duplicates before the active gate: a retry can read its recorded unknown result.
    let previous;
    try { previous = this.store.operation(command.ref.operationId); } catch { /* new operation */ }
    if (!previous && (state?.hold || this.retiring.has(row.id) || this.store.pendingBlockingTaskIds(command.ref.runId).has(reg.taskId) || ['stopping', 'completed', 'stopped', 'unknown'].includes(row.state))) throw new Error('held or stale worker cannot receive instructions');
    if (!previous && !this.canWake(command.ref.runId)) throw new Error('run is stopped');
    if (!previous) {
      const snapshot = this.store.plan(command.ref.runId)?.snapshot;
      const plan = snapshot?.plan;
      if (state?.reviewPlanHash && (state.reviewPlanHash !== snapshot?.planHash || state.attemptId !== row.id || state.state !== 'assigned')) throw new Error('review assignment requires the current plan');
      const adaptive = plan?.schema_version === 2 && plan.run.worker_model_policy && plan.tasks.find(task => task.id === reg.taskId)?.model_routing;
      if (adaptive) {
        const routing = reg.modelRouting;
        if (!routing || routing.planHash !== snapshot?.planHash || state?.attemptId !== row.id
          || routing.modelSwitch && (!routing.agent || !sameAgentChoice(routing.agent, routing.modelSwitch.agent)
            || routing.modelSwitch.stopGeneration !== this.store.run(command.ref.runId).stop_generation)
          || !command.agent || !sameAgentChoice(command.agent, reg)
          || this.store.operationUnknown(command.ref.runId) || this.store.wakeUnknown(command.ref.runId)
          || this.store.requests(command.ref.runId).some(request => request.attempt_id === row.id && ['pending', 'unsupported', 'replied'].includes(String(request.state)))) {
          throw new Error('model routing assignment or delivery needs reconciliation');
        }
      }
    }
    let text = command.text;
    const coordinatorSave = this.store.coordinatorSave(command.ref.runId);
    if (!previous && (state?.revisionPlanHash || state?.reviewPlanHash || coordinatorSave)) {
      const task = this.store.plan(command.ref.runId)?.snapshot.plan.tasks.find(task => task.id === reg.taskId);
      if (state?.attemptId !== row.id || !task) throw new Error('revised task assignment mismatch');
      const instructions = [];
      if (state.revisionPlanHash) instructions.push(`承認済み工程表の改訂: ${state.revisionPlanHash}`);
      if (state.reviewPlanHash || coordinatorSave) {
        const assignment = this.store.gitAssignment(row.id);
        if (!assignment) throw new Error('read-only assignment unavailable');
        const reportFields = { task_id: task.id, worker_id: worker.workerId, attempt_id: worker.attemptId, actor_id: worker.threadId,
          base_sha: assignment.baseSha, candidate_sha: null, branch: assignment.branch,
          push_result: { status: 'not_attempted', remote: 'origin', branch: assignment.branch } };
        instructions.push(state.reviewPlanHash ? '読み取り専用の担当です。base_sha の内容を調べ、以下の割当情報を使って report を提出してください。' :
          '担当範囲を編集し、作業ツリー上で必須検証を実行して report を提出してください。コミットと push は報告後に Coordinator が行います。',
          JSON.stringify(reportFields), state.reviewPlanHash ?
          'summary に結論を書き、各必須検証の command、result、exit_code、checked_sha、evidence_refs を示してください。未確認や不合格の項目はそのまま報告してください。' :
          '各必須検証の command、result、exit_code、evidence_refs を記録してください。');
      }
      instructions.push('以下の依存関係と必須検証を今回の指示に適用してください。', JSON.stringify({ id: task.id, depends_on: task.depends_on, completion: task.completion }));
      text = instructions.join('\n') + '\n\n' + text;
      if (Buffer.byteLength(text) > 65536) throw new Error('plan instruction exceeds byte limit');
    }
    const prepared = this.store.prepareOperation(command.ref, payloadHash);
    if (!prepared.fresh) {
      const saved = prepared.operation.result;
      const absentFromCatalog = reg.modelRouting?.modelSwitch && saved && JSON.parse(saved).deliveryFailure === 'agent_not_in_catalog';
      return { state: prepared.operation.state, ...(absentFromCatalog ? { deliveryFailure: 'agent_not_in_catalog' } : {}) };
    }
    this.store.operationState(command.ref.operationId, 'sent_unknown');
    this.store.attemptState(worker, 'running');
    try {
      const fallback = await this.runtime.send(worker, text, command.agent);
      this.store.transaction(() => {
        const applied = fallback ? reg.modelRouting?.initialRecommendation?.planned : command.agent;
        if (fallback && !applied) throw new Error('initial model fallback was not reserved');
        if (applied) this.store.updateAgent(worker, applied, fallback || undefined);
        this.store.operationState(command.ref.operationId, 'acked');
        if (state?.reviewPlanHash) {
          const current = this.store.planStates(command.ref.runId)[reg.taskId];
          if (current?.attemptId === row.id && current.reviewPlanHash === state.reviewPlanHash) this.store.savePlanState(command.ref.runId, reg.taskId, { ...current, reviewInstructionId: command.ref.operationId });
        }
      });
      return { state: 'acked' };
    } catch (error) {
      if (error instanceof RequestFailure) {
        const state = error.delivery === 'rejected' ? 'settled' : 'cancelled';
        const deliveryFailure = reg.modelRouting?.modelSwitch && error.delivery === 'not_sent' && error.reason === 'agent_not_in_catalog'
          ? 'agent_not_in_catalog' as const : undefined;
        const result = { state, ...(deliveryFailure ? { deliveryFailure } : {}) };
        if (deliveryFailure) this.store.operationResult(command.ref.operationId, state, result);
        else this.store.operationState(command.ref.operationId, state);
        await this.stopRun(command.ref.runId, error.kind);
        this.store.appendEvent({ runId: command.ref.runId, attemptId: worker.attemptId, kind: error.kind });
        return result;
      }
      await this.stopRun(command.ref.runId, 'delivery_unknown');
      this.store.appendEvent({ runId: command.ref.runId, attemptId: worker.attemptId, kind: 'unknown' });
      return { state: 'sent_unknown' };
    }
  }
  canWake(runId: string): boolean { return !this.stoppingRuns.has(runId) && this.store.run(runId).state === 'active'; }
  canReviewRequest(runId: string, request: HumanRequest): boolean {
    if (this.canWake(runId)) return true;
    // Only the sibling's existing turn may finish its local report/status consent.
    return this.store.run(runId).state === 'stopped' && request.kind === 'elicitation' && request.state === 'pending' && this.survivingTurns.get(runId)?.has(request.worker.attemptId) === true
      && ['running', 'waiting_input', 'waiting_approval'].includes(this.attempt(runId, request.worker).state);
  }
  private async block(runId: string, reconcile = false): Promise<void> {
    this.stoppingRuns.add(runId);
    // Linearize against the parent's single writer before committing the stopped generation.
    // Transport failure remains fail-closed in the relay and never authorizes a new wake.
    try { await this.fence?.(true); } catch { reconcile = true; }
    this.store.stopRun(runId, reconcile);
  }
  async resumeRun(runId: string): Promise<void> {
    this.store.resumeRun(runId);
    this.survivingTurns.delete(runId);
    try { await this.fence?.(false); this.stoppingRuns.delete(runId); }
    catch { this.store.stopRun(runId, true); throw new Error('parent wake fence needs reconciliation'); }
  }
  async closeTerminal(runId: string, binding: TerminalBinding): Promise<StopResult | undefined> {
    Binding.parse(binding);
    const row = this.attempt(runId, binding.worker), reg = JSON.parse(row.registration) as Registration;
    if (reg.binding.terminalId !== binding.terminalId || reg.binding.windowBindingId !== binding.windowBindingId) throw new Error('stale terminal binding');
    if (row.state === 'completed' || row.state === 'stopped') return row.stop_result ? JSON.parse(row.stop_result) as StopResult : undefined;
    if (this.canWake(runId)) this.survivingTurns.set(runId, new Set(this.store.attempts(runId).filter(a => a.id !== row.id && ['running', 'waiting_input', 'waiting_approval'].includes(a.state)).map(a => a.id)));
    else this.survivingTurns.get(runId)?.delete(row.id);
    await this.block(runId);
    return this.stopOne(runId, binding.worker, 'terminal_closed');
  }
  private async stopOne(runId: string, worker: WorkerRef, reason: string): Promise<StopResult> {
    this.attempt(runId, worker);
    const existing = this.stops.get(worker.attemptId); if (existing) return existing;
    const stopping = (async () => {
      let result: StopResult;
      try { result = await this.runtime.stop(worker, reason); }
      catch { result = { worker, state: 'unknown', evidenceRefs: ['stop_unconfirmed'] }; }
      if (!sameWorker(result.worker, worker)) result = { worker, state: 'unknown', evidenceRefs: ['identity_mismatch'] };
      this.store.saveStop(runId, result); return result;
    })();
    this.stops.set(worker.attemptId, stopping); return stopping;
  }
  async retireWorker(runId: string, worker: WorkerRef): Promise<StopResult> {
    const row = this.attempt(runId, worker), taskId = (JSON.parse(row.registration) as Registration).taskId;
    if (['completed', 'stopped'].includes(row.state) && row.stop_result) return JSON.parse(row.stop_result) as StopResult;
    this.retiring.add(row.id);
    this.store.attemptState(worker, 'stopping');
    const result = await this.stopOne(runId, worker, 'worker_retired');
    if (result.state !== 'stopped') await this.stopRun(runId, 'cleanup_unknown');
    const state = this.store.planStates(runId)[taskId];
    if (state?.attemptId === row.id && !state.hold && !state.integrationSha && !state.pendingIntegration) this.store.savePlanState(runId, taskId, { ...state, state: result.state === 'stopped' ? 'retired' : 'unknown' });
    return result;
  }
  async parkTask(runId: string, worker: WorkerRef): Promise<StopResult> {
    const row = this.attempt(runId, worker), taskId = (JSON.parse(row.registration) as Registration).taskId;
    const state = this.store.planStates(runId)[taskId];
    if (state?.state !== 'held' || state.attemptId !== row.id || !state.hold) throw new Error('current held attempt required');
    const existing = this.parking.get(row.id); if (existing) return existing;
    const parking = (async () => {
      const result = ['completed', 'stopped'].includes(row.state) && row.stop_result ? JSON.parse(row.stop_result) as StopResult : await this.stopOne(runId, worker, 'task_hold');
      if (result.state !== 'stopped') await this.stopRun(runId, 'cleanup_unknown');
      if (result.state === 'stopped' && sameWorker(result.worker, worker)) this.store.transaction(() => {
        const current = this.store.planStates(runId)[taskId];
        if (current?.state !== 'held' || current.attemptId !== row.id || !current.hold) throw new Error('parked attempt changed');
        this.store.savePlanState(runId, taskId, { ...current, hold: { ...current.hold, releasedExecutionSlot: true } });
        for (const hold of this.store.taskHolds(runId, taskId)) {
          if (this.store.coordinationDecision(runId, hold.decisionId)?.decision.state !== 'superseded') this.store.saveTaskHold(runId, { ...hold, releasedExecutionSlot: true });
        }
      });
      return result;
    })();
    this.parking.set(row.id, parking); return parking;
  }
  async stopRun(runId: string, reason = 'manual_stop'): Promise<StopResult[]> {
    this.survivingTurns.delete(runId);
    await this.block(runId, reason === 'lease_lost');
    return Promise.all(this.store.attempts(runId).filter(a => !['completed', 'stopped'].includes(a.state)).map(a => this.stopOne(runId, (JSON.parse(a.registration) as Registration).worker, reason)));
  }
  leaseLost(runId: string): Promise<StopResult[]> { return this.stopRun(runId, 'lease_lost'); }
  report(runId: string, worker: WorkerRef): void {
    const row = this.attempt(runId, worker);
    this.store.appendEvent({ runId, attemptId: worker.attemptId, kind: row.state === 'running' ? 'report_saved' : 'late_report' });
  }
  async releaseCompleted(runId: string, worker: WorkerRef): Promise<StopResult> {
    this.attempt(runId, worker);
    if (this.retiring.has(worker.attemptId)) return this.stopOne(runId, worker, 'worker_retired');
    let result: StopResult;
    try { result = await this.runtime.releaseCompleted(worker); }
    catch { result = { worker, state: 'unknown', evidenceRefs: ['cleanup_unconfirmed'] }; }
    if (!sameWorker(result.worker, worker)) result = { worker, state: 'unknown', evidenceRefs: ['identity_mismatch'] };
    if (result.state !== 'stopped') await this.stopRun(runId, 'cleanup_unknown');
    this.store.saveStop(runId, result, !this.retiring.has(worker.attemptId)); return result;
  }
}
