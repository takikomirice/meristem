import assert from 'node:assert/strict';
import { test } from 'node:test';
import childProcess, { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cliPlanChoices, cliRepository, listCliRuns, prepareCliRun, verifyCliArtifacts } from '../src/cli-setup.js';

test('CLI setup discovers a plan, pins the repository and keeps simultaneous terminals and ordinary Codex settings independent', t => {
  const base = mkdtempSync(path.join(tmpdir(), 'meristem-cli-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'project'), trees = path.join(base, 'worktrees'), elsewhere = path.join(base, 'elsewhere');
  const auth = path.join(base, 'auth'), tools = path.join(base, 'codex'), registry = path.join(base, 'runs');
  for (const p of [repo, trees, elsewhere, auth, tools]) mkdirSync(p);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q'); git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('remote', 'add', 'origin', elsewhere);
  const dir = path.join(repo, 'plans'); mkdirSync(dir);
  const plan = path.join(dir, 'plan.md');
  const document = (repository: string) => ['<!-- chat-control:plan:start -->', 'schema_version: 2', 'run:',
    '  repository: ' + JSON.stringify(repository), '  worktrees_root: ' + JSON.stringify(trees), '  integration_branch: integration',
    '  max_parallel: 2', 'tasks:', '  - id: A', '    depends_on: []', '    scope: [src]', '    conflicts_with: []',
    '    agent: {model: mock, effort: low, permissionProfileId: read-only}', '    completion: [ok]', '<!-- chat-control:plan:end -->'].join('\n');
  writeFileSync(plan, document(repo)); writeFileSync(path.join(dir, 'other.md'), document(elsewhere));
  writeFileSync(path.join(repo, 'README.md'), 'ordinary Markdown');
  const config = path.join(auth, 'config.toml'); writeFileSync(config, '# ordinary config\n');
  const realExe = path.join(tools, 'codex.exe'); writeFileSync(realExe, 'fixture binary');
  const options = { realExe, registryRoot: registry, authHome: auth };
  const originalSpawn = childProcess.spawnSync;
  let login = 'Logged in using ChatGPT';
  const commands: string[] = [];
  t.mock.method(childProcess, 'spawnSync', (exe: string, args: string[], opts: object) => {
    if (exe !== realExe) return originalSpawn(exe, args, opts);
    commands.push(args.join(' '));
    const output = args[0] === '--version' ? 'codex-cli 1.0' : args[0] === '--help' ? '--remote <ADDR> --remote-auth-token-env <KEY>' : login;
    return { status: 0, stdout: output, stderr: '' };
  });
  assert.equal(cliRepository(dir), repo);
  assert.deepEqual(cliPlanChoices(repo), [plan]);
  assert.throws(() => prepareCliRun(repo, path.join(dir, 'other.md'), options), /リポジトリ/);
  const first = prepareCliRun(repo, plan, options), second = prepareCliRun(repo, plan, options);
  assert.notEqual(first.runId, second.runId);
  const control = JSON.parse(readFileSync(first.configPath, 'utf8'));
  assert.equal(control.mcp.parentRelay.sessionKind, 'cli'); assert.equal(control.runtime.fixture, false);
  assert.deepEqual(control.mcp.scope.permissionPermit.allowedProfileIds, ['read-only']);
  assert.equal(control.runtime.authHome, auth); assert.deepEqual(control.mcp.scope.branchScope, ['integration']);
  assert.deepEqual(new Set(listCliRuns(repo, registry).map(item => item.runId)), new Set([first.runId, second.runId]));
  assert.equal(readFileSync(config, 'utf8'), '# ordinary config\n');
  assert.equal(existsSync(first.stateDirectory), false, 'only native owner creates private state');
  assert.deepEqual(new Set(commands), new Set(['--version', '--help', 'login status']));
  verifyCliArtifacts(first);
  const beforeRelay = readFileSync(second.relayExe + '.json', 'utf8');
  const otherRelay = JSON.parse(beforeRelay);
  otherRelay.controlHost.configPath = first.configPath;
  writeFileSync(second.relayExe + '.json', JSON.stringify(otherRelay));
  assert.throws(() => verifyCliArtifacts(second), /一致/);
  login = 'Logged in using an API key';
  assert.throws(() => prepareCliRun(repo, plan, options), /ChatGPT/);
  assert.equal(listCliRuns(repo, registry).length, 2);
});
