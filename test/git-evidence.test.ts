import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { GitEvidence, pinRepository } from '../src/git-evidence.js';
import { readPlan } from '../src/plan.js';
import { serialFixture, git, checks, commitFile } from './fixtures/serial-git.js';

function setup() {
  const f = serialFixture(), snapshot = readPlan(f.planPath), pin = pinRepository(snapshot, 'run'), evidence = new GitEvidence(snapshot, pin);
  evidence.initialize(); const assignment = evidence.createWorktree('A', 'attempt', []);
  const candidate = commitFile(assignment.cwd, 'a.txt', 'one'); git(assignment.cwd, 'push', 'origin', assignment.branch);
  const report = { task_id: 'A', worker_id: 'A', attempt_id: 'attempt', actor_id: 'thread', status: 'completed' as const, base_sha: assignment.baseSha, candidate_sha: candidate, branch: assignment.branch, push_result: { status: 'pushed' as const, remote: 'origin' as const, branch: assignment.branch }, summary: 'done', checks, remaining: [] };
  return { ...f, snapshot, pin, evidence, assignment, candidate, report };
}
test('candidate_verifies_actual_git_and_preserves_dirty_original', async () => {
  const f = setup(); writeFileSync(path.join(f.repository, 'original.txt'), 'user change');
  const result = await f.evidence.verifyCandidate('A', f.report, f.assignment);
  assert.equal(result.candidateSha, f.candidate); assert.match(git(f.repository, 'status', '--porcelain'), /original/);
  for (const report of [{ ...f.report, candidate_sha: f.assignment.baseSha }, { ...f.report, push_result: { ...f.report.push_result, status: 'failed' } }, { ...f.report, checks: [{ ...checks[0], exit_code: 1 }] }]) await assert.rejects(f.evidence.verifyCandidate('A', report, f.assignment));
  writeFileSync(path.join(f.assignment.cwd, 'a.txt'), 'after report'); await assert.rejects(f.evidence.verifyCandidate('A', f.report, f.assignment));
});
test('history_reuse_requires_cleanup_current_cwd_and_git_head', () => {
  const f = setup(); assert.equal(f.evidence.reuseWorktree(f.assignment, [f.candidate]).baseSha, f.candidate);
  assert.throws(() => f.evidence.reuseWorktree({ ...f.assignment, cwd: f.repository }, []));
  writeFileSync(path.join(f.assignment.cwd, 'dirty'), 'dirty'); assert.throws(() => f.evidence.reuseWorktree(f.assignment, []));
});
test('dependent_base_contains_all_integrations', () => {
  const f = setup(); assert.throws(() => f.evidence.createWorktree('B', 'early', [f.candidate]));
  git(f.pin.integrationCwd, 'merge', '--ff-only', f.candidate);
  const integration = f.evidence.verifyIntegration(f.candidate, f.candidate, checks, ['test'], []);
  const b = f.evidence.createWorktree('B', 'next', [integration.integrationSha]); assert.equal(b.baseSha, f.candidate);
  assert.throws(() => f.evidence.verifyIntegration(f.candidate, f.assignment.baseSha, checks, ['test'], []));
});
test('rejects_remote_scope_branch_and_post_report_commit_drift', async () => {
  const f = setup(); git(f.assignment.cwd, 'push', 'origin', '--delete', f.assignment.branch);
  await assert.rejects(f.evidence.verifyCandidate('A', f.report, f.assignment));
  git(f.assignment.cwd, 'push', 'origin', f.assignment.branch);
  const outside = commitFile(f.assignment.cwd, 'outside.txt', 'bad'); git(f.assignment.cwd, 'push', 'origin', f.assignment.branch);
  await assert.rejects(f.evidence.verifyCandidate('A', { ...f.report, candidate_sha: outside }, f.assignment));
  git(f.repository, 'remote', 'set-url', 'origin', f.root); assert.throws(() => f.evidence.reuseWorktree(f.assignment, []));
});
test('new_assignment_never_adopts_existing_branch_or_directory', () => {
  const f = setup(); assert.throws(() => f.evidence.createWorktree('A', 'attempt', []));
  assert.throws(() => f.evidence.initialize());
});

