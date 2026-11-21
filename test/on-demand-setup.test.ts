import assert from 'node:assert/strict';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { serialFixture } from './fixtures/serial-git.js';
import { resolveOnDemandFile, sidebarExecutable } from '../src/on-demand-setup.js';

const cli = path.resolve('dist/src/cli.js');
test('resolves a file from the Git root even when invoked from a subdirectory', t => {
  const repository = mkdtempSync(path.join(tmpdir(), 'meristem path '));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: repository });
  const cwd = path.join(repository, '子フォルダ');
  mkdirSync(cwd);
  const absolute = path.join(cwd, '検査.txt');
  writeFileSync(absolute, 'value');
  // Inspect the selected program before allowing the repository lookup to run.
  t.mock.method(childProcess, 'spawnSync', (exe: string, args: string[], opts: object) => {
    assert.ok(path.isAbsolute(exe));
    assert.notEqual(path.dirname(exe), cwd);
    assert.deepEqual(args, ['-C', cwd, 'rev-parse', '--show-toplevel']);
    return spawnSync(exe, args, opts);
  });
  assert.deepEqual(resolveOnDemandFile('子フォルダ/検査.txt', cwd), { repository, absolute, file: '子フォルダ/検査.txt' });
  for (const file of ['C:relative', '.git/config', '子フォルダ/検査.txt:stream']) {
    assert.throws(() => resolveOnDemandFile(file, cwd));
  }
});

test('ambiguous or escaping extension registry entries never supply the Worker executable', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'meristem extensions '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const row = { identifier: { id: 'openai.chatgpt' }, version: '1.2.3', relativeLocation: '../other' };
  for (const rows of [[], [row], [row, row]]) {
    writeFileSync(path.join(root, 'extensions.json'), JSON.stringify(rows));
    assert.throws(() => sidebarExecutable(root), /official_extension_unavailable/);
  }
});

test('run previews the first independent tasks and never allocates or saves on retry', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'meristem on demand '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = serialFixture(root);
  const tasks = ['A', 'B', 'C', 'D'].map((id, index) => ({
    ...f.plan.tasks[0], id, scope: [index === 1 ? 'a.txt' : id.toLowerCase() + '.txt'],
    depends_on: id === 'D' ? ['A'] : [], agent: { ...f.plan.tasks[0].agent, permissionProfileId: 'workspace' }
  }));
  const plan = { schema_version: 2, run: { ...f.plan.run, max_parallel: 2 }, tasks };
  const file = path.join(f.repository, 'plan file.md');
  const save = () => writeFileSync(file, '<!-- chat-control:plan:start -->\n' + JSON.stringify(plan) + '\n<!-- chat-control:plan:end -->\n');
  save();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.repository, encoding: 'utf8' });
  const status = () => [git('status', '--porcelain'), git('show-ref'), git('worktree', 'list'), git('ls-remote', 'origin')];
  const before = status(), original = readFileSync(file);
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'run', ...args], { cwd: f.repository, encoding: 'utf8' });
  const preview = spawnSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/meristem.ps1'), 'run', 'plan file.md'],
    { cwd: f.repository, encoding: 'utf8', windowsHide: true });
  assert.equal(preview.status, 2, preview.stderr);
  const result = JSON.parse(preview.stdout);
  assert.equal(result.status, 'sidebar_authorization_unverified');
  assert.deepEqual(result.initialTasks, ['A', 'C']);
  assert.equal(result.branch, plan.run.integration_branch);
  assert.equal(result.planHash.length, 64);
  assert.equal(run('plan file.md').stdout, preview.stdout);
  assert.deepEqual(status(), before);
  assert.deepEqual(readFileSync(file), original);
  for (const args of [[], ['..\\plan.md'], [file], ['plan file.md', '--approve']]) {
    const rejected = run(...args);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stdout, '');
  }
  const outside = path.join(root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, path.join(f.repository, 'alias'), 'junction');
  writeFileSync(path.join(outside, 'plan.md'), original);
  assert.equal(run('alias/plan.md').status, 1);
  plan.run.repository = outside; save();
  assert.equal(run('plan file.md').status, 1);
});
