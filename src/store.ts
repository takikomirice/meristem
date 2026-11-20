import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Event, Id, ModelId, Operation, Stop, Worker, Binding, DisplayName, AppliedTaskSettings, DecisionTransition, sameWorker } from './contracts.js';
import type { ControlEvent, DeliveryState, OperationRef, Registration, StopResult, RunState, WorkerRef, WorkerPresentation } from './contracts.js';
import type { HumanAction, HumanRequest } from './requests.js';
import type { PlanSnapshot, TaskState } from './plan.js';
import type { RepositoryPin, GitAssignment, CandidateEvidence, IntegrationEvidence } from './git-evidence.js';
import { Decision, DecisionKind, TaskHold } from './contracts.js';
import type { DecisionAnswer } from './decisions.js';
import { RevisionConflict } from './failures.js';
import { terminalText, type TerminalActivity } from './terminal-events.js';
import { MODEL_OUTCOME_LIMIT, sameAgentChoice, type ModelOutcome, type ModelSwitch } from './model-routing.js';

type TaskDispatch = { mode: 'new'; modelSwitch?: ModelSwitch } | { mode: 'same'; after?: string } | { mode: 'history'; target: WorkerRef; head: string; stopGeneration: number };
export type PlanTaskState = TaskState & {
  hold?: { decisionIds: string[]; planHash: string; releasedExecutionSlot: boolean; revised?: boolean };
  revisionPlanHash?: string;
  attemptId?: string;
  candidate?: CandidateEvidence;
  dispatch?: TaskDispatch;
  checks?: unknown;
  pendingIntegration?: { baseSha: string; inputCandidateShas: string[]; checkedSha?: string; checks?: IntegrationEvidence['checks'] };
  integrationEvidence?: IntegrationEvidence;
  reviewPlanHash?: string;
  reviewInstructionId?: string;
  reviewEvidence?: { reportRef: string; reviewedSha: string; acceptedByParentTurnId: string };
};

type Run = { id: string; state: RunState; revision: number; stop_generation: number };
type StoredOperation = { id: string; run_id: string; payload_hash: string; expected_revision: number; state: DeliveryState; result: string | null };
export type Attempt = { id: string; run_id: string; cwd: string; state: string; registration: string; stop_result: string | null; completed_turn_id: string | null };
import { UsagePolicy, admission, applyUsage, type Usage, type UsageState } from './usage.js';

