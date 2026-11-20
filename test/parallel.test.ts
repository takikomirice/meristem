import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { WorkerRef } from '../src/contracts.js';
import { readPlan } from '../src/plan.js';
import { recordedWorkflow } from './live/pre-p6-observation.js';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerRuntime } from '../src/workers.js';
import { GitEvidence } from '../src/git-evidence.js';
import { Broker, PlanControl } from '../src/broker.js';
import { DecisionService } from '../src/decisions.js';
import { Store } from '../src/store.js';
import path from 'node:path';
import { planControllerFixture } from './fixtures/plan-controller.js';
import { git, checks, commitFile } from './fixtures/serial-git.js';

const parallel = (t: Parameters<typeof planControllerFixture>[0], configure?: Parameters<typeof planControllerFixture>[1]) => planControllerFixture(t, f => {
  f.plan.run.max_parallel = 2; f.plan.tasks[1].depends_on = [];
  f.plan.tasks.push({ ...f.plan.tasks[0], id: 'C', scope: ['c.txt'], depends_on: ['A', 'B'] });
  f.plan.tasks.push({ ...f.plan.tasks[0], id: 'D', scope: ['d.txt'] });
  configure?.(f);
});

test('quota controls real reservations, permits registered workers to finish and notifies once after recovery', async t => {
  const f = await planControllerFixture(t, file => { file.plan.run.max_parallel=2; file.plan.tasks[1].depends_on=[]; },
    undefined, undefined, undefined, {enabled:true,threshold:20,lowMaximum:1});
  const update = (remaining: number) => f.store.saveUsage('run',{status:'ok', account:'f'.repeat(64), fetchedAt:Date.now(), ordinaryUsageAllowed:true,
    windows:[{name:'primary',remainingPercent:remaining,usedPercent:100-remaining,windowDurationMins:null,resetsAt:null}]});
  update(21);
  const worker = await f.create('A'); assert(worker.threadId);
  update(20);
  assert.equal((await f.create('B')).state,'waiting_usage');
  assert.equal(f.store.attempts('run').length,1);
  assert.equal(f.store.correctionCount('run','B'),0);
  assert.deepEqual((await f.status()).plan.eligible,[]);
  update(0);
  assert.equal((await f.status()).capacity.activeWorkers,1);
  update(21); f.controller.checkUsageWaiting(); f.controller.checkUsageWaiting();
  assert.equal(f.store.events('run',0,100).filter(e=>e.kind==='usage_recovered').length,1);
  assert((await f.create('B')).threadId);
  assert.equal(f.starts[0].gitApprovalRoots.length,0);
  const a=f.store.gitAssignment(worker.attemptId)!;
  writeFileSync(path.join(a.cwd,'a.txt'),'scoped change');
  const save = { ...f.ref(),taskId:'A',target:worker,expectedHead:a.baseSha,message:'Save assigned change' };
  const saved=await f.call('save_worker_changes',save);
  assert.equal(git(a.cwd,'ls-remote','origin','refs/heads/'+a.branch).split(/\s/)[0],saved.candidateSha);
  assert.deepEqual(await f.call('save_worker_changes',save),saved);
});

const managedPlan = (t: Parameters<typeof planControllerFixture>[0]) => planControllerFixture(t, undefined,
  undefined, undefined, undefined, { enabled: false, threshold: 20, lowMaximum: 1 }, 'managed-session');

