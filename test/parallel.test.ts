import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerRuntime } from '../src/workers.js';
import { GitEvidence } from '../src/git-evidence.js';
import path from 'node:path';
import { planControllerFixture } from './fixtures/plan-controller.js';
import { git, checks, commitFile } from './fixtures/serial-git.js';

const parallel = (t: Parameters<typeof planControllerFixture>[0], configure?: Parameters<typeof planControllerFixture>[1]) => planControllerFixture(t, f => {
  f.plan.run.max_parallel = 2; f.plan.tasks[1].depends_on = [];
  f.plan.tasks.push({ ...f.plan.tasks[0], id: 'C', scope: ['c.txt'], depends_on: ['A', 'B'] });
  f.plan.tasks.push({ ...f.plan.tasks[0], id: 'D', scope: ['d.txt'] });
  configure?.(f);
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
