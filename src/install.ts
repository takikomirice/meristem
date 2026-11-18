import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import { fileHash, readPlan, type PlanSnapshot } from './plan.js';
import { ExecutionLimits, Hash, Id, ModelId } from './contracts.js';
import { resolveTaskPermissions, RunPermissionPermit } from './permissions.js';
import { pinRepository } from './git-evidence.js';
import { inspectEnvironment as inspectDevelopmentEnvironment, type EnvironmentInput } from './development.js';
import type { FixtureScope } from './mcp.js';
import { loadPlanRoutingSummary, RoutingSummaryReference } from './routing-summary.js';

const absolute = z.string().max(4096).refine(p => path.isAbsolute(p) && !/[\x00-\x1f]/.test(p)
  && (process.platform !== 'win32' || path.parse(p).root.length > 1 && !/^[\\/]{2}[?.][\\/]/.test(p)));
const Agent = z.object({ model: ModelId, effort: Id }).strict();
const Prepare = z.object({
  environmentRoot: absolute, stateDirectory: absolute, parentThreadId: Id, planPath: absolute, repositoryPath: absolute,
  repositoryId: Id, branchScope: z.array(z.string().max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/)
    .refine(branch => !['main', 'master'].includes(branch.toLowerCase()) && !branch.endsWith('/'))).min(1).max(128)
    .refine(branches => new Set(branches).size === branches.length),
  coordinator: Agent, permissionPermit: RunPermissionPermit.optional(), executionLimits: ExecutionLimits.optional(),
  modelRoutingSummary: RoutingSummaryReference.optional()
}).strict();
const Spec = z.object({ implementationRoot: absolute, realExe: absolute, nodeExe: absolute, helperExtension: absolute, settings: absolute, sourceSettings: absolute.optional(), codexConfig: absolute, controlConfig: absolute, installDirectory: absolute, parentCwd: absolute,
  prepare: Prepare.optional(), controlSha256: Hash.optional() }).strict();
export type InstallationSpec = z.infer<typeof Spec>;
export type InstallSpec = InstallationSpec;
export type EnvironmentReport = {
  tools: Array<{ name: string; path: string | null; version: string | null; sha256: string | null }>;
  blockers: string[];
  warnings: string[];
};

// The existing DE input supplies Code, the official extension and versions.
export function inspectEnvironment(input: Partial<InstallationSpec>, environment?: EnvironmentInput): EnvironmentReport {
  const names = ['codex', 'node', 'code', 'codex_extension'];
  const tools = names.map(name => ({ name, path: null, version: null, sha256: null }));
  const parsed = Spec.partial().safeParse(input);
  if (!parsed.success) return { tools, blockers: ['installation_input_invalid: 絶対パスの導入設定を明示してください。'], warnings: [] };
  const s = parsed.data;
  let config: any;
  const blockers: string[] = [];
  if (s.controlConfig && !s.prepare) {
    try { localPath(s.controlConfig); config = JSON.parse(readFileSync(s.controlConfig, 'utf8')); }
    catch { blockers.push('control_config_invalid: control設定を読み取れません。'); }
  }
  const selected = environment?.selectedTools;
  const report = inspectDevelopmentEnvironment({
    ...environment,
    // DE's checkout is outside envRoot; the installer may use a snapshot inside it.
    implementationRoot: environment?.implementationRoot ?? s.implementationRoot ?? '',
    envRoot: s.prepare?.environmentRoot ?? environment?.envRoot ?? s.installDirectory ?? '',
    authHome: s.codexConfig ? path.dirname(s.codexConfig) : environment?.authHome ?? '',
    codexExe: s.realExe ?? environment?.codexExe ?? '', nodeExe: s.nodeExe ?? environment?.nodeExe ?? '',
    codeExe: environment?.codeExe ?? '', extensionDirectory: environment?.extensionDirectory ?? '',
    selectedTools: {
      ...selected,
      codex: selected?.codex ?? { sha256: config?.runtime?.realSha256, version: null },
      node: selected?.node ?? { sha256: config?.nodeSha256, version: null }
    },
    settingsFile: s.settings && existsSync(s.settings) ? s.settings : s.sourceSettings ?? s.settings ?? environment?.settingsFile,
    controlConfig: s.prepare ? undefined : s.controlConfig ?? environment?.controlConfig
  });
  // DE inspects config.toml under authHome. Do not diagnose a different basename.
  if (s.codexConfig && path.basename(s.codexConfig) !== 'config.toml') {
    blockers.push('codex_config_invalid: 専用CODEX_HOMEのconfig.tomlを明示してください。');
  }
  const warnings = ['installation_validation_pending: 静的診断です。導入可否は既存installer、終了・復元は所有runのstatusとreceiptで別途照合してください。'];
  for (const d of report.diagnostics) {
    const message = `${d.code}: ${d.message}${d.nextAction ? ' ' + d.nextAction : ''}`;
    (d.severity === 'blocker' ? blockers : warnings).push(message);
  }
  return { tools: names.map(name => report.tools.find(tool => tool.name === name) ?? tools.find(tool => tool.name === name)!), blockers, warnings };
}