for (const failedAudit of [false, true]) {
  test(`pre-P6 small plan ${failedAudit ? 'holds entry after a failed audit' : 'finishes entry after an accepted audit'}`, async t => {
    const example = path.resolve('docs/validation/chat-control/pre-p6-small-plan.md');
    const tasks = readPlan(example).plan.tasks;
    const stateDirectory = mkdtempSync(path.join(tmpdir(), 'meristem-small-plan-'));
    const hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe');
    const realExe = path.resolve('.local/chat-control-build/MockCodex.exe');
    const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
    const workerRequests: string[] = [];
    const runtime = new WorkerRuntime({ stateDirectory, hostExe, hostSha256: hash(hostExe), realExe,
      realSha256: hash(realExe), authHome: stateDirectory, fixture: true }, undefined, request => workerRequests.push(request.kind));
    const f = await planControllerFixture(t, (fixture, scope) => {
      const script = readFileSync(example, 'utf8').match(/```javascript\r?\n([\s\S]+?)```/);
      assert.ok(script);
      commitFile(fixture.repository, 'checks.mjs', script[1]);
      commitFile(fixture.repository, 'audit.mjs', "import './checks.mjs';\nimport { formatLabel } from './src/label.mjs';\n" +
        "import assert from 'node:assert/strict';\nassert.equal(formatLabel('  Bea  '), 'Bea');\n");
      Object.assign(fixture.plan, { schema_version: 2, tasks: tasks.map(task => ({
        ...task, agent: { ...task.agent, model: 'mock', effort: 'low' }
      })) });
      fixture.plan.run.max_parallel = 2;
      scope!.permissionPermit = { allowedProfileIds: ['workspace', 'read-only'], writableRoots: [fixture.trees], allowedReviewers: ['user'] };
    }, runtime, undefined, undefined, { enabled: false, threshold: 20, lowMaximum: 1 }, 'managed-session');
    const integration = f.store.plan('run')!.pin.integrationCwd;
    const instruct = async (taskId: string, text: string) => {
      const target = await f.create(taskId);
      t.after(() => runtime.stop(target, 'test_cleanup'));
      await f.call('send_instruction', { taskId, target, agent: { model: 'mock', effort: 'low' }, text: text + ' fixture-parallel-completion' });
      return target as WorkerRef;
    };
    const check = (cwd: string, names: string[], args = ['checks.mjs', ...names]) => {
      const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true });
      assert.ifError(result.error);
      assert.notEqual(result.status, null);
      return names.map(name => ({ name, command: ['node', ...args].join(' '), exit_code: result.status,
        result: result.status === 0 ? 'passed' as const : 'failed' as const,
        evidence_refs: [(result.status === 0 ? result.stdout : result.stderr).trim().slice(0, 200)] }));
    };
    const submit = async (worker: WorkerRef, observations: ReturnType<typeof check>, success: boolean) => {
      const a = f.store.gitAssignment(worker.attemptId)!;
      const reportRef = f.ref().operationId;
      const activeTurn = path.join(a.cwd, 'active-turn.txt'), completeTurn = path.join(a.cwd, 'complete-turn');
      const turnId = readFileSync(activeTurn, 'utf8');
      await f.call('report', { operationId: reportRef, taskId: a.taskId, report: {
        task_id: a.taskId, worker_id: worker.workerId, attempt_id: worker.attemptId, actor_id: worker.threadId,
        status: success ? 'completed' : 'failed', base_sha: a.baseSha, candidate_sha: null, branch: a.branch,
        push_result: { status: 'not_attempted', remote: 'origin', branch: a.branch }, checks: observations,
        summary: success ? 'Assigned checks passed' : 'Nonempty labels must preserve the trimmed input',
        remaining: success ? [] : ['Correct formatLabel']
      } }, { actor: worker, turnId });
      writeFileSync(completeTurn, '');
      for (let i = 0; i < 100 && !runtime.completedTurn(worker); i++) await delay(50);
      assert.equal(runtime.completedTurn(worker), turnId);
      f.store.completedTurn(worker, turnId);
      await f.broker.releaseCompleted('run', worker);
      unlinkSync(activeTurn);
      unlinkSync(completeTurn);
      return reportRef;
    };
    const save = async (worker: WorkerRef, implementation: string) => {
      const a = f.store.gitAssignment(worker.attemptId)!;
      mkdirSync(path.join(a.cwd, 'src'), { recursive: true });
      writeFileSync(path.join(a.cwd, 'src', a.taskId + '.mjs'), implementation);
      const observations = check(a.cwd, [a.taskId]);
      assert.equal(observations[0].result, 'passed', observations[0].evidence_refs[0]);
      const reportRef = await submit(worker, observations, true);
      const saveRef = f.ref().operationId;
      const saved = await f.call('save_worker_changes', { taskId: a.taskId, target: worker, expectedHead: a.baseSha,
        operationId: saveRef, reportRef, message: 'Implement ' + a.taskId });
      const sha = git(a.cwd, 'rev-parse', 'HEAD');
      assert.equal(saved.candidateSha, sha);
      assert.equal(git(f.remote, 'rev-parse', 'refs/heads/' + a.branch), sha);
      await f.call('record_decision', { taskId: a.taskId, decision: 'accept_candidate', candidateSha: sha,
        evidenceRefs: [reportRef, saveRef], checks: check(a.cwd, [a.taskId]).map(c => ({ ...c, checked_sha: sha })) });
      return sha;
    };
    const progress = async () => f.call('write_progress', { expectedFileHash: (await f.status()).plan.fileHash });
    const integrate = async (taskId: string, inputCandidateShas: string[], names: string[]) => {
      await f.call('record_decision', { taskId, decision: 'prepare_integration', inputCandidateShas, evidenceRefs: [] });
      for (const sha of inputCandidateShas) git(integration, 'merge', '--no-edit', sha);
      const sha = git(integration, 'rev-parse', 'HEAD');
      const outcomes = check(integration, names);
      assert.equal(outcomes[0].result, 'passed', outcomes[0].evidence_refs[0]);
      const required = taskId === 'entry'
        ? [...outcomes.filter(c => c.name !== 'audit'), ...check(integration, ['audit'], ['audit.mjs', 'audit'])]
        : outcomes;
      const verified = [...required, { ...outcomes[0], name: 'integration' }].map(c => ({ ...c, checked_sha: sha }));
      await f.call('record_decision', { taskId, decision: 'accept_integration', integrationSha: sha, checks: verified, evidenceRefs: [] });
      await progress();
      return sha;
    };

    assert.deepEqual((await f.status()).plan.eligible, ['label', 'status']);
    const label = await instruct('label', 'Implement formatLabel'), status = await instruct('status', 'Implement formatStatus');
    assert.equal((await f.status()).capacity.activeWorkers, 2);
    const labelSha = await save(label, failedAudit ? "export const formatLabel = s => s.trim() ? 'Ada' : '(untitled)';"
      : "export const formatLabel = s => s.trim() || '(untitled)';");
    if (failedAudit) await integrate('label', [labelSha], ['label']);
    await assert.rejects(f.create('audit'));
    const statusSha = await save(status, "export const formatStatus = done => done ? 'done' : 'pending';");
    const reviewedSha = await integrate('status', failedAudit ? [statusSha] : [labelSha, statusSha], ['label', 'status', 'audit']);
    assert.deepEqual((await f.status()).plan.eligible, ['audit']);
    const audit = await instruct('audit', 'Review both functions at ' + reviewedSha);
    const reviewed = f.store.gitAssignment(audit.attemptId)!;
    assert.equal(reviewed.baseSha, reviewedSha);
    const auditChecks = check(reviewed.cwd, ['audit'], ['audit.mjs', 'audit']).map(c => ({ ...c, checked_sha: reviewedSha }));
    assert.equal(auditChecks[0].result, failedAudit ? 'failed' : 'passed');
    const reportRef = await submit(audit, auditChecks, !failedAudit);
    const accept = () => f.call('record_decision', { taskId: 'audit', decision: 'accept_review', integrationSha: reviewedSha, evidenceRefs: [reportRef] });
    await assert.rejects(f.create('entry'));
    if (failedAudit) {
      await assert.rejects(accept());
      assert.deepEqual((await f.status()).plan.eligible, []);
      await assert.rejects(f.create('entry'));
    } else {
      await accept();
      await progress();
      assert.deepEqual((await f.status()).plan.eligible, ['entry']);
      const entry = await instruct('entry', 'Implement formatEntry');
      const entrySha = await save(entry, "import {formatLabel} from './label.mjs'; import {formatStatus} from './status.mjs'; " +
        "export const formatEntry = (s, done) => formatLabel(s) + ' [' + formatStatus(done) + ']';");
      const finalSha = await integrate('entry', [entrySha], ['label', 'status', 'audit', 'entry']);
      await f.call('record_decision', { taskId: 'entry', decision: 'finish', evidenceRefs: [] });
      assert.equal(f.store.run('run').state, 'completed');
      assert.ok(readFileSync(f.planPath, 'utf8').includes('entry: integrated ' + finalSha));
      t.diagnostic('Final integration SHA ' + finalSha);
    }
    assert.deepEqual(workerRequests, []);
    const attempts = f.store.attempts('run');
    assert.equal(attempts.length, failedAudit ? 3 : 4);
    for (const attempt of attempts) {
      const registration = JSON.parse(attempt.registration);
      assert.deepEqual(registration.settings.permissions.writableRoots, registration.taskId === 'audit' ? [] : [registration.cwd]);
      assert.equal(attempt.state, 'completed');
      const stop = JSON.parse(attempt.stop_result!);
      assert.equal(stop.state, 'stopped');
      assert.ok(stop.evidenceRefs.includes('native_job_empty'));
    }
    const observed = recordedWorkflow(path.join(f.root, 'state'), 'run');
    assert.equal(observed.workers.length, attempts.length);
    assert.equal(observed.reports.length, attempts.length);
    assert.equal(observed.reports.find(report => report.reportRef === reportRef)?.status, failedAudit ? 'failed' : 'completed');
    assert.ok(observed.workers.every(worker => worker.stopResult === 'stopped'));
    assert.deepEqual(observed.workerRequestsByKind, []);
    const observedAudit = observed.tasks.find(task => task.taskId === 'audit');
    assert.equal(observedAudit?.reviewReportRef, failedAudit ? null : reportRef);
    const observedLabel = observed.tasks.find(task => task.taskId === 'label');
    assert.equal(observedLabel?.candidateSha, labelSha);
    assert.ok(observedLabel?.editReportRef && observedLabel?.saveRef);
  });
}

async function editedReport(f: Awaited<ReturnType<typeof managedPlan>>) {
  const worker = await f.create('A');
  const a=f.store.gitAssignment(worker.attemptId)!;
  await f.call('send_instruction',{taskId:'A',target:worker,agent:{model:'mock',effort:'low'},text:'Edit a.txt'});
  writeFileSync(path.join(a.cwd,'a.txt'),'scoped change');
  git(a.cwd,'diff','--check');
  const reportRef = f.ref().operationId;
  const report = { task_id:'A', worker_id:worker.workerId, attempt_id:worker.attemptId, actor_id:worker.threadId,
    status:'completed', base_sha:a.baseSha, candidate_sha:null, branch:a.branch,
    push_result:{status:'not_attempted', remote:'origin', branch:a.branch}, summary:'edited',
    checks:[{...checks[0],command:'git diff --check'}], remaining:[] };
  await f.call('report', { operationId:reportRef, taskId:'A', report }, {actor:worker, turnId:'done'});
  const save = { taskId:'A', target:worker, expectedHead:a.baseSha, message:'Save assigned change', reportRef };
  return { a, worker, reportRef, save };
}