export class Store {
  private db!: DatabaseSync;
  private lock: DatabaseSync;
  private transactionStarted?: number;
  private savepoint = 0;
  constructor(private directory: string, repository: string) {
    const repo = realpathSync(repository).toLowerCase();
    const candidate = path.resolve(directory).toLowerCase();
    if (candidate === repo || candidate.startsWith(repo + path.sep)) throw new Error('state must be outside worktree');
    mkdirSync(directory, { recursive: true });
    const actual = realpathSync(directory).toLowerCase();
    if (actual === repo || actual.startsWith(repo + path.sep)) throw new Error('state must be outside worktree');
    this.lock = new DatabaseSync(path.join(directory, 'writer.sqlite'));
    try { this.lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER);'); }
    catch { this.lock.close(); throw new Error('another writer owns this state directory'); }
    try {
      this.db = new DatabaseSync(path.join(directory, 'control.sqlite'));
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      if (![0, 1, 2, 3, 4, 5, 6, 7].includes(version)) throw new Error('unknown schema');
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error('unknown schema');
        this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/001-control.sql', import.meta.url)), 'utf8')));
      }
      if (version < 2) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/002-mcp.sql', import.meta.url)), 'utf8')));
      if (version < 3) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/003-wake.sql', import.meta.url)), 'utf8')));
      if (version < 4) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/004-requests.sql', import.meta.url)), 'utf8')));
      if (version < 5) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/005-plan.sql', import.meta.url)), 'utf8')));
      if (version < 6) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/006-coordination.sql', import.meta.url)), 'utf8')));
      if (version < 7) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/007-usage.sql', import.meta.url)), 'utf8')));
      this.db.exec("UPDATE run_usage SET observation=json_set(observation,'$.latest.status','stale') WHERE observation IS NOT NULL");
      this.db.exec('UPDATE coordination_decisions SET form_generation=NULL');
      this.db.exec("UPDATE requests SET state='cancelled' WHERE state IN ('pending','unsupported')");
      this.transaction(() => {
        this.db.exec("UPDATE runs SET state='needs_reconcile', revision=revision+1, stop_generation=stop_generation+1 WHERE state!='completed'; UPDATE operations SET state='cancelled' WHERE state='prepared'; UPDATE wake_deliveries SET state='cancelled' WHERE state='prepared'; UPDATE attempts SET state='unknown' WHERE state NOT IN ('stopped','completed');");
      });
    } catch (error) { this.db?.close(); this.lock.close(); throw error; }
  }
  transaction<T>(action: () => T): T {
    const nested = this.transactionStarted !== undefined;
    const marker = 'nested_' + ++this.savepoint;
    this.db.exec(nested ? 'SAVEPOINT ' + marker : 'BEGIN IMMEDIATE');
    if (!nested) this.transactionStarted = Date.now();
    try { const result = action(); this.db.exec(nested ? 'RELEASE ' + marker : 'COMMIT'); return result; }
    catch (error) { this.db.exec(nested ? 'ROLLBACK TO ' + marker + '; RELEASE ' + marker : 'ROLLBACK'); throw error; }
    finally { if (!nested) this.transactionStarted = undefined; }
  }
  createRun(id: string, policy?: UsagePolicy): void {
    Id.parse(id);
    this.transaction(() => {
      this.db.prepare("INSERT INTO runs(id,state) VALUES(?,'active')").run(id);
      if (policy) this.db.prepare('INSERT INTO run_usage(run_id,policy) VALUES(?,?)').run(id, JSON.stringify(UsagePolicy.parse(policy)));
    });
  }
  usageRecord(runId: string) {
    const row = this.db.prepare('SELECT * FROM run_usage WHERE run_id=?').get(runId);
    return row && { policy: UsagePolicy.parse(JSON.parse(String(row.policy))), state: row.observation ? JSON.parse(String(row.observation)) as UsageState : undefined, waiting: !!row.waiting };
  }
  capacity(runId: string, now = this.transactionStarted ?? Date.now()) {
    const usage = this.usageRecord(runId), latest = usage?.state?.latest;
    const quota = usage ? admission(usage.policy, usage.state, now) : {maximum:null, reason:'legacy', status:'unavailable'};
    const requestedMaximum = this.plan(runId)?.snapshot.plan.run.max_parallel ?? 128;
    const approvedMaximum = this.effectiveParallelLimit(runId);
    const activeWorkers = Number(this.db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE run_id=? AND state NOT IN ('completed','stopped')").get(runId)!.n);
    const effectiveMaximum = Math.min(requestedMaximum,approvedMaximum,quota.maximum ?? Infinity);
    return { requestedMaximum, approvedMaximum, activeWorkers, effectiveMaximum, quotaMaximum:quota.maximum, reason:quota.reason, usageStatus:quota.status,
      policy:usage?.policy ?? null, fetchedAt:latest?.fetchedAt ?? null, windows:latest?.windows.map(w => ({...w, resetsAtLocal: w.resetsAt === null ? null : new Date(w.resetsAt * 1000).toLocaleString()})) ?? [] };
  }
  saveUsage(runId: string, value: Usage) {
    this.transaction(() => {
      const prior = this.usageRecord(runId);
      if (!prior) return;
      const state = applyUsage(prior.state, value);
      this.db.prepare('UPDATE run_usage SET observation=? WHERE run_id=?').run(JSON.stringify(state),runId);
    });
  }
  usageWaiting(runId: string) {
    this.db.prepare('UPDATE run_usage SET waiting=1 WHERE run_id=? AND waiting=0').run(runId);
  }
  notifyUsageRecovery(runId: string) {
    this.transaction(() => {
      if (this.db.prepare('UPDATE run_usage SET waiting=0 WHERE run_id=? AND waiting=1').run(runId).changes) this.appendEvent({runId,kind:'usage_recovered'});
    });
  }
  plan(runId: string): { snapshot: PlanSnapshot; pin: RepositoryPin; bindingHash: string; frozen: boolean; initialized: boolean } | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE run_id=?').get(runId);
    return row ? { snapshot: JSON.parse(row.snapshot as string), pin: JSON.parse(row.pin as string), bindingHash: row.binding_hash as string, frozen: !!row.frozen, initialized: !!row.initialized } : undefined;
  }
  savePlan(runId: string, snapshot: PlanSnapshot, pin: RepositoryPin): void {
    this.transaction(() => this.savePlanInTransaction(runId, snapshot, pin));
  }
  savePlanInTransaction(runId: string, snapshot: PlanSnapshot, pin: RepositoryPin): void {
    this.db.prepare('INSERT INTO plans(run_id,snapshot,pin,binding_hash) VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET snapshot=excluded.snapshot,frozen=0').run(runId, JSON.stringify(snapshot), JSON.stringify(pin), snapshot.planHash);
    this.savePlanRevision(runId, snapshot);
  }
  savePlanRevision(runId: string, snapshot: PlanSnapshot): void {
    this.db.prepare(`INSERT INTO plan_revisions VALUES(?,?,?)
      ON CONFLICT(run_id,plan_hash) DO UPDATE SET snapshot=json_set(plan_revisions.snapshot,
        '$.planText',json_extract(excluded.snapshot,'$.planText'),
        '$.documentHash',json_extract(excluded.snapshot,'$.documentHash'))
      WHERE json_extract(plan_revisions.snapshot,'$.documentHash') IS NULL AND json_extract(excluded.snapshot,'$.documentHash') IS NOT NULL`)
      .run(runId, snapshot.planHash, JSON.stringify(snapshot));
  }
  planRevision(runId: string, planHash: string): PlanSnapshot | undefined {
    const row = this.db.prepare('SELECT snapshot FROM plan_revisions WHERE run_id=? AND plan_hash=?').get(runId, planHash);
    return row ? JSON.parse(row.snapshot as string) as PlanSnapshot : undefined;
  }
  freezePlan(runId: string): void { this.db.prepare('UPDATE plans SET frozen=1 WHERE run_id=?').run(runId); }
  initializePlan(runId: string): void { this.db.prepare('UPDATE plans SET initialized=1 WHERE run_id=?').run(runId); }
  gitAssignment(attemptId: string): GitAssignment | undefined {
    const row = this.db.prepare('SELECT payload FROM git_assignments WHERE attempt_id=?').get(attemptId); return row ? JSON.parse(row.payload as string) : undefined;
  }
  saveGitAssignment(runId: string, value: GitAssignment): void { this.db.prepare('INSERT INTO git_assignments VALUES(?,?,?)').run(value.attemptId, runId, JSON.stringify(value)); }
  planStates(runId: string): Record<string, PlanTaskState> { return Object.fromEntries(this.db.prepare('SELECT task_id,payload FROM plan_task_state WHERE run_id=?').all(runId).map(r => [r.task_id, JSON.parse(r.payload as string)])); }
  savePlanState(runId: string, taskId: string, state: PlanTaskState): void { this.db.prepare('INSERT INTO plan_task_state VALUES(?,?,?) ON CONFLICT(run_id,task_id) DO UPDATE SET payload=excluded.payload').run(runId, taskId, JSON.stringify(state)); }
  saveDecision(operationId: string, runId: string, taskId: string, turnId: string, payload: unknown): void { this.db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?)').run(operationId, runId, taskId, turnId, JSON.stringify(payload)); }
  modelSwitchCount(runId: string, taskId: string): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM decisions WHERE run_id=? AND task_id=? AND json_type(payload,'$.modelSwitch')='object'").get(runId, taskId)!.count);
  }
  modelOutcomes(runId: string, taskId: string): ModelOutcome[] {
    // A single integration decision can produce outcomes for multiple tasks.
    return this.db.prepare(`SELECT outcome.value FROM decisions AS d, json_each(d.payload,'$.modelOutcomes') AS outcome
      WHERE d.run_id=? AND json_extract(outcome.value,'$.taskId')=?
      ORDER BY d.rowid DESC, outcome.key LIMIT ?`).all(runId, taskId, MODEL_OUTCOME_LIMIT).map(row => JSON.parse(row.value as string) as ModelOutcome);
  }
  hasModelOutcome(runId: string, attemptId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM decisions AS d, json_each(d.payload,'$.modelOutcomes') AS outcome
      WHERE d.run_id=? AND json_extract(outcome.value,'$.attemptId')=? LIMIT 1`).get(runId, attemptId);
  }
  latestReport(runId: string, attemptId: string): { operationId: string; turnId: string; report: unknown } | undefined {
    const row = this.db.prepare('SELECT operation_id,turn_id,payload FROM reports WHERE run_id=? AND attempt_id=? ORDER BY rowid DESC LIMIT 1').get(runId, attemptId);
    return row ? { operationId: row.operation_id as string, turnId: row.turn_id as string, report: JSON.parse(row.payload as string) } : undefined;
  }
  finishRun(runId: string): void { this.db.prepare("UPDATE runs SET state='completed',revision=revision+1 WHERE id=?").run(runId); }
  saveRequest(runId: string, item: HumanRequest): void {
    this.auditHumanRequest(runId, item, item.state, 'runtime');
    this.db.prepare('INSERT INTO requests(id,run_id,attempt_id,state,kind,worker,turn_id,payload_hash,form_generation,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,form_generation=excluded.form_generation').run(item.key, Id.parse(runId), item.worker.attemptId, item.state, item.kind, JSON.stringify(item.worker), item.turnId, item.payloadHash, item.formGeneration, item.expiresAt);
  }
  auditHumanRequest(runId: string, item: HumanRequest, phase: HumanRequest['state'] | 'presentation_prepared' | 'response_received', route: 'runtime' | 'parent_mcp' | 'human_window', action?: HumanAction): void {
    // Correlation only: never persist the prompt, report body, command or credentials.
    // A prepared form is not proof of rendering; a received response is not proof of a click.
    appendFileSync(path.join(this.directory, 'human-requests.jsonl'), JSON.stringify({ at: Date.now(), runId: Id.parse(runId), requestKey: item.key, worker: Worker.parse(item.worker), turnId: item.turnId, payloadHash: item.payloadHash, formGeneration: item.formGeneration, kind: item.kind, phase, route, ...(action ? { action } : {}) }) + '\n', { encoding: 'utf8', flush: true });
  }
  requests(runId: string) { return this.db.prepare('SELECT id AS key,run_id,attempt_id,state,kind,worker,turn_id,payload_hash,form_generation,expires_at FROM requests WHERE run_id=?').all(Id.parse(runId)); }
  run(id: string): Run {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(Id.parse(id)) as Run | undefined;
    if (!row) throw new Error('unknown run'); return row;
  }
  operation(id: string): StoredOperation {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as StoredOperation | undefined;
    if (!row) throw new Error('unknown operation'); return row;
  }
  prepareOperation(ref: OperationRef, payloadHash: string, advanceRevision = true): { fresh: boolean; operation: StoredOperation } {
    return this.transaction(() => this.prepareOperationInTransaction(ref, payloadHash, advanceRevision));
  }
  private prepareOperationInTransaction(ref: OperationRef, payloadHash: string, advanceRevision: boolean) {
    Operation.parse(ref); if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw new Error('invalid payload hash');
    const previous = this.db.prepare('SELECT * FROM operations WHERE id=?').get(ref.operationId) as StoredOperation | undefined;
    if (previous) {
      if (previous.run_id !== ref.runId || previous.payload_hash !== payloadHash || previous.expected_revision !== ref.expectedRevision) throw new Error('operation payload mismatch');
      return { fresh: false, operation: previous };
    }
    const run = this.run(ref.runId);
    if (run.revision !== ref.expectedRevision) throw new RevisionConflict();
    if (advanceRevision) this.db.prepare('UPDATE runs SET revision=revision+1 WHERE id=?').run(ref.runId);
    this.db.prepare("INSERT INTO operations VALUES(?,?,?,?,'prepared',NULL)").run(ref.operationId, ref.runId, payloadHash, ref.expectedRevision);
    return { fresh: true, operation: this.operation(ref.operationId) };
  }
  coordinationOperation<T>(ref: OperationRef, payloadHash: string, action: () => T): T {
    return this.transaction(() => {
      const prepared = this.prepareOperationInTransaction(ref, payloadHash, true);
      if (!prepared.fresh) {
        if (prepared.operation.state !== 'settled' || prepared.operation.result === null) throw new Error('operation unresolved');
        return JSON.parse(prepared.operation.result) as T;
      }
      if (this.run(ref.runId).state !== 'active') throw new Error('run is not active');
      const result = action();
      this.operationResult(ref.operationId, 'settled', result);
      return result;
    });
  }
  coordinationDecision(runId: string, id: string): { decision: Decision; formGeneration: string | null; answer: DecisionAnswer | null } | undefined {
    const row = this.db.prepare('SELECT * FROM coordination_decisions WHERE run_id=? AND id=?').get(runId, id);
    return row ? { decision: Decision.parse(JSON.parse(row.payload as string)), formGeneration: row.form_generation as string | null, answer: row.answer ? JSON.parse(row.answer as string) : null } : undefined;
  }
  coordinationDecisions(runId: string, afterId = '', limit = 50, pendingOnly = false): Decision[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid decision bounds');
    return this.db.prepare(`SELECT payload FROM coordination_decisions WHERE run_id=? AND id>?
      AND (?=0 OR json_extract(payload,'$.state')='pending') ORDER BY id LIMIT ?`).all(runId, afterId, Number(pendingOnly), limit).map(row => Decision.parse(JSON.parse(row.payload as string)));
  }
  pendingBlockingTaskIds(runId: string): Set<string> {
    const blocking = this.db.prepare(`SELECT d.payload FROM coordination_decisions d
      LEFT JOIN coordination_revisions r ON r.run_id=d.run_id AND r.decision_id=d.id
      WHERE d.run_id=? AND (json_extract(d.payload,'$.state')='pending' OR (
        json_extract(d.payload,'$.proposedPlanHash') IS NOT NULL AND json_extract(d.payload,'$.state')='resolved'
        AND json_extract(d.payload,'$.planHash')=json_extract((SELECT snapshot FROM plans WHERE run_id=d.run_id),'$.planHash')
        AND json_extract(d.answer,'$.optionId')='approve' AND json_extract(d.answer,'$.text') IS NULL AND r.decision_id IS NULL
      ))`).all(runId).flatMap(row => Decision.parse(JSON.parse(row.payload as string)).blockingTaskIds);
    const stale = this.db.prepare(`SELECT h.task_id FROM task_holds h JOIN coordination_decisions d ON d.run_id=h.run_id AND d.id=h.decision_id
      WHERE h.run_id=? AND json_extract(d.payload,'$.state')='superseded'`).all(runId);
    return new Set([...blocking, ...stale.map(row => row.task_id as string)]);
  }
  saveCoordinationDecision(decision: Decision, formGeneration: string | null = null, answer: DecisionAnswer | null = null): void {
    const safe = Decision.parse(decision);
    this.db.prepare('INSERT INTO coordination_decisions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,form_generation=excluded.form_generation,answer=excluded.answer WHERE coordination_decisions.run_id=excluded.run_id').run(safe.id, safe.runId, JSON.stringify(safe), formGeneration, answer ? JSON.stringify(answer) : null);
  }
  supersedeParallelismDecisions(runId: string): void {
    for (const row of this.db.prepare("SELECT payload FROM coordination_decisions WHERE run_id=? AND json_extract(payload,'$.kind')='parallelism' AND json_extract(payload,'$.state')='pending'").all(runId)) {
      const decision = Decision.parse(JSON.parse(row.payload as string));
      this.saveCoordinationDecision({ ...decision, state: 'superseded' });
      this.releaseDecisionHolds(runId, decision.id);
    }
  }
  supersedePlanDecisions(runId: string, planHash: string): void {
    const rows = this.db.prepare(`SELECT d.payload, d.answer FROM coordination_decisions d
      LEFT JOIN coordination_revisions r ON r.run_id=d.run_id AND r.decision_id=d.id
      WHERE d.run_id=? AND json_extract(d.payload,'$.planHash')=? AND (
        json_extract(d.payload,'$.state')='pending' OR (
          json_extract(d.payload,'$.state')='resolved' AND r.decision_id IS NULL AND (
            json_extract(d.payload,'$.proposedPlanHash') IS NOT NULL OR EXISTS (
              SELECT 1 FROM plan_task_state s, json_each(s.payload,'$.hold.decisionIds') h WHERE s.run_id=d.run_id AND h.value=d.id
            )
          )
        )
      )`).all(runId, planHash);
    for (const row of rows) {
      const decision = Decision.parse(JSON.parse(row.payload as string));
      // Scope-version changes invalidate forms, but do not resolve a blocking
      // concern. Preserve the gate even if the task never needed parking.
      const keepBlocking = decision.kind === 'consultation' && decision.state === 'pending';
      if (keepBlocking) for (const taskId of decision.blockingTaskIds) {
        this.db.prepare('INSERT OR IGNORE INTO task_holds VALUES(?,?,?,0)').run(runId, taskId, decision.id);
      }
      this.saveCoordinationDecision({ ...decision, state: 'superseded' }, null, row.answer ? JSON.parse(row.answer as string) : null);
      if (!keepBlocking) this.releaseDecisionHolds(runId, decision.id);
    }
    // An approval presented for an older plan cannot revive when a later
    // revision returns to the same YAML. The original human answer remains.
    this.db.prepare('DELETE FROM parallelism_approvals WHERE run_id=?').run(runId);
  }
  planChangeAgreement(runId: string, id: string): Decision | undefined {
    const record = this.coordinationDecision(runId, id);
    if (record?.decision.state === 'resolved' && record.decision.kind === 'plan_change' && record.decision.recipient === 'human' && record.decision.proposedPlanHash && record.answer?.optionId === 'approve' && !record.answer.text) return record.decision;
  }
  saveTaskHold(runId: string, hold: TaskHold): void {
    const safe = TaskHold.parse(hold), decision = this.coordinationDecision(runId, safe.decisionId)?.decision;
    if (!decision?.blockingTaskIds.includes(safe.taskId) || !(decision.state === 'pending' || this.planChangeAgreement(runId, safe.decisionId) && !this.coordinationRevision(runId, safe.decisionId))) throw new Error('hold requires pending blocking decision');
    this.db.prepare('INSERT INTO task_holds VALUES(?,?,?,?) ON CONFLICT(run_id,task_id,decision_id) DO UPDATE SET released_execution_slot=excluded.released_execution_slot').run(runId, safe.taskId, safe.decisionId, Number(safe.releasedExecutionSlot));
  }
  taskHolds(runId: string, taskId: string): TaskHold[] {
    return this.db.prepare('SELECT * FROM task_holds WHERE run_id=? AND task_id=?').all(runId, taskId).map(row => ({ taskId: row.task_id as string, decisionId: row.decision_id as string, releasedExecutionSlot: !!row.released_execution_slot }));
  }
  releaseDecisionHolds(runId: string, decisionId: string): void {
    this.db.prepare('DELETE FROM task_holds WHERE run_id=? AND decision_id=?').run(runId, decisionId);
  }
  releaseTaskHold(runId: string, taskId: string, decisionId: string): void {
    this.db.prepare('DELETE FROM task_holds WHERE run_id=? AND task_id=? AND decision_id=?').run(runId, taskId, decisionId);
  }
  saveParallelismApproval(runId: string, decisionId: string, maximum: number): void {
    const record = this.coordinationDecision(runId, decisionId), decision = record?.decision;
    const plan = this.plan(runId);
    if (decision?.state !== 'resolved' || decision.kind !== 'parallelism' || decision.recipient !== 'human' || record?.answer?.optionId !== 'approve' || record.answer.text || decision.requestedMaximum !== maximum || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128 || !plan || plan.frozen || plan.snapshot.planHash !== decision.planHash) throw new Error('invalid parallelism approval');
    this.db.prepare('INSERT INTO parallelism_approvals VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET decision_id=excluded.decision_id,maximum=excluded.maximum').run(runId, decisionId, maximum);
  }
  parallelismApproval(runId: string): { decisionId: string; maximum: number } | undefined {
    const row = this.db.prepare('SELECT * FROM parallelism_approvals WHERE run_id=?').get(runId);
    return row ? { decisionId: row.decision_id as string, maximum: Number(row.maximum) } : undefined;
  }
  effectiveParallelLimit(runId: string): number {
    const approval = this.parallelismApproval(runId);
    if (!approval) return 2;
    const record = this.coordinationDecision(runId, approval.decisionId), plan = this.plan(runId);
    return record?.decision.state === 'resolved' && record.decision.kind === 'parallelism' && record.decision.recipient === 'human' && record.decision.requestedMaximum === approval.maximum && record.answer?.optionId === 'approve' && !record.answer.text && plan && !plan.frozen && plan.snapshot.planHash === record.decision.planHash ? approval.maximum : 2;
  }
  saveCoordinationRevision(runId: string, decisionId: string, proposedPlanHash: string): void {
    const decision = this.planChangeAgreement(runId, decisionId);
    if (!decision || decision.proposedPlanHash !== proposedPlanHash || this.plan(runId)?.snapshot.planHash !== decision.planHash) throw new Error('invalid plan revision agreement');
    this.db.prepare('INSERT INTO coordination_revisions VALUES(?,?,?,?)').run(runId, decisionId, decision.planHash, proposedPlanHash);
  }
  coordinationRevision(runId: string, decisionId: string) {
    const row = this.db.prepare('SELECT * FROM coordination_revisions WHERE run_id=? AND decision_id=?').get(runId, decisionId);
    return row ? { previousPlanHash: row.previous_plan_hash as string, proposedPlanHash: row.proposed_plan_hash as string } : undefined;
  }
  operationState(id: string, state: DeliveryState, result?: StopResult): void {
    if (!['prepared', 'sent_unknown', 'acked', 'settled', 'cancelled'].includes(state)) throw new Error('invalid delivery');
    this.db.prepare('UPDATE operations SET state=?, result=? WHERE id=?').run(state, result ? JSON.stringify(Stop.parse(result)) : null, id);
  }
  operationResult(id: string, state: DeliveryState, result: unknown): void {
    this.db.prepare('UPDATE operations SET state=?,result=? WHERE id=?').run(state, JSON.stringify(result), id);
  }
  binding(runId: string): any {
    return this.db.prepare('SELECT * FROM run_bindings WHERE run_id=?').get(runId);
  }
  coordinatorSave(runId: string): boolean {
    const binding = this.binding(runId);
    return binding ? JSON.parse(binding.scope).planScope?.coordinatorSave === true : false;
  }
  savedCandidateOperation(runId: string, attemptId: string) {
    return this.db.prepare(`SELECT * FROM operations WHERE run_id=? AND json_extract(result,'$.kind')='worker_save'
      AND json_extract(result,'$.attemptId')=? AND state IN ('sent_unknown','settled')`).get(runId, attemptId) as StoredOperation | undefined;
  }
  unconfirmedSaves(runId: string) {
    return this.db.prepare(`SELECT * FROM operations WHERE run_id=? AND state='sent_unknown'
      AND json_extract(result,'$.kind')='worker_save'`).all(runId) as StoredOperation[];
  }
  requestBinding(id: string, runId: string, operationId: string, parent: unknown, scopeHash: string, scope: unknown): void {
    this.db.prepare("INSERT INTO run_bindings VALUES(?,?,?,?,?,?,'pending',NULL)").run(id, runId, operationId, JSON.stringify(parent), scopeHash, JSON.stringify(scope));
  }
  replaceBinding(id: string, runId: string, operationId: string, parent: unknown, scopeHash: string, scope: unknown, humanResume = false): void {
    if (this.wakeUnknown(runId)) throw new Error('wake needs reconciliation');
    this.transaction(() => {
      const previous = this.binding(runId);
      const state = this.run(runId).state;
      if ((state !== 'needs_reconcile' && !(humanResume && state === 'stopped')) || this.attempts(runId).some(row => !['completed', 'stopped'].includes(row.state)) || this.operationUnknown(runId)) throw new Error('binding needs reconciliation');
      this.db.prepare('INSERT INTO binding_history VALUES(?,?)').run(previous.id, JSON.stringify(previous));
      this.db.prepare('DELETE FROM run_bindings WHERE run_id=?').run(runId);
      this.requestBinding(id, runId, operationId, parent, scopeHash, scope);
      if (humanResume) this.commitHumanStart(id, 'control_input');
    });
  }
  confirmBinding(id: string): void {
    if (this.db.prepare("UPDATE run_bindings SET state='confirmed',confirmed_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), id).changes !== 1) throw new Error('permit is not pending');
  }
  commitHumanStart(id: string, source: 'control_input' | 'permit_confirmation'): void {
    const changed = this.db.prepare(
      "UPDATE run_bindings SET state='consumed', confirmed_at=?, scope=json_set(scope,'$.startSource',?) WHERE id=? AND state='pending'"
    ).run(new Date().toISOString(), source, id);
    if (changed.changes !== 1) throw new Error('start permit is not pending');
  }
  consumeBinding(id: string): void {
    if (this.db.prepare("UPDATE run_bindings SET state='consumed' WHERE id=? AND state='confirmed'").run(id).changes !== 1) throw new Error('permit already used or missing');
  }
  saveReport(ref: OperationRef, worker: import('./contracts.js').WorkerRef, turnId: string, report: unknown): void {
    this.db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(ref.operationId, ref.runId, worker.attemptId, turnId, JSON.stringify(report));
  }
  reports(runId: string, attemptId?: string, offset = 0): Record<string, unknown>[] {
    return (attemptId ? this.db.prepare('SELECT operation_id AS reportRef,attempt_id,turn_id,payload FROM reports WHERE run_id=? AND attempt_id=? ORDER BY rowid LIMIT 4 OFFSET ?').all(runId, attemptId, offset) : this.db.prepare('SELECT operation_id AS reportRef,attempt_id,turn_id,payload FROM reports WHERE run_id=? ORDER BY rowid LIMIT 4 OFFSET ?').all(runId, offset)).map(row => ({ ...row, report: JSON.parse(row.payload as string), payload: undefined }));
  }
  reportCount(runId: string, attemptId?: string): number {
    return Number((attemptId ? this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE run_id=? AND attempt_id=?').get(runId, attemptId) : this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE run_id=?').get(runId))!.n);
  }
  hasFinalReport(runId: string, attemptId: string, requireCleanup = false): boolean {
    const row = this.db.prepare('SELECT r.payload,r.turn_id,a.completed_turn_id,a.state FROM reports r JOIN attempts a ON a.id=r.attempt_id AND a.run_id=r.run_id WHERE r.run_id=? AND r.attempt_id=? ORDER BY r.rowid DESC LIMIT 1').get(runId, attemptId);
    if (requireCleanup && (row?.state !== 'completed' || !row.completed_turn_id)) return false;
    return !!row && !JSON.parse(row.payload as string).question && (row.completed_turn_id === null || row.completed_turn_id === row.turn_id);
  }
  completedTurn(worker: import('./contracts.js').WorkerRef, turnId: string): void { this.db.prepare('UPDATE attempts SET completed_turn_id=? WHERE id=?').run(Id.parse(turnId), worker.attemptId); }
  reserveInstruction(ref: OperationRef, limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid instruction budget');
    this.transaction(() => {
      if (this.db.prepare('SELECT operation_id FROM instruction_reservations WHERE operation_id=? AND run_id=?').get(ref.operationId, ref.runId)) return;
      const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM instruction_reservations WHERE run_id=?').get(ref.runId)!.n);
      if (count >= limit) throw new Error('instruction budget exhausted');
      this.db.prepare('INSERT INTO instruction_reservations VALUES(?,?)').run(ref.operationId, ref.runId);
    });
  }
  historyDecision(runId: string, taskId: string, decision?: string): string | undefined {
    if (decision) this.db.prepare('INSERT INTO task_decisions VALUES(?,?,?) ON CONFLICT(run_id,task_id) DO UPDATE SET decision=excluded.decision').run(runId, taskId, decision);
    return this.db.prepare('SELECT decision FROM task_decisions WHERE run_id=? AND task_id=?').get(runId, taskId)?.decision as string | undefined;
  }
  updateAgent(worker: import('./contracts.js').WorkerRef, agent: { model: string; effort: string }, fallback?: 'agent_not_in_catalog'): void {
    const row = this.attempts().find(row => row.id === worker.attemptId);
    if (!row) throw new Error('unknown attempt');
    const reg = JSON.parse(row.registration) as Registration;
    if (fallback) {
      const routing = reg.modelRouting, initial = routing?.initialRecommendation;
      if (!routing || initial?.reason !== 'learned' || !sameAgentChoice(initial.selected, reg) || !sameAgentChoice(initial.planned, agent)) throw new Error('initial model fallback was not reserved');
      // turn/start acknowledges a turn ID, but does not echo model/effort.
      reg.modelRouting = { ...routing, agent: null, initialRecommendation: { ...initial, selected: agent, reason: fallback } };
    }
    this.db.prepare('UPDATE attempts SET registration=? WHERE id=?').run(JSON.stringify({ ...reg, model: agent.model, effort: agent.effort }), row.id);
  }
  attemptState(worker: import('./contracts.js').WorkerRef, state: 'idle' | 'running' | 'waiting_approval' | 'waiting_input' | 'stopping'): void {
    this.db.prepare("UPDATE attempts SET state=? WHERE id=? AND state NOT IN ('completed','stopped','unknown')").run(state, worker.attemptId);
  }
  operationUnknown(runId: string): boolean {
    return !!this.db.prepare("SELECT id FROM operations WHERE run_id=? AND state='sent_unknown'").get(runId);
  }
  resumeRun(runId: string): void {
    if (this.wakeUnknown(runId)) throw new Error('wake needs reconciliation');
    if (this.attempts(runId).some(row => !['completed', 'stopped'].includes(row.state)) || this.operationUnknown(runId)) throw new Error('run needs reconciliation');
    if (this.run(runId).state !== 'active') this.transaction(() => {
      const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE run_id=?').get(runId)!.seq);
      this.wakeProgress(runId, 'scanned_seq', seq); this.wakeProgress(runId, 'delivered_seq', seq);
      this.db.prepare("UPDATE runs SET state='active' WHERE id=? AND state IN ('stopped','needs_reconcile')").run(runId);
    });
  }
  appendEvent(event: ControlEvent, decisionKind?: DecisionKind): number {
    const safe = Event.parse(event);
    const kind = decisionKind ? `${DecisionTransition.parse(safe.kind)}:${DecisionKind.parse(decisionKind)}` : safe.kind;
    return Number(this.db.prepare('INSERT INTO events(run_id,kind,attempt_id) VALUES(?,?,?)').run(safe.runId, kind, safe.attemptId ?? null).lastInsertRowid);
  }
  events(runId: string, afterSeq: number, limit: number, attemptId?: string): Record<string, unknown>[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid event bounds');
    const rows = attemptId === undefined
      ? this.db.prepare('SELECT seq,kind,attempt_id FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, afterSeq, limit)
      : this.db.prepare(`SELECT seq,kind,attempt_id FROM events WHERE run_id=? AND seq>?
          AND (attempt_id=? OR (attempt_id IS NULL AND seq >=
            (SELECT MIN(seq) FROM events WHERE run_id=? AND attempt_id=? AND kind='registered')))
          ORDER BY seq LIMIT ?`).all(runId, afterSeq, attemptId, runId, attemptId, limit);
    return rows.map(row => {
      const [transition, decisionKind] = String(row.kind).split(':');
      return DecisionTransition.options.some(kind => kind === transition)
        ? { ...row, kind: 'decision_changed', transition, ...(decisionKind ? { decisionKind } : {}) } : row;
    });
  }
  private initialDisplayName(runId: string, reg: Registration): string {
    const plan = this.plan(runId)?.snapshot.plan;
    const displayName = plan?.schema_version === 2 ? plan.tasks.find(task => task.id === reg.taskId)?.display_name : undefined;
    return displayName && terminalText(displayName, 512).trim() || reg.worker.workerId;
  }
  register(reg: Registration): void {
    this.persistRegistration(reg, false);
  }
  private persistRegistration(reg: Registration, starting: boolean): void {
    Worker.parse(reg.worker); Binding.parse(reg.binding);
    for (const value of [reg.runId, reg.taskId, reg.assignmentId, reg.repositoryId, reg.jobId]) Id.parse(value);
    if (!path.isAbsolute(reg.cwd)) throw new Error('absolute cwd required');
    if (this.run(reg.runId).state !== 'active') throw new Error('run is stopped');
    const reserved = this.attempts(reg.runId).find(a => a.id === reg.worker.attemptId);
    let routing = reg.modelRouting;
    if (reserved) {
      const previous = JSON.parse(reserved.registration) as Registration;
      if (starting || reserved.state !== 'starting' || previous.worker.ownerId !== reg.worker.ownerId || previous.worker.ownerEpoch !== reg.worker.ownerEpoch || previous.worker.workerId !== reg.worker.workerId || previous.cwd.toLowerCase() !== realpathSync(reg.cwd).toLowerCase() || previous.assignmentId !== reg.assignmentId) throw new Error('reservation identity mismatch');
      routing = previous.modelRouting;
      if (routing?.modelSwitch && (!sameAgentChoice(previous, routing.modelSwitch.agent) || !sameAgentChoice(reg, previous)
        || !reg.settings || !sameAgentChoice(reg.settings.agent, previous))) throw new Error('requested task settings not confirmed');
      const initial = routing?.initialRecommendation;
      if (routing && initial?.reason === 'learned') {
        const fallback = reg.settings?.initialFallback === 'agent_not_in_catalog';
        const selected = fallback ? initial.planned : initial.selected;
        if (!sameAgentChoice(previous, initial.selected) || !sameAgentChoice(reg, selected) ||
          !reg.settings || !sameAgentChoice(reg.settings.agent, selected)) throw new Error('requested task settings not confirmed');
        if (fallback) routing = { ...routing, initialRecommendation: { ...initial, selected, reason: 'agent_not_in_catalog' } };
      } else if (reg.settings?.initialFallback) throw new Error('initial model fallback was not reserved');
    }
    if (this.attempts().some(a => a.id !== reserved?.id && a.cwd.toLowerCase() === realpathSync(reg.cwd).toLowerCase() && !['completed', 'stopped'].includes(a.state))) throw new Error('worktree has unresolved cleanup');
    // Only explicitly constructed registration fields reach disk; no launch env or RPC payload.
    const safe: Registration = { worker: Worker.parse(reg.worker), binding: Binding.parse(reg.binding), runId: reg.runId, taskId: reg.taskId, assignmentId: reg.assignmentId, repositoryId: reg.repositoryId, cwd: realpathSync(reg.cwd), branch: reg.branch, model: reg.model, effort: reg.effort, hostPid: reg.hostPid, hostCreated: reg.hostCreated, childPid: reg.childPid, childCreated: reg.childCreated, jobId: reg.jobId };
    if (routing) {
      const applied = reg.settings?.agent;
      const agent = reserved && applied && applied.model === reg.model && applied.effort === reg.effort
        ? { model: applied.model, effort: applied.effort } : null;
      safe.modelRouting = { ...routing, agent };
    }
    if (reg.settings) safe.settings = AppliedTaskSettings.parse(reg.settings);
    if (reg.modelProvider !== undefined) safe.modelProvider = ModelId.parse(reg.modelProvider);
    safe.displayName = this.initialDisplayName(reg.runId, reg);
    this.transaction(() => {
      if (reserved) {
        this.db.prepare('UPDATE actors SET thread_id=? WHERE attempt_id=?').run(reg.worker.threadId, reg.worker.attemptId);
        this.db.prepare("UPDATE attempts SET registration=?,state='running' WHERE id=?").run(JSON.stringify(safe), reg.worker.attemptId);
        this.appendEvent({ runId: reg.runId, kind: 'registered', attemptId: reg.worker.attemptId }); return;
      }
      const capacity = this.capacity(reg.runId);
      if ((starting || capacity.policy) && capacity.activeWorkers >= capacity.effectiveMaximum) throw new Error('worker capacity unavailable');
      this.db.prepare("INSERT INTO tasks VALUES(?,?,'assigned') ON CONFLICT(id) DO NOTHING").run(reg.taskId, reg.runId);
      const task = this.db.prepare('SELECT run_id FROM tasks WHERE id=?').get(reg.taskId);
      if (task?.run_id !== reg.runId) throw new Error('task run mismatch');
      this.db.prepare('INSERT INTO assignments VALUES(?,?,?)').run(reg.assignmentId, reg.taskId, reg.runId);
      this.db.prepare('INSERT INTO actors VALUES(?,?,?,?)').run(reg.worker.attemptId, reg.worker.ownerId, reg.worker.ownerEpoch, reg.worker.threadId);
      this.db.prepare("INSERT INTO attempts(id,run_id,assignment_id,registration,cwd,state,stop_result) VALUES(?,?,?,?,?,?,NULL)").run(reg.worker.attemptId, reg.runId, reg.assignmentId, JSON.stringify(safe), safe.cwd, starting ? 'starting' : 'running');
      if (!starting) this.appendEvent({ runId: reg.runId, kind: 'registered', attemptId: reg.worker.attemptId });
    });
  }
  reserve(reg: Registration): void {
    if (reg.worker.threadId !== 'pending' || reg.hostPid !== 0 || reg.childPid !== 0) throw new Error('unstarted reservation required');
    this.persistRegistration(reg, true);
  }
  attempts(runId?: string): Attempt[] { return (runId ? this.db.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY rowid').all(runId) : this.db.prepare('SELECT * FROM attempts ORDER BY rowid').all()) as Attempt[]; }
  hasRegisteredThread(threadId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM actors WHERE thread_id=? LIMIT 1').get(Id.parse(threadId));
  }
  terminalRegistration(runId: string, attemptId: string): Registration | undefined {
    const row = this.db.prepare('SELECT registration FROM attempts WHERE run_id=? AND id=?').get(runId, Id.parse(attemptId));
    return row ? JSON.parse(row.registration as string) as Registration : undefined;
  }
  historyTargets(runId: string, offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid history offset');
    const rows = this.db.prepare(`SELECT state, registration FROM attempts WHERE run_id=?
      AND json_extract(registration,'$.worker.threadId')!='pending' ORDER BY rowid DESC LIMIT 17 OFFSET ?`).all(runId, offset);
    const targets = rows.slice(0, 16).map(row => {
      const { worker, taskId, branch, displayName } = JSON.parse(row.registration as string) as Registration;
      return { worker, taskId, branch, displayName, state: row.state };
    });
    return { targets, nextOffset: rows.length > 16 ? offset + 16 : null, revision: this.run(runId).revision };
  }
  renameWorker(runId: string, target: WorkerRef, value: unknown): string {
    const displayName = DisplayName.parse(terminalText(DisplayName.parse(value), 512));
    const reg = this.terminalRegistration(runId, target.attemptId);
    if (!reg || reg.worker.threadId === 'pending' || !sameWorker(reg.worker, target)) throw new Error('stale worker binding');
    this.db.prepare("UPDATE attempts SET registration=json_set(registration,'$.displayName',?) WHERE id=? AND run_id=?")
      .run(displayName, target.attemptId, runId);
    return displayName;
  }
  private terminalPresentation(runId: string, row: Attempt, reg: Registration, stopResult: StopResult | null, telemetry?: { activity?: TerminalActivity; permissionSummary?: string; appliedAgent?: string }) {
    const activity = telemetry?.activity;
    // Project only the fields the terminal renders. Answers, options and proposal hashes stay in the inbox.
    const records = this.db.prepare(`SELECT id, json_extract(payload,'$.recipient') AS recipient,
        json_extract(payload,'$.state') AS state, json_extract(payload,'$.question') AS question,
        json_extract(payload,'$.taskIds') AS tasks, json_extract(payload,'$.blockingTaskIds') AS blockers
      FROM coordination_decisions d
      WHERE run_id=? AND json_extract(payload,'$.kind')='consultation'
        AND EXISTS(SELECT 1 FROM json_each(d.payload,'$.taskIds') WHERE value=?)
      ORDER BY state='pending' DESC, rowid DESC LIMIT 17`).all(runId, reg.taskId);
    const consultations = [];
    let bytes = 0;
    for (const { id, recipient, state, question, tasks, blockers } of records.slice(0, 16)) {
      const summary = { id: id as string, recipient: recipient as Decision['recipient'], state: state as Decision['state'],
        question: terminalText(question as string, 512), taskIds: JSON.parse(tasks as string) as string[], blockingTaskIds: JSON.parse(blockers as string) as string[] };
      bytes += Buffer.byteLength(JSON.stringify(summary)) + 1;
      if (bytes > 40_000) break;
      consultations.push(summary);
    }
    const task = this.db.prepare('SELECT payload FROM plan_task_state WHERE run_id=? AND task_id=?').get(runId, reg.taskId);
    const state = task && JSON.parse(task.payload as string) as PlanTaskState;
    const taskState = state?.attemptId === row.id ? state : undefined;
    const reported = this.db.prepare("SELECT json_extract(payload,'$.status') AS status FROM reports WHERE run_id=? AND attempt_id=? ORDER BY rowid DESC LIMIT 1").get(runId, row.id);
    const result = stopResult?.state === 'stopped' ? 'プロセス終了確認済み'
      : row.state === 'unknown' || stopResult?.state === 'unknown' ? 'プロセス終了未確認'
      : reported ? ({ completed: '完了の報告を受領', failed: '失敗の報告を受領', needs_input: '相談が必要との報告を受領' } as const)[reported.status as 'completed' | 'failed' | 'needs_input'] ?? '報告を受領'
      : undefined;
    const presentation: WorkerPresentation = { displayName: reg.displayName ?? this.initialDisplayName(runId, reg), taskId: reg.taskId,
      activity: activity?.latest?.text ?? '情報なし', activitySource: activity?.latest?.source ?? null,
      lastActivityAt: activity?.lastActivityAt ?? null, decisionIds: consultations.map(item => item.id) };
    return { presentation, consultations, consultationsTruncated: records.length > consultations.length,
      taskState: taskState?.state, slotReleased: taskState?.hold?.releasedExecutionSlot, permissionSummary: telemetry?.permissionSummary, appliedAgent: telemetry?.appliedAgent,
      lastResult: [result, activity?.lastResult].filter(Boolean).join(' / ') || undefined,
      connection: row.state === 'unknown' ? 'unknown' as const : 'connected' as const };
  }
  terminalSnapshot(runId: string, offset = 0, attemptId?: string, options: { telemetry?: (worker: WorkerRef) => { activity?: TerminalActivity; permissionSummary?: string; appliedAgent?: string }; registrationOnly?: boolean } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid attempt offset');
    if (attemptId !== undefined) Id.parse(attemptId);
    const rows = attemptId ? this.db.prepare('SELECT * FROM attempts WHERE run_id=? AND id=?').all(runId, attemptId) as Attempt[] : this.displayAttempts(runId);
    const attempts: ({ state: string; registration: Registration; stopResult: StopResult | null } & Partial<ReturnType<Store['terminalPresentation']>>)[] = [];
    const result = { ok: true, run: this.run(runId), capacity: this.capacity(runId), binding: this.binding(runId), attempts, nextAttemptOffset: null as number | null };
    for (const row of rows.slice(offset, offset + 4)) {
      const registration = JSON.parse(row.registration) as Registration, stopResult = row.stop_result ? JSON.parse(row.stop_result) as StopResult : null;
      const item = { state: row.state, registration, stopResult, ...(options.registrationOnly ? {}
        : this.terminalPresentation(runId, row, registration, stopResult, options.telemetry?.(registration.worker))) };
      attempts.push(item);
      if (Buffer.byteLength(JSON.stringify(result)) > 180000) {
        attempts.pop(); if (!attempts.length) throw new Error('terminal status item exceeds frame budget'); break;
      }
    }
    result.nextAttemptOffset = rows.length > offset + attempts.length ? offset + attempts.length : null;
    return result;
  }
  displayAttempts(runId: string): Attempt[] {
    const attempts = this.attempts(runId), live = attempts.filter(row => !['completed', 'stopped'].includes(row.state));
    const count = Math.max(0, 4 - live.length), recent = count ? attempts.filter(row => ['completed', 'stopped'].includes(row.state)).slice(-count) : [];
    const selected = new Set([...live, ...recent].map(row => row.id));
    return attempts.filter(row => selected.has(row.id));
  }
  stopRun(runId: string, reconcile = false): void {
    this.transaction(() => {
      this.run(runId);
      this.db.prepare('UPDATE runs SET state=?, stop_generation=stop_generation+1, revision=revision+1 WHERE id=?').run(reconcile ? 'needs_reconcile' : 'stopped', runId);
      this.db.prepare("UPDATE operations SET state='cancelled' WHERE run_id=? AND state='prepared'").run(runId);
      this.db.prepare("UPDATE wake_deliveries SET state='cancelled' WHERE run_id=? AND state='prepared'").run(runId);
      this.db.prepare('UPDATE coordination_decisions SET form_generation=NULL WHERE run_id=? AND form_generation IS NOT NULL').run(runId);
      const cursor = this.wakeCursor(runId);
      this.wakeProgress(runId, 'delivered_seq', cursor.pending_seq);
      this.appendEvent({ runId, kind: reconcile ? 'needs_reconcile' : 'stopping' });
    });
  }
  saveStop(runId: string, result: StopResult, completed = false): void {
    Stop.parse(result);
    this.transaction(() => {
      this.db.prepare('UPDATE attempts SET state=?, stop_result=? WHERE id=? AND run_id=?').run(completed && result.state === 'stopped' ? 'completed' : result.state, JSON.stringify(result), result.worker.attemptId, runId);
      this.appendEvent({ runId, attemptId: result.worker.attemptId, kind: result.state === 'stopped' ? (completed ? 'completed' : 'stopped') : 'unknown' });
      if (result.state !== 'stopped') this.db.prepare("UPDATE runs SET state='stopped', revision=revision+1 WHERE id=?").run(runId);
    });
  }
  close(): void { this.db.close(); this.lock.close(); }
  wakeCursor(runId: string): { scanned_seq: number; pending_seq: number; delivered_seq: number; read_seq: number } {
    this.db.prepare('INSERT OR IGNORE INTO wake_cursors(run_id) VALUES(?)').run(runId);
    return this.db.prepare('SELECT scanned_seq,pending_seq,delivered_seq,read_seq FROM wake_cursors WHERE run_id=?').get(runId) as any;
  }
  wakeProgress(runId: string, column: 'scanned_seq' | 'pending_seq' | 'delivered_seq' | 'read_seq', seq: number): void {
    this.wakeCursor(runId);
    this.db.prepare(`UPDATE wake_cursors SET ${column}=MAX(${column},?) WHERE run_id=?`).run(seq, runId);
  }
  wakeUnknown(runId: string): boolean { return !!this.db.prepare("SELECT id FROM wake_deliveries WHERE run_id=? AND state='sent_unknown'").get(runId); }
  wakeCount(runId: string): number { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM wake_deliveries WHERE run_id=? AND state IN ('acked','sent_unknown')").get(runId)!.n); }
  reserveWake(id: string, runId: string, seq: number, parent: unknown): void {
    this.db.prepare("INSERT INTO wake_deliveries(id,run_id,state,source_seq,stop_generation,parent) VALUES(?,?,'sent_unknown',?,?,?)").run(id, runId, seq, this.run(runId).stop_generation, JSON.stringify(parent));
  }
  settleWake(id: string, state: 'acked' | 'cancelled', turnId?: string): void {
    this.db.prepare('UPDATE wake_deliveries SET state=?,turn_id=? WHERE id=?').run(state, turnId ?? null, id);
  }
  correctionCount(runId: string, taskId: string): number {
    return Number(this.db.prepare('SELECT count FROM correction_counts WHERE run_id=? AND task_id=?').get(runId, taskId)?.count ?? 0);
  }
  reserveCorrection(runId: string, taskId: string, limit: number | null = null): boolean {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('invalid correction budget');
    if (limit !== null && this.correctionCount(runId, taskId) >= limit) return false;
    this.db.prepare('INSERT INTO correction_counts VALUES(?,?,1) ON CONFLICT(run_id,task_id) DO UPDATE SET count=count+1').run(runId, taskId); return true;
  }
}
