import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstallationControl, draftTrialWake, identity, localPath } from './install.js';
import { pinRepository } from './git-evidence.js';
import { fileHash, readPlan } from './plan.js';
import { resolveTaskPermissions, RunPermissionPermit } from './permissions.js';
import { UsagePolicy } from './usage.js';
import { verifyIsolation } from './workers.js';

export type CliRun = {
  runId: string; repository: string; planPath: string; directory: string; stateDirectory: string;
  discoveryPath: string; configPath: string; relayExe: string; realExe: string; authHome: string;
};
const implementation = fileURLToPath(new URL('../../', import.meta.url));
const native = path.join(implementation, '.local/chat-control-build');
const registryRoot = () => path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData/Local'), 'Meristem', 'cli');
const same = (a: string, b: string) => path.relative(a, b) === '';
function contains(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function gitExecutable() {
  if (process.platform !== 'win32') return 'git';
  // Windows also searches the calling process's working directory for a bare
  // executable. Choose an installed Git before inspecting the requested repository.
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!/^[a-z]:[\\/]/i.test(directory)) continue;
    const candidate = path.join(directory, 'git.exe');
    if (!statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
    const resolved = realpathSync.native(candidate);
    let ancestor = path.dirname(resolved);
    while (!existsSync(path.join(ancestor, '.git'))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return resolved;
      ancestor = parent;
    }
  }
  throw new Error('Git for Windows の実行ファイルを PATH で確認できません。');
}
function git(cwd: string, args: string[]) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^GIT_/i.test(name)) delete env[name];
  const result = childProcess.spawnSync(gitExecutable(), ['-C', cwd, ...args], { env, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000 });
  if (result.status !== 0) throw new Error('Gitリポジトリを確認できません。対象の作業フォルダーで実行してください。');
  return result.stdout;
}
export function cliRepository(cwd = process.cwd()) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  localPath(root);
  return realpathSync(root);
}
export function cliPlanChoices(repository: string) {
  const files = git(repository, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ':(icase)*.md', ':(icase)*.markdown']);
  const choices = new Set<string>();
  for (const item of files.split('\0').filter(Boolean)) {
    const file = path.join(repository, item);
    try {
      localPath(file);
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 262144) continue;
      const { plan } = readPlan(file);
      if (plan.schema_version === 2 && same(realpathSync(plan.run.repository), repository)) choices.add(file);
    } catch { /* Other Markdown files and removed Git entries are not plans for this repository. */ }
  }
  return [...choices].sort();
}

function findCli(repository: string, worktrees: string) {
  const npmVendor = path.join('node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc');
  for (const item of (process.env.PATH ?? '').split(path.delimiter)) {
    const root = item.replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(root)) continue;
    const candidates = [path.join(root, 'codex.exe')];
    if (existsSync(path.join(root, 'codex.cmd'))) {
      candidates.push(path.join(root, npmVendor, 'bin/codex.exe'), path.join(root, npmVendor, 'codex/codex.exe'));
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      const file = realpathSync(candidate);
      if (!contains(repository, file) && !contains(worktrees, file)) return file;
    }
  }
  throw new Error('公式Codex CLIの実行ファイルをPATHから検出できません。');
}
function diagnoseCli(realExe: string, authHome: string) {
  const probe = (args: string[]) => {
    const result = childProcess.spawnSync(realExe, args, { env: { ...process.env, CODEX_HOME: authHome },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000, encoding: 'utf8' });
    return result.status === 0 ? result.stdout + '\n' + result.stderr : '';
  };
  if (!/^codex-cli \d/m.test(probe(['--version']))) throw new Error('公式Codex CLIの版を確認できません。');
  const help = probe(['--help']);
  if (!/--remote\s/.test(help) || !/--remote-auth-token-env\s/.test(help)) throw new Error('公式CLIが認証付きのリモートTUIに対応していません。');
  if (!/^Logged in (?:using|with) ChatGPT\s*$/im.test(probe(['login', 'status']))) throw new Error('公式CLIでChatGPTにログインし、codex login status を確認してください。');
}
function repoDirectory(registry: string, repository: string) {
  const canonical = realpathSync(repository);
  return path.join(registry, fileHash(process.platform === 'win32' ? canonical.toLowerCase() : canonical));
}
const artifactHash = (file: string) => { localPath(file); return fileHash(readFileSync(file)); };
type Options = { registryRoot?: string; realExe?: string; authHome?: string };
type Control = ReturnType<typeof buildInstallationControl> & { cliTerminal: { executable: string; sha256: string } };
function runDescriptor(directory: string, control: Control): CliRun {
  return { runId: control.runId, repository: control.repository, planPath: control.mcp.scope.planPath, directory,
    stateDirectory: control.stateDirectory, discoveryPath: path.join(control.stateDirectory, 'discovery.json'),
    configPath: path.join(directory, 'control.json'), relayExe: path.join(directory, 'CodexRelay.exe'),
    realExe: control.runtime.realExe, authHome: control.runtime.authHome };
}