test('Coordinator saves the completed turn and binds acceptance to its save and checked SHA', async t => {
  const f = await managedPlan(t);
  const instructions = t.mock.method(f.runtime,'send');
  const {a, worker, reportRef, save} = await editedReport(f);
  const instruction = instructions.mock.calls[0].arguments[1] ?? '';
  assert.match(instruction,/"candidate_sha":null/);
  assert.match(instruction,/"status":"not_attempted"/);
  await assert.rejects(f.call('save_worker_changes',save));
  assert.equal(git(a.cwd,'rev-parse','HEAD'), a.baseSha);
  f.store.completedTurn(worker,'done');
  await assert.rejects(f.call('save_worker_changes',save));
  await f.broker.releaseCompleted('run',worker);
  const decision = {taskId:'A', decision:'accept_candidate', candidateSha:a.baseSha, evidenceRefs:[reportRef]};
  await assert.rejects(f.call('record_decision', decision));
  f.store.createRun('other-run');
  const foreign = {runId:'other-run', operationId:'another-run-report', expectedRevision:0};
  const other = {...worker, attemptId:'other-attempt', threadId:'other-thread'};
  const reg = JSON.parse(f.store.attempts('run')[0].registration);
  f.store.register({...reg, cwd:f.repository, taskId:'other-task', runId:foreign.runId, assignmentId:'other-assignment',
    worker:other, binding:{...reg.binding,worker:other}});
  f.store.prepareOperation(foreign,'a'.repeat(64));
  f.store.saveReport(foreign,other,'done',f.store.latestReport('run',worker.attemptId)!.report);
  await assert.rejects(f.call('save_worker_changes',{...save, reportRef:foreign.operationId}),/completed turn report/);
  const op = {...f.ref(), ...save};
  const saved = await f.call('save_worker_changes',op);
  assert.equal(git(a.cwd,'ls-remote','origin','refs/heads/'+a.branch).split(/\s/)[0],saved.candidateSha);
  assert.deepEqual(await f.call('save_worker_changes',op),saved);
  const accept = {...decision, candidateSha:saved.candidateSha, evidenceRefs:[op.operationId, reportRef]};
  await assert.rejects(f.call('record_decision',{...accept, checks:[{...checks[0], checked_sha:a.baseSha}]}));
  const verified = [{...checks[0], checked_sha:saved.candidateSha}];
  for (const incomplete of [{command:' '},{evidence_refs:[' ']}]) {
    await assert.rejects(f.call('record_decision',{...accept, checks:[{...verified[0],...incomplete}]}));
  }
  await assert.rejects(f.call('record_decision',{...accept, checks:verified, evidenceRefs:[reportRef]}));
  git(a.cwd,'diff','--check',a.baseSha,saved.candidateSha);
  await f.call('record_decision',{...accept, checks:verified});
  await assert.rejects(f.call('record_decision',{...accept, checks:[{...verified[0],evidence_refs:['replacement']}]}),/already accepted/);
  assert.deepEqual(f.store.planStates('run').A.candidate?.checks,verified);
  assert.deepEqual((await f.status()).plan.eligible,[]);
  git(f.store.plan('run')!.pin.integrationCwd,'merge','--ff-only',saved.candidateSha);
  await f.call('record_decision',{taskId:'A', decision:'accept_integration', integrationSha:saved.candidateSha, checks:verified, evidenceRefs:[]});
  assert.deepEqual((await f.status()).plan.eligible,['B']);
});
for (const failure of ['checkpoint persisted', 'lost acknowledgement', 'stopped after push', 'push rejected', 'remote advanced'] as const) {
  test(`Coordinator reconciles the original candidate after ${failure}`, async t => {
    const f = await managedPlan(t), {a, worker, save} = await editedReport(f);
    f.store.completedTurn(worker,'done'); await f.broker.releaseCompleted('run',worker);
    const op = {...f.ref(), ...save}, ref = 'refs/heads/' + a.branch;
    const hook = path.join(f.remote,'hooks','pre-receive');
    const pushRejected = failure === 'push rejected' || failure === 'remote advanced';
    if (!pushRejected) {
      const persist = f.store.operationResult.bind(f.store);
      t.mock.method(f.store,'operationResult',(id: string, state: Parameters<typeof persist>[1], result: unknown) => {
        if (id === op.operationId && state === 'settled' && failure !== 'checkpoint persisted') throw new Error('response lost');
        persist(id,state,result);
        if (id === op.operationId && state === 'sent_unknown' && failure === 'checkpoint persisted') throw new Error('response lost');
      });
    } else writeFileSync(hook,'#!/bin/sh\nexit 1\n',{mode:0o755});
    await assert.rejects(f.call('save_worker_changes',op),pushRejected ? /push/ : /response lost/);
    const record = f.store.operation(op.operationId);
    assert.equal(record.state,'sent_unknown');
    const candidate = JSON.parse(record.result!).candidateSha;
    assert.notEqual(candidate,a.baseSha);
    assert.equal(git(a.cwd,'rev-parse','HEAD'),failure === 'checkpoint persisted' ? a.baseSha : candidate);
    assert.deepEqual((await f.status()).plan.eligible,[]);
    if (!pushRejected) t.mock.restoreAll();
    else unlinkSync(hook);
    if (failure === 'remote advanced') {
      const other = commitFile(f.repository,'original.txt','other');
      git(f.repository,'push','origin',other+':'+ref);
      await assert.rejects(f.call('save_worker_changes',op));
      assert.equal(git(f.remote,'rev-parse',ref),other);
    } else {
      if (failure === 'stopped after push') {
        await f.broker.stopRun('run');
        await f.controller.resumeFromControl('resume', f.controller.startPreview().scopeHash);
        assert.equal(f.store.operation(op.operationId).state,'settled');
      }
      assert.equal((await f.call('save_worker_changes',op)).candidateSha,candidate);
      assert.equal(git(f.remote,'rev-parse',ref),candidate);
    }
    assert.equal(git(a.cwd,'rev-list','--count',a.baseSha+'..HEAD'),'1');
  });
}

test('stopped and superseded attempts cannot save their reported edits', async t => {
  const f = await managedPlan(t), {a, worker, save} = await editedReport(f);
  await f.call('retire_worker',{target:worker});
  await assert.rejects(f.call('save_worker_changes',save));
  await f.call('record_decision',{taskId:'A', decision:'handoff_new', evidenceRefs:[]});
  await f.create('A');
  await assert.rejects(f.call('save_worker_changes',save));
  assert.equal(git(a.cwd,'rev-parse','HEAD'),a.baseSha);
});
test('a hold or a different completed turn leaves the reported worktree untouched', async t => {
  const f = await managedPlan(t), {a, worker, save} = await editedReport(f);
  f.store.completedTurn(worker,'later-turn'); await f.broker.releaseCompleted('run',worker);
  await assert.rejects(f.call('save_worker_changes',save),/completed turn report/);
  f.store.completedTurn(worker,'done');
  const c = coordination(f), decision = c.propose('A');
  c.control.holdTask(f.ref(),'A',decision.id);
  await assert.rejects(f.call('save_worker_changes',save),/current writable assignment/);
  assert.equal(git(a.cwd,'rev-parse','HEAD'),a.baseSha);
  assert.equal(git(a.cwd,'diff','--cached','--name-only'),'');
  assert.equal(git(f.remote,'for-each-ref','refs/heads/'+a.branch),'');
});
function coordination(f: Awaited<ReturnType<typeof parallel>>) {
  const control = new PlanControl(f.store, 'run', () => f.broker.canWake('run'));
  const decisions = new DecisionService(f.store, () => {}, () => undefined);
  const propose = (taskId: string, blocking = true) => decisions.propose(f.ref(), {
    taskIds: [taskId], blockingTaskIds: blocking ? [taskId] : [], kind: 'consultation', recipient: 'coordinator',
    planHash: f.store.plan('run')!.snapshot.planHash, question: 'Continue the approved work?',
    options: [{ id: 'resume', label: 'Resume', description: 'Continue within the current plan' }, { id: 'deny', label: 'Hold', description: 'Keep held' }], allowFreeText: true
  });
  return { control, decisions, propose };
}

test('two_held_tasks_allow_independent_work_after_safe_parking', async t => {
  const f = await parallel(t, f => {
    f.plan.tasks[0].conflicts_with = ['lockfile'];
    f.plan.tasks.find(task => task.id === 'D')!.conflicts_with = [];
    f.plan.tasks.push({ ...f.plan.tasks[0], id: 'E', scope: ['a.txt/nested'] });
    f.plan.tasks.push({ ...f.plan.tasks[0], id: 'F', scope: ['f.txt'] });
  });
  const c = coordination(f), a = await f.create('A'), b = await f.create('B');
  const dirty = path.join(f.store.gitAssignment(a.attemptId)!.cwd, 'draft.txt'); writeFileSync(dirty, 'keep');
  const da = c.propose('A'), db = c.propose('B');
  c.control.holdTask(f.ref(), 'A', da.id); c.control.holdTask(f.ref(), 'B', db.id);
  await assert.rejects(f.create('D'));
  await f.broker.parkTask('run', a); await f.broker.parkTask('run', b);
  assert.equal(f.store.run('run').state, 'active');
  await assert.rejects(f.create('E')); await assert.rejects(f.create('F')); await assert.rejects(f.create('C'));
  await f.create('D');
  assert.equal(readFileSync(dirty, 'utf8'), 'keep');
  assert.equal((await f.status()).plan.tasks.A.state, 'held');
  assert.equal(f.store.attempts('run').filter(row => !['stopped', 'completed'].includes(row.state)).length, 1);
});