type ControlBinding = {
  runId: string; pipeName: string; stateDirectory: string; nodeSha256: string; realSha256: string;
  parentRelay: { pipeName: string; threadId: string }; scope: Omit<FixtureScope, 'windowBindingId'>;
  wake?: z.infer<typeof Agent> & { maxTurns?: number }; executionLimits?: ExecutionLimits;
};

// Used by both the snapshot runner and the extracted Windows package.
export function buildInstallationControl(s: Pick<InstallationSpec, 'implementationRoot' | 'realExe' | 'nodeExe' | 'codexConfig'>, binding: ControlBinding) {
  const entryPoint = path.join(s.implementationRoot, 'dist/src/cli.js');
  const mcp = path.join(s.implementationRoot, 'dist/src/mcp.js');
  const hostExe = path.join(s.implementationRoot, '.local/chat-control-build/CodexWorkerHost.exe');
  const artifactHash = (file: string) => { localPath(file); return fileHash(readFileSync(file)); };
  return { runId: binding.runId, stateDirectory: binding.stateDirectory, repository: binding.scope.repositoryPath, pipeName: binding.pipeName,
    nodeExecutable: s.nodeExe, nodeSha256: binding.nodeSha256, entryPoint, entrySha256: artifactHash(entryPoint),
    runtime: { hostExe, hostSha256: artifactHash(hostExe), realExe: s.realExe, realSha256: binding.realSha256,
      authHome: path.dirname(s.codexConfig), fixture: false }, assignments: [],
    ...(binding.executionLimits && { executionLimits: binding.executionLimits }),
    mcp: { ...(binding.wake && { wake: binding.wake }), parentRelay: binding.parentRelay, entryPoint: mcp,
      entrySha256: artifactHash(mcp), scope: binding.scope } };
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);

const targetPaths = ['settings', 'codexConfig', 'controlConfig', 'installDirectory', 'parentCwd'] as const;
type InstallationTarget = Pick<InstallationSpec, (typeof targetPaths)[number]> & { environmentRoot: string; planFileSha256: string };
type Control = ReturnType<typeof buildInstallationControl> & { installationTarget?: InstallationTarget };