test('git_approval_roots_include_only_metadata_and_verified_local_bare_remote', () => {
  const f = setup();
  assert.deepEqual(f.evidence.approvalRoots(), [f.pin.commonDir, f.remote]);
  assert.deepEqual(f.evidence.approvalRoots(f.assignment), [f.pin.commonDir, f.remote, git(f.assignment.cwd, 'rev-parse', '--absolute-git-dir').replaceAll('/', path.sep)]);
  assert.throws(() => f.evidence.approvalRoots({ ...f.assignment, cwd: f.repository }));
  const bad = serialFixture(); git(bad.repository, 'remote', 'set-url', 'origin', bad.root);
  const snapshot = readPlan(bad.planPath), evidence = new GitEvidence(snapshot, pinRepository(snapshot, 'run'));
  assert.throws(() => evidence.approvalRoots());
});

test('scope_does_not_trim_leading_whitespace_in_changed_paths', async () => {
  const f = setup(), candidate = commitFile(f.assignment.cwd, ' a.txt', 'outside'); git(f.assignment.cwd, 'push', 'origin', f.assignment.branch);
  await assert.rejects(f.evidence.verifyCandidate('A', { ...f.report, candidate_sha: candidate }, f.assignment));
});

test('history_correction_checks_cumulative_task_scope', async () => {
  const f = setup(); commitFile(f.assignment.cwd, 'outside.txt', 'must not integrate');
  const correction = { ...f.evidence.reuseWorktree(f.assignment, []), attemptId: 'correction' };
  const candidate = commitFile(correction.cwd, 'a.txt', 'fixed'); git(correction.cwd, 'push', 'origin', correction.branch);
  await assert.rejects(f.evidence.verifyCandidate('A', { ...f.report, attempt_id: 'correction', base_sha: correction.baseSha, candidate_sha: candidate }, correction));
});

test('cross_task_history_cannot_adopt_unintegrated_source_commits', () => {
  const f = setup(); git(f.pin.integrationCwd, 'merge', '--ff-only', f.candidate);
  commitFile(f.assignment.cwd, 'outside.txt', 'after integration');
  assert.throws(() => f.evidence.reuseWorktree(f.assignment, [f.candidate], true));
});

test('worktree_specific_origin_rewrite_cannot_fake_push_reachability', async () => {
  const f = setup(), other = path.join(f.root, 'other.git'); git(f.root, 'init', '--bare', other);
  git(f.repository, 'config', 'extensions.worktreeConfig', 'true');
  git(f.assignment.cwd, 'config', '--worktree', `url.${other}.insteadOf`, f.remote);
  git(f.assignment.cwd, 'push', 'origin', f.assignment.branch);
  await assert.rejects(f.evidence.verifyCandidate('A', f.report, f.assignment));
});

test('candidate_must_reach_pinned_push_url_when_fetch_url_differs', async () => {
  const f = serialFixture(), push = path.join(f.root, 'push.git'); git(f.root, 'init', '--bare', push);
  git(f.repository, 'remote', 'set-url', '--push', 'origin', push);
  const snapshot = readPlan(f.planPath), pin = pinRepository(snapshot, 'run'), evidence = new GitEvidence(snapshot, pin); evidence.initialize();
  const a = evidence.createWorktree('A', 'attempt', []), candidate = commitFile(a.cwd, 'a.txt', 'one');
  const report = { task_id: 'A', worker_id: 'A', attempt_id: 'attempt', actor_id: 'thread', status: 'completed', base_sha: a.baseSha, candidate_sha: candidate, branch: a.branch, push_result: { status: 'pushed', remote: 'origin', branch: a.branch }, summary: 'done', checks, remaining: [] };
  git(a.cwd, 'push', f.remote, a.branch); await assert.rejects(evidence.verifyCandidate('A', report, a));
  git(a.cwd, 'push', 'origin', a.branch); assert.equal((await evidence.verifyCandidate('A', report, a)).candidateSha, candidate);
});

test('remote_verification_yields_to_control_requests', async () => {
  const f = setup(); let eventLoopRan = false;
  const verification = f.evidence.verifyCandidate('A', f.report, f.assignment);
  setImmediate(() => { eventLoopRan = true; });
  await verification; assert.equal(eventLoopRan, true, 'remote I/O must not block stop/lease processing');
});
