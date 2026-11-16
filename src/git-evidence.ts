import { spawnSync, execFile } from 'node:child_process';
import { existsSync, realpathSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Id } from './contracts.js';
import type { PlanSnapshot } from './plan.js';

export const Sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
export const Check = z.object({ name: z.string().min(1).max(128), command: z.string().min(1).max(2048), result: z.enum(['passed', 'failed', 'not_run']), exit_code: z.number().int().nullable(), evidence_refs: z.array(z.string().min(1).max(512)).min(1).max(16), checked_sha: Sha.optional() }).strict();
export const Checks = z.array(Check).max(32);
export const TaskReport = z.object({ task_id: Id, worker_id: Id, attempt_id: Id, actor_id: Id, status: z.enum(['completed', 'failed', 'needs_input']), base_sha: Sha, candidate_sha: Sha.nullable(), branch: z.string().min(1).max(512), push_result: z.object({ status: z.enum(['pushed', 'failed', 'not_attempted']), remote: z.literal('origin'), branch: z.string().min(1).max(512) }).strict(), summary: z.string().min(1).max(8192), checks: Checks, remaining: z.array(z.string().min(1).max(2048)).max(32), question: z.string().trim().min(1).max(8192).optional() }).strict();
export type CandidateEvidence = { candidateSha: string; baseSha: string; branch: string; checks: z.infer<typeof Checks>; remote: 'origin' };
export type IntegrationEvidence = { inputCandidateShas: string[]; resultSha: string; checks: z.infer<typeof Checks>; acceptedByParentTurnId: string };
export type GitAssignment = { taskId: string; attemptId: string; cwd: string; branch: string; baseSha: string; scopeBaseSha: string };
export type RepositoryPin = { repository: string; commonDir: string; origin: string; pushUrl: string; root: string; integrationCwd: string; integrationBranch: string; initialSha: string; runId: string };
// No shell, no inherited repository redirection, no interactive credentials or implicit fetch.
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|NAMESPACE|CEILING_DIRECTORIES)/i.test(key)) delete (env as NodeJS.ProcessEnv)[key];
  return env;
}
function git(cwd: string, args: string[], raw = false): string {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd, env: gitEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error('Git evidence unavailable'); return raw ? result.stdout : result.stdout.trim();
}
const canonical = (p: string) => realpathSync(p).toLowerCase();
const inside = (root: string, child: string) => child.toLowerCase().startsWith(root.toLowerCase() + path.sep);
function branch(cwd: string, name: string) { if (['main', 'master'].includes(name.toLowerCase())) throw new Error('protected default branch'); git(cwd, ['check-ref-format', '--branch', name]); }
function remoteUrls(cwd: string) {
  // A URL rewrite may be applied again when querying a push URL. Fail closed instead
  // of guessing a destination through per-worktree or chained rewrite rules.
  if (/^url\..*\.(insteadof|pushinsteadof)$/im.test(git(cwd, ['config', '--name-only', '--list']))) throw new Error('Git URL rewriting is unsupported in plan mode');
  const origin = git(cwd, ['remote', 'get-url', '--all', 'origin']), pushUrl = git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']);
  if (!origin || !pushUrl || /[\r\n]/.test(origin + pushUrl)) throw new Error('one pinned origin and push URL required');
  return { origin, pushUrl };
}
export function pinRepository(snapshot: PlanSnapshot, runId: string): RepositoryPin {
  Id.parse(runId); const run = snapshot.plan.run, repository = realpathSync(run.repository), root = realpathSync(run.worktrees_root);
  if (canonical(git(repository, ['rev-parse', '--show-toplevel'])) !== canonical(repository) || canonical(root) === canonical(repository) || inside(repository, root)) throw new Error('worktrees must be outside source repository');
  branch(repository, run.integration_branch);
  return { repository, root, commonDir: realpathSync(git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir'])), ...remoteUrls(repository), integrationBranch: run.integration_branch, integrationCwd: path.join(root, runId, 'integration'), initialSha: git(repository, ['rev-parse', 'HEAD']), runId };
}
export class GitEvidence {
  constructor(readonly snapshot: PlanSnapshot, readonly pin: RepositoryPin) {}
  approvalRoots(assignment?: GitAssignment): string[] {
    this.assertRepository();
    const roots = [this.pin.commonDir];
    if (path.isAbsolute(this.pin.pushUrl)) {
      const remote = realpathSync(this.pin.pushUrl);
      if (git(remote, ['rev-parse', '--is-bare-repository']) !== 'true' || canonical(git(remote, ['rev-parse', '--absolute-git-dir'])) !== remote.toLowerCase()) throw new Error('Git approval requires a local bare remote root');
      roots.push(remote);
    }
    if (assignment) {
      this.worktree(assignment.cwd, assignment.branch);
      const gitDir = realpathSync(git(assignment.cwd, ['rev-parse', '--absolute-git-dir']));
      if (!inside(this.pin.commonDir, gitDir)) throw new Error('worktree Git directory outside pinned metadata');
      // Codex protects the resolved linked-worktree gitdir separately from its common dir.
      roots.push(gitDir);
    }
    return roots;
  }
  assertRepository(): void {
    const current = pinRepository(this.snapshot, this.pin.runId);
    for (const key of ['repository', 'root', 'commonDir', 'origin', 'pushUrl', 'integrationBranch'] as const) if (current[key] !== this.pin[key]) throw new Error('repository identity changed');
  }
  private worktree(cwd: string, expectedBranch: string): string {
    this.assertRepository();
    const remote = remoteUrls(cwd);
    if (remote.origin !== this.pin.origin || remote.pushUrl !== this.pin.pushUrl) throw new Error('worktree remote identity changed');
    if (!inside(this.pin.root, realpathSync(cwd)) || canonical(git(cwd, ['rev-parse', '--show-toplevel'])) !== canonical(cwd) || canonical(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== canonical(this.pin.commonDir) || git(cwd, ['symbolic-ref', '--short', 'HEAD']) !== expectedBranch || git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('worktree identity, branch or clean state changed');
    for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) if (existsSync(git(cwd, ['rev-parse', '--git-path', operation]))) throw new Error('Git operation unfinished');
    return Sha.parse(git(cwd, ['rev-parse', 'HEAD']));
  }
  private contains(cwd: string, sha: string, dependencies: string[]): void {
    Sha.parse(sha); for (const dependency of dependencies) git(cwd, ['merge-base', '--is-ancestor', Sha.parse(dependency), sha]);
  }
  private add(cwd: string, name: string, baseSha: string): void {
    this.assertRepository(); branch(this.pin.repository, name); Sha.parse(baseSha);
    if (existsSync(cwd)) throw new Error('existing worktree cannot be adopted');
    mkdirSync(path.dirname(cwd), { recursive: true });
    if (!inside(this.pin.root, realpathSync(path.dirname(cwd)))) throw new Error('worktree root escaped');
    git(this.pin.repository, ['worktree', 'add', '-b', name, cwd, baseSha]);
  }
  initialize(): void { this.add(this.pin.integrationCwd, this.pin.integrationBranch, this.pin.initialSha); }
  integrationBase(integrations: string[]): string {
    const head = this.worktree(this.pin.integrationCwd, this.pin.integrationBranch);
    if (!(integrations.length ? integrations : [this.pin.initialSha]).includes(head)) throw new Error('unaccepted integration base changed');
    this.contains(this.pin.integrationCwd, head, integrations); return head;
  }
  assertCandidateHead(assignment: GitAssignment, sha: string): void {
    if (this.worktree(assignment.cwd, assignment.branch) !== sha) throw new Error('fixed candidate changed during verification');
  }
  createWorktree(taskId: string, attemptId: string, integrations: string[]): GitAssignment {
    Id.parse(taskId); Id.parse(attemptId);
    const baseSha = this.worktree(this.pin.integrationCwd, this.pin.integrationBranch);
    this.contains(this.pin.integrationCwd, baseSha, integrations);
    const workerBranch = `${this.pin.integrationBranch}-${taskId}-${attemptId}`;
    const cwd = path.join(this.pin.root, this.pin.runId, `${taskId}-${attemptId}`);
    this.add(cwd, workerBranch, baseSha); return { taskId, attemptId, cwd: realpathSync(cwd), branch: workerBranch, baseSha, scopeBaseSha: baseSha };
  }
  reuseWorktree(assignment: GitAssignment, integrations: string[], newTask = false): GitAssignment {
    const baseSha = this.worktree(assignment.cwd, assignment.branch);
    this.contains(assignment.cwd, baseSha, [assignment.baseSha, ...integrations]);
    if (newTask && baseSha !== this.worktree(this.pin.integrationCwd, this.pin.integrationBranch)) throw new Error('cross-task history must match integration HEAD');
    return { ...assignment, baseSha, scopeBaseSha: newTask ? baseSha : assignment.scopeBaseSha };
  }
  async verifyCandidate(taskId: string, input: unknown, assignment: GitAssignment): Promise<CandidateEvidence> {
    const report = TaskReport.parse(input), task = this.snapshot.plan.tasks.find(t => t.id === taskId);
    if (!task || report.task_id !== taskId || report.status !== 'completed' || report.question || report.remaining.length || report.base_sha !== assignment.baseSha || report.branch !== assignment.branch || report.attempt_id !== assignment.attemptId || report.push_result.status !== 'pushed' || report.push_result.branch !== assignment.branch) throw new Error('candidate report mismatch');
    validateChecks(report.checks, task.completion);
    const sha = this.worktree(assignment.cwd, assignment.branch);
    if (sha !== report.candidate_sha) throw new Error('candidate HEAD changed');
    this.contains(assignment.cwd, sha, [assignment.baseSha]);
    this.contains(assignment.cwd, sha, [assignment.scopeBaseSha]);
    const files = git(assignment.cwd, ['diff', '--name-only', '-z', '--no-renames', assignment.scopeBaseSha, sha, '--'], true).split('\0').filter(Boolean);
    if (files.some(file => !task.scope.some(p => file === p || file.startsWith(p + '/')))) throw new Error('candidate changes outside task scope');
    const remote = await new Promise<string>((resolve, reject) => {
      execFile('git', ['--no-replace-objects', 'ls-remote', '--exit-code', '--heads', '--', this.pin.pushUrl, `refs/heads/${assignment.branch}`], { cwd: assignment.cwd, env: gitEnvironment(), windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(new Error('Git remote evidence unavailable')) : resolve(stdout.trim()));
    });
    if (remote.split(/\s+/)[0] !== sha) throw new Error('candidate not at pinned remote branch');
    // Recheck after remote I/O, including clean state and original assignment.
    if (this.worktree(assignment.cwd, assignment.branch) !== sha) throw new Error('candidate changed during verification');
    return { candidateSha: sha, baseSha: assignment.baseSha, branch: assignment.branch, checks: report.checks, remote: 'origin' };
  }
  verifyIntegration(candidate: string, integrationSha: string, checks: unknown, required: string[], integrations: string[], bindChecks = false) {
    const verified = validateChecks(checks, required), head = this.worktree(this.pin.integrationCwd, this.pin.integrationBranch);
    if (head !== Sha.parse(integrationSha)) throw new Error('integration HEAD changed');
    if (bindChecks && verified.some(c => c.checked_sha !== head)) throw new Error('checks must target the integration result SHA');
    this.contains(this.pin.integrationCwd, head, [candidate, ...integrations]);
    return { integrationSha: head, checks: verified };
  }
}
function validateChecks(input: unknown, required: string[]) {
  const checks = Checks.parse(input);
  if (new Set(checks.map(c => c.name)).size !== checks.length || checks.some(c => c.result !== 'passed' || c.exit_code !== 0) || required.some(name => !checks.some(c => c.name === name))) throw new Error('required checks have not passed');
  return checks;
}