function validateGeneratedTarget(s: InstallationSpec, target: InstallationTarget, plan: PlanSnapshot, config: Control) {
  if (s.sourceSettings || targetPaths.some(key => s[key] !== target[key])) throw new Error('prepared installation targets changed');
  if (plan.plan.schema_version !== 2 || plan.fileHash !== Hash.parse(target.planFileSha256)) throw new Error('prepared plan changed; prepare again using the selected version');
  const { repository, worktrees_root: trees } = plan.plan.run;
  const state = absolute.parse(config.stateDirectory), envRoot = absolute.parse(target.environmentRoot);
  [envRoot, repository, trees, state, ...targetPaths.map(key => s[key])].forEach(localPath);
  const authHome = path.dirname(s.codexConfig), newPaths = [s.controlConfig, s.installDirectory, state];
  const normalRoots = [path.join(homedir(), '.codex')];
  for (const active of [process.env.CODEX_HOME, process.env.VSCODE_PORTABLE]) {
    if (active) normalRoots.push(path.resolve(active));
  }
  if (process.env.APPDATA) normalRoots.push(...['Code', 'Code - Insiders'].map(name => path.join(process.env.APPDATA!, name)));
  const projectRoots = [s.implementationRoot, repository, trees];
  if (path.basename(s.codexConfig) !== 'config.toml' || !statSync(envRoot).isDirectory()
    || [...projectRoots, ...normalRoots, authHome].some(root => overlap(envRoot, root))
    || [...projectRoots, ...normalRoots].some(root => overlap(authHome, root))
    || [envRoot, authHome].some(root => overlap(s.parentCwd, root)) || !inside(envRoot, s.settings)
    || newPaths.some(file => !inside(envRoot, file)) || existsSync(state)
    || overlap(s.controlConfig, s.installDirectory) || overlap(s.controlConfig, state)) {
    throw new Error('new control, install and state paths and existing settings must use explicit dedicated directories');
  }
  const permit = RunPermissionPermit.parse(config.mcp.scope.permissionPermit);
  if (permit.allowedProfileIds.some(id => !['workspace', 'read-only'].includes(id)) || permit.allowedReviewers.includes('guardian_subagent')) throw new Error('unsupported profile or reviewer');
  if (permit.writableRoots.length !== 1 || realpathSync(permit.writableRoots[0]) !== realpathSync(trees)) throw new Error('writable ceiling must be the plan worktrees root');
  const agentsByProfile = new Map(plan.plan.tasks.map(task => [task.agent.permissionProfileId, task.agent]));
  for (const agent of agentsByProfile.values()) {
    resolveTaskPermissions(agent, permit);
  }
}

