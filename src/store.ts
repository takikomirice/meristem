import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Event, Id, Operation, Stop, Worker, Binding } from './contracts.js';
import type { ControlEvent, DeliveryState, OperationRef, Registration, StopResult, RunState } from './contracts.js';
import type { HumanAction, HumanRequest } from './requests.js';
import type { PlanSnapshot, TaskState } from './plan.js';
import type { RepositoryPin, GitAssignment, CandidateEvidence, IntegrationEvidence } from './git-evidence.js';
import { RevisionConflict } from './failures.js';

export type PlanTaskState = TaskState & { attemptId?: string; candidate?: CandidateEvidence; dispatch?: { mode: 'new' | 'same'; after?: string }; checks?: unknown; pendingIntegration?: { baseSha: string; inputCandidateShas: string[] }; integrationEvidence?: IntegrationEvidence };

type Run = { id: string; state: RunState; revision: number; stop_generation: number };
type StoredOperation = { id: string; run_id: string; payload_hash: string; expected_revision: number; state: DeliveryState; result: string | null };
type Attempt = { id: string; run_id: string; cwd: string; state: string; registration: string; stop_result: string | null; completed_turn_id: string | null };
export class Store {
  private db!: DatabaseSync;
  private lock: DatabaseSync;
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
      if (![0, 1, 2, 3, 4, 5].includes(version)) throw new Error('unknown schema');
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw new Error('unknown schema');
        this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/001-control.sql', import.meta.url)), 'utf8')));
      }
      if (version < 2) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/002-mcp.sql', import.meta.url)), 'utf8')));
      if (version < 3) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/003-wake.sql', import.meta.url)), 'utf8')));
      if (version < 4) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/004-requests.sql', import.meta.url)), 'utf8')));
      if (version < 5) this.transaction(() => this.db.exec(readFileSync(fileURLToPath(new URL('../../migrations/005-plan.sql', import.meta.url)), 'utf8')));
      this.db.exec("UPDATE requests SET state='cancelled' WHERE state IN ('pending','unsupported')");
      this.transaction(() => {
        this.db.exec("UPDATE runs SET state='needs_reconcile', revision=revision+1, stop_generation=stop_generation+1 WHERE state!='completed'; UPDATE operations SET state='cancelled' WHERE state='prepared'; UPDATE wake_deliveries SET state='cancelled' WHERE state='prepared'; UPDATE attempts SET state='unknown' WHERE state NOT IN ('stopped','completed');");
      });
    } catch (error) { this.db?.close(); this.lock.close(); throw error; }
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createRun(id: string): void { Id.parse(id); this.db.prepare("INSERT INTO runs(id,state) VALUES(?,'active')").run(id); }
  plan(runId: string): { snapshot: PlanSnapshot; pin: RepositoryPin; bindingHash: string; frozen: boolean; initialized: boolean } | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE run_id=?').get(runId);
    return row ? { snapshot: JSON.parse(row.snapshot as string), pin: JSON.parse(row.pin as string), bindingHash: row.binding_hash as string, frozen: !!row.frozen, initialized: !!row.initialized } : undefined;
  }
  savePlan(runId: string, snapshot: PlanSnapshot, pin: RepositoryPin): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO plans(run_id,snapshot,pin,binding_hash) VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET snapshot=excluded.snapshot,frozen=0').run(runId, JSON.stringify(snapshot), JSON.stringify(pin), snapshot.planHash);
      this.db.prepare('INSERT OR IGNORE INTO plan_revisions VALUES(?,?,?)').run(runId, snapshot.planHash, JSON.stringify(snapshot));
    });
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
  latestReport(runId: string, attemptId: string): { turnId: string; report: unknown } | undefined {
    const row = this.db.prepare('SELECT turn_id,payload FROM reports WHERE run_id=? AND attempt_id=? ORDER BY rowid DESC LIMIT 1').get(runId, attemptId);
    return row ? { turnId: row.turn_id as string, report: JSON.parse(row.payload as string) } : undefined;
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
    Operation.parse(ref); if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw new Error('invalid payload hash');
    return this.transaction(() => {
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
    });
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
  requestBinding(id: string, runId: string, operationId: string, parent: unknown, scopeHash: string, scope: unknown): void {
    this.db.prepare("INSERT INTO run_bindings VALUES(?,?,?,?,?,?,'pending',NULL)").run(id, runId, operationId, JSON.stringify(parent), scopeHash, JSON.stringify(scope));
  }
  replaceBinding(id: string, runId: string, operationId: string, parent: unknown, scopeHash: string, scope: unknown): void {
    if (this.wakeUnknown(runId)) throw new Error('wake needs reconciliation');
    this.transaction(() => {
      const previous = this.binding(runId);
      if (this.run(runId).state !== 'needs_reconcile' || this.attempts(runId).some(row => !['completed', 'stopped'].includes(row.state)) || this.db.prepare("SELECT id FROM operations WHERE run_id=? AND state='sent_unknown'").get(runId)) throw new Error('binding needs reconciliation');
      this.db.prepare('INSERT INTO binding_history VALUES(?,?)').run(previous.id, JSON.stringify(previous));
      this.db.prepare('DELETE FROM run_bindings WHERE run_id=?').run(runId);
      this.requestBinding(id, runId, operationId, parent, scopeHash, scope);
    });
  }
  confirmBinding(id: string): void {
    if (this.db.prepare("UPDATE run_bindings SET state='confirmed',confirmed_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), id).changes !== 1) throw new Error('permit is not pending');
  }
  consumeBinding(id: string): void {
    if (this.db.prepare("UPDATE run_bindings SET state='consumed' WHERE id=? AND state='confirmed'").run(id).changes !== 1) throw new Error('permit already used or missing');
  }
  saveReport(ref: OperationRef, worker: import('./contracts.js').WorkerRef, turnId: string, report: unknown): void {
    this.db.prepare('INSERT INTO reports VALUES(?,?,?,?,?)').run(ref.operationId, ref.runId, worker.attemptId, turnId, JSON.stringify(report));
  }
  reports(runId: string, attemptId?: string, offset = 0): Record<string, unknown>[] {
    return (attemptId ? this.db.prepare('SELECT attempt_id,turn_id,payload FROM reports WHERE run_id=? AND attempt_id=? ORDER BY rowid LIMIT 4 OFFSET ?').all(runId, attemptId, offset) : this.db.prepare('SELECT attempt_id,turn_id,payload FROM reports WHERE run_id=? ORDER BY rowid LIMIT 4 OFFSET ?').all(runId, offset)).map(row => ({ ...row, report: JSON.parse(row.payload as string), payload: undefined }));
  }
  reportCount(runId: string, attemptId?: string): number {
    return Number((attemptId ? this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE run_id=? AND attempt_id=?').get(runId, attemptId) : this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE run_id=?').get(runId))!.n);
  }
  hasFinalReport(runId: string, attemptId: string): boolean {
    const row = this.db.prepare('SELECT r.payload,r.turn_id,a.completed_turn_id FROM reports r JOIN attempts a ON a.id=r.attempt_id WHERE r.run_id=? AND r.attempt_id=? ORDER BY r.rowid DESC LIMIT 1').get(runId, attemptId);
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
  updateAgent(worker: import('./contracts.js').WorkerRef, agent: { model: string; effort: string }): void {
    const row = this.attempts().find(row => row.id === worker.attemptId);
    if (!row) throw new Error('unknown attempt');
    const reg = JSON.parse(row.registration) as Registration;
    this.db.prepare('UPDATE attempts SET registration=? WHERE id=?').run(JSON.stringify({ ...reg, model: agent.model, effort: agent.effort }), row.id);
  }
  attemptState(worker: import('./contracts.js').WorkerRef, state: 'idle' | 'running' | 'waiting_approval' | 'waiting_input'): void {
    this.db.prepare("UPDATE attempts SET state=? WHERE id=? AND state NOT IN ('completed','stopped','unknown')").run(state, worker.attemptId);
  }
  resumeRun(runId: string): void {
    if (this.wakeUnknown(runId)) throw new Error('wake needs reconciliation');
    if (this.attempts(runId).some(row => !['completed', 'stopped'].includes(row.state)) || this.db.prepare("SELECT id FROM operations WHERE run_id=? AND state='sent_unknown'").get(runId)) throw new Error('run needs reconciliation');
    if (this.run(runId).state !== 'active') this.transaction(() => {
      const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE run_id=?').get(runId)!.seq);
      this.wakeProgress(runId, 'scanned_seq', seq); this.wakeProgress(runId, 'delivered_seq', seq);
      this.db.prepare("UPDATE runs SET state='active' WHERE id=? AND state IN ('stopped','needs_reconcile')").run(runId);
    });
  }
  appendEvent(event: ControlEvent): number {
    const safe = Event.parse(event);
    return Number(this.db.prepare('INSERT INTO events(run_id,kind,attempt_id) VALUES(?,?,?)').run(safe.runId, safe.kind, safe.attemptId ?? null).lastInsertRowid);
  }
  events(runId: string, afterSeq: number, limit: number): Record<string, unknown>[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid event bounds');
    return this.db.prepare('SELECT seq,kind,attempt_id FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(runId, afterSeq, limit);
  }
  register(reg: Registration): void {
    Worker.parse(reg.worker); Binding.parse(reg.binding);
    for (const value of [reg.runId, reg.taskId, reg.assignmentId, reg.repositoryId, reg.jobId]) Id.parse(value);
    if (!path.isAbsolute(reg.cwd)) throw new Error('absolute cwd required');
    if (this.run(reg.runId).state !== 'active') throw new Error('run is stopped');
    const reserved = this.attempts(reg.runId).find(a => a.id === reg.worker.attemptId);
    if (reserved) {
      const previous = JSON.parse(reserved.registration) as Registration;
      if (reserved.state !== 'starting' || previous.worker.ownerId !== reg.worker.ownerId || previous.worker.ownerEpoch !== reg.worker.ownerEpoch || previous.worker.workerId !== reg.worker.workerId || previous.cwd.toLowerCase() !== realpathSync(reg.cwd).toLowerCase() || previous.assignmentId !== reg.assignmentId) throw new Error('reservation identity mismatch');
    }
    if (this.attempts().some(a => a.id !== reserved?.id && a.cwd.toLowerCase() === realpathSync(reg.cwd).toLowerCase() && !['completed', 'stopped'].includes(a.state))) throw new Error('worktree has unresolved cleanup');
    // Only explicitly constructed registration fields reach disk; no launch env or RPC payload.
    const safe: Registration = { worker: Worker.parse(reg.worker), binding: Binding.parse(reg.binding), runId: reg.runId, taskId: reg.taskId, assignmentId: reg.assignmentId, repositoryId: reg.repositoryId, cwd: realpathSync(reg.cwd), branch: reg.branch, model: reg.model, effort: reg.effort, hostPid: reg.hostPid, hostCreated: reg.hostCreated, childPid: reg.childPid, childCreated: reg.childCreated, jobId: reg.jobId };
    this.transaction(() => {
      if (reserved) {
        this.db.prepare('UPDATE actors SET thread_id=? WHERE attempt_id=?').run(reg.worker.threadId, reg.worker.attemptId);
        this.db.prepare("UPDATE attempts SET registration=?,state='running' WHERE id=?").run(JSON.stringify(safe), reg.worker.attemptId);
        this.appendEvent({ runId: reg.runId, kind: 'registered', attemptId: reg.worker.attemptId }); return;
      }
      this.db.prepare("INSERT INTO tasks VALUES(?,?,'assigned') ON CONFLICT(id) DO NOTHING").run(reg.taskId, reg.runId);
      const task = this.db.prepare('SELECT run_id FROM tasks WHERE id=?').get(reg.taskId);
      if (task?.run_id !== reg.runId) throw new Error('task run mismatch');
      this.db.prepare('INSERT INTO assignments VALUES(?,?,?)').run(reg.assignmentId, reg.taskId, reg.runId);
      this.db.prepare('INSERT INTO actors VALUES(?,?,?,?)').run(reg.worker.attemptId, reg.worker.ownerId, reg.worker.ownerEpoch, reg.worker.threadId);
      this.db.prepare("INSERT INTO attempts(id,run_id,assignment_id,registration,cwd,state,stop_result) VALUES(?,?,?,?,?,'running',NULL)").run(reg.worker.attemptId, reg.runId, reg.assignmentId, JSON.stringify(safe), safe.cwd);
      this.appendEvent({ runId: reg.runId, kind: 'registered', attemptId: reg.worker.attemptId });
    });
  }
  reserve(reg: Registration): void {
    if (reg.worker.threadId !== 'pending' || reg.hostPid !== 0 || reg.childPid !== 0) throw new Error('unstarted reservation required');
    this.register(reg);
    this.db.prepare("UPDATE attempts SET state='starting' WHERE id=?").run(reg.worker.attemptId);
  }
  attempts(runId?: string): Attempt[] { return (runId ? this.db.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY rowid').all(runId) : this.db.prepare('SELECT * FROM attempts ORDER BY rowid').all()) as Attempt[]; }
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
  reserveCorrection(runId: string, taskId: string): boolean {
    const count = Number(this.db.prepare('SELECT count FROM correction_counts WHERE run_id=? AND task_id=?').get(runId, taskId)?.count ?? 0);
    if (count >= 2) return false;
    this.db.prepare('INSERT INTO correction_counts VALUES(?,?,1) ON CONFLICT(run_id,task_id) DO UPDATE SET count=count+1').run(runId, taskId); return true;
  }
}
