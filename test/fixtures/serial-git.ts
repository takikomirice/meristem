import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
}
export function serialFixture(root = mkdtempSync(path.join(tmpdir(), 'cc05-git-'))) {
  mkdirSync(root, { recursive: true });
  const repository = path.join(root, 'repo'), trees = path.join(root, 'trees'), remote = path.join(root, 'remote.git');
  mkdirSync(repository); mkdirSync(trees); git(root, 'init', '--bare', remote); git(repository, 'init', '-b', 'source');
  git(repository, 'config', 'user.name', 'Fixture'); git(repository, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(path.join(repository, 'original.txt'), 'original'); git(repository, 'add', '.'); git(repository, 'commit', '-m', 'initial');
  git(repository, 'remote', 'add', 'origin', remote); git(repository, 'push', 'origin', 'source');
  const plan = { schema_version: 1, run: { repository, worktrees_root: trees, integration_branch: 'cc05-integration', max_parallel: 1 }, tasks: ['A', 'B'].map((id, i) => ({ id, depends_on: i ? ['A'] : [], scope: [id.toLowerCase() + '.txt'], conflicts_with: [] as string[], agent: { model: 'mock', effort: 'low' }, continuation: { mode: 'new' }, completion: ['test'] })) };
  const planPath = path.join(root, 'plan.md');
  const savePlan = () => writeFileSync(planPath, `notes\n<!-- chat-control:plan:start -->\n${JSON.stringify(plan)}\n<!-- chat-control:plan:end -->\n<!-- chat-control:progress:start -->\ninitial\n<!-- chat-control:progress:end -->\nend\n`);
  savePlan();
  return { root, repository, trees, remote, plan, planPath, savePlan };
}
export const checks = [{ name: 'test', command: 'git diff --check <base> <candidate>', result: 'passed' as const, exit_code: 0, evidence_refs: ['fixture:diff-check'] }];
export function commitFile(cwd: string, filename: string, text: string) { writeFileSync(path.join(cwd, filename), text); git(cwd, 'add', '--', filename); git(cwd, 'commit', '-m', 'fixture change'); return git(cwd, 'rev-parse', 'HEAD'); }

export function serialAcceptancePlan(f: ReturnType<typeof serialFixture>, agent: { model: string; effort: string }) {
  writeFileSync(path.join(f.repository, 'checks.mjs'), `import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
for (const name of process.argv.slice(2)) {
  if (name === 'A') assert.equal(readFileSync('a.txt', 'utf8').trim(), 'alpha');
  else if (name === 'B') assert.equal(readFileSync('b.txt', 'utf8').trim(), 'beta');
  else throw new Error('unknown check');
}
console.log('passed: ' + process.argv.slice(2).join(','));
`);
  git(f.repository, 'add', 'checks.mjs'); git(f.repository, 'commit', '-m', 'serial acceptance baseline'); git(f.repository, 'push', 'origin', 'source');
  f.plan.run.integration_branch = 'cc07-serial-integration';
  for (const task of f.plan.tasks) { task.agent = agent; task.completion = [task.id]; }
  f.savePlan(); return f;
}
