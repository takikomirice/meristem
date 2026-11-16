import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
export function gitScope(root: string) {
  const repositoryPath = path.join(root, 'repository'); mkdirSync(repositoryPath);
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', repositoryPath, ...args], { windowsHide: true, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('fixture Git setup failed: ' + result.stderr);
  };
  git(['init', '-b', 'fixture']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const assignments = ['A', 'B'].map(workerId => {
    const cwd = path.join(root, workerId), branch = `fixture-${workerId}`;
    git(['worktree', 'add', '-b', branch, cwd]);
    return { workerId, cwd, repositoryId: 'repo', branch, model: 'mock', effort: 'low' };
  });
  return { repositoryPath, assignments, branchScope: assignments.map(a => a.branch) };
}
