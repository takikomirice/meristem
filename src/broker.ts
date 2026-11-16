import { createHash } from 'node:crypto';
import { Binding, sameWorker, Worker } from './contracts.js';
import type { OperationRef, Registration, StopResult, TerminalBinding, WorkerRef } from './contracts.js';
import { Store, type PlanTaskState } from './store.js';
import { RequestFailure } from './failures.js';
import { readPlan, eligibleTasks, writeProgress, type PlanSnapshot } from './plan.js';
import { GitEvidence, pinRepository, TaskReport, type GitAssignment } from './git-evidence.js';
import { realpathSync } from 'node:fs';
import type { HumanRequest } from './requests.js';

export interface Runtime {
  send(worker: WorkerRef, text: string, agent?: { model: string; effort: string }): Promise<void>;
  stop(worker: WorkerRef, reason: string): Promise<StopResult>;
  releaseCompleted(worker: WorkerRef): Promise<StopResult>;
}

// Mechanical plan/Git gates only. The parent chooses work, performs merges and runs checks.
export class PlanControl {
  constructor(private store: Store, private runId: string, private canProceed = () => store.run(runId).state === 'active') {}
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
    if (observed?.planHash !== record.snapshot.planHash) this.store.freezePlan(this.runId);
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
    return states;
  }
  private cleanCompletion(attemptId: string): void {
    const row = this.store.attempts(this.runId).find(a => a.id === attemptId);
    if (!row || row.state !== 'completed' || !row.completed_turn_id || !row.stop_result || JSON.parse(row.stop_result).state !== 'stopped' || this.store.requests(this.runId).some(r => r.attempt_id === attemptId && ['pending', 'unsupported', 'replied'].includes(String(r.state)))) throw new Error('attempt cleanup, turn or requests unresolved');
  }
  reserveAssignment(taskId: string, attemptId: string): { assignment: GitAssignment; previous?: WorkerRef; agent: { model: string; effort: string }; workerId: string } {
    this.assertCurrent();
    // Single writer: reserve slots/resources and persist the assignment before runtime I/O.
    return this.store.transaction(() => this.allocate(taskId, attemptId));
  }
  private allocate(taskId: string, attemptId: string) {
    this.assertCurrent(); const p = this.current(), task = p.snapshot.plan.tasks.find(t => t.id === taskId), states = this.store.planStates(this.runId);
    if (!task) throw new Error('unknown task');
    if (!this.canProceed() || this.store.attempts(this.runId).some(a => a.state === 'unknown') || Object.values(states).some(s => s.pendingIntegration)) throw new Error('dispatch or cleanup unresolved');
    if (!eligibleTasks(p.snapshot, this.assignmentStates()).includes(taskId)) throw new Error('assignment slots, dependencies or resources unavailable');
    if (states[taskId]?.integrationSha || task.depends_on.some(d => states[d]?.state !== 'integrated')) throw new Error('task dependencies not integrated');
    const previous = this.latest(taskId), dispatch = states[taskId]?.dispatch ?? (task.continuation.mode === 'same' ? { mode: 'same' as const, after: task.continuation.after } : task.continuation.mode === 'new' ? { mode: 'new' as const } : undefined);
    if (!dispatch || (previous && !states[taskId]?.dispatch)) throw new Error('parent continuation decision required');
    const git = this.git();
    if (!p.initialized) { git.initialize(); this.store.initializePlan(this.runId); }
    git.integrationBase(this.integrations());
    let assignment: GitAssignment, source: WorkerRef | undefined;
    if (dispatch.mode === 'same') {
      const old = this.latest(dispatch.after ?? taskId); if (!old) throw new Error('history source unavailable');
      this.cleanCompletion(old.id); const reg = JSON.parse(old.registration) as Registration, managed = this.store.gitAssignment(old.id);
      if (!managed || reg.cwd !== managed.cwd || reg.branch !== managed.branch) throw new Error('history cwd changed');
      if (this.store.attempts().some(a => !['completed', 'stopped'].includes(a.state) && (a.cwd.toLowerCase() === managed.cwd.toLowerCase() || (JSON.parse(a.registration) as Registration).worker.workerId === reg.worker.workerId))) throw new Error('history worktree or worker is already reserved');
      const report = this.store.latestReport(this.runId, old.id);
      const required = report ? TaskReport.parse(report.report).candidate_sha : null;
      const reused = git.reuseWorktree(managed, [...this.integrations(), ...(required ? [required] : [])], managed.taskId !== taskId);
      assignment = { ...reused, taskId, attemptId }; source = reg.worker;
    } else assignment = git.createWorktree(taskId, attemptId, this.integrations());
    this.store.saveGitAssignment(this.runId, assignment);
    this.store.savePlanState(this.runId, taskId, { state: 'assigned', attemptId });
    return { assignment, previous: source, agent: task.agent, workerId: source?.workerId ?? taskId };
  }
  validateReport(taskId: string, worker: WorkerRef, input: unknown): void {
    const report = TaskReport.parse(input), assignment = this.store.gitAssignment(worker.attemptId);
    if (!assignment || report.task_id !== taskId || report.worker_id !== worker.workerId || report.attempt_id !== worker.attemptId || report.actor_id !== worker.threadId || assignment.taskId !== taskId || assignment.baseSha !== report.base_sha || assignment.branch !== report.branch || (report.question && report.status !== 'needs_input')) throw new Error('report metadata or assignment mismatch');
  }
  async candidate(taskId: string) {
    const row = this.latest(taskId); if (!row) throw new Error('no candidate attempt'); this.cleanCompletion(row.id);
    const report = this.store.latestReport(this.runId, row.id), assignment = this.store.gitAssignment(row.id);
    if (!report || !assignment || report.turnId !== row.completed_turn_id) throw new Error('report does not match completed turn');
    return this.git().verifyCandidate(taskId, report.report, assignment);
  }
  async status() {
    const p = this.current(), states = this.store.planStates(this.runId);
    for (const [taskId, state] of Object.entries(states)) {
      if (state.integrationSha || state.dispatch) continue;
      const attempt = this.latest(taskId);
      if (attempt && !['completed', 'stopped'].includes(attempt.state)) { states[taskId] = { ...state, state: attempt.state }; continue; }
      try {
        const candidate = await this.candidate(taskId);
        if (state.candidate && state.candidate.candidateSha !== candidate.candidateSha) throw new Error('fixed candidate changed');
        states[taskId] = { ...state, state: state.state === 'candidate_accepted' ? state.state : 'candidate_ready', candidate };
      } catch { states[taskId] = { ...state, state: 'awaiting_evidence' }; }
    }
    const summary = Object.fromEntries(Object.entries(states).map(([id, s]) => [id, { state: s.state, attemptId: s.attemptId, candidateSha: s.candidate?.candidateSha, integrationSha: s.integrationSha }]));
    const blocked = p.frozen || !this.canProceed() || Object.values(states).some(s => s.pendingIntegration || s.state === 'unknown');
    return { planHash: p.snapshot.planHash, observedPlanHash: p.observed?.planHash, fileHash: p.observed?.fileHash, frozen: p.frozen, tasks: summary, eligible: blocked ? [] : eligibleTasks(p.snapshot, this.assignmentStates()), integrationCwd: p.pin.integrationCwd };
  }
  reconcile(expectedFileHash: string, expectedPlanHash: string): void {
    const p = this.current(), next = p.observed;
    if (!next || next.fileHash !== expectedFileHash || next.planHash !== expectedPlanHash) throw new Error('plan changed during reconciliation');
    if (JSON.stringify(next.plan.run) !== JSON.stringify(p.snapshot.plan.run) || next.plan.tasks.length !== p.snapshot.plan.tasks.length) throw new Error('new run permit required for scope expansion');
    const states = this.store.planStates(this.runId);
    for (const old of p.snapshot.plan.tasks) {
      const replacement = next.plan.tasks.find(t => t.id === old.id); if (!replacement) throw new Error('task removal requires new run');
      const comparable = (t: typeof old) => states[t.id] ? t : { ...t, depends_on: [], completion: [] };
      if (JSON.stringify(comparable(old)) !== JSON.stringify(comparable(replacement))) throw new Error('assigned task or permitted scope changed');
    }
    this.git().assertRepository(); this.store.savePlan(this.runId, next, p.pin);
  }
  async decide(args: { operationId: string; taskId: string; decision: string; candidateSha?: string; integrationSha?: string; checks?: unknown; sourceTaskId?: string; inputCandidateShas?: string[] }, parentTurnId: string) {
    if (args.decision !== 'pause') this.assertCurrent(); const p = this.current(), task = p.snapshot.plan.tasks.find(t => t.id === args.taskId);
    const revision = this.store.run(this.runId).revision;
    const guard = () => { this.assertCurrent(); if (!this.canProceed() || this.store.run(this.runId).revision !== revision) throw new Error('run changed during verification'); };
    if (!task) throw new Error('unknown task');
    const states = this.store.planStates(this.runId), state = states[args.taskId];
    let nextState: PlanTaskState | undefined, finish = false;
    const updates: Record<string, PlanTaskState> = {};
    const pending = Object.values(states).some(s => s.pendingIntegration);
    if (['retry_same', 'continue_same', 'handoff_new'].includes(args.decision)) {
      if (pending || this.store.attempts(this.runId).some(a => (JSON.parse(a.registration) as Registration).taskId === args.taskId && !['completed', 'stopped'].includes(a.state))) throw new Error('attempt or integration still active');
      if (state?.integrationSha) throw new Error('integrated task is immutable');
      const source = args.sourceTaskId ?? args.taskId;
      if (source !== args.taskId && (!task.depends_on.includes(source) || states[source]?.state !== 'integrated')) throw new Error('history source must be integrated dependency');
      if (args.decision !== 'handoff_new') { const old = this.latest(source); if (!old) throw new Error('history source unavailable'); this.cleanCompletion(old.id); }
      nextState = { ...state, state: 'pending', dispatch: { mode: args.decision === 'handoff_new' ? 'new' : 'same', ...(args.decision === 'handoff_new' ? {} : { after: source }) } };
    } else if (args.decision === 'accept_candidate') {
      if (pending) throw new Error('integration inputs are fixed');
      const candidate = await this.candidate(args.taskId);
      guard();
      if (candidate.candidateSha !== args.candidateSha || state?.integrationSha || (state?.candidate && state.candidate.candidateSha !== candidate.candidateSha)) throw new Error('candidate SHA mismatch or already integrated');
      nextState = { state: 'candidate_accepted', attemptId: this.latest(args.taskId)!.id, candidate };
    } else if (args.decision === 'prepare_integration') {
      const inputs = args.inputCandidateShas;
      if (pending || !inputs?.length || new Set(inputs).size !== inputs.length || !state?.candidate || !inputs.includes(state.candidate.candidateSha)) throw new Error('invalid integration inputs');
      for (const sha of inputs) {
        const matches = Object.entries(states).filter(([, s]) => s.state === 'candidate_accepted' && s.candidate?.candidateSha === sha);
        if (matches.length !== 1 || (await this.candidate(matches[0][0])).candidateSha !== sha) throw new Error('fixed candidate changed');
        guard();
      }
      for (const s of Object.values(states).filter(s => s.state === 'candidate_accepted' && s.candidate && inputs.includes(s.candidate.candidateSha))) this.git().assertCandidateHead(this.store.gitAssignment(s.attemptId!)!, s.candidate!.candidateSha);
      const baseSha = this.git().integrationBase(this.integrations());
      nextState = { ...state, pendingIntegration: { baseSha, inputCandidateShas: inputs } };
    } else if (args.decision === 'cancel_integration') {
      if (!state?.pendingIntegration) throw new Error('no prepared integration');
      const { pendingIntegration: _pending, ...rest } = state;
      nextState = rest; // Release only the reservation; preserve all Git work for the parent.
    } else if (args.decision === 'accept_integration') {
      if (state?.state !== 'candidate_accepted' || !state.candidate || !args.integrationSha) throw new Error('candidate not accepted');
      const candidate = await this.candidate(args.taskId);
      guard();
      if (candidate.candidateSha !== state.candidate.candidateSha) throw new Error('fixed candidate changed');
      const parallel = p.snapshot.plan.run.max_parallel === 2;
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
      const evidence = this.git().verifyIntegration(candidate.candidateSha, args.integrationSha, args.checks, required, [...this.integrations(), ...inputs, ...(state.pendingIntegration ? [state.pendingIntegration.baseSha] : [])], parallel);
      const integrationEvidence = { inputCandidateShas: inputs, resultSha: evidence.integrationSha, checks: evidence.checks, acceptedByParentTurnId: parentTurnId };
      for (const [id, s] of selected) { const { pendingIntegration: _pending, ...rest } = s; updates[id] = { ...rest, state: 'integrated', ...evidence, integrationEvidence }; }
    } else if (args.decision === 'finish') {
      if (p.snapshot.plan.tasks.some(t => states[t.id]?.state !== 'integrated') || this.store.attempts(this.runId).some(a => !['completed', 'stopped'].includes(a.state))) throw new Error('run is not fully integrated');
      finish = true;
    } else if (args.decision !== 'pause') throw new Error('unsupported plan decision');
    const result = { state: 'decision_recorded', decision: args.decision, acceptedByParentTurnId: parentTurnId };
    this.store.transaction(() => {
      if (nextState) this.store.savePlanState(this.runId, args.taskId, nextState);
      for (const [id, value] of Object.entries(updates)) this.store.savePlanState(this.runId, id, value);
      if (finish) this.store.finishRun(this.runId);
      this.store.saveDecision(args.operationId, this.runId, args.taskId, parentTurnId, args);
      this.store.operationResult(args.operationId, 'settled', result);
    });
    return result;
  }
  async project(expectedFileHash: string): Promise<void> {
    const p = this.current(), status = await this.status();
    await writeProgress(p.snapshot.path, expectedFileHash, p.snapshot.plan.tasks.map(t => `${t.id}: ${status.tasks[t.id]?.state ?? 'pending'}${status.tasks[t.id]?.integrationSha ? ' ' + status.tasks[t.id].integrationSha : ''}`).join('\n'));
  }
}
export type Command = { kind: 'send'; ref: OperationRef; worker: WorkerRef; text: string; agent?: { model: string; effort: string } };
// Only the trusted local coordinator calls this API. CC-02 adds native/MCP caller correlation;
// no role or parent identity supplied by a model is accepted at the local control endpoint.
export class Broker {
  private stoppingRuns = new Set<string>();
  private survivingTurns = new Map<string, Set<string>>();
  constructor(readonly store: Store, private readonly runtime: Runtime, private readonly fence?: (blocked: boolean) => Promise<unknown>) {}
  private attempt(runId: string, worker: WorkerRef) {
    Worker.parse(worker);
    const row = this.store.attempts(runId).find(a => a.id === worker.attemptId);
    if (!row || !sameWorker((JSON.parse(row.registration) as Registration).worker, worker)) throw new Error('stale worker binding');
    return row;
  }
  async dispatch(command: Command): Promise<{ state: string }> {
    const worker = Worker.parse(command.worker);
    if (command.kind !== 'send' || typeof command.text !== 'string' || !command.text.length || Buffer.byteLength(command.text) > 65536) throw new Error('invalid instruction');
    this.attempt(command.ref.runId, worker);
    const payloadHash = createHash('sha256').update(JSON.stringify({ kind: command.kind, worker, text: command.text, agent: command.agent })).digest('hex');
    // Inspect duplicates before the active gate: a retry can read its recorded unknown result.
    let previous;
    try { previous = this.store.operation(command.ref.operationId); } catch { /* new operation */ }
    if (!previous && !this.canWake(command.ref.runId)) throw new Error('run is stopped');
    const prepared = this.store.prepareOperation(command.ref, payloadHash);
    if (!prepared.fresh) return { state: prepared.operation.state };
    this.store.operationState(command.ref.operationId, 'sent_unknown');
    this.store.attemptState(worker, 'running');
    try {
      await this.runtime.send(worker, command.text, command.agent);
      if (command.agent) this.store.updateAgent(worker, command.agent);
      this.store.operationState(command.ref.operationId, 'acked');
      return { state: 'acked' };
    } catch (error) {
      if (error instanceof RequestFailure) {
        const state = error.delivery === 'rejected' ? 'settled' : 'cancelled';
        this.store.operationState(command.ref.operationId, state);
        await this.stopRun(command.ref.runId, error.kind);
        this.store.appendEvent({ runId: command.ref.runId, attemptId: worker.attemptId, kind: error.kind });
        return { state };
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
    let result: StopResult;
    try { result = await this.runtime.stop(worker, reason); }
    catch { result = { worker, state: 'unknown', evidenceRefs: ['stop_unconfirmed'] }; }
    if (!sameWorker(result.worker, worker)) result = { worker, state: 'unknown', evidenceRefs: ['identity_mismatch'] };
    this.store.saveStop(runId, result); return result;
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
    let result: StopResult;
    try { result = await this.runtime.releaseCompleted(worker); }
    catch { result = { worker, state: 'unknown', evidenceRefs: ['cleanup_unconfirmed'] }; }
    if (!sameWorker(result.worker, worker)) result = { worker, state: 'unknown', evidenceRefs: ['identity_mismatch'] };
    if (result.state !== 'stopped') await this.stopRun(runId, 'cleanup_unknown');
    this.store.saveStop(runId, result, true); return result;
  }
}
