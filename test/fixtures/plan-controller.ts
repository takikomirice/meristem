import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Store } from '../../src/store.js';
import { Broker } from '../../src/broker.js';
import { McpController, type FixtureScope, type ManagedRuntime } from '../../src/mcp.js';
import type { WorkerRef } from '../../src/contracts.js';
import { serialFixture, commitFile, git, checks } from './serial-git.js';
import type { RoutingHistory } from '../../src/routing-summary.js';

export async function planControllerFixture(t: { after(fn: () => void): void }, configure?: (f: ReturnType<typeof serialFixture>, scope?: FixtureScope) => void, managedRuntime?: ManagedRuntime,
  approve?: (controller: McpController, pending: any, fixture: ReturnType<typeof serialFixture>, startRun: () => Promise<any>) => Promise<void>,
  routingHistory?: (fixture: ReturnType<typeof serialFixture>) => RoutingHistory) {
  const f = serialFixture();
  const scope = { fixture: true, plan: true, planPath: f.planPath, repositoryPath: f.repository, repositoryId: 'repo', windowBindingId: 'window', branchScope: ['cc05-integration'], assignments: [] } as FixtureScope;
  configure?.(f, scope); f.savePlan();
  const store = new Store(path.join(f.root, 'state'), f.repository); store.createRun('run'); t.after(() => store.close());
  const starts: any[] = [], parent = { actor: { ownerId: 'parent', ownerEpoch: 'epoch', threadId: 'P' }, turnId: 'parent-turn' };
  const runtime = managedRuntime ?? {
    async start(assignment: any) { starts.push(assignment); return { ...assignment.identity, threadId: assignment.previous?.threadId ?? randomUUID() }; },
    registration() { return { hostPid: 1, hostCreated: '1', childPid: 2, childCreated: '2', jobId: 'job' }; },
    async send() {},
    async stop(worker: WorkerRef) { return { worker, state: 'stopped' as const, evidenceRefs: ['confirmed'] }; },
    async releaseCompleted(worker: WorkerRef) { return { worker, state: 'stopped' as const, evidenceRefs: ['confirmed'] }; }
  };
  const history = routingHistory?.(f);
  if (history) scope.modelRoutingSummary = history.reference;
  const broker = new Broker(store, runtime), controller = new McpController(store, broker, runtime, 'run', parent.actor, scope, history);
  const ref = () => ({ runId: 'run', operationId: randomUUID(), expectedRevision: store.run('run').revision });
  const call = (name: string, args: any = {}, who = parent) => controller.call(name, { ...ref(), ...args }, { ...who, actor: { ownerId: who.actor.ownerId, ownerEpoch: who.actor.ownerEpoch, threadId: who.actor.threadId } });
  const start = { planPath: f.planPath, operationId: 'start' };
  const startRun = () => controller.call('start_run', start, parent);
  const pending = await startRun();
  if (approve) await approve(controller, pending, f, startRun);
  else controller.authorize(pending.bindingId);
  await startRun();
  const create = (taskId: string) => call('create_worker', { taskId });
  const status = () => controller.call('get_status', { runId: 'run' }, parent);
  const complete = async (taskId: string, worker: WorkerRef, text = 'one', cleanup = true, turnId = 'turn', reportedChecks = checks) => {
    const a = store.gitAssignment(worker.attemptId)!; const sha = commitFile(a.cwd, taskId.toLowerCase() + '.txt', text); git(a.cwd, 'push', 'origin', a.branch);
    git(a.cwd, 'diff', '--check', a.baseSha, sha);
    const report = { task_id: taskId, worker_id: worker.workerId, attempt_id: worker.attemptId, actor_id: worker.threadId, status: 'completed', base_sha: a.baseSha, candidate_sha: sha, branch: a.branch, push_result: { status: 'pushed', remote: 'origin', branch: a.branch }, summary: 'done', checks: reportedChecks, remaining: [] };
    await call('report', { taskId, report }, { actor: worker, turnId });
    if (cleanup) { store.completedTurn(worker, turnId); await broker.releaseCompleted('run', worker); }
    return { sha, report, assignment: a };
  };
  return { ...f, store, controller, broker, runtime, scope, ref, parent, starts, call, create, status, complete };
}