test('nonblocking_consultation_keeps_worker_running', async t => {
  const f = await parallel(t), c = coordination(f), a = await f.create('A');
  const decision = c.propose('A', false);
  assert.throws(() => c.control.holdTask(f.ref(), 'A', decision.id));
  await f.broker.dispatch({ kind: 'send', ref: f.ref(), worker: a, text: 'independent work' });
  assert.equal(f.store.attempts('run')[0].state, 'running'); assert.deepEqual(f.store.requests('run'), []);
  assert.equal(f.store.coordinationDecision('run', decision.id)!.decision.state, 'pending');
  c.propose('A');
  await assert.rejects(f.broker.dispatch({ kind: 'send', ref: f.ref(), worker: a, text: 'blocked work' }));
});

test('unassigned_task_can_be_held_and_explicitly_resumed_before_git_initialization', async t => {
  const f = await parallel(t), c = coordination(f), d = c.propose('A');
  assert.equal(c.control.holdTask(f.ref(), 'A', d.id).releasedExecutionSlot, true);
  await assert.rejects(f.create('A'));
  c.decisions.resolveCoordinator(f.ref(), d.id, { optionId: 'resume' });
  c.control.resumeTask(f.ref(), 'A', d.id);
  await f.create('A'); assert.equal(f.store.attempts('run').length, 1);
});

test('execution_hold_survives_answer_row_release_and_broker_restart', async t => {
  const cleanup: (() => void)[] = [], f = await parallel({ after(fn) { cleanup.push(fn); } });
  let closed = false; t.after(() => { if (!closed) cleanup[0](); });
  const c = coordination(f), a = await f.create('A'), d = c.propose('A');
  c.control.holdTask(f.ref(), 'A', d.id); await f.broker.parkTask('run', a);
  c.decisions.resolveCoordinator(f.ref(), d.id, { optionId: 'resume' });
  cleanup[0](); closed = true;
  const restored = new Store(path.join(f.root, 'state'), f.repository); t.after(() => restored.close());
  const control = new PlanControl(restored, 'run');
  assert.deepEqual(restored.taskHolds('run', 'A'), []);
  assert.equal(restored.planStates('run').A.state, 'held'); assert.equal(restored.planStates('run').A.hold?.releasedExecutionSlot, true);
  assert.equal(restored.run('run').state, 'needs_reconcile'); assert.deepEqual((await control.status()).eligible, []);
  assert.throws(() => control.resumeTask({ runId: 'run', operationId: 'restart-resume', expectedRevision: restored.run('run').revision }, 'A', d.id));
});

test('hold_answer_and_safe_parking_are_separate_idempotent_gates', async t => {
  const f = await parallel(t), c = coordination(f), a = await f.create('A');
  const d = c.propose('A'), ref = f.ref();
  const first = c.control.holdTask(ref, 'A', d.id);
  assert.deepEqual(c.control.holdTask(ref, 'A', d.id), first);
  let finish!: (value: any) => void;
  t.mock.method(f.runtime, 'stop', () => new Promise(resolve => { finish = resolve; }));
  const parking = f.broker.parkTask('run', a);
  c.decisions.resolveCoordinator(f.ref(), d.id, { optionId: 'resume' });
  assert.deepEqual(f.store.taskHolds('run', 'A'), []);
  assert.throws(() => c.control.resumeTask(f.ref(), 'A', d.id));
  assert.equal(f.store.planStates('run').A.hold?.releasedExecutionSlot, false);
  await assert.rejects(f.broker.dispatch({ kind: 'send', ref: f.ref(), worker: a, text: 'old' }));
  finish({ worker: a, state: 'stopped', evidenceRefs: ['confirmed'] }); await parking;
  const resume = f.ref(); c.control.resumeTask(resume, 'A', d.id); c.control.resumeTask(resume, 'A', d.id);
  const next = await f.create('A'); assert.notEqual(next.attemptId, a.attemptId); assert.notEqual(next.threadId, a.threadId);
  assert.equal(f.store.gitAssignment(next.attemptId)!.cwd, f.store.gitAssignment(a.attemptId)!.cwd);
  await assert.rejects(f.broker.dispatch({ kind: 'send', ref: f.ref(), worker: a, text: 'stale' }));
});

test('closed_negative_and_free_text_answers_never_resume_held_work', async t => {
  for (const outcome of ['cancelled', 'superseded', 'deny', 'text', 'amended'] as const) {
    const f = await parallel(t), c = coordination(f), a = await f.create('A'), d = c.propose('A');
    c.control.holdTask(f.ref(), 'A', d.id); await f.broker.parkTask('run', a);
    if (outcome === 'cancelled' || outcome === 'superseded') c.decisions.close(f.ref(), d.id, outcome);
    else c.decisions.resolveCoordinator(f.ref(), d.id, outcome === 'text' ? { text: 'maybe' } : { optionId: outcome === 'amended' ? 'resume' : 'deny', ...(outcome === 'amended' ? { text: 'change the plan' } : {}) });
    assert.throws(() => c.control.resumeTask(f.ref(), 'A', d.id));
    await assert.rejects(f.create('A')); assert.equal(f.store.planStates('run').A.state, 'held');
  }
});

test('held_scope_and_stale_results_remain_fenced', async t => {
  const f = await parallel(t), c = coordination(f), a = await f.create('A'), d = c.propose('A');
  c.control.holdTask(f.ref(), 'A', d.id); await f.broker.parkTask('run', a);
  c.decisions.resolveCoordinator(f.ref(), d.id, { optionId: 'resume' });
  await assert.rejects(f.call('record_decision', { taskId: 'A', decision: 'handoff_new', evidenceRefs: [] }));
  await assert.rejects(f.complete('A', a));
  f.plan.tasks[0].completion = ['new-check']; f.savePlan();
  assert.throws(() => c.control.resumeTask(f.ref(), 'A', d.id));
  await assert.rejects(f.create('C')); assert.equal(f.store.planStates('run').A.state, 'held');
});

test('resume_rechecks_dirty_git_other_decisions_and_operation_identity', async t => {
  const f = await parallel(t), c = coordination(f), a = await f.create('A'), d = c.propose('A');
  c.control.holdTask(f.ref(), 'A', d.id); await f.broker.parkTask('run', a);
  c.decisions.resolveCoordinator(f.ref(), d.id, { optionId: 'resume' });
  const other = c.propose('A');
  assert.throws(() => c.control.resumeTask(f.ref(), 'A', d.id));
  c.control.holdTask(f.ref(), 'A', other.id); c.decisions.resolveCoordinator(f.ref(), other.id, { optionId: 'resume' });
  const dirty = path.join(f.store.gitAssignment(a.attemptId)!.cwd, 'draft.txt'); writeFileSync(dirty, 'keep');
  assert.throws(() => c.control.resumeTask(f.ref(), 'A', d.id)); assert.equal(readFileSync(dirty, 'utf8'), 'keep');
  unlinkSync(dirty);
  const ref = f.ref(); c.control.resumeTask(ref, 'A', d.id);
  assert.throws(() => c.control.resumeTask(ref, 'A', other.id), /payload/);
  writeFileSync(dirty, 'late edit'); await assert.rejects(f.create('A')); assert.equal(readFileSync(dirty, 'utf8'), 'late edit');
});