export function prepareInstallation(input: InstallationSpec, report: EnvironmentReport): InstallationSpec {
  const { prepare: binding, ...s } = Spec.parse(input);
  if (!binding || s.sourceSettings || s.controlSha256) throw new Error('explicit prepare binding and existing dedicated settings required');
  if (report.blockers.length) throw new Error(report.blockers.join('\n'));
  const tool = (name: string) => {
    const selected = report.tools.find(tool => tool.name === name);
    if (!selected?.path || !selected.sha256 || !selected.version) throw new Error(`validated ${name} selection and version required`);
    return { path: selected.path, sha256: selected.sha256 };
  };
  const codex = tool('codex'), node = tool('node');
  for (const name of ['code', 'codex_extension']) {
    const { path, sha256 } = tool(name);
    localPath(path); identity(path, sha256);
  }
  if (realpathSync(s.realExe) !== codex.path || realpathSync(s.nodeExe) !== node.path) throw new Error('inspection report tool binding mismatch');
  [binding.planPath, binding.repositoryPath].forEach(localPath);
  const plan = readPlan(binding.planPath);
  if (plan.plan.schema_version !== 2) throw new Error('generation requires plan schema version 2');
  localPath(plan.plan.run.repository); localPath(plan.plan.run.worktrees_root);
  const runId = randomUUID(), pin = pinRepository(plan, runId);
  if (realpathSync(binding.repositoryPath) !== pin.repository || !binding.branchScope.includes(pin.integrationBranch)) throw new Error('plan repository or branch mismatch');
  const permit = binding.permissionPermit ?? RunPermissionPermit.parse({ allowedProfileIds: ['workspace'], writableRoots: [pin.root], allowedReviewers: ['user'] });
  const routingSummary = binding.modelRoutingSummary &&
    loadPlanRoutingSummary(binding.modelRoutingSummary, plan, runId, path.dirname(s.codexConfig)).reference;
  const config: Control = {
    ...buildInstallationControl(s, { runId, stateDirectory: binding.stateDirectory, pipeName: `meristem-cc01-control-${runId}`,
      nodeSha256: node.sha256, realSha256: codex.sha256, parentRelay: { pipeName: `meristem-cc00-${randomUUID()}`, threadId: binding.parentThreadId },
      scope: { fixture: true, plan: true, planPath: plan.path, repositoryId: binding.repositoryId, repositoryPath: pin.repository,
        branchScope: binding.branchScope, permissionPermit: permit, assignments: [],
        ...(routingSummary ? { modelRoutingSummary: routingSummary } : {}) },
      wake: binding.coordinator, executionLimits: ExecutionLimits.parse(binding.executionLimits ?? {}) }),
    installationTarget: { environmentRoot: binding.environmentRoot, planFileSha256: plan.fileHash,
      settings: s.settings, codexConfig: s.codexConfig, controlConfig: s.controlConfig, installDirectory: s.installDirectory, parentCwd: s.parentCwd }
  };
  const bytes = JSON.stringify(config, null, 2) + '\n', spec = { ...s, controlSha256: fileHash(bytes) };
  validateInstallationControl(spec, config);
  if (existsSync(s.installDirectory)) throw new Error('installation directory must be new; preserve previous receipt');
  setting(readFileSync(s.settings, 'utf8'));
  if (hasMcpNamespace(readFileSync(s.codexConfig, 'utf8'))) throw new Error('existing MCP configuration requires manual review');
  writeFileSync(s.controlConfig, bytes, { flag: 'wx', mode: 0o600 });
  return spec;
}
const key = 'chatgpt.cliExecutable';
export function hasMcpNamespace(text: string): boolean {
  // Conservative declaration check: do not parse/rewrite unrelated TOML values.
  // Unicode escapes in quoted keys can spell the same namespace.
  return text.split(/\r?\n/).some(line => {
    const declaration = (line.trimStart().startsWith('[') ? line : line.slice(0, Math.max(0, line.indexOf('='))))
      .replace(/\\(?:u([a-f0-9]{4})|U([a-f0-9]{8}))/gi, (_all, short, long) => String.fromCodePoint(parseInt(short ?? long, 16)));
    return /^[ \t]*\[\s*["']?mcp_servers["']?\s*\.\s*["']?meristem["']?\s*[.\]]/i.test(declaration)
      || /^[ \t]*["']?mcp_servers["']?\s*[.]?/i.test(declaration)
      || /^[ \t]*\[\s*["']?mcp_servers["']?\s*\]/i.test(declaration);
  });
}
type Manifest = { version: 1; state: 'prepared' | 'installed' | 'restored'; settings: string; previous?: string; installed: string; codexConfig: string; mcpBlock: string; artifacts: Record<string, string>; versions: { node: string; codex: string }; retained?: string[] };
export function localPath(file: string) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('reparse path rejected');
    if (path.dirname(current) === current) break;
  }
}
function jsonc(text: string) {
  const parsed = ts.parseConfigFileTextToJson('settings.json', text);
  const source = ts.parseJsonText('settings.json', text), expression = (source.statements[0] as ts.ExpressionStatement)?.expression;
  if (parsed.error || !expression || !ts.isObjectLiteralExpression(expression)) throw new Error('settings must be a JSONC object');
  const properties = expression.properties;
  const names = properties.map(p => p.name && ts.isStringLiteral(p.name) ? p.name.text : '');
  if (names.some(n => !n) || new Set(names).size !== names.length) throw new Error('duplicate or invalid settings key');
  const property = properties.find(p => p.name && ts.isStringLiteral(p.name) && p.name.text === key) as ts.PropertyAssignment | undefined;
  return { source, expression, property };
}
function setting(text: string): string | undefined {
  const { source, property } = jsonc(text); return property?.initializer.getText(source);
}
function editSetting(text: string, value?: string): string {
  const { source, expression, property } = jsonc(text);
  if (property) {
    if (value !== undefined) return text.slice(0, property.initializer.getStart(source)) + value + text.slice(property.initializer.end);
    // Installed missing keys are inserted first; remove only that property and its comma.
    const start = property.getStart(source), end = property.end;
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
    scanner.setTextPos(end);
    if (scanner.scan() === ts.SyntaxKind.CommaToken) return text.slice(0, start) + text.slice(end, scanner.getTokenPos()) + text.slice(scanner.getTextPos());
    scanner.setTextPos(expression.getStart(source) + 1);
    let comma = -1;
    while (scanner.getTextPos() < start && scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
      if (scanner.getTokenPos() >= start) break;
      comma = scanner.getToken() === ts.SyntaxKind.CommaToken ? scanner.getTokenPos() : -1;
    }
    return (comma >= 0 ? text.slice(0, comma) + text.slice(comma + 1, start) : text.slice(0, start)) + text.slice(end);
  }
  if (value === undefined) return text;
  const start = expression.getStart(source) + 1;
  return text.slice(0, start) + `\n  ${JSON.stringify(key)}: ${value}${expression.properties.length ? ',' : ''}` + text.slice(start);
}
function replace(file: string, before: string, after: string) {
  localPath(file);
  if (readFileSync(file, 'utf8') !== before) throw new Error('configuration changed concurrently');
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, after, { flag: 'wx' });
  try {
    if (readFileSync(file, 'utf8') !== before) throw new Error('configuration changed concurrently');
    renameSync(temp, file);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function identity(file: string, expected: string) {
  if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expected ?? '') || fileHash(readFileSync(file)) !== expected) throw new Error('artifact identity mismatch');
}
function version(executable: string) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('executable version unavailable');
  return result.stdout.trim();
}
function validateInstallationControl(s: InstallationSpec, config: Control) {
  const runtime = config.runtime, mcp = config.mcp;
  if (mcp?.scope?.plan !== true || !mcp.parentRelay?.threadId || config.assignments?.length || mcp.scope.assignments?.length) throw new Error('explicit plan and parent binding required');
  Id.parse(config.runId); Id.parse(mcp.parentRelay.threadId);
  if (!/^meristem-cc01-control-[a-zA-Z0-9-]{1,90}$/.test(config.pipeName) || !/^meristem-cc00-[a-zA-Z0-9-]{1,90}$/.test(mcp.parentRelay.pipeName)) throw new Error('invalid pipe binding');
  localPath(absolute.parse(mcp.scope.planPath));
  const plan = readPlan(mcp.scope.planPath);
  if (Boolean(s.controlSha256) !== Boolean(config.installationTarget)) throw new Error('prepared installation specification required');
  if (config.installationTarget) validateGeneratedTarget(s, config.installationTarget, plan, config);
  if (realpathSync(plan.plan.run.repository) !== realpathSync(config.repository) || realpathSync(config.repository) !== realpathSync(mcp.scope.repositoryPath) || !mcp.scope.branchScope.includes(plan.plan.run.integration_branch)) throw new Error('plan repository or branch mismatch');
  if (!path.isAbsolute(config.stateDirectory) || [config.repository, s.implementationRoot, plan.plan.run.worktrees_root].some(root => overlap(s.installDirectory, root) || overlap(config.stateDirectory, root)) || overlap(s.installDirectory, config.stateDirectory)) throw new Error('installation and run state require separate directories outside repositories and worktrees');
  localPath(config.stateDirectory);
  if (runtime.fixture || realpathSync(runtime.realExe) !== realpathSync(s.realExe) || realpathSync(config.nodeExecutable) !== realpathSync(s.nodeExe) || realpathSync(s.nodeExe) !== realpathSync(process.execPath) || realpathSync(runtime.authHome) !== realpathSync(path.dirname(s.codexConfig))) throw new Error('runtime binding mismatch');
  if (mcp.scope.modelRoutingSummary !== undefined) loadPlanRoutingSummary(mcp.scope.modelRoutingSummary, plan, config.runId, runtime.authHome);
  const root = s.implementationRoot, build = path.join(root, '.local/chat-control-build');
  if (realpathSync(config.entryPoint) !== realpathSync(path.join(root, 'dist/src/cli.js')) || realpathSync(mcp.entryPoint) !== realpathSync(path.join(root, 'dist/src/mcp.js')) || realpathSync(runtime.hostExe) !== realpathSync(path.join(build, 'CodexWorkerHost.exe'))) throw new Error('implementation root mismatch');
  const limits = ExecutionLimits.parse(config.executionLimits ?? {});
  const legacyWake = ExecutionLimits.parse({ maxWakeTurns: config.mcp?.wake?.maxTurns }).maxWakeTurns;
  if (plan.plan.schema_version === 2 && config.executionLimits && Object.hasOwn(config.executionLimits, 'maxWakeTurns')
    && config.mcp.wake && Object.hasOwn(config.mcp.wake, 'maxTurns') && limits.maxWakeTurns !== legacyWake) throw new Error('conflicting maxWakeTurns and legacy maxTurns');
  localPath(runtime.realExe);
  if (fileHash(readFileSync(runtime.realExe)) !== Hash.parse(runtime.realSha256)) {
    throw new Error('Codex artifact identity mismatch; validate compatibility before changing the selected hash');
  }
  for (const [file, sha] of [[runtime.hostExe, runtime.hostSha256], [config.nodeExecutable, config.nodeSha256], [config.entryPoint, config.entrySha256], [mcp.entryPoint, mcp.entrySha256]]) {
    localPath(file); identity(file, sha);
  }
  const helperManifest = path.join(s.helperExtension, 'package.json'), helperMain = path.join(s.helperExtension, 'dist/src/extension.js');
  const artifacts = [helperManifest, helperMain, path.join(build, 'CodexRelay.exe'), path.join(build, 'MeristemControl.exe')];
  for (const file of artifacts) { localPath(file); if (!statSync(file).isFile()) throw new Error('required installation artifact missing'); }
  const helper = JSON.parse(readFileSync(helperManifest, 'utf8'));
  if (helper.name !== 'meristem-chat-control-fixture' || helper.publisher !== 'meristem-local' || helper.main !== './dist/src/extension.js') throw new Error('built helper extension required');
  localPath(s.parentCwd);
  const parentCwd = realpathSync(s.parentCwd);
  if (!statSync(parentCwd).isDirectory()) throw new Error('parent working directory required');
  return { build, helperMain, parentCwd };
}
export function install(input: unknown) {
  const s = Spec.parse(input);
  [s.settings, s.codexConfig, s.controlConfig, s.installDirectory].forEach(localPath);
  if (s.prepare) throw new Error('run prepare first and install the returned specification');
  const bytes = readFileSync(s.controlConfig);
  if (s.controlSha256 && fileHash(bytes) !== s.controlSha256) throw new Error('prepared control artifact identity mismatch');
  const config = JSON.parse(bytes.toString('utf8'));
  const { build, helperMain, parentCwd } = validateInstallationControl(s, config);
  const { runtime, mcp } = config;
  const nodeVersion = version(s.nodeExe), codexVersion = version(s.realExe);
  const numbers = /^v(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion)?.slice(1).map(Number);
  if (!numbers || numbers[0] < 24 || (numbers[0] === 24 && (numbers[1] < 22 || (numbers[1] === 22 && numbers[2] < 1)))) throw new Error('Node 24.22.1 or newer required');
  if (existsSync(s.installDirectory)) throw new Error('installation directory must be new; preserve previous receipt');
  if (s.sourceSettings && existsSync(s.settings)) throw new Error('profile clone target already exists');
  const before = s.sourceSettings ? readFileSync(s.sourceSettings, 'utf8') : readFileSync(s.settings, 'utf8');
  const previous = setting(before), auth = readFileSync(s.codexConfig, 'utf8');
  if (hasMcpNamespace(auth)) throw new Error('existing, dotted or inline MCP namespace requires manual review');
  if (auth.includes('\u0000')) throw new Error('invalid Codex configuration');
  const relay = path.join(s.installDirectory, 'CodexRelay.exe');
  const mcpBlock = `\n[mcp_servers.meristem]\ncommand = ${JSON.stringify(s.nodeExe)}\nargs = [${JSON.stringify(mcp.entryPoint)}, "--pipe", ${JSON.stringify(config.pipeName)}]\n`;
  const receipt = path.join(s.installDirectory, 'installation.json');
  const manifest: Manifest = { version: 1, state: 'prepared', settings: s.settings, previous, installed: JSON.stringify(relay), codexConfig: s.codexConfig, mcpBlock, artifacts: {}, versions: { node: nodeVersion, codex: codexVersion } };
  mkdirSync(s.installDirectory);
  const control = path.join(s.installDirectory, 'control.json');
  writeFileSync(control, JSON.stringify(config, null, 2)); copyFileSync(path.join(build, 'CodexRelay.exe'), relay);
  const controlExe = path.join(build, 'MeristemControl.exe');
  writeFileSync(relay + '.json', JSON.stringify({ realExecutable: s.realExe, realSha256: runtime.realSha256, pipeName: mcp.parentRelay.pipeName, allowedCwds: [parentCwd], testProfile: 'CC-00R-managed', controlHost: { executable: controlExe, sha256: fileHash(readFileSync(controlExe)), configPath: control, configSha256: fileHash(readFileSync(control)), parentThreadId: mcp.parentRelay.threadId } }, null, 2));
  for (const file of [s.realExe, s.nodeExe, relay, relay + '.json', control, controlExe, runtime.hostExe, config.entryPoint, mcp.entryPoint, helperMain]) manifest.artifacts[file] = fileHash(readFileSync(file));
  writeFileSync(receipt, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  if (s.sourceSettings) { mkdirSync(path.dirname(s.settings), { recursive: true }); writeFileSync(s.settings, before, { flag: 'wx' }); }
  try {
    const settings = editSetting(before, manifest.installed); jsonc(settings);
    replace(s.settings, before, settings);
    replace(s.codexConfig, auth, auth + mcpBlock);
    manifest.state = 'installed'; writeFileSync(receipt, JSON.stringify(manifest, null, 2));
  } catch (error) { uninstall(receipt); throw error; }
  return { state: 'installed', receipt, versions: manifest.versions, automaticStart: false };
}
export function uninstall(receipt: string) {
  localPath(receipt);
  const m = JSON.parse(readFileSync(receipt, 'utf8')) as Manifest;
  if (m.version !== 1 || !path.isAbsolute(m.settings) || !path.isAbsolute(m.codexConfig) || !m.mcpBlock.startsWith('\n[mcp_servers.meristem]\n')) throw new Error('invalid installation receipt');
  const retained: string[] = [];
  if (existsSync(m.settings)) {
    const current = readFileSync(m.settings, 'utf8');
    if (setting(current) === m.installed) { const restored = editSetting(current, m.previous); jsonc(restored); replace(m.settings, current, restored); }
    else retained.push('settings: user value retained');
  }
  const auth = readFileSync(m.codexConfig, 'utf8'), start = auth.indexOf(m.mcpBlock);
  const suffix = start < 0 ? '' : auth.slice(start + m.mcpBlock.length);
  // An appended key still belongs to our table. Preserve the whole changed table.
  const nextTable = /^[ \t]*\[/m.exec(suffix), tableTail = nextTable ? suffix.slice(0, nextTable.index) : suffix;
  if (start >= 0 && auth.indexOf(m.mcpBlock, start + 1) < 0 && !tableTail.trim() && !hasMcpNamespace(suffix)) replace(m.codexConfig, auth, auth.slice(0, start) + suffix);
  else if (m.state !== 'restored') retained.push('MCP: user value retained or installation not applied');
  m.state = 'restored'; m.retained = retained; writeFileSync(receipt, JSON.stringify(m, null, 2));
  return { state: m.state, retained, artifactsPreserved: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, configPath, environmentPath] = process.argv.slice(2);
    const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    switch (action) {
      case 'prepare': {
        const request = Spec.parse(readJson(configPath));
        console.log(JSON.stringify(prepareInstallation(request, inspectEnvironment(request, readJson(environmentPath)))));
        break;
      }
      case 'install': console.log(JSON.stringify(install(readJson(configPath)))); break;
      case 'uninstall': console.log(JSON.stringify(uninstall(configPath))); break;
      default: throw new Error('prepare, install or uninstall required');
    }
  }
  catch (e) { console.error(e instanceof Error ? e.message : 'installation failed'); process.exitCode = 1; }
}