export function prepareCliRun(repository: string, planPath: string, options: Options = {}): CliRun {
  repository = realpathSync(repository);
  localPath(planPath);
  const plan = readPlan(planPath);
  if (plan.plan.schema_version !== 2 || !same(realpathSync(plan.plan.run.repository), repository)) throw new Error('版2工程表と対象リポジトリを照合できません。');
  const runId = randomUUID(), pin = pinRepository(plan, runId);
  const registry = options.registryRoot ?? registryRoot();
  const selectedHome = options.authHome ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  localPath(selectedHome); localPath(registry); localPath(plan.plan.run.worktrees_root); localPath(plan.plan.run.repository);
  if (!statSync(selectedHome, { throwIfNoEntry: false })?.isDirectory()) throw new Error('公式CLIでChatGPTにログインし、codex login status を確認してください。');
  const authHome = realpathSync(selectedHome);
  if ([repository, pin.root, authHome, implementation].some(root => contains(root, registry) || contains(registry, root))
    || [repository, pin.root].some(root => contains(root, authHome) || contains(authHome, root))) throw new Error('管理領域・認証環境・作業場所が重なっています。');
  const realExe = options.realExe ?? findCli(repository, pin.root);
  localPath(realExe);
  const realSha256 = artifactHash(realExe);
  diagnoseCli(realExe, authHome);
  const profiles = [...new Set(plan.plan.tasks.map(task => task.agent.permissionProfileId))];
  const permit = RunPermissionPermit.parse({ allowedProfileIds: profiles, allowedReviewers: ['user'], writableRoots: [pin.root] });
  for (const task of plan.plan.tasks) resolveTaskPermissions(task.agent, permit);
  const directory = path.join(repoDirectory(registry, repository), runId);
  const base = buildInstallationControl({ implementationRoot: implementation, realExe, nodeExe: process.execPath, codexConfig: path.join(authHome, 'config.toml') }, {
    runId, stateDirectory: path.join(directory, 'state'), pipeName: 'meristem-cc01-control-' + runId,
    nodeSha256: artifactHash(process.execPath), realSha256, parentRelay: { pipeName: 'meristem-cc00-' + runId, mode: 'verified-start', sessionKind: 'cli' },
    usagePolicy: UsagePolicy.parse({}), executionLimits: plan.plan.run.execution_limits, wake: draftTrialWake(plan, 'cli'),
    scope: { fixture: true, plan: true, planPath: plan.path, repositoryId: fileHash(pin.commonDir.toLowerCase()), repositoryPath: repository,
      branchScope: [pin.integrationBranch], permissionPermit: permit, assignments: [] }
  });
  const terminalExe = path.join(native, 'MeristemTerminal.exe');
  const control = { ...base, cliTerminal: { executable: terminalExe, sha256: artifactHash(terminalExe) } };
  const run = runDescriptor(directory, control);
  const controlExe = path.join(native, 'MeristemControl.exe'), sourceRelay = path.join(native, 'CodexRelay.exe');
  const controlBytes = JSON.stringify(control);
  const relayConfig = { realExecutable: realExe, realSha256, pipeName: control.mcp.parentRelay.pipeName, allowedCwds: [repository],
    testProfile: 'CC-00R-managed', controlHost: { executable: controlExe, sha256: artifactHash(controlExe), configPath: run.configPath,
      configSha256: fileHash(controlBytes), parentMode: 'verified-start', cliTransport: 'launcher-websocket' } };
  localPath(sourceRelay);
  mkdirSync(path.dirname(directory), { recursive: true }); mkdirSync(directory);
  writeFileSync(run.configPath, controlBytes, { flag: 'wx' });
  copyFileSync(sourceRelay, run.relayExe, constants.COPYFILE_EXCL);
  const ready = run.relayExe + '.json';
  writeFileSync(ready + '.tmp', JSON.stringify(relayConfig), { flag: 'wx' });
  renameSync(ready + '.tmp', ready);
  return run;
}