test('unknown_or_wrong_owner_parking_never_releases_execution_slot', async t => {
  for (const mismatch of [false, true]) {
    const f = await parallel(t), c = coordination(f), a = await f.create('A');
    const d = c.propose('A'); c.control.holdTask(f.ref(), 'A', d.id);
    t.mock.method(f.runtime, 'stop', async () => ({ worker: mismatch ? { ...a, ownerEpoch: 'other' } : a, state: mismatch ? 'stopped' : 'unknown', evidenceRefs: ['fixture'] }));
    const result = await f.broker.parkTask('run', a);
    assert.equal(result.state, 'unknown'); assert.equal(f.store.planStates('run').A.hold?.releasedExecutionSlot, false);
    await assert.rejects(f.create('D')); assert.equal(f.store.run('run').state, 'stopped');
  }
});

test('unknown_parking_fences_parent_wake_and_stops_independent_attempts', async t => {
  const f = await parallel(t), c = coordination(f), a = await f.create('A'), b = await f.create('B'), d = c.propose('A');
  c.control.holdTask(f.ref(), 'A', d.id);
  let fenced = false;
  const broker = new Broker(f.store, f.runtime, async blocked => { fenced = blocked; });
  t.mock.method(f.runtime, 'stop', async (worker: typeof a) => ({ worker, state: worker.attemptId === a.attemptId ? 'unknown' : 'stopped', evidenceRefs: ['fixture'] }));
  const generation = f.store.run('run').stop_generation;
  assert.equal((await broker.parkTask('run', a)).state, 'unknown');
  assert.equal(fenced, true); assert(f.store.run('run').stop_generation > generation);
  assert.equal(f.store.attempts('run').find(row => row.id === b.attemptId)!.state, 'stopped');
  assert.equal(f.store.planStates('run').A.hold?.releasedExecutionSlot, false);
});

test('held_task_resumes_after_independent_integration_and_keeps_final_sha_checks', async t => {
  const f = await parallel(t), c = coordination(f), a = await f.create('A'), d = c.propose('A');
  c.control.holdTask(f.ref(), 'A', d.id); await f.broker.parkTask('run', a);
  const b = await f.create('B'), one = await f.complete('B', b, 'independent');
  const integrate = async (taskId: string, candidate: string, fastForward: boolean) => {
    await f.call('record_decision', { taskId, decision: 'accept_candidate', candidateSha: candidate, evidenceRefs: [] });
    await f.call('record_decision', { taskId, decision: 'prepare_integration', inputCandidateShas: [candidate], evidenceRefs: [] });
    const cwd = f.store.plan('run')!.pin.integrationCwd;
    git(cwd, 'merge', fastForward ? '--ff-only' : '--no-edit', candidate);
    const sha = git(cwd, 'rev-parse', 'HEAD');
    await f.call('record_decision', { taskId, decision: 'accept_integration', integrationSha: sha, checks: [...checks, { ...checks[0], name: 'integration' }].map(check => ({ ...check, checked_sha: sha })), evidenceRefs: [] });
    return { cwd, sha };
  };
  await integrate('B', one.sha, true);
  c.decisions.resolveCoordinator(f.ref(), d.id, { optionId: 'resume' });
  c.control.resumeTask(f.ref(), 'A', d.id);
  const next = await f.create('A'); assert.notEqual(next.attemptId, a.attemptId);
  const two = await f.complete('A', next, 'resumed');
  const final = await integrate('A', two.sha, false);
  assert.equal(git(final.cwd, 'show', `${final.sha}:a.txt`), 'resumed');
  assert.equal(git(final.cwd, 'show', `${final.sha}:b.txt`), 'independent');
  assert.equal(f.store.planStates('run').A.integrationSha, final.sha);
});

test('parked_history_worktree_cannot_be_assigned_to_another_task', async t => {
  const f = await parallel(t, f => { f.plan.tasks[1].depends_on = ['A']; f.plan.tasks[2].depends_on = ['A']; });
  const c = coordination(f), a = await f.create('A'), one = await f.complete('A', a);
  await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: one.sha, evidenceRefs: [] });
  await f.call('record_decision', { taskId: 'A', decision: 'prepare_integration', inputCandidateShas: [one.sha], evidenceRefs: [] });
  git(f.store.plan('run')!.pin.integrationCwd, 'merge', '--ff-only', one.sha);
  await f.call('record_decision', { taskId: 'A', decision: 'accept_integration', integrationSha: one.sha, checks: [...checks, { ...checks[0], name: 'integration' }].map(check => ({ ...check, checked_sha: one.sha })), evidenceRefs: [] });
  for (const taskId of ['B', 'C']) await f.call('record_decision', { taskId, decision: 'continue_same', sourceTaskId: 'A', evidenceRefs: [] });
  const b = await f.create('B'), d = c.propose('B'); c.control.holdTask(f.ref(), 'B', d.id); await f.broker.parkTask('run', b);
  // C has disjoint scope, but its chosen history would reuse B's reserved worktree.
  await assert.rejects(f.create('C'));
  assert.equal(f.store.planStates('run').B.state, 'held'); assert.equal(f.store.run('run').state, 'active');
});

test('parking_confirms_native_job_without_stopping_independent_worker', { timeout: 120000 }, async t => {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), 'mc04-native-'));
  const hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe'), realExe = path.resolve('.local/chat-control-build/MockCodex.exe');
  const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const runtime = new WorkerRuntime({ stateDirectory, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: stateDirectory, fixture: true });
  const f = await planControllerFixture(t, f => { f.plan.run.max_parallel = 2; f.plan.tasks[1].depends_on = []; }, runtime);
  const a = await f.create('A'), b = await f.create('B');
  t.after(async () => { await runtime.stop(a, 'test_cleanup'); await runtime.stop(b, 'test_cleanup'); });
  await runtime.send(a, 'fixture-start-marker'); await runtime.send(b, 'fixture-start-marker');
  const markerA = path.join(f.store.gitAssignment(a.attemptId)!.cwd, 'worker.marker'), markerB = path.join(f.store.gitAssignment(b.attemptId)!.cwd, 'worker.marker');
  for (let i = 0; i < 100 && (!existsSync(markerA) || !existsSync(markerB)); i++) await delay(50);
  assert(existsSync(markerA) && existsSync(markerB));
  const d = await f.call('propose_decision', { proposal: { taskIds: ['A'], blockingTaskIds: ['A'], kind: 'consultation', recipient: 'coordinator', planHash: f.store.plan('run')!.snapshot.planHash,
    question: 'Hold current work?', options: [{ id: 'resume', label: 'Resume', description: 'Continue current plan' }], allowFreeText: false } });
  const result = await f.call('hold_task', { taskId: 'A', decisionId: d.id }); assert.equal(result.releasedExecutionSlot, true);
  assert(JSON.parse(f.store.attempts('run').find(row => row.id === a.attemptId)!.stop_result!).evidenceRefs.includes('native_job_empty'));
  const lengthA = readFileSync(markerA).length, lengthB = readFileSync(markerB).length;
  await delay(2100); assert.equal(readFileSync(markerA).length, lengthA); assert(readFileSync(markerB).length > lengthB);
  assert.equal(f.store.planStates('run').A.hold?.releasedExecutionSlot, true); assert.equal(f.store.run('run').state, 'active');
});

test('limits_workers_to_two_and_blocks_dependencies', async t => {
  const f = await parallel(t);
  const [a, b] = await Promise.all([f.create('A'), f.create('B')]);
  assert.notEqual(a.attemptId, b.attemptId);
  await assert.rejects(f.create('D')); await assert.rejects(f.create('C')); await assert.rejects(f.create('A'));
  assert.equal(f.store.attempts('run').length, 2);
  assert.equal(f.store.planStates('run').D, undefined);
});

test('parallel_reservation_rejects_scope_and_shared_resource_overlap', async t => {
  for (const resource of [false, true]) {
    const f = await parallel(t, f => {
      if (resource) { f.plan.tasks[0].conflicts_with = ['lockfile']; f.plan.tasks[1].conflicts_with = ['lockfile']; }
      else { f.plan.tasks[0].scope = ['src']; f.plan.tasks[1].scope = ['SRC/nested']; }
    });
    await f.create('A'); await assert.rejects(f.create('B')); await f.create('D');
    assert.equal(f.store.attempts('run').length, 2);
  }
});

