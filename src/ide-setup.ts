import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstallationControl, localPath } from './install.js';
import { pinRepository } from './git-evidence.js';
import { fileHash, readPlan } from './plan.js';
import { resolveTaskPermissions, RunPermissionPermit } from './permissions.js';
import { UsagePolicy } from './usage.js';
import { Rpc } from './protocol.js';
import { verifyIsolation } from './workers.js';

const implementation = fileURLToPath(new URL('../../', import.meta.url));
const hash = (file: string) => fileHash(readFileSync(file));
function contains(root: string, target: string) {
  const rel = path.relative(root, target);
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

export async function prepareIdeRun(storage: string, repository: string, file: string, realExe: string) {
  const authHome = realpathSync(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'));
  for (const target of [storage, repository, file, authHome, realExe]) localPath(target);
  const plan = readPlan(file);
  if (plan.plan.schema_version !== 2) throw new Error('版2の工程表を選んでください。');
  localPath(plan.plan.run.repository);
  if (realpathSync.native(plan.plan.run.repository) !== realpathSync.native(repository)) throw new Error('工程表の対象と選んだフォルダーが異なります。');
  localPath(plan.plan.run.worktrees_root);
  const runId = randomUUID(), pin = pinRepository(plan, runId);
  if ([implementation, authHome].some(root => contains(root, storage) || contains(storage, root))) throw new Error('実行の保存先と認証・拡張のフォルダーが重なっています。');
  for (const root of [pin.repository, pin.root]) {
    if ([storage, authHome, implementation, realExe].some(target => contains(root, target) || contains(target, root))) throw new Error('作業場所と実行・認証環境が重なっています。');
  }
  let mcpName = 'meristem';
  const probe = spawn(realExe, ['-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"', 'app-server'], {
    cwd: repository, env: { ...process.env, CODEX_HOME: authHome }, windowsHide: true, stdio: 'pipe'
  });
  probe.stderr.resume();
  const rpc = new Rpc(probe, () => { });
  try {
    await rpc.call('initialize', { clientInfo: { name: 'meristem', version: '1' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const account = await rpc.call('account/read', { refreshToken: false });
    if (account?.account?.type !== 'chatgpt') throw new Error('公式 Codex に ChatGPT アカウントでログインしてください。');
    const { config } = await rpc.call('config/read', { cwd: repository, includeLayers: false });
    if (!config || config.model_provider !== 'openai' || config.forced_login_method !== 'chatgpt' || config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/' || config.openai_base_url != null || config.model_providers?.openai) throw new Error('公式 Codex の接続設定を確認できません。');
    const servers = config.mcp_servers ?? {};
    if (Object.hasOwn(servers, mcpName)) {
      mcpName = 'meristem_' + runId.replaceAll('-', '');
      if (Object.hasOwn(servers, mcpName)) throw new Error('この実行専用のツール名が既に使われています。');
    }
  } finally {
    rpc.close();
    probe.kill();
  }
  const permit = RunPermissionPermit.parse({ allowedProfileIds: [...new Set(plan.plan.tasks.map(t => t.agent.permissionProfileId))], writableRoots: [pin.root], allowedReviewers: ['user'] });
  for (const task of plan.plan.tasks) resolveTaskPermissions(task.agent, permit);
  const directory = path.join(storage, runId), stateDirectory = path.join(directory, 'state');
  const pipeName = 'meristem-cc01-control-' + runId, parentPipe = 'meristem-cc00-' + runId;
  const base = buildInstallationControl({ implementationRoot: implementation, realExe, nodeExe: process.execPath, codexConfig: path.join(authHome, 'config.toml') }, {
    runId, pipeName, stateDirectory, realSha256: hash(realExe), nodeSha256: hash(process.execPath),
    parentRelay: { mode: 'verified-start', sessionKind: 'vscode', pipeName: parentPipe }, usagePolicy: UsagePolicy.parse({}),
    executionLimits: plan.plan.run.execution_limits, scope: { fixture: true, plan: true, planPath: plan.path, repositoryId: fileHash(pin.commonDir), repositoryPath: pin.repository, branchScope: [pin.integrationBranch], permissionPermit: permit, assignments: [] }
  });
  const native = path.join(implementation, '.local/chat-control-build'), control = path.join(native, 'MeristemControl.exe');
  const config = { ...base, ideTerminal: true, runtime: { ...base.runtime, managedProfile: true, windowsSandbox: 'mxc' as const } };
  const bytes = JSON.stringify(config), configPath = path.join(directory, 'control.json'), relay = path.join(directory, 'CodexRelay.exe');
  mkdirSync(storage, { recursive: true }); mkdirSync(directory);
  writeFileSync(configPath, bytes, { flag: 'wx' });
  copyFileSync(path.join(native, 'CodexRelay.exe'), relay, constants.COPYFILE_EXCL);
  writeFileSync(relay + '.json', JSON.stringify({
    realExecutable: realExe, realSha256: base.runtime.realSha256, pipeName: parentPipe,
    allowedCwds: [pin.repository], testProfile: 'CC-00R-managed', controlHost: { executable: control, sha256: hash(control), configPath, configSha256: fileHash(bytes), parentMode: 'verified-start', sidebarMcp: 'process', sidebarMcpName: mcpName, ideTerminal: true }
  }), { flag: 'wx' });
  return { runId, pipeName, repository: pin.repository, relay, configPath, realExe, authHome, file: path.join(stateDirectory, 'discovery.json') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [op, ...args] = process.argv.slice(2);
    if (op === 'prepare' && args.length === 4) console.log(JSON.stringify(await prepareIdeRun(args[0], args[1], args[2], args[3])));
    else if (op === 'isolation' && args.length === 1) {
      const config = JSON.parse(readFileSync(args[0], 'utf8'));
      const check = mkdtempSync(path.join(path.dirname(args[0]), 'isolation-'));
      try {
        for (const profile of RunPermissionPermit.parse(config.mcp.scope.permissionPermit).allowedProfileIds) {
          if (profile !== 'workspace' && profile !== 'read-only') throw new Error('未対応のワーカー権限です。');
          verifyIsolation({ ...config.runtime, stateDirectory: config.stateDirectory }, check, profile);
        }
      } finally { rmdirSync(check); }
    } else throw new Error('Unknown IDE setup request');
  } catch (error) { console.error(error instanceof Error ? error.message : 'Meristem の診断に失敗しました。'); process.exitCode = 1; }
}