export function listCliRuns(repository: string, registry = registryRoot()): CliRun[] {
  const root = repoDirectory(registry, repository);
  localPath(root);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) return [];
    const directory = path.join(root, entry.name), configPath = path.join(directory, 'control.json');
    localPath(configPath); localPath(path.join(directory, 'CodexRelay.exe.json'));
    if (!existsSync(path.join(directory, 'CodexRelay.exe.json'))) return [];
    const control: Control = JSON.parse(readFileSync(configPath, 'utf8'));
    if (control.runId !== entry.name || !same(control.repository, repository) || !same(control.stateDirectory, path.join(directory, 'state'))) throw new Error('保存済みrunの対象を照合できません。');
    return [runDescriptor(directory, control)];
  }).sort((a, b) => a.runId.localeCompare(b.runId));
}

export function verifyCliArtifacts(run: CliRun) {
  const relayConfigPath = run.relayExe + '.json';
  for (const file of [run.configPath, run.relayExe, relayConfigPath, run.realExe]) localPath(file);
  const control: Control = JSON.parse(readFileSync(run.configPath, 'utf8'));
  const relay = JSON.parse(readFileSync(relayConfigPath, 'utf8'));
  const controlExe = path.join(native, 'MeristemControl.exe');
  if (control.runId !== run.runId || control.runtime.fixture !== false || !same(control.repository, run.repository)
    || !same(control.runtime.realExe, run.realExe) || !same(relay.realExecutable, run.realExe)
    || !same(control.runtime.authHome, run.authHome) || !same(control.stateDirectory, path.join(run.directory, 'state'))
    || !same(control.mcp.scope.planPath, run.planPath) || !same(relay.controlHost.executable, controlExe)
    || !same(relay.controlHost.configPath, run.configPath) || !same(control.nodeExecutable, process.execPath)
    || !same(control.entryPoint, path.join(implementation, 'dist/src/cli.js'))
    || !same(control.mcp.entryPoint, path.join(implementation, 'dist/src/mcp.js'))
    || !same(control.runtime.hostExe, path.join(native, 'CodexWorkerHost.exe'))
    || !same(control.cliTerminal.executable, path.join(native, 'MeristemTerminal.exe'))
    || relay.controlHost.cliTransport !== 'launcher-websocket' || relay.controlHost.parentMode !== 'verified-start'
    || !('mode' in control.mcp.parentRelay) || control.mcp.parentRelay.sessionKind !== 'cli'
    || relay.pipeName !== control.mcp.parentRelay.pipeName || relay.realSha256 !== control.runtime.realSha256) {
    throw new Error('保存済みrunの実行ファイルと接続設定が一致しません。');
  }
  identity(run.relayExe, artifactHash(path.join(native, 'CodexRelay.exe')));
  identity(run.configPath, relay.controlHost.configSha256);
  identity(controlExe, relay.controlHost.sha256);
  identity(run.realExe, control.runtime.realSha256);
  identity(process.execPath, control.nodeSha256);
  identity(control.entryPoint, control.entrySha256);
  identity(control.mcp.entryPoint, control.mcp.entrySha256);
  identity(control.runtime.hostExe, control.runtime.hostSha256);
  identity(control.cliTerminal.executable, control.cliTerminal.sha256);
}
export function verifyCliIsolation(run: CliRun) {
  const config: Control = JSON.parse(readFileSync(run.configPath, 'utf8'));
  const profiles = RunPermissionPermit.parse(config.mcp.scope.permissionPermit).allowedProfileIds;
  const cwd = mkdtempSync(path.join(run.directory, 'sandbox-'));
  try {
    for (const profile of profiles) {
      if (profile !== 'workspace' && profile !== 'read-only') throw new Error('未対応のWorker権限です。');
      verifyIsolation({ ...config.runtime, stateDirectory: run.stateDirectory }, cwd, profile);
    }
  } finally { rmdirSync(cwd); }
}