async function candidates(t: Parameters<typeof planControllerFixture>[0]) {
  const f = await parallel(t), a = await f.create('A'), b = await f.create('B');
  const one = await f.complete('A', a), two = await f.complete('B', b);
  for (const [taskId, result] of [['A', one], ['B', two]] as const) await f.call('record_decision', { taskId, decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  const inputCandidateShas = [one.sha, two.sha], cwd = f.store.plan('run')!.pin.integrationCwd;
  const prepare = () => f.call('record_decision', { taskId: 'B', decision: 'prepare_integration', inputCandidateShas, evidenceRefs: [] });
  return { ...f, a, b, one, two, inputCandidateShas, cwd, prepare };
}

test('candidate_is_fixed_during_review', async t => {
  const f = await candidates(t); await f.prepare();
  const next = commitFile(f.one.assignment.cwd, 'a.txt', 'changed after review'); git(f.one.assignment.cwd, 'push', 'origin', f.one.assignment.branch);
  git(f.cwd, 'merge', '--ff-only', f.one.sha); git(f.cwd, 'merge', '--no-edit', f.two.sha);
  const sha = git(f.cwd, 'rev-parse', 'HEAD');
  await assert.rejects(f.call('record_decision', { taskId: 'B', decision: 'accept_integration', integrationSha: sha, checks: [...checks, { ...checks[0], name: 'integration' }].map(c => ({ ...c, checked_sha: sha })), evidenceRefs: [] }));
  assert.notEqual(next, f.one.sha); assert.equal(f.store.planStates('run').A.state, 'candidate_accepted'); await assert.rejects(f.create('C'));
});

test('cancel_integration_releases_review_without_discarding_work', async t => {
  const f = await candidates(t); await f.prepare();
  writeFileSync(path.join(f.cwd, 'resolution.txt'), 'keep unfinished resolution');
  await f.call('record_decision', { taskId: 'B', decision: 'cancel_integration', evidenceRefs: [] });
  assert.equal(f.store.planStates('run').B.pendingIntegration, undefined);
  assert.equal(readFileSync(path.join(f.cwd, 'resolution.txt'), 'utf8'), 'keep unfinished resolution');
  await assert.rejects(f.create('D')); // Git remains dirty, even though review reservation is released.
  unlinkSync(path.join(f.cwd, 'resolution.txt'));
  await f.prepare();
});

test('earlier_candidate_drift_during_later_remote_check_is_rejected', async t => {
  const f = await candidates(t); await f.prepare();
  git(f.cwd, 'merge', '--ff-only', f.one.sha); git(f.cwd, 'merge', '--no-edit', f.two.sha);
  const sha = git(f.cwd, 'rev-parse', 'HEAD'), original = GitEvidence.prototype.verifyCandidate;
  let bChecks = 0;
  // Real verifier and Git; inject an external edit at the later async I/O boundary.
  t.mock.method(GitEvidence.prototype, 'verifyCandidate', async function(this: GitEvidence, ...args: Parameters<GitEvidence['verifyCandidate']>) {
    const result = await original.apply(this, args);
    if (args[0] === 'B' && ++bChecks === 2) writeFileSync(path.join(f.one.assignment.cwd, 'a.txt'), 'external edit during B verification');
    return result;
  });
  await assert.rejects(f.call('record_decision', { taskId: 'B', decision: 'accept_integration', integrationSha: sha, checks: [...checks, { ...checks[0], name: 'integration' }].map(c => ({ ...c, checked_sha: sha })), evidenceRefs: [] }));
  assert.equal(f.store.planStates('run').A.state, 'candidate_accepted');
});

test('shared_history_reservation_rejects_second_reuser_without_stopping_first', async t => {
  const f = await parallel(t, f => {
    f.plan.tasks[1].depends_on = ['A']; f.plan.tasks[2].depends_on = ['A'];
  }), a = await f.create('A'), one = await f.complete('A', a);
  await f.call('record_decision', { taskId: 'A', decision: 'accept_candidate', candidateSha: one.sha, evidenceRefs: [] });
  await f.call('record_decision', { taskId: 'A', decision: 'prepare_integration', inputCandidateShas: [one.sha], evidenceRefs: [] });
  git(f.store.plan('run')!.pin.integrationCwd, 'merge', '--ff-only', one.sha);
  await f.call('record_decision', { taskId: 'A', decision: 'accept_integration', integrationSha: one.sha, checks: [...checks, { ...checks[0], name: 'integration' }].map(c => ({ ...c, checked_sha: one.sha })), evidenceRefs: [] });
  for (const taskId of ['B', 'C']) await f.call('record_decision', { taskId, decision: 'continue_same', sourceTaskId: 'A', evidenceRefs: [] });
  const b = await f.create('B'); await assert.rejects(f.create('C'));
  assert.equal(f.store.run('run').state, 'active');
  assert.equal(f.store.attempts('run').find(row => row.id === b.attemptId)!.state, 'idle');
  assert.equal(f.store.planStates('run').C.state, 'pending');
});

test('merge_requires_clean_integration_worktree', async t => {
  const f = await candidates(t), dirty = path.join(f.cwd, 'dirty.txt'); writeFileSync(dirty, 'preserve');
  await assert.rejects(f.prepare()); assert.equal(readFileSync(dirty, 'utf8'), 'preserve'); unlinkSync(dirty);
  const base = git(f.cwd, 'rev-parse', 'HEAD'); await f.prepare();
  assert.equal(f.store.planStates('run').B.pendingIntegration?.baseSha, base);
  await assert.rejects(f.create('D'));
});

test('unaccepted_integration_base_blocks_assignment_and_merge_preparation', async t => {
  const f = await candidates(t); commitFile(f.cwd, 'unexpected.txt', 'base drift');
  await assert.rejects(f.prepare()); await assert.rejects(f.create('D'));
});

test('conflict_resolution_requires_new_sha_checks', async t => {
  const f = await candidates(t); await f.prepare();
  git(f.cwd, 'merge', '--ff-only', f.one.sha); git(f.cwd, 'merge', '--no-edit', f.two.sha);
  const merged = git(f.cwd, 'rev-parse', 'HEAD');
  // A semantic resolution changes the result even without Git conflict markers.
  const resolved = commitFile(f.cwd, 'b.txt', 'uses A correctly');
  const accept = (input: unknown) => f.call('record_decision', { taskId: 'B', decision: 'accept_integration', integrationSha: resolved, checks: input, evidenceRefs: [] });
  await assert.rejects(accept(checks));
  await assert.rejects(accept([...checks, { ...checks[0], name: 'integration' }].map(c => ({ ...c, checked_sha: merged }))));
  await assert.rejects(accept(checks.map(c => ({ ...c, checked_sha: resolved }))));
  const verified = [...checks, { ...checks[0], name: 'integration' }].map(c => ({ ...c, checked_sha: resolved }));
  await accept(verified);
  const states = f.store.planStates('run');
  assert.equal(states.A.integrationSha, resolved); assert.equal(states.B.integrationSha, resolved);
  assert.deepEqual(states.B.integrationEvidence, { inputCandidateShas: f.inputCandidateShas, resultSha: resolved, checks: verified, acceptedByParentTurnId: 'parent-turn' });
  const c = await f.create('C'); assert.equal(f.store.gitAssignment(c.attemptId)!.baseSha, resolved);
});

test('internal_subagent_cannot_reserve_parallel_slot', async t => {
  const f = await parallel(t), a = await f.create('A');
  await assert.rejects(f.call('create_worker', { taskId: 'B' }, { actor: { ...a, threadId: 'internal-subagent' }, turnId: 'turn' }));
  assert.equal(f.store.attempts('run').length, 1); await f.create('B');
});

test('workers_have_separate_jobs_worktrees_branches_and_terminals', { timeout: 120000 }, async t => {
  const stateDirectory = mkdtempSync(path.join(tmpdir(), 'cc06-native-'));
  const hostExe = path.resolve('.local/chat-control-build/CodexWorkerHost.exe'), realExe = path.resolve('.local/chat-control-build/MockCodex.exe');
  const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  let bCompleted = false;
  const runtime = new WorkerRuntime({ stateDirectory, hostExe, hostSha256: sha(hostExe), realExe, realSha256: sha(realExe), authHome: stateDirectory, fixture: true }, (worker, state) => { if (worker.workerId === 'B' && state === 'completed') bCompleted = true; });
  const f = await planControllerFixture(t, f => { f.plan.run.max_parallel = 2; f.plan.tasks[1].depends_on = []; }, runtime);
  const a = await f.create('A'); t.after(() => runtime.stop(a, 'test_cleanup'));
  const b = await f.create('B'); t.after(() => runtime.stop(b, 'test_cleanup'));
  const rows = f.store.attempts('run').map(a => JSON.parse(a.registration));
  for (const key of ['hostPid', 'childPid', 'jobId', 'cwd', 'branch']) assert.notEqual(rows[0][key], rows[1][key]);
  assert.notEqual(rows[0].binding.terminalId, rows[1].binding.terminalId);
  assert.notEqual(a.threadId, b.threadId); assert.notEqual(a.ownerEpoch, b.ownerEpoch);
  await Promise.all([runtime.send(a, 'fixture-start-marker'), runtime.send(b, 'fixture-start-marker fixture-parallel-completion')]);
  const markerA = path.join(rows[0].cwd, 'worker.marker'), markerB = path.join(rows[1].cwd, 'worker.marker');
  for (let i = 0; i < 100 && (!existsSync(markerA) || !existsSync(markerB)); i++) await delay(50);
  assert(existsSync(markerA) && existsSync(markerB));
  await t.test('closing_A_spares_B_but_blocks_new_dispatch', async () => {
    const result = await f.broker.closeTerminal('run', rows[0].binding); assert.equal(result?.state, 'stopped');
    const beforeA = readFileSync(markerA).length, beforeB = readFileSync(markerB).length;
    await delay(2100); assert.equal(readFileSync(markerA).length, beforeA); assert(readFileSync(markerB).length > beforeB);
    assert.equal(f.broker.canWake('run'), false); await assert.rejects(f.create('A'));
    // The sibling can save its in-flight report after the run's stop fence.
    const turnId = readFileSync(path.join(rows[1].cwd, 'active-turn.txt'), 'utf8');
    const resultB = await f.complete('B', b, 'sibling completed', false, turnId);
    writeFileSync(path.join(rows[1].cwd, 'complete-turn'), 'done');
    for (let i = 0; i < 100 && !bCompleted; i++) await delay(50);
    assert(bCompleted); assert.equal(runtime.completedTurn(b), turnId); f.store.completedTurn(b, turnId);
    assert.equal((await f.broker.releaseCompleted('run', b)).state, 'stopped');
    assert.equal(f.store.latestReport('run', b.attemptId)?.turnId, turnId);
    assert.equal(git(resultB.assignment.cwd, 'rev-parse', 'HEAD'), resultB.sha);
    assert(readFileSync(markerA).length > 0); assert.equal(f.store.run('run').state, 'stopped');
  });
});

async function expanded(t: Parameters<typeof planControllerFixture>[0], maximum = 4) {
  const { expandedParallelPlan } = await import('./fixtures/parallel-git.js');
  return planControllerFixture(t, f => expandedParallelPlan(f, maximum));
}
async function proposeMaximum(f: Awaited<ReturnType<typeof expanded>>, maximum: number) {
  return f.call('propose_decision', { proposal: { taskIds: ['A', 'B', 'C', 'D'], blockingTaskIds: [], kind: 'parallelism', recipient: 'human',
    requestedMaximum: maximum, planHash: f.store.plan('run')!.snapshot.planHash, question: 'Independent tasks need more workers; approve the maximum?',
    options: [{ id: 'approve', label: 'Approve', description: 'Approve this run ceiling' }, { id: 'deny', label: 'Deny', description: 'Keep the current ceiling' }], allowFreeText: true } });
}
async function approveMaximum(f: Awaited<ReturnType<typeof expanded>>, maximum: number) {
  const decision = await proposeMaximum(f, maximum);
  const { humanDecisionForm: { form } } = await f.call('answer_consultation', { decisionId: decision.id });
  const input = { decision: form, answer: { optionId: 'approve' } };
  await f.controller.humanResponse(input, f.parent);
  await f.controller.humanResponse(input, f.parent); // Callback replay must settle once.
  return decision;
}

test('a quota drop during startup preserves three reserved workers under a human grant', async t => {
  const { expandedParallelPlan } = await import('./fixtures/parallel-git.js');
  const f=await planControllerFixture(t,file=>expandedParallelPlan(file,4),undefined,undefined,undefined,{enabled:true,threshold:20,lowMaximum:1});
  const update=(usedPercent:number)=>f.store.saveUsage('run',{status:'ok',account:'a'.repeat(64),ordinaryUsageAllowed:null,fetchedAt:Date.now(),
    windows:[{name:'primary',remainingPercent:100-usedPercent,usedPercent,windowDurationMins:null,resetsAt:null}]});
  update(79); await approveMaximum(f,4); const a=await f.create('A'), b=await f.create('B');
  const start = f.runtime.start.bind(f.runtime);
  t.mock.method(f.runtime,'start', async (args: Parameters<typeof start>[0]) => {
    assert.equal(f.store.capacity('run').activeWorkers,3);
    update(99);
    return start(args);
  });
  const c=await f.create('C');
  assert.equal(f.store.capacity('run').effectiveMaximum,1);
  for (const target of [a,b,c]) {
    assert.equal((await f.create('D')).state,'waiting_usage');
    await f.call('retire_worker',{target});
  }
  t.mock.restoreAll();
  assert((await f.create('D')).threadId);
});
test('third_worker_requires_current_human_grant', async t => {
  const f = await expanded(t); await f.create('A'); await f.create('B');
  assert.deepEqual((await f.status()).plan.eligible, []);
  await assert.rejects(f.create('C'));
  const decision = await proposeMaximum(f, 4);
  await assert.rejects(f.call('answer_consultation', { decisionId: decision.id, answer: { optionId: 'approve' } }));
  await assert.rejects(f.create('C'));
  const first = await f.call('answer_consultation', { decisionId: decision.id });
  const second = await f.call('answer_consultation', { decisionId: decision.id });
  await assert.rejects(f.controller.humanResponse({ decision: first.humanDecisionForm.form, answer: { optionId: 'approve' } }, f.parent));
  await f.controller.humanResponse({ decision: second.humanDecisionForm.form, answer: { optionId: 'approve', text: 'Use three instead' } }, f.parent);
  await assert.rejects(f.create('C')); // Changed text creates a fresh pending proposal.
  assert.equal(f.store.parallelismApproval('run'), undefined);
  await approveMaximum(f, 3); await f.create('C'); await assert.rejects(f.create('D'));
  f.store.createRun('other'); assert.throws(() => f.store.saveParallelismApproval('other', decision.id, 4));
  assert.equal((f.store as any).effectiveParallelLimit('other'), 2);
});

test('grant_four_allows_replacement_but_not_five', async t => {
  const f = await expanded(t, 5); await approveMaximum(f, 4);
  const a = await f.create('A'); await f.create('B'); await f.create('C'); await f.create('D');
  await assert.rejects(f.create('E'));
  await f.call('retire_worker', { target: a });
  const pending = await Promise.allSettled([f.create('E'), f.create('F')]);
  assert.equal(pending.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.store.attempts('run').filter(row => !['completed', 'stopped'].includes(row.state)).length, 4);
  await approveMaximum(f, 5);
  const remaining = pending[0].status === 'rejected' ? 'E' : 'F'; await f.create(remaining);
  assert.equal(f.store.attempts('run').filter(row => !['completed', 'stopped'].includes(row.state)).length, 5);
});

async function threeCandidates(t: Parameters<typeof planControllerFixture>[0]) {
  const f = await expanded(t, 3); await approveMaximum(f, 3);
  const workers = await Promise.all(['A', 'B', 'C'].map(id => f.create(id)));
  const results = [];
  for (const [i, worker] of workers.entries()) {
    const id = ['A', 'B', 'C'][i], result = await f.complete(id, worker, 'one', true, 'turn', [{ ...checks[0], name: id }]);
    results.push(result);
  }
  for (const [i, result] of results.entries()) await f.call('record_decision', { taskId: ['A', 'B', 'C'][i], decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  const inputs = results.map(result => result.sha), cwd = f.store.plan('run')!.pin.integrationCwd;
  await f.call('record_decision', { taskId: 'C', decision: 'prepare_integration', inputCandidateShas: inputs, evidenceRefs: [] });
  for (const sha of inputs) git(cwd, 'merge', '--no-edit', sha);
  const sha = git(cwd, 'rev-parse', 'HEAD');
  const verified = ['A', 'B', 'C', 'integration'].map(name => ({ ...checks[0], name, checked_sha: sha }));
  return { ...f, results, inputs, cwd, sha, verified };
}

test('three_candidates_are_pinned_and_checked_at_final_sha', async t => {
  const f = await threeCandidates(t);
  const accept = (checks: unknown) => f.call('record_decision', { taskId: 'C', decision: 'accept_integration', integrationSha: f.sha, checks, evidenceRefs: [] });
  await assert.rejects(accept(f.verified.slice(1)));
  await assert.rejects(accept(f.verified.map(check => ({ ...check, checked_sha: f.inputs[0] }))));
  await accept(f.verified);
  for (const id of ['A', 'B', 'C']) assert.equal(f.store.planStates('run')[id].integrationSha, f.sha);
  assert.deepEqual(f.store.planStates('run').C.integrationEvidence?.inputCandidateShas, f.inputs);
});

test('candidate_changed_during_integration_is_rejected', async t => {
  const f = await threeCandidates(t);
  commitFile(f.results[0].assignment.cwd, 'a.txt', 'changed'); git(f.results[0].assignment.cwd, 'push', 'origin', f.results[0].assignment.branch);
  await assert.rejects(f.call('record_decision', { taskId: 'C', decision: 'accept_integration', integrationSha: f.sha, checks: f.verified, evidenceRefs: [] }));
  for (const id of ['A', 'B', 'C']) assert.equal(f.store.planStates('run')[id].state, 'candidate_accepted');
});

test('human_grant_keeps_scope_and_shared_locks_and_counts_starting_reservations', async t => {
  const { expandedParallelPlan } = await import('./fixtures/parallel-git.js');
  const f = await planControllerFixture(t, f => {
    expandedParallelPlan(f, 3); f.plan.tasks[1].scope = ['A.txt/nested'];
    f.plan.tasks[0].conflicts_with = ['lock']; f.plan.tasks[2].conflicts_with = ['lock'];
  });
  await approveMaximum(f, 3);
  let finish!: (worker: any) => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => entered = resolve), original = f.runtime.start.bind(f.runtime);
  t.mock.method(f.runtime, 'start', async (assignment: any) => {
    const worker = await original(assignment);
    if (assignment.workerId === 'A') { entered(); return new Promise(resolve => finish = () => resolve(worker)); }
    return worker;
  });
  const starting = f.create('A'); await waiting;
  try {
    assert.equal(f.store.attempts('run')[0].state, 'starting');
    await assert.rejects(f.create('B')); await assert.rejects(f.create('C'));
    await f.create('D'); await f.create('E'); await assert.rejects(f.create('F'));
    assert.equal(f.store.attempts('run').length, 3);
  } finally { finish(undefined); await starting; }
});

test('plan_change_during_third_candidate_verification_rejects_the_entire_batch', async t => {
  const f = await threeCandidates(t), original = GitEvidence.prototype.verifyCandidate;
  t.mock.method(GitEvidence.prototype, 'verifyCandidate', async function(this: GitEvidence, ...args: Parameters<GitEvidence['verifyCandidate']>) {
    const result = await original.apply(this, args);
    if (args[0] === 'B') { f.plan.tasks[0].completion = ['changed']; f.savePlan(); }
    return result;
  });
  await assert.rejects(f.call('record_decision', { taskId: 'C', decision: 'accept_integration', integrationSha: f.sha, checks: f.verified, evidenceRefs: [] }));
  for (const id of ['A', 'B', 'C']) assert.equal(f.store.planStates('run')[id].state, 'candidate_accepted');
  assert.equal(f.store.effectiveParallelLimit('run'), 2);
});

test('integration_checks_can_be_batched_without_weakening_frame_or_final_sha', async t => {
  const { expandedParallelPlan } = await import('./fixtures/parallel-git.js');
  const f = await planControllerFixture(t, f => { expandedParallelPlan(f, 3); for (const task of f.plan.tasks) task.completion = Array.from({ length: 11 }, (_, i) => `${task.id}-${i}`); });
  await approveMaximum(f, 3);
  const inputs = [];
  for (const id of ['A', 'B', 'C']) {
    const worker = await f.create(id), result = await f.complete(id, worker, 'one', true, 'turn', Array.from({ length: 11 }, (_, i) => ({ ...checks[0], name: `${id}-${i}` })));
    inputs.push(result.sha); await f.call('record_decision', { taskId: id, decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  }
  const cwd = f.store.plan('run')!.pin.integrationCwd;
  await f.call('record_decision', { taskId: 'C', decision: 'prepare_integration', inputCandidateShas: inputs, evidenceRefs: [] });
  for (const sha of inputs) git(cwd, 'merge', '--no-edit', sha);
  const sha = git(cwd, 'rev-parse', 'HEAD'), verified = [...['A', 'B', 'C'].flatMap(id => Array.from({ length: 11 }, (_, i) => `${id}-${i}`)), 'integration'].map(name => ({ ...checks[0], name, checked_sha: sha }));
  const record = (batch: unknown, checkedSha = sha) => f.call('record_decision', { taskId: 'C', decision: 'record_integration_checks', integrationSha: checkedSha, checks: batch, evidenceRefs: [] });
  await assert.rejects(record(verified));
  await assert.rejects(record([{ ...verified[0], checked_sha: inputs[0] }]));
  await record(verified.slice(0, 32));
  await assert.rejects(f.call('record_decision', { taskId: 'C', decision: 'accept_integration', integrationSha: sha, checks: [], evidenceRefs: [] }));
  await assert.rejects(record([verified[0]]));
  await assert.rejects(record(verified.slice(32), inputs[0]));
  await record(verified.slice(32));
  await f.call('record_decision', { taskId: 'C', decision: 'accept_integration', integrationSha: sha, checks: [], evidenceRefs: [] });
  assert.equal(f.store.planStates('run').C.integrationEvidence?.checks.length, 34);
  for (const id of ['A', 'B', 'C']) assert.equal(f.store.planStates('run')[id].integrationSha, sha);
});

test('multiple_candidates_require_final_sha_checks_even_with_a_serial_worker_ceiling', async t => {
  const f = await expanded(t, 1), inputs: string[] = [];
  for (const id of ['A', 'B', 'C']) {
    const worker = await f.create(id), result = await f.complete(id, worker, 'one', true, 'turn', [{ ...checks[0], name: id }]);
    inputs.push(result.sha); await f.call('record_decision', { taskId: id, decision: 'accept_candidate', candidateSha: result.sha, evidenceRefs: [] });
  }
  await f.call('record_decision', { taskId: 'C', decision: 'prepare_integration', inputCandidateShas: inputs, evidenceRefs: [] });
  const cwd = f.store.plan('run')!.pin.integrationCwd;
  for (const sha of inputs) git(cwd, 'merge', '--no-edit', sha);
  const sha = git(cwd, 'rev-parse', 'HEAD'), verified = ['A', 'B', 'C', 'integration'].map(name => ({ ...checks[0], name, checked_sha: sha }));
  const accept = (checks: unknown) => f.call('record_decision', { taskId: 'C', decision: 'accept_integration', integrationSha: sha, checks, evidenceRefs: [] });
  await assert.rejects(accept(verified.slice(0, 3).map(({ checked_sha: _, ...check }) => check)));
  await assert.rejects(accept(verified.map(check => ({ ...check, checked_sha: inputs[0] }))));
  await accept(verified);
  for (const id of ['A', 'B', 'C']) assert.equal(f.store.planStates('run')[id].integrationSha, sha);
});
